#!/usr/bin/env node
// Creates (or finds) the Cloudflare resources EdgeWatch needs and writes their IDs into the Worker configs.
// Idempotent: re-running reuses existing resources by name.
//
//   node scripts/cf-setup.mjs [--dry-run] [--skip-secret]
//
// Requires `wrangler login` or CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID for multi-account tokens).
// Override names with EDGEWATCH_KV_TITLE, EDGEWATCH_D1_NAME, EDGEWATCH_R2_BUCKET, EDGEWATCH_QUEUE, EDGEWATCH_DLQ.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');
const SKIP_SECRET = process.argv.includes('--skip-secret');
const WRANGLER = process.env.WRANGLER_BIN ?? (existsSync(join(ROOT, 'node_modules/.bin/wrangler')) ? join(ROOT, 'node_modules/.bin/wrangler') : 'wrangler');

const names = {
  kv: process.env.EDGEWATCH_KV_TITLE ?? 'edgewatch-api-keys',
  d1: process.env.EDGEWATCH_D1_NAME ?? 'edgewatch',
  r2: process.env.EDGEWATCH_R2_BUCKET ?? 'edgewatch-traces',
  queue: process.env.EDGEWATCH_QUEUE ?? 'edgewatch-ingest',
  dlq: process.env.EDGEWATCH_DLQ ?? 'edgewatch-ingest-dlq',
};
const CONFIGS = ['workers/ingest/wrangler.jsonc', 'workers/consumer/wrangler.jsonc', 'workers/api/wrangler.jsonc'];

function wrangler(args, { input, allowFail = false } = {}) {
  if (DRY) {
    console.log(`[dry-run] wrangler ${args.join(' ')}`);
    return '';
  }
  try {
    return execFileSync(WRANGLER, args, { encoding: 'utf8', input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], cwd: join(ROOT, 'workers/ingest') });
  } catch (e) {
    if (allowFail) return `${e.stdout ?? ''}${e.stderr ?? ''}`;
    console.error(`wrangler ${args.join(' ')} failed:\n${e.stdout ?? ''}${e.stderr ?? ''}`);
    process.exit(1);
  }
}

const json = (text) => (text.trim() ? JSON.parse(text.slice(text.search(/[[{]/))) : []);

console.log('Checking Cloudflare authentication…');
const whoami = DRY ? null : spawnSync(WRANGLER, ['whoami'], { encoding: 'utf8' });
if (whoami && (whoami.status !== 0 || /not authenticated/i.test(`${whoami.stdout}${whoami.stderr}`))) {
  console.error('Not authenticated. Run `npx wrangler login` or export CLOUDFLARE_API_TOKEN, then re-run.');
  process.exit(1);
}

// KV namespace for API keys (shared by ingest + api)
let kvId = json(wrangler(['kv', 'namespace', 'list'])).find((n) => n.title === names.kv)?.id;
if (!kvId) {
  const out = wrangler(['kv', 'namespace', 'create', names.kv]);
  kvId = out.match(/"?id"?\s*[:=]\s*"([0-9a-f]{32})"/)?.[1];
  if (!kvId && !DRY) throw new Error(`Could not parse KV namespace id from:\n${out}`);
}
console.log(`KV  ${names.kv}: ${kvId ?? '(dry-run)'}`);

// D1 database
let d1Id = json(wrangler(['d1', 'list', '--json'])).find((d) => d.name === names.d1)?.uuid;
if (!d1Id) {
  const out = wrangler(['d1', 'create', names.d1]);
  d1Id = out.match(/"?database_id"?\s*[:=]\s*"([0-9a-f-]{36})"/)?.[1];
  if (!d1Id && !DRY) throw new Error(`Could not parse D1 database id from:\n${out}`);
}
console.log(`D1  ${names.d1}: ${d1Id ?? '(dry-run)'}`);

// R2 bucket and queues have no IDs in wrangler config, only names; "already exists" is fine.
for (const [kind, args] of [
  ['R2', ['r2', 'bucket', 'create', names.r2]],
  ['Queue', ['queues', 'create', names.queue]],
  ['Queue', ['queues', 'create', names.dlq]],
]) {
  const out = wrangler(args, { allowFail: true });
  if (out && !/created|already exists|already taken|exists/i.test(out)) {
    console.error(`${kind} ${args.at(-1)} failed:\n${out}`);
    process.exit(1);
  }
  console.log(`${kind.padEnd(3)} ${args.at(-1)}: ok`);
}

// Write IDs/names into wrangler configs (placeholder or a previous id).
if (!DRY) {
  for (const rel of CONFIGS) {
    const path = join(ROOT, rel);
    const before = readFileSync(path, 'utf8');
    const after = before
      .replace(/("binding":\s*"API_KEYS",\s*"id":\s*")[^"]*(")/, `$1${kvId}$2`)
      .replace(/("database_name":\s*")[^"]*(",\s*"database_id":\s*")[^"]*(")/, `$1${names.d1}$2${d1Id}$3`)
      .replace(/("bucket_name":\s*")[^"]*(")/g, `$1${names.r2}$2`)
      .replace(/("queue":\s*")edgewatch-ingest(")/g, `$1${names.queue}$2`)
      .replace(/("dead_letter_queue":\s*")[^"]*(")/, `$1${names.dlq}$2`);
    if (after !== before) writeFileSync(path, after);
    console.log(`wrote ${rel}${after === before ? ' (unchanged)' : ''}`);
  }
}

if (DRY) console.log('[dry-run] would write KV/D1 ids into ' + CONFIGS.join(', '));

// Signing secret for agent-auth tokens (only set if missing, so existing agent tokens stay valid).
if (!SKIP_SECRET) {
  const list = wrangler(['secret', 'list', '--config', join(ROOT, 'workers/ingest/wrangler.jsonc')], { allowFail: true });
  if (/TOKEN_SIGNING_SECRET/.test(list)) console.log('Secret TOKEN_SIGNING_SECRET: already set');
  else {
    wrangler(['secret', 'put', 'TOKEN_SIGNING_SECRET', '--config', join(ROOT, 'workers/ingest/wrangler.jsonc')], { input: randomBytes(32).toString('base64url') });
    console.log(`Secret TOKEN_SIGNING_SECRET: ${DRY ? '(dry-run)' : 'set (random 32 bytes)'}`);
  }
}

console.log('\nNext: scripts/d1-migrate.sh --remote && scripts/deploy.sh  (see docs/deployment.md)');
