#!/usr/bin/env bun
/**
 * Provisions the Cloudflare resources EdgeWatch needs and writes their IDs into workers/*\/wrangler.jsonc.
 *
 *   bun run setup:cloudflare [--validate | --dry-run] [--force] [--skip-migrations] [--skip-secret]
 *
 * Needs CLOUDFLARE_API_TOKEN (and CLOUDFLARE_ACCOUNT_ID when the token can see more than one account).
 * Token permissions: Workers KV Storage:Edit, D1:Edit, Workers R2 Storage:Edit, Queues:Edit, Workers Scripts:Edit.
 *
 * - Idempotent: resources are looked up by name first and reused, so re-running never creates duplicates.
 * - Names come from the wrangler configs (database_name, bucket_name, queue names); the KV title from
 *   EDGEWATCH_KV_TITLE (default edgewatch-api-keys).
 * - Config safety: an ID is written only over a REPLACE_WITH_* placeholder (or when it is already the same value).
 *   A different real ID is kept and reported unless --force is passed.
 * - Preflight: every run first checks the wrangler configs for each binding the Workers read (KV, D1, R2, the queue
 *   producer and consumers, DLQ, crons), the env URLs, the token and the Worker secrets each config needs
 *   (TOKEN_SIGNING_SECRET; LIBSQL_AUTH_TOKEN with LIBSQL_URL; S3 keys with S3_BUCKET). It only reads, and a failing
 *   check stops the run before any remote change. --validate runs only the preflight and exits 1 on any error.
 * - --dry-run makes no changes: with a token it only reads (GET) and reports what it would create; without a token
 *   it prints the plan offline.
 * - D1 migrations: `wrangler d1 migrations apply <db> --remote` (tracked in d1_migrations, so re-runs are no-ops).
 * - Queues: ingest queue and DLQ, with message retention raised from 4 to 14 days.
 * - R2 lifecycle (retention backstop): rules edgewatch-incoming (incoming/, 1 day) and edgewatch-traces-retention
 *   (traces/, EDGEWATCH_RETENTION_DAYS + 1 days, default 31); other lifecycle rules on the bucket are kept.
 * - TOKEN_SIGNING_SECRET is set on the ingest Worker only if missing (existing agent tokens stay valid).
 * - Optional Postgres or MySQL: with EDGEWATCH_POSTGRES_URL (or EDGEWATCH_MYSQL_URL) set, finds or creates the Hyperdrive configuration
 *   EDGEWATCH_HYPERDRIVE_NAME (default edgewatch-pg; token also needs Hyperdrive:Edit), adds the HYPERDRIVE binding to
 *   the consumer and API configs, and runs `bun run migrate:postgres` against the URL. The URL is never logged.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLACEHOLDER = /^REPLACE_WITH_/;
const API = 'https://api.cloudflare.com/client/v4';
const CONFIGS = { ingest: 'workers/ingest/wrangler.jsonc', consumer: 'workers/consumer/wrangler.jsonc', api: 'workers/api/wrangler.jsonc' } as const;

export class SetupError extends Error {}

export interface SetupOptions {
  root: string;
  token?: string;
  accountId?: string;
  dryRun?: boolean;
  /** Only run the preflight (configs, bindings, URLs, token, Worker secrets) and report; never writes anything. */
  validate?: boolean;
  force?: boolean;
  skipMigrations?: boolean;
  skipSecret?: boolean;
  kvTitle?: string;
  retentionDays?: number;
  queueRetentionSeconds?: number;
  /** Direct Postgres URL: enables Hyperdrive provisioning and Postgres migrations. */
  postgresUrl?: string;
  /** Direct MySQL 8.0.19+ URL: the same with MySQL. Set at most one of postgresUrl and mysqlUrl. */
  mysqlUrl?: string;
  hyperdriveName?: string;
  fetch?: typeof fetch;
  /** Runs a command (wrangler); returns exit status and combined output. */
  run?: (cmd: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => { status: number; output: string };
  log?: (line: string) => void;
}

export interface SetupResult {
  account: string | null;
  resources: Record<string, { name: string; id?: string; action: 'exists' | 'created' | 'would-create' | 'planned' }>;
  configs: { file: string; field: string; action: 'written' | 'unchanged' | 'kept-existing' | 'would-write'; value: string }[];
  migrations: 'applied' | 'skipped' | 'planned';
  /** Migrations of the Hyperdrive database (Postgres or MySQL). */
  postgresMigrations: 'applied' | 'skipped' | 'planned' | 'off';
  secret: 'exists' | 'set' | 'skipped' | 'planned' | 'after-deploy';
  warnings: string[];
  preflight: PreflightCheck[];
}

/** Minimal JSONC reader (comments + trailing commas); writes go through targeted text edits to keep comments. */
export function parseJsonc(text: string): unknown {
  const noComments = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, str) => str ?? '');
  return JSON.parse(noComments.replace(/,(\s*[}\]])/g, '$1'));
}

export function readNames(root: string, kvTitle: string) {
  const read = (rel: string) => ({ rel, config: parseJsonc(readFileSync(join(root, rel), 'utf8')) });
  const ingest = read(CONFIGS.ingest);
  const consumer = read(CONFIGS.consumer);
  return {
    kv: kvTitle,
    d1: configString(consumer, ['d1_databases', 0, 'database_name']),
    r2: configString(consumer, ['r2_buckets', 0, 'bucket_name']),
    queue: configString(ingest, ['queues', 'producers', 0, 'queue']),
    dlq: configString(consumer, ['queues', 'consumers', 0, 'dead_letter_queue']),
    ingestScript: configString(ingest, ['name']),
  };
}

/** Reads a nonempty string at `path` in a parsed wrangler config, or fails with the file and path that are wrong. */
export function configString(file: { rel: string; config: unknown }, path: (string | number)[]): string {
  let value: unknown = file.config;
  for (const key of path) value = typeof value === 'object' && value !== null ? (value as Record<string | number, unknown>)[key] : undefined;
  if (typeof value !== 'string' || value === '') {
    throw new SetupError(`${file.rel}: expected a name at ${path.join('.')}; fix the wrangler config and rerun.`);
  }
  return value;
}

function cloudflare(token: string, fetcher: typeof fetch) {
  return async <T>(method: string, path: string, body?: unknown, okStatus: number[] = []): Promise<{ status: number; result: T }> => {
    const res = await fetcher(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { code: number; message: string }[] };
    if (okStatus.includes(res.status)) return { status: res.status, result: json.result as T };
    if (res.status === 401 || res.status === 403) {
      throw new SetupError(`Cloudflare rejected CLOUDFLARE_API_TOKEN for ${method} ${path} (${res.status}): ${json.errors?.map((e) => e.message).join('; ') ?? ''}. Check the token's permissions.`);
    }
    if (!res.ok || json.success === false) {
      throw new SetupError(`${method} ${path} failed (${res.status}): ${json.errors?.map((e) => `${e.code} ${e.message}`).join('; ') ?? 'no details'}`);
    }
    return { status: res.status, result: json.result as T };
  };
}

/** Replaces a field value in raw config text, honouring the placeholder/--force rule. */
function setField(text: string, pattern: RegExp, value: string, force: boolean) {
  const m = text.match(pattern);
  if (!m) throw new SetupError(`Expected field not found (${pattern})`);
  const current = m[2];
  if (current === value) return { text, action: 'unchanged' as const, current };
  if (!PLACEHOLDER.test(current) && !force) return { text, action: 'kept-existing' as const, current };
  return { text: text.replace(pattern, `$1${value}$3`), action: 'written' as const, current };
}

/** Hyperdrive origin from a postgres:// or mysql:// URL, validated like `wrangler hyperdrive create --connection-string`. */
export function hyperdriveOrigin(connectionString: string, name = 'EDGEWATCH_POSTGRES_URL') {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new SetupError(`${name} is not a valid URL (expected postgres://user:password@host:5432/database or mysql://...:3306/...).`);
  }
  const mysql = url.protocol === 'mysql:';
  if (!mysql && url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new SetupError(`${name} must start with postgres://, postgresql:// or mysql://.`);
  const missing = [!url.hostname && 'host', !url.username && 'user', !url.password && 'password', url.pathname.length < 2 && 'database'].filter(Boolean);
  if (missing.length) throw new SetupError(`${name} is missing: ${missing.join(', ')}.`);
  return {
    scheme: mysql ? 'mysql' : 'postgres',
    host: url.hostname,
    port: Number(url.port || (mysql ? 3306 : 5432)),
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

const HYPERDRIVE_FIELD = /("binding":\s*"HYPERDRIVE",\s*"id":\s*")([^"]*)(")/;

/** Sets the HYPERDRIVE binding id, adding the binding after compatibility_flags when the config has none. */
function setHyperdrive(text: string, value: string, force: boolean) {
  if (HYPERDRIVE_FIELD.test(text)) return setField(text, HYPERDRIVE_FIELD, value, force);
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.includes('"compatibility_flags"'));
  if (at < 0) throw new SetupError('Expected field not found ("compatibility_flags")');
  lines.splice(at + 1, 0, `  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "${value}" }],`);
  return { text: lines.join('\n'), action: 'written' as const, current: '' };
}

/** Queues keep unconsumed messages up to 14 days (Workers Paid). */
export const QUEUE_RETENTION_SECONDS = 14 * 86_400;

export async function setup(o: SetupOptions): Promise<SetupResult> {
  const log = o.log ?? console.log;
  const run = o.run ?? ((cmd, args, opts) => {
    const r = spawnSync(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, encoding: 'utf8' });
    return { status: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  });
  const result: SetupResult = { account: null, resources: {}, configs: [], migrations: 'skipped', postgresMigrations: 'off', secret: 'skipped', warnings: [], preflight: [] };
  const report = (checks: PreflightCheck[]) => {
    result.preflight = checks;
    for (const c of checks) log(`[preflight] ${c.status.padEnd(7)} ${c.check}: ${c.message}`);
  };
  if (o.validate) {
    report((await preflight(o)).checks);
    return result;
  }
  const names = readNames(o.root, o.kvTitle ?? 'edgewatch-api-keys');
  const retention = o.retentionDays ?? 30;
  const queueRetention = o.queueRetentionSeconds ?? QUEUE_RETENTION_SECONDS;
  if (!Number.isInteger(queueRetention) || queueRetention < 60 || queueRetention > QUEUE_RETENTION_SECONDS) {
    throw new SetupError('EDGEWATCH_QUEUE_RETENTION_SECONDS must be an integer between 60 and 1209600.');
  }
  const offline = !o.token;
  if (o.postgresUrl && o.mysqlUrl) throw new SetupError('Set EDGEWATCH_POSTGRES_URL or EDGEWATCH_MYSQL_URL, not both.');
  const dbUrl = o.postgresUrl ?? o.mysqlUrl;
  const dbVar = o.postgresUrl ? 'EDGEWATCH_POSTGRES_URL' : 'EDGEWATCH_MYSQL_URL';
  const origin = dbUrl ? hyperdriveOrigin(dbUrl, dbVar) : undefined;
  const dbLabel = origin?.scheme === 'mysql' ? 'MySQL' : 'Postgres';
  const hyperdriveName = o.hyperdriveName ?? (origin?.scheme === 'mysql' ? 'edgewatch-mysql' : 'edgewatch-pg');

  if (offline && !o.dryRun) {
    throw new SetupError(
      'CLOUDFLARE_API_TOKEN is not set. Create an API token with Workers KV Storage:Edit, D1:Edit, Workers R2 Storage:Edit, ' +
        'Queues:Edit and Workers Scripts:Edit, then: export CLOUDFLARE_API_TOKEN=... (and CLOUDFLARE_ACCOUNT_ID=... if the token ' +
        'can see several accounts). Use --dry-run to preview without credentials.',
    );
  }

  // Every binding and secret is checked before the first remote change; a dry run reports problems and keeps planning.
  const checked = await preflight(o);
  report(checked.checks);
  if (!checked.ok && !o.dryRun) {
    const errors = checked.checks.filter((c) => c.status === 'error').map((c) => `${c.check}: ${c.message}`);
    throw new SetupError(`Preflight failed, nothing was changed:\n  ${errors.join('\n  ')}`);
  }

  let kvId: string | undefined;
  let d1Id: string | undefined;
  let hyperdriveId: string | undefined;

  if (offline) {
    log('[dry-run] CLOUDFLARE_API_TOKEN is not set: offline plan, no Cloudflare API calls.');
    for (const [k, name] of Object.entries({ kv: names.kv, d1: names.d1, r2: names.r2, queue: names.queue, dlq: names.dlq })) {
      result.resources[k] = { name, action: 'planned' };
      log(`[dry-run] find or create ${k} "${name}"`);
    }
    if (origin) {
      result.resources.hyperdrive = { name: hyperdriveName, action: 'planned' };
      log(`[dry-run] find or create hyperdrive "${hyperdriveName}" (${origin.host}:${origin.port}/${origin.database})`);
    }
  } else {
    const cf = cloudflare(o.token!, o.fetch ?? fetch);
    let account = o.accountId;
    if (!account) {
      const { result: accounts } = await cf<{ id: string; name: string }[]>('GET', '/accounts?per_page=50');
      if (accounts.length !== 1) {
        throw new SetupError(`The token can see ${accounts.length} accounts (${accounts.map((a) => a.name).join(', ')}); set CLOUDFLARE_ACCOUNT_ID.`);
      }
      account = accounts[0].id;
    }
    result.account = account;
    const a = `/accounts/${account}`;
    const create = async <T>(key: string, name: string, path: string, body: unknown, id: (r: T) => string) => {
      if (o.dryRun) {
        result.resources[key] = { name, action: 'would-create' };
        log(`[dry-run] would create ${key} "${name}"`);
        return undefined;
      }
      const { result: r } = await cf<T>('POST', path, body);
      result.resources[key] = { name, id: id(r), action: 'created' };
      log(`created ${key} "${name}"${id(r) ? ` (${id(r)})` : ''}`);
      return id(r);
    };
    const found = (key: string, name: string, id?: string) => {
      result.resources[key] = { name, id, action: 'exists' };
      log(`exists  ${key} "${name}"${id ? ` (${id})` : ''}`);
      return id;
    };

    // KV namespace (paginated list)
    for (let page = 1; !kvId; page++) {
      const { result: list } = await cf<{ id: string; title: string }[]>('GET', `${a}/storage/kv/namespaces?per_page=100&page=${page}`);
      kvId = list.find((n) => n.title === names.kv)?.id;
      if (kvId) found('kv', names.kv, kvId);
      if (list.length < 100) break;
    }
    kvId ??= await create<{ id: string }>('kv', names.kv, `${a}/storage/kv/namespaces`, { title: names.kv }, (r) => r.id);

    // D1 database
    const { result: dbs } = await cf<{ uuid: string; name: string }[]>('GET', `${a}/d1/database?name=${encodeURIComponent(names.d1)}&per_page=100`);
    d1Id = dbs.find((d) => d.name === names.d1)?.uuid;
    d1Id = d1Id ? found('d1', names.d1, d1Id) : await create<{ uuid: string }>('d1', names.d1, `${a}/d1/database`, { name: names.d1 }, (r) => r.uuid);

    // R2 bucket + lifecycle rules
    const bucket = await cf<unknown>('GET', `${a}/r2/buckets/${names.r2}`, undefined, [404]);
    const bucketExists = bucket.status !== 404;
    if (bucketExists) found('r2', names.r2);
    else await create('r2', names.r2, `${a}/r2/buckets`, { name: names.r2 }, () => '');
    const ours = [
      { id: 'edgewatch-incoming', prefix: 'incoming/', days: 1 },
      { id: 'edgewatch-traces-retention', prefix: 'traces/', days: retention > 0 ? retention + 1 : 0 },
    ].filter((r) => r.days > 0);
    if (!o.dryRun) {
      const { result: lc } = await cf<{ rules?: { id: string }[] }>('GET', `${a}/r2/buckets/${names.r2}/lifecycle`, undefined, [404]);
      const keep = (lc?.rules ?? []).filter((r) => !ours.some((x) => x.id === r.id));
      await cf('PUT', `${a}/r2/buckets/${names.r2}/lifecycle`, {
        rules: [...keep, ...ours.map((r) => ({ id: r.id, enabled: true, conditions: { prefix: r.prefix }, deleteObjectsTransition: { condition: { type: 'Age', maxAge: r.days * 86400 } } }))],
      });
      log(`R2 lifecycle: ${ours.map((r) => `${r.prefix} -> ${r.days}d`).join(', ')}${keep.length ? ` (kept ${keep.length} other rule(s))` : ''}`);
    } else {
      log(`[dry-run] would set R2 lifecycle: ${ours.map((r) => `${r.prefix} -> ${r.days}d`).join(', ')}`);
    }

    // Queues, keeping unconsumed messages for 14 days (default 4) so a long consumer outage or a full DLQ loses nothing.
    const settings = { message_retention_period: queueRetention };
    const { result: queues } = await cf<{ queue_id: string; queue_name: string; settings?: { message_retention_period?: number } }[]>('GET', `${a}/queues?per_page=100`);
    for (const [key, name] of [['queue', names.queue], ['dlq', names.dlq]] as const) {
      const q = queues.find((x) => x.queue_name === name);
      if (!q) {
        await create<{ queue_id: string }>(key, name, `${a}/queues`, { queue_name: name, settings }, (r) => r.queue_id);
        continue;
      }
      found(key, name, q.queue_id);
      if (q.settings?.message_retention_period === queueRetention) continue;
      if (o.dryRun) {
        log(`[dry-run] would set ${key} "${name}" message retention to ${queueRetention} seconds`);
      } else {
        await cf('PATCH', `${a}/queues/${q.queue_id}`, { settings });
        log(`updated ${key} "${name}": message retention ${queueRetention} seconds`);
      }
    }

    // Hyperdrive configuration for the optional Postgres event store
    if (origin) {
      const { result: configs } = await cf<{ id: string; name: string }[]>('GET', `${a}/hyperdrive/configs`);
      hyperdriveId = configs.find((c) => c.name === hyperdriveName)?.id;
      hyperdriveId = hyperdriveId
        ? found('hyperdrive', hyperdriveName, hyperdriveId)
        : await create<{ id: string }>('hyperdrive', hyperdriveName, `${a}/hyperdrive/configs`, { name: hyperdriveName, origin }, (r) => r.id);
    }

    // Signing secret on the ingest Worker (only if missing)
    if (!o.skipSecret) {
      const secrets = await cf<{ name: string }[]>('GET', `${a}/workers/scripts/${names.ingestScript}/secrets`, undefined, [404]);
      if (secrets.status === 404) {
        result.secret = 'after-deploy';
        result.warnings.push(`Worker ${names.ingestScript} is not deployed yet: run this script again after scripts/deploy.sh to set TOKEN_SIGNING_SECRET.`);
      } else if (secrets.result.some((s) => s.name === 'TOKEN_SIGNING_SECRET')) {
        result.secret = 'exists';
      } else if (o.dryRun) {
        result.secret = 'planned';
      } else {
        await cf('PUT', `${a}/workers/scripts/${names.ingestScript}/secrets`, { name: 'TOKEN_SIGNING_SECRET', text: randomBytes(32).toString('base64url'), type: 'secret_text' });
        result.secret = 'set';
      }
      log(`secret  TOKEN_SIGNING_SECRET: ${result.secret}`);
    }
  }

  // Write IDs into the wrangler configs
  const kvValue = kvId ?? '<kv-namespace-id>';
  const d1Value = d1Id ?? '<d1-database-id>';
  const edits: [keyof typeof CONFIGS, string, RegExp, string][] = [
    ['ingest', 'API_KEYS.id', /("binding":\s*"API_KEYS",\s*"id":\s*")([^"]*)(")/, kvValue],
    ['api', 'API_KEYS.id', /("binding":\s*"API_KEYS",\s*"id":\s*")([^"]*)(")/, kvValue],
    ['consumer', 'API_KEYS.id', /("binding":\s*"API_KEYS",\s*"id":\s*")([^"]*)(")/, kvValue],
    ['consumer', 'DB.database_id', new RegExp(`("database_name":\\s*"${names.d1}",\\s*"database_id":\\s*")([^"]*)(")`), d1Value],
    ['api', 'DB.database_id', new RegExp(`("database_name":\\s*"${names.d1}",\\s*"database_id":\\s*")([^"]*)(")`), d1Value],
  ];
  if (origin) {
    for (const cfg of ['consumer', 'api'] as const) edits.push([cfg, 'HYPERDRIVE.id', HYPERDRIVE_FIELD, hyperdriveId ?? '<hyperdrive-id>']);
  }
  const texts = new Map<string, string>();
  for (const [cfg, field, pattern, value] of edits) {
    const file = CONFIGS[cfg];
    const before = texts.get(file) ?? readFileSync(join(o.root, file), 'utf8');
    const r = pattern === HYPERDRIVE_FIELD ? setHyperdrive(before, value, !!o.force) : setField(before, pattern, value, !!o.force);
    const action = r.action === 'written' && (o.dryRun || offline) ? 'would-write' : r.action;
    if (r.action === 'kept-existing') result.warnings.push(`${file} ${field} keeps ${r.current} (Cloudflare has ${value}); pass --force to replace it.`);
    if (!o.dryRun && !offline) texts.set(file, r.text);
    result.configs.push({ file, field, action, value: action === 'kept-existing' ? r.current : value });
    log(`config  ${file} ${field}: ${action}${action === 'kept-existing' ? ` (${r.current})` : ''}`);
  }
  for (const [file, text] of texts) writeFileSync(join(o.root, file), text);

  // D1 migrations (wrangler tracks applied files in d1_migrations, so this is a no-op when up to date)
  if (o.skipMigrations) result.migrations = 'skipped';
  else if (o.dryRun || offline) {
    result.migrations = 'planned';
    log(`[dry-run] would run: wrangler d1 migrations apply ${names.d1} --remote (workers/consumer)`);
  } else {
    const wrangler = join(o.root, 'workers/consumer/node_modules/.bin/wrangler');
    const r = run(wrangler, ['d1', 'migrations', 'apply', names.d1, '--remote'], {
      cwd: join(o.root, 'workers/consumer'),
      env: { CLOUDFLARE_API_TOKEN: o.token!, CLOUDFLARE_ACCOUNT_ID: result.account!, CI: '1' },
    });
    if (r.status !== 0) throw new SetupError(`D1 migrations failed:\n${r.output}`);
    result.migrations = 'applied';
    log('D1 migrations: applied (or already up to date)');
  }

  // Postgres/MySQL migrations (both migrate scripts track applied files, so re-runs only apply new ones)
  if (dbUrl) {
    const mysql = origin?.scheme === 'mysql';
    if (o.skipMigrations) result.postgresMigrations = 'skipped';
    else if (o.dryRun || offline) {
      result.postgresMigrations = 'planned';
      log(`[dry-run] would run: bun run migrate:${mysql ? 'mysql' : 'postgres'} <${dbVar}>`);
    } else {
      const r = run(process.execPath, [join(o.root, mysql ? 'scripts/mysql-migrate.ts' : 'scripts/pg-migrate.ts'), dbUrl], { cwd: o.root, env: {} });
      if (r.status !== 0) throw new SetupError(`${dbLabel} migrations failed:\n${r.output.split(dbUrl).join(`<${dbVar}>`)}`);
      result.postgresMigrations = 'applied';
      log(`${dbLabel} migrations: applied (or already up to date)`);
    }
  }

  for (const w of result.warnings) log(`warning: ${w}`);
  return result;
}

export interface PreflightCheck {
  status: 'ok' | 'warn' | 'error' | 'skipped';
  check: string;
  message: string;
}

const get = (config: unknown, path: (string | number)[]): unknown =>
  path.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string | number, unknown>)[k] : undefined), config);
const list = (config: unknown, key: string): Record<string, unknown>[] => (Array.isArray(get(config, [key])) ? (get(config, [key]) as Record<string, unknown>[]) : []);

/**
 * Preflight for `--validate` (and the first step of every run): checks the wrangler configs for every binding the
 * Workers need, the environment and URLs, and, with a token, the account and the Worker secrets. It only reads.
 * Setup refuses to make any remote change while an `error` is reported.
 */
export async function preflight(o: SetupOptions): Promise<{ ok: boolean; checks: PreflightCheck[] }> {
  const checks: PreflightCheck[] = [];
  const add = (status: PreflightCheck['status'], check: string, message: string) => checks.push({ status, check, message });
  const cfg: Partial<Record<keyof typeof CONFIGS, unknown>> = {};
  for (const [name, rel] of Object.entries(CONFIGS) as [keyof typeof CONFIGS, string][]) {
    try {
      cfg[name] = parseJsonc(readFileSync(join(o.root, rel), 'utf8'));
      add('ok', `${name} config`, `${rel} parses`);
    } catch (e) {
      add('error', `${name} config`, `${rel}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const vars = (name: keyof typeof CONFIGS) => (get(cfg[name], ['vars']) ?? {}) as Record<string, unknown>;
  const binding = (name: keyof typeof CONFIGS, kind: string, bindingName: string, idField?: string) => {
    if (!cfg[name]) return undefined;
    const entry = list(cfg[name], kind).find((b) => b.binding === bindingName);
    if (!entry) {
      add('error', `${name} ${bindingName}`, `${CONFIGS[name]} has no ${kind} binding "${bindingName}"`);
      return undefined;
    }
    const id = idField ? entry[idField] : undefined;
    if (idField && (typeof id !== 'string' || PLACEHOLDER.test(id))) add('warn', `${name} ${bindingName}`, `${kind} "${bindingName}" has placeholder ${idField}; setup will write it`);
    else add('ok', `${name} ${bindingName}`, `${kind} "${bindingName}" is bound`);
    return entry;
  };
  const externalEvents = (name: 'consumer' | 'api') => !!get(cfg[name], ['hyperdrive']) || !!vars(name).LIBSQL_URL;

  // Bindings each Worker reads (see the Env interfaces).
  binding('ingest', 'kv_namespaces', 'API_KEYS', 'id');
  binding('ingest', 'r2_buckets', 'TRACES');
  const producer = cfg.ingest ? (get(cfg.ingest, ['queues', 'producers']) as Record<string, unknown>[] | undefined)?.find((p) => p.binding === 'INGEST_QUEUE') : undefined;
  if (cfg.ingest) add(producer ? 'ok' : 'error', 'ingest INGEST_QUEUE', producer ? `produces to "${String(producer.queue)}"` : 'no queue producer binding "INGEST_QUEUE"');
  for (const name of ['consumer', 'api'] as const) {
    binding(name, 'kv_namespaces', 'API_KEYS', 'id');
    binding(name, 'r2_buckets', 'TRACES');
    if (externalEvents(name)) add('ok', `${name} DB`, 'event store is Hyperdrive or libSQL; the D1 binding is not used');
    else binding(name, 'd1_databases', 'DB', 'database_id');
  }
  if (cfg.consumer) {
    const consumers = (get(cfg.consumer, ['queues', 'consumers']) as Record<string, unknown>[] | undefined) ?? [];
    const queueName = producer?.queue;
    const main = consumers.find((c) => c.queue === queueName);
    add(main ? 'ok' : 'error', 'consumer queue', main ? `consumes "${String(queueName)}"` : `does not consume the ingest queue "${String(queueName)}"`);
    const dlq = main?.dead_letter_queue;
    const dlqConsumer = consumers.find((c) => c.queue === dlq);
    add(dlq && dlqConsumer ? 'ok' : 'error', 'consumer dead-letter queue', dlq && dlqConsumer ? `"${String(dlq)}" is set and consumed` : 'the ingest queue needs a dead_letter_queue that the consumer also consumes');
    if (dlq && vars('consumer').DEAD_LETTER_QUEUE !== dlq) add('error', 'consumer DEAD_LETTER_QUEUE', `vars.DEAD_LETTER_QUEUE must equal "${String(dlq)}"`);
    const crons = (get(cfg.consumer, ['triggers', 'crons']) as unknown[] | undefined) ?? [];
    add(crons.length >= 2 ? 'ok' : 'error', 'consumer crons', crons.length >= 2 ? `${crons.length} cron triggers` : 'needs the retention and pipeline cron triggers');
  }
  const buckets = (['ingest', 'consumer', 'api'] as const).map((n) => list(cfg[n], 'r2_buckets').find((b) => b.binding === 'TRACES')?.bucket_name).filter(Boolean);
  if (new Set(buckets).size > 1) add('error', 'TRACES bucket', `the Workers bind different buckets (${[...new Set(buckets)].join(', ')})`);
  const dbs = (['consumer', 'api'] as const).map((n) => list(cfg[n], 'd1_databases').find((b) => b.binding === 'DB')?.database_name).filter(Boolean);
  if (new Set(dbs).size > 1) add('error', 'DB database', `consumer and API bind different D1 databases (${[...new Set(dbs)].join(', ')})`);

  // Environment.
  if (o.postgresUrl && o.mysqlUrl) add('error', 'database URL', 'set EDGEWATCH_POSTGRES_URL or EDGEWATCH_MYSQL_URL, not both');
  for (const [v, url] of [['EDGEWATCH_POSTGRES_URL', o.postgresUrl], ['EDGEWATCH_MYSQL_URL', o.mysqlUrl]] as const) {
    if (!url) continue;
    try {
      hyperdriveOrigin(url, v);
      add('ok', v, 'is a complete connection string');
    } catch (e) {
      add('error', v, e instanceof Error ? e.message : String(e));
    }
  }
  if (o.retentionDays !== undefined && !(Number.isInteger(o.retentionDays) && o.retentionDays >= 0)) add('error', 'EDGEWATCH_RETENTION_DAYS', 'must be a whole number of days (0 = keep forever)');
  for (const name of ['consumer', 'api'] as const) {
    if (vars(name).LIBSQL_URL && get(cfg[name], ['hyperdrive'])) add('error', `${name} event store`, 'LIBSQL_URL and HYPERDRIVE are both set; pick one');
  }

  // Secrets each Worker needs, by its configuration.
  const secrets: [string, string, string][] = [];
  if (!o.skipSecret) secrets.push(['ingest', 'edgewatch-ingest', 'TOKEN_SIGNING_SECRET']);
  for (const name of ['ingest', 'consumer', 'api'] as const) {
    const script = String(get(cfg[name], ['name']) ?? `edgewatch-${name}`);
    if (name === 'ingest' && secrets[0]) secrets[0][1] = script;
    if (vars(name).LIBSQL_URL) secrets.push([name, script, 'LIBSQL_AUTH_TOKEN']);
    if (vars(name).S3_BUCKET) secrets.push([name, script, 'S3_ACCESS_KEY_ID'], [name, script, 'S3_SECRET_ACCESS_KEY']);
  }

  if (!o.token) {
    const offlineOk = o.dryRun || o.validate;
    add(offlineOk ? 'skipped' : 'error', 'CLOUDFLARE_API_TOKEN', offlineOk ? 'not set: account and secret checks skipped' : 'not set');
    for (const [name, , secret] of secrets) add('skipped', `${name} ${secret}`, 'needs CLOUDFLARE_API_TOKEN to check');
  } else {
    const cf = cloudflare(o.token, o.fetch ?? fetch);
    let account = o.accountId;
    try {
      if (!account) {
        const { result: accounts } = await cf<{ id: string; name: string }[]>('GET', '/accounts?per_page=50');
        if (accounts.length !== 1) throw new SetupError(`the token can see ${accounts.length} accounts; set CLOUDFLARE_ACCOUNT_ID`);
        account = accounts[0]?.id;
      }
      add('ok', 'CLOUDFLARE_API_TOKEN', `accepted for account ${account}`);
    } catch (e) {
      add('error', 'CLOUDFLARE_API_TOKEN', e instanceof Error ? e.message : String(e));
      account = undefined;
    }
    for (const [name, script, secret] of secrets) {
      if (!account) {
        add('skipped', `${name} ${secret}`, 'account not resolved');
        continue;
      }
      try {
        const r = await cf<{ name: string }[]>('GET', `/accounts/${account}/workers/scripts/${script}/secrets`, undefined, [404]);
        const has = r.status !== 404 && r.result.some((s) => s.name === secret);
        if (has) add('ok', `${name} ${secret}`, `set on ${script}`);
        else if (secret === 'TOKEN_SIGNING_SECRET') add('warn', `${name} ${secret}`, r.status === 404 ? `${script} is not deployed; rerun setup after deploy to set it` : 'missing; setup will set it');
        else if (r.status === 404) add('warn', `${name} ${secret}`, `${script} is not deployed yet; after deploy: wrangler secret put ${secret}`);
        else add('error', `${name} ${secret}`, `missing on ${script}: wrangler secret put ${secret}`);
      } catch (e) {
        add('error', `${name} ${secret}`, e instanceof Error ? e.message : String(e));
      }
    }
  }
  return { ok: !checks.some((c) => c.status === 'error'), checks };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const validate = argv.includes('--validate');
    const result = await setup({
      root,
      validate,
      token: process.env.CLOUDFLARE_API_TOKEN || undefined,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID || undefined,
      dryRun: argv.includes('--dry-run'),
      force: argv.includes('--force'),
      skipMigrations: argv.includes('--skip-migrations'),
      skipSecret: argv.includes('--skip-secret'),
      kvTitle: process.env.EDGEWATCH_KV_TITLE,
      queueRetentionSeconds: process.env.EDGEWATCH_QUEUE_RETENTION_SECONDS ? Number(process.env.EDGEWATCH_QUEUE_RETENTION_SECONDS) : undefined,
      retentionDays: process.env.EDGEWATCH_RETENTION_DAYS ? Number(process.env.EDGEWATCH_RETENTION_DAYS) : undefined,
      postgresUrl: process.env.EDGEWATCH_POSTGRES_URL || undefined,
      mysqlUrl: process.env.EDGEWATCH_MYSQL_URL || undefined,
      hyperdriveName: process.env.EDGEWATCH_HYPERDRIVE_NAME || undefined,
    });
    if (validate) {
      const errors = result.preflight.filter((c) => c.status === 'error').length;
      console.log(errors ? `\nValidation failed: ${errors} error(s). Nothing was changed.` : '\nValidation passed. Nothing was changed.');
      process.exit(errors ? 1 : 0);
    }
    console.log(argv.includes('--dry-run') ? '\nDry run: nothing was created or written.' : '\nDone. Next: scripts/deploy.sh (see docs/deployment.md).');
  } catch (e) {
    console.error(`\nsetup-cloudflare: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
