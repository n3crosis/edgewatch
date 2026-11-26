import type { Context, ErrorHandler, MiddlewareHandler, NotFoundHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { errorBody, errorFields, log, requestIdFrom, type ErrorCode } from './observability';

/** Context variables set by `observe()`; handlers may add projectId and extra log fields. */
export type ObservedVariables = { requestId: string; projectId?: string; logFields?: Record<string, unknown> };

/** Any Hono context whose variables include the request id set by `observe()`. */
type ErrorContext = Pick<Context, 'json' | 'header'> & { get(key: 'requestId'): string | undefined };

export type StorageBinding = 'kv' | 'd1' | 'r2' | 'queue';

/** A KV, D1, R2 or Queue call failed. `onError` answers 503 `unavailable` and logs the (scrubbed) cause. */
export class StorageError extends Error {
  constructor(readonly binding: StorageBinding, cause: unknown) {
    super(`${binding} unavailable`, { cause });
    this.name = 'StorageError';
  }
}

/** Runs one binding call and tags any failure as a StorageError for the given binding. */
export async function storage<T>(binding: StorageBinding, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
    throw e instanceof StorageError ? e : new StorageError(binding, e);
  }
}

/**
 * Request id + one structured access-log line per request. Only the path is logged (never the query string, which can
 * carry a browser key) and never headers or bodies.
 */
export function observe(service: string): MiddlewareHandler {
  return async (c, next) => {
    const started = Date.now();
    const requestId = requestIdFrom(c.req.raw.headers);
    c.set('requestId', requestId);
    await next();
    c.header('X-Request-Id', requestId);
    const status = c.res.status;
    log(service, status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', 'request', {
      request_id: requestId,
      project_id: c.get('projectId') ?? null,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status,
      duration_ms: Date.now() - started,
      ...(c.get('logFields') ?? {}),
    });
  };
}

export function fail(c: ErrorContext, status: ContentfulStatusCode, code: ErrorCode, message: string, details?: unknown) {
  return c.json(errorBody(code, message, c.get('requestId'), details), status);
}

export function onError(service: string): ErrorHandler {
  return (err, c) => {
    const fields = { request_id: c.get('requestId'), project_id: c.get('projectId') ?? null, path: new URL(c.req.url).pathname };
    if (err instanceof StorageError) {
      log(service, 'error', 'storage_unavailable', { ...fields, binding: err.binding, ...errorFields(err.cause) });
      c.header('Retry-After', '5');
      return fail(c, 503, 'unavailable', 'Storage temporarily unavailable.');
    }
    log(service, 'error', 'unhandled_error', { ...fields, ...errorFields(err) });
    return fail(c, 500, 'internal_error', 'Internal error.');
  };
}

export const notFound: NotFoundHandler = (c) => fail(c, 404, 'not_found', 'Not found.');
