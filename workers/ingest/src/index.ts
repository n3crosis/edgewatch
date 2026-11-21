import {
  apiKeyKvKey,
  IngestBody,
  signIngestToken,
  validateRecords,
  verifyIngestToken,
  type ApiKeyRecord,
  type IngestMessage,
  type NightwatchRecord,
  type Scope,
} from '@edgewatch/shared';
import { Hono, type Context } from 'hono';

export interface Env {
  API_KEYS: KVNamespace;
  INGEST_QUEUE: Queue<IngestMessage>;
  TRACES: R2Bucket;
  TOKEN_SIGNING_SECRET: string;
  TOKEN_TTL?: string;
  MAX_BODY_BYTES?: string;
  INGEST_URL?: string;
}

/** Queue messages are capped at 128 KB; anything bigger is parked in R2 and referenced by key. */
const MAX_INLINE_MESSAGE_BYTES = 100_000;
const MAX_BATCH_MESSAGES = 100;
const MAX_BATCH_BYTES = 200_000;

const app = new Hono<{ Bindings: Env }>();

const unauthenticated = (c: Context) => c.json({ message: 'Unauthenticated.' }, 401);

function bearer(c: Context): string | null {
  return c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
}

async function lookupKey(env: Env, raw: string, scope: Scope): Promise<ApiKeyRecord | null> {
  const record = await env.API_KEYS.get<ApiKeyRecord>(await apiKeyKvKey(raw), 'json');
  return record && !record.disabled && record.scopes.includes(scope) ? record : null;
}

app.get('/health', (c) => c.json({ ok: true }));

/**
 * Nightwatch agent authentication. The agent sends `Authorization: Bearer <NIGHTWATCH_TOKEN>` with body `{}` and
 * requires all four keys back (expires_in / refresh_in as integers).
 */
app.post('/api/agent-auth', async (c) => {
  const token = bearer(c);
  const key = token ? await lookupKey(c.env, token, 'ingest') : null;
  if (!key) return unauthenticated(c);

  const ttl = Number(c.env.TOKEN_TTL ?? 3600);
  return c.json({
    token: await signIngestToken({ p: key.project_id, exp: Math.floor(Date.now() / 1000) + ttl }, c.env.TOKEN_SIGNING_SECRET),
    expires_in: ttl,
    refresh_in: Math.max(60, ttl - 600),
    ingest_url: c.env.INGEST_URL ?? new URL('/api/ingest', c.req.url).toString(),
  });
});

/**
 * Batch ingest. Accepts the agent's short-lived token, or a raw ingest API key (edgewatch/laravel-edgewatch's
 * agentless HTTP transport). Body: `{"records": [...]}`, gzip or plain JSON.
 */
app.post('/api/ingest', async (c) => {
  const token = bearer(c);
  if (!token) return unauthenticated(c);
  const projectId = (await verifyIngestToken(token, c.env.TOKEN_SIGNING_SECRET))?.p ?? (await lookupKey(c.env, token, 'ingest'))?.project_id;
  if (!projectId) return unauthenticated(c);

  const maxBytes = Number(c.env.MAX_BODY_BYTES ?? 20_000_000);
  let text: string;
  try {
    text = await readBody(c.req.raw, maxBytes);
  } catch (e) {
    return e instanceof PayloadTooLarge ? c.json({ message: 'Payload too large.' }, 413) : c.json({ message: 'Unable to decode request body.' }, 400);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return c.json({ message: 'Malformed JSON.' }, 422);
  }

  const body = IngestBody.safeParse(json);
  if (!body.success) return c.json({ message: 'The records field is required and must be an array.' }, 422);

  const { records, rejected } = validateRecords(body.data.records);
  if (rejected.length > 0) console.warn(`edgewatch: rejected ${rejected.length} record(s)`, JSON.stringify(rejected.slice(0, 5)));

  try {
    await enqueue(c.env, projectId, c.req.header('nightwatch-server') ?? '', records);
  } catch (e) {
    console.error('edgewatch: enqueue failed', e);
    return c.json({ message: 'Temporarily unable to accept data.' }, 503);
  }

  return c.json({ ok: true, accepted: records.length, rejected: rejected.length, errors: rejected.slice(0, 10) });
});

app.notFound((c) => c.json({ message: 'Not found.' }, 404));

class PayloadTooLarge extends Error {}

async function readBody(request: Request, maxBytes: number): Promise<string> {
  if (Number(request.headers.get('content-length') ?? 0) > maxBytes) throw new PayloadTooLarge();
  let bytes = new Uint8Array(await request.arrayBuffer());
  const gzipped = request.headers.get('content-encoding')?.toLowerCase() === 'gzip' || (bytes[0] === 0x1f && bytes[1] === 0x8b);
  if (gzipped) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (bytes.byteLength > maxBytes) throw new PayloadTooLarge();
  return new TextDecoder().decode(bytes);
}

async function enqueue(env: Env, projectId: string, server: string, records: NightwatchRecord[]): Promise<number> {
  const byTrace = new Map<string | null, NightwatchRecord[]>();
  for (const record of records) {
    const traceId = typeof record.trace_id === 'string' ? record.trace_id : null;
    byTrace.set(traceId, [...(byTrace.get(traceId) ?? []), record]);
  }

  const receivedAt = Date.now();
  const messages: { body: IngestMessage; size: number }[] = [];
  for (const [traceId, group] of byTrace) {
    let body: IngestMessage = { project_id: projectId, server, received_at: receivedAt, trace_id: traceId, records: group };
    let size = JSON.stringify(body).length;
    if (size > MAX_INLINE_MESSAGE_BYTES) {
      const r2Key = `incoming/${projectId}/${receivedAt}-${crypto.randomUUID()}.json`;
      await env.TRACES.put(r2Key, JSON.stringify(group), { httpMetadata: { contentType: 'application/json' } });
      body = { project_id: projectId, server, received_at: receivedAt, trace_id: traceId, r2_key: r2Key };
      size = JSON.stringify(body).length;
    }
    messages.push({ body, size });
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

export default app;
