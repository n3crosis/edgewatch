import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { backup, backupName, listBackups, parseArgs, type Run } from './d1-backup';

function fakeRoot(placeholder: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'ew-backup-'));
  mkdirSync(join(root, 'workers/consumer'), { recursive: true });
  const id = placeholder ? 'REPLACE_WITH_D1_DATABASE_ID' : 'abc';
  writeFileSync(join(root, 'workers/consumer/wrangler.jsonc'), `{ // consumer\n "d1_databases": [{ "binding": "DB", "database_name": "edgewatch", "database_id": "${id}" }] }`);
  return root;
}
const exporter = (calls: string[][], status = 0): Run => (args) => {
  calls.push(args);
  if (args[1] === 'export' && status === 0) writeFileSync(args[args.indexOf('--output') + 1], 'CREATE TABLE traces (id INTEGER);\n');
  return { status, stderr: status ? 'boom\nauth error' : '' };
};

describe('d1-backup', () => {
  it('parses options and rejects bad ones', () => {
    expect(parseArgs(['--local', '--keep', '3', '--r2', 'bk', '--out', '/tmp/x'], {})).toMatchObject({ mode: '--local', keep: 3, r2: 'bk', out: '/tmp/x', db: 'edgewatch' });
    expect(parseArgs([], { EDGEWATCH_D1_NAME: 'other' })).toMatchObject({ mode: '--remote', keep: 14, r2: null, db: 'other' });
    expect(() => parseArgs(['--keep', '0'])).toThrow('positive integer');
    expect(() => parseArgs(['--nope'])).toThrow('Unknown');
  });

  it('exports, gzips, uploads to R2 and keeps only the newest N dumps', () => {
    const root = fakeRoot(false);
    const out = join(root, 'backups');
    const calls: string[][] = [];
    for (let day = 1; day <= 4; day++) {
      backup({ mode: '--remote', out, keep: 2, r2: day === 4 ? 'ew-backups' : null, db: 'edgewatch' }, exporter(calls), new Date(Date.UTC(2026, 0, day)), root);
    }
    const files = listBackups(out);
    expect(files).toEqual([backupName(new Date(Date.UTC(2026, 0, 4))), backupName(new Date(Date.UTC(2026, 0, 3)))]);
    expect(readdirSync(out).some((f) => f.endsWith('.sql'))).toBe(false);
    expect(gunzipSync(readFileSync(join(out, files[0]))).toString()).toContain('CREATE TABLE traces');
    expect(calls[0].slice(0, 4)).toEqual(['d1', 'export', 'edgewatch', '--remote']);
    expect(calls.at(-1)?.slice(0, 4)).toEqual(['r2', 'object', 'put', `ew-backups/backups/${files[0]}`]);
  });

  it('exports the repo-root local state with --local through a temporary config', () => {
    const root = fakeRoot(true);
    const seen: { cwd: string; config: unknown }[] = [];
    const run: Run = (args, cwd) => {
      seen.push({ cwd, config: JSON.parse(readFileSync(args[args.indexOf('--config') + 1], 'utf8')) });
      return exporter([])(args, cwd);
    };
    backup({ mode: '--local', out: join(root, 'b'), keep: 5, r2: null, db: 'edgewatch' }, run, new Date(), root);
    expect(seen[0].cwd).toBe(root);
    expect(seen[0].config).toMatchObject({ d1_databases: [{ binding: 'DB', database_name: 'edgewatch', database_id: 'REPLACE_WITH_D1_DATABASE_ID' }] });
    expect(readdirSync(root)).not.toContain('.edgewatch-backup.wrangler.json');
    expect(() => backup({ mode: '--local', out: join(root, 'b'), keep: 5, r2: null, db: 'other' }, run, new Date(), root)).toThrow('no D1 database named other');
  });

  it('preserves unrelated config files and cleans only its own config on failure', () => {
    const root = fakeRoot(false);
    const existing = join(root, '.edgewatch-backup.wrangler.json');
    writeFileSync(existing, 'user configuration');
    const opts = { out: join(root, 'b'), keep: 5, r2: null, db: 'edgewatch' };
    backup({ ...opts, mode: '--remote' }, exporter([]), new Date(), root);
    let temporary = '';
    expect(() => backup({ ...opts, mode: '--local' }, (args) => {
      temporary = args[args.indexOf('--config') + 1];
      expect(temporary).not.toBe(existing);
      expect(existsSync(temporary)).toBe(true);
      throw new Error('export interrupted');
    }, new Date(), root)).toThrow('export interrupted');
    expect(existsSync(temporary)).toBe(false);
    expect(readFileSync(existing, 'utf8')).toBe('user configuration');
  });

  it('gives overlapping local exports independent temporary configs', () => {
    const root = fakeRoot(false);
    const opts = { mode: '--local' as const, out: join(root, 'b'), keep: 5, r2: null, db: 'edgewatch' };
    const configs: string[] = [];
    backup(opts, (args, cwd) => {
      const outer = args[args.indexOf('--config') + 1];
      configs.push(outer);
      backup(opts, (nested, nestedCwd) => {
        configs.push(nested[nested.indexOf('--config') + 1]);
        expect(configs[0]).not.toBe(configs[1]);
        expect(existsSync(outer)).toBe(true);
        return exporter([])(nested, nestedCwd);
      }, new Date('2026-01-02'), root);
      expect(existsSync(outer)).toBe(true);
      return exporter([])(args, cwd);
    }, new Date('2026-01-01'), root);
    expect(configs.every((config) => !existsSync(config))).toBe(true);
  });

  it('refuses the placeholder database id and reports export and upload failures', () => {
    const opts = { mode: '--remote' as const, keep: 5, r2: null, db: 'edgewatch' };
    expect(() => backup({ ...opts, out: '/tmp/never' }, exporter([]), new Date(), fakeRoot(true))).toThrow('placeholder');
    const root = fakeRoot(false);
    expect(() => backup({ ...opts, out: join(root, 'b') }, exporter([], 1), new Date(), root)).toThrow('wrangler d1 export failed: boom auth error');
    const failingPut: Run = (args) => (args[0] === 'r2' ? { status: 1, stderr: 'no bucket' } : exporter([])(args, ''));
    expect(() => backup({ ...opts, r2: 'x', out: join(root, 'c') }, failingPut, new Date(), root)).toThrow('R2 upload failed: no bucket');
    expect(listBackups(join(root, 'c'))).toHaveLength(1);
  });
});
