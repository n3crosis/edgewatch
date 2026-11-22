import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { init, normalizeError, type BrowserErrorEvent } from './index';

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
