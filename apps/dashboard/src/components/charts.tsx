import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { cn } from '@cloudflare/kumo/utils';
import { timeWindow } from '@edgewatch/shared/time-window';
import { useId, type ReactNode } from 'react';
import type { Range } from '@/lib/types';

const nice = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${Math.round(n)}`);

export type MetricPillTone = 'neutral' | 'alert' | 'error' | 'blue' | 'success' | 'charcoal';

const PILL_TONES: Record<MetricPillTone, string> = {
  neutral: 'bg-neutral-300 dark:bg-neutral-600',
  charcoal: 'bg-neutral-700 dark:bg-neutral-400',
  alert: 'bg-amber-500',
  error: 'bg-rose-500',
  blue: 'bg-blue-500',
  success: 'bg-emerald-500',
};

export interface MetricLegendItem {
  label: string;
  value: ReactNode;
  tone: MetricPillTone;
}

/** Formats a UTC timestamp exactly like the capture chart footer: `15 Oct 2026, 11:07:00`. */
export function chartFooterDate(ts: number): string {
  return new Date(ts).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });
}

/** Returns start and end formatted timestamps for the active Range. */
export function rangeFooterBounds(range: Range): [string, string] | null {
  const win = timeWindow(range);
  if (!win) return null;
  return [chartFooterDate(win.since), chartFooterDate(win.now)];
}

/** 1:1 Capture chart card (`CountChart` / `DurationChart`): white bordered card, top-left mono title + text-xl value, top-right vertical-pill legend items with matching text-xl values. */
export function MetricChartCard({
  title,
  value,
  metrics = [],
  fetching = false,
  children,
  className,
}: {
  title: string;
  value: ReactNode;
  metrics?: MetricLegendItem[];
  fetching?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="card"
      className={cn(
        'relative flex flex-col justify-between overflow-hidden rounded-lg border border-neutral-200 bg-white p-4 shadow-md shadow-black/[0.04] sm:p-5 dark:border-white/[0.06] dark:bg-white/[0.02] dark:shadow-black/20',
        className,
      )}
    >
      {fetching && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-blue-600/15" aria-hidden>
          <div className="ew-indeterminate h-full w-1/3 rounded-full bg-blue-600 dark:bg-emerald-500" />
        </div>
      )}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <div className="font-mono text-xs/none uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            {title}
          </div>
          <div className="text-xl/none font-medium tabular-nums text-neutral-900 dark:text-white">
            {value}
          </div>
        </div>
        {metrics.length > 0 && (
          <div className="flex flex-wrap items-start gap-5 sm:gap-6">
            {metrics.map((metric) => (
              <div key={metric.label} className="flex flex-col items-end gap-2">
                <div className="flex items-center gap-1.5 font-mono text-xs/none uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                  <span className={cn('inline-block h-2.5 w-1 rounded-full', PILL_TONES[metric.tone])} aria-hidden />
                  <span>{metric.label}</span>
                </div>
                <div className="text-xl/none font-medium tabular-nums text-neutral-900 dark:text-white">
                  {metric.value}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className={cn('transition-opacity duration-150', fetching && 'opacity-65')}>{children}</div>
    </div>
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
        <div key={line} className="h-px w-full bg-neutral-100 dark:bg-white/[0.05]" />
      ))}
    </div>
  );
}

function FooterDates({ labels, bounds }: { labels: string[]; bounds?: [string, string] | null }) {
  const start = bounds?.[0] ?? labels[0];
  const end = bounds?.[1] ?? labels[labels.length - 1];
  const hasUtc = Boolean(bounds);
  if (!start) return null;
  return (
    <div className="mt-3 flex items-center justify-between gap-4 font-mono text-[11px] tabular-nums text-neutral-500 dark:text-neutral-400" aria-hidden>
      <span className="truncate">
        {start}
        {hasUtc && <span className="ml-1 text-neutral-400 dark:text-neutral-500">UTC</span>}
      </span>
      {end && end !== start && (
        <span className="truncate text-right">
          {end}
          {hasUtc && <span className="ml-1 text-neutral-400 dark:text-neutral-500">UTC</span>}
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

/** 1:1 Capture stacked bar chart: full-width 5-line grid, neutral/amber/rose bars, flush monospace footer dates. */
export function BarChart({
  series,
  height = 148,
  tone = 'neutral',
  unit = 'requests',
  bounds,
}: {
  series: { label: string; value: number; warn?: number; highlight?: number }[];
  height?: number;
  tone?: 'neutral' | 'brand' | 'danger';
  unit?: string;
  bounds?: [string, string] | null;
}) {
  const total = series.reduce((a, s) => a + s.value, 0);
  if (!series.length || total === 0) {
    return (
      <div role="img" aria-label={`0 ${unit}`}>
        <div className="relative" style={{ height }}>
          <HorizontalGrid />
        </div>
        <FooterDates labels={series.map((s) => s.label)} bounds={bounds} />
      </div>
    );
  }
  const max = Math.max(1, ...series.map((s) => s.value));
  const barTone =
    tone === 'danger'
      ? 'bg-rose-500/85 group-hover:bg-rose-500'
      : tone === 'brand'
        ? 'bg-blue-500/80 group-hover:bg-blue-600'
        : 'bg-neutral-300 group-hover:bg-neutral-400 dark:bg-neutral-700 dark:group-hover:bg-neutral-500';
  return (
    <div role="img" aria-label={`${total} ${unit}, peak ${max} per bucket`}>
      <div className="relative" style={{ height }}>
        <HorizontalGrid />
        <div className="absolute inset-0 flex items-end gap-1 sm:gap-1.5">
          {series.map((s, i) => {
            const tooltipText = [
              s.label,
              `${s.value.toLocaleString()} ${unit}`,
              s.warn ? `${s.warn.toLocaleString()} warnings` : null,
              s.highlight ? `${s.highlight.toLocaleString()} errors` : null,
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <Tooltip key={i} asChild content={tooltipText}>
                <div className="group flex h-full min-w-0 flex-1 cursor-default flex-col justify-end rounded-t-xs transition-colors hover:bg-neutral-100/80 dark:hover:bg-white/[0.04]">
                  <div
                    className={`flex w-full flex-col justify-end overflow-hidden rounded-t-[2px] transition-colors ${barTone}`}
                    style={{ height: `${(s.value / max) * 100}%`, minHeight: s.value ? 3 : 0 }}
                  >
                    {s.warn ? (
                      <div
                        className="w-full bg-amber-500"
                        style={{ height: `${Math.min(100, Math.max(8, (s.warn / Math.max(1, s.value)) * 100))}%` }}
                      />
                    ) : null}
                    {s.highlight ? (
                      <div
                        className="w-full bg-rose-500"
                        style={{ height: `${Math.min(100, Math.max(10, (s.highlight / Math.max(1, s.value)) * 100))}%` }}
                      />
                    ) : null}
                  </div>
                </div>
              </Tooltip>
            );
          })}
        </div>
      </div>
      <FooterDates labels={series.map((s) => s.label)} bounds={bounds} />
    </div>
  );
}

/** 1:1 Capture area line chart: full-width 5-line grid, amber/charcoal area stroke, flush monospace footer dates. */
export function LineChart({
  values,
  labels = [],
  height = 148,
  className = 'text-amber-500',
  format = nice,
  bounds,
}: {
  values: number[];
  labels?: string[];
  height?: number;
  className?: string;
  format?: (n: number) => string;
  bounds?: [string, string] | null;
}) {
  const gradId = useId();
  const hasNonZero = values.some((v) => v > 0);
  if (!values.length || !hasNonZero) {
    return (
      <div role="img" aria-label="No duration data in this window">
        <div className="relative" style={{ height }}>
          <HorizontalGrid />
        </div>
        <FooterDates labels={labels} bounds={bounds} />
      </div>
    );
  }
  const width = 600;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const pts = values.map((v, i) => [values.length === 1 ? width / 2 : i * step, height - (v / max) * (height - 12) - 6] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <div role="img" aria-label={`peak ${format(max)}`}>
      <div className="relative" style={{ height }}>
        <HorizontalGrid />
        <div className="absolute inset-0">
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={`h-full w-full ${className}`}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="currentColor" stopOpacity={0.18} />
                <stop offset="100%" stopColor="currentColor" stopOpacity={0.01} />
              </linearGradient>
            </defs>
            {values.length > 1 && <polygon points={`0,${height} ${line} ${width},${height}`} fill={`url(#${gradId})`} />}
            {values.length > 1 && <polyline points={line} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
          </svg>
          <div className={`absolute inset-0 flex ${className}`}>
            {values.map((v, i) => {
              const topPct = (pts[i][1] / height) * 100;
              return (
                <Tooltip key={i} asChild content={`${labels[i] ? `${labels[i]} · ` : ''}${format(v)}`}>
                  <div className="group relative h-full flex-1 transition-colors hover:bg-neutral-100/70 dark:hover:bg-white/[0.04]">
                    <div className="pointer-events-none absolute inset-y-0 left-1/2 hidden w-px -translate-x-1/2 bg-neutral-300 dark:bg-white/15 group-hover:block" />
                    <div
                      className="pointer-events-none absolute left-1/2 hidden size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current ring-4 ring-current/20 group-hover:block"
                      style={{ top: `${topPct}%` }}
                    />
                  </div>
                </Tooltip>
              );
            })}
          </div>
        </div>
      </div>
      <FooterDates labels={labels} bounds={bounds} />
    </div>
  );
}
