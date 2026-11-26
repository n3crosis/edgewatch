import { errorFields, healthChecks, log, SqlKeyStore, type IngestMessage } from '@edgewatch/shared';
import { backendHealth, healthResponse, openBackends } from '@edgewatch/shared/backends';
// Only handlers may be exported from the Worker entry module (workerd rejects other named exports such as constants).
import { checkPipeline, recordBatch, replayDeadLetters, RETENTION_CRON, retryDelaySeconds, storeDeadLetters } from './pipeline';
import { applyRetention, processBodies, type Env } from './process';

export type { Env };

/** Runs `fn` with the configured storage backends (D1/R2/KV unless BackendEnv settings select others). */
async function withEventStore<T>(env: Env, fn: (env: Env) => Promise<T>): Promise<T> {
  const backends = openBackends(env);
  try {
    return await fn(backends.env);
  } finally {
    await backends.close().catch((e: unknown) => log('consumer', 'warn', 'postgres_close_failed', errorFields(e)));
  }
}

async function deadLetterBatch(batch: MessageBatch<IngestMessage>, env: Env): Promise<void> {
  const failed = await storeDeadLetters(batch.messages.map((m) => ({ id: m.id, body: m.body })), env);
  for (const m of batch.messages) {
    if (failed.has(m.id)) m.retry({ delaySeconds: retryDelaySeconds(m.attempts) });
    else m.ack();
  }
}

export default {
  /** GET /healthz only: the consumer has no other HTTP surface. */
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'GET' || new URL(request.url).pathname !== '/healthz') {
      return Response.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404 });
    }
    return healthResponse(
      await backendHealth('consumer', env, (env, kind) => ({
        events: healthChecks.sql(env.DB, kind.events),
        schema: healthChecks.schema(env.DB, kind.events),
        blobs: healthChecks.blobs(env.TRACES, kind.blobs),
        // Only used to write the over-quota block, so a failure degrades the consumer instead of taking it down.
        keys: healthChecks.keys(env.API_KEYS, kind.keys, false),
      }), { onError: (check, e) => log('consumer', 'warn', 'health_check_failed', { check, ...errorFields(e) }) }),
    );
  },

  queue(batch: MessageBatch<IngestMessage>, env: Env): Promise<void> {
    return withEventStore(env, (env) => handleQueue(batch, env));
  },

  scheduled(controller: ScheduledController, env: Env): Promise<void> {
    return withEventStore(env, (env) => handleScheduled(controller, env));
  },
} satisfies ExportedHandler<Env, IngestMessage>;

async function handleQueue(batch: MessageBatch<IngestMessage>, env: Env): Promise<void> {
    if (batch.queue === (env.DEAD_LETTER_QUEUE ?? 'edgewatch-ingest-dlq')) return deadLetterBatch(batch, env);
    const started = Date.now();
    let failed: Set<number>;
    let traces = 0;
    try {
      ({ failed, traces } = await processBodies(batch.messages.map((m) => m.body), env));
    } catch (e) {
      // Batch-level failure (e.g. D1 unavailable): retry everything with backoff.
      log('consumer', 'error', 'batch_failed', { queue: batch.queue, messages: batch.messages.length, ...errorFields(e) });
      failed = new Set(batch.messages.map((_, i) => i));
    }
    batch.messages.forEach((m, i) => (failed.has(i) ? m.retry({ delaySeconds: retryDelaySeconds(m.attempts) }) : m.ack()));
    const lagMs = started - Math.min(...batch.messages.map((m) => m.timestamp.getTime()));
    await recordBatch(env, { messages: batch.messages.length, retried: failed.size, lagMs }, started).catch((e: unknown) => log('consumer', 'warn', 'stats_failed', errorFields(e)));
    log('consumer', failed.size ? 'warn' : 'info', 'batch', {
      queue: batch.queue,
      messages: batch.messages.length,
      traces,
      retried: failed.size,
      lag_ms: lagMs,
      projects: [...new Set(batch.messages.map((m) => m.body.project_id))].slice(0, 20),
      duration_ms: Date.now() - started,
    });
}

async function handleScheduled(controller: ScheduledController, env: Env): Promise<void> {
    try {
      if (controller.cron === RETENTION_CRON) {
        const expiredKeys = env.API_KEYS instanceof SqlKeyStore ? { expired_keys: await env.API_KEYS.purgeExpired() } : {};
        log('consumer', 'info', 'retention', { cron: controller.cron, ...(await applyRetention(env, controller.scheduledTime)), ...expiredKeys });
      } else {
        log('consumer', 'info', 'pipeline', { cron: controller.cron, ...(await replayDeadLetters(env, controller.scheduledTime)), ...(await checkPipeline(env, controller.scheduledTime)) });
      }
    } catch (e) {
      log('consumer', 'error', 'scheduled_failed', { cron: controller.cron, ...errorFields(e) });
      throw e;
    }
}
