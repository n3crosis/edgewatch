/**
 * Exports the EdgeWatch D1 database to a gzipped SQL dump and keeps the newest N dumps.
 *   bun scripts/d1-backup.ts [--remote|--local] [--out backups] [--keep 14] [--r2 <bucket>]
 * --local reads the self-hosting state in .wrangler/state (the --persist-to used by docs/self-hosting.md).
 * --r2 also uploads the dump to <bucket>/backups/ (use a bucket other than the traces bucket if its lifecycle rule
 * would expire it). Restore: see docs/deployment.md ("Backups and restore").
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseJsonc } from './setup-cloudflare';
import { gzipSync } from 'node:zlib';

export interface BackupOptions {
  mode: '--remote' | '--local';
  out: string;
  keep: number;
  r2: string | null;
  db: string;
}

export type Run = (args: string[], cwd: string) => { status: number | null; stderr: string };

const ROOT = resolve(import.meta.dir, '..');
const PREFIX = 'edgewatch-d1-';

export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env): BackupOptions {
  const opts: BackupOptions = { mode: '--remote', out: join(ROOT, 'backups'), keep: 14, r2: null, db: env.EDGEWATCH_D1_NAME || 'edgewatch' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--remote' || a === '--local') opts.mode = a;
    else if (a === '--out' && argv[i + 1]) opts.out = resolve(argv[++i]);
    else if (a === '--keep' && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error('--keep must be a positive integer');
      opts.keep = n;
    } else if (a === '--r2' && argv[i + 1]) opts.r2 = argv[++i];
    else throw new Error(`Unknown or incomplete option: ${a}`);
  }
  return opts;
}

export const backupName = (now = new Date()) => `${PREFIX}${now.toISOString().replace(/[:.]/g, '-')}.sql.gz`;

/** Newest first; only files this script wrote. */
export function listBackups(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith(PREFIX) && f.endsWith('.sql.gz')).sort().reverse();
}

export function backup(opts: BackupOptions, run: Run, now = new Date(), root = ROOT): { file: string; removed: string[] } {
  const cwd = join(root, 'workers/consumer');
  if (opts.mode === '--remote' && readFileSync(join(cwd, 'wrangler.jsonc'), 'utf8').includes('REPLACE_WITH_D1_DATABASE_ID')) {
    throw new Error('workers/consumer/wrangler.jsonc still has the D1 placeholder id; run bun run setup:cloudflare first.');
  }
  mkdirSync(opts.out, { recursive: true });
  const file = join(opts.out, backupName(now));
  const sql = file.replace(/\.gz$/, '');
  const args = ['d1', 'export', opts.db, opts.mode, '--output', sql];
  // `d1 export` has no --persist-to: local state is <config dir>/.wrangler/state, so point a config at the repo root.
  const localConfig = opts.mode === '--local' ? join(root, `.edgewatch-backup-${randomUUID()}.wrangler.json`) : null;
  if (localConfig) {
    writeFileSync(localConfig, JSON.stringify({ name: 'edgewatch-backup', d1_databases: localD1(cwd, opts.db) }), { flag: 'wx', mode: 0o600 });
    args.push('--config', localConfig);
  }
  let res: ReturnType<Run>;
  try {
    res = run(args, opts.mode === '--local' ? root : cwd);
  } finally {
    if (localConfig) rmSync(localConfig, { force: true });
  }
  if (res.status !== 0 || !existsSync(sql)) throw new Error(`wrangler d1 export failed: ${res.stderr.trim().split('\n').slice(-3).join(' ')}`);
  writeFileSync(file, gzipSync(readFileSync(sql)));
  rmSync(sql);
  if (opts.r2) {
    const put = run(['r2', 'object', 'put', `${opts.r2}/backups/${backupName(now)}`, '--file', file, opts.mode], cwd);
    if (put.status !== 0) throw new Error(`Backup written to ${file}, but the R2 upload failed: ${put.stderr.trim().split('\n').pop()}`);
  }
  const removed = listBackups(opts.out).slice(opts.keep);
  for (const f of removed) rmSync(join(opts.out, f));
  return { file, removed };
}

/** The consumer's D1 binding, so the local export opens the same database file wrangler dev uses. */
function localD1(cwd: string, db: string): unknown[] {
  const config = parseJsonc(readFileSync(join(cwd, 'wrangler.jsonc'), 'utf8')) as { d1_databases?: { database_name?: string }[] };
  const binding = config.d1_databases?.find((d) => d.database_name === db);
  if (!binding) throw new Error(`workers/consumer/wrangler.jsonc has no D1 database named ${db}`);
  return [binding];
}

const wrangler: Run = (args, cwd) => {
  const r = spawnSync('bunx', ['wrangler', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'] });
  if (r.stderr) process.stderr.write(r.stderr);
  return { status: r.status, stderr: r.stderr ?? '' };
};

if (import.meta.main) {
  try {
    const { file, removed } = backup(parseArgs(process.argv.slice(2)), wrangler);
    console.log(`Backup written: ${file}${removed.length ? ` (removed ${removed.length} older)` : ''}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
