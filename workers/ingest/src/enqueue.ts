import type { IngestMessage, NightwatchRecord } from '@edgewatch/shared';
import type { Env } from './index';

/** Queue messages are capped at 128 KB; anything bigger is parked in R2 and referenced by key. */
const MAX_INLINE_MESSAGE_BYTES = 100_000;
const MAX_BATCH_MESSAGES = 100;
const MAX_BATCH_BYTES = 200_000;
/** A big trace is parked as several objects of at most this size, so the consumer never loads one huge payload. */
export const MAX_PARKED_PART_BYTES = 1_000_000;

/**
 * Groups records by trace into queue messages. A group over the inline cap is parked in the blob store, split into
 * parts of at most MAX_PARKED_PART_BYTES (each its own message for the same trace; the consumer merges them).
 */
export async function enqueue(env: Pick<Env, 'TRACES' | 'INGEST_QUEUE'>, projectId: string, server: string, records: NightwatchRecord[]): Promise<number> {
  const byTrace = new Map<string | null, NightwatchRecord[]>();
  for (const record of records) {
    const traceId = typeof record.trace_id === 'string' ? record.trace_id : null;
    const group = byTrace.get(traceId);
    if (group) group.push(record);
    else byTrace.set(traceId, [record]);
  }

  const receivedAt = Date.now();
  const messages: { body: IngestMessage; size: number }[] = [];
  const park = async (traceId: string | null, json: string) => {
    const r2Key = `incoming/${projectId}/${receivedAt}-${crypto.randomUUID()}.json`;
    await env.TRACES.put(r2Key, json, { httpMetadata: { contentType: 'application/json' } });
    const body: IngestMessage = { message_id: crypto.randomUUID(), project_id: projectId, server, received_at: receivedAt, trace_id: traceId, r2_key: r2Key };
    messages.push({ body, size: JSON.stringify(body).length });
  };
  for (const [traceId, group] of byTrace) {
    const body: IngestMessage = { message_id: crypto.randomUUID(), project_id: projectId, server, received_at: receivedAt, trace_id: traceId, records: group };
    const size = JSON.stringify(body).length;
    if (size <= MAX_INLINE_MESSAGE_BYTES) {
      messages.push({ body, size });
      continue;
    }
    let part: string[] = [];
    let partBytes = 2;
    for (const record of group) {
      const json = JSON.stringify(record);
      if (part.length && partBytes + json.length + 1 > MAX_PARKED_PART_BYTES) {
        await park(traceId, `[${part.join(',')}]`);
        part = [];
        partBytes = 2;
      }
      part.push(json);
      partBytes += json.length + 1;
    }
    if (part.length) await park(traceId, `[${part.join(',')}]`);
  }

  let batch: { body: IngestMessage }[] = [];
  let batchBytes = 0;
  for (const message of messages) {
    if (batch.length === MAX_BATCH_MESSAGES || batchBytes + message.size > MAX_BATCH_BYTES) {
      await env.INGEST_QUEUE.sendBatch(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push({ body: message.body });
    batchBytes += message.size;
  }
  if (batch.length > 0) await env.INGEST_QUEUE.sendBatch(batch);

  return messages.length;
}
