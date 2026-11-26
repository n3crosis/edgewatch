#!/usr/bin/env bun
/**
 * API key management for the API_KEYS KV namespace. Keys are stored as apikey:<sha256(raw key)> → ApiKeyRecord; the raw
 * key is printed once and never stored. A key's id is the first 12 hex characters of its hash. Every change is
 * appended to an audit log in the same namespace (audit:<ms>:<random>).
 *
 *   keys create <default_project> [ingest|read|browser|admin[,...]] [name] [--expires 90d] [--origins https://a,https://b]
 *   keys list
 *   keys revoke <id>
 *   keys rotate <id> [--grace 7d]      new key with the same project, scopes and name; the old one expires after the grace
 *   keys audit [--limit 50]
 *
 * Runs wrangler from workers/ingest: --remote (default) or --local [--persist-to <dir>]. With KEY_STORE=sql deployments
 * (no KV), pass --postgres <url> to manage the kv_store table in the Postgres event store instead.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectPostgres } from '../packages/shared/src/postgres-js';
import { SqlKeyStore } from '../packages/shared/src/sql-keystore';

export type Scope = 'ingest' | 'read' | 'browser' | 'admin';
const SCOPES: Scope[] = ['ingest', 'read', 'browser', 'admin'];

export interface KeyRecord {
  project_id: string;
  name: string;
  scopes: Scope[];
  disabled?: boolean;
  allowed_origins?: string[];
  created_at?: number;
  expires_at?: number;
  revoked_at?: number;
}

export interface KeyStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export interface AuditEntry {
  at: string;
  action: 'create' | 'revoke' | 'rotate';
  key_id: string;
  name: string;
  project_id: string;
  scopes: Scope[];
  expires_at?: string;
  replaced_by?: string;
  by?: string;
}

export class KeyError extends Error {}

const sha256 = (raw: string) => createHash('sha256').update(raw).digest('hex');
const iso = (s: number) => new Date(s * 1000).toISOString();

/** "90d", "12h", "30m", "45s" or plain seconds. */
export function parseDuration(value: string): number {
  const m = /^(\d+)([smhd]?)$/.exec(value.trim());
  if (!m) throw new KeyError(`Invalid duration "${value}": use e.g. 90d, 12h, 30m.`);
  return Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86_400 }[m[2] as '' | 's' | 'm' | 'h' | 'd'];
}

let lastAuditMs = 0;
async function audit(store: KeyStore, entry: Omit<AuditEntry, 'at' | 'by'>, now: number) {
  const full: AuditEntry = { at: iso(now), ...entry, ...(process.env.USER ? { by: process.env.USER } : {}) };
  // Strictly increasing within a process so entries written in the same millisecond keep their order.
  lastAuditMs = Math.max(Math.round(now * 1000), lastAuditMs + 1);
  await store.put(`audit:${String(lastAuditMs).padStart(15, '0')}:${randomBytes(4).toString('hex')}`, JSON.stringify(full));
}

export interface CreateOptions {
  project: string;
  scopes: string[];
  name?: string;
  expiresIn?: number;
  origins?: string[];
}

export async function createKey(store: KeyStore, o: CreateOptions, now = Date.now() / 1000, action: 'create' | 'rotate' = 'create') {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(o.project)) throw new KeyError(`Invalid project "${o.project}".`);
  const bad = o.scopes.filter((s) => !(SCOPES as string[]).includes(s));
  if (!o.scopes.length || bad.length) throw new KeyError(`Invalid scope ${bad.join(', ') || '(none)'}: use ${SCOPES.join(', ')}.`);
  const scopes = o.scopes as Scope[];
  const prefix = scopes.includes('ingest') ? 'ew_live' : scopes.includes('browser') ? 'ew_pub' : 'ew_read';
  const key = `${prefix}_${randomBytes(24).toString('base64url')}`;
  const hash = sha256(key);
  const record: KeyRecord = {
    project_id: o.project,
    name: o.name ?? 'default',
    scopes,
    created_at: Math.floor(now),
    ...(o.expiresIn ? { expires_at: Math.floor(now + o.expiresIn) } : {}),
    ...(o.origins?.length ? { allowed_origins: o.origins } : {}),
  };
  await store.put(`apikey:${hash}`, JSON.stringify(record));
  const id = hash.slice(0, 12);
  if (action === 'create') {
    await audit(store, { action, key_id: id, name: record.name, project_id: record.project_id, scopes, ...(record.expires_at ? { expires_at: iso(record.expires_at) } : {}) }, now);
  }
  return { key, id, record };
}

export type KeyStatus = 'active' | 'expired' | 'revoked';
const statusOf = (r: KeyRecord, now: number): KeyStatus => (r.disabled ? 'revoked' : r.expires_at !== undefined && r.expires_at <= now ? 'expired' : 'active');

export async function listKeys(store: KeyStore, now = Date.now() / 1000) {
  const names = await store.list('apikey:');
  const rows = await Promise.all(
    names.map(async (name) => {
      const raw = await store.get(name);
      if (!raw) return null;
      const r = JSON.parse(raw) as KeyRecord;
      return {
        id: name.slice('apikey:'.length, 'apikey:'.length + 12),
        name: r.name,
        project_id: r.project_id,
        scopes: r.scopes,
        status: statusOf(r, now),
        created_at: r.created_at ? iso(r.created_at) : null,
        expires_at: r.expires_at ? iso(r.expires_at) : null,
      };
    }),
  );
  return rows.filter((r) => r !== null).sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id.localeCompare(b.id));
}

async function findKey(store: KeyStore, id: string): Promise<{ kvKey: string; record: KeyRecord }> {
  if (!/^[0-9a-f]{6,64}$/.test(id)) throw new KeyError(`Invalid key id "${id}": use at least 6 hex characters from \`keys list\`.`);
  const matches = await store.list(`apikey:${id}`);
  if (matches.length !== 1) throw new KeyError(matches.length ? `Key id ${id} is ambiguous; use more characters.` : `No key with id ${id}.`);
  const raw = await store.get(matches[0]);
  if (!raw) throw new KeyError(`No key with id ${id}.`);
  return { kvKey: matches[0], record: JSON.parse(raw) as KeyRecord };
}

export async function revokeKey(store: KeyStore, id: string, now = Date.now() / 1000) {
  const { kvKey, record } = await findKey(store, id);
  const updated: KeyRecord = { ...record, disabled: true, revoked_at: Math.floor(now) };
  await store.put(kvKey, JSON.stringify(updated));
  await audit(store, { action: 'revoke', key_id: kvKey.slice(7, 19), name: record.name, project_id: record.project_id, scopes: record.scopes }, now);
  return updated;
}

/** New key with the same project, scopes, name, origins and lifetime; the old key expires after `grace` seconds (0 = now). */
export async function rotateKey(store: KeyStore, id: string, grace: number, now = Date.now() / 1000) {
  const { kvKey, record } = await findKey(store, id);
  if (statusOf(record, now) !== 'active') throw new KeyError(`Key ${id} is ${statusOf(record, now)}; create a new key instead.`);
  const lifetime = record.expires_at && record.created_at ? record.expires_at - record.created_at : undefined;
  const fresh = await createKey(store, { project: record.project_id, scopes: record.scopes, name: record.name, expiresIn: lifetime, origins: record.allowed_origins }, now, 'rotate');
  const until = Math.floor(now + grace);
  const old: KeyRecord = grace > 0 ? { ...record, expires_at: Math.min(record.expires_at ?? until, until) } : { ...record, disabled: true, revoked_at: Math.floor(now) };
  await store.put(kvKey, JSON.stringify(old));
  await audit(store, {
    action: 'rotate', key_id: kvKey.slice(7, 19), name: record.name, project_id: record.project_id, scopes: record.scopes,
    ...(old.expires_at ? { expires_at: iso(old.expires_at) } : {}), replaced_by: fresh.id,
  }, now);
  return { ...fresh, old };
}

export async function auditLog(store: KeyStore, limit = 50): Promise<AuditEntry[]> {
  const names = (await store.list('audit:')).sort().reverse().slice(0, limit);
  const entries = await Promise.all(names.map(async (n) => store.get(n)));
  return entries.flatMap((e) => (e ? [JSON.parse(e) as AuditEntry] : []));
}

/** KeyStore backed by `wrangler kv key` in workers/ingest (binding API_KEYS). */
export function wranglerStore(o: { local: boolean; persistTo?: string; cwd: string }): KeyStore {
  const target = o.local ? ['--local', ...(o.persistTo ? ['--persist-to', o.persistTo] : [])] : ['--remote'];
  const run = (args: string[]) => {
    const r = spawnSync('bunx', ['wrangler', 'kv', 'key', ...args, '--binding', 'API_KEYS', ...target], { cwd: o.cwd, encoding: 'utf8' });
    return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
  return {
    async get(key) {
      const r = run(['get', key, '--text']);
      return r.ok && !/^Value not found/.test(r.out.trim()) ? r.out : null;
    },
    async put(key, value) {
      const r = run(['put', key, value]);
      if (!r.ok) throw new KeyError(`wrangler kv key put failed: ${r.err.trim() || r.out.trim()}`);
    },
    async list(prefix) {
      const r = run(['list', '--prefix', prefix]);
      if (!r.ok) throw new KeyError(`wrangler kv key list failed: ${r.err.trim() || r.out.trim()}`);
      const json = r.out.slice(r.out.indexOf('['));
      return (JSON.parse(json) as { name: string }[]).map((k) => k.name);
    },
  };
}

/** KeyStore on the event store's kv_store table (KEY_STORE=sql deployments). */
export function sqlStore(store: SqlKeyStore): KeyStore {
  return { get: (key) => store.getText(key), put: (key, value) => store.put(key, value), list: (prefix) => store.list(prefix) };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function main(argv: string[], store: KeyStore, out: (line: string) => void = console.log): Promise<number> {
  const valued = new Set(['--expires', '--origins', '--grace', '--limit', '--persist-to', '--postgres']);
  const positional = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1] ?? ''));
  const [command, ...rest] = positional;
  try {
    switch (command) {
      case 'create': {
        const [project, scopes = 'ingest', name] = rest;
        if (!project) throw new KeyError('Usage: keys create <default_project> [scopes] [name] [--expires 90d] [--origins a,b]');
        const expires = flag(argv, 'expires');
        const { key, id, record } = await createKey(store, {
          project, scopes: scopes.split(','), name, expiresIn: expires ? parseDuration(expires) : undefined, origins: flag(argv, 'origins')?.split(','),
        });
        out(`Key ${id} (${record.scopes.join(',')}) for ${project}${record.expires_at ? `, expires ${iso(record.expires_at)}` : ''}:\n${key}\nShown once; store it now.`);
        return 0;
      }
      case 'list': {
        const keys = await listKeys(store);
        if (!keys.length) out('No keys.');
        for (const k of keys) out(`${k.id}  ${k.status.padEnd(7)}  ${k.scopes.join(',').padEnd(12)}  ${k.project_id}  ${k.name}  created ${k.created_at ?? '-'}  expires ${k.expires_at ?? 'never'}`);
        return 0;
      }
      case 'revoke': {
        if (!rest[0]) throw new KeyError('Usage: keys revoke <id>');
        const r = await revokeKey(store, rest[0]);
        out(`Revoked ${rest[0]} (${r.name}). Edge caches may accept it for up to 60 s, and agent tokens it issued stay valid until they expire (TOKEN_TTL).`);
        return 0;
      }
      case 'rotate': {
        if (!rest[0]) throw new KeyError('Usage: keys rotate <id> [--grace 7d]');
        const grace = parseDuration(flag(argv, 'grace') ?? '7d');
        const r = await rotateKey(store, rest[0], grace);
        out(`New key ${r.id} replaces ${rest[0]}, which ${r.old.disabled ? 'is revoked now' : `expires ${iso(r.old.expires_at ?? 0)}`}:\n${r.key}\nShown once; store it now.`);
        return 0;
      }
      case 'audit': {
        for (const e of await auditLog(store, Number(flag(argv, 'limit') ?? 50))) {
          out(`${e.at}  ${e.action.padEnd(6)}  ${e.key_id}  ${e.project_id}  ${e.name}${e.replaced_by ? `  -> ${e.replaced_by}` : ''}${e.expires_at ? `  expires ${e.expires_at}` : ''}${e.by ? `  by ${e.by}` : ''}`);
        }
        return 0;
      }
      default:
        throw new KeyError('Usage: keys <create|list|revoke|rotate|audit> ... [--local [--persist-to dir] | --remote]');
    }
  } catch (e) {
    if (e instanceof KeyError) {
      out(`Error: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const cwd = join(dirname(fileURLToPath(import.meta.url)), '..', 'workers', 'ingest');
  const pgUrl = flag(argv, 'postgres');
  if (pgUrl) {
    const pg = connectPostgres(pgUrl, { max: 1 });
    const code = await main(argv, sqlStore(new SqlKeyStore(pg.db))).finally(() => pg.close());
    process.exit(code);
  }
  process.exit(await main(argv, wranglerStore({ local: argv.includes('--local'), persistTo: flag(argv, 'persist-to'), cwd })));
}
