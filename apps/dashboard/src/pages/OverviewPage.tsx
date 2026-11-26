import Link from '@/components/ScopedLink';
import { BarChart, LineChart, MetricChartCard, rangeFooterBounds } from '@/components/charts';
import { CardTray, ErrorState, MethodBadge, PageHeader, PageSkeleton, Sql } from '@/components/common';
import { Badge } from '@cloudflare/kumo/components/badge';
import {
  AppWindowIcon,
  CheckCircleIcon,
  DatabaseIcon,
  PulseIcon,
  UsersIcon,
} from '@phosphor-icons/react';
import { api, useAsync } from '@/lib/api';
import { bucketTime, compact, ms } from '@/lib/format';
import { useRange, rangeLabel } from '@/lib/range';
import { splitClassName } from '@/lib/ui-helpers';
import type { ReactNode } from 'react';

function splitRoute(route: string): { method: string | null; path: string } {
  const match = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i.exec(route);
  return match ? { method: match[1].toUpperCase(), path: match[2] } : { method: null, path: route };
}

function StatusCard({
  badge,
  headline,
  viewTo,
  children,
}: {
  badge: string;
  headline: string;
  viewTo: string;
  children: ReactNode;
}) {
  return (
    <div
      data-slot="card"
      className="flex flex-col justify-between overflow-hidden rounded-lg border border-neutral-200 bg-white p-5 shadow-md shadow-black/[0.04] dark:border-white/[0.06] dark:bg-white/[0.02] dark:shadow-black/20"
    >
      <div>
        <span className="inline-block rounded bg-neutral-100 px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wider text-neutral-600 dark:bg-white/10 dark:text-neutral-300">
          {badge}
        </span>
        <h3 className="mt-4 text-lg font-semibold leading-snug tracking-tight text-neutral-900 dark:text-white">
          {headline}
        </h3>
        <div className="mt-4">{children}</div>
      </div>
      <div className="mt-5 flex justify-end">
        <Link
          to={viewTo}
          className="inline-flex h-7 items-center rounded-md border border-neutral-200 bg-white px-2.5 text-xs font-medium text-neutral-700 transition-colors hover:border-blue-500 hover:text-neutral-900 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-neutral-300 dark:hover:border-white/15 dark:hover:text-white"
        >
          View
        </Link>
      </div>
    </div>
  );
}

export default function OverviewPage() {
  const { range } = useRange();
  const { data, error, loading, fetching } = useAsync(() => api.overview(range), [range], { keepPreviousData: true });
  const exceptions = useAsync(() => api.exceptions(range), [range], { keepPreviousData: true });
  const queries = useAsync(() => api.queries(range), [range], { keepPreviousData: true });
  const jobs = useAsync(() => api.events('/jobs', range), [range], { keepPreviousData: true });
  const users = useAsync(() => api.events('/users', range), [range], { keepPreviousData: true });

  if (error) return <ErrorState error={error} />;
  if (loading || !data) return <PageSkeleton />;

  const bounds = rangeFooterBounds(range);
  const windowLabel = rangeLabel(range);
  const totalErrors = data.series.reduce((sum, s) => sum + s.errors, 0);
  const okRequests = Math.max(0, data.requests - totalErrors);
  const nonZeroP95 = data.series.filter((s) => s.p95_ms > 0);
  const avgDuration = nonZeroP95.length ? nonZeroP95.reduce((sum, s) => sum + s.p95_ms, 0) / nonZeroP95.length : 0;

  const slowRoutes = data.top_routes.filter((r) => r.p95_ms > 500);
  const jobsSummary = jobs.data?.summary ?? {};
  const jobsRows = jobs.data?.data ?? [];
  const jobsAttempts = Number(jobsSummary.attempts ?? 0);
  const jobsFailed = Number(jobsSummary.failed ?? 0);
  const jobsReleased = Number(jobsSummary.released ?? 0);
  const jobsProcessed = Math.max(0, jobsAttempts - jobsFailed - jobsReleased);
  const jobsBarSeries = jobsRows.slice(0, 12).map((j) => ({
    label: splitClassName(j.key).short,
    value: Number(j.attempts ?? j.count ?? 0),
    warn: Number(j.released ?? 0),
    highlight: Number(j.failed ?? 0),
  }));

  const usersSummary = users.data?.summary ?? {};
  const usersRows = users.data?.data ?? [];
  const authUsersCount = Number(usersSummary.users ?? usersRows.length);
  const userTracesCount = Number(usersSummary.traces ?? 0);
  const userExceptionsCount = Number(usersSummary.exceptions ?? 0);
  const usersBarSeries = usersRows.slice(0, 12).map((u) => ({
    label: u.name ? String(u.name) : `#${u.key}`,
    value: Number(u.count ?? 0),
    highlight: Number(u.exceptions ?? 0),
  }));

  const slowestQueries = queries.data ? [...queries.data].sort((a, b) => b.p95_ms - a.p95_ms).slice(0, 3) : [];

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" />

      {/* Tray 1: Activity (Requests + Duration) matching capture Dashboard 1:1 */}
      <CardTray
        title="Activity"
        icon={<PulseIcon size={13} />}
        action={{ to: '/requests', label: 'Requests' }}
      >
        <div className="grid grid-cols-1 gap-2 [&>*]:min-w-0 xl:grid-cols-2">
          <MetricChartCard
            fetching={!loading && fetching}
            title="Requests"
            value={compact(data.requests)}
            metrics={[
              { label: '1/2/3/4XX', value: compact(okRequests), tone: 'neutral' },
              { label: '5XX', value: compact(totalErrors), tone: 'error' },
            ]}
          >
            <BarChart
              bounds={bounds}
              series={data.series.map((s) => ({ label: bucketTime(s.ts, range), value: s.requests, highlight: s.errors }))}
            />
          </MetricChartCard>
          <MetricChartCard
            fetching={!loading && fetching}
            title="Duration"
            value={data.p95_ms > 0 ? ms(data.p95_ms) : '—'}
            metrics={[
              { label: 'AVG', value: avgDuration > 0 ? ms(avgDuration) : '—', tone: 'charcoal' },
              { label: 'P95', value: data.p95_ms > 0 ? ms(data.p95_ms) : '—', tone: 'alert' },
            ]}
          >
            <LineChart
              bounds={bounds}
              values={data.series.map((s) => s.p95_ms)}
              labels={data.series.map((s) => bucketTime(s.ts, range))}
              format={ms}
            />
          </MetricChartCard>
        </div>
      </CardTray>

      {/* Tray 2: Application (Exceptions CardStatus + Top Routes + Jobs MetricChartCard) */}
      <CardTray
        title="Application"
        icon={<AppWindowIcon size={13} />}
        action={{ to: '/jobs', label: 'Jobs' }}
      >
        <div className="grid grid-cols-1 gap-2 [&>*]:min-w-0 md:grid-cols-2 xl:grid-cols-3">
          <StatusCard
            badge="Exceptions"
            headline={
              data.exceptions === 0
                ? `No exceptions reported in the ${windowLabel}.`
                : `${compact(data.exceptions)} exception${data.exceptions === 1 ? '' : 's'} reported in the ${windowLabel}.`
            }
            viewTo="/exceptions"
          >
            {data.exceptions === 0 || !exceptions.data?.length ? (
              <div className="flex justify-center py-6">
                <div className="grid size-24 place-items-center rounded-full border-2 border-dashed border-emerald-400/70 text-emerald-500">
                  <CheckCircleIcon size={32} />
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {exceptions.data.slice(0, 3).map((e) => (
                  <Link
                    key={e.group}
                    to={`/exceptions/${e.group}`}
                    className="block rounded-md border border-neutral-200/80 bg-neutral-50/40 px-3 py-2 transition-colors hover:border-blue-500 hover:bg-white dark:border-white/[0.07] dark:bg-white/[0.02] dark:hover:border-white/20"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-xs font-medium text-kumo-danger">
                        {splitClassName(e.class).short}
                      </span>
                      <Badge variant={e.handled ? 'secondary' : 'error'} className="shrink-0 tabular-nums">
                        {compact(e.count)}×
                      </Badge>
                    </div>
                    <div title={e.message} className="mt-0.5 truncate text-xs text-kumo-subtle">
                      {e.message}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </StatusCard>

          <StatusCard
            badge="Routes"
            headline={
              data.top_routes.length === 0
                ? `No routes recorded in the ${windowLabel}.`
                : slowRoutes.length > 0
                  ? `${slowRoutes.length} slow route${slowRoutes.length === 1 ? '' : 's'} (>500ms) in the ${windowLabel}.`
                  : `${data.top_routes.length} active route${data.top_routes.length === 1 ? '' : 's'} in the ${windowLabel}.`
            }
            viewTo="/requests"
          >
            {data.top_routes.length === 0 ? (
              <div className="flex justify-center py-6">
                <div className="grid size-24 place-items-center rounded-full border-2 border-dashed border-neutral-200 text-neutral-400 dark:border-white/10">
                  <PulseIcon size={28} />
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {data.top_routes.slice(0, 4).map((r) => {
                  const { method, path } = splitRoute(r.route);
                  const target = `/traces?${new URLSearchParams({ q: r.route, source: 'request' })}`;
                  return (
                    <Link
                      key={r.route}
                      to={target}
                      className="flex items-center justify-between gap-2 rounded-md border border-neutral-200/80 bg-neutral-50/40 px-3 py-2 transition-colors hover:border-blue-500 hover:bg-white dark:border-white/[0.07] dark:bg-white/[0.02] dark:hover:border-white/20"
                    >
                      <span className="inline-flex min-w-0 items-center gap-2">
                        {method && <MethodBadge method={method} />}
                        <span title={r.route} className="truncate font-mono text-xs text-neutral-900 dark:text-white">
                          {path}
                        </span>
                      </span>
                      <span
                        className={`shrink-0 font-mono text-xs tabular-nums ${
                          r.p95_ms > 500 ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-neutral-500 dark:text-neutral-400'
                        }`}
                      >
                        {ms(r.p95_ms)}
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </StatusCard>

          <MetricChartCard
            fetching={!jobs.loading && jobs.fetching}
            title="Jobs"
            value={compact(jobsAttempts)}
            metrics={[
              { label: 'FAILED', value: compact(jobsFailed), tone: 'error' },
              { label: 'PROCESSED', value: compact(jobsProcessed), tone: 'neutral' },
              { label: 'RELEASED', value: compact(jobsReleased), tone: 'alert' },
            ]}
          >
            <BarChart bounds={bounds} series={jobsBarSeries} unit="attempts" />
          </MetricChartCard>
        </div>
      </CardTray>

      {/* Tray 3: Users & Database */}
      <CardTray
        title="Users"
        icon={<UsersIcon size={13} />}
        action={{ to: '/users', label: 'Users' }}
      >
        <div className="grid grid-cols-1 gap-2 [&>*]:min-w-0 md:grid-cols-2 xl:grid-cols-3">
          <MetricChartCard
            fetching={!users.loading && users.fetching}
            title="Authenticated Users"
            value={compact(authUsersCount)}
            metrics={[
              { label: 'TRACES', value: compact(userTracesCount), tone: 'success' },
              { label: 'EXCEPTIONS', value: compact(userExceptionsCount), tone: 'error' },
            ]}
          >
            <BarChart bounds={bounds} series={usersBarSeries} unit="traces" />
          </MetricChartCard>

          <StatusCard
            badge="Queries"
            headline={
              data.slow_queries > 0
                ? `${compact(data.slow_queries)} slow quer${data.slow_queries === 1 ? 'y' : 'ies'} (>100ms).`
                : slowestQueries.length > 0
                  ? `No slow queries (>100ms) in the ${windowLabel}.`
                  : `No queries recorded in the ${windowLabel}.`
            }
            viewTo="/queries"
          >
            {slowestQueries.length === 0 ? (
              <div className="flex justify-center py-6">
                <div className="grid size-24 place-items-center rounded-full border-2 border-dashed border-emerald-400/70 text-emerald-500">
                  <DatabaseIcon size={28} />
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {slowestQueries.map((q) => (
                  <Link
                    key={q.sql_hash}
                    to={`/queries/${q.sql_hash}`}
                    className="block rounded-md border border-neutral-200/80 bg-neutral-50/40 px-3 py-2 transition-colors hover:border-blue-500 hover:bg-white dark:border-white/[0.07] dark:bg-white/[0.02] dark:hover:border-white/20"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate">
                        <Sql sql={q.sql} />
                      </span>
                      <span className="shrink-0 font-mono text-xs font-medium tabular-nums text-amber-600 dark:text-amber-400">
                        {ms(q.p95_ms)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                      <span>{q.connection}</span>
                      <span>{compact(q.calls)} calls</span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </StatusCard>

          <StatusCard
            badge="Active Users"
            headline={
              usersRows.length > 0
                ? `${compact(authUsersCount)} active user${authUsersCount === 1 ? '' : 's'} in the ${windowLabel}.`
                : `No authenticated users in the ${windowLabel}.`
            }
            viewTo="/users"
          >
            {usersRows.length === 0 ? (
              <div className="flex justify-center py-6">
                <div className="grid size-24 place-items-center rounded-full border-2 border-dashed border-neutral-200 text-neutral-400 dark:border-white/10">
                  <UsersIcon size={28} />
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {usersRows.slice(0, 4).map((u) => (
                  <Link
                    key={u.key}
                    to={`/users/${encodeURIComponent(u.key)}`}
                    className="flex items-center justify-between gap-2 rounded-md border border-neutral-200/80 bg-neutral-50/40 px-3 py-2 transition-colors hover:border-blue-500 hover:bg-white dark:border-white/[0.07] dark:bg-white/[0.02] dark:hover:border-white/20"
                  >
                    <span className="min-w-0 truncate text-xs font-medium text-neutral-900 dark:text-white">
                      {u.name ? String(u.name) : `User #${u.key}`}
                    </span>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
                      {compact(Number(u.count ?? 0))} traces
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </StatusCard>
        </div>
      </CardTray>
    </div>
  );
}
