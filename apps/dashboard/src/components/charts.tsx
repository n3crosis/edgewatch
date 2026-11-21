import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function Sparkline({ values, className = 'text-chart-1', height = 28, width = 120 }: { values: number[]; className?: string; height?: number; width?: number }) {
  const max = Math.max(1, ...values);
  const step = width / Math.max(1, values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - (v / max) * (height - 2) - 1).toFixed(1)}`).join(' ');
  return (
    <svg width={width} height={height} className={className} viewBox={`0 0 ${width} ${height}`}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

export function BarChart({ series, height = 160 }: { series: { label: string; value: number; highlight?: number }[]; height?: number }) {
  const max = Math.max(1, ...series.map((s) => s.value));
  return (
    <div className="flex items-end gap-1" style={{ height }}>
      {series.map((s, i) => (
        <Tooltip key={i}>
          <TooltipTrigger asChild>
            <div className="group flex h-full flex-1 cursor-default flex-col justify-end">
              <div className="w-full overflow-hidden rounded-t-sm bg-chart-1/70 transition group-hover:bg-chart-1" style={{ height: `${(s.value / max) * 100}%` }}>
                {s.highlight ? <div className="w-full bg-chart-2" style={{ height: `${Math.max(6, (s.highlight / Math.max(1, s.value)) * 100)}%` }} /> : null}
              </div>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            {s.label}: {s.value}
            {s.highlight ? ` · ${s.highlight} errors` : ''}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

export function LineChart({ values, height = 160, className = 'text-chart-3' }: { values: number[]; height?: number; className?: string }) {
  const width = 600;
  const max = Math.max(1, ...values);
  const step = width / Math.max(1, values.length - 1);
  const line = values.map((v, i) => `${(i * step).toFixed(1)},${(height - (v / max) * (height - 8) - 4).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={`w-full ${className}`} style={{ height }}>
      <polygon points={`0,${height} ${line} ${width},${height}`} fill="currentColor" opacity={0.08} />
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
