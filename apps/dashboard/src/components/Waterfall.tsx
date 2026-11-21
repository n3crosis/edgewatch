import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ms } from '@/lib/format';
import type { Span, SpanType } from '@/lib/types';
import { cn } from '@/lib/utils';

export const SPAN_COLORS: Record<SpanType, string> = {
  request: 'bg-sky-500',
  job: 'bg-violet-500',
  middleware: 'bg-slate-500',
  controller: 'bg-indigo-500',
  query: 'bg-amber-400',
  cache: 'bg-teal-400',
  'outgoing-request': 'bg-fuchsia-500',
  mail: 'bg-emerald-500',
  exception: 'bg-rose-500',
};

export default function Waterfall({ spans, total, onSelect, selected }: { spans: Span[]; total: number; onSelect?: (s: Span) => void; selected?: string }) {
  return (
    <div className="text-xs">
      <div className="relative ml-[40%] h-6 border-b text-muted-foreground">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <span key={t} className="absolute -translate-x-1/2" style={{ left: `${t * 100}%` }}>
            {ms(total * t)}
          </span>
        ))}
      </div>
      {spans.map((span) => (
        <button
          key={span.id}
          onClick={() => onSelect?.(span)}
          className={cn('flex w-full items-center border-b border-border/50 py-1.5 text-left transition-colors hover:bg-muted/50', selected === span.id && 'bg-muted')}
        >
          <div className="flex w-[40%] min-w-0 items-center gap-2 pr-3">
            <span className={cn('size-2 shrink-0 rounded-full', SPAN_COLORS[span.type])} />
            <span className="w-24 shrink-0 text-muted-foreground">{span.type}</span>
            <span className="truncate font-mono">{span.label}</span>
          </div>
          <div className="relative h-4 flex-1">
            <Tooltip>
              <TooltipTrigger asChild>
                {span.type === 'exception' ? (
                  <div className="absolute top-0 h-4 w-0.5 bg-rose-500" style={{ left: `${(span.start_ms / total) * 100}%` }} />
                ) : (
                  <div
                    className={cn('absolute top-0.5 h-3 rounded-sm', SPAN_COLORS[span.type])}
                    style={{ left: `${(span.start_ms / total) * 100}%`, width: `max(2px, ${(span.duration_ms / total) * 100}%)` }}
                  />
                )}
              </TooltipTrigger>
              <TooltipContent className="max-w-sm font-mono">
                {ms(span.duration_ms)} at +{ms(span.start_ms)}
              </TooltipContent>
            </Tooltip>
            {span.type !== 'exception' && (
              <span className="absolute top-0 text-[10px] text-muted-foreground" style={{ left: `calc(${Math.min(88, ((span.start_ms + span.duration_ms) / total) * 100)}% + 6px)` }}>
                {ms(span.duration_ms)}
              </span>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
