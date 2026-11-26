import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeElement, init, normalizeError, type BrowserErrorEvent } from './index';

class FakeTarget {
  listeners = new Map<string, ((e: Event) => void)[]>();
  addEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  emit(type: string, e: object) {
    (this.listeners.get(type) ?? []).forEach((fn) => fn(e as Event));
  }
}

let sent: { url: string; events: BrowserErrorEvent[] }[];
let target: FakeTarget;
const transport = (url: string, body: string) => void sent.push({ url, events: JSON.parse(body).events });
const setup = (extra = {}) => init({ endpoint: 'https://ingest.test/', key: 'ew_pub_abc', release: 'v42', transport, target: target as unknown as Window, ...extra });

beforeEach(() => {
  sent = [];
  target = new FakeTarget();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('@edgewatch/browser', () => {
  it('parses Chrome and Firefox stack frames', () => {
    const chrome = new TypeError('x is undefined');
    chrome.stack = 'TypeError: x is undefined\n    at render (https://shop.test/assets/app.js:10:5)\n    at main (https://shop.test/assets/app.js:2:1)';
    expect(normalizeError(chrome)).toMatchObject({ class: 'TypeError', message: 'x is undefined', file: 'https://shop.test/assets/app.js', line: 10, column: 5 });

    const firefox = new Error('boom');
    firefox.stack = 'render@https://shop.test/assets/app.js:7:3\nmain@https://shop.test/assets/app.js:1:1';
    expect(normalizeError(firefox)).toMatchObject({ file: 'https://shop.test/assets/app.js', line: 7, column: 3 });
    expect(normalizeError('plain string')).toMatchObject({ class: 'Error', message: 'plain string' });
    expect(normalizeError({ code: 1 })).toMatchObject({ message: '{"code":1}' });
  });

  it('batches uncaught errors and rejections to {endpoint}/api/browser?key=', () => {
    setup({ traceId: '019aa7b1-35fb-7000-8000-00000000000a', user: 7 });
    target.emit('error', { error: new RangeError('bad'), message: 'bad', filename: 'https://shop.test/a.js', lineno: 3, colno: 9 });
    target.emit('unhandledrejection', { reason: new Error('rejected') });
    expect(sent).toHaveLength(0);

    vi.advanceTimersByTime(1000);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://ingest.test/api/browser?key=ew_pub_abc');
    expect(sent[0].events.map((e) => [e.type, e.class, e.handled])).toEqual([['error', 'RangeError', false], ['unhandledrejection', 'Error', false]]);
    expect(sent[0].events[0]).toMatchObject({ release: 'v42', trace_id: '019aa7b1-35fb-7000-8000-00000000000a', user: 7 });
  });

  it('ignores resource load errors, dedupes repeats, and respects the per-minute cap', () => {
    const client = setup({ maxEventsPerMinute: 2 });
    target.emit('error', {});
    const same = new Error('same');
    client.captureException(same);
    client.captureException(same);
    client.captureException(new Error('other'));
    client.captureException(new Error('third'));
    client.flush();
    expect(sent[0].events.map((e) => e.message)).toEqual(['same', 'other']);
    expect(sent[0].events[0]).toMatchObject({ type: 'manual', handled: true });
  });

  it('applies ignoreErrors, sampleRate and beforeSend, and close() flushes and detaches', () => {
    const client = setup({ ignoreErrors: [/ResizeObserver/], beforeSend: (e: BrowserErrorEvent) => (e.message.includes('drop') ? null : { ...e, message: e.message.toUpperCase() }) });
    client.captureException(new Error('ResizeObserver loop limit exceeded'));
    client.captureException(new Error('drop me'));
    client.captureException(new Error('keep'));
    client.close();
    target.emit('error', { error: new Error('after close') });
    vi.advanceTimersByTime(5000);
    expect(sent.flatMap((s) => s.events).map((e) => e.message)).toEqual(['KEEP']);

    setup({ sampleRate: 0 }).captureException(new Error('sampled out'));
    vi.advanceTimersByTime(5000);
    expect(sent).toHaveLength(1);
  });

  it('flushes on pagehide', () => {
    setup();
    target.emit('error', { error: new Error('leaving') });
    target.emit('pagehide', {});
    expect(sent).toHaveLength(1);
  });
});

describe('breadcrumbs', () => {
  it('records clicks, console, fetch and navigation, keeps the last N, attaches them to errors and restores globals on close', async () => {
    const realFetch = globalThis.fetch;
    const realWarn = console.warn;
    globalThis.fetch = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const history = { pushState: vi.fn(), replaceState: vi.fn() };
    vi.stubGlobal('history', history);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = setup({ breadcrumbs: { max: 4 }, webVitals: false });
    target.emit('click', { target: { tagName: 'BUTTON', id: 'pay', className: 'btn primary x', textContent: '  Pay   now ' } });
    console.warn = vi.fn();
    console.error('card declined for', { id: 7 });
    await globalThis.fetch('https://api.shop.test/cart?token=secret', { method: 'post' });
    await globalThis.fetch('https://ingest.test/api/browser');
    (globalThis.history as unknown as typeof history).pushState({}, '', '/next');
    client.addBreadcrumb({ category: 'custom', message: 'opened drawer' });
    client.captureException(new Error('boom'));
    client.flush();
    const crumbs = sent[0].events[0].breadcrumbs ?? [];
    expect(crumbs.map((c) => [c.category, c.message])).toEqual([
      ['console', 'card declined for {"id":7}'], ['fetch', 'POST https://api.shop.test/cart 503'], ['navigation', expect.any(String)], ['custom', 'opened drawer'],
    ]);
    expect(crumbs[1].level).toBe('error');
    client.close();
    expect(history.pushState).toHaveBeenCalled();
    expect((globalThis.history as unknown as typeof history).pushState).toBe(history.pushState);
    expect(globalThis.fetch).not.toBe(realFetch);
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('describes elements without reading field values; breadcrumbs: false keeps only manual ones', () => {
    expect(describeElement({ tagName: 'INPUT', id: 'email', className: '', textContent: 'jane@example.com' })).toBe('input#email');
    expect(describeElement({ tagName: 'A', className: 'nav', textContent: 'Home' })).toBe('a.nav "Home"');
    expect(describeElement(null)).toBe('unknown');
    const client = setup({ breadcrumbs: false, webVitals: false });
    target.emit('click', { target: { tagName: 'BUTTON' } });
    client.addBreadcrumb({ category: 'custom', message: 'only me' });
    client.captureException(new Error('x'));
    client.close();
    expect(sent[0].events[0].breadcrumbs?.map((c) => c.message)).toEqual(['only me']);
  });
});

describe('web vitals', () => {
  type Cb = (list: { getEntries: () => object[] }) => void;
  let observers: Map<string, Cb>;
  beforeEach(() => {
    observers = new Map();
    vi.stubGlobal('PerformanceObserver', class {
      constructor(private cb: Cb) {}
      observe(o: { type: string }) { observers.set(o.type, this.cb); }
      disconnect() {}
    });
    vi.stubGlobal('performance', { getEntriesByType: () => [{ responseStart: 120.4 }] });
  });
  afterEach(() => vi.unstubAllGlobals());
  const emit = (type: string, ...entries: object[]) => observers.get(type)?.({ getEntries: () => entries });

  it('reports LCP, INP, CLS session windows, FCP and TTFB once on pagehide', () => {
    setup({ breadcrumbs: false });
    emit('largest-contentful-paint', { startTime: 900 }, { startTime: 1800.6 });
    emit('paint', { name: 'first-paint', startTime: 300 }, { name: 'first-contentful-paint', startTime: 450 });
    emit('layout-shift', { startTime: 100, value: 0.05 }, { startTime: 600, value: 0.05 }, { startTime: 700, value: 0.5, hadRecentInput: true }, { startTime: 3000, value: 0.02 });
    emit('event', { interactionId: 1, duration: 90 }, { interactionId: 0, duration: 900 }, { interactionId: 2, duration: 240 });
    target.emit('pagehide', {});
    target.emit('pagehide', {});
    const vitals = sent.flatMap((s) => s.events).filter((e) => e.type === 'vitals');
    expect(vitals).toHaveLength(1);
    expect(vitals[0].vitals).toEqual({ lcp: 1801, inp: 240, cls: 0.1, fcp: 450, ttfb: 120 });
  });

  it('sends nothing when no metric was observed, when disabled, or when sampled out', () => {
    setup({ breadcrumbs: false }).close();
    target.emit('pagehide', {});
    setup({ breadcrumbs: false, webVitals: false });
    emit('largest-contentful-paint', { startTime: 900 });
    target.emit('pagehide', {});
    setup({ breadcrumbs: false, vitalsSampleRate: 0 });
    target.emit('pagehide', {});
    expect(sent.flatMap((s) => s.events).filter((e) => e.type === 'vitals')).toHaveLength(0);
  });
});
