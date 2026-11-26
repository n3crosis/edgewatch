import { useId, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import Link from '@/components/ScopedLink';
import {
  CopyButton,
  DescriptionList,
  DescriptionRow,
  Empty,
  ErrorState,
  HttpMethodText,
  Loading,
  PageHeader,
  Panel,
  SourceBadge,
  Sql,
  StatusBadge,
  UtcDate,
  useRowNavigate,
} from '@/components/common';
import Waterfall, { SPAN_COLORS, SPAN_ICONS, SPAN_LABELS } from '@/components/Waterfall';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Banner } from '@cloudflare/kumo/components/banner';
import { Button } from '@cloudflare/kumo/components/button';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { InputGroup } from '@cloudflare/kumo/components/input-group';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { cn } from '@cloudflare/kumo/utils';
import {
  ArrowUpRightIcon,
  CaretLeftIcon,
  CaretRightIcon,
  GitBranchIcon,
  GitForkIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import { api, useAsync } from '@/lib/api';
import { bytes, ms } from '@/lib/format';
import { traceView, updateTraceView } from '@/lib/trace-view';
import { filterSpansByQuery, traceTimeBreakdown } from '@/lib/ui-helpers';
import type { Span, SpanType } from '@/lib/types';

/** 1:1 Nightwatch `Show-CzNI7yfT.js` (`V`) URL formatter highlighting origin/path/query/hash. */
function FormattedUrl({ url, className }: { url: string; className?: string }) {
  try {
    const parsed = new URL(url);
    return (
      <span className={cn('font-mono text-sm', className)}>
        <span className="font-medium text-neutral-900 dark:text-white">
          {`${parsed.protocol}//${parsed.hostname}`}
        </span>
        <span className="text-neutral-900 dark:text-white">{parsed.pathname}</span>
        {parsed.search && <span className="text-neutral-500 dark:text-neutral-400">{parsed.search}</span>}
        {parsed.hash && <span className="text-neutral-500 dark:text-neutral-400">{parsed.hash}</span>}
      </span>
    );
  } catch {
    return <span className={cn('font-mono text-sm text-neutral-700 dark:text-neutral-300', className)}>{url}</span>;
  }
}

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
              <DescriptionList className="rounded-lg border border-neutral-200 bg-neutral-50/50 p-4 dark:border-white/[0.08] dark:bg-white/[0.02]">
                <DescriptionRow label="Start">+{ms(span.start_ms)}</DescriptionRow>
                <DescriptionRow label="Duration">{ms(span.duration_ms)}</DescriptionRow>
                {Object.entries(span.meta ?? {}).map(([k, v]) => (
                  <DescriptionRow key={k} label={k.replace(/_/g, ' ')}>
                    {k === 'sql_hash' ? (
                      <Link className="text-kumo-link hover:underline" to={`/queries/${v}`}>{String(v)}</Link>
                    ) : (
                      String(v)
                    )}
                  </DescriptionRow>
                ))}
              </DescriptionList>
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
      <div className="space-y-5">
        <PageHeader hideTelemetryControls back={{ to: '/requests', label: 'Requests' }} title="Trace not found" />
        <Empty description="This trace may have expired or belongs to another project">Trace not found</Empty>
      </div>
    );
  }

  const { trace, spans, capture, repeated_queries: repeated = [], user, related = [] } = data;
  const split = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i.exec(trace.name);
  const method = split ? split[1].toUpperCase() : null;
  const routePath = split ? split[2] : trace.name;
  const statusCode = Number(trace.status_code ?? 0);
  const globeTone =
    statusCode >= 500
      ? 'text-rose-500 dark:text-rose-400'
      : statusCode >= 400
        ? 'text-amber-600 dark:text-amber-500'
        : 'text-emerald-600 dark:text-emerald-500';

  const spanStats = (type: SpanType) => {
    const list = spans.filter((s) => s.type === type);
    const total = list.reduce((sum, s) => sum + s.duration_ms, 0);
    if (!list.length) return <span className="text-neutral-400">0 EVENTS</span>;
    return (
      <span>
        {list.length} <span className="text-neutral-400">{list.length === 1 ? 'EVENT' : 'EVENTS'}</span>
        {total > 0 && <span className="text-neutral-400"> / </span>}
        {total > 0 && <span>{ms(total)}</span>}
      </span>
    );
  };

  return (
    <div className="space-y-4 md:space-y-6 xl:space-y-10">
      <PageHeader
        hideTelemetryControls
        back={{ to: '/requests', label: 'Requests' }}
        documentTitle={trace.name}
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {method ? <HttpMethodText method={method} className="text-xl" /> : <SourceBadge source={trace.execution_source} />}
            <span className="font-mono">{routePath}</span>
          </span>
        }
      />

      {/* 1:1 Capture `Show-CzNI7yfT.js` Direct Card with status-colored Globe + Method + URL + 3-col DescriptionList + Events */}
      <div className="grid overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-md shadow-black/[0.04] dark:border-white/[0.06] dark:bg-white/[0.02]">
        <div className="border-b border-neutral-200/80 p-5 py-4 dark:border-white/5">
          <div className="float-left mt-[3px] mr-1.5 flex items-center gap-1.5 font-mono text-sm font-semibold">
            <GlobeIcon size={14} className={cn('shrink-0', globeTone)} aria-hidden />
            {method && <span className="text-neutral-900 dark:text-white">{method}</span>}
          </div>
          <FormattedUrl url={routePath} className="break-all" />
        </div>

        <div className="grid gap-10 p-5">
          <div className="grid grid-cols-1 gap-8 md:grid-cols-2 xl:grid-cols-3">
            <div className="flex-1">
              <DescriptionList>
                <DescriptionRow label="Date"><UtcDate iso={trace.timestamp} /></DescriptionRow>
                <DescriptionRow label="Status Code"><StatusBadge status={trace.status_code} source={trace.execution_source} /></DescriptionRow>
                <DescriptionRow label="Duration">{ms(trace.duration_ms)}</DescriptionRow>
              </DescriptionList>
            </div>
            <div className="flex-1">
              <DescriptionList>
                <DescriptionRow label="Server">{trace.server || '—'}</DescriptionRow>
                <DescriptionRow label="Peak Memory">{trace.peak_memory_usage ? bytes(trace.peak_memory_usage) : '—'}</DescriptionRow>
                <DescriptionRow label="Environment">{trace.environment || '—'}</DescriptionRow>
              </DescriptionList>
            </div>
            {(user || trace.user) && (
              <div className="flex-1 space-y-2">
                <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">User</h3>
                <DescriptionList>
                  {user?.name && <DescriptionRow label="Name">{user.name}</DescriptionRow>}
                  <DescriptionRow label="Username">
                    <Link
                      to={`/users/${encodeURIComponent(user?.id ?? trace.user ?? '')}`}
                      className="group inline-flex items-center gap-1.5 hover:underline"
                    >
                      <span>{user?.username ?? `#${user?.id ?? trace.user}`}</span>
                      <ArrowUpRightIcon size={12} className="text-neutral-500 group-hover:text-neutral-900 dark:group-hover:text-white" aria-hidden />
                    </Link>
                  </DescriptionRow>
                </DescriptionList>
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">Events</h3>
              <div className="inline-flex items-center divide-x divide-neutral-200 rounded border border-neutral-200 bg-white font-mono text-[11px] dark:divide-white/10 dark:border-white/10 dark:bg-white/[0.03]">
                <span className="px-2 py-0.5 text-neutral-500">
                  EVENTS <strong className="ml-1 font-medium text-neutral-900 dark:text-white">{spans.length}</strong>
                </span>
                <span className="px-2 py-0.5 text-neutral-500">
                  DURATION <strong className="ml-1 font-medium text-neutral-900 dark:text-white">{ms(trace.duration_ms)}</strong>
                </span>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-x-8 gap-y-2.5 md:grid-cols-2">
              <DescriptionList>
                <DescriptionRow label="Queries">{spanStats('query')}</DescriptionRow>
                <DescriptionRow label="Mail">{spanStats('mail')}</DescriptionRow>
                <DescriptionRow label="Cache">{spanStats('cache')}</DescriptionRow>
              </DescriptionList>
              <DescriptionList>
                <DescriptionRow label="Outgoing Requests">{spanStats('outgoing-request')}</DescriptionRow>
                <DescriptionRow label="Queued Jobs">{spanStats('queued-job')}</DescriptionRow>
                <DescriptionRow label="Exceptions">{spanStats('exception')}</DescriptionRow>
              </DescriptionList>
            </div>
          </div>
        </div>
      </div>

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
                  className="flex cursor-pointer items-center justify-between gap-4 px-5 py-3 text-xs transition-colors hover:bg-neutral-50 dark:hover:bg-white/[0.03]"
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
            <div className="px-5 py-4 text-xs text-kumo-subtle">
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
                className="flex cursor-pointer items-center gap-3.5 px-5 py-3 text-sm transition-colors hover:bg-neutral-50 dark:hover:bg-white/[0.03]"
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
            <span className="font-mono text-xs font-normal text-kumo-subtle">
              {filteredSpans.length === spans.length ? `${spans.length} spans` : `${filteredSpans.length} of ${spans.length} spans`}
            </span>
          </span>
        }
        actions={
          <InputGroup className="h-8 w-52 bg-white sm:w-64 dark:bg-white/[0.03]">
            <InputGroup.Addon align="start"><MagnifyingGlassIcon size={14} className="text-kumo-subtle" /></InputGroup.Addon>
            <InputGroup.Input
              value={spanQuery}
              onChange={(e) => setSpanQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && spanQuery) setSpanQuery(''); }}
              placeholder="Filter spans…"
              aria-label="Filter spans"
              className="h-8 text-sm"
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
          <div className="border-b border-kumo-hairline px-5 py-4">
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
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-kumo-subtle">
              {timeShare.map((segment) => (
                <span key={segment.key} className="inline-flex items-center gap-2">
                  <span className={cn('size-2 rounded-full', BREAKDOWN_COLORS[segment.key])} />
                  <span>{segment.label}</span>
                  <span className="font-mono tabular-nums text-kumo-default">{ms(segment.ms)}</span>
                  <span className="tabular-nums">({segment.percent.toFixed(0)}%)</span>
                </span>
              ))}
            </div>
          </div>
        )}
        {spanBreakdown.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-kumo-hairline bg-neutral-50/60 px-5 py-3 dark:bg-white/[0.02]" role="group" aria-label="Filter spans by type">
            <button
              id={eventTypeId}
              type="button"
              aria-pressed={!eventType}
              onClick={() => updateView({ type: null, span: null })}
              className={cn(
                'inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs transition-colors',
                !eventType
                  ? 'border-neutral-200 bg-white font-medium text-neutral-900 shadow-2xs dark:border-white/15 dark:bg-white/[0.06] dark:text-white'
                  : 'border-transparent text-kumo-subtle hover:bg-white/60 hover:text-kumo-default dark:hover:bg-white/[0.04]',
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
                    'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors',
                    active
                      ? 'border-neutral-200 bg-white font-medium text-neutral-900 shadow-2xs dark:border-white/15 dark:bg-white/[0.06] dark:text-white'
                      : 'border-transparent text-kumo-subtle hover:bg-white/60 hover:text-kumo-default dark:hover:bg-white/[0.04]',
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
          </div>
        )}
        <div className="p-5">
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
              variant="clean"
              icon={<GitBranchIcon size={28} className="text-kumo-subtle" />}
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
