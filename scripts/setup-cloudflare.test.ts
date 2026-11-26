import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configString, hyperdriveOrigin, parseJsonc, QUEUE_RETENTION_SECONDS, SetupError, setup, type SetupOptions } from './setup-cloudflare';

const REPO = join(import.meta.dir, '..');
const FILES = ['workers/ingest/wrangler.jsonc', 'workers/consumer/wrangler.jsonc', 'workers/api/wrangler.jsonc'];

/** In-memory Cloudflare API: just enough of KV, D1, R2, Queues and Worker secrets. */
function fakeCloudflare(accounts = [{ id: 'acc1', name: 'Me' }]) {
  const state = {
    kv: [] as { id: string; title: string }[],
    d1: [] as { uuid: string; name: string }[],
    r2: new Map<string, { rules: { id: string }[] }>(),
    queues: [] as { queue_id: string; queue_name: string; settings?: { message_retention_period?: number } }[],
    scripts: new Map<string, string[]>(),
    hyperdrive: [] as { id: string; name: string; origin: Record<string, unknown> }[],
    calls: [] as string[],
  };
  let n = 0;
  const ok = (result: unknown, status = 200) => new Response(JSON.stringify({ success: true, errors: [], result }), { status });
  const notFound = () => new Response(JSON.stringify({ success: false, errors: [{ code: 10006, message: 'not found' }] }), { status: 404 });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace('/client/v4', '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    state.calls.push(`${method} ${path}`);
    let m: RegExpMatchArray | null;
    if (path === '/accounts') return ok(accounts);
    if (path.endsWith('/storage/kv/namespaces')) {
      if (method === 'GET') return ok(state.kv);
      const ns = { id: `kv${++n}`.padEnd(32, '0'), title: body.title };
      state.kv.push(ns);
      return ok(ns);
    }
    if (path.endsWith('/d1/database')) {
      if (method === 'GET') return ok(state.d1.filter((d) => d.name === url.searchParams.get('name')));
      const db = { uuid: `d1-uuid-${++n}`, name: body.name };
      state.d1.push(db);
      return ok(db);
    }
    if ((m = path.match(/\/r2\/buckets\/([^/]+)\/lifecycle$/))) {
      const b = state.r2.get(m[1]);
      if (!b) return notFound();
      if (method === 'GET') return ok({ rules: b.rules });
      b.rules = body.rules;
      return ok({});
    }
    if ((m = path.match(/\/r2\/buckets\/([^/]+)$/))) return state.r2.has(m[1]) ? ok({ name: m[1] }) : notFound();
    if (path.endsWith('/r2/buckets')) {
      state.r2.set(body.name, { rules: [] });
      return ok({ name: body.name });
    }
    if (path.endsWith('/queues')) {
      if (method === 'GET') return ok(state.queues);
      const q = { queue_id: `q${++n}`, queue_name: body.queue_name, settings: body.settings };
      state.queues.push(q);
      return ok(q);
    }
    if ((m = path.match(/\/queues\/([^/]+)$/)) && method === 'PATCH') {
      const q = state.queues.find((x) => x.queue_id === m![1]);
      if (!q) return notFound();
      q.settings = { ...q.settings, ...body.settings };
      return ok(q);
    }
    if (path.endsWith('/hyperdrive/configs')) {
      if (method === 'GET') return ok(state.hyperdrive.map(({ id, name }) => ({ id, name })));
      const hd = { id: `hd${++n}`.padEnd(32, '0'), name: body.name, origin: body.origin };
      state.hyperdrive.push(hd);
      return ok(hd);
    }
    if ((m = path.match(/\/workers\/scripts\/([^/]+)\/secrets$/))) {
      const s = state.scripts.get(m[1]);
      if (!s) return notFound();
      if (method === 'GET') return ok(s.map((name) => ({ name, type: 'secret_text' })));
      s.push(body.name);
      return ok({});
    }
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
  const writes = () => state.calls.filter((c) => !c.startsWith('GET'));
  return { state, fetcher, writes };
}

let root: string;
let ran: string[][];
const quiet = () => {};
const opts = (extra: Partial<SetupOptions>): SetupOptions => ({
  root,
  log: quiet,
  run: (_cmd, args) => {
    ran.push(args);
    return { status: 0, output: 'Migrations applied' };
  },
  ...extra,
});
const config = (file: string) => readFileSync(join(root, file), 'utf8');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ew-setup-'));
  for (const f of FILES) {
    cpSync(join(REPO, f), join(root, f), { recursive: true });
    const text = config(f).replace(/("id"\s*:\s*")[^"]+/g, '$1REPLACE_WITH_KV_NAMESPACE_ID')
      .replace(/("database_id"\s*:\s*")[^"]+/g, '$1REPLACE_WITH_D1_DATABASE_ID');
    writeFileSync(join(root, f), text);
  }
  ran = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('setup-cloudflare', () => {
  it('fails with a clear message when CLOUDFLARE_API_TOKEN is missing', async () => {
    await expect(setup(opts({}))).rejects.toThrow(SetupError);
    await expect(setup(opts({}))).rejects.toThrow(/CLOUDFLARE_API_TOKEN is not set/);
  });

  it('dry-run without a token plans offline and changes nothing', async () => {
    const before = FILES.map(config);
    const r = await setup(opts({ dryRun: true }));
    expect(Object.values(r.resources).every((x) => x.action === 'planned')).toBe(true);
    expect(r.configs.every((c) => c.action === 'would-write')).toBe(true);
    expect(r.migrations).toBe('planned');
    expect(FILES.map(config)).toEqual(before);
    expect(ran).toEqual([]);
  });

  it('plans exactly the KV, D1, R2 and queue resources named in the wrangler configs', async () => {
    const lines: string[] = [];
    const r = await setup(opts({ dryRun: true, log: (l: string) => lines.push(l) }));
    expect(r.resources).toEqual({
      kv: { name: 'edgewatch-api-keys', action: 'planned' },
      d1: { name: 'edgewatch', action: 'planned' },
      r2: { name: 'edgewatch-traces', action: 'planned' },
      queue: { name: 'edgewatch-ingest', action: 'planned' },
      dlq: { name: 'edgewatch-ingest-dlq', action: 'planned' },
    });
    for (const [kind, res] of Object.entries(r.resources)) expect(lines).toContain(`[dry-run] find or create ${kind} "${res.name}"`);
    expect([...new Set(r.configs.map((c) => c.file))].sort()).toEqual([...FILES].sort());
  });

  it('dry-run against an already provisioned account plans no changes (verification mode)', async () => {
    const cf = fakeCloudflare();
    await setup(opts({ token: 't', fetch: cf.fetcher }));
    const writes = cf.writes().length;
    ran.length = 0;
    const r = await setup(opts({ token: 't', dryRun: true, fetch: cf.fetcher }));
    expect(Object.values(r.resources).every((x) => x.action === 'exists')).toBe(true);
    expect(r.configs.every((c) => c.action === 'unchanged')).toBe(true);
    expect(cf.writes()).toHaveLength(writes);
  });

  it('dry-run with a token only reads', async () => {
    const cf = fakeCloudflare();
    const r = await setup(opts({ token: 't', dryRun: true, fetch: cf.fetcher }));
    expect(cf.writes()).toEqual([]);
    expect(r.resources.kv.action).toBe('would-create');
    expect(config(FILES[0])).toContain('REPLACE_WITH_KV_NAMESPACE_ID');
  });

  it('creates every resource, writes IDs over placeholders and applies migrations', async () => {
    const cf = fakeCloudflare();
    cf.state.scripts.set('edgewatch-ingest', []);
    const r = await setup(opts({ token: 't', fetch: cf.fetcher }));
    expect(Object.fromEntries(Object.entries(r.resources).map(([k, v]) => [k, v.action]))).toEqual({ kv: 'created', d1: 'created', r2: 'created', queue: 'created', dlq: 'created' });
    expect(cf.state.queues.map((q) => q.queue_name)).toEqual(['edgewatch-ingest', 'edgewatch-ingest-dlq']);
    expect(cf.state.queues.map((q) => q.settings?.message_retention_period)).toEqual([QUEUE_RETENTION_SECONDS, QUEUE_RETENTION_SECONDS]);
    expect(cf.state.r2.get('edgewatch-traces')!.rules.map((x) => x.id)).toEqual(['edgewatch-incoming', 'edgewatch-traces-retention']);
    const kv = cf.state.kv[0].id;
    const d1 = cf.state.d1[0].uuid;
    expect(config('workers/ingest/wrangler.jsonc')).toContain(`"id": "${kv}"`);
    expect(config('workers/api/wrangler.jsonc')).toContain(`"id": "${kv}"`);
    expect(config('workers/consumer/wrangler.jsonc')).toContain(`"id": "${kv}"`);
    expect(config('workers/api/wrangler.jsonc')).toContain(`"database_id": "${d1}"`);
    expect(config('workers/consumer/wrangler.jsonc')).toContain(`"database_id": "${d1}"`);
    expect(config('workers/consumer/wrangler.jsonc')).toContain('// Hourly retention job'); // comments survive
    expect(ran).toEqual([['d1', 'migrations', 'apply', 'edgewatch', '--remote']]);
    expect(r.secret).toBe('set');
    expect(cf.state.scripts.get('edgewatch-ingest')).toEqual(['TOKEN_SIGNING_SECRET']);
  });

  it('is idempotent: a second run creates nothing and leaves configs unchanged', async () => {
    const cf = fakeCloudflare();
    cf.state.scripts.set('edgewatch-ingest', []);
    await setup(opts({ token: 't', fetch: cf.fetcher }));
    const after = FILES.map(config);
    const creates = cf.writes().filter((c) => c.startsWith('POST')).length;
    const r = await setup(opts({ token: 't', fetch: cf.fetcher }));
    expect(cf.writes().filter((c) => c.startsWith('POST')).length).toBe(creates);
    expect(cf.writes().filter((c) => c.startsWith('PATCH'))).toEqual([]);
    expect(cf.state.kv).toHaveLength(1);
    expect(cf.state.d1).toHaveLength(1);
    expect(cf.state.queues).toHaveLength(2);
    expect(Object.values(r.resources).every((x) => x.action === 'exists')).toBe(true);
    expect(r.configs.every((c) => c.action === 'unchanged')).toBe(true);
    expect(r.secret).toBe('exists');
    expect(FILES.map(config)).toEqual(after);
  });

  it('supports free-plan retention and rejects invalid values before writes', async () => {
    const cf = fakeCloudflare();
    await setup(opts({ token: 't', fetch: cf.fetcher, queueRetentionSeconds: 86400 }));
    expect(cf.state.queues.map((q) => q.settings?.message_retention_period)).toEqual([86400, 86400]);
    for (const value of [0, 59, 1209601, NaN, 60.5]) {
      await expect(setup(opts({ token: 't', fetch: cf.fetcher, queueRetentionSeconds: value }))).rejects.toThrow('EDGEWATCH_QUEUE_RETENTION_SECONDS');
    }
  });

  it('raises message retention on existing queues to 14 days, and only plans it in dry-run', async () => {
    const cf = fakeCloudflare();
    cf.state.scripts.set('edgewatch-ingest', []);
    cf.state.queues.push({ queue_id: 'qa', queue_name: 'edgewatch-ingest', settings: { message_retention_period: 345_600 } });
    cf.state.queues.push({ queue_id: 'qb', queue_name: 'edgewatch-ingest-dlq' });
    await setup(opts({ token: 't', fetch: cf.fetcher, dryRun: true }));
    expect(cf.writes()).toEqual([]);
    await setup(opts({ token: 't', fetch: cf.fetcher }));
    expect(cf.writes().filter((c) => c.startsWith('PATCH'))).toEqual(['PATCH /accounts/acc1/queues/qa', 'PATCH /accounts/acc1/queues/qb']);
    expect(cf.state.queues.map((q) => q.settings?.message_retention_period)).toEqual([QUEUE_RETENTION_SECONDS, QUEUE_RETENTION_SECONDS]);
  });

  it('keeps a real (non-placeholder) ID unless --force, and keeps foreign lifecycle rules', async () => {
    const cf = fakeCloudflare();
    cf.state.r2.set('edgewatch-traces', { rules: [{ id: 'my-own-rule' }] });
    const file = 'workers/ingest/wrangler.jsonc';
    writeFileSync(join(root, file), config(file).replace('REPLACE_WITH_KV_NAMESPACE_ID', 'aaaabbbbccccddddeeeeffff00001111'));
    const r = await setup(opts({ token: 't', fetch: cf.fetcher, skipSecret: true }));
    expect(config(file)).toContain('aaaabbbbccccddddeeeeffff00001111');
    expect(r.configs.find((c) => c.file === file)!.action).toBe('kept-existing');
    expect(r.warnings.join('\n')).toMatch(/--force/);
    expect(cf.state.r2.get('edgewatch-traces')!.rules.map((x) => x.id)).toEqual(['my-own-rule', 'edgewatch-incoming', 'edgewatch-traces-retention']);

    await setup(opts({ token: 't', fetch: cf.fetcher, skipSecret: true, force: true }));
    expect(config(file)).toContain(`"id": "${cf.state.kv[0].id}"`);
  });

  it('asks for CLOUDFLARE_ACCOUNT_ID when the token sees several accounts', async () => {
    const cf = fakeCloudflare([{ id: 'a', name: 'One' }, { id: 'b', name: 'Two' }]);
    await expect(setup(opts({ token: 't', fetch: cf.fetcher }))).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    const r = await setup(opts({ token: 't', accountId: 'b', fetch: cf.fetcher, skipSecret: true }));
    expect(r.account).toBe('b');
  });

  it('defers the signing secret until the ingest Worker exists, and fails loudly on migration errors', async () => {
    const cf = fakeCloudflare();
    const r = await setup(opts({ token: 't', fetch: cf.fetcher }));
    expect(r.secret).toBe('after-deploy');
    await expect(setup(opts({ token: 't', fetch: cf.fetcher, run: () => ({ status: 1, output: 'boom' }) }))).rejects.toThrow(/D1 migrations failed/);
  });

  const PG = 'postgres://edge:s3cr%40t@db.example.com:6543/edgewatch';

  it('Postgres: plans Hyperdrive offline without logging the password', async () => {
    const lines: string[] = [];
    const r = await setup(opts({ dryRun: true, postgresUrl: PG, log: (l: string) => lines.push(l) }));
    expect(r.resources.hyperdrive).toEqual({ name: 'edgewatch-pg', action: 'planned' });
    expect(r.postgresMigrations).toBe('planned');
    expect(r.configs.filter((c) => c.field === 'HYPERDRIVE.id').map((c) => [c.file, c.action])).toEqual([
      ['workers/consumer/wrangler.jsonc', 'would-write'],
      ['workers/api/wrangler.jsonc', 'would-write'],
    ]);
    expect(lines.join('\n')).not.toContain('s3cr');
    expect(config('workers/api/wrangler.jsonc')).not.toContain('HYPERDRIVE');
  });

  it('MySQL: plans a mysql Hyperdrive and the MySQL migrations, and refuses both URLs at once', async () => {
    const lines: string[] = [];
    const r = await setup(opts({ dryRun: true, mysqlUrl: 'mysql://edge:s3cr3t@db.example.com/edgewatch', log: (l: string) => lines.push(l) }));
    expect(r.resources.hyperdrive).toEqual({ name: 'edgewatch-mysql', action: 'planned' });
    expect(r.postgresMigrations).toBe('planned');
    expect(lines.join('\n')).toContain('bun run migrate:mysql <EDGEWATCH_MYSQL_URL>');
    expect(lines.join('\n')).toContain('db.example.com:3306/edgewatch');
    expect(lines.join('\n')).not.toContain('s3cr3t');
    await expect(setup(opts({ dryRun: true, postgresUrl: PG, mysqlUrl: 'mysql://u:p@h/db' }))).rejects.toThrow(/not both/);
  });

  it('Postgres: creates Hyperdrive, binds it on consumer and API only, migrates, and is idempotent', async () => {
    const cf = fakeCloudflare();
    const r = await setup(opts({ token: 't', fetch: cf.fetcher, skipSecret: true, postgresUrl: PG, hyperdriveName: 'ew-pg' }));
    expect(cf.state.hyperdrive).toHaveLength(1);
    const hd = cf.state.hyperdrive[0];
    expect(hd.name).toBe('ew-pg');
    expect(hd.origin).toEqual({ scheme: 'postgres', host: 'db.example.com', port: 6543, database: 'edgewatch', user: 'edge', password: 's3cr@t' });
    expect(r.resources.hyperdrive).toEqual({ name: 'ew-pg', id: hd.id, action: 'created' });
    for (const f of ['workers/consumer/wrangler.jsonc', 'workers/api/wrangler.jsonc']) {
      expect(config(f)).toContain(`"hyperdrive": [{ "binding": "HYPERDRIVE", "id": "${hd.id}" }],`);
      expect(() => parseJsonc(config(f))).not.toThrow();
    }
    expect(config('workers/ingest/wrangler.jsonc')).not.toContain('HYPERDRIVE');
    expect(ran.at(-1)).toEqual([join(root, 'scripts/pg-migrate.ts'), PG]);
    expect(r.postgresMigrations).toBe('applied');

    const after = FILES.map(config);
    const again = await setup(opts({ token: 't', fetch: cf.fetcher, skipSecret: true, postgresUrl: PG, hyperdriveName: 'ew-pg' }));
    expect(cf.state.hyperdrive).toHaveLength(1);
    expect(again.resources.hyperdrive.action).toBe('exists');
    expect(again.configs.filter((c) => c.field === 'HYPERDRIVE.id').every((c) => c.action === 'unchanged')).toBe(true);
    expect(FILES.map(config)).toEqual(after);
  });

  it('Postgres: keeps a different existing binding unless --force, and scrubs the URL from migration errors', async () => {
    const cf = fakeCloudflare();
    const file = 'workers/api/wrangler.jsonc';
    writeFileSync(join(root, file), config(file).replace(/("compatibility_flags".*\n)/, '$1  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "mine" }],\n'));
    const r = await setup(opts({ token: 't', fetch: cf.fetcher, skipSecret: true, postgresUrl: PG, skipMigrations: true }));
    expect(config(file)).toContain('"id": "mine"');
    expect(r.configs.find((c) => c.file === file && c.field === 'HYPERDRIVE.id')?.action).toBe('kept-existing');
    expect(r.postgresMigrations).toBe('skipped');
    const run = (_c: string, args: string[]) => ({ status: 1, output: args[0].endsWith('pg-migrate.ts') ? `connect ${PG} refused` : 'ok' });
    const err = await setup(opts({ token: 't', fetch: cf.fetcher, skipSecret: true, postgresUrl: PG, run })).catch((e: Error) => e);
    expect(String(err)).toMatch(/D1 migrations failed|Postgres migrations failed/);
    const pgErr = await setup(opts({ token: 't', fetch: cf.fetcher, skipSecret: true, postgresUrl: PG, run: (c, a) => (a[0] === 'd1' ? { status: 0, output: '' } : run(c, a)) })).catch((e: Error) => e);
    expect(String(pgErr)).toContain('Postgres migrations failed');
    expect(String(pgErr)).not.toContain('s3cr');
  });

  it('Postgres: rejects an incomplete URL before any API call', async () => {
    expect(hyperdriveOrigin('mysql://u:p@h/db', 'EDGEWATCH_MYSQL_URL')).toEqual({ scheme: 'mysql', host: 'h', port: 3306, database: 'db', user: 'u', password: 'p' });
    expect(() => hyperdriveOrigin('mysql://u@h/db', 'EDGEWATCH_MYSQL_URL')).toThrow(/EDGEWATCH_MYSQL_URL is missing: password/);
    expect(() => hyperdriveOrigin('redis://u:p@h/db')).toThrow(/mysql:\/\//);
    expect(() => hyperdriveOrigin('postgres://u@h/db')).toThrow(/missing: password/);
    expect(() => hyperdriveOrigin('postgres://u:p@h')).toThrow(/missing: database/);
    expect(() => hyperdriveOrigin('nope')).toThrow(/not a valid URL/);
    expect(hyperdriveOrigin('postgresql://u:p@h/db').port).toBe(5432);
    const cf = fakeCloudflare();
    await expect(setup(opts({ token: 't', fetch: cf.fetcher, postgresUrl: 'postgres://u@h/db' }))).rejects.toThrow(SetupError);
    expect(cf.state.calls).toEqual([]);
  });

  it('reports a rejected token clearly', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 403 })) as unknown as typeof fetch;
    await expect(setup(opts({ token: 'bad', fetch: fetcher }))).rejects.toThrow(/rejected CLOUDFLARE_API_TOKEN/);
  });
});

describe('wrangler config reading', () => {
  it('reads a nested name from JSONC with comments and trailing commas', () => {
    const config = parseJsonc('{ // c\n "d1_databases": [{ "database_name": "edgewatch", }], /* x */ }');
    expect(configString({ rel: 'w.jsonc', config }, ['d1_databases', 0, 'database_name'])).toBe('edgewatch');
  });

  it('fails with the file and path when a name is missing, empty or not a string', () => {
    for (const config of [{}, { d1_databases: [] }, { d1_databases: [{ database_name: '' }] }, { d1_databases: [{ database_name: 7 }] }, null]) {
      expect(() => configString({ rel: 'workers/consumer/wrangler.jsonc', config }, ['d1_databases', 0, 'database_name'])).toThrow(
        new SetupError('workers/consumer/wrangler.jsonc: expected a name at d1_databases.0.database_name; fix the wrangler config and rerun.'),
      );
    }
  });
});

describe('preflight (--validate, and the first step of every run)', () => {
  const edit = (file: string, from: string | RegExp, to: string) => writeFileSync(join(root, file), config(file).replace(from, to));
  const byCheck = (r: { preflight: { check: string; status: string; message: string }[] }) => Object.fromEntries(r.preflight.map((c) => [c.check, c]));

  it('checks every binding, the queues, crons and the signing secret with reads only', async () => {
    const before = config(FILES[0]);
    const cf = fakeCloudflare();
    const r = await setup(opts({ token: 't', fetch: cf.fetcher, validate: true }));
    const c = byCheck(r);
    for (const check of ['ingest API_KEYS', 'ingest TRACES', 'ingest INGEST_QUEUE', 'consumer API_KEYS', 'consumer TRACES', 'consumer DB', 'api API_KEYS', 'api TRACES', 'api DB', 'consumer queue', 'consumer dead-letter queue', 'consumer crons']) {
      expect(c[check]?.status, check).not.toBe('error');
    }
    expect(c['ingest API_KEYS']?.status).toBe('warn');
    expect(c['ingest TOKEN_SIGNING_SECRET']).toMatchObject({ status: 'warn' });
    expect(c.CLOUDFLARE_API_TOKEN?.status).toBe('ok');
    expect(r.preflight.some((x) => x.status === 'error')).toBe(false);
    expect(cf.writes()).toEqual([]);
    expect(r.resources).toEqual({});
    expect(config(FILES[0])).toBe(before);
  });

  it('works offline: config checks run, account and secret checks are skipped', async () => {
    const r = await setup(opts({ validate: true }));
    const c = byCheck(r);
    expect(c.CLOUDFLARE_API_TOKEN?.status).toBe('skipped');
    expect(c['ingest TOKEN_SIGNING_SECRET']?.status).toBe('skipped');
    expect(r.preflight.some((x) => x.status === 'error')).toBe(false);
  });

  it('stops a real run before any remote change when a binding is missing', async () => {
    edit('workers/api/wrangler.jsonc', /"r2_buckets": \[[^\]]*\],\n/, '');
    const cf = fakeCloudflare();
    await expect(setup(opts({ token: 't', fetch: cf.fetcher }))).rejects.toThrow(/Preflight failed, nothing was changed:\n {2}api TRACES: .*no r2_buckets binding "TRACES"/);
    expect(cf.writes()).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('reports mismatched buckets, a consumer that does not read the ingest queue and missing crons', async () => {
    edit('workers/api/wrangler.jsonc', '"bucket_name": "edgewatch-traces"', '"bucket_name": "other-traces"');
    edit('workers/consumer/wrangler.jsonc', /"triggers": \{[^}]*\},?\n/, '');
    edit('workers/ingest/wrangler.jsonc', '"queue": "edgewatch-ingest"', '"queue": "renamed-ingest"');
    const c = byCheck(await setup(opts({ validate: true })));
    expect(c['TRACES bucket']?.status).toBe('error');
    expect(c['consumer queue']).toMatchObject({ status: 'error', message: expect.stringContaining('renamed-ingest') });
    expect(c['consumer crons']?.status).toBe('error');
  });

  it('requires LIBSQL_AUTH_TOKEN and the S3 keys on deployed Workers whose config selects libSQL or S3', async () => {
    edit('workers/api/wrangler.jsonc', '"vars": {', '"vars": { "LIBSQL_URL": "libsql://db.turso.io", "S3_BUCKET": "traces",');
    const cf = fakeCloudflare();
    cf.state.scripts.set('edgewatch-api', ['S3_ACCESS_KEY_ID']);
    const c = byCheck(await setup(opts({ token: 't', fetch: cf.fetcher, validate: true })));
    expect(c['api DB']?.status).toBe('ok');
    expect(c['api LIBSQL_AUTH_TOKEN']).toMatchObject({ status: 'error', message: expect.stringContaining('wrangler secret put LIBSQL_AUTH_TOKEN') });
    expect(c['api S3_ACCESS_KEY_ID']?.status).toBe('ok');
    expect(c['api S3_SECRET_ACCESS_KEY']?.status).toBe('error');
    cf.state.scripts.set('edgewatch-api', ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'LIBSQL_AUTH_TOKEN']);
    const again = await setup(opts({ token: 't', fetch: cf.fetcher, validate: true }));
    expect(again.preflight.filter((x) => x.status === 'error')).toEqual([]);
  });

  it('reports a bad database URL, both URLs, and a rejected token as errors', async () => {
    const c = byCheck(await setup(opts({ validate: true, postgresUrl: 'postgres://host/db', mysqlUrl: 'mysql://u:p@h/db' })));
    expect(c['database URL']?.status).toBe('error');
    expect(c.EDGEWATCH_POSTGRES_URL).toMatchObject({ status: 'error', message: expect.stringContaining('missing: user, password') });
    const rejected = (async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 403 })) as unknown as typeof fetch;
    const t = byCheck(await setup(opts({ validate: true, token: 'bad', fetch: rejected })));
    expect(t.CLOUDFLARE_API_TOKEN?.status).toBe('error');
    expect(t['ingest TOKEN_SIGNING_SECRET']?.status).toBe('skipped');
  });
});
