#!/usr/bin/env node
// Every Nightwatch record type, end to end: sends one agent-style gzip batch per project, then reads each type back
// through workers/api (D1) and the trace detail (R2), and checks that no project sees another project's markers.
//   node scripts/e2e-records.mjs <ingest base> <api base> <ingest key> <read key> <project>...
// Prints "PASS|FAIL <project> <type> <detail>" lines and a per-type summary; exits 1 on any failure.
import { gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';

const [ingest, api, ingestKey, readKey, ...projects] = process.argv.slice(2);
if (!projects.length) throw new Error('usage: e2e-records.mjs <ingest> <api> <ingest key> <read key> <project>...');

const TYPES = ['request', 'query', 'exception', 'command', 'job-attempt', 'queued-job', 'scheduled-task', 'cache-event', 'outgoing-request', 'mail', 'notification', 'log', 'user'];
const now = Date.now() / 1000;
const plan = projects.map((project, i) => {
  const m = `m${i}${randomUUID().slice(0, 6)}`;
  const M = m[0].toUpperCase() + m.slice(1);
  return { project, m, M, user: `matrix-${m}`, traces: { request: randomUUID(), command: randomUUID(), job: randomUUID(), schedule: randomUUID() } };
});

function batch({ m, M, user, traces }) {
  const exec = (trace, source, preview, stage = 'action', ts = now) => ({ timestamp: ts, deploy: 'e2e', server: `matrix-${m}`, _group: m, trace_id: trace, execution_source: source, execution_id: trace, execution_preview: preview, execution_stage: stage, user });
  const r = (t, extra, v = 1) => ({ v, t, ...extra });
  const req = () => exec(traces.request, 'request', `GET /matrix-${m}`);
  return {
    records: [
      r('request', { ...exec(traces.request, 'request', `GET /matrix-${m}`, 'end'), method: 'GET', url: `https://app.test/matrix-${m}?token=secret`, route_name: `matrix.${m}`, route_path: `/matrix-${m}`, status_code: 200, duration: 30000, peak_memory_usage: 4194304 }),
      r('query', { ...req(), sql: `select * from matrix_${m} where id = ?`, file: 'app/Matrix.php', line: 1, duration: 1200, connection: 'sqlite' }),
      r('exception', { ...req(), class: `App\\Exceptions\\${M}Exception`, file: 'app/Matrix.php', line: 2, message: `matrix ${m} for jane@example.com`, code: 0, trace: '[]', handled: true }, 3),
      r('cache-event', { ...req(), store: 'array', key: `matrix:${m}`, type: 'hit', duration: 50 }),
      r('outgoing-request', { ...req(), host: `${m}.matrix.test`, method: 'POST', url: `https://${m}.matrix.test/hook?api_key=secret`, duration: 9000, status_code: 201 }),
      r('mail', { ...req(), mailer: 'array', class: `App\\Mail\\${M}`, subject: `Hello ${m}`, to: 1, duration: 800, failed: false }),
      r('notification', { ...req(), channel: 'database', class: `App\\Notifications\\${M}`, duration: 300, failed: false }),
      r('log', { ...req(), level: 'info', message: `matrix ${m}`, context: JSON.stringify({ m, email: 'jane@example.com' }) }),
      r('queued-job', { ...req(), job_id: randomUUID(), name: `App\\Jobs\\${M}`, connection: 'database', queue: `q-${m}`, duration: 400 }),
      r('command', { ...exec(traces.command, 'command', `php artisan matrix:${m}`, 'end'), name: `matrix:${m}`, command: `matrix:${m} --force`, exit_code: 0, duration: 20000 }),
      r('job-attempt', { ...exec(traces.job, 'job', `App\\Jobs\\${M}`, 'end'), job_id: randomUUID(), attempt_id: randomUUID(), attempt: 1, name: `App\\Jobs\\${M}`, connection: 'database', queue: `q-${m}`, status: 'processed', duration: 15000 }),
      r('scheduled-task', { ...exec(traces.schedule, 'schedule', `matrix-${m}`, 'end'), name: `matrix-${m}`, cron: '*/5 * * * *', timezone: 'UTC', repeat_seconds: 0, status: 'processed', duration: 5000 }),
      r('user', { timestamp: now, id: user, name: `Matrix ${M}`, username: m }),
    ],
  };
}

const get = async (path) => {
  const res = await fetch(`${api}${path}`, { headers: { authorization: `Bearer ${readKey}` } });
  return res.ok ? res.json() : { status: res.status, data: [] };
};
const enc = encodeURIComponent;

// One check per record type: [type, path under /v1/projects/:id, predicate over (json, plan entry)]. R2 checks read the raw trace back.
const CHECKS = [
  ['request', (p) => `/traces/${p.traces.request}`, (d, p) => d.records?.some((r) => r.t === 'request') && d.trace?.route === `matrix.${p.m}` && d.trace?.name === `GET /matrix-${p.m}` && d.trace?.peak_memory_usage === 4194304 && d.trace?.status_code === 200],
  ['query', () => '/queries?range=1h', (d, p) => d.data.some((q) => q.sql.includes(`matrix_${p.m}`))],
  ['exception', () => '/exceptions?range=1h', (d, p) => d.data.some((e) => e.class === `App\\Exceptions\\${p.M}Exception` && !e.message.includes('jane@'))],
  ['command', (p) => `/commands/${enc(`matrix:${p.m}`)}`, (d) => d.data[0]?.exit_code === 0],
  ['job-attempt', (p) => `/jobs?range=1h&q=${p.m}`, (d, p) => d.data.some((j) => j.key === `App\\Jobs\\${p.M}` && j.attempts === 1 && j.processed === 1)],
  ['queued-job', (p) => `/jobs?range=1h&q=${p.m}`, (d, p) => d.data.some((j) => j.key === `App\\Jobs\\${p.M}` && j.queued === 1)],
  ['scheduled-task', (p) => `/scheduled-tasks/${enc(`matrix-${p.m}`)}`, (d) => d.data[0]?.cron === '*/5 * * * *' && d.data[0]?.status === 'processed'],
  ['cache-event', (p) => `/cache/${enc(`matrix:${p.m}`)}`, (d) => d.data[0]?.type === 'hit'],
  ['outgoing-request', (p) => `/outgoing-requests/${enc(`${p.m}.matrix.test`)}`, (d) => d.data[0]?.status_code === 201 && !String(d.data[0]?.url).includes('secret')],
  ['mail', (p) => `/mail/${enc(`App\\Mail\\${p.M}`)}`, (d, p) => d.data[0]?.subject === `Hello ${p.m}` && d.data[0]?.to_count === 1],
  ['notification', (p) => `/notifications/${enc(`App\\Notifications\\${p.M}`)}`, (d) => d.data[0]?.channel === 'database'],
  ['log', (p) => `/logs/info?q=${p.m}`, (d, p) => d.data.some((l) => l.message === `matrix ${p.m}` && !l.context.includes('jane@'))],
  ['user', (p) => `/users/${enc(p.user)}`, (d, p) => d.data.length >= 4 && d.data.every((t) => t.user === p.user)],
];
// R2: the raw request trace keeps every record of that trace verbatim.
const R2_TYPES = ['request', 'query', 'exception', 'cache-event', 'outgoing-request', 'mail', 'notification', 'log', 'queued-job'];

for (const p of plan) {
  const res = await fetch(`${ingest}/api/ingest`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ingestKey}`, 'x-edgewatch-project': p.project, 'content-type': 'application/json', 'content-encoding': 'gzip', 'user-agent': 'NightwatchAgent/1.30.6' },
    body: gzipSync(JSON.stringify(batch(p))),
  });
  const body = await res.json().catch(() => ({}));
  console.log(`${res.status === 200 && body.accepted === TYPES.length ? 'PASS' : 'FAIL'} ${p.project} ingest accepted ${body.accepted ?? res.status}/${TYPES.length} record types`);
}

async function run() {
  const results = [];
  for (const p of plan) {
    const base = `/v1/projects/${p.project}`;
    for (const [type, path, ok] of CHECKS) {
      const d = await get(`${base}${path(p)}`.replace(/^\/v1/, ''));
      results.push({ project: p.project, type, layer: 'D1/API', ok: Boolean(ok(d, p)) });
    }
    const raw = await get(`${base}/traces/${p.traces.request}`.replace(/^\/v1/, ''));
    const seen = new Set((raw.records ?? []).map((r) => r.t));
    for (const type of R2_TYPES) results.push({ project: p.project, type, layer: 'R2', ok: seen.has(type) });
    for (const [kind, id] of Object.entries(p.traces).filter(([k]) => k !== 'request')) {
      const t = await get(`${base}/traces/${id}`.replace(/^\/v1/, ''));
      results.push({ project: p.project, type: { command: 'command', job: 'job-attempt', schedule: 'scheduled-task' }[kind], layer: 'R2', ok: Boolean(t.records?.length) });
    }
    // Project filter: none of the other projects' markers appear under this project.
    const others = plan.filter((o) => o !== p).map((o) => o.m);
    const lists = await Promise.all(['/traces?limit=200', '/queries?range=1h', '/exceptions?range=1h', '/jobs?range=1h', '/commands?range=1h', '/scheduled-tasks?range=1h', '/cache?range=1h', '/outgoing-requests?range=1h', '/mail?range=1h', '/notifications?range=1h', '/logs/info', '/users?range=1h'].map((x) => get(`${base}${x}`.replace(/^\/v1/, ''))));
    const leaked = others.filter((m) => JSON.stringify(lists).includes(m));
    results.push({ project: p.project, type: 'project filter', layer: 'API', ok: leaked.length === 0 });
  }
  return results;
}

let results = [];
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  results = await run();
  if (results.every((r) => r.ok)) break;
}
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.project} ${r.type} (${r.layer})`);
console.log('\nRound trip per record type (ingest -> queue -> consumer -> D1 + R2 -> API), all projects:');
for (const type of TYPES) {
  const rs = results.filter((r) => r.type === type);
  console.log(`  ${type.padEnd(17)} ${rs.every((r) => r.ok) ? 'round-trips' : 'DOES NOT round-trip'} (${rs.map((r) => r.layer).filter((v, i, a) => a.indexOf(v) === i).join(' + ')}, ${projects.length} projects)`);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
