/**
 * @edgewatch/browser: reports uncaught browser errors and unhandled promise rejections to EdgeWatch.
 *
 * This is an EdgeWatch extension. laravel/nightwatch (v1.30.6) has no browser record type, so events go to
 * EdgeWatch's own POST /api/browser endpoint (not the Nightwatch agent endpoints), authenticated with a public
 * `browser`-scope key. The ingest Worker turns them into Nightwatch-shaped `exception` records.
 */
export interface BrowserErrorEvent {
  type: 'error' | 'unhandledrejection' | 'manual';
  timestamp: number;
  class: string;
  message: string;
  stack: string;
  file: string;
  line: number;
  column: number;
  url: string;
  user_agent: string | null;
  release: string | null;
  trace_id: string | null;
  user: string | number | null;
  handled: boolean;
}

export interface EdgeWatchBrowserOptions {
  /** Ingest Worker origin, e.g. https://ingest.example.com (the SDK posts to {endpoint}/api/browser). */
  endpoint: string;
  /** Public browser key (scope "browser"). Never ship an ingest key to browsers. */
  key: string;
  release?: string;
  /** Server trace to attach errors to. Defaults to <meta name="edgewatch-trace-id" content="...">. */
  traceId?: string | null;
  user?: string | number | null;
  /** 0..1, default 1. */
  sampleRate?: number;
  /** Hard cap per page load per minute, default 30. */
  maxEventsPerMinute?: number;
  ignoreErrors?: (string | RegExp)[];
  /** Return null to drop the event. */
  beforeSend?: (event: BrowserErrorEvent) => BrowserErrorEvent | null;
  /** Batch window in ms, default 1000. */
  flushInterval?: number;
  /** For tests/custom delivery. Default: navigator.sendBeacon, falling back to fetch(keepalive). */
  transport?: (url: string, body: string) => void;
  /** Where to attach listeners. Default: window. */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

export interface EdgeWatchBrowser {
  captureException(error: unknown, options?: { handled?: boolean }): void;
  setUser(user: string | number | null): void;
  flush(): void;
  close(): void;
}

const FRAME = /(?:@|\()?((?:https?|file|webpack|blob):\/\/[^\s)]+?|\/[^\s):]+?):(\d+):(\d+)\)?\s*$/m;

function defaultTransport(url: string, body: string): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(url, body)) return;
  } catch {
    // fall through to fetch
  }
  if (typeof fetch === 'function') {
    fetch(url, { method: 'POST', body, keepalive: true, mode: 'cors', headers: { 'content-type': 'text/plain' } }).catch(() => {});
  }
}

function metaTraceId(): string | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector('meta[name="edgewatch-trace-id"]')?.getAttribute('content') || null;
}

export function normalizeError(
  error: unknown,
  fallback: { file?: string; line?: number; column?: number } = {},
): Pick<BrowserErrorEvent, 'class' | 'message' | 'stack' | 'file' | 'line' | 'column'> {
  const err = error instanceof Error ? error : null;
  const stack = (err?.stack ?? '').slice(0, 20_000);
  const frame = stack.split('\n').map((l) => l.match(FRAME)).find(Boolean);
  let message: string;
  if (err) message = err.message;
  else if (typeof error === 'string') message = error;
  else {
    try {
      message = JSON.stringify(error) ?? String(error);
    } catch {
      message = String(error);
    }
  }
  return {
    class: err?.name || (error && typeof error === 'object' ? error.constructor?.name : null) || 'Error',
    message: message.slice(0, 2_000),
    stack,
    file: frame?.[1] ?? fallback.file ?? '',
    line: frame ? Number(frame[2]) : (fallback.line ?? 0),
    column: frame ? Number(frame[3]) : (fallback.column ?? 0),
  };
}

export function init(options: EdgeWatchBrowserOptions): EdgeWatchBrowser {
  const url = `${options.endpoint.replace(/\/$/, '')}/api/browser?key=${encodeURIComponent(options.key)}`;
  const send = options.transport ?? defaultTransport;
  const target = options.target ?? (typeof window !== 'undefined' ? window : undefined);
  const sampleRate = options.sampleRate ?? 1;
  const maxPerMinute = options.maxEventsPerMinute ?? 30;
  const flushInterval = options.flushInterval ?? 1000;
  let user = options.user ?? null;
  let queue: BrowserErrorEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let windowStart = Date.now();
  let sentInWindow = 0;
  const recent = new Map<string, number>();

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    while (queue.length) send(url, JSON.stringify({ events: queue.splice(0, 50) }));
  };

  const record = (type: BrowserErrorEvent['type'], error: unknown, handled: boolean, fallback?: { file?: string; line?: number; column?: number }) => {
    try {
      const n = normalizeError(error, fallback);
      if (options.ignoreErrors?.some((p) => (typeof p === 'string' ? n.message.includes(p) : p.test(n.message)))) return;
      if (Math.random() >= sampleRate) return;

      const now = Date.now();
      if (now - windowStart > 60_000) {
        windowStart = now;
        sentInWindow = 0;
      }
      const fingerprint = `${n.class}|${n.message}|${n.file}|${n.line}`;
      if ((recent.get(fingerprint) ?? 0) > now - 5_000 || sentInWindow >= maxPerMinute) return;
      recent.set(fingerprint, now);

      let event: BrowserErrorEvent | null = {
        type,
        timestamp: now / 1000,
        ...n,
        url: typeof location !== 'undefined' ? location.href : '',
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
        release: options.release ?? null,
        trace_id: options.traceId ?? metaTraceId(),
        user,
        handled,
      };
      if (options.beforeSend) event = options.beforeSend(event);
      if (!event) return;

      sentInWindow++;
      queue.push(event);
      if (!timer) timer = setTimeout(flush, flushInterval);
    } catch {
      // Never let telemetry throw into the app.
    }
  };

  const onError = (e: Event) => {
    const ev = e as ErrorEvent;
    if (!ev.error && !ev.message) return; // resource load errors
    record('error', ev.error ?? ev.message, false, { file: ev.filename, line: ev.lineno, column: ev.colno });
  };
  const onRejection = (e: Event) => record('unhandledrejection', (e as PromiseRejectionEvent).reason, false);
  const onHide = () => flush();

  target?.addEventListener('error', onError);
  target?.addEventListener('unhandledrejection', onRejection);
  target?.addEventListener('pagehide', onHide);

  return {
    captureException: (error, opts) => record('manual', error, opts?.handled ?? true),
    setUser: (u) => {
      user = u;
    },
    flush,
    close: () => {
      flush();
      target?.removeEventListener('error', onError);
      target?.removeEventListener('unhandledrejection', onRejection);
      target?.removeEventListener('pagehide', onHide);
    },
  };
}
