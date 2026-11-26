import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { cn } from '@cloudflare/kumo/utils';
import {
  ArrowsLeftRightIcon,
  BriefcaseIcon,
  BugIcon,
  CodeIcon,
  DatabaseIcon,
  EnvelopeIcon,
  GlobeIcon,
  LightningIcon,
  ListBulletsIcon,
  QueueIcon,
  StackIcon,
} from '@phosphor-icons/react';
import type { ComponentType, KeyboardEvent } from 'react';
import { waterfallDuration, waterfallPosition } from '@/lib/waterfall';
import { ms } from '@/lib/format';
import type { Span, SpanType } from '@/lib/types';

export const SPAN_COLORS: Record<SpanType, string> = {
  request: 'bg-sky-500',
  job: 'bg-violet-500',
  middleware: 'bg-slate-500',
  controller: 'bg-indigo-500',
  query: 'bg-amber-400',
  cache: 'bg-teal-400',
  'outgoing-request': 'bg-fuchsia-500',
  mail: 'bg-emerald-500',
  'queued-job': 'bg-violet-300',
  log: 'bg-slate-400',
  exception: 'bg-rose-500',
};

export const SPAN_LABELS: Record<SpanType, string> = {
  request: 'Request',
  job: 'Job',
  middleware: 'Middleware',
  controller: 'Controller',
  query: 'Query',
  cache: 'Cache',
  'outgoing-request': 'Outgoing HTTP',
  mail: 'Mail',
  'queued-job': 'Queued job',
  log: 'Log',
  exception: 'Exception',
};

export const SPAN_ICONS: Record<SpanType, ComponentType<{ size?: number; className?: string }>> = {
  request: ArrowsLeftRightIcon,
  job: BriefcaseIcon,
  middleware: StackIcon,
  controller: CodeIcon,
  query: DatabaseIcon,
  cache: LightningIcon,
  'outgoing-request': GlobeIcon,
  mail: EnvelopeIcon,
  'queued-job': QueueIcon,
  log: ListBulletsIcon,
  exception: BugIcon,
};

const TICKS = [0, 0.25, 0.5, 0.75, 1] as const;

function spanDepth(type: SpanType): number {
  if (type === 'request' || type === 'job') return 0;
  if (type === 'middleware' || type === 'controller') return 1;
  return 2;
}

function isSlowSpan(span: Span): boolean {
  if (span.type === 'query') return span.duration_ms > 100;
  if (span.type === 'cache') return span.duration_ms > 50;
  return span.type !== 'request' && span.type !== 'job' && span.type !== 'controller' && span.duration_ms > 500;
}

export default function Waterfall({
  spans,
  total,
  onSelect,
  selected,
}: {
  spans: Span[];
  total: number;
  onSelect?: (s: Span) => void;
  selected?: string;
}) {
  const duration = waterfallDuration(spans, total);
  const hasRoot = spans.some((s) => s.type === 'request' || s.type === 'job');

  const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const nextIndex = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : -1;
    if (nextIndex < 0 || nextIndex >= spans.length) return;
    event.preventDefault();
    document.getElementById(`span-${spans[nextIndex].id}`)?.focus();
  };

  return (
    <div className="min-w-[700px] text-xs">
      <div className="flex items-center border-b border-kumo-hairline pb-3.5 text-kumo-subtle">
        <div className="w-[44%] shrink-0 pr-5 font-medium">Span</div>
        <div className="relative h-4 flex-1">
          {TICKS.map((t) => (
            <span
              key={t}
              className={cn('absolute tabular-nums', t === 0 ? 'translate-x-0' : t === 1 ? '-translate-x-full' : '-translate-x-1/2')}
              style={{ left: `${t * 100}%` }}
            >
              {ms(duration * t)}
            </span>
          ))}
        </div>
        <div className="w-24 shrink-0 pl-5 text-right font-medium">Duration</div>
      </div>
      <div className="divide-y divide-kumo-hairline/70">
        {spans.map((span, index) => {
          const position = waterfallPosition(span, duration);
          const isSelected = selected === span.id;
          const depth = hasRoot ? spanDepth(span.type) : 0;
          const slow = isSlowSpan(span);
          const SpanIcon = SPAN_ICONS[span.type];
          return (
            <button
              type="button"
              key={span.id}
              id={`span-${span.id}`}
              aria-haspopup="dialog"
              onClick={() => onSelect?.(span)}
              onKeyDown={(event) => onRowKeyDown(event, index)}
              className={cn(
                'group flex w-full cursor-pointer items-center py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-kumo-link hover:bg-kumo-tint/60',
                isSelected && 'bg-kumo-tint',
                span.type === 'exception' && 'bg-kumo-danger-tint/40 hover:bg-kumo-danger-tint/70',
              )}
            >
              <div
                className="flex w-[44%] min-w-0 shrink-0 items-center gap-2 pr-5"
                style={{ paddingLeft: depth ? `${depth * 14}px` : undefined }}
              >
                <span className={cn('size-2 shrink-0 rounded-full', SPAN_COLORS[span.type])} />
                <SpanIcon size={13} className={cn('shrink-0', span.type === 'exception' ? 'text-kumo-danger' : 'text-kumo-subtle')} />
                <span className="w-24 shrink-0 truncate text-kumo-subtle">{SPAN_LABELS[span.type]}</span>
                <span className={cn('truncate font-mono group-hover:text-kumo-strong', span.type === 'exception' ? 'text-kumo-danger' : 'text-kumo-default')}>
                  {span.label}
                </span>
              </div>
              <div className="relative h-6 flex-1">
                {/* Subtle vertical ruler guides */}
                <div className="pointer-events-none absolute inset-0" aria-hidden>
                  {TICKS.map((t) => (
                    <div key={t} className="absolute inset-y-0 border-l border-dashed border-kumo-hairline/50" style={{ left: `${t * 100}%` }} />
                  ))}
                </div>
                <Tooltip asChild content={<span className="font-mono text-xs">{ms(span.duration_ms)} at +{ms(span.start_ms)}</span>}>
                  {span.type === 'exception' ? (
                    <div
                      className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px] bg-rose-500 ring-2 ring-rose-500/25"
                      style={{ left: `${position.left}%` }}
                    />
                  ) : (
                    <div
                      className={cn(
                        'absolute top-1/2 h-3.5 -translate-y-1/2 rounded-sm transition-opacity group-hover:opacity-100',
                        SPAN_COLORS[span.type],
                        isSelected ? 'opacity-100 ring-2 ring-kumo-focus/50' : 'opacity-90',
                      )}
                      style={{ left: `${position.left}%`, width: `max(4px, ${position.width}%)` }}
                    />
                  )}
                </Tooltip>
              </div>
              <div
                className={cn(
                  'w-24 shrink-0 pl-5 text-right font-mono tabular-nums',
                  span.type === 'exception'
                    ? 'text-kumo-danger'
                    : slow
                      ? 'font-medium text-kumo-warning'
                      : 'text-kumo-subtle group-hover:text-kumo-strong',
                )}
              >
                {span.type === 'exception' ? `+${ms(span.start_ms)}` : ms(span.duration_ms)}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
