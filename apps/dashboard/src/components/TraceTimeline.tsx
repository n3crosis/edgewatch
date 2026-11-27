import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { InputGroup } from '@cloudflare/kumo/components/input-group';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { cn } from '@cloudflare/kumo/utils';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  GitBranchIcon,
  LinkSimpleIcon,
  MagnifyingGlassIcon,
  MonitorIcon,
  WarningOctagonIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type WheelEvent } from 'react';
import Link from './ScopedLink';
import { CopyButton, Empty, HttpMethodText, Sql, StatusCodeText, UtcDate } from './common';
import { SPAN_COLORS, SPAN_ICONS, SPAN_LABELS } from './Waterfall';
import { ms } from '@/lib/format';
import { traceTimeBreakdown } from '@/lib/ui-helpers';
import type { Span, SpanType, TraceSummary } from '@/lib/types';

type StageKey =
  | 'bootstrap'
  | 'before_middleware'
  | 'action'
  | 'render'
  | 'after_middleware'
  | 'sending'
  | 'terminating';

const STAGE_ORDER: { key: StageKey; label: string }[] = [
  { key: 'bootstrap', label: 'Bootstrap' },
  { key: 'before_middleware', label: 'Before Middleware' },
  { key: 'action', label: 'Action' },
  { key: 'render', label: 'Render' },
  { key: 'after_middleware', label: 'After Middleware' },
  { key: 'sending', label: 'Sending' },
  { key: 'terminating', label: 'Terminating' },
];

const BREAKDOWN_COLORS: Record<SpanType | 'app', string> = {
  ...SPAN_COLORS,
  app: 'bg-indigo-500',
};

interface TimelineStage {
  id: string;
  name: string;
  offsetMs: number;
  durationMs: number;
  spans: Span[];
}

function formatRulerTick(msVal: number): string {
  if (msVal >= 60_000) return `${(msVal / 60_000).toFixed(2)}m`;
  if (msVal >= 1_000) return `${(msVal / 1_000).toFixed(2)}s`;
  return `${Math.round(msVal)}ms`;
}

function spanVariant(span: Span): 'error' | 'alert' | 'default' {
  if (span.type === 'exception') return 'error';
  if (span.type === 'outgoing-request' && Number(span.meta?.status ?? 0) >= 500) return 'error';
  if (span.type === 'outgoing-request' && Number(span.meta?.status ?? 0) >= 400) return 'alert';
  if (span.type === 'mail' && Number(span.meta?.failed ?? 0) === 1) return 'error';
  if (span.type === 'query' && span.duration_ms > 100) return 'alert';
  if (span.type === 'cache' && span.duration_ms > 50) return 'alert';
  return 'default';
}

function spanDotClass(span: Span): string {
  const variant = spanVariant(span);
  if (variant === 'error') return 'border-rose-500 bg-rose-500';
  if (variant === 'alert') return 'border-amber-500 bg-transparent';
  switch (span.type) {
    case 'query':
      return 'border-blue-500 bg-transparent';
    case 'outgoing-request':
    case 'queued-job':
      return 'border-emerald-600 bg-transparent';
    case 'cache':
      return 'border-teal-500 bg-transparent';
    default:
      return 'border-neutral-500 bg-transparent dark:border-neutral-600';
  }
}

function spanBarClass(span: Span, isSelected: boolean): string {
  const variant = spanVariant(span);
  if (variant === 'error') {
    return isSelected
      ? 'border-rose-500 bg-rose-500/30 dark:bg-rose-700/50'
      : 'border-rose-200 bg-rose-100 group-hover/bar:border-rose-500 group-hover/bar:bg-rose-200/80 dark:border-rose-700 dark:bg-rose-900/50';
  }
  if (variant === 'alert') {
    return isSelected
      ? 'border-amber-500 bg-amber-500/30 dark:bg-amber-700/50'
      : 'border-amber-300 bg-amber-50 group-hover/bar:border-amber-500 group-hover/bar:bg-amber-100/80 dark:border-amber-700 dark:bg-amber-700/15';
  }
  return isSelected
    ? 'border-blue-400 bg-blue-100 dark:border-blue-400 dark:bg-blue-600/70'
    : 'border-neutral-200 bg-white group-hover/bar:border-blue-500 group-hover/bar:bg-blue-50 dark:border-neutral-700 dark:bg-neutral-800 dark:group-hover/bar:bg-neutral-700';
}

function spanExternalLink(span: Span): string | null {
  if (span.type === 'query' && span.meta?.sql_hash) return `/queries/${span.meta.sql_hash}`;
  if (span.type === 'outgoing-request') {
    try {
      const urlStr = span.label.replace(/^[A-Z]+\s+/, '');
      const host = new URL(urlStr).hostname;
      if (host) return `/outgoing-requests/${encodeURIComponent(host)}`;
    } catch {
      /* ignore */
    }
  }
  if (span.type === 'mail' && span.label) return `/mail/${encodeURIComponent(span.label)}`;
  if (span.type === 'queued-job') {
    const name = span.label.replace(/^queued\s+/i, '');
    if (name) return `/jobs/${encodeURIComponent(name)}`;
  }
  return null;
}

/** Builds Nightwatch-style Laravel lifecycle stages from the root record + child spans. */
function buildStages(
  trace: TraceSummary,
  rootRecord: Record<string, unknown> | undefined,
  childSpans: Span[],
  totalMs: number,
): TimelineStage[] {
  const stageTimingEntries: { key: StageKey; label: string; durationMs: number; offsetMs: number }[] = [];
  if (rootRecord) {
    let cursor = 0;
    for (const s of STAGE_ORDER) {
      const raw = rootRecord[s.key];
      if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        const durMs = raw > 1000 ? raw / 1000 : raw; // Nightwatch root timings are microseconds
        stageTimingEntries.push({ key: s.key, label: s.label, durationMs: durMs, offsetMs: cursor });
        cursor += durMs;
      }
    }
  }

  // If the root record carries explicit lifecycle timings, slot child spans into matching stages
  if (stageTimingEntries.length > 0) {
    const stages: TimelineStage[] = stageTimingEntries.map((st) => ({
      id: st.key,
      name: st.label,
      offsetMs: st.offsetMs,
      durationMs: st.durationMs,
      spans: [],
    }));
    const findStageForSpan = (span: Span): TimelineStage => {
      const explicit = typeof span.meta?.execution_stage === 'string' ? span.meta.execution_stage : null;
      if (explicit) {
        const hit = stages.find((st) => st.id === explicit);
        if (hit) return hit;
      }
      const hitByTime = stages.find((st) => span.start_ms >= st.offsetMs && span.start_ms <= st.offsetMs + st.durationMs);
      return hitByTime ?? stages.find((st) => st.id === 'action') ?? stages[stages.length - 1];
    };
    for (const span of childSpans) {
      findStageForSpan(span).spans.push(span);
    }
    return stages;
  }

  // Otherwise derive stages cleanly from middleware/controller spans or a single Action stage
  const middlewareSpan = childSpans.find((s) => s.type === 'middleware');
  const controllerSpan = childSpans.find((s) => s.type === 'controller');
  const leafSpans = childSpans.filter((s) => s.type !== 'middleware' && s.type !== 'controller');

  if (middlewareSpan || controllerSpan) {
    const stages: TimelineStage[] = [];
    if (middlewareSpan) {
      stages.push({
        id: 'before_middleware',
        name: 'Before Middleware',
        offsetMs: middlewareSpan.start_ms,
        durationMs: middlewareSpan.duration_ms,
        spans: leafSpans.filter((s) => s.start_ms < (controllerSpan?.start_ms ?? middlewareSpan.start_ms + middlewareSpan.duration_ms)),
      });
    }
    const actionStart = controllerSpan?.start_ms ?? (middlewareSpan ? middlewareSpan.start_ms + middlewareSpan.duration_ms : 0);
    const actionDur = controllerSpan?.duration_ms ?? Math.max(0, totalMs - actionStart);
    stages.push({
      id: 'action',
      name: trace.execution_source === 'request' ? 'Action' : 'Execution',
      offsetMs: actionStart,
      durationMs: actionDur,
      spans: middlewareSpan
        ? leafSpans.filter((s) => s.start_ms >= actionStart)
        : leafSpans,
    });
    return stages;
  }

  return [
    {
      id: 'action',
      name: trace.execution_source === 'request' ? 'Action' : 'Execution',
      offsetMs: 0,
      durationMs: totalMs,
      spans: leafSpans,
    },
  ];
}

/** Inline Nightwatch `360px` right-side Span Details panel (`Z` / `Q` / `yt` / `vt` in `pretty-bytes-DviNQNl5.js`). */
function InlineSpanPanel({
  span,
  spans,
  traceTimestamp,
  onSelect,
  onClose,
}: {
  span: Span;
  spans: Span[];
  traceTimestamp: string;
  onSelect: (span: Span) => void;
  onClose: () => void;
}) {
  const index = spans.findIndex((s) => s.id === span.id);
  const prevSpan = index > 0 ? spans[index - 1] : null;
  const nextSpan = index >= 0 && index < spans.length - 1 ? spans[index + 1] : null;
  const externalHref = spanExternalLink(span);
  const spanIso = useMemo(() => {
    const base = Date.parse(traceTimestamp);
    if (!Number.isFinite(base)) return traceTimestamp;
    return new Date(base + span.start_ms).toISOString();
  }, [traceTimestamp, span.start_ms]);
  const [copiedLink, setCopiedLink] = useState(false);

  const copyPermalink = () => {
    const url = `${window.location.href.split('#')[0]}#span-${span.id}`;
    navigator.clipboard?.writeText(url).catch(() => {});
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 1500);
  };

  return (
    <aside
      aria-label={`${SPAN_LABELS[span.type]} details`}
      className="absolute top-0 right-0 z-50 flex h-full w-[360px] max-w-[90%] shrink-0 flex-col border-l border-neutral-300 bg-white/95 shadow-xl backdrop-blur-xl select-text dark:border-neutral-700/60 dark:bg-neutral-900/95"
    >
      <div className="flex items-center justify-between gap-2 border-b border-neutral-200 p-4 dark:border-neutral-700/60">
        <div className="flex min-w-0 flex-col items-start gap-1 font-mono">
          <div className="text-xs font-semibold uppercase text-neutral-900 dark:text-white">
            {SPAN_LABELS[span.type]}
          </div>
          <UtcDate iso={spanIso} className="text-xs text-neutral-500 dark:text-neutral-400" />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip asChild content={copiedLink ? 'Link copied' : 'Copy link to span'}>
            <button
              type="button"
              onClick={copyPermalink}
              aria-label="Copy link to span"
              className="grid size-7 place-items-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-white"
            >
              <LinkSimpleIcon size={15} aria-hidden />
            </button>
          </Tooltip>
          {externalHref && (
            <Tooltip asChild content="Open resource">
              <Link
                to={externalHref}
                aria-label="Open resource"
                className="grid size-7 place-items-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-white"
              >
                <ArrowSquareOutIcon size={15} aria-hidden />
              </Link>
            </Tooltip>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close span details"
            className="ml-1 grid size-7 place-items-center rounded-md border border-neutral-200 bg-white text-neutral-600 transition-colors hover:border-neutral-300 hover:text-neutral-900 dark:border-white/10 dark:bg-white/[0.04] dark:text-neutral-300 dark:hover:text-white"
          >
            <XIcon size={14} aria-hidden />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 divide-y divide-neutral-200 overflow-y-auto text-sm dark:divide-neutral-800">
        <div className="space-y-2 px-4 py-3.5">
          <div className="flex items-center justify-between">
            <span className="text-neutral-500 dark:text-neutral-400">
              {span.type === 'query' ? 'SQL' : span.type === 'outgoing-request' ? 'URL' : 'Details'}
            </span>
            <CopyButton text={span.label} label="Copy details" />
          </div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md border border-neutral-200 bg-neutral-50 p-3 font-mono text-xs leading-relaxed dark:border-white/[0.06] dark:bg-white/[0.03]">
            {span.type === 'query' ? <Sql sql={span.label} /> : span.label}
          </pre>
        </div>

        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <span className="text-neutral-500 dark:text-neutral-400">Duration</span>
          <span className="font-mono text-xs font-medium tabular-nums text-neutral-900 dark:text-white">
            {ms(span.duration_ms)}
          </span>
        </div>

        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <span className="text-neutral-500 dark:text-neutral-400">Offset</span>
          <span className="font-mono text-xs tabular-nums text-neutral-700 dark:text-neutral-300">
            +{ms(span.start_ms)}
          </span>
        </div>

        {Object.entries(span.meta ?? {}).map(([k, v]) => {
          if (v === '' || v === null || v === undefined) return null;
          return (
            <div key={k} className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="capitalize text-neutral-500 dark:text-neutral-400">{k.replace(/_/g, ' ')}</span>
              <span className="truncate text-right font-mono text-xs text-neutral-900 dark:text-neutral-100">
                {k === 'sql_hash' ? (
                  <Link className="text-blue-600 hover:underline dark:text-emerald-400" to={`/queries/${v}`}>
                    {String(v)}
                  </Link>
                ) : k === 'status' ? (
                  <StatusCodeText status={Number(v)} />
                ) : k === 'method' ? (
                  <HttpMethodText method={String(v)} />
                ) : (
                  String(v)
                )}
              </span>
            </div>
          );
        })}
      </div>

      {spans.length > 1 && index >= 0 && (
        <div className="flex shrink-0 items-center justify-between border-t border-neutral-200 bg-neutral-50/80 px-4 py-2.5 dark:border-neutral-800 dark:bg-neutral-900">
          <span className="font-mono text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
            {index + 1} / {spans.length}
          </span>
          <div className="flex items-center gap-1.5">
            <Button variant="secondary" size="xs" icon={CaretLeftIcon} disabled={!prevSpan} onClick={() => prevSpan && onSelect(prevSpan)}>
              Prev
            </Button>
            <Button variant="secondary" size="xs" disabled={!nextSpan} onClick={() => nextSpan && onSelect(nextSpan)}>
              Next
              <CaretRightIcon />
            </Button>
          </div>
        </div>
      )}
    </aside>
  );
}

/**
 * 1:1 Nightwatch `St` Interactive Timeline (`pretty-bytes-DviNQNl5.js`):
 * - Sticky header with `Timeline` title + Zoom slider (`Ctrl/Cmd + wheel` zoom) + synced horizontal time ruler
 * - Collapsible Execution → Lifecycle Stages → Spans left sidebar tree
 * - Drag-to-pan right canvas with live vertical hover crosshair + floating timestamp badge
 * - Bordered span bars with sticky inline labels + offscreen left/right jump buttons
 * - Inline 360px right-side Span Details panel with keyboard navigation (`←` / `→` / `Escape`)
 */
export default function TraceTimeline({
  trace,
  rootRecord,
  allSpans,
  visibleSpans,
  eventType,
  spanQuery,
  onSpanQueryChange,
  onEventTypeChange,
  selected,
  onSelect,
  onClearSelection,
  missingSpanNotice,
}: {
  trace: TraceSummary;
  rootRecord?: Record<string, unknown>;
  allSpans: Span[];
  visibleSpans: Span[];
  eventType: SpanType | null;
  spanQuery: string;
  onSpanQueryChange: (q: string) => void;
  onEventTypeChange: (type: SpanType | null) => void;
  selected: Span | null;
  onSelect: (span: Span) => void;
  onClearSelection: () => void;
  missingSpanNotice?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(800);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [zoom, setZoom] = useState(1); // 1x = fits 100%, up to 8x zoomed in
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [dragging, setDragging] = useState<{ startX: number; startScroll: number } | null>(null);
  const [execExpanded, setExecExpanded] = useState(true);

  const childSpans = useMemo(
    () => visibleSpans.filter((s) => s.type !== 'request' && s.type !== 'job'),
    [visibleSpans],
  );

  const totalMs = useMemo(() => {
    const maxSpanEnd = allSpans.reduce((acc, s) => Math.max(acc, s.start_ms + s.duration_ms), 0);
    return Math.max(trace.duration_ms || 0, maxSpanEnd, 1);
  }, [trace.duration_ms, allSpans]);

  const stages = useMemo(
    () => buildStages(trace, rootRecord, childSpans, totalMs),
    [trace, rootRecord, childSpans, totalMs],
  );

  const selectableSpans = useMemo(
    () => stages.flatMap((st) => st.spans),
    [stages],
  );

  const spanBreakdown = useMemo(() => {
    const counts = new Map<SpanType, { count: number; totalMs: number }>();
    for (const span of allSpans) {
      if (span.type === 'request' || span.type === 'job') continue;
      const entry = counts.get(span.type) ?? { count: 0, totalMs: 0 };
      entry.count++;
      entry.totalMs += span.duration_ms;
      counts.set(span.type, entry);
    }
    return [...counts.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs || b[1].count - a[1].count);
  }, [allSpans]);

  const timeShare = useMemo(
    () => traceTimeBreakdown(allSpans, trace.duration_ms),
    [allSpans, trace.duration_ms],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const updateWidth = () => {
      const w = el.clientWidth;
      if (w > 0) setCanvasWidth(w);
    };
    updateWidth();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(updateWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keyboard navigation (`Escape`, `ArrowLeft`, `ArrowRight`) when a span is selected
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      const idx = selectableSpans.findIndex((s) => s.id === selected.id);
      if (e.key === 'Escape') {
        e.preventDefault();
        onClearSelection();
      } else if (e.key === 'ArrowLeft' && idx > 0) {
        e.preventDefault();
        onSelect(selectableSpans[idx - 1]);
      } else if (e.key === 'ArrowRight' && idx >= 0 && idx < selectableSpans.length - 1) {
        e.preventDefault();
        onSelect(selectableSpans[idx + 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, selectableSpans, onSelect, onClearSelection]);

  const contentWidth = Math.max(canvasWidth, Math.round(canvasWidth * zoom));
  const msPerPixel = (totalMs * 1.12) / Math.max(1, contentWidth);

  const rulerTicks = useMemo(() => {
    const targetTicks = Math.max(4, Math.floor(contentWidth / 95));
    const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 30000, 60000];
    const totalRange = totalMs * 1.12;
    const step = steps.find((s) => totalRange / s <= targetTicks) ?? steps[steps.length - 1];
    const count = Math.ceil(totalRange / step);
    return Array.from({ length: count + 1 }, (_, i) => ({
      ms: i * step,
      leftPx: (i * step) / msPerPixel,
      label: formatRulerTick(i * step),
    }));
  }, [contentWidth, totalMs, msPerPixel]);

  const scrollToOffset = useCallback(
    (offsetMs: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const targetLeft = Math.max(0, offsetMs / msPerPixel - 24);
      el.scrollTo({ left: targetLeft, behavior: 'smooth' });
    },
    [msPerPixel],
  );

  const onCanvasMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setHoverX(el.scrollLeft + e.clientX - rect.left);
    if (dragging) {
      el.scrollLeft = dragging.startScroll - (e.clientX - dragging.startX);
      setScrollLeft(el.scrollLeft);
    }
  };

  const onCanvasMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !scrollRef.current) return;
    // Ignore clicks on buttons/links inside bars
    if ((e.target as HTMLElement).closest('button, a')) return;
    setDragging({ startX: e.clientX, startScroll: scrollRef.current.scrollLeft });
  };

  const onCanvasWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (!e.metaKey && !e.ctrlKey) return;
    e.preventDefault();
    setZoom((prev) => Math.min(8, Math.max(1, Number((prev + (e.deltaY < 0 ? 0.35 : -0.35)).toFixed(2)))));
  };

  const execStatusVariant: 'success' | 'error' | 'alert' =
    Number(trace.status_code ?? 0) >= 500 || trace.status === 'failed'
      ? 'error'
      : Number(trace.status_code ?? 0) >= 400 || trace.status === 'released'
        ? 'alert'
        : 'success';

  const execBarTone =
    execStatusVariant === 'error'
      ? 'border-rose-500 bg-rose-500/15 dark:border-rose-700 dark:bg-rose-700/20'
      : execStatusVariant === 'alert'
        ? 'border-amber-500 bg-amber-500/15 dark:border-amber-700 dark:bg-amber-700/20'
        : 'border-emerald-500 bg-emerald-500/15 dark:border-emerald-700 dark:bg-emerald-700/20';

  const execTypeLabel =
    trace.execution_source === 'job'
      ? 'JOB'
      : trace.execution_source === 'command'
        ? 'COMMAND'
        : trace.execution_source === 'schedule'
          ? 'TASK'
          : 'REQUEST';

  return (
    <div className="space-y-3">
      {/* Desktop-first Nightwatch Timeline Card (`St` in `pretty-bytes-DviNQNl5.js`) */}
      <div className="flex flex-col items-center gap-2 rounded-lg border border-neutral-200 bg-white px-4 py-6 text-center text-neutral-500 md:hidden dark:border-neutral-800 dark:bg-white/[0.02]">
        <MonitorIcon size={28} className="text-neutral-400" aria-hidden />
        <div className="text-sm">Desktop width recommended for full interactive timeline</div>
      </div>

      <div className="relative w-full overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-md shadow-black/[0.04] dark:border-neutral-800 dark:bg-neutral-900">
        {/* Top Breakdown & Filter Controls */}
        {timeShare.length > 0 && (
          <div className="border-b border-neutral-200/80 px-5 py-3.5 dark:border-neutral-800">
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-white/10">
              {timeShare.map((segment) => (
                <Tooltip key={segment.key} asChild content={`${segment.label}: ${ms(segment.ms)} (${segment.percent.toFixed(1)}%)`}>
                  <div
                    className={cn('h-full transition-opacity hover:opacity-85', BREAKDOWN_COLORS[segment.key])}
                    style={{ width: `${Math.max(1.5, segment.percent)}%` }}
                  />
                </Tooltip>
              ))}
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
              {timeShare.map((segment) => (
                <span key={segment.key} className="inline-flex items-center gap-1.5">
                  <span className={cn('size-2 rounded-full', BREAKDOWN_COLORS[segment.key])} />
                  <span>{segment.label}</span>
                  <span className="font-mono tabular-nums text-neutral-800 dark:text-neutral-200">{ms(segment.ms)}</span>
                  <span className="tabular-nums">({segment.percent.toFixed(0)}%)</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Filter bar: span type pills + search box */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 bg-neutral-50/70 px-4 py-2.5 dark:border-neutral-800 dark:bg-white/[0.02]">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter spans by type">
            <button
              type="button"
              aria-pressed={!eventType}
              onClick={() => onEventTypeChange(null)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors',
                !eventType
                  ? 'border-neutral-200 bg-white font-medium text-neutral-900 shadow-2xs dark:border-white/15 dark:bg-white/[0.08] dark:text-white'
                  : 'border-transparent text-neutral-500 hover:bg-white/60 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/[0.04] dark:hover:text-white',
              )}
            >
              <span>All</span>
              <span className="font-mono text-[11px] opacity-70">{allSpans.filter((s) => s.type !== 'request' && s.type !== 'job').length}</span>
            </button>
            {spanBreakdown.map(([type, stats]) => {
              const active = eventType === type;
              const SpanIcon = SPAN_ICONS[type];
              return (
                <button
                  key={type}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onEventTypeChange(active ? null : type)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors',
                    active
                      ? 'border-neutral-200 bg-white font-medium text-neutral-900 shadow-2xs dark:border-white/15 dark:bg-white/[0.08] dark:text-white'
                      : 'border-transparent text-neutral-500 hover:bg-white/60 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/[0.04] dark:hover:text-white',
                  )}
                >
                  <span className={cn('size-2 rounded-full', SPAN_COLORS[type])} />
                  <SpanIcon size={12} className="shrink-0" />
                  <span>{SPAN_LABELS[type]}</span>
                  <span className="font-mono text-[11px] opacity-70">
                    {stats.count}
                    {stats.totalMs > 0 ? ` · ${ms(stats.totalMs)}` : ''}
                  </span>
                </button>
              );
            })}
          </div>

          <InputGroup className="h-8 w-48 bg-white sm:w-56 dark:bg-white/[0.03]">
            <InputGroup.Addon align="start">
              <MagnifyingGlassIcon size={13} className="text-neutral-400" />
            </InputGroup.Addon>
            <InputGroup.Input
              value={spanQuery}
              onChange={(e) => onSpanQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && spanQuery) onSpanQueryChange('');
              }}
              placeholder="Filter spans…"
              aria-label="Filter spans"
              className="h-8 text-xs"
            />
            {spanQuery && (
              <InputGroup.Addon align="end">
                <button
                  type="button"
                  onClick={() => onSpanQueryChange('')}
                  aria-label="Clear span search"
                  className="grid size-4 place-items-center rounded text-neutral-400 hover:text-neutral-900 dark:hover:text-white"
                >
                  <XIcon size={11} />
                </button>
              </InputGroup.Addon>
            )}
          </InputGroup>
        </div>

        {/* Sticky Timeline Header: Left ("Timeline" + Zoom Slider) | Right (Time Ruler) */}
        <header className="sticky top-0 z-20 flex h-11 divide-x divide-neutral-200 border-b border-neutral-200 bg-white/95 backdrop-blur-sm dark:divide-neutral-800 dark:border-neutral-800 dark:bg-neutral-900/95">
          <div className="flex h-full w-1/4 min-w-[200px] max-w-[260px] shrink-0 items-center justify-between gap-3 px-4">
            <span className="text-sm font-semibold text-neutral-900 dark:text-white">Timeline</span>
            <label className="flex items-center gap-2" title={`Zoom ${zoom.toFixed(1)}× (Ctrl/Cmd + scroll)`}>
              <span className="sr-only">Timeline zoom</span>
              <input
                type="range"
                min={1}
                max={8}
                step={0.1}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="h-1.5 w-20 cursor-pointer accent-blue-600 dark:accent-white"
              />
            </label>
          </div>
          <div className="relative flex h-full flex-1 items-center overflow-hidden pl-2 [mask-image:linear-gradient(to_right,transparent,black_0%,black_92%,transparent)]">
            <div
              className="relative flex h-full w-full items-center font-mono text-xs/none"
              style={{ transform: `translateX(-${scrollLeft}px)` }}
            >
              {rulerTicks.map((tick) => (
                <div
                  key={tick.ms}
                  className="absolute flex -translate-x-1/2 flex-col items-center text-neutral-500 first:translate-x-0 dark:text-neutral-500"
                  style={{ left: tick.leftPx }}
                >
                  <span>{tick.label}</span>
                  <span className="mt-1.5 h-2 w-px bg-neutral-200 dark:bg-neutral-800" aria-hidden />
                </div>
              ))}
            </div>
          </div>
        </header>

        {missingSpanNotice && (
          <div
            role="status"
            className="flex items-center justify-between gap-3 border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-white/[0.03] dark:text-neutral-400"
          >
            <span>This event is no longer available in the stored trace.</span>
            <Button variant="ghost" size="xs" onClick={onClearSelection}>
              Dismiss
            </Button>
          </div>
        )}

        {/* 2-Column Body: Left Collapsible Tree | Right Pannable Canvas + Inline Span Panel */}
        <section className="relative flex min-h-[380px] items-stretch divide-x divide-neutral-200 font-mono text-xs select-none dark:divide-neutral-800">
          {/* Left Execution → Stages → Spans Tree */}
          <div className="w-1/4 min-w-[200px] max-w-[260px] shrink-0 overflow-hidden whitespace-nowrap py-1">
            {/* Execution root row */}
            <button
              type="button"
              onClick={() => setExecExpanded((prev) => !prev)}
              className="flex h-9 w-full items-center gap-2 pl-3 pr-2 text-left transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800/50"
            >
              <CaretDownIcon
                size={13}
                className={cn('shrink-0 text-neutral-500 transition-transform duration-150', !execExpanded && '-rotate-90')}
                aria-hidden
              />
              {execStatusVariant === 'error' && <WarningOctagonIcon size={12} weight="fill" className="shrink-0 text-rose-500" aria-hidden />}
              {execStatusVariant === 'alert' && <WarningIcon size={12} weight="fill" className="shrink-0 text-amber-500" aria-hidden />}
              <span className="font-semibold uppercase text-neutral-900 dark:text-white">{execTypeLabel}</span>
              <span className="truncate text-neutral-500">{trace.name}</span>
            </button>

            {execExpanded &&
              stages.map((stage) => (
                <div key={stage.id} className="ml-4 border-l border-neutral-200 dark:border-neutral-800">
                  <div className="flex h-9 items-center gap-2 pl-3 pr-2 text-neutral-700 dark:text-neutral-300">
                    <span className="uppercase">{stage.name}</span>
                    <span className="text-neutral-400 dark:text-neutral-500">{ms(stage.durationMs)}</span>
                  </div>
                  {stage.spans.length > 0 && (
                    <div className="ml-3 border-l border-neutral-200 pl-1 dark:border-neutral-800">
                      {stage.spans.map((span) => {
                        const isSelected = selected?.id === span.id;
                        const variant = spanVariant(span);
                        return (
                          <Tooltip key={span.id} asChild side="left" content={<span className="block max-w-xs break-words font-mono text-xs">{span.label}</span>}>
                            <button
                              type="button"
                              id={`span-${span.id}`}
                              onClick={() => {
                                onSelect(span);
                                scrollToOffset(span.start_ms);
                              }}
                              className={cn(
                                'flex h-9 w-full items-center gap-2.5 rounded-l-md px-2.5 text-left transition-colors',
                                isSelected
                                  ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
                                  : 'hover:bg-neutral-100 dark:hover:bg-neutral-800/50',
                              )}
                            >
                              <span className={cn('size-2 shrink-0 rounded-full border', spanDotClass(span))} />
                              <span
                                className={cn(
                                  'shrink-0 uppercase',
                                  variant === 'error'
                                    ? 'text-rose-600 dark:text-rose-400'
                                    : variant === 'alert'
                                      ? 'text-amber-600 dark:text-amber-400'
                                      : 'text-neutral-800 dark:text-neutral-200',
                                )}
                              >
                                {SPAN_LABELS[span.type]}
                              </span>
                              <span className="truncate text-neutral-400 dark:text-neutral-500">{span.label}</span>
                            </button>
                          </Tooltip>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
          </div>

          {/* Right Pannable Timeline Canvas */}
          <div
            ref={scrollRef}
            role="application"
            aria-label="Execution timeline"
            onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
            onMouseMove={onCanvasMouseMove}
            onMouseDown={onCanvasMouseDown}
            onMouseUp={() => setDragging(null)}
            onMouseLeave={() => {
              setHoverX(null);
              setDragging(null);
            }}
            onWheel={onCanvasWheel}
            style={{ cursor: dragging ? 'grabbing' : 'grab' }}
            className="relative flex-1 overflow-x-auto bg-neutral-50/70 dark:bg-transparent"
          >
            <div className="relative min-h-full py-1" style={{ width: contentWidth + 16 }}>
              {/* Vertical ruler gridlines aligned with px-2 bar origin */}
              <div className="pointer-events-none absolute inset-y-0 right-2 left-2" aria-hidden>
                {rulerTicks.map((tick) => (
                  <div
                    key={tick.ms}
                    className="absolute inset-y-0 border-l border-neutral-200/70 dark:border-white/[0.04]"
                    style={{ left: tick.leftPx }}
                  />
                ))}
              </div>

              {/* Execution Root Bar */}
              <div className="relative flex h-9 items-center px-2">
                <div
                  className={cn(
                    'flex h-8 items-center gap-2 overflow-hidden rounded-md border px-2.5 whitespace-nowrap',
                    execBarTone,
                  )}
                  style={{ width: Math.max(8, totalMs / msPerPixel) }}
                >
                  <span className="font-semibold uppercase text-neutral-900 dark:text-white">{execTypeLabel}</span>
                  {trace.status_code !== null && (
                    <Badge variant={execStatusVariant === 'error' ? 'error' : execStatusVariant === 'alert' ? 'warning' : 'success'}>
                      {trace.status_code}
                    </Badge>
                  )}
                  <span className="text-neutral-600 dark:text-neutral-300">{ms(totalMs)}</span>
                  <span className="truncate text-neutral-500 dark:text-neutral-400">{trace.name}</span>
                </div>
              </div>

              {/* Stage Bars + Span Bars */}
              {execExpanded &&
                stages.map((stage) => {
                  const stageLeft = Math.max(0, stage.offsetMs / msPerPixel);
                  const stageWidth = Math.max(6, stage.durationMs / msPerPixel);
                  return (
                    <div key={stage.id} className="relative">
                      {/* Stage bar */}
                      <div className="relative flex h-9 items-center px-2">
                        <div
                          className="flex h-8 items-center gap-2 overflow-hidden rounded-md border border-neutral-200 bg-white/90 px-2.5 whitespace-nowrap backdrop-blur-xs dark:border-neutral-700 dark:bg-neutral-800/80"
                          style={{ marginLeft: stageLeft, width: stageWidth }}
                        >
                          <span className="uppercase text-neutral-800 dark:text-neutral-200">{stage.name}</span>
                          <span className="text-neutral-500 dark:text-neutral-400">{ms(stage.durationMs)}</span>
                        </div>
                      </div>

                      {/* Span bars under stage */}
                      {stage.spans.map((span) => {
                        const leftPx = Math.max(0, span.start_ms / msPerPixel);
                        const widthPx = Math.max(span.type === 'exception' ? 12 : 6, span.duration_ms / msPerPixel);
                        const isSelected = selected?.id === span.id;
                        const isOffLeft = leftPx + widthPx < scrollLeft;
                        const isOffRight = leftPx > scrollLeft + canvasWidth;
                        return (
                          <div key={span.id} className="group/bar relative flex h-9 items-center px-2">
                            {isOffLeft && (
                              <div className="sticky left-2 z-30 w-0 overflow-visible">
                                <button
                                  type="button"
                                  onClick={() => scrollToOffset(span.start_ms)}
                                  aria-label={`Jump to ${span.label}`}
                                  className="absolute top-1/2 -translate-y-1/2 flex size-6 items-center justify-center rounded-md border border-neutral-300 bg-white/80 text-neutral-700 shadow-xs backdrop-blur-xs hover:bg-neutral-200 dark:border-white/15 dark:bg-neutral-800/80 dark:text-white"
                                >
                                  <ArrowLeftIcon size={13} />
                                </button>
                              </div>
                            )}

                            <button
                              type="button"
                              onClick={() => onSelect(span)}
                              style={{ marginLeft: leftPx }}
                              className="relative flex h-8 items-center text-left focus-visible:outline-2 focus-visible:outline-blue-500"
                            >
                              <span
                                className={cn(
                                  'absolute inset-y-0 left-0 rounded-md border transition-colors',
                                  spanBarClass(span, isSelected),
                                )}
                                style={{ width: widthPx }}
                              />
                              <span className="relative z-10 flex items-center gap-2 whitespace-nowrap px-2">
                                <span className="font-medium uppercase text-neutral-900 dark:text-neutral-100">
                                  {SPAN_LABELS[span.type]}
                                </span>
                                {span.duration_ms > 0 && (
                                  <span className="text-neutral-600 dark:text-neutral-300">{ms(span.duration_ms)}</span>
                                )}
                                <span className="max-w-md truncate text-neutral-500 dark:text-neutral-400">
                                  {span.label}
                                </span>
                              </span>
                            </button>

                            {isOffRight && (
                              <button
                                type="button"
                                onClick={() => scrollToOffset(span.start_ms)}
                                aria-label={`Jump to ${span.label}`}
                                className={cn(
                                  'sticky right-2 z-30 ml-auto flex size-6 items-center justify-center rounded-md border border-neutral-300 bg-white/80 text-neutral-700 shadow-xs backdrop-blur-xs hover:bg-neutral-200 dark:border-white/15 dark:bg-neutral-800/80 dark:text-white',
                                  selected && 'right-[372px]',
                                )}
                              >
                                <ArrowRightIcon size={13} />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}

              {selectableSpans.length === 0 && (
                <div className="px-4 py-12">
                  <Empty
                    variant="clean"
                    icon={<GitBranchIcon size={24} className="text-neutral-400" />}
                    action={
                      eventType || spanQuery ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            onSpanQueryChange('');
                            onEventTypeChange(null);
                          }}
                        >
                          Reset span filters
                        </Button>
                      ) : undefined
                    }
                  >
                    {eventType || spanQuery ? 'No spans match these filters.' : 'No child spans recorded for this trace.'}
                  </Empty>
                </div>
              )}

              {/* Live vertical hover crosshair + floating timestamp badge (exact Nightwatch `St`) */}
              {hoverX !== null && hoverX >= 0 && (
                <div
                  className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-blue-600 dark:bg-amber-500"
                  style={{ left: hoverX }}
                  aria-hidden
                >
                  <div className="sticky top-0 left-0 inline-block rounded-tr rounded-br bg-blue-600 px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap text-white shadow-xs dark:bg-amber-500/90 dark:text-neutral-950">
                    {formatRulerTick(Math.max(0, (hoverX - 8) * msPerPixel))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Inline 360px Nightwatch Span Details Panel */}
          {selected && (
            <InlineSpanPanel
              span={selected}
              spans={selectableSpans}
              traceTimestamp={trace.timestamp}
              onSelect={onSelect}
              onClose={onClearSelection}
            />
          )}
        </section>
      </div>
    </div>
  );
}
