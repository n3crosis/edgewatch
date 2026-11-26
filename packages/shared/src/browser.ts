import { z } from 'zod';
import { sha256Hex } from './crypto';
import { scrubPii } from './pii';
import type { NightwatchRecord } from './records';

/**
 * Browser error events (EdgeWatch extension, NOT part of the Nightwatch wire format: laravel/nightwatch v1.30.6 has no
 * browser record type). Posted by @edgewatch/browser to POST /api/browser and converted into Nightwatch-shaped
 * `exception` (v3) records with execution_source "browser", so the rest of the pipeline treats them like server exceptions.
 */
export const Breadcrumb = z.object({
  timestamp: z.number(),
  category: z.string().max(40),
  message: z.string().max(500),
  level: z.enum(['info', 'warning', 'error']).default('info'),
  data: z.record(z.string().max(40), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).optional(),
});
export type Breadcrumb = z.infer<typeof Breadcrumb>;
export const MAX_BREADCRUMBS = 30;

const metric = z.number().nonnegative().max(3_600_000).nullish();
/** Core Web Vitals in ms (cls is unitless), measured once per page view. */
export const WebVitals = z.object({ lcp: metric, inp: metric, cls: metric, fcp: metric, ttfb: metric });

export const BrowserEvent = z.object({
  type: z.enum(['error', 'unhandledrejection', 'manual', 'vitals']).default('error'),
  timestamp: z.number(),
  class: z.string().max(200).default('Error'),
  message: z.string().max(2_000).default(''),
  stack: z.string().max(20_000).default(''),
  file: z.string().max(2_000).default(''),
  line: z.number().int().nonnegative().default(0),
  column: z.number().int().nonnegative().default(0),
  url: z.string().max(2_000),
  user_agent: z.string().max(500).nullish(),
  release: z.string().max(200).nullish(),
  trace_id: z.string().max(64).nullish(),
  user: z.union([z.string().max(200), z.number()]).nullish(),
  handled: z.boolean().default(false),
  breadcrumbs: z.array(Breadcrumb).max(MAX_BREADCRUMBS).optional(),
  vitals: WebVitals.optional(),
});
export type BrowserEvent = z.infer<typeof BrowserEvent>;

export const BrowserBody = z.object({ events: z.array(z.unknown()).min(1).max(50) });

const path = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url.slice(0, 200);
  }
};

/** Breadcrumbs can carry user input (console text, URLs): scrub PII like exception messages. */
const scrubCrumb = (b: Breadcrumb): Breadcrumb => ({
  ...b,
  message: scrubPii(b.message),
  ...(b.data ? { data: Object.fromEntries(Object.entries(b.data).map(([k, v]) => [k, typeof v === 'string' ? scrubPii(v) : v])) } : {}),
});

export async function browserEventToRecord(e: BrowserEvent): Promise<NightwatchRecord> {
  const traceId = e.trace_id || crypto.randomUUID();
  if (e.type === 'vitals') {
    const v = e.vitals ?? {};
    return {
      v: 1,
      t: 'web-vital',
      timestamp: e.timestamp,
      deploy: e.release ?? null,
      server: 'browser',
      trace_id: traceId,
      execution_source: 'browser',
      execution_id: traceId,
      execution_preview: path(e.url),
      execution_stage: 'browser',
      user: e.user ?? null,
      path: path(e.url),
      lcp: v.lcp ?? null,
      inp: v.inp ?? null,
      cls: v.cls ?? null,
      fcp: v.fcp ?? null,
      ttfb: v.ttfb ?? null,
      user_agent: e.user_agent ?? null,
    };
  }
  // Group like Nightwatch does (class + location), with the message as tiebreaker since minified bundles share files.
  const group = (await sha256Hex(`${e.class}|${e.file}|${e.line}|${e.message.replace(/\d+/g, '?')}`)).slice(0, 32);
  return {
    v: 3,
    t: 'exception',
    timestamp: e.timestamp,
    deploy: e.release ?? null,
    server: 'browser',
    _group: group,
    trace_id: traceId,
    execution_source: 'browser',
    execution_id: traceId,
    execution_preview: path(e.url),
    execution_stage: 'browser',
    user: e.user ?? null,
    class: e.class,
    file: e.file,
    line: e.line,
    message: e.message,
    code: '0',
    trace: e.stack,
    handled: e.handled,
    browser: { type: e.type, url: e.url, column: e.column, user_agent: e.user_agent ?? null, breadcrumbs: (e.breadcrumbs ?? []).map(scrubCrumb) },
  };
}
