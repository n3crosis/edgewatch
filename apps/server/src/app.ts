import { existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { errorFields, healthChecks, HealthCheckError, log, runHealthChecks, SqlKeyStore, type BlobStore, type HealthReport, type IngestMessage, type KeyStore, type SqlDatabase } from '@edgewatch/shared';
import { healthResponse } from '@edgewatch/shared/backends';
import api from '../../../workers/api/src/index';
import consumer from '../../../workers/consumer/src/index';
import ingest from '../../../workers/ingest/src/index';
import { LocalQueue, type LocalQueueOptions } from './queue';

/** Worker vars the server passes through from its own environment. */
export const VAR_NAMES = [
  'TOKEN_SIGNING_SECRET', 'TOKEN_TTL', 'MAX_BODY_BYTES', 'INGEST_URL', 'RATE_LIMIT_PERIOD', 'CORS_ORIGIN', 'DASHBOARD_ORIGIN',
  'OWNER_SETUP_TOKEN', 'OWNER_EMAIL', 'OWNER_PASSWORD', 'OWNER_NAME', 'RETENTION_DAYS',
  'DEAD_LETTER_QUEUE', 'ALERT_WEBHOOK_URL', 'ALERT_LAG_SECONDS', 'DAILY_RECORD_QUOTA',
] as const;

export const RETENTION_CRON = '17 * * * *';
export const PIPELINE_CRON = '*/5 * * * *';

export interface EdgeWatchOptions {
  db: SqlDatabase;
  blobs: BlobStore;
  keys?: KeyStore;
  vars?: Partial<Record<(typeof VAR_NAMES)[number], string>>;
  /** Ingest requests per project per RATE_LIMIT_PERIOD (the Workers RATE_LIMITER binding's limit). 0 disables. */
  rateLimit?: number;
  /** Built dashboard (apps/dashboard/dist) to serve at `/`. */
  dashboardDir?: string;
  queue?: Omit<LocalQueueOptions<IngestMessage>, 'deadLetter'>;
  /** Backend names reported by GET /healthz. Default sqlite and fs. */
  backends?: { events?: string; blobs?: string };
}

/** The in-memory queue counts as degraded from this share of maxPending: ingest starts answering 503 when it is full. */
export const QUEUE_DEGRADED_RATIO = 0.9;

/** Fixed-window per-key limiter with the Workers Rate Limiting binding's interface. */
export function memoryRateLimiter(limit: number, periodSeconds: number, now: () => number = Date.now) {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    limit({ key }: { key: string }): Promise<{ success: boolean }> {
      const t = now();
      let w = windows.get(key);
      if (!w || t - w.start >= periodSeconds * 1000) {
        if (windows.size > 10_000) windows.clear();
        w = { start: t, count: 0 };
        windows.set(key, w);
      }
      w.count++;
      return Promise.resolve({ success: w.count <= limit });
    },
  };
}

class Context {
  readonly pending = new Set<Promise<unknown>>();
  readonly props = {};
  waitUntil(p: Promise<unknown>): void {
    const tracked = p.catch(() => {}).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }
  passThroughOnException(): void {}
}

const STATIC_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
};

/**
 * The API throttles sign-in attempts per `cf-connecting-ip`. Outside Cloudflare a client could send that header itself,
 * so the server always replaces it with the address it observed (or removes it when there is none).
 */
export function withClientIp(req: Request, ip: string | null | undefined): Request {
  const headers = new Headers(req.headers);
  if (ip) headers.set('cf-connecting-ip', ip);
  else headers.delete('cf-connecting-ip');
  return new Request(req, { headers });
}

/** Client address: the first entry of `proxyHeader` (when the server sits behind a trusted proxy), else the socket peer. */
export function clientIp(req: Request, peer: string | null | undefined, proxyHeader?: string): string | null {
  if (proxyHeader) return req.headers.get(proxyHeader)?.split(',')[0]?.trim() || null;
  return peer || null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.map': 'application/json', '.txt': 'text/plain',
};

function staticFile(dir: string, pathname: string): Response | null {
  const root = normalize(dir);
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch {
    return new Response('Invalid path', { status: 400, headers: { 'cache-control': 'no-store' } });
  }
  let file = normalize(join(root, decoded));
  if (file !== root && !file.startsWith(root + sep)) return null;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // A stale deployment chunk must fail as an asset, not receive the SPA HTML shell.
    if (decoded === '/assets' || decoded.startsWith('/assets/')) return null;
    file = join(root, 'index.html');
  }
  if (!existsSync(file)) return null;
  const type = MIME[extname(file)] ?? 'application/octet-stream';
  const cache = file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
  return new Response(Bun.file(file), { headers: { ...STATIC_HEADERS, 'content-type': type, 'cache-control': cache } });
}

/** One process running the ingest, consumer and API Workers over the given stores, with an in-process queue. */
export function createEdgeWatch(o: EdgeWatchOptions) {
  const vars = o.vars ?? {};
  const dlqName = vars.DEAD_LETTER_QUEUE ?? 'edgewatch-ingest-dlq';
  const period = Number(vars.RATE_LIMIT_PERIOD ?? 60);
  const rateLimit = o.rateLimit ?? 600;
  const env = {
    ...vars,
    DEAD_LETTER_QUEUE: dlqName,
    DB: o.db,
    TRACES: o.blobs,
    API_KEYS: o.keys ?? new SqlKeyStore(o.db),
    RATE_LIMITER: rateLimit > 0 ? memoryRateLimiter(rateLimit, period) : undefined,
    TOKEN_SIGNING_SECRET: vars.TOKEN_SIGNING_SECRET ?? '',
  } as Record<string, unknown>;
  const ctx = new Context();
  const consume = (batch: MessageBatch<IngestMessage>) => consumer.queue(batch, env as never);
  const deadLetters = new LocalQueue<IngestMessage>(dlqName, consume, o.queue);
  const queue = new LocalQueue<IngestMessage>('edgewatch-ingest', consume, { ...o.queue, deadLetter: deadLetters });
  env.INGEST_QUEUE = queue;

  const events = o.backends?.events ?? 'sqlite';
  const health = (): Promise<HealthReport> =>
    runHealthChecks('server', {
      events: healthChecks.sql(o.db, events),
      schema: healthChecks.schema(o.db, events),
      blobs: healthChecks.blobs(o.blobs, o.backends?.blobs ?? 'fs'),
      keys: healthChecks.keys(env.API_KEYS as KeyStore, o.keys ? 'custom' : 'sql'),
      signing_secret: healthChecks.configured(env.TOKEN_SIGNING_SECRET),
      queue: {
        required: false,
        backend: o.queue?.store ? 'sqlite' : 'memory',
        run: async () => {
          const detail = { pending: queue.size, capacity: queue.capacity, dead_letters: deadLetters.size };
          if (queue.size >= queue.capacity * QUEUE_DEGRADED_RATIO) throw new HealthCheckError('over_capacity', 'queue nearly full', detail);
          return detail;
        },
      },
    }, { onError: (check, e) => log('server', 'warn', 'health_check_failed', { check, ...errorFields(e) }) });

  const fetch = async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);
    if (pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) return healthResponse(await health());
    if (pathname.startsWith('/v1/') || pathname.startsWith('/auth/')) return api.fetch(req, env as never, ctx as never);
    if (pathname === '/health' || pathname.startsWith('/api/') || !o.dashboardDir) return ingest.fetch(req, env as never, ctx as never);
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Not found', { status: 404 });
    return staticFile(o.dashboardDir, pathname) ?? new Response('Not found', { status: 404 });
  };

  const scheduled = (cron: string, scheduledTime = Date.now()) =>
    consumer.scheduled({ cron, scheduledTime, type: 'scheduled', noRetry() {} } as ScheduledController, env as never);

  const timers: ReturnType<typeof setInterval>[] = [];
  const runCron = (cron: string) => scheduled(cron).catch(() => {});

  return {
    env,
    queue,
    deadLetters,
    fetch,
    health,
    scheduled,
    /** Runs the consumer's crons: dead-letter replay and lag check every 5 minutes, retention hourly (first after 1 minute). */
    startCrons(): void {
      timers.push(setInterval(() => runCron(PIPELINE_CRON), 5 * 60_000));
      timers.push(setTimeout(() => runCron(RETENTION_CRON), 60_000) as unknown as ReturnType<typeof setInterval>);
      timers.push(setInterval(() => runCron(RETENTION_CRON), 60 * 60_000));
    },
    /** Waits for background work (waitUntil) and delivers queued messages. */
    async settle(): Promise<void> {
      await Promise.all(ctx.pending);
      await queue.drain();
      await deadLetters.drain();
      await Promise.all(ctx.pending);
    },
    async close(): Promise<void> {
      for (const t of timers) clearInterval(t);
      await Promise.all(ctx.pending);
      await queue.close();
      await deadLetters.close();
      log('server', 'info', 'closed', {});
    },
  };
}

export type EdgeWatch = ReturnType<typeof createEdgeWatch>;
