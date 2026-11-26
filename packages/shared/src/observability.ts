import { scrubPii } from './pii';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type ErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'conflict'
  | 'not_found'
  | 'invalid_request'
  | 'payload_too_large'
  | 'unprocessable'
  | 'over_quota'
  | 'rate_limited'
  | 'unavailable'
  | 'internal_error';

/**
 * Every EdgeWatch error response. `message` is kept at the top level as well because the Nightwatch agent
 * logs `message`; new clients should read `error.code`.
 */
export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
  message: string;
  request_id?: string;
}

export function errorBody(code: ErrorCode, message: string, requestId?: string, details?: unknown): ErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }) }, message, ...(requestId ? { request_id: requestId } : {}) };
}

const SECRET_KEY = /authorization|token|secret|password|passwd|api[_-]?key|^key$|cookie|signature/i;

/** Masks secret-looking keys and scrubs emails, card numbers and bearer tokens from strings before anything is logged. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubPii(value).slice(0, 1000);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)]));
}

/** One JSON object per line, so Workers Logs / Logpush can filter on request_id, project_id, event, etc. */
export function log(service: string, level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, service, event, ...(redact(fields) as Record<string, unknown>) });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function errorFields(e: unknown): Record<string, string> {
  return e instanceof Error ? { error_class: e.name, error_message: scrubPii(e.message).slice(0, 500) } : { error_message: scrubPii(String(e)).slice(0, 500) };
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Reuses a caller's X-Request-Id (or Cloudflare's cf-ray) when it is safe to echo, otherwise mints one. */
export function requestIdFrom(headers: Headers): string {
  for (const name of ['x-request-id', 'cf-ray']) {
    const value = headers.get(name);
    if (value && SAFE_REQUEST_ID.test(value)) return value;
  }
  return crypto.randomUUID();
}
