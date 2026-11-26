import { useId, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import Link from '@/components/ScopedLink';
import { CardTray, CopyButton, Empty, ErrorState, Loading, PageHeader, Panel, SourceBadge, Sql, Stat, StatusBadge, useRowNavigate } from '@/components/common';
import Waterfall, { SPAN_COLORS, SPAN_ICONS, SPAN_LABELS } from '@/components/Waterfall';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Banner } from '@cloudflare/kumo/components/banner';
import { Button } from '@cloudflare/kumo/components/button';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { InputGroup } from '@cloudflare/kumo/components/input-group';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { cn } from '@cloudflare/kumo/utils';
import {
  BugIcon,
  CaretLeftIcon,
  CaretRightIcon,
  ClockIcon,
  CloudIcon,
  CpuIcon,
  DatabaseIcon,
  GitBranchIcon,
  GitForkIcon,
  HardDrivesIcon,
  MagnifyingGlassIcon,
  TimerIcon,
  UserIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import { api, useAsync } from '@/lib/api';
import { bytes, ms } from '@/lib/format';
import { traceView, updateTraceView } from '@/lib/trace-view';
import { filterSpansByQuery, traceTimeBreakdown } from '@/lib/ui-helpers';
import type { Span, SpanType } from '@/lib/types';

function SpanSheet({
  span,
  spans,
  onSelect,
  onClose,
  fallbackId,
}: {
  span: Span | null;
  spans: Span[];
  onSelect: (span: Span) => void;
  onClose: () => void;
  fallbackId: string;
}) {
  const lastSpanId = useRef<string | null>(null);
  if (span) lastSpanId.current = span.id;
  const index = span ? spans.findIndex((s) => s.id === span.id) : -1;
  const prevSpan = index > 0 ? spans[index - 1] : null;
  const nextSpan = index >= 0 && index < spans.length - 1 ? spans[index + 1] : null;

  return (
    <Dialog.Root
      open={span !== null}
      onOpenChange={(open) => !open && onClose()}
      onOpenChangeComplete={(open) => {
        if (!open) (document.getElementById(`span-${lastSpanId.current}`) ?? document.getElementById(fallbackId))?.focus();
      }}
    >
      <Dialog size="lg" className="max-h-[85vh] overflow-auto p-6 sm:p-8">
        {span && (
          <>
            <div className="mb-6 flex items-start justify-between gap-4 border-b border-kumo-hairline pb-5">
              <div className="min-w-0">
                <Dialog.Title className="flex items-center gap-2.5 text-lg font-semibold text-kumo-strong">
                  <span className={cn('size-2.5 shrink-0 rounded-full', SPAN_COLORS[span.type])} />
                  {(() => {
                    const SpanIcon = SPAN_ICONS[span.type];
                    return <SpanIcon size={18} className="shrink-0 text-kumo-subtle" />;
                  })()}
                  <span>{SPAN_LABELS[span.type]}</span>
                </Dialog.Title>
                <Dialog.Description className="mt-1 font-mono text-xs text-kumo-subtle">
                  {ms(span.duration_ms)} starting at +{ms(span.start_ms)}
                </Dialog.Description>
              </div>
              <Dialog.Close render={(props) => <Button {...props} variant="ghost" shape="square" size="sm" icon={<XIcon />} aria-label="Close" />} />
            </div>
            <div className="space-y-6 text-sm">
              <div className="relative">
                <pre className="whitespace-pre-wrap break-all rounded-xl border border-kumo-hairline bg-kumo-recessed p-4 pr-12 font-mono text-xs leading-6">
                  {span.type === 'query' ? <Sql sql={span.label} /> : span.label}
                </pre>
                <CopyButton text={span.label} label="Copy span" className="absolute right-2.5 top-2.5" />
              </div>
              <dl className="grid grid-cols-[120px_1fr] gap-x-5 gap-y-3.5 rounded-xl border border-kumo-hairline bg-kumo-elevated/60 p-5 text-xs">
                <dt className="font-medium text-kumo-subtle">Start</dt>
                <dd className="font-mono text-kumo-strong">+{ms(span.start_ms)}</dd>
                <dt className="font-medium text-kumo-subtle">Duration</dt>
                <dd className="font-mono text-kumo-strong">{ms(span.duration_ms)}</dd>
                {Object.entries(span.meta ?? {}).map(([k, v]) => {
                  const metaLabel = k.replace(/_/g, ' ').replace(/\bsql\b/i, 'SQL').replace(/^\w/, (c) => c.toUpperCase());
                  return (
                    <div key={k} className="contents">
                      <dt className="font-medium text-kumo-subtle">{metaLabel}</dt>
                      <dd className="break-all font-mono text-kumo-strong">
                        {k === 'sql_hash' ? <Link className="text-kumo-link hover:underline" to={`/queries/${v}`}>{String(v)}</Link> : v}
                      </dd>
                    </div>
                  );
                })}
              </dl>
              {spans.length > 1 && index >= 0 && (
                <div className="flex items-center justify-between border-t border-kumo-hairline pt-4">
                  <span className="text-xs tabular-nums text-kumo-subtle">Span {index + 1} of {spans.length}</span>
                  <div className="flex items-center gap-2.5">
                    <Button variant="secondary" size="sm" icon={CaretLeftIcon} disabled={!prevSpan} onClick={() => prevSpan && onSelect(prevSpan)}>
                      Previous
                    </Button>
                    <Button variant="secondary" size="sm" disabled={!nextSpan} onClick={() => nextSpan && onSelect(nextSpan)}>
                      Next
                      <CaretRightIcon />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </Dialog>
    </Dialog.Root>
  );
}

const BREAKDOWN_COLORS: Record<SpanType | 'app', string> = {
  ...SPAN_COLORS,
  app: 'bg-indigo-500',
};

export default function TraceDetailPage() {
  const { traceId = '' } = useParams();
  const rowNav = useRowNavigate();
  const eventTypeId = useId();
  const [spanQuery, setSpanQuery] = useState('');
  const { data, error, loading } = useAsync(() => api.trace(traceId), [traceId], { keepPreviousData: true });
  const [search, setSearch] = useSearchParams();
  const { eventType, spanId, selected, visibleSpans } = traceView(search, data?.spans ?? []);
  const updateView = (values: Record<string, string | null>, replace = false) => {
    setSearch((previous) => updateTraceView(previous, values), { replace });
  };

  const spanBreakdown = useMemo(() => {
    const counts = new Map<SpanType, { count: number; totalMs: number }>();
    for (const span of data?.spans ?? []) {
      const entry = counts.get(span.type) ?? { count: 0, totalMs: 0 };
      entry.count++;
      entry.totalMs += span.duration_ms;
      counts.set(span.type, entry);
    }
    return [...counts.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs || b[1].count - a[1].count);
  }, [data?.spans]);

  const timeShare = useMemo(
    () => (data ? traceTimeBreakdown(data.spans, data.trace.duration_ms) : []),
    [data],
  );

  const filteredSpans = useMemo(() => filterSpansByQuery(visibleSpans, spanQuery), [visibleSpans, spanQuery]);

  if (error) return <ErrorState error={error} />;
  if (loading) return <Loading />;
  if (!data) {
    return (
      <>
        <PageHeader back={{ to: '/traces', label: 'Traces' }} title="Trace not found" />
        <Panel>
          <Empty
            icon={<GitBranchIcon size={32} className="text-kumo-subtle" />}
            description="This trace may have expired or belongs to another project."
          >
            Trace not found.
          </Empty>
        </Panel>
      </>
    );
  }

  const { trace, spans, capture, repeated_queries: repeated = [], user, related = [] } = data;
  const userLabel = user ? user.name || user.username || `#${user.id}` : trace.user ? `#${trace.user}` : '—';
  const queryTime = spans.filter((s) => s.type === 'query').reduce((a, s) => a + s.duration_ms, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ to: '/traces', label: 'Traces' }}
        documentTitle={trace.name}
        title={<span className="font-mono">{trace.name}</span>}
        subtitle={
          <span className="mt-1.5 flex flex-wrap items-center gap-2.5">
            <SourceBadge source={trace.execution_source} />
            <StatusBadge status={trace.status_code} source={trace.execution_source} />
            {trace.status && <Badge variant={trace.status === 'failed' ? 'error' : trace.status === 'processed' ? 'success' : 'warning'}>{trace.status}</Badge>}
            {trace.route_action && <span className="font-mono text-xs text-kumo-subtle">{trace.route_action}</span>}
            <span className="inline-flex items-center gap-1.5 rounded-md bg-kumo-recessed px-2.5 py-1 font-mono text-xs text-kumo-subtle">
              {trace.trace_id}
              <CopyButton text={trace.trace_id} label="Copy trace ID" toastMessage="Trace ID copied." className="size-5" />
            </span>
          </span>
        }
      />

      <CardTray>
        <section className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Duration" icon={<TimerIcon size={13} />} value={ms(trace.duration_ms)} hint={`${spans.length} span${spans.length === 1 ? '' : 's'}`} tone={trace.duration_ms > 2000 ? 'bad' : trace.duration_ms > 500 ? 'warn' : 'default'} />
          <Stat label="Queries" icon={<DatabaseIcon size={13} />} value={trace.query_count} hint={`${ms(queryTime)} in database`} />
          <Stat label="Exceptions" icon={<BugIcon size={13} />} value={trace.exception_count} hint={trace.exception_count ? 'captured in trace' : 'clean execution'} tone={trace.exception_count ? 'bad' : 'good'} />
          <Stat label="Peak memory" icon={<CpuIcon size={13} />} value={trace.peak_memory_usage ? bytes(trace.peak_memory_usage) : '—'} />
        </section>
      </CardTray>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl border border-kumo-hairline bg-kumo-elevated/55 px-5 py-4 text-xs sm:grid-cols-4 sm:px-6">
        <div>
          <dt className="flex items-center gap-1.5 font-medium text-kumo-subtle"><UserIcon size={13} aria-hidden />User</dt>
          <dd className="mt-1 truncate text-kumo-strong">
            {userLabel}
            {user?.username && user.name && <span className="ml-1.5 text-kumo-subtle">({user.username})</span>}
          </dd>
        </div>
        <div>
          <dt className="flex items-center gap-1.5 font-medium text-kumo-subtle"><CloudIcon size={13} aria-hidden />Environment</dt>
          <dd className="mt-1 truncate text-kumo-strong">{trace.environment || 'Unknown'}</dd>
        </div>
        <div>
          <dt className="flex items-center gap-1.5 font-medium text-kumo-subtle"><HardDrivesIcon size={13} aria-hidden />Server</dt>
          <dd className="mt-1 truncate font-mono text-kumo-strong">{trace.server || '—'}</dd>
        </div>
        <div>
          <dt className="flex items-center gap-1.5 font-medium text-kumo-subtle"><ClockIcon size={13} aria-hidden />Recorded at</dt>
          <dd className="mt-1 truncate font-mono tabular-nums text-kumo-strong">{new Date(trace.timestamp).toLocaleString()}</dd>
        </div>
      </dl>

      {capture && (!capture.records_available || capture.dropped_records > 0) && (
        <Banner
          variant="alert"
          icon={<WarningIcon />}
          title="Incomplete trace details"
          description={!capture.records_available
            ? 'Stored trace events are unavailable for this trace. Summary metadata may still be available; an empty timeline does not mean no events occurred.'
            : `Storage limits reported ${capture.dropped_records} dropped events. The timeline shows only retained events.`}
        />
      )}

      {(repeated.length > 0 || (trace.lazy_loads ?? 0) > 0) && (
        <Panel
          className="border-kumo-warning/40"
          title={
            <span className="flex items-center gap-2.5 text-kumo-warning">
              <WarningIcon size={17} />
              <span>Possible N+1 queries</span>
              {(trace.lazy_loads ?? 0) > 0 && <Badge variant="warning">{trace.lazy_loads} lazy loads</Badge>}
            </span>
          }
        >
          {repeated.length > 0 ? (
            <ul className="divide-y divide-kumo-hairline">
              {repeated.map((q) => (
                /* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard navigation is provided by the inner Link */
                <li
                  key={q.sql_hash}
                  onClick={rowNav(`/queries/${q.sql_hash}`)}
                  className="flex cursor-pointer items-center justify-between gap-4 px-6 py-3.5 text-xs transition-colors hover:bg-kumo-tint/50"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <Badge variant="warning" className="shrink-0 font-mono">{q.count}×</Badge>
                    <Link to={`/queries/${q.sql_hash}`} className="truncate hover:underline">
                      <Sql sql={q.sql} />
                    </Link>
                  </div>
                  <span className="shrink-0 font-mono tabular-nums text-kumo-warning">{ms(q.total_ms)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-6 py-4 text-xs text-kumo-subtle">
              Detected {trace.lazy_loads} Eloquent lazy load{trace.lazy_loads === 1 ? '' : 's'} during this execution.
            </div>
          )}
        </Panel>
      )}

      {related.length > 0 && (
        <Panel
          title={
            <span className="flex items-center gap-2">
              <GitForkIcon size={16} className="text-kumo-subtle" aria-hidden />
              <span>{related.some((r) => r.trace_id === trace.origin_trace_id) ? 'Dispatched by' : 'Dispatched jobs'}</span>
            </span>
          }
        >
          <ul className="divide-y divide-kumo-hairline">
            {related.map((r) => (
              /* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard navigation is provided by the inner Link */
              <li
                key={r.trace_id}
                onClick={rowNav(`/traces/${r.trace_id}`)}
                className="flex cursor-pointer items-center gap-3.5 px-6 py-3.5 text-sm transition-colors hover:bg-kumo-tint/50"
              >
                <SourceBadge source={r.execution_source} />
                <Link className="truncate font-mono text-xs text-kumo-link hover:underline" to={`/traces/${r.trace_id}`}>{r.name}</Link>
                {r.status && <Badge variant={r.status === 'failed' ? 'error' : r.status === 'processed' ? 'success' : 'warning'}>{r.status}</Badge>}
                <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-kumo-subtle">{ms(r.duration_ms)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel
        title={
          <span className="flex items-center gap-2.5">
            <span>Timeline</span>
            <span className="text-xs font-normal text-kumo-subtle">
              {filteredSpans.length === spans.length ? `${spans.length} spans` : `${filteredSpans.length} of ${spans.length} spans`}
            </span>
          </span>
        }
        actions={
          <InputGroup size="sm" className="w-52 sm:w-64">
            <InputGroup.Addon align="start"><MagnifyingGlassIcon className="text-kumo-subtle" /></InputGroup.Addon>
            <InputGroup.Input
              value={spanQuery}
              onChange={(e) => setSpanQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && spanQuery) setSpanQuery(''); }}
              placeholder="Filter spans…"
              aria-label="Filter spans"
            />
            {spanQuery && (
              <InputGroup.Addon align="end">
                <button
                  type="button"
                  onClick={() => setSpanQuery('')}
                  aria-label="Clear span search"
                  className="grid size-4 place-items-center rounded text-kumo-subtle hover:text-kumo-strong"
                >
                  <XIcon size={12} />
                </button>
              </InputGroup.Addon>
            )}
          </InputGroup>
        }
      >
        {timeShare.length > 0 && (
          <div className="border-b border-kumo-hairline px-5 py-4 sm:px-6">
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-kumo-fill">
              {timeShare.map((segment) => (
                <Tooltip key={segment.key} asChild content={`${segment.label}: ${ms(segment.ms)} (${segment.percent.toFixed(1)}%)`}>
                  <div
                    className={cn('h-full transition-opacity hover:opacity-85', BREAKDOWN_COLORS[segment.key])}
                    style={{ width: `${Math.max(1.5, segment.percent)}%` }}
                  />
                </Tooltip>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-kumo-subtle">
              {timeShare.map((segment) => (
                <span key={segment.key} className="inline-flex items-center gap-2">
                  <span className={cn('size-2.5 rounded-full', BREAKDOWN_COLORS[segment.key])} />
                  <span>{segment.label}</span>
                  <span className="font-mono tabular-nums text-kumo-default">{ms(segment.ms)}</span>
                  <span className="tabular-nums">({segment.percent.toFixed(0)}%)</span>
                </span>
              ))}
            </div>
          </div>
        )}
        {spanBreakdown.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-kumo-hairline bg-kumo-elevated/40 px-5 py-3.5 sm:px-6" role="group" aria-label="Filter spans by type">
            <button
              id={eventTypeId}
              type="button"
              aria-pressed={!eventType}
              onClick={() => updateView({ type: null, span: null })}
              className={cn(
                'inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
                !eventType
                  ? 'border-kumo-line bg-kumo-base font-medium text-kumo-strong shadow-2xs'
                  : 'border-transparent text-kumo-subtle hover:bg-kumo-tint/60 hover:text-kumo-default',
              )}
            >
              <span>All</span>
              <span className="font-mono text-[11px] text-kumo-subtle">{spans.length}</span>
            </button>
            {spanBreakdown.map(([type, stats]) => {
              const active = eventType === type;
              const SpanIcon = SPAN_ICONS[type];
              return (
                <button
                  key={type}
                  type="button"
                  aria-pressed={active}
                  onClick={() => updateView({ type: active ? null : type, span: null })}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
                    active
                      ? 'border-kumo-line bg-kumo-base font-medium text-kumo-strong shadow-2xs'
                      : 'border-transparent text-kumo-subtle hover:bg-kumo-tint/60 hover:text-kumo-default',
                  )}
                >
                  <span className={cn('size-2 rounded-full', SPAN_COLORS[type])} />
                  <SpanIcon size={13} className="shrink-0" />
                  <span>{SPAN_LABELS[type]}</span>
                  <span className="font-mono text-[11px] text-kumo-subtle">
                    {stats.count}{stats.totalMs > 0 ? ` · ${ms(stats.totalMs)}` : ''}
                  </span>
                </button>
              );
            })}
            {eventType && !spanBreakdown.some(([t]) => t === eventType) && (
              <button
                type="button"
                aria-pressed="true"
                onClick={() => updateView({ type: null, span: null })}
                className="inline-flex items-center gap-2 rounded-lg border border-kumo-line bg-kumo-base px-2.5 py-1.5 text-xs font-medium text-kumo-strong"
              >
                <span>{eventType}</span>
                <XIcon size={11} />
              </button>
            )}
          </div>
        )}
        <div className="p-6">
          {spanId && !selected && (
            <div role="status" className="mb-5 flex items-center justify-between gap-3 rounded-lg border border-kumo-hairline bg-kumo-elevated px-4 py-2.5 text-xs text-kumo-subtle">
              <span>This event is no longer available in the stored trace.</span>
              <Button variant="ghost" size="xs" onClick={() => updateView({ span: null }, true)}>Dismiss</Button>
            </div>
          )}
          {filteredSpans.length ? (
            <Waterfall spans={filteredSpans} total={trace.duration_ms} onSelect={(span) => updateView({ tab: 'timeline', span: span.id })} selected={selected?.id} />
          ) : (
            <Empty
              icon={<GitBranchIcon size={32} className="text-kumo-subtle" />}
              action={
                eventType || spanQuery ? (
                  <Button variant="secondary" size="sm" onClick={() => { setSpanQuery(''); updateView({ type: null, span: null }); }}>
                    Reset span filters
                  </Button>
                ) : undefined
              }
            >
              {eventType || spanQuery ? 'No spans match these filters.' : 'No spans recorded for this trace.'}
            </Empty>
          )}
        </div>
      </Panel>

      <SpanSheet
        fallbackId={eventTypeId}
        span={selected}
        spans={filteredSpans}
        onSelect={(span) => updateView({ tab: 'timeline', span: span.id }, true)}
        onClose={() => updateView({ span: null }, true)}
      />
    </div>
  );
}

