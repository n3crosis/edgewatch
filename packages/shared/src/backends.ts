import { connectLibsql } from './libsql-client';
import { connectMysql } from './mysql2';
import { connectPostgres } from './postgres-js';
import { s3BlobStore } from './s3';
import { SqlKeyStore } from './sql-keystore';
import { healthHttpStatus, HealthCheckError, runHealthChecks, type HealthCheck, type HealthOptions, type HealthReport, type HealthService } from './health';
import type { BlobStore, KeyStore, SqlDatabase } from './storage';

/**
 * Optional bindings/vars that swap a Cloudflare storage binding for another backend (docs/architecture.md, "Storage
 * backends"). With none set, the Workers use D1, R2 and KV as bound.
 */
export interface BackendEnv {
  DB?: SqlDatabase;
  TRACES?: BlobStore;
  API_KEYS?: KeyStore;
  /** Event store: Postgres or MySQL (by the URL scheme) through Hyperdrive instead of D1. */
  HYPERDRIVE?: { connectionString: string };
  /** Event store: libSQL / Turso over HTTP (`libsql://`, `https://`) instead of D1; token in the LIBSQL_AUTH_TOKEN secret. */
  LIBSQL_URL?: string;
  LIBSQL_AUTH_TOKEN?: string;
  /** Blob store: an S3-compatible bucket instead of R2 when S3_BUCKET is set. */
  S3_ENDPOINT?: string;
  S3_BUCKET?: string;
  S3_REGION?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  /** Key store: `sql` keeps API keys in the event store's kv_store table instead of KV. Default `kv`. */
  KEY_STORE?: string;
}

export class BackendConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendConfigError';
  }
}

export interface OpenBackends<E> {
  env: E;
  /** True when a connection was opened (Postgres, MySQL or libSQL) and `close()` must be called. */
  connected: boolean;
  close(): Promise<void>;
}

/** Which backend serves each store for this env (logged at startup by the Node server, shown in docs). */
export const isMysqlUrl = (url: string) => /^mysql:\/\//i.test(url);

export function describeBackends(env: BackendEnv): { events: 'd1' | 'postgres' | 'mysql' | 'libsql'; blobs: 'r2' | 's3'; keys: 'kv' | 'sql' } {
  const hyperdrive = env.HYPERDRIVE && (isMysqlUrl(env.HYPERDRIVE.connectionString) ? 'mysql' : 'postgres');
  return { events: hyperdrive || (env.LIBSQL_URL ? 'libsql' : 'd1'), blobs: env.S3_BUCKET ? 's3' : 'r2', keys: env.KEY_STORE === 'sql' ? 'sql' : 'kv' };
}

/**
 * Returns `env` with DB, TRACES and API_KEYS replaced according to the backend settings, plus `close()` for the
 * database connection (Postgres, MySQL or libSQL; call it when the request or batch is done). Throws BackendConfigError when a selected backend
 * is missing a setting, so a half-configured deployment fails loudly instead of silently using another store.
 */
export function openBackends<E extends BackendEnv>(env: E): OpenBackends<E> {
  const kind = describeBackends(env);
  let close = async () => {};
  let db = env.DB;
  if (env.HYPERDRIVE && env.LIBSQL_URL) throw new BackendConfigError('Set HYPERDRIVE or LIBSQL_URL, not both.');
  if (kind.events === 'libsql' && env.LIBSQL_URL) {
    const conn = connectLibsql(env.LIBSQL_URL, env.LIBSQL_AUTH_TOKEN);
    db = conn.db;
    close = conn.close;
  } else if (kind.events !== 'd1' && env.HYPERDRIVE) {
    const conn = (kind.events === 'mysql' ? connectMysql : connectPostgres)(env.HYPERDRIVE.connectionString);
    db = conn.db;
    close = conn.close;
  }
  let traces = env.TRACES;
  if (kind.blobs === 's3') {
    const missing = (['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const).filter((k) => !env[k]);
    if (missing.length) throw new BackendConfigError(`S3_BUCKET is set but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} missing.`);
    traces = s3BlobStore({
      endpoint: env.S3_ENDPOINT ?? '', bucket: env.S3_BUCKET ?? '', region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID ?? '', secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
    });
  }
  let keys = env.API_KEYS;
  if (kind.keys === 'sql') {
    if (!db) throw new BackendConfigError('KEY_STORE=sql needs an event store: bind DB (D1) or HYPERDRIVE, or set LIBSQL_URL.');
    keys = sqlKeyStoreFor(db);
  }
  return { env: { ...env, DB: db, TRACES: traces, API_KEYS: keys }, connected: db !== env.DB, close };
}

// One SqlKeyStore per database object keeps the cacheTtl cache across requests in the same isolate (D1). A Postgres
// database is opened per request, so its store caches nothing across requests; Hyperdrive's own query cache applies.
const keyStores = new WeakMap<SqlDatabase, SqlKeyStore>();
function sqlKeyStoreFor(db: SqlDatabase): SqlKeyStore {
  let store = keyStores.get(db);
  if (!store) keyStores.set(db, (store = new SqlKeyStore(db)));
  return store;
}

/**
 * GET /healthz for a Worker: opens the configured backends (a half-configured one is reported as a failing `config`
 * check instead of a 500), runs the service's checks against them and closes any connection it opened.
 */
export async function backendHealth<E extends BackendEnv>(
  service: HealthService,
  env: E,
  checks: (env: E, kind: ReturnType<typeof describeBackends>) => Record<string, HealthCheck>,
  options?: HealthOptions,
): Promise<HealthReport> {
  let opened: OpenBackends<E>;
  try {
    opened = openBackends(env);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return runHealthChecks(service, { config: { required: true, run: () => Promise.reject(new HealthCheckError('not_configured', message)) } }, options);
  }
  try {
    return await runHealthChecks(service, { config: { required: true, run: async () => {} }, ...checks(opened.env, describeBackends(env)) }, options);
  } finally {
    await opened.close().catch(() => {});
  }
}

/** The JSON response for a health report: 503 when down, never cached. */
export const healthResponse = (report: HealthReport): Response =>
  Response.json(report, { status: healthHttpStatus(report), headers: { 'cache-control': 'no-store' } });
