/** Typed status for GET /healthz on every EdgeWatch service. */
export type HealthStatus = 'ok' | 'degraded' | 'down';
export type HealthService = 'ingest' | 'consumer' | 'api' | 'server';

export interface HealthCheckResult {
  status: 'ok' | 'fail';
  /** A failing required check makes the service `down` (HTTP 503); a failing optional one makes it `degraded`. */
  required: boolean;
  latency_ms: number;
  /** Which implementation was checked (d1, postgres, r2, s3, kv, sql, queue, ...). */
  backend?: string;
  /** Short, fixed reason: never the underlying error text, which can hold hostnames or credentials. */
  error?: 'timeout' | 'unavailable' | 'not_configured' | 'schema_missing' | 'over_capacity';
  detail?: Record<string, number>;
}

export interface HealthReport {
  status: HealthStatus;
  service: HealthService;
  checked_at: string;
  checks: Record<string, HealthCheckResult>;
}

export interface HealthCheck {
  required: boolean;
  backend?: string;
  /** Resolves when the dependency answered; may return numbers to report (for example queue depth). */
  // biome-ignore lint/suspicious/noConfusingVoidType: most checks are `async () => {}` and report nothing
  run: () => Promise<Record<string, number> | void>;
}

export class HealthCheckError extends Error {
  constructor(readonly reason: NonNullable<HealthCheckResult['error']>, message: string = reason, readonly detail?: Record<string, number>) {
    super(message);
  }
}

/** Runs every check in parallel, each bounded by timeoutMs, and folds them into one status. */
export interface HealthOptions {
  /** Per-check limit; a slower dependency counts as failed (`timeout`). Default 3000 ms. */
  timeoutMs?: number;
  /** Receives the real error (for logs); the report itself only carries the fixed reason. */
  onError?: (name: string, error: unknown) => void;
  now?: () => number;
}

export async function runHealthChecks(service: HealthService, checks: Record<string, HealthCheck>, options: HealthOptions = {}): Promise<HealthReport> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const now = options.now ?? (() => performance.now());
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, check]): Promise<[string, HealthCheckResult]> => {
      const started = now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const base = { required: check.required, ...(check.backend ? { backend: check.backend } : {}) };
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new HealthCheckError('timeout')), timeoutMs);
        });
        const detail = await Promise.race([check.run(), timeout]);
        return [name, { status: 'ok', ...base, latency_ms: Math.round(now() - started), ...(detail ? { detail } : {}) }];
      } catch (e) {
        options.onError?.(name, e);
        const error = e instanceof HealthCheckError ? e.reason : 'unavailable';
        const detail = e instanceof HealthCheckError && e.detail ? { detail: e.detail } : {};
        return [name, { status: 'fail', ...base, latency_ms: Math.round(now() - started), error, ...detail }];
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const results = Object.fromEntries(entries);
  const failed = entries.filter(([, r]) => r.status === 'fail');
  const status: HealthStatus = failed.some(([, r]) => r.required) ? 'down' : failed.length ? 'degraded' : 'ok';
  return { status, service, checked_at: new Date().toISOString(), checks: results };
}

/** HTTP status for a report: 503 when down, so load balancers and Docker healthchecks take the service out. */
export const healthHttpStatus = (report: HealthReport): 200 | 503 => (report.status === 'down' ? 503 : 200);

/** Probe key that never exists: reading it proves the store answers without touching real data. */
export const HEALTH_PROBE_KEY = 'edgewatch-healthz-probe';

/** Common checks over the shared storage interfaces. */
export const healthChecks = {
  sql(db: { prepare(sql: string): { first<T>(): Promise<T | null> } } | undefined, backend: string, required = true): HealthCheck {
    return {
      required,
      backend,
      run: async () => {
        if (!db) throw new HealthCheckError('not_configured');
        await db.prepare('SELECT 1 AS ok').first();
      },
    };
  },
  /** The tables EdgeWatch writes exist, i.e. migrations were applied. */
  schema(db: { prepare(sql: string): { first<T>(): Promise<T | null> } } | undefined, backend: string): HealthCheck {
    return {
      required: true,
      backend,
      run: async () => {
        if (!db) throw new HealthCheckError('not_configured');
        try {
          await db.prepare('SELECT trace_id FROM traces LIMIT 1').first();
        } catch (e) {
          throw new HealthCheckError('schema_missing', e instanceof Error ? e.message : String(e));
        }
      },
    };
  },
  blobs(store: { get(key: string): Promise<unknown> } | undefined, backend: string, required = true): HealthCheck {
    return {
      required,
      backend,
      run: async () => {
        if (!store) throw new HealthCheckError('not_configured');
        await store.get(`health/${HEALTH_PROBE_KEY}`);
      },
    };
  },
  keys(store: { get(key: string, options: { type: 'json' }): Promise<unknown> } | undefined, backend: string, required = true): HealthCheck {
    return {
      required,
      backend,
      run: async () => {
        if (!store) throw new HealthCheckError('not_configured');
        await store.get(HEALTH_PROBE_KEY, { type: 'json' });
      },
    };
  },
  /** A binding or secret that cannot be probed without side effects: only checks that it is set. */
  configured(value: unknown, backend?: string, required = true): HealthCheck {
    return {
      required,
      backend,
      run: async () => {
        if (value === undefined || value === null || value === '') throw new HealthCheckError('not_configured');
      },
    };
  },
};
