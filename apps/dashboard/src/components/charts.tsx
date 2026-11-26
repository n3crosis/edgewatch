import { cn } from '@cloudflare/kumo/utils';
import { timeWindow } from '@edgewatch/shared/time-window';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { ms } from '@/lib/format';
import { useLocalPreferences } from '@/lib/preferences';
import { useRange } from '@/lib/range';
import type { Range } from '@/lib/types';

const nice = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${Math.round(n)}`);

export type MetricPillTone = 'neutral' | 'alert' | 'error' | 'blue' | 'success' | 'charcoal';
export type SeriesKey = 'base' | 'extra' | 'warn' | 'highlight' | 'avg' | 'p95';

const PILL_TONES: Record<MetricPillTone, string> = {
  neutral: 'bg-[var(--chart-bar-neutral)]',
  charcoal: 'bg-[var(--chart-area-neutral-line)]',
  alert: 'bg-[var(--chart-bar-alert)]',
  error: 'bg-[var(--chart-bar-error)]',
  blue: 'bg-[var(--chart-bar-blue)]',
  success: 'bg-[hsl(var(--chart-6))]',
};

export interface MetricLegendItem {
  label: string;
  value: ReactNode;
  tone: MetricPillTone;
  seriesKey?: SeriesKey;
}

export interface BarDatum {
  label: string;
  ts?: number;
  value: number;
  extra?: number;
  warn?: number;
  highlight?: number;
}

function inferSeriesKey(metric: MetricLegendItem): SeriesKey {
  if (metric.seriesKey) return metric.seriesKey;
  const upper = metric.label.toUpperCase();
  if (upper === 'AVG' || metric.tone === 'charcoal') return 'avg';
  if (upper === 'P95') return 'p95';
  if (metric.tone === 'error') return 'highlight';
  if (metric.tone === 'alert') return 'warn';
  if (metric.tone === 'blue') return 'extra';
  return 'base';
}

/* -------------------------------------------------------------------------- */
/* Cross-chart Hover Sync Context (1:1 Nightwatch Recharts `syncId` behavior) */
/* -------------------------------------------------------------------------- */

interface ChartSyncState {
  hoveredIndex: number | null;
  sourceId: string | null;
  setHover: (index: number | null, sourceId: string | null) => void;
}

const ChartSyncContext = createContext<ChartSyncState>({
  hoveredIndex: null,
  sourceId: null,
  setHover: () => {},
});

export function ChartSyncProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ hoveredIndex: number | null; sourceId: string | null }>({
    hoveredIndex: null,
    sourceId: null,
  });
  const setHover = (hoveredIndex: number | null, sourceId: string | null) => {
    setState((prev) =>
      prev.hoveredIndex === hoveredIndex && prev.sourceId === sourceId ? prev : { hoveredIndex, sourceId },
    );
  };
  return (
    <ChartSyncContext.Provider value={{ hoveredIndex: state.hoveredIndex, sourceId: state.sourceId, setHover }}>
      {children}
    </ChartSyncContext.Provider>
  );
}

/* -------------------------------------------------------------------------- */
/* Per-Card Interactive Legend Context (click legend items to toggle series)  */
/* -------------------------------------------------------------------------- */

interface ChartCardContextState {
  hidden: Partial<Record<SeriesKey, boolean>>;
  labels: Partial<Record<SeriesKey, string>>;
}

const ChartCardContext = createContext<ChartCardContextState>({
  hidden: {},
  labels: {},
});

/** Measures a chart container's exact CSS pixel width so SVG coordinates are 1:1 (no squished circles!). */
function useContainerWidth(defaultWidth = 513): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(defaultWidth);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const next = Math.round(el.getBoundingClientRect().width);
      if (next > 0) setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
}

/** Short browser timezone label (e.g. "PST", "UTC+8") when showing local timestamps. */
export function localTzLabel(): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? 'LOCAL';
  } catch {
    return 'LOCAL';
  }
}

/** Formats a UTC or local timestamp matching Nightwatch chart footers: `26 Nov 2026, 05:32:07`. */
export function chartFooterDate(ts: number | string, showUtc = true): string {
  return new Date(ts).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: showUtc ? 'UTC' : undefined,
  });
}

/** Formats an ISO-style UTC log timestamp: `2026-11-26 06:32:07`. */
export function isoUtcTimestamp(ts: number | string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/** Formats a duration min-max headline exactly like Nightwatch (`30ms - 1.12s`, or `84ms` if equal). */
export function durationRangeLabel(values: (number | null | undefined)[]): string {
  const positive = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (!positive.length) return '—';
  const min = Math.min(...positive);
  const max = Math.max(...positive);
  if (Math.abs(max - min) < 1) return ms(max);
  return `${ms(min)} - ${ms(max)}`;
}

/** Returns start and end formatted timestamps for the active Range. */
export function rangeFooterBounds(range: Range): [string, string] | null {
  const win = timeWindow(range);
  if (!win) return null;
  return [chartFooterDate(win.since), chartFooterDate(win.now)];
}

/**
 * Buckets timestamped items onto the real chronological `timeWindow(range)` axis.
 * Empty buckets have `value: 0` for bar charts and `null` for line charts so charts
 * align 1:1 with the UTC start/end footer timestamps and never drop lines to zero.
 */
export function bucketTimeSeries<T>(
  items: T[],
  range: Range,
  opts: {
    timestamp: (item: T) => string | number | null | undefined;
    value?: (item: T) => number;
    extra?: (item: T) => number;
    warn?: (item: T) => number;
    highlight?: (item: T) => number;
    p95?: (item: T) => number | null | undefined;
    avg?: (item: T) => number | null | undefined;
    buckets?: number;
  },
): {
  barSeries: BarDatum[];
  p95Values: (number | null)[];
  avgValues: (number | null)[];
  labels: string[];
  timestamps: number[];
} {
  const count = opts.buckets ?? 48;
  const win = timeWindow(range);
  const now = win?.now ?? Date.now();
  const since = win?.since ?? now - 24 * 3600e3;
  const span = Math.max(1, now - since);
  const bucketWidth = span / count;

  const buckets = Array.from({ length: count }, (_, idx) => ({
    ts: Math.round(since + idx * bucketWidth),
    value: 0,
    extra: 0,
    warn: 0,
    highlight: 0,
    p95Vals: [] as number[],
    avgVals: [] as number[],
  }));

  for (const item of items) {
    const rawTs = opts.timestamp(item);
    if (rawTs === null || rawTs === undefined || rawTs === '') continue;
    const msTs = typeof rawTs === 'number' ? rawTs : Date.parse(rawTs);
    if (!Number.isFinite(msTs)) continue;
    const rawIdx = Math.floor(((msTs - since) / span) * count);
    const idx = Math.max(0, Math.min(count - 1, rawIdx));
    const b = buckets[idx];
    const v = opts.value ? opts.value(item) : 1;
    b.value += Number.isFinite(v) ? v : 0;
    if (opts.extra) b.extra += opts.extra(item) || 0;
    if (opts.warn) b.warn += opts.warn(item) || 0;
    if (opts.highlight) b.highlight += opts.highlight(item) || 0;
    const p = opts.p95?.(item);
    if (typeof p === 'number' && Number.isFinite(p) && p > 0) b.p95Vals.push(p);
    const a = opts.avg?.(item);
    if (typeof a === 'number' && Number.isFinite(a) && a > 0) b.avgVals.push(a);
  }

  const timestamps = buckets.map((b) => b.ts);
  const labels = buckets.map((b) => `${chartFooterDate(b.ts)} UTC`);
  const barSeries: BarDatum[] = buckets.map((b, idx) => ({
    label: labels[idx],
    ts: b.ts,
    value: b.value,
    extra: b.extra || undefined,
    warn: b.warn || undefined,
    highlight: b.highlight || undefined,
  }));
  const p95Values = buckets.map((b) => {
    if (!b.p95Vals.length) return null;
    const sorted = [...b.p95Vals].sort((a, c) => a - c);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  });
  const avgValues = buckets.map((b) => {
    if (!b.avgVals.length) return null;
    return b.avgVals.reduce((sum, v) => sum + v, 0) / b.avgVals.length;
  });

  return { barSeries, p95Values, avgValues, labels, timestamps };
}

/**
 * 1:1 Nightwatch chart card (`CountChart` / `DurationChart`):
 * - White/dark bordered card with interactive click-to-toggle legend buttons (`opacity-40` when hidden)
 * - Top-left mono uppercase title + `text-xl` headline value
 * - Top-right vertical-pill legend metrics (`h-2 w-1 rounded-[2px]`)
 */
export function MetricChartCard({
  title,
  value,
  metrics = [],
  fetching = false,
  compact = false,
  children,
  className,
}: {
  title: string;
  value: ReactNode;
  metrics?: MetricLegendItem[];
  fetching?: boolean;
  compact?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [hidden, setHidden] = useState<Partial<Record<SeriesKey, boolean>>>({});

  const labels: Partial<Record<SeriesKey, string>> = {};
  for (const m of metrics) {
    labels[inferSeriesKey(m)] = m.label;
  }

  const toggleSeries = (key: SeriesKey) => {
    setHidden((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <ChartCardContext.Provider value={{ hidden, labels }}>
      <div
        data-slot="card"
        className={cn(
          'relative flex flex-col justify-between rounded-lg border border-neutral-200 bg-white shadow-md shadow-black/5 dark:border-white/[0.05] dark:bg-white/[0.02] dark:shadow-black/20',
          compact ? 'p-5 sm:p-6' : 'p-4 lg:p-5',
          className,
        )}
      >
        {fetching && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden rounded-t-lg bg-blue-600/15" aria-hidden>
            <div className="ew-indeterminate h-full w-1/3 rounded-full bg-blue-600 dark:bg-emerald-500" />
          </div>
        )}
        <div className={cn('flex flex-wrap items-start justify-between gap-4', compact ? 'pb-4' : 'pb-6')}>
          <div className="flex flex-col gap-2">
            <div className="font-mono text-xs/none uppercase text-neutral-500 dark:text-neutral-400">
              {title}
            </div>
            <div className="text-base/none font-medium tabular-nums text-neutral-900 sm:text-xl/none dark:text-white">
              {value}
            </div>
          </div>
          {metrics.length > 0 && (
            <div className="flex flex-wrap items-start gap-4 sm:gap-6">
              {metrics.map((metric) => {
                const key = inferSeriesKey(metric);
                const isHidden = Boolean(hidden[key]);
                return (
                  <button
                    key={metric.label}
                    type="button"
                    onClick={() => toggleSeries(key)}
                    aria-pressed={!isHidden}
                    className={cn(
                      'flex shrink-0 flex-col items-end gap-1 whitespace-nowrap transition-opacity sm:gap-2',
                      isHidden && 'opacity-40',
                    )}
                  >
                    <div className="flex items-center gap-2 font-mono text-xs/none uppercase text-neutral-500 dark:text-neutral-400">
                      <span className={cn('inline-block h-2 w-1 shrink-0 rounded-[2px]', PILL_TONES[metric.tone])} aria-hidden />
                      <span>{metric.label}</span>
                    </div>
                    <div className="text-base/none font-medium tabular-nums text-neutral-900 sm:text-lg/none dark:text-white">
                      {metric.value}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className={cn('transition-opacity duration-150', fetching && 'opacity-65')}>{children}</div>
      </div>
    </ChartCardContext.Provider>
  );
}

/** Small trend line: area fill, last-point dot, and an accessible summary. */
export function Sparkline({
  values,
  className = 'text-kumo-info',
  height = 28,
  width = 104,
  label = 'trend',
}: {
  values: number[];
  className?: string;
  height?: number;
  width?: number;
  label?: string;
}) {
  if (!values.length) return <span className="text-xs text-kumo-subtle">—</span>;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const pts = values.map((v, i) => [values.length === 1 ? width / 2 : i * step, height - (v / max) * (height - 6) - 3] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = pts[pts.length - 1];
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <svg width={width} height={height} className={className} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}: ${total} total, peak ${max}`}>
      {values.length > 1 && <polygon points={`0,${height} ${line} ${width},${height}`} fill="currentColor" opacity={0.14} />}
      {values.length > 1 && <polyline points={line} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />}
      <circle cx={lx} cy={ly} r={2.5} fill="currentColor" />
    </svg>
  );
}

/** Capture-exact 5 full-width horizontal gridlines (no left Y-axis column). */
function HorizontalGrid() {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col justify-between" aria-hidden>
      {[0, 1, 2, 3, 4].map((line) => (
        <div key={line} className="h-px w-full bg-neutral-100 dark:bg-white/[0.03]" />
      ))}
    </div>
  );
}

function FooterDates({ labels, bounds }: { labels: string[]; bounds?: [string, string] | null }) {
  const { showUtc } = useLocalPreferences();
  const { range } = useRange();
  const tzLabel = showUtc ? 'UTC' : localTzLabel();
  const resolvedBounds = (() => {
    if (!bounds) return null;
    if (showUtc) return bounds;
    const win = timeWindow(range);
    return win ? ([chartFooterDate(win.since, false), chartFooterDate(win.now, false)] as [string, string]) : bounds;
  })();
  const start = resolvedBounds?.[0] ?? labels[0];
  const end = resolvedBounds?.[1] ?? labels[labels.length - 1];
  const hasTz = Boolean(resolvedBounds);
  if (!start) return null;
  return (
    <div className="mt-3 flex items-center justify-between gap-4 font-mono text-xs tabular-nums text-neutral-500 dark:text-neutral-400" aria-hidden>
      <span className="truncate">
        {start}
        {hasTz && <span className="ml-1 text-neutral-400 dark:text-neutral-500">{tzLabel}</span>}
      </span>
      {end && end !== start && (
        <span className="truncate text-right">
          {end}
          {hasTz && <span className="ml-1 text-neutral-400 dark:text-neutral-500">{tzLabel}</span>}
        </span>
      )}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; className: string }[] }) {
  return (
    <div className="flex items-center gap-4 font-mono text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className={`h-2.5 w-1 rounded-full ${i.className}`} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/**
 * 1:1 Nightwatch `CountChart-B9LIaQE0.js` (`JF`) floating dark tooltip:
 * `min-w-72 sm:min-w-80 divide-y divide-neutral-700 rounded-md border border-neutral-700 bg-neutral-900 font-mono text-xs leading-3 text-white uppercase shadow-xl`
 * Follows hovered bucket instantaneously with zero delay and flips left/right to stay inside the card.
 */
function FloatingChartTooltip({
  anchorX,
  containerWidth,
  label,
  rows,
  total,
}: {
  anchorX: number;
  containerWidth: number;
  label?: string;
  rows: { color: string; name: string; value: string }[];
  total?: string;
}) {
  const flipLeft = anchorX > containerWidth * 0.52;
  const offset = 14;
  return (
    <div
      className="pointer-events-none absolute top-2 z-50 min-w-64 divide-y divide-neutral-700 rounded-md border border-neutral-700 bg-neutral-900 font-mono text-xs leading-3 text-white uppercase shadow-xl sm:min-w-72"
      style={
        flipLeft
          ? { right: Math.max(8, containerWidth - anchorX + offset) }
          : { left: Math.max(8, anchorX + offset) }
      }
    >
      {label && <div className="p-3.5 text-neutral-200">{label}</div>}
      <div className="grid gap-3 p-3.5">
        {rows.map((r) => (
          <div key={r.name} className="flex w-full items-stretch gap-2">
            <div
              className="w-1 shrink-0 rounded-[2px]"
              style={{ backgroundColor: r.color }}
            />
            <div className="flex flex-1 items-center justify-between leading-none">
              <span className="pr-3 text-neutral-300">{r.name}</span>
              <span className="text-right font-medium text-neutral-100 tabular-nums">{r.value}</span>
            </div>
          </div>
        ))}
        {total && rows.length > 1 && (
          <div className="flex justify-between pt-1 text-white">
            <span className="uppercase">Total</span>
            <span className="font-medium tabular-nums">{total}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Shared hook for smooth mousemove bucket tracking + drag-to-zoom (`QF` in Nightwatch). */
function useChartInteraction({
  count,
  chartId,
  plotWidth,
  timestamps,
}: {
  count: number;
  chartId: string;
  plotWidth: number;
  timestamps?: number[];
}) {
  const { hoveredIndex, sourceId, setHover } = useContext(ChartSyncContext);
  const { range, setRange } = useRange();
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragEnd, setDragEnd] = useState<number | null>(null);

  const indexFromEvent = (e: MouseEvent<HTMLDivElement>): number => {
    if (count <= 0) return -1;
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = Math.max(0, Math.min(rect.width - 0.001, e.clientX - rect.left));
    return Math.max(0, Math.min(count - 1, Math.floor((relX / Math.max(1, rect.width)) * count)));
  };

  const onMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    const idx = indexFromEvent(e);
    if (idx < 0) return;
    setHover(idx, chartId);
    if (dragStart !== null) setDragEnd(idx);
  };

  const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || count < 2) return;
    const idx = indexFromEvent(e);
    if (idx >= 0) {
      setDragStart(idx);
      setDragEnd(idx);
    }
  };

  const onMouseUp = () => {
    if (dragStart !== null && dragEnd !== null && dragStart !== dragEnd) {
      const left = Math.min(dragStart, dragEnd);
      const right = Math.max(dragStart, dragEnd);
      const win = timeWindow(range);
      let fromMs: number | null = null;
      let toMs: number | null = null;
      if (timestamps && timestamps.length === count) {
        const step = count > 1 ? Math.max(60_000, timestamps[1] - timestamps[0]) : 60_000;
        fromMs = timestamps[left];
        toMs = timestamps[right] + step;
      } else if (win) {
        const step = (win.now - win.since) / Math.max(1, count);
        fromMs = Math.round(win.since + left * step);
        toMs = Math.round(win.since + (right + 1) * step);
      }
      if (fromMs !== null && toMs !== null && toMs - fromMs >= 60_000) {
        setRange(`custom:${fromMs}:${toMs}`);
      }
    }
    setDragStart(null);
    setDragEnd(null);
  };

  const onMouseLeave = () => {
    setHover(null, null);
    setDragStart(null);
    setDragEnd(null);
  };

  const activeIdx = hoveredIndex !== null && hoveredIndex < count ? hoveredIndex : null;
  const isSource = sourceId === chartId;
  const anchorX =
    activeIdx !== null && count > 0
      ? ((activeIdx + 0.5) / count) * plotWidth
      : 0;

  const selection =
    dragStart !== null && dragEnd !== null && dragStart !== dragEnd && count > 0
      ? {
          leftPct: (Math.min(dragStart, dragEnd) / count) * 100,
          widthPct: ((Math.abs(dragEnd - dragStart) + 1) / count) * 100,
        }
      : null;

  return {
    activeIdx,
    isSource,
    anchorX,
    selection,
    handlers: { onMouseMove, onMouseDown, onMouseUp, onMouseLeave },
  };
}

/**
 * 1:1 Nightwatch `CountChart-B9LIaQE0.js` stacked bar chart:
 * - Default `196px` plot height (matching Nightwatch 2-col 513×196 SVGs; 238px for full-width)
 * - Full-width 5-line horizontal grid (no Y-axis labels)
 * - Crisp 0px-radius vertical bars (`maxBarSize: 20`, 20% category gap) with exact 1px vertical gap between stacked segments
 * - Instant zero-delay mouse-following Nightwatch dark `ChartTooltip`, cross-chart synced hover, clickable legend toggling, and drag-to-zoom
 */
export function BarChart({
  series,
  height = 196,
  tone = 'neutral',
  unit = 'requests',
  bounds,
  hideFooter = false,
}: {
  series: BarDatum[];
  height?: number;
  tone?: 'neutral' | 'brand' | 'danger' | 'success';
  unit?: string;
  bounds?: [string, string] | null;
  hideFooter?: boolean;
}) {
  const chartId = useId();
  const { showUtc } = useLocalPreferences();
  const { hidden, labels: metricLabels } = useContext(ChartCardContext);
  const [containerRef, plotWidth] = useContainerWidth(513);

  const timestamps = series.every((s) => typeof s.ts === 'number')
    ? series.map((s) => s.ts as number)
    : undefined;

  const { activeIdx, isSource, anchorX, selection, handlers } = useChartInteraction({
    count: series.length,
    chartId,
    plotWidth,
    timestamps,
  });

  const baseColor =
    tone === 'danger'
      ? 'var(--chart-bar-error)'
      : tone === 'success'
        ? 'hsl(var(--chart-6))'
        : tone === 'brand'
          ? 'var(--chart-bar-blue)'
          : 'var(--chart-bar-neutral)';
  const warnColor = tone === 'success' ? 'hsl(var(--chart-2))' : 'var(--chart-bar-alert)';
  const extraColor = 'var(--chart-bar-blue)';
  const errorColor = 'var(--chart-bar-error)';

  const defaultBaseName =
    metricLabels.base ?? (tone === 'success' ? 'Authenticated' : unit.charAt(0).toUpperCase() + unit.slice(1));
  const defaultExtraName = metricLabels.extra ?? 'Writes';
  const defaultWarnName = metricLabels.warn ?? (tone === 'success' ? 'Guest' : '4xx');
  const defaultErrorName = metricLabels.highlight ?? '5xx';

  const visibleTotals = series.map((s) => {
    const err = hidden.highlight ? 0 : Math.max(0, s.highlight ?? 0);
    const warn = hidden.warn ? 0 : Math.max(0, s.warn ?? 0);
    const extra = hidden.extra ? 0 : Math.max(0, s.extra ?? 0);
    const rawBase = Math.max(0, s.value - (s.highlight ?? 0) - (s.warn ?? 0) - (s.extra ?? 0));
    const base = hidden.base ? 0 : rawBase;
    return { err, warn, extra, base, total: err + warn + extra + base };
  });

  const grandTotal = visibleTotals.reduce((a, b) => a + b.total, 0);

  if (!series.length || grandTotal === 0) {
    return (
      <div role="img" aria-label={`0 ${unit}`}>
        <div ref={containerRef} className="relative" style={{ height }}>
          <HorizontalGrid />
        </div>
        {!hideFooter && <FooterDates labels={series.map((s) => s.label)} bounds={bounds} />}
      </div>
    );
  }

  const max = Math.max(1, ...visibleTotals.map((t) => t.total));
  const n = series.length;
  const slotWidth = plotWidth / n;
  // Exact Recharts `maxBarSize: 20, barCategoryGap: '20%'` geometry
  const barWidth = Math.max(2, Math.min(20, Math.floor(slotWidth * 0.8)));

  // Determine which series exist across the whole chart so tooltip lists all relevant rows like Nightwatch
  const hasErrSeries = !hidden.highlight && series.some((s) => (s.highlight ?? 0) > 0 || metricLabels.highlight);
  const hasWarnSeries = !hidden.warn && series.some((s) => (s.warn ?? 0) > 0 || metricLabels.warn);
  const hasExtraSeries = !hidden.extra && series.some((s) => (s.extra ?? 0) > 0 || metricLabels.extra);
  const hasBaseSeries = !hidden.base;

  const hoveredDatum = activeIdx !== null ? series[activeIdx] : null;
  const hoveredVis = activeIdx !== null ? visibleTotals[activeIdx] : null;
  const tooltipRows: { color: string; name: string; value: string }[] = [];
  if (hoveredVis) {
    if (hasBaseSeries) tooltipRows.push({ color: baseColor, name: defaultBaseName, value: hoveredVis.base.toLocaleString() });
    if (hasExtraSeries) tooltipRows.push({ color: extraColor, name: defaultExtraName, value: hoveredVis.extra.toLocaleString() });
    if (hasWarnSeries) tooltipRows.push({ color: warnColor, name: defaultWarnName, value: hoveredVis.warn.toLocaleString() });
    if (hasErrSeries) tooltipRows.push({ color: errorColor, name: defaultErrorName, value: hoveredVis.err.toLocaleString() });
  }

  return (
    <div role="img" aria-label={`${grandTotal} ${unit}, peak ${max} per bucket`}>
      <div
        ref={containerRef}
        className="relative select-none"
        style={{ height }}
        {...handlers}
      >
        <HorizontalGrid />

        {/* Hovered bucket vertical cursor highlight (1:1 Recharts `.recharts-rectangle.recharts-tooltip-cursor`) */}
        {activeIdx !== null && (
          <div
            className="pointer-events-none absolute inset-y-0 bg-neutral-100 dark:bg-white/[0.03]"
            style={{
              left: activeIdx * slotWidth,
              width: slotWidth,
            }}
          />
        )}

        {/* Drag-to-zoom selection highlight */}
        {selection && (
          <div
            className="pointer-events-none absolute inset-y-0 z-10 border-x border-neutral-400/50 bg-neutral-400/15 dark:border-white/25 dark:bg-white/10"
            style={{ left: `${selection.leftPct}%`, width: `${selection.widthPct}%` }}
          />
        )}

        {/* Crisp 1:1 pixel SVG bars with exact 1px gap between stacked segments */}
        <svg
          width="100%"
          height={height}
          viewBox={`0 0 ${plotWidth} ${height}`}
          className="pointer-events-none relative z-[1] block"
        >
          {series.map((_, i) => {
            const vis = visibleTotals[i];
            if (vis.total <= 0) return null;

            const x = i * slotWidth + (slotWidth - barWidth) / 2;
            // Stack from bottom to top: base -> extra -> warn -> error, with 1px gap between each visible segment
            const parts: { key: string; val: number; color: string }[] = [];
            if (vis.base > 0) parts.push({ key: 'base', val: vis.base, color: baseColor });
            if (vis.extra > 0) parts.push({ key: 'extra', val: vis.extra, color: extraColor });
            if (vis.warn > 0) parts.push({ key: 'warn', val: vis.warn, color: warnColor });
            if (vis.err > 0) parts.push({ key: 'err', val: vis.err, color: errorColor });

            const rawHeights = parts.map((p) => Math.max(1, (p.val / max) * height));
            const totalGap = Math.max(0, parts.length - 1);
            const rawSum = rawHeights.reduce((a, b) => a + b, 0);
            const scale = rawSum + totalGap > height ? (height - totalGap) / Math.max(1, rawSum) : 1;

            let cursorY = height;
            return (
              <g key={i}>
                {parts.map((p, pIdx) => {
                  const segH = Math.max(1, Math.round(rawHeights[pIdx] * scale));
                  cursorY -= segH;
                  const y = Math.max(0, cursorY);
                  cursorY -= 1; // exact 1px gap matching Nightwatch CountChart
                  return (
                    <rect
                      key={p.key}
                      x={x}
                      y={y}
                      width={barWidth}
                      height={segH}
                      fill={p.color}
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>

        {/* Zero-delay mouse-following dark Nightwatch tooltip */}
        {isSource && hoveredDatum && hoveredVis && (
          <FloatingChartTooltip
            anchorX={anchorX}
            containerWidth={plotWidth}
            label={
              hoveredDatum.ts
                ? `${chartFooterDate(hoveredDatum.ts, showUtc)} ${showUtc ? 'UTC' : localTzLabel()}`
                : hoveredDatum.label
            }
            rows={tooltipRows}
            total={hoveredVis.total.toLocaleString()}
          />
        )}
      </div>
      {!hideFooter && <FooterDates labels={series.map((s) => s.label)} bounds={bounds} />}
    </div>
  );
}

interface PlotPoint {
  index: number;
  x: number;
  y: number;
  value: number;
}

/** Splits a series into contiguous non-null runs (`connectNulls={false}` matching Nightwatch `LineChart-CuYQx_SP.js`). */
function buildContiguousRuns(
  arr: (number | null)[],
  width: number,
  height: number,
  max: number,
): PlotPoint[][] {
  const n = arr.length;
  const runs: PlotPoint[][] = [];
  let current: PlotPoint[] = [];

  for (let i = 0; i < n; i++) {
    const raw = arr[i];
    if (raw !== null) {
      const x = n === 1 ? width / 2 : ((i + 0.5) / n) * width;
      const y = height - (raw / max) * (height - 10) - 2;
      current.push({ index: i, x, y, value: raw });
    } else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * 1:1 Nightwatch `DurationChart-lcwMUIfQ.js` + `LineChart-CuYQx_SP.js` dual-line area chart:
 * - Default `200px` plot height (matching Nightwatch 2-col 513×200 SVGs)
 * - 1:1 pixel coordinates via `ResizeObserver` so vertex dots (`r=0.8`), isolated dots (`r=3`), and hover dots (`r=2.5`) are perfect circles
 * - `connectNulls={false}`: empty / zero buckets are gaps, NEVER dropped to 0
 * - Zero-delay mouse-following dark `ChartTooltip`, cross-chart hover sync, clickable legend toggling, and drag-to-zoom
 */
export function LineChart({
  values,
  secondaryValues,
  labels = [],
  timestamps,
  height = 200,
  format = nice,
  bounds,
  hideFooter = false,
}: {
  values: (number | null | undefined)[];
  secondaryValues?: (number | null | undefined)[];
  labels?: string[];
  timestamps?: number[];
  height?: number;
  className?: string;
  format?: (n: number) => string;
  bounds?: [string, string] | null;
  hideFooter?: boolean;
}) {
  const chartId = useId();
  const { showUtc } = useLocalPreferences();
  const p95GradId = useId();
  const avgGradId = useId();
  const { hidden } = useContext(ChartCardContext);
  const [containerRef, plotWidth] = useContainerWidth(513);

  const { activeIdx, isSource, anchorX, selection, handlers } = useChartInteraction({
    count: values.length,
    chartId,
    plotWidth,
    timestamps,
  });

  const normalizedPrimary = values.map((v) =>
    !hidden.p95 && typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null,
  );
  const normalizedSecondary =
    !hidden.avg && secondaryValues && secondaryValues.length === values.length
      ? secondaryValues.map((v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null))
      : null;

  const positiveValues = [
    ...normalizedPrimary.filter((v): v is number => v !== null),
    ...(normalizedSecondary?.filter((v): v is number => v !== null) ?? []),
  ];

  if (!values.length || positiveValues.length === 0) {
    return (
      <div role="img" aria-label="No duration data in this window">
        <div ref={containerRef} className="relative" style={{ height }} />
        {!hideFooter && <FooterDates labels={labels} bounds={bounds} />}
      </div>
    );
  }

  const max = Math.max(1, ...positiveValues);
  const p95Runs = buildContiguousRuns(normalizedPrimary, plotWidth, height, max);
  const avgRuns = normalizedSecondary ? buildContiguousRuns(normalizedSecondary, plotWidth, height, max) : [];

  const n = values.length;
  const xFor = (i: number) => (n === 1 ? plotWidth / 2 : ((i + 0.5) / n) * plotWidth);
  const yFor = (v: number) => height - (v / max) * (height - 10) - 2;

  const hoveredP95 = activeIdx !== null ? normalizedPrimary[activeIdx] : null;
  const hoveredAvg = activeIdx !== null && normalizedSecondary ? normalizedSecondary[activeIdx] : null;
  const tooltipRows: { color: string; name: string; value: string }[] = [];
  if (hoveredAvg !== null) tooltipRows.push({ color: 'var(--chart-area-neutral-line)', name: 'AVG', value: format(hoveredAvg) });
  if (hoveredP95 !== null) tooltipRows.push({ color: 'var(--chart-area-alert-line)', name: 'P95', value: format(hoveredP95) });

  return (
    <div role="img" aria-label={`peak ${format(max)}`}>
      <div
        ref={containerRef}
        className="relative select-none"
        style={{ height }}
        {...handlers}
      >
        <HorizontalGrid />

        {/* Drag-to-zoom selection highlight */}
        {selection && (
          <div
            className="pointer-events-none absolute inset-y-0 z-10 border-x border-neutral-400/50 bg-neutral-400/15 dark:border-white/25 dark:bg-white/10"
            style={{ left: `${selection.leftPct}%`, width: `${selection.widthPct}%` }}
          />
        )}

        <svg
          width="100%"
          height={height}
          viewBox={`0 0 ${plotWidth} ${height}`}
          className="pointer-events-none relative z-[1] block overflow-visible"
        >
          <defs>
            <linearGradient id={p95GradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-area-alert-line)" stopOpacity={0.2} />
              <stop offset="100%" stopColor="var(--chart-area-alert-line)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id={avgGradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-area-neutral-line)" stopOpacity={0.2} />
              <stop offset="100%" stopColor="var(--chart-area-neutral-line)" stopOpacity={0} />
            </linearGradient>
          </defs>

          {/* Vertical hover cursor line (1:1 Recharts `.recharts-curve.recharts-tooltip-cursor`) */}
          {activeIdx !== null && (
            <line
              x1={xFor(activeIdx)}
              x2={xFor(activeIdx)}
              y1={0}
              y2={height}
              className="stroke-neutral-200 dark:stroke-white/10"
              strokeWidth={1}
            />
          )}

          {/* AVG series behind P95 */}
          {avgRuns.map((run, rIdx) => {
            if (run.length === 1) {
              return (
                <circle
                  key={`avg-pt-${rIdx}`}
                  cx={run[0].x}
                  cy={run[0].y}
                  r={3}
                  fill="var(--chart-area-neutral-line)"
                />
              );
            }
            const pts = run.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
            const firstX = run[0].x.toFixed(1);
            const lastX = run[run.length - 1].x.toFixed(1);
            return (
              <g key={`avg-run-${rIdx}`}>
                <polygon points={`${firstX},${height} ${pts} ${lastX},${height}`} fill={`url(#${avgGradId})`} />
                <polyline
                  points={pts}
                  fill="none"
                  stroke="var(--chart-area-neutral-line)"
                  strokeWidth={1.5}
                  strokeLinejoin="miter"
                  strokeLinecap="butt"
                />
                {run.map((p) => (
                  <circle key={p.index} cx={p.x} cy={p.y} r={0.8} fill="var(--chart-area-neutral-line)" />
                ))}
              </g>
            );
          })}

          {/* P95 series on top */}
          {p95Runs.map((run, rIdx) => {
            if (run.length === 1) {
              return (
                <circle
                  key={`p95-pt-${rIdx}`}
                  cx={run[0].x}
                  cy={run[0].y}
                  r={3}
                  fill="var(--chart-area-alert-line)"
                />
              );
            }
            const pts = run.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
            const firstX = run[0].x.toFixed(1);
            const lastX = run[run.length - 1].x.toFixed(1);
            return (
              <g key={`p95-run-${rIdx}`}>
                <polygon points={`${firstX},${height} ${pts} ${lastX},${height}`} fill={`url(#${p95GradId})`} />
                <polyline
                  points={pts}
                  fill="none"
                  stroke="var(--chart-area-alert-line)"
                  strokeWidth={1.5}
                  strokeLinejoin="miter"
                  strokeLinecap="butt"
                />
                {run.map((p) => (
                  <circle key={p.index} cx={p.x} cy={p.y} r={0.8} fill="var(--chart-area-alert-line)" />
                ))}
              </g>
            );
          })}

          {/* Active hover dots (`r=2.5`, exact 1:1 Nightwatch `activeDot`) */}
          {activeIdx !== null && hoveredAvg !== null && (
            <circle cx={xFor(activeIdx)} cy={yFor(hoveredAvg)} r={2.5} fill="var(--chart-area-neutral-line)" />
          )}
          {activeIdx !== null && hoveredP95 !== null && (
            <circle cx={xFor(activeIdx)} cy={yFor(hoveredP95)} r={2.5} fill="var(--chart-area-alert-line)" />
          )}
        </svg>

        {/* Zero-delay mouse-following dark Nightwatch tooltip */}
        {isSource && activeIdx !== null && tooltipRows.length > 0 && (
          <FloatingChartTooltip
            anchorX={anchorX}
            containerWidth={plotWidth}
            label={
              timestamps?.[activeIdx]
                ? `${chartFooterDate(timestamps[activeIdx], showUtc)} ${showUtc ? 'UTC' : localTzLabel()}`
                : labels[activeIdx] || (bounds ? `${bounds[0]} ${showUtc ? 'UTC' : localTzLabel()}` : undefined)
            }
            rows={tooltipRows}
          />
        )}
      </div>
      {!hideFooter && <FooterDates labels={labels} bounds={bounds} />}
    </div>
  );
}
