/**
 * @edgewatch/browser: reports uncaught browser errors and unhandled promise rejections (with breadcrumbs) and Core Web
 * Vitals to EdgeWatch.
 *
 * This is an EdgeWatch extension. laravel/nightwatch (v1.30.6) has no browser record type, so events go to
 * EdgeWatch's own POST /api/browser endpoint (not the Nightwatch agent endpoints), authenticated with a public
 * `browser`-scope key. The ingest Worker turns them into Nightwatch-shaped `exception` records.
 */
export interface Breadcrumb {
  timestamp: number;
  category: string;
  message: string;
  level?: 'info' | 'warning' | 'error';
  data?: Record<string, string | number | boolean | null>;
}

export interface WebVitals {
  lcp: number | null;
  inp: number | null;
  cls: number | null;
  fcp: number | null;
  ttfb: number | null;
}

export interface BrowserErrorEvent {
  type: 'error' | 'unhandledrejection' | 'manual' | 'vitals';
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
  breadcrumbs?: Breadcrumb[];
  vitals?: WebVitals;
}

export interface BreadcrumbOptions {
  clicks?: boolean;
  navigation?: boolean;
  console?: boolean;
  fetch?: boolean;
  /** Ring buffer size, default 20 (the server accepts up to 30). */
  max?: number;
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
  /** Automatic breadcrumbs attached to error events (default: all on, 20 kept). `false` keeps only addBreadcrumb(). */
  breadcrumbs?: BreadcrumbOptions | false;
  /** Report LCP, INP, CLS, FCP and TTFB once per page view when the page is hidden (default true). */
  webVitals?: boolean;
  /** 0..1 share of page views that report web vitals, default 1. */
  vitalsSampleRate?: number;
  /** Where to attach listeners. Default: window. */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

export interface EdgeWatchBrowser {
  captureException(error: unknown, options?: { handled?: boolean }): void;
  addBreadcrumb(crumb: Omit<Breadcrumb, 'timestamp'> & { timestamp?: number }): void;
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
  const queue: BrowserErrorEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let windowStart = Date.now();
  let sentInWindow = 0;
  const recent = new Map<string, number>();
  const crumbOpts = options.breadcrumbs === false ? { clicks: false, navigation: false, console: false, fetch: false } : (options.breadcrumbs ?? {});
  const maxCrumbs = Math.min(options.breadcrumbs === false ? 20 : (crumbOpts.max ?? 20), 30);
  const crumbs: Breadcrumb[] = [];
  const restore: (() => void)[] = [];
  const addBreadcrumb = (c: Omit<Breadcrumb, 'timestamp'> & { timestamp?: number }) => {
    crumbs.push({ ...c, message: String(c.message).slice(0, 500), category: String(c.category).slice(0, 40), timestamp: c.timestamp ?? Date.now() / 1000 });
    if (crumbs.length > maxCrumbs) crumbs.shift();
  };

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
        breadcrumbs: crumbs.slice(),
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
  const onHide = () => {
    sendVitals();
    flush();
  };

  const pagePath = () => (typeof location !== 'undefined' ? location.pathname + location.search : '');
  const onClick = (e: Event) => addBreadcrumb({ category: 'click', message: describeElement(e.target) });
  const onPop = () => addBreadcrumb({ category: 'navigation', message: pagePath() });
  if (crumbOpts.clicks !== false) target?.addEventListener('click', onClick, true);
  if (crumbOpts.navigation !== false) {
    target?.addEventListener('popstate', onPop);
    const history = globalThis.history as History | undefined;
    for (const method of ['pushState', 'replaceState'] as const) {
      const original = history?.[method];
      if (!history || typeof original !== 'function') continue;
      history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
        const result = original.apply(this, args);
        addBreadcrumb({ category: 'navigation', message: pagePath() });
        return result;
      };
      restore.push(() => (history[method] = original));
    }
  }
  if (crumbOpts.console !== false && typeof console !== 'undefined') {
    for (const level of ['warn', 'error'] as const) {
      const original = console[level];
      console[level] = (...args: unknown[]) => {
        addBreadcrumb({ category: 'console', level: level === 'warn' ? 'warning' : 'error', message: args.map((a) => (typeof a === 'string' ? a : safeString(a))).join(' ') });
        original.apply(console, args);
      };
      restore.push(() => (console[level] = original));
    }
  }
  const originalFetch = globalThis.fetch;
  if (crumbOpts.fetch !== false && typeof originalFetch === 'function') {
    const endpoint = options.endpoint.replace(/\/$/, '');
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (href.startsWith(endpoint)) return originalFetch(input, init);
      const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
      const started = Date.now();
      const where = href.split('?')[0];
      try {
        const res = await originalFetch(input, init);
        addBreadcrumb({ category: 'fetch', level: res.status >= 500 ? 'error' : res.status >= 400 ? 'warning' : 'info', message: `${method} ${where} ${res.status}`, data: { duration_ms: Date.now() - started } });
        return res;
      } catch (e) {
        addBreadcrumb({ category: 'fetch', level: 'error', message: `${method} ${where} failed`, data: { duration_ms: Date.now() - started } });
        throw e;
      }
    };
    restore.push(() => (globalThis.fetch = originalFetch));
  }

  const vitals = options.webVitals !== false && Math.random() < (options.vitalsSampleRate ?? 1) ? observeVitals() : null;
  const sendVitals = () => {
    const v = vitals?.take();
    if (!v) return;
    queue.push({
      type: 'vitals', timestamp: Date.now() / 1000, class: '', message: '', stack: '', file: '', line: 0, column: 0,
      url: typeof location !== 'undefined' ? location.href : '', user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      release: options.release ?? null, trace_id: options.traceId ?? metaTraceId(), user, handled: true, vitals: v,
    });
    flush();
  };
  const onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') sendVitals();
  };
  if (vitals) target?.addEventListener('visibilitychange', onVisibility);

  target?.addEventListener('error', onError);
  target?.addEventListener('unhandledrejection', onRejection);
  target?.addEventListener('pagehide', onHide);

  return {
    captureException: (error, opts) => record('manual', error, opts?.handled ?? true),
    addBreadcrumb,
    setUser: (u) => {
      user = u;
    },
    flush,
    close: () => {
      flush();
      target?.removeEventListener('error', onError);
      target?.removeEventListener('unhandledrejection', onRejection);
      target?.removeEventListener('pagehide', onHide);
      target?.removeEventListener('click', onClick, true);
      target?.removeEventListener('popstate', onPop);
      target?.removeEventListener('visibilitychange', onVisibility);
      vitals?.disconnect();
      restore.splice(0).forEach((fn) => fn());
    },
  };
}

function safeString(value: unknown): string {
  try {
    return value instanceof Error ? `${value.name}: ${value.message}` : (JSON.stringify(value) ?? String(value));
  } catch {
    return String(value);
  }
}

/** e.g. `button#pay.btn.primary "Pay now"`; never reads input values. */
export function describeElement(el: unknown): string {
  if (!el || typeof el !== 'object' || !('tagName' in el)) return 'unknown';
  const e = el as { tagName: string; id?: string; className?: unknown; textContent?: string | null };
  const classes = typeof e.className === 'string' && e.className.trim() ? `.${e.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
  const isField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName.toUpperCase());
  const text = !isField && e.textContent ? ` "${e.textContent.trim().replace(/\s+/g, ' ').slice(0, 40)}"` : '';
  return `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${classes}${text}`;
}

interface VitalsObserver {
  take(): WebVitals | null;
  disconnect(): void;
}

/** Core Web Vitals with PerformanceObserver (LCP, CLS session windows, INP as the slowest interaction, FCP, TTFB). */
export function observeVitals(): VitalsObserver | null {
  const PO = (globalThis as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
  if (typeof PO !== 'function') return null;
  const v: WebVitals = { lcp: null, inp: null, cls: null, fcp: null, ttfb: null };
  let taken = false;
  let windowValue = 0;
  let windowStart = 0;
  let lastShift = 0;
  const observers: PerformanceObserver[] = [];
  const watch = (type: string, onEntry: (e: PerformanceEntry & Record<string, unknown>) => void, extra: Record<string, unknown> = {}) => {
    try {
      const o = new PO((list) => list.getEntries().forEach((e) => onEntry(e as PerformanceEntry & Record<string, unknown>)));
      o.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
      observers.push(o);
    } catch {
      // Entry type not supported by this browser.
    }
  };
  watch('largest-contentful-paint', (e) => (v.lcp = Math.round(e.startTime)));
  watch('paint', (e) => {
    if (e.name === 'first-contentful-paint') v.fcp = Math.round(e.startTime);
  });
  watch('layout-shift', (e) => {
    if (e.hadRecentInput) return;
    const value = Number(e.value) || 0;
    if (e.startTime - lastShift > 1000 || e.startTime - windowStart > 5000) {
      windowStart = e.startTime;
      windowValue = 0;
    }
    lastShift = e.startTime;
    windowValue += value;
    v.cls = Math.round(Math.max(v.cls ?? 0, windowValue) * 10_000) / 10_000;
  });
  watch('event', (e) => {
    if (e.interactionId) v.inp = Math.max(v.inp ?? 0, Math.round(e.duration));
  }, { durationThreshold: 40 });
  const nav = (globalThis as { performance?: Performance }).performance?.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined;
  if (nav && nav.responseStart > 0) v.ttfb = Math.round(nav.responseStart);
  return {
    take: () => {
      if (taken || Object.values(v).every((x) => x === null)) return null;
      taken = true;
      return { ...v };
    },
    disconnect: () => observers.forEach((o) => o.disconnect()),
  };
}
