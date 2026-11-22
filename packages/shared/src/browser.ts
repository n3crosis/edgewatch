import { z } from 'zod';
import { sha256Hex } from './crypto';
import type { NightwatchRecord } from './records';

/**
 * Browser error events (EdgeWatch extension, NOT part of the Nightwatch wire format: laravel/nightwatch v1.30.6 has no
 * browser record type). Posted by @edgewatch/browser to POST /api/browser and converted into Nightwatch-shaped
 * `exception` (v3) records with execution_source "browser", so the rest of the pipeline treats them like server exceptions.
 */
export const BrowserEvent = z.object({
  type: z.enum(['error', 'unhandledrejection', 'manual']).default('error'),
  timestamp: z.number(),
  class: z.string().max(200).default('Error'),
  message: z.string().max(2_000),
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

export async function browserEventToRecord(e: BrowserEvent): Promise<NightwatchRecord> {
  const traceId = e.trace_id || crypto.randomUUID();
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
    browser: { type: e.type, url: e.url, column: e.column, user_agent: e.user_agent ?? null },
  };
}
