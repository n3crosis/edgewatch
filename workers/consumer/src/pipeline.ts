import { errorFields, log, type IngestMessage, type NightwatchRecord } from '@edgewatch/shared';
import type { Env } from './process';
import { USAGE_KEEP_DAYS, utcDay } from './usage';

/** A dead message being stored or replayed. `id` is the queue message id. */
export interface DeadMessage {
  id: string;
  body: IngestMessage;
}

/**
 * Delay before redelivering a failed message: 5 s doubling to a 10-minute cap. With the queue's 20 retries a message
 * keeps retrying for about 2.3 hours, so a D1 overload or outage drains back in instead of filling the DLQ.
 */
export const retryDelaySeconds = (attempts: number) => Math.min(600, 5 * 2 ** Math.max(0, attempts - 1));

/** Cron that runs retention; the other (every 5 minutes) replays requested dead letters and checks queue lag. */
export const RETENTION_CRON = '17 * * * *';

export const REPLAY_BATCH = 50;
/** A requested replay that keeps failing is given up (flag cleared) after this many tries; it can be requested again. */
export const MAX_REPLAY_ATTEMPTS = 5;
/** Default alert thresholds: queue lag above 10 minutes; at most one webhook per event per hour. */
const ALERT_LAG_MS = 600_000;
const ALERT_INTERVAL_MS = 3_600_000;
/** pipeline_minutes rows are kept for 7 days. */
const STATS_KEEP_MS = 7 * 86_400_000;

const deadKey = (m: DeadMessage) => `dead/${m.body.project_id}/${m.id}.json`;

/**
 * DLQ handler: stores each message that exhausted its retries in R2 (records inlined, since parked `incoming/` payloads
 * expire after a day) and D1 `dead_letters`, then sends the alert webhook. Returns the ids to retry (storage failed).
 */
export async function storeDeadLetters(messages: DeadMessage[], env: Env, now = Date.now()): Promise<Set<string>> {
  const failed = new Set<string>();
  const stored: DeadMessage[] = [];
  await Promise.all(
    messages.map(async (m) => {
      try {
        let records = m.body.records;
        if (!records && m.body.r2_key) records = (await (await env.TRACES.get(m.body.r2_key))?.json<NightwatchRecord[]>()) ?? undefined;
        const body: IngestMessage = records ? { ...m.body, records, r2_key: undefined } : m.body;
        await env.TRACES.put(deadKey(m), JSON.stringify(body), { httpMetadata: { contentType: 'application/json' } });
        stored.push({ id: m.id, body });
      } catch (e) {
        failed.add(m.id);
        log('consumer', 'error', 'dead_letter_store_failed', { project_id: m.body.project_id, ...errorFields(e) });
      }
    }),
  );
  if (stored.length) {
    try {
      await env.DB.batch(
        stored.map((m) =>
          env.DB.prepare('INSERT OR IGNORE INTO dead_letters (id, project_id, trace_id, received_at, failed_at, record_count, r2_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .bind(m.id, m.body.project_id, m.body.trace_id, m.body.received_at, now, m.body.records?.length ?? 0, deadKey(m)),
        ),
      );
    } catch (e) {
      for (const m of stored) failed.add(m.id);
      log('consumer', 'error', 'dead_letter_store_failed', errorFields(e));
      return failed;
    }
    const projects = [...new Set(stored.map((m) => m.body.project_id))];
    log('consumer', 'error', 'dead_letters', { messages: stored.length, projects });
    await alert(env, 'dead_letters', `${stored.length} EdgeWatch message(s) failed every retry and were moved to dead letters (projects: ${projects.join(', ')}).`, { messages: stored.length, projects }, now, 0);
  }
  return failed;
}

/**
 * Enqueues requested dead letters (POST /v1/dead-letters/replay) for the serialized consumer.
 * Successfully enqueued dead letters are removed; enqueue failures count an attempt and keep the error.
 * A crash between enqueue and cleanup may enqueue twice; trace processing must remain idempotent.
 */
export async function replayDeadLetters(env: Env, now = Date.now()): Promise<{ replayed: number; failed: number }> {
  const { results } = await env.DB.prepare('SELECT id, r2_key, replay_attempts FROM dead_letters WHERE replay_requested_at IS NOT NULL ORDER BY replay_requested_at LIMIT ?')
    .bind(REPLAY_BATCH).all<{ id: string; r2_key: string; replay_attempts: number }>();
  if (!results.length) return { replayed: 0, failed: 0 };
  const loaded = await Promise.all(results.map(async (row) => ({ row, body: await env.TRACES.get(row.r2_key).then((o) => o?.json<IngestMessage>() ?? null, () => null) })));
  const present = loaded.filter((x): x is { row: (typeof results)[number]; body: IngestMessage } => x.body !== null);
  // Replay must enter the same serialized consumer as live ingestion. A cron must never merge traces directly.
  const failed = new Set<number>();
  for (const [i, { body }] of present.entries()) {
    try {
      if (!env.INGEST_QUEUE) throw new Error('INGEST_QUEUE binding is missing');
      const records = body.records ?? (body.r2_key ? await (await env.TRACES.get(body.r2_key))?.json<NightwatchRecord[]>() : undefined);
      if (!records) throw new Error('Stored payload is missing');
      // Park a separate copy: the dead-letter object is removed only after enqueue succeeds.
      // Always use a pointer so large dead letters stay within the queue's message-size limit.
      const key = `incoming/${body.project_id}/replay-${crypto.randomUUID()}.json`;
      await env.TRACES.put(key, JSON.stringify(records), { httpMetadata: { contentType: 'application/json' } });
      await env.INGEST_QUEUE.sendBatch([{ body: { ...body, records: undefined, r2_key: key } }]);
    } catch (e) {
      failed.add(i);
      log('consumer', 'error', 'replay_enqueue_failed', { project_id: body.project_id, ...errorFields(e) });
    }
  }

  const done = present.filter((_, i) => !failed.has(i)).map((x) => x.row);
  const bad = [...loaded.filter((x) => x.body === null).map((x) => ({ row: x.row, error: 'Stored payload is missing.' })), ...present.filter((_, i) => failed.has(i)).map((x) => ({ row: x.row, error: 'Could not enqueue replay; see consumer logs.' }))];
  await env.DB.batch([
    ...done.map((r) => env.DB.prepare('DELETE FROM dead_letters WHERE id = ?').bind(r.id)),
    ...bad.map(({ row, error }) =>
      env.DB.prepare('UPDATE dead_letters SET replay_attempts = replay_attempts + 1, last_error = ?, replay_requested_at = CASE WHEN replay_attempts + 1 >= ? THEN NULL ELSE replay_requested_at END WHERE id = ?')
        .bind(error, MAX_REPLAY_ATTEMPTS, row.id),
    ),
  ]);
  if (done.length) await env.TRACES.delete(done.map((r) => r.r2_key));
  log('consumer', bad.length ? 'warn' : 'info', 'dead_letters_replayed', { replayed: done.length, failed: bad.length, at: now });
  return { replayed: done.length, failed: bad.length };
}

/** Adds one consumer batch to the per-minute stats (one upsert; D1 serialises concurrent consumers). */
export function recordBatch(env: Env, stats: { messages: number; retried: number; lagMs: number }, now = Date.now()) {
  const minute = now - (now % 60_000);
  return env.DB.prepare(
    `INSERT INTO pipeline_minutes (minute, batches, messages, retried, max_lag_ms) VALUES (?, 1, ?, ?, ?)
     ON CONFLICT (minute) DO UPDATE SET batches = pipeline_minutes.batches + 1, messages = pipeline_minutes.messages + excluded.messages,
       retried = pipeline_minutes.retried + excluded.retried, max_lag_ms = max(pipeline_minutes.max_lag_ms, excluded.max_lag_ms)`,
  ).bind(minute, stats.messages, stats.retried, Math.max(0, Math.round(stats.lagMs))).run();
}

/** Periodic check (cron): alerts on queue lag over ALERT_LAG_SECONDS in the last 5 minutes and prunes old stats. */
export async function checkPipeline(env: Env, now = Date.now()): Promise<{ max_lag_ms: number; alerted: boolean }> {
  const lagLimit = Number(env.ALERT_LAG_SECONDS ?? ALERT_LAG_MS / 1000) * 1000;
  const lag = (await env.DB.prepare('SELECT max(max_lag_ms) AS lag FROM pipeline_minutes WHERE minute >= ?').bind(now - 5 * 60_000).first<number | null>('lag')) ?? 0;
  await env.DB.prepare('DELETE FROM pipeline_minutes WHERE minute < ?').bind(now - STATS_KEEP_MS).run();
  await env.DB.prepare('DELETE FROM usage_daily WHERE day < ?').bind(utcDay(now - USAGE_KEEP_DAYS * 86_400_000)).run();
  await env.DB.prepare('DELETE FROM usage_receipts WHERE day < ?').bind(utcDay(now - USAGE_KEEP_DAYS * 86_400_000)).run();
  const alerted = lag > lagLimit && (await alert(env, 'queue_lag', `EdgeWatch queue lag is ${Math.round(lag / 1000)} s (limit ${lagLimit / 1000} s): the consumer is behind.`, { max_lag_ms: lag }, now));
  return { max_lag_ms: lag, alerted };
}

/**
 * Sends `{ text, event, ... }` to ALERT_WEBHOOK_URL (a Slack-compatible `text` field), at most once per
 * `interval` per event. Never throws: an alert failure must not fail the batch or the cron run.
 */
export async function alert(env: Env, event: string, text: string, details: Record<string, unknown>, now = Date.now(), interval = ALERT_INTERVAL_MS): Promise<boolean> {
  if (!env.ALERT_WEBHOOK_URL) return false;
  try {
    if (interval > 0) {
      const last = await env.DB.prepare('SELECT sent_at FROM alerts_sent WHERE event = ?').bind(event).first<number | null>('sent_at');
      if (last !== null && now - last < interval) return false;
    }
    const res = await fetch(env.ALERT_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, source: 'edgewatch', event, ...details }) });
    if (!res.ok) throw new Error(`Alert webhook answered HTTP ${res.status}`);
    await env.DB.prepare('INSERT INTO alerts_sent (event, sent_at) VALUES (?, ?) ON CONFLICT (event) DO UPDATE SET sent_at = excluded.sent_at').bind(event, now).run();
    return true;
  } catch (e) {
    log('consumer', 'error', 'alert_failed', { event, ...errorFields(e) });
    return false;
  }
}
