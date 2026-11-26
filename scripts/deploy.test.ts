import { afterEach, expect, it } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function harness(placeholder = false) {
  const root = mkdtempSync(join(tmpdir(), 'ew-deploy-'));
  roots.push(root);
  for (const dir of ['scripts', 'bin', 'workers/api', 'workers/consumer', 'workers/ingest']) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(join(import.meta.dir, 'deploy.sh'), join(root, 'scripts/deploy.sh'));
  for (const worker of ['api', 'consumer', 'ingest']) writeFileSync(join(root, `workers/${worker}/wrangler.jsonc`), placeholder ? 'REPLACE_WITH_ID' : '{}');
  const log = join(root, 'calls');
  writeFileSync(log, '');
  writeFileSync(join(root, 'bin/bun'), `#!/bin/bash
if [ "$1" = -e ]; then exec "$REAL_BUN" "$@"; fi
printf 'build\\n' >> "$DEPLOY_TEST_LOG"
exit "\${BUILD_EXIT:-0}"
`);
  writeFileSync(join(root, 'bin/bunx'), `#!/bin/bash
printf '%s:%s\\n' "\${PWD##*/}" "$*" >> "$DEPLOY_TEST_LOG"
if [ "\${FAIL_WORKER:-}" = "\${PWD##*/}" ] && [ "$2" = deploy ]; then exit 1; fi
`);
  for (const bin of ['bun', 'bunx']) chmodSync(join(root, 'bin', bin), 0o755);
  return (args: string[], variables: Record<string, string> = {}) => {
    const result = Bun.spawnSync(['bash', join(root, 'scripts/deploy.sh'), ...args], {
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, REAL_BUN: process.execPath, DEPLOY_TEST_LOG: log, VITE_API_URL: '', BUILD_EXIT: '0', FAIL_WORKER: '', ...variables },
      stdout: 'pipe', stderr: 'pipe',
    });
    return { status: result.exitCode, error: result.stderr.toString(), calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
  };
}

it('rejects invalid invocation and missing URL before any build or deployment', () => {
  for (const args of [['typo'], ['workers', '--dry-run'], ['all'], []]) {
    const result = harness()(args);
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
  }
});

it('rejects malformed or credential-bearing API URLs before side effects', () => {
  for (const url of [' ', 'api.example.test', 'javascript:alert(1)', 'https://user:secret@api.test', 'https://api.test?key=secret', 'https://api.test#fragment', '/\\api.test']) {
    const result = harness()(['all'], { VITE_API_URL: url });
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.error).not.toContain('secret');
  }
});

it('builds before deploying workers and stops when the build fails', () => {
  const result = harness()(['all'], { VITE_API_URL: 'https://api.test', BUILD_EXIT: '1' });
  expect(result.status).not.toBe(0);
  expect(result.calls).toEqual(['build']);
});

it('preserves consumer-first order and stops on a Worker failure', () => {
  expect(harness()(['workers']).calls).toEqual(['consumer:wrangler deploy', 'ingest:wrangler deploy', 'api:wrangler deploy']);
  const failed = harness()(['all'], { VITE_API_URL: 'https://api.test', FAIL_WORKER: 'ingest' });
  expect(failed.status).not.toBe(0);
  expect(failed.calls).toEqual(['build', 'consumer:wrangler deploy', 'ingest:wrangler deploy']);
});

it('requires resource IDs only when deploying workers', () => {
  const blocked = harness(true)(['workers']);
  expect(blocked.status).not.toBe(0);
  expect(blocked.calls).toEqual([]);
  for (const url of ['/', 'https://api.test/prefix', 'HTTPS://api.test']) {
    const result = harness(true)(['dashboard'], { VITE_API_URL: url });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(['build', 'api:wrangler pages project create edgewatch-dashboard --production-branch main --force', expect.stringContaining('api:wrangler pages deploy ')]);
  }
});

it('finishes a combined deploy only after a successful local build', () => {
  const result = harness()(['all'], { VITE_API_URL: 'https://api.test' });
  expect(result.status).toBe(0);
  expect(result.calls).toEqual(['build', 'consumer:wrangler deploy', 'ingest:wrangler deploy', 'api:wrangler deploy',
    'api:wrangler pages project create edgewatch-dashboard --production-branch main --force', expect.stringContaining('api:wrangler pages deploy ')]);
});
