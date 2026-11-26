import {
  apiKeyKvKey,
  usableKey,
  errorBody,
  errorFields,
  healthChecks,
  BrowserBody,
  BrowserEvent,
  browserEventToRecord,
  IngestBody,
  signIngestToken,
  validateRecords,
  verifyIngestToken,
  type ApiKeyRecord,
  type IngestMessage,
  type NightwatchRecord,
  log,
  type Scope,
  type BlobStore,
  type IngestQueue,
  type KeyStore,
} from '@edgewatch/shared';
import { backendHealth, healthResponse, openBackends, type BackendEnv } from '@edgewatch/shared/backends';
import { fail, notFound, observe, onError, storage, type ObservedVariables } from '@edgewatch/shared/hono';
import { Hono, type Context } from 'hono';
import { enqueue } from './enqueue';

/** Storage backends: see BackendEnv. Ingest only needs an event store (DB or HYPERDRIVE) when KEY_STORE=sql. */
export interface Env extends BackendEnv {
  API_KEYS: KeyStore;
  INGEST_QUEUE: IngestQueue<IngestMessage>;
  TRACES: BlobStore;
  TOKEN_SIGNING_SECRET: string;
  TOKEN_TTL?: string;
  MAX_BODY_BYTES?: string;
  INGEST_URL?: string;
  /** Optional Workers Rate Limiting binding, keyed by project id. */
  RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  RATE_LIMIT_PERIOD?: string;
}

/** Stored in KV under project:<id> by billing/ops to cut a project off until a given time. */
export interface ProjectQuota {
  over_quota_until?: number;
  message?: string;
}

const app = new Hono<{ Bindings: Env; Variables: ObservedVariables }>();
app.use('*', observe('ingest'));
app.onError(onError('ingest'));
app.notFound(notFound);
// Before the backend middleware, so a half-configured backend is reported here instead of failing the request.
app.get('/healthz', async (c) =>
  healthResponse(
    await backendHealth('ingest', c.env, (env, kind) => ({
      keys: healthChecks.keys(env.API_KEYS, kind.keys),
      blobs: healthChecks.blobs(env.TRACES, kind.blobs),
      queue: healthChecks.configured(env.INGEST_QUEUE, 'queue'),
      signing_secret: healthChecks.configured(env.TOKEN_SIGNING_SECRET),
      rate_limiter: healthChecks.configured(env.RATE_LIMITER, undefined, false),
      ...(kind.keys === 'sql' ? { events: healthChecks.sql(env.DB, kind.events) } : {}),
    }), { onError: (check, e) => log('ingest', 'warn', 'health_check_failed', { check, ...errorFields(e) }) }),
  ),
);
app.use('*', async (c, next) => {
  const backends = openBackends(c.env);
  c.env = backends.env;
  if (!backends.connected) return next();
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(backends.close());
  }
});

const unauthenticated = (c: Context) => fail(c, 401, 'unauthenticated', 'Unauthenticated.');

function bearer(c: Context): string | null {
  return c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
}

/**
 * Project tag. EdgeWatch is single-tenant: any valid ingest key may write to any project. Clients tag data with
 * X-EdgeWatch-Project or ?project=; untagged data goes to the key's
 * default project, which is what the official Nightwatch agent relies on.
 */
const PROJECT_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function projectTag(c: Context): string | null | false {
  const tag = c.req.header('x-edgewatch-project') ?? c.req.query('project');
  if (!tag) return null;
  return PROJECT_TAG.test(tag) ? tag : false;
}
const badTag = (c: Context) => fail(c, 422, 'unprocessable', 'Invalid project tag: use 1-64 letters, digits, ".", "_" or "-".');

async function lookupKey(env: Env, raw: string, scope: Scope): Promise<ApiKeyRecord | null> {
  // Edge-cached for 60s: avoids a KV round trip per batch. Disabling a key therefore takes up to a minute to apply.
  const kvKey = await apiKeyKvKey(raw);
  const record = await storage('kv', () => env.API_KEYS.get<ApiKeyRecord>(kvKey, { type: 'json', cacheTtl: 60 }));
  return usableKey(record, scope) ? record : null;
}

app.get('/health', (c) => c.json({ ok: true }));

/**
 * Nightwatch "stop" instruction: the agent pauses (and drops buffered data) until refresh_in seconds pass,
 * on both agent-auth and ingest responses.
 */
function stop(c: Context, code: 'over_quota' | 'rate_limited', message: string, refreshIn: number) {
  const seconds = Math.max(1, Math.ceil(refreshIn));
  c.header('Retry-After', String(seconds));
  c.header('X-EdgeWatch-Stop', '1');
  c.set('logFields', { stop: code, refresh_in: seconds });
  return c.json({ ...errorBody(code, message, c.get('requestId')), stop: true, refresh_in: seconds }, 429);
}

async function quotaStop(c: Context<{ Bindings: Env; Variables: ObservedVariables }>, projectId: string, rateLimit: boolean) {
  // Quota and rate-limit checks fail open: an outage of either must not drop data the key is allowed to send.
  const quota = await c.env.API_KEYS.get<ProjectQuota>(`project:${projectId}`, { type: 'json', cacheTtl: 60 }).catch((e: unknown) => {
    log('ingest', 'warn', 'quota_check_failed', { request_id: c.get('requestId'), project_id: projectId, ...errorFields(e) });
    return null;
  });
  const now = Date.now() / 1000;
  if (quota?.over_quota_until && quota.over_quota_until > now) {
    return stop(c, 'over_quota', quota.message ?? 'Project is over its quota.', quota.over_quota_until - now);
  }
  if (rateLimit && c.env.RATE_LIMITER) {
    const allowed = await c.env.RATE_LIMITER.limit({ key: projectId }).then(
      (r) => r.success,
      (e: unknown) => {
        log('ingest', 'warn', 'rate_limit_check_failed', { request_id: c.get('requestId'), project_id: projectId, ...errorFields(e) });
        return true;
      },
    );
    if (!allowed) return stop(c, 'rate_limited', 'Rate limit exceeded.', Number(c.env.RATE_LIMIT_PERIOD ?? 60));
  }
  return null;
}

/**
 * Nightwatch agent authentication. The agent sends `Authorization: Bearer <NIGHTWATCH_TOKEN>` with body `{}` and
 * requires all four keys back (expires_in / refresh_in as integers).
 */
app.post('/api/agent-auth', async (c) => {
  const token = bearer(c);
  const key = token ? await lookupKey(c.env, token, 'ingest') : null;
  if (!key) return unauthenticated(c);
  const tag = projectTag(c);
  if (tag === false) return badTag(c);
  const projectId = tag ?? key.project_id;
  c.set('projectId', projectId);
  const stopped = await quotaStop(c, projectId, false);
  if (stopped) return stopped;

  // A token never outlives the key that issued it.
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(1, Math.min(Number(c.env.TOKEN_TTL ?? 3600), (key.expires_at ?? Infinity) - now));
  return c.json({
    token: await signIngestToken({ p: projectId, exp: now + ttl }, c.env.TOKEN_SIGNING_SECRET),
    expires_in: ttl,
    refresh_in: Math.min(ttl, Math.max(60, ttl - 600)),
    ingest_url: c.env.INGEST_URL ?? new URL('/api/ingest', c.req.url).toString(),
  });
});

/**
 * Batch ingest. Accepts the agent's short-lived token, or a raw ingest API key (direct HTTP senders such as the
 * e2e harness). Body: `{"records": [...]}`, gzip or plain JSON.
 */
app.post('/api/ingest', async (c) => {
  const token = bearer(c);
  if (!token) return unauthenticated(c);
  const defaultProject = (await verifyIngestToken(token, c.env.TOKEN_SIGNING_SECRET))?.p ?? (await lookupKey(c.env, token, 'ingest'))?.project_id;
  if (!defaultProject) return unauthenticated(c);
  const tag = projectTag(c);
  if (tag === false) return badTag(c);
  const projectId = tag ?? defaultProject;
  c.set('projectId', projectId);
  const stopped = await quotaStop(c, projectId, true);
  if (stopped) return stopped;

  const maxBytes = maxBodyBytes(c.env.MAX_BODY_BYTES);
  let text: string;
  try {
    text = await readBody(c.req.raw, maxBytes);
  } catch (e) {
    return e instanceof PayloadTooLarge ? fail(c, 413, 'payload_too_large', 'Payload too large.') : fail(c, 400, 'invalid_request', 'Unable to decode request body.');
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail(c, 422, 'unprocessable', 'Malformed JSON.');
  }

  const body = IngestBody.safeParse(json);
  if (!body.success) return fail(c, 422, 'unprocessable', 'The records field is required and must be an array.');

  const { records, rejected } = validateRecords(body.data.records);
  if (rejected.length > 0) {
    log('ingest', 'warn', 'records_rejected', { request_id: c.get('requestId'), project_id: projectId, count: rejected.length, sample: rejected.slice(0, 3) });
  }

  try {
    const messages = await enqueue(c.env, projectId, c.req.header('nightwatch-server') ?? '', records);
    c.set('logFields', { accepted: records.length, rejected: rejected.length, messages });
  } catch (e) {
    log('ingest', 'error', 'enqueue_failed', { request_id: c.get('requestId'), project_id: projectId, ...errorFields(e) });
    c.header('Retry-After', '5');
    return fail(c, 503, 'unavailable', 'Temporarily unable to accept data.');
  }

  return c.json({ ok: true, accepted: records.length, rejected: rejected.length, errors: rejected.slice(0, 10) });
});

class PayloadTooLarge extends Error {}

/** Default ingest body ceiling (decoded bytes): 20 MB, well under the Workers request limit and the agent's batch size. */
const DEFAULT_MAX_BODY_BYTES = 20_000_000;

/** MAX_BODY_BYTES as a positive integer; a missing, empty or malformed value falls back to the default instead of disabling the limit. */
function maxBodyBytes(raw: string | undefined): number {
  const n = Number(raw);
  return raw?.trim() && Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_MAX_BODY_BYTES;
}

/**
 * Streams the body (gunzipping on the fly when Content-Encoding says gzip or the gzip magic bytes are present) and stops
 * as soon as the decoded size passes maxBytes, so a small gzip bomb can never be inflated into memory.
 */
async function readBody(request: Request, maxBytes: number): Promise<string> {
  // Content-Length (when sent) rejects before any byte is read; otherwise the streamed count below enforces the limit.
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) throw new PayloadTooLarge();
  if (!request.body) return '';

  const source = request.body.getReader();
  const first = await source.read();
  const head = first.value ?? new Uint8Array();
  const gzipped = request.headers.get('content-encoding')?.toLowerCase() === 'gzip' || (head[0] === 0x1f && head[1] === 0x8b);
  let stream: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.byteLength) controller.enqueue(head);
      if (first.done) controller.close();
    },
    async pull(controller) {
      const { done, value } = await source.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => source.cancel(reason),
  });
  if (gzipped) {
    // Pump by hand so a truncated or corrupt gzip body surfaces as a read error below (-> 400); pipeThrough leaves the
    // rejected close() of the decompressor unhandled.
    const gunzip = new DecompressionStream('gzip');
    const writer = gunzip.writable.getWriter();
    writer.closed.catch(() => {});
    const input = stream.getReader();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await input.read();
          if (done) break;
          await writer.write(value);
        }
        await writer.close();
      } catch (e) {
        await writer.abort(e).catch(() => {});
      }
    })();
    stream = gunzip.readable;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new PayloadTooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Browser error telemetry (EdgeWatch extension; the Nightwatch wire format has no browser record type).
 * Auth is a public `browser`-scope key in ?key= (navigator.sendBeacon cannot set headers) or a Bearer header,
 * optionally restricted to allowed_origins. Events become Nightwatch-shaped exception records on the normal queue.
 */
function browserCors(c: Context, origin: string | undefined) {
  if (!origin) return;
  c.header('Access-Control-Allow-Origin', origin);
  c.header('Vary', 'Origin');
  c.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'content-type, authorization');
  c.header('Access-Control-Max-Age', '86400');
}

app.options('/api/browser', (c) => {
  browserCors(c, c.req.header('origin'));
  return c.body(null, 204);
});

app.post('/api/browser', async (c) => {
  const origin = c.req.header('origin');
  const raw = c.req.query('key') ?? bearer(c);
  const key = raw ? await lookupKey(c.env, raw, 'browser') : null;
  if (!key) return unauthenticated(c);
  const tag = projectTag(c);
  if (tag === false) return badTag(c);
  const projectId = tag ?? key.project_id;
  c.set('projectId', projectId);
  if (key.allowed_origins?.length && (!origin || !key.allowed_origins.includes(origin))) {
    return fail(c, 403, 'forbidden', 'Origin not allowed for this key.');
  }
  browserCors(c, origin);

  const stopped = await quotaStop(c, projectId, true);
  if (stopped) return stopped;

  let text: string;
  try {
    text = await readBody(c.req.raw, 256_000);
  } catch (e) {
    return e instanceof PayloadTooLarge ? fail(c, 413, 'payload_too_large', 'Payload too large.') : fail(c, 400, 'invalid_request', 'Unable to decode request body.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail(c, 422, 'unprocessable', 'Body must be JSON.');
  }
  const body = BrowserBody.safeParse(parsed);
  if (!body.success) return fail(c, 422, 'unprocessable', 'Body must be {"events": [...]} with 1-50 events.');

  const records: NightwatchRecord[] = [];
  let rejected = 0;
  for (const event of body.data.events) {
    const ok = BrowserEvent.safeParse(event);
    if (ok.success) records.push(await browserEventToRecord(ok.data));
    else rejected++;
  }
  if (records.length) {
    try {
      await enqueue(c.env, projectId, 'browser', records);
    } catch (e) {
      log('ingest', 'error', 'enqueue_failed', { request_id: c.get('requestId'), project_id: projectId, ...errorFields(e) });
      c.header('Retry-After', '5');
      return fail(c, 503, 'unavailable', 'Temporarily unable to accept data.');
    }
  }
  c.set('logFields', { accepted: records.length, rejected });
  return c.json({ ok: true, accepted: records.length, rejected });
});


export default app;
