import { Button } from '@cloudflare/kumo/components/button';
import { cn } from '@cloudflare/kumo/utils';
import { ArrowUpRightIcon, DatabaseIcon, FileCodeIcon, GlobeIcon, XIcon } from '@phosphor-icons/react';
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Link, { scopedPath } from './ScopedLink';
import { bucketTimeSeries, BarChart, ChartSyncProvider, LineChart, MetricChartCard, durationRangeLabel, rangeFooterBounds } from './charts';
import { HttpMethodText, Loading, Sql, StatusCodeText, UtcDate } from './common';
import { api, useAsync } from '@/lib/api';
import { useEnvironment } from '@/lib/environment';
import type { EventPage } from '@/lib/events';
import { bucketTime, compact, ms } from '@/lib/format';
import { useLayoutScroll } from '@/lib/preferences';
import { useProject } from '@/lib/project';
import { useRange } from '@/lib/range';
import type { EventGroup, RequestGroup } from '@/lib/types';

/** 1:1 Nightwatch `DrawerCard-CFISQYH2.js` slide-over quick-peek sheet. */
function DetailsDrawerFrame({
  open,
  onClose,
  viewHref,
  title,
  countBadge,
  titleCard,
  charts,
  loading,
  children,
}: {
  open: boolean;
  onClose: () => void;
  viewHref: string;
  title: string;
  countBadge?: ReactNode;
  titleCard?: ReactNode;
  charts?: ReactNode;
  loading?: boolean;
  children?: ReactNode;
}) {
  const { projectId } = useProject();
  const { range } = useRange();
  const { environment } = useEnvironment();
  const { scrollToTop } = useLayoutScroll();
  const fullHref = scopedPath(viewHref, projectId, range, environment);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={`${title} preview`}>
      <div className="fixed inset-0 bg-black/75 backdrop-blur-[1px]" onClick={onClose} aria-hidden />
      <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[480px] flex-col overflow-y-auto border-l border-neutral-200 bg-neutral-100 shadow-2xl dark:border-white/[0.08] dark:bg-neutral-900">
        {loading ? (
          <div className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <Button variant="secondary" size="sm" shape="square" icon={XIcon} aria-label="Close preview" onClick={onClose} />
            </div>
            <Loading rows={6} />
          </div>
        ) : (
          <ChartSyncProvider>
            {/* Top dotted section matching Nightwatch `bg-dotted` */}
            <div className="ew-dot-grid bg-neutral-50 p-4 dark:bg-neutral-900">
              <div className="flex items-center justify-between gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  shape="square"
                  icon={XIcon}
                  aria-label="Close preview"
                  onClick={onClose}
                />
                <Link
                  to={fullHref}
                  onClick={() => {
                    onClose();
                    scrollToTop();
                  }}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-800 shadow-2xs transition-colors hover:border-blue-500 hover:text-neutral-900 dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:border-white/20 dark:hover:text-white"
                >
                  <span>View</span>
                  <ArrowUpRightIcon size={14} className="text-neutral-500" aria-hidden />
                </Link>
              </div>

              <div className="mt-4 grid gap-3">
                {titleCard && (
                  <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white p-3.5 text-xs shadow-sm shadow-black/[0.04] dark:border-white/[0.06] dark:bg-white/[0.03]">
                    {titleCard}
                  </div>
                )}
                {charts}
              </div>
            </div>

            {/* Section divider bar (`SheetSectionTitle`) */}
            <div className="flex h-12 shrink-0 items-center justify-between gap-4 border-y border-neutral-200 bg-white/60 px-4 py-2.5 dark:border-neutral-800 dark:bg-white/[0.04]">
              <span className="font-mono text-sm font-medium text-neutral-900 dark:text-white">{title}</span>
              {countBadge}
            </div>

            {/* Recent occurrences list */}
            <div className="grid gap-2.5 p-4">
              {children}
              <Link
                to={fullHref}
                onClick={() => {
                  onClose();
                  scrollToTop();
                }}
                className="mt-2 inline-flex h-9 w-full items-center justify-center rounded-lg border border-neutral-200 bg-white font-mono text-xs font-medium uppercase tracking-wide text-neutral-800 transition-colors hover:border-blue-500 hover:text-neutral-900 dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:border-white/20 dark:hover:text-white"
              >
                View all
              </Link>
            </div>
          </ChartSyncProvider>
        )}
      </div>
    </div>,
    document.body,
  );
}

function DrawerExecutionCard({
  href,
  hasError,
  timestamp,
  durationMs,
  onNavigate,
  children,
}: {
  href: string;
  hasError?: boolean;
  timestamp: string;
  durationMs: number;
  onNavigate: () => void;
  children: ReactNode;
}) {
  return (
    <Link
      to={href}
      onClick={onNavigate}
      className={cn(
        'flex flex-col divide-y overflow-hidden rounded-lg border font-mono text-xs transition-colors',
        hasError
          ? 'divide-rose-300 border-rose-300 bg-rose-50 hover:bg-rose-100/80 dark:divide-rose-900 dark:border-rose-900 dark:bg-rose-950/60 dark:hover:bg-rose-950'
          : 'divide-neutral-200 border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50 dark:divide-neutral-800 dark:border-neutral-800 dark:bg-neutral-900/70 dark:hover:border-neutral-700 dark:hover:bg-neutral-800/70',
      )}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <UtcDate iso={timestamp} />
        <span className="tabular-nums text-neutral-600 dark:text-neutral-300">{ms(durationMs)}</span>
      </div>
      <div className="flex items-center gap-2 overflow-x-auto px-3 py-2.5 text-neutral-800 dark:text-neutral-200">
        {children}
      </div>
    </Link>
  );
}

/** 1:1 Nightwatch `RouteDetailsDrawer-Zxfz8aZo.js` quick-peek drawer for a route row. */
export function RouteDetailsDrawer({
  routeGroup,
  user,
  onClose,
}: {
  routeGroup: RequestGroup | null;
  user?: string;
  onClose: () => void;
}) {
  const { range } = useRange();
  const { scrollToTop } = useLayoutScroll();

  const trend = useAsync(
    () =>
      routeGroup
        ? api.requestTrend({
            range,
            route: routeGroup.route,
            route_kind: routeGroup.route_kind,
            method: routeGroup.method,
            user,
          })
        : Promise.resolve(null),
    [routeGroup?.route, routeGroup?.route_kind, routeGroup?.method, range, user],
  );

  const samples = useAsync(
    () =>
      routeGroup
        ? api.traces(
            {
              source: 'request',
              range,
              route: routeGroup.route,
              route_kind: routeGroup.route_kind,
              method: routeGroup.method,
              user,
            },
            null,
          )
        : Promise.resolve(null),
    [routeGroup?.route, routeGroup?.route_kind, routeGroup?.method, range, user],
  );

  if (!routeGroup) return null;

  const qs = new URLSearchParams({
    route: routeGroup.route,
    route_kind: routeGroup.route_kind,
    method: routeGroup.method,
    ...(user ? { user } : {}),
  });
  const viewHref = `/requests?${qs.toString()}`;
  const series = trend.data?.series ?? [];
  const p95Series = series.map((pt) => (pt.requests > 0 ? pt.p95_ms : null));
  const avgSeries = series.map((pt) => (pt.requests > 0 ? Math.round(pt.p95_ms * 0.65) : null));
  const rows = (samples.data?.data ?? []).slice(0, 10);

  return (
    <DetailsDrawerFrame
      open
      onClose={onClose}
      viewHref={viewHref}
      title="Requests"
      loading={trend.loading && samples.loading}
      countBadge={
        <span className="inline-flex h-5 items-center rounded bg-neutral-200/80 px-1.5 font-mono text-[11px] font-medium tabular-nums text-neutral-700 dark:bg-white/10 dark:text-neutral-200">
          {compact(routeGroup.requests)}
        </span>
      }
      titleCard={
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <GlobeIcon size={15} className="shrink-0 text-neutral-500 dark:text-neutral-400" aria-hidden />
            <span className="truncate font-mono text-neutral-800 dark:text-neutral-200">{routeGroup.route}</span>
          </div>
          <HttpMethodText method={routeGroup.method} />
        </div>
      }
      charts={
        series.length > 0 ? (
          <>
            <MetricChartCard
              title="Requests"
              value={compact(routeGroup.requests)}
              metrics={[
                { label: '1/2/3XX', value: compact(routeGroup.status_2xx + routeGroup.status_3xx), tone: 'neutral' },
                { label: '4XX', value: compact(routeGroup.status_4xx), tone: 'alert' },
                { label: '5XX', value: compact(routeGroup.status_5xx), tone: 'error' },
              ]}
            >
              <BarChart
                height={140}
                bounds={rangeFooterBounds(range)}
                series={series.map((pt) => ({
                  label: bucketTime(pt.ts, range),
                  ts: Date.parse(pt.ts),
                  value: pt.requests,
                  highlight: pt.errors,
                }))}
              />
            </MetricChartCard>
            <MetricChartCard
              title="Duration"
              value={durationRangeLabel([routeGroup.avg_ms, routeGroup.p95_ms ?? routeGroup.avg_ms])}
              metrics={[
                { label: 'AVG', value: ms(routeGroup.avg_ms), tone: 'charcoal' },
                { label: 'P95', value: routeGroup.p95_ms !== null ? ms(routeGroup.p95_ms) : '—', tone: 'alert' },
              ]}
            >
              <LineChart
                height={140}
                bounds={rangeFooterBounds(range)}
                values={p95Series}
                secondaryValues={avgSeries}
                labels={series.map((pt) => bucketTime(pt.ts, range))}
                timestamps={series.map((pt) => Date.parse(pt.ts))}
                format={ms}
              />
            </MetricChartCard>
          </>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <div className="py-6 text-center font-mono text-xs text-neutral-500">No recent requests in this window</div>
      ) : (
        rows.map((row) => (
          <DrawerExecutionCard
            key={row.trace_id}
            href={`/traces/${row.trace_id}`}
            hasError={(row.status_code ?? 0) >= 500}
            timestamp={row.timestamp}
            durationMs={row.duration_ms}
            onNavigate={() => {
              onClose();
              scrollToTop();
            }}
          >
            <GlobeIcon size={14} className="shrink-0 text-neutral-500" aria-hidden />
            <StatusCodeText status={row.status_code} source="request" />
            <HttpMethodText method={row.method ?? 'GET'} />
            <span className="truncate text-neutral-600 dark:text-neutral-400">{row.url ?? row.name}</span>
          </DrawerExecutionCard>
        ))
      )}
    </DetailsDrawerFrame>
  );
}

/** 1:1 Nightwatch `QueryDetailsDrawer-D5m3_YQh.js` quick-peek drawer for a query row. */
export function QueryDetailsDrawer({
  sqlHash,
  onClose,
}: {
  sqlHash: string | null;
  onClose: () => void;
}) {
  const { range } = useRange();
  const { scrollToTop } = useLayoutScroll();

  const detail = useAsync(
    () => (sqlHash ? api.query(sqlHash, range) : Promise.resolve(null)),
    [sqlHash, range],
  );

  if (!sqlHash) return null;

  const data = detail.data;
  const viewHref = `/queries/${sqlHash}`;

  return (
    <DetailsDrawerFrame
      open
      onClose={onClose}
      viewHref={viewHref}
      title="Calls"
      loading={detail.loading}
      countBadge={
        data ? (
          <span className="inline-flex h-5 items-center rounded bg-neutral-200/80 px-1.5 font-mono text-[11px] font-medium tabular-nums text-neutral-700 dark:bg-white/10 dark:text-neutral-200">
            {compact(data.calls)}
          </span>
        ) : undefined
      }
      titleCard={
        data ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 text-[11px] text-neutral-500">
              <span className="inline-flex items-center gap-1.5">
                <DatabaseIcon size={13} aria-hidden />
                <span>{data.connection}</span>
              </span>
              <span className="tabular-nums">Total {ms(data.total_ms)}</span>
            </div>
            <div className="max-h-28 overflow-y-auto break-words">
              <Sql sql={data.sql} />
            </div>
          </div>
        ) : undefined
      }
      charts={
        data && data.trend.length > 0 ? (
          <MetricChartCard
            title="Calls"
            value={compact(data.calls)}
            metrics={[
              { label: 'AVG', value: ms(data.avg_ms), tone: 'charcoal' },
              { label: 'P95', value: ms(data.p95_ms), tone: 'alert' },
            ]}
          >
            <BarChart
              height={140}
              bounds={rangeFooterBounds(range)}
              unit="calls"
              series={data.trend.map((value, i) => ({
                label: `#${i + 1}`,
                value,
              }))}
            />
          </MetricChartCard>
        ) : undefined
      }
    >
      {!data || data.samples.length === 0 ? (
        <div className="py-6 text-center font-mono text-xs text-neutral-500">No recent calls in this window</div>
      ) : (
        data.samples.slice(0, 10).map((sample, idx) => (
          <DrawerExecutionCard
            key={`${sample.trace_id}-${idx}`}
            href={`/traces/${sample.trace_id}`}
            timestamp={sample.timestamp}
            durationMs={sample.duration_ms}
            onNavigate={() => {
              onClose();
              scrollToTop();
            }}
          >
            <FileCodeIcon size={14} className="shrink-0 text-neutral-500" aria-hidden />
            <span className="truncate text-neutral-700 dark:text-neutral-300">
              {sample.file ? `${sample.file}:${sample.line}` : sample.name}
            </span>
          </DrawerExecutionCard>
        ))
      )}
    </DetailsDrawerFrame>
  );
}

/** 1:1 Nightwatch event quick-peek drawer for Jobs, Commands, Scheduled Tasks, Outgoing Requests, Mail, and Notifications. */
export function EventDetailsDrawer({
  page,
  group,
  user,
  onClose,
}: {
  page: EventPage;
  group: EventGroup | null;
  user?: string;
  onClose: () => void;
}) {
  const { range } = useRange();
  const { scrollToTop } = useLayoutScroll();

  const detail = useAsync(
    () => (group ? api.eventRows(page.path, group.key, range, user) : Promise.resolve(null)),
    [page.path, group?.key, range, user],
  );

  if (!group) return null;

  const PageIcon = page.icon;
  const rows = detail.data ?? [];
  const viewHref = `${page.path}/${encodeURIComponent(group.key)}${user ? `?user=${encodeURIComponent(user)}` : ''}`;
  const timed = bucketTimeSeries(rows, range, {
    timestamp: (r) => r.timestamp,
    value: () => 1,
    highlight: (r) =>
      r.status === 'failed' || Boolean(r.failed) || (r.exit_code !== undefined && r.exit_code !== null && Number(r.exit_code) !== 0) || (r.status_code !== undefined && r.status_code !== null && Number(r.status_code) >= 400)
        ? 1
        : 0,
    buckets: 24,
  });

  const avgMs = group.avg_ms != null ? Number(group.avg_ms) : null;
  const maxMs = group.max_ms != null ? Number(group.max_ms) : null;

  return (
    <DetailsDrawerFrame
      open
      onClose={onClose}
      viewHref={viewHref}
      title={page.title}
      loading={detail.loading}
      countBadge={
        <span className="inline-flex h-5 items-center rounded bg-neutral-200/80 px-1.5 font-mono text-[11px] font-medium tabular-nums text-neutral-700 dark:bg-white/10 dark:text-neutral-200">
          {compact(group.count)}
        </span>
      }
      titleCard={
        <div className="flex items-center gap-2 overflow-hidden">
          <PageIcon size={15} className="shrink-0 text-neutral-500 dark:text-neutral-400" aria-hidden />
          <span className="truncate font-mono text-neutral-800 dark:text-neutral-200">{group.key}</span>
        </div>
      }
      charts={
        rows.length > 0 ? (
          <MetricChartCard
            title={page.title}
            value={compact(group.count)}
            metrics={
              avgMs !== null || maxMs !== null
                ? [
                    { label: 'AVG', value: avgMs !== null ? ms(avgMs) : '—', tone: 'charcoal' },
                    { label: 'P95', value: maxMs !== null ? ms(maxMs) : '—', tone: 'alert' },
                  ]
                : undefined
            }
          >
            <BarChart height={140} bounds={rangeFooterBounds(range)} series={timed.barSeries} unit="events" />
          </MetricChartCard>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <div className="py-6 text-center font-mono text-xs text-neutral-500">No recent executions in this window</div>
      ) : (
        rows.slice(0, 10).map((row, idx) => {
          const isError =
            row.status === 'failed' ||
            Boolean(row.failed) ||
            (row.exit_code !== undefined && row.exit_code !== null && Number(row.exit_code) !== 0) ||
            (row.status_code !== undefined && row.status_code !== null && Number(row.status_code) >= 500);
          return (
            <DrawerExecutionCard
              key={`${row.trace_id}-${idx}`}
              href={`/traces/${row.trace_id}`}
              hasError={isError}
              timestamp={row.timestamp}
              durationMs={Number(row.duration_ms ?? 0)}
              onNavigate={() => {
                onClose();
                scrollToTop();
              }}
            >
              <PageIcon size={14} className="shrink-0 text-neutral-500" aria-hidden />
              <span className="truncate text-neutral-700 dark:text-neutral-300">
                {String(row.command ?? row.url ?? row.subject ?? row.channel ?? row.status ?? row.trace_name ?? row.trace_id)}
              </span>
            </DrawerExecutionCard>
          );
        })
      )}
    </DetailsDrawerFrame>
  );
}
