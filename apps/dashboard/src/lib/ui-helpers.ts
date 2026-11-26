import type { Span, SpanType } from './types';

/** Produces 3 Y-axis tick labels while suppressing a duplicate middle label on small ranges (e.g. 1 / 1 / 0). */
export function yAxisTicks(max: number, format: (n: number) => string): [string, string, string] {
  const top = format(max);
  const mid = format(max / 2);
  const zero = format(0);
  return [top, mid !== top && mid !== zero ? mid : '', zero];
}

export interface TimeBreakdownSegment {
  key: SpanType | 'app';
  label: string;
  ms: number;
  percent: number;
}

const LEAF_CATEGORIES: { type: SpanType; label: string }[] = [
  { type: 'query', label: 'Queries' },
  { type: 'outgoing-request', label: 'Outgoing HTTP' },
  { type: 'cache', label: 'Cache' },
  { type: 'mail', label: 'Mail' },
  { type: 'middleware', label: 'Middleware' },
  { type: 'queued-job', label: 'Queued jobs' },
];

/** Computes proportional category breakdown of a trace's duration for the stacked summary bar. */
export function traceTimeBreakdown(spans: Span[], totalMs: number): TimeBreakdownSegment[] {
  const leafTotals = new Map<SpanType, number>();
  let leafSum = 0;
  for (const span of spans) {
    if (!LEAF_CATEGORIES.some((c) => c.type === span.type)) continue;
    const d = Number.isFinite(span.duration_ms) ? Math.max(0, span.duration_ms) : 0;
    if (d <= 0) continue;
    leafTotals.set(span.type, (leafTotals.get(span.type) ?? 0) + d);
    leafSum += d;
  }

  const total = Math.max(Number.isFinite(totalMs) ? Math.max(0, totalMs) : 0, leafSum);
  if (total <= 0) return [];

  const segments: TimeBreakdownSegment[] = [];
  for (const cat of LEAF_CATEGORIES) {
    const ms = leafTotals.get(cat.type) ?? 0;
    if (ms > 0) {
      segments.push({ key: cat.type, label: cat.label, ms, percent: (ms / total) * 100 });
    }
  }
  const appMs = Math.max(0, total - leafSum);
  if (appMs > 0.01) {
    segments.push({ key: 'app', label: 'Application', ms: appMs, percent: (appMs / total) * 100 });
  }
  return segments.sort((a, b) => b.ms - a.ms);
}

/** Filters waterfall spans by a free-text query matching type, label, or metadata values. */
export function filterSpansByQuery(spans: Span[], query: string): Span[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return spans;
  return spans.filter((span) => {
    if (span.type.toLowerCase().includes(needle) || span.label.toLowerCase().includes(needle)) return true;
    if (!span.meta) return false;
    return Object.entries(span.meta).some(([k, v]) => k.toLowerCase().includes(needle) || String(v).toLowerCase().includes(needle));
  });
}

/** Formats an exception and its stack frames into a readable plain-text trace for clipboard copy. */
export function formatStackTrace(exceptionClass: string, message: string, frames: { file: string; source: string }[]): string {
  const header = message ? `${exceptionClass}: ${message}` : exceptionClass;
  if (!frames.length) return header;
  return [header, ...frames.map((frame, index) => `#${index} ${frame.file} — ${frame.source}`)].join('\n');
}

/** Returns a compact single-line preview of log context, or null when absent. */
export function inlineLogContext(value: unknown, maxLength = 140): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw || raw === '{}' || raw === '[]') return null;
  const normalized = raw.replace(/\s+/g, ' ');
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

/** Splits a fully-qualified PHP/JS class name into short name and optional namespace. */
export function splitClassName(fqcn: string): { short: string; namespace: string | null } {
  const normalized = fqcn.replace(/^\\+/, '');
  const idx = normalized.lastIndexOf('\\');
  if (idx < 0) return { short: normalized, namespace: null };
  return { short: normalized.slice(idx + 1), namespace: normalized.slice(0, idx) };
}

/** Extracts a concise human-readable title (e.g. "SELECT · orders") from a normalized SQL statement. */
export function sqlSummary(sql: string): string {
  const clean = sql.trim().replace(/\s+/g, ' ');
  const verbMatch = /^(select|insert|update|delete|replace|create|alter|drop|with)\b/i.exec(clean);
  const verb = verbMatch ? verbMatch[1].toUpperCase() : 'SQL';
  const tableMatch = /\b(?:from|into|update|join)\s+[`"]?([A-Za-z0-9_.]+)[`"]?/i.exec(clean);
  return tableMatch ? `${verb} · ${tableMatch[1]}` : `${verb} query`;
}
