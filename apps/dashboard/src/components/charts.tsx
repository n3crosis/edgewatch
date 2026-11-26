import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { useId } from 'react';
import { yAxisTicks } from '@/lib/ui-helpers';

const nice = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${Math.round(n)}`);

/** Small trend line: area fill, last-point dot, and an accessible summary. Flat (all-zero) data renders as a baseline. */
export function Sparkline({
  values,
  className = 'text-kumo-info',
  height = 30,
  width = 112,
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

function YAxis({ max, format = nice }: { max: number; format?: (n: number) => string }) {
  const ticks = yAxisTicks(max, format);
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col justify-between" aria-hidden>
      {ticks.map((label, i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="w-14 shrink-0 text-right text-xs tabular-nums text-kumo-subtle">{label}</span>
          <div className="h-px flex-1 border-t border-dashed border-kumo-hairline" />
        </div>
      ))}
    </div>
  );
}

function XAxis({ labels }: { labels: string[] }) {
  if (!labels.length) return null;
  const pick = labels.length === 1
    ? [labels[0]]
    : labels.length === 2
      ? [labels[0], labels[1]]
      : [labels[0], labels[Math.floor(labels.length / 2)], labels[labels.length - 1]];
  return (
    <div className="ml-[4.25rem] mt-3.5 flex justify-between text-xs tabular-nums text-kumo-subtle" aria-hidden>
      {pick.map((l, i) => <span key={i}>{l}</span>)}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; className: string }[] }) {
  return (
    <div className="flex items-center gap-4 text-xs text-kumo-subtle">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-2">
          <span className={`size-2.5 rounded-xs ${i.className}`} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/** Stacked bars (total with the error share in red) over a labelled grid. */
export function BarChart({
  series,
  height = 208,
  tone = 'brand',
  unit = 'requests',
}: {
  series: { label: string; value: number; highlight?: number }[];
  height?: number;
  tone?: 'brand' | 'danger';
  unit?: string;
}) {
  if (!series.length) {
    return (
      <div className="grid place-items-center text-sm text-kumo-subtle" style={{ height }}>
        No data in this window
      </div>
    );
  }
  const max = Math.max(1, ...series.map((s) => s.value));
  const total = series.reduce((a, s) => a + s.value, 0);
  const barTone = tone === 'danger' ? 'bg-kumo-danger/70 group-hover:bg-kumo-danger' : 'bg-kumo-brand/65 group-hover:bg-kumo-brand';
  return (
    <div role="img" aria-label={`${total} ${unit}, peak ${max} per bucket`}>
      <div className="relative" style={{ height }}>
        <YAxis max={max} />
        <div className="absolute inset-y-0 left-[4.25rem] right-0 flex items-end gap-1 sm:gap-1.5">
          {series.map((s, i) => (
            <Tooltip key={i} asChild content={`${s.label} · ${s.value.toLocaleString()} ${unit}${s.highlight ? ` · ${s.highlight.toLocaleString()} errors` : ''}`}>
              <div className="group flex h-full min-w-0 flex-1 cursor-default flex-col justify-end rounded-t-sm transition-colors hover:bg-kumo-tint/35">
                <div
                  className={`flex w-full flex-col justify-end overflow-hidden rounded-t-[4px] transition-colors ${barTone}`}
                  style={{ height: `${(s.value / max) * 100}%`, minHeight: s.value ? 3 : 0 }}
                >
                  {s.highlight ? (
                    <div
                      className="w-full bg-kumo-danger"
                      style={{ height: `${Math.min(100, Math.max(8, (s.highlight / Math.max(1, s.value)) * 100))}%` }}
                    />
                  ) : null}
                </div>
              </div>
            </Tooltip>
          ))}
        </div>
      </div>
      <XAxis labels={series.map((s) => s.label)} />
    </div>
  );
}

/** Area line over a labelled grid; hover a bucket for its exact value and snapped point indicator. */
export function LineChart({
  values,
  labels = [],
  height = 208,
  className = 'text-kumo-info',
  format = nice,
}: {
  values: number[];
  labels?: string[];
  height?: number;
  className?: string;
  format?: (n: number) => string;
}) {
  const gradId = useId();
  if (!values.length) {
    return (
      <div className="grid place-items-center text-sm text-kumo-subtle" style={{ height }}>
        No data in this window
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
        <YAxis max={max} format={format} />
        <div className="absolute inset-y-0 left-[4.25rem] right-0">
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={`h-full w-full ${className}`}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="currentColor" stopOpacity={0.22} />
                <stop offset="100%" stopColor="currentColor" stopOpacity={0.01} />
              </linearGradient>
            </defs>
            {values.length > 1 && <polygon points={`0,${height} ${line} ${width},${height}`} fill={`url(#${gradId})`} />}
            {values.length > 1 && <polyline points={line} fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
          </svg>
          <div className={`absolute inset-0 flex ${className}`}>
            {values.map((v, i) => {
              const topPct = (pts[i][1] / height) * 100;
              return (
                <Tooltip key={i} asChild content={`${labels[i] ? `${labels[i]} · ` : ''}${format(v)}`}>
                  <div className="group relative h-full flex-1 transition-colors hover:bg-kumo-tint/30">
                    <div className="pointer-events-none absolute inset-y-0 left-1/2 hidden w-px -translate-x-1/2 bg-kumo-line group-hover:block" />
                    <div
                      className="pointer-events-none absolute left-1/2 hidden size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current ring-4 ring-current/20 group-hover:block"
                      style={{ top: `${topPct}%` }}
                    />
                  </div>
                </Tooltip>
              );
            })}
          </div>
        </div>
      </div>
      <XAxis labels={labels} />
    </div>
  );
}
