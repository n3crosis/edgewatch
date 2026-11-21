import { ms } from '../lib/format';
import type { Span, SpanType } from '../lib/types';

const COLORS: Record<SpanType, string> = {
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
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div className="text-xs">
      <div className="relative ml-[40%] h-6 border-b border-slate-800 text-slate-500">
        {ticks.map((t) => (
          <span key={t} className="absolute -translate-x-1/2" style={{ left: `${t * 100}%` }}>
            {ms(total * t)}
          </span>
        ))}
      </div>
      {spans.map((span) => (
        <button
          key={span.id}
          onClick={() => onSelect?.(span)}
          className={`flex w-full items-center border-b border-slate-900 py-1.5 text-left hover:bg-slate-800/40 ${selected === span.id ? 'bg-slate-800/60' : ''}`}
        >
          <div className="flex w-[40%] min-w-0 items-center gap-2 pr-3">
            <span className={`h-2 w-2 shrink-0 rounded-full ${COLORS[span.type]}`} />
            <span className="w-24 shrink-0 text-slate-500">{span.type}</span>
            <span className="truncate font-mono text-slate-300">{span.label}</span>
          </div>
          <div className="relative h-4 flex-1">
            {span.type === 'exception' ? (
              <div className="absolute top-0 h-4 w-0.5 bg-rose-500" style={{ left: `${(span.start_ms / total) * 100}%` }} />
            ) : (
              <div
                className={`absolute top-0.5 h-3 rounded-sm ${COLORS[span.type]}`}
                style={{ left: `${(span.start_ms / total) * 100}%`, width: `max(2px, ${(span.duration_ms / total) * 100}%)` }}
              />
            )}
            <span className="absolute top-0 text-[10px] text-slate-500" style={{ left: `calc(${Math.min(88, ((span.start_ms + span.duration_ms) / total) * 100)}% + 6px)` }}>
              {span.type === 'exception' ? '' : ms(span.duration_ms)}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}
