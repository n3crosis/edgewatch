#!/usr/bin/env bun
/**
 * EdgeWatch as one Bun process: ingest, consumer and API on one port, plus the dashboard when DASHBOARD_DIR is set.
 *
 *   bun apps/server/src/main.ts                 serve (default)
 *   bun apps/server/src/main.ts migrate         apply migrations and exit
 *   bun apps/server/src/main.ts setup ...       create the initial owner account (email + password)
 *   bun apps/server/src/main.ts accounts ...    list/create accounts and reset passwords without removing data
 *   bun apps/server/src/main.ts keys <cmd> ...  manage API keys (same commands as scripts/keys.ts)
 *
 * Environment: PORT (8080), HOST (0.0.0.0), EDGEWATCH_DATA_DIR (./data: SQLite file, blobs, signing secret),
 * DATABASE_URL (postgres://..., mysql://... or libsql:// / https:// with LIBSQL_AUTH_TOKEN, instead of SQLite), S3_ENDPOINT/S3_BUCKET/S3_REGION/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY
 * (S3 instead of local files), OWNER_EMAIL/OWNER_PASSWORD/OWNER_NAME (optional auto-bootstrap for the first owner),
 * OWNER_SETUP_TOKEN (optional token required for browser setup), ACCESS_LOG (one line per request),
 * RATE_LIMIT (600 per RATE_LIMIT_PERIOD per project, 0 disables), DASHBOARD_DIR, and the Worker vars in VAR_NAMES.
 * API keys always live in the event store's kv_store table.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log, s3BlobStore, SqlKeyStore, type BlobStore, type SqlDatabase } from '@edgewatch/shared';
import { connectLibsql, isLibsqlUrl } from '@edgewatch/shared/libsql';
import { connectMysql } from '@edgewatch/shared/mysql';
import { connectPostgres } from '@edgewatch/shared/postgres';
import { main as accountsCli } from '../../../scripts/accounts';
import { main as keys, sqlStore } from '../../../scripts/keys';
import { migrate as migrateLibsql } from '../../../scripts/libsql-migrate';
import { migrate as migrateMysql } from '../../../scripts/mysql-migrate';
import { migrate as migratePostgres } from '../../../scripts/pg-migrate';
import { Accounts } from '../../../workers/api/src/accounts';
import { defaultDisplayName, hashPassword, normalizeEmail, passwordProblem } from '../../../workers/api/src/passwords';
import { createEdgeWatch, VAR_NAMES } from './app';
import { SqliteQueueStore } from './queue-store';
import type { IngestMessage } from '@edgewatch/shared';
import { FsBlobStore } from './fs-blob';
import { BunSqliteDatabase, migrateSqlite } from './sqlite';

const MIGRATIONS = join(import.meta.dir, '../../../workers/migrations');
const env = process.env;
const dataDir = env.EDGEWATCH_DATA_DIR ?? './data';
mkdirSync(dataDir, { recursive: true });

async function openDb(): Promise<{ db: SqlDatabase; kind: string; close: () => Promise<void> }> {
  if (env.DATABASE_URL && isLibsqlUrl(env.DATABASE_URL)) {
    await migrateLibsql(env.DATABASE_URL, { authToken: env.LIBSQL_AUTH_TOKEN, log: (l) => log('server', 'info', 'migration', { detail: l }) });
    const lib = connectLibsql(env.DATABASE_URL, env.LIBSQL_AUTH_TOKEN);
    return { db: lib.db, kind: 'libsql', close: lib.close };
  }
  if (env.DATABASE_URL && /^mysql:\/\//i.test(env.DATABASE_URL)) {
    await migrateMysql(env.DATABASE_URL, { log: (l) => log('server', 'info', 'migration', { detail: l }) });
    const my = connectMysql(env.DATABASE_URL, { max: Number(env.DATABASE_POOL ?? 10) });
    return { db: my.db, kind: 'mysql', close: my.close };
  }
  if (env.DATABASE_URL) {
    await migratePostgres(env.DATABASE_URL, { log: (l) => log('server', 'info', 'migration', { detail: l }) });
    const pg = connectPostgres(env.DATABASE_URL, { max: Number(env.DATABASE_POOL ?? 10) });
    return { db: pg.db, kind: 'postgres', close: pg.close };
  }
  const db = new BunSqliteDatabase(join(dataDir, 'edgewatch.sqlite'));
  migrateSqlite(db, MIGRATIONS, (l) => log('server', 'info', 'migration', { detail: l }));
  return { db, kind: 'sqlite', close: async () => db.raw.close() };
}

function openBlobs(): { blobs: BlobStore; kind: string } {
  if (!env.S3_BUCKET) return { blobs: new FsBlobStore(join(dataDir, 'blobs')), kind: 'files' };
  const missing = ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`S3_BUCKET is set but ${missing.join(', ')} missing.`);
  return {
    blobs: s3BlobStore({ endpoint: env.S3_ENDPOINT ?? '', bucket: env.S3_BUCKET, region: env.S3_REGION, accessKeyId: env.S3_ACCESS_KEY_ID ?? '', secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '' }),
    kind: 's3',
  };
}

/** TOKEN_SIGNING_SECRET from the environment, else generated once and kept in the data dir so agent tokens survive restarts. */
function signingSecret(): string {
  if (env.TOKEN_SIGNING_SECRET) return env.TOKEN_SIGNING_SECRET;
  const file = join(dataDir, 'signing-secret');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('base64url'), { mode: 0o600 });
  return readFileSync(file, 'utf8').trim();
}

function parseSetupArgs(args: string[]): { email?: string; password?: string; name?: string } {
  const positional: string[] = [];
  let email = env.OWNER_EMAIL;
  let password = env.OWNER_PASSWORD;
  let name = env.OWNER_NAME;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--email' && args[i + 1]) email = args[++i];
    else if (arg === '--password' && args[i + 1]) password = args[++i];
    else if (arg === '--name' && args[i + 1]) name = args[++i];
    else if (!arg.startsWith('-')) positional.push(arg);
  }
  return {
    email: email ?? positional[0],
    password: password ?? positional[1],
    name: name ?? positional[2],
  };
}

const [command = 'serve', ...rest] = process.argv.slice(2);
const store = await openDb();

if (command === 'migrate') {
  await store.close();
} else if (command === 'setup') {
  const accounts = new Accounts(store.db);
  if (await accounts.hasOwner()) {
    console.log('Owner account already exists.');
    await store.close();
    process.exit(0);
  }
  const { email: rawEmail, password, name } = parseSetupArgs(rest);
  const email = normalizeEmail(rawEmail);
  const problem = passwordProblem(password);
  if (!email || problem) {
    console.error(problem ?? 'Provide a valid email address and password (min 8 characters).');
    console.error('Usage: bun apps/server/src/main.ts setup --email admin@example.com --password <password> [--name Owner]');
    await store.close();
    process.exit(1);
  }
  const displayName = name?.trim() ? name.trim().slice(0, 100) : defaultDisplayName(email);
  const owner = await accounts.createOwner(email, displayName, await hashPassword(password!));
  console.log(`Created owner account: ${owner.email} (${owner.name})`);
  await store.close();
} else if (command === 'accounts') {
  const code = await accountsCli(rest, store.db);
  await store.close();
  process.exit(code);
} else if (command === 'keys') {
  const code = await keys(rest, sqlStore(new SqlKeyStore(store.db)));
  await store.close();
  process.exit(code);
} else if (command === 'serve') {
  const accounts = new Accounts(store.db);
  if (env.OWNER_EMAIL || env.OWNER_PASSWORD) {
    const email = normalizeEmail(env.OWNER_EMAIL);
    const problem = passwordProblem(env.OWNER_PASSWORD);
    if (!email || problem) {
      log('server', 'warn', 'owner_bootstrap_invalid', { detail: problem ?? 'OWNER_EMAIL must be a valid email address.' });
    } else {
      const created = await accounts.ensureBootstrapOwner(email, env.OWNER_PASSWORD, env.OWNER_NAME);
      if (created) log('server', 'info', 'owner_created', { email: created.email, name: created.name });
    }
  }
  const { blobs, kind: blobKind } = openBlobs();
  const vars = Object.fromEntries(VAR_NAMES.map((k) => [k, env[k]]).filter(([, v]) => v !== undefined));
  const journal = new SqliteQueueStore<IngestMessage>(join(dataDir, 'queue.sqlite'));
  const app = createEdgeWatch({
    queue: { store: journal },
    db: store.db,
    blobs,
    vars: { ...vars, TOKEN_SIGNING_SECRET: signingSecret() },
    rateLimit: Number(env.RATE_LIMIT ?? 600),
    dashboardDir: env.DASHBOARD_DIR,
    backends: { events: store.kind, blobs: blobKind },
  });
  app.startCrons();
  const server = Bun.serve({
    port: Number(env.PORT ?? 8080),
    hostname: env.HOST ?? '0.0.0.0',
    maxRequestBodySize: Number(env.MAX_BODY_BYTES ?? 20_000_000) + 1024,
    fetch: env.ACCESS_LOG
      ? async (req) => {
          const res = await app.fetch(req);
          console.log(`${req.method} ${new URL(req.url).pathname} ${res.status}`);
          return res;
        }
      : app.fetch,
  });
  const ownerExists = await accounts.hasOwner();
  log('server', 'info', 'listening', {
    url: String(server.url),
    events: store.kind,
    blobs: blobKind,
    keys: 'sql',
    dashboard: !!env.DASHBOARD_DIR,
    setup_required: !ownerExists,
  });
  if (!ownerExists && env.DASHBOARD_DIR) {
    log('server', 'info', 'first_run_setup', {
      message: `Open ${server.url} to create your owner account, or set OWNER_EMAIL and OWNER_PASSWORD.`,
    });
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.stop();
    await app.close();
    journal.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} else {
  console.error(`unknown command: ${command} (serve | migrate | setup | accounts | keys)`);
  process.exit(2);
}
