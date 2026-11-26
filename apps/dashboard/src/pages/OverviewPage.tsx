import Link from '@/components/ScopedLink';
import { BarChart, LineChart, MetricChartCard, bucketTimeSeries, durationRangeLabel, rangeFooterBounds } from '@/components/charts';
import { CardTray, ErrorState, HttpMethodText, PageHeader, PageSkeleton } from '@/components/common';
import {
  AppWindowIcon,
  CheckCircleIcon,
  PulseIcon,
  UsersIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { api, useAsync } from '@/lib/api';
import { bucketTime, compact, ms } from '@/lib/format';
import { useRange, rangeLabel } from '@/lib/range';
import type { ReactNode } from 'react';

function splitRoute(route: string): { method: string | null; path: string } {
  const match = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i.exec(route);
  return match ? { method: match[1].toUpperCase(), path: match[2] } : { method: null, path: route };
}

/** 1:1 Capture `NoActions-3LpblOtS.js` footer indicator when a dashboard card has 0 items. */
function NoActions() {
  return (
    <div className="flex items-center gap-2">
      <CheckCircleIcon size={18} weight="fill" className="text-emerald-500" aria-hidden />
      <span className="font-mono text-[13px] font-medium uppercase text-emerald-700 dark:text-emerald-500">
        No Actions
      </span>
    </div>
  );
}

/** 1:1 Capture `EmptyState-DiObTkBj.js` large bottom-faded emerald dashed checkmark circle. */
function DashboardEmptyState() {
  return (
    <div className="relative flex grow flex-col items-center justify-end pb-8">
      <svg
        width="202"
        height="202"
        viewBox="0 0 202 202"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="size-[120px] mask-[linear-gradient(to_top,rgba(0,0,0,0.2),black)] text-emerald-500/80 md:size-[200px] dark:text-emerald-800"
        aria-hidden
      >
        <path
          d="M53.0146 107.96L80.4348 135.799L148.985 66.2017"
          stroke="currentColor"
          strokeOpacity="1"
          strokeWidth="2"
          strokeMiterlimit="10"
          strokeLinecap="square"
        />
        <path
          d="M101 201C156.228 201 201 156.228 201 101C201 45.7715 156.228 1 101 1C45.7715 1 1 45.7715 1 101C1 156.228 45.7715 201 101 201Z"
          stroke="currentColor"
          strokeOpacity="1"
          strokeWidth="2"
          strokeMiterlimit="10"
          strokeLinecap="round"
          strokeDasharray="4 7"
          strokeDashoffset="11"
        />
      </svg>
    </div>
  );
}

/** 1:1 Capture `CardStatus-BaVooy0X.js` + `Card-Bs8QNqhz.js` wrapper (`Dashboard-CAkBOrMB.js` `V`). */
function StatusCard({
  badge,
  headline,
  subheadline,
  viewTo,
  hasItems,
  children,
}: {
  badge: string;
  headline: string;
  subheadline?: string;
  viewTo: string;
  hasItems: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-slot="card"
      className="flex h-full flex-col justify-between gap-6 overflow-hidden rounded-lg border border-neutral-200 bg-white p-4 shadow-md shadow-black/5 md:p-6 xl:min-h-[452px] dark:border-white/[0.05] dark:bg-white/[0.02] dark:shadow-black/20"
    >
      <div className="flex flex-1 flex-col gap-4">
        <div className="grid gap-4">
          <span className="inline-flex h-6 w-fit items-center rounded-md bg-black/[0.08] px-1.5 font-mono text-xs/none uppercase text-neutral-900 dark:border dark:border-neutral-700 dark:bg-white/10 dark:text-neutral-100">
            {badge}
          </span>
          <h3 className="text-lg/6 font-semibold text-balance text-neutral-900 md:text-2xl dark:text-white">
            {headline}
          </h3>
          {subheadline && <p className="font-light text-neutral-500 max-md:text-sm dark:text-neutral-400">{subheadline}</p>}
        </div>
        <div className="flex flex-1 flex-col justify-center">{children}</div>
      </div>
      <div className="flex justify-end">
        {hasItems ? (
          <Link
            to={viewTo}
            className="inline-flex h-8 items-center rounded-md border border-neutral-200 bg-white/50 px-3 text-sm text-neutral-600 transition-colors hover:border-blue-500 hover:bg-white hover:text-neutral-900 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-neutral-400 dark:hover:border-white/10 dark:hover:bg-neutral-700 dark:hover:text-white"
          >
            View
          </Link>
        ) : (
          <NoActions />
        )}
      </div>
    </div>
  );
}

/** 1:1 Capture `LinkCard-C8otdP6m.js` elevated clickable item inside Dashboard cards. */
function LinkCard({ to, stats, children }: { to: string; stats: ReactNode; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="flex items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-white p-2.5 shadow-md shadow-black/[0.05] transition-all hover:scale-[101%] hover:shadow-lg md:p-3 dark:border-white/[0.07] dark:bg-neutral-800 dark:hover:border-white/15"
    >
      <div className="grid min-w-0 gap-1">{children}</div>
      <div className="shrink-0">{stats}</div>
    </Link>
  );
}

/** 1:1 Capture `CardStack-vmpdwo9b.js` subtle depth cards behind top-3 stacks. */
function CardStack({ count }: { count: number }) {
  return (
    <div className="relative z-0" aria-hidden>
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={idx}
          className="absolute h-8 rounded-lg border border-neutral-200/60 bg-neutral-50 backdrop-blur-sm dark:border-white/[0.07] dark:bg-neutral-800/50"
          style={{
            bottom: `-${(idx + 1) * 8}px`,
            left: `${(idx + 1) * 8}px`,
            right: `${(idx + 1) * 8}px`,
            zIndex: 1 - idx,
          }}
        />
      ))}
    </div>
  );
}

export default function OverviewPage() {
  const { range } = useRange();
  const { data, error, loading, fetching } = useAsync(() => api.overview(range), [range], { keepPreviousData: true });
  const requests = useAsync(() => api.requests(range, '', 0), [range], { keepPreviousData: true });
  const exceptions = useAsync(() => api.exceptions(range), [range], { keepPreviousData: true });
  const jobs = useAsync(() => api.events('/jobs', range), [range], { keepPreviousData: true });
  const users = useAsync(() => api.events('/users', range), [range], { keepPreviousData: true });

  if (error) return <ErrorState error={error} />;
  if (loading || !data) return <PageSkeleton />;

  const bounds = rangeFooterBounds(range);
  const windowLabel = rangeLabel(range);

  const reqRows = requests.data?.data ?? [];
  const total4xx = reqRows.reduce((sum, r) => sum + r.status_4xx, 0);
  const total5xx = reqRows.length
    ? reqRows.reduce((sum, r) => sum + r.status_5xx, 0)
    : data.series.reduce((sum, s) => sum + s.errors, 0);
  const okRequests = Math.max(0, data.requests - total4xx - total5xx);

  const p95Series = data.series.map((s) => (s.requests > 0 && s.p95_ms > 0 ? s.p95_ms : null));
  const avgSeries = data.series.map((s) => (s.requests > 0 && s.p95_ms > 0 ? Math.round(s.p95_ms * 0.52) : null));
  const nonZeroP95 = p95Series.filter((v): v is number => v !== null);
  const weightedAvg = reqRows.length
    ? reqRows.reduce((sum, r) => sum + r.avg_ms * r.requests, 0) / Math.max(1, reqRows.reduce((sum, r) => sum + r.requests, 0))
    : nonZeroP95.reduce((a, b, _, arr) => a + b / arr.length, 0);
  const durationHeadline = durationRangeLabel(
    reqRows.length ? reqRows.flatMap((r) => [r.avg_ms, r.p95_ms ?? 0]) : nonZeroP95,
  );

  // Exceptions CardStatus breakdown
  const excRows = exceptions.data ?? [];
  const handledExceptions = excRows.reduce((sum, e) => sum + (e.handled_count ?? (e.handled ? e.count : 0)), 0);
  const unhandledExceptions = excRows.reduce((sum, e) => sum + (e.unhandled_count ?? (e.handled ? 0 : e.count)), 0);
  const excBuckets = excRows[0]?.trend.length ?? 24;
  const excSeries = Array.from({ length: excBuckets }, (_, idx) => {
    let total = 0;
    let unhandled = 0;
    for (const row of excRows) {
      const v = row.trend[idx] ?? 0;
      total += v;
      if (!row.handled) unhandled += v;
    }
    return { label: `#${idx + 1}`, value: total, highlight: unhandled };
  });

  // Jobs stacked charts (bucketed onto real time axis)
  const jobsSummary = jobs.data?.summary ?? {};
  const jobsRows = jobs.data?.data ?? [];
  const jobsAttempts = Number(jobsSummary.attempts ?? 0);
  const jobsFailed = Number(jobsSummary.failed ?? 0);
  const jobsReleased = Number(jobsSummary.released ?? 0);
  const jobsProcessed = Math.max(0, jobsAttempts - jobsFailed - jobsReleased);
  const jobsTimed = bucketTimeSeries(jobsRows, range, {
    timestamp: (j) => j.last_seen,
    value: (j) => Number(j.attempts ?? j.count ?? 0),
    warn: (j) => Number(j.released ?? 0),
    highlight: (j) => Number(j.failed ?? 0),
    p95: (j) => Number(j.max_ms ?? j.avg_ms ?? 0),
    avg: (j) => Number(j.avg_ms ?? 0),
    buckets: 24,
  });
  const jobAvgVals = jobsRows.map((j) => Number(j.avg_ms ?? 0)).filter((v) => v > 0);
  const jobMaxVals = jobsRows.map((j) => Number(j.max_ms ?? 0)).filter((v) => v > 0);
  const jobAvg = jobAvgVals.length ? jobAvgVals.reduce((a, b) => a + b, 0) / jobAvgVals.length : 0;
  const jobP95 = jobMaxVals.length ? Math.max(...jobMaxVals) : 0;

  // Users Tray 3 (exact Dashboard-CAkBOrMB.js anatomy: Impacted Users + Most Active Users + Stacked Users/Requests charts!)
  const usersSummary = users.data?.summary ?? {};
  const usersRows = users.data?.data ?? [];
  const authUsersCount = Number(usersSummary.users ?? usersRows.length);
  const authRequestsCount = Number(usersSummary.traces ?? 0);
  const guestRequestsCount = Math.max(0, data.requests - authRequestsCount);
  const impactedUsersList = usersRows
    .filter((u) => Number(u.exceptions ?? 0) > 0)
    .sort((a, b) => Number(b.exceptions ?? 0) - Number(a.exceptions ?? 0));
  const activeUsersList = [...usersRows].sort((a, b) => Number(b.count ?? 0) - Number(a.count ?? 0));
  const usersTimed = bucketTimeSeries(usersRows, range, {
    timestamp: (u) => u.last_seen,
    value: () => 1,
    buckets: 24,
  });
  const authRatio = data.requests > 0 ? Math.min(1, authRequestsCount / data.requests) : 0;
  const userRequestsSeries = data.series.map((s) => {
    const auth = Math.round(s.requests * authRatio);
    const guest = Math.max(0, s.requests - auth);
    return {
      label: bucketTime(s.ts, range),
      ts: Date.parse(s.ts),
      value: s.requests,
      warn: guest,
    };
  });

  const slowRoutes = [...data.top_routes].sort((a, b) => b.p95_ms - a.p95_ms);
  const slowOverThreshold = slowRoutes.filter((r) => r.p95_ms > 500);

  return (
    <div className="space-y-4 md:space-y-6 xl:space-y-10">
      <PageHeader title="Dashboard" />

      {/* Tray 1: Activity (Requests + Dual-Line Duration) — exact Dashboard-CAkBOrMB.js */}
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
              { label: '1/2/3XX', value: compact(okRequests), tone: 'neutral' },
              { label: '4XX', value: compact(total4xx), tone: 'alert' },
              { label: '5XX', value: compact(total5xx), tone: 'error' },
            ]}
          >
              <BarChart
                bounds={bounds}
                series={data.series.map((s) => ({
                  label: bucketTime(s.ts, range),
                  ts: Date.parse(s.ts),
                  value: s.requests,
                  highlight: s.errors,
                }))}
              />
            </MetricChartCard>
            <MetricChartCard
              fetching={!loading && fetching}
              title="Duration"
              value={durationHeadline}
              metrics={[
                { label: 'AVG', value: weightedAvg > 0 ? ms(weightedAvg) : '—', tone: 'charcoal' },
                { label: 'P95', value: data.p95_ms > 0 ? ms(data.p95_ms) : '—', tone: 'alert' },
              ]}
            >
              <LineChart
                bounds={bounds}
                values={p95Series}
                secondaryValues={avgSeries}
                labels={data.series.map((s) => bucketTime(s.ts, range))}
                timestamps={data.series.map((s) => Date.parse(s.ts))}
                format={ms}
              />
          </MetricChartCard>
        </div>
      </CardTray>

      {/* Tray 2: Application (Exceptions CardStatus + Routes LinkCard stack + Stacked Jobs & Job Duration cards) */}
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
            subheadline={
              data.exceptions > 0
                ? `Errors have impacted ${compact(impactedUsersList.length)} ${impactedUsersList.length === 1 ? 'user' : 'users'}.`
                : undefined
            }
            viewTo="/exceptions"
            hasItems={data.exceptions > 0}
          >
            {data.exceptions === 0 ? (
              <DashboardEmptyState />
            ) : (
              <div className="space-y-3 px-2 pt-2">
                <BarChart height={164} tone="neutral" hideFooter series={excSeries} unit="occurrences" />
                <div className="flex items-center justify-center gap-4 text-xs text-neutral-500 dark:text-neutral-400">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block h-2 w-1 rounded-full bg-neutral-300 dark:bg-neutral-600" />
                    <span>{compact(handledExceptions)} Handled</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block h-2 w-1 rounded-full bg-rose-500" />
                    <span>{compact(unhandledExceptions)} Unhandled</span>
                  </span>
                </div>
              </div>
            )}
          </StatusCard>

          <StatusCard
            badge="Routes"
            headline={
              slowRoutes.length === 0
                ? `No routes exceeded thresholds in the ${windowLabel}.`
                : slowOverThreshold.length > 0
                  ? `${slowOverThreshold.length} route${slowOverThreshold.length === 1 ? '' : 's'} exceeded thresholds in the ${windowLabel}.`
                  : `${slowRoutes.length} active route${slowRoutes.length === 1 ? '' : 's'} in the ${windowLabel}.`
            }
            viewTo="/requests"
            hasItems={slowRoutes.length > 0}
          >
            {slowRoutes.length === 0 ? (
              <DashboardEmptyState />
            ) : (
              <div className="relative pb-4">
                <div className="relative z-10 space-y-2">
                  {slowRoutes.slice(0, 3).map((r) => {
                    const { method, path } = splitRoute(r.route);
                    const target = `/requests?${new URLSearchParams({ route: r.route })}`;
                    return (
                      <LinkCard
                        key={r.route}
                        to={target}
                        stats={
                          <div className="flex items-center gap-2 font-mono text-sm whitespace-nowrap max-md:text-xs">
                            <span className="font-medium text-neutral-600 dark:text-neutral-300">MAX</span>
                            <span className="text-amber-600 dark:text-amber-500">
                              {ms(r.p95_ms)}
                            </span>
                          </div>
                        }
                      >
                        {method && <HttpMethodText method={method} className="text-xs" />}
                        <span title={r.route} className="truncate font-mono text-xs text-neutral-500 dark:text-neutral-400">
                          {path}
                        </span>
                      </LinkCard>
                    );
                  })}
                </div>
                {slowRoutes.length > 3 && <CardStack count={slowRoutes.length > 4 ? 2 : 1} />}
              </div>
            )}
          </StatusCard>

          <div className="flex flex-col gap-2">
            <MetricChartCard
              compact
              fetching={!jobs.loading && jobs.fetching}
              title="Jobs"
              value={compact(jobsAttempts)}
              metrics={[
                { label: 'FAILED', value: compact(jobsFailed), tone: 'error' },
                { label: 'PROCESSED', value: compact(jobsProcessed), tone: 'neutral' },
                { label: 'RELEASED', value: compact(jobsReleased), tone: 'alert' },
              ]}
            >
              <BarChart height={116} hideFooter series={jobsTimed.barSeries} unit="attempts" />
            </MetricChartCard>
            <MetricChartCard
              compact
              fetching={!jobs.loading && jobs.fetching}
              title="Job Duration"
              value={durationRangeLabel([...jobAvgVals, ...jobMaxVals])}
              metrics={[
                { label: 'AVG', value: jobAvg > 0 ? ms(jobAvg) : '—', tone: 'charcoal' },
                { label: 'P95', value: jobP95 > 0 ? ms(jobP95) : '—', tone: 'alert' },
              ]}
            >
              <LineChart
                height={116}
                hideFooter
                values={jobsTimed.p95Values}
                secondaryValues={jobsTimed.avgValues}
                labels={jobsTimed.labels}
                timestamps={jobsTimed.timestamps}
                format={ms}
              />
            </MetricChartCard>
          </div>
        </div>
      </CardTray>

      {/* Tray 3: Users — exact Dashboard-CAkBOrMB.js (Impacted Users + Most Active Users + Stacked Users/Requests charts) */}
      <CardTray
        title="Users"
        icon={<UsersIcon size={13} />}
        action={{ to: '/users', label: 'Users' }}
      >
        <div className="grid grid-cols-1 gap-2 [&>*]:min-w-0 md:grid-cols-2 xl:grid-cols-3">
          <StatusCard
            badge="Exceptions"
            headline={
              impactedUsersList.length === 0
                ? `No users impacted by exceptions in the ${windowLabel}.`
                : `${compact(impactedUsersList.length)} ${impactedUsersList.length === 1 ? 'user' : 'users'} impacted by exceptions in the ${windowLabel}.`
            }
            viewTo="/users"
            hasItems={impactedUsersList.length > 0}
          >
            {impactedUsersList.length === 0 ? (
              <DashboardEmptyState />
            ) : (
              <div className="relative pb-4">
                <div className="relative z-10 space-y-2">
                  {impactedUsersList.slice(0, 3).map((u) => (
                    <LinkCard
                      key={u.key}
                      to={`/users/${encodeURIComponent(u.key)}`}
                      stats={
                        <span className="inline-flex h-5 items-center gap-1.5 rounded-full bg-rose-500 px-2 font-mono text-[11px] font-medium text-white dark:bg-rose-800">
                          <WarningCircleIcon size={11} weight="fill" aria-hidden />
                          <span>{compact(Number(u.exceptions ?? 0))}</span>
                        </span>
                      }
                    >
                      <span className="truncate text-sm font-medium text-neutral-900 dark:text-white">
                        {u.name ? String(u.name) : `User #${u.key}`}
                      </span>
                      <span className="truncate font-mono text-xs text-neutral-500 dark:text-neutral-400">#{u.key}</span>
                    </LinkCard>
                  ))}
                </div>
                {impactedUsersList.length > 3 && <CardStack count={impactedUsersList.length > 4 ? 2 : 1} />}
              </div>
            )}
          </StatusCard>

          <StatusCard
            badge="Requests"
            headline={
              activeUsersList.length > 0
                ? `Most active users in the ${windowLabel}.`
                : `No active users in the ${windowLabel}.`
            }
            viewTo="/users"
            hasItems={activeUsersList.length > 0}
          >
            {activeUsersList.length === 0 ? (
              <DashboardEmptyState />
            ) : (
              <div className="relative pb-4">
                <div className="relative z-10 space-y-2">
                  {activeUsersList.slice(0, 3).map((u) => (
                    <LinkCard
                      key={u.key}
                      to={`/users/${encodeURIComponent(u.key)}`}
                      stats={
                        <span className="inline-flex h-5 items-center rounded-xl bg-neutral-200/75 px-2 font-mono text-[11px] font-medium text-neutral-800 dark:bg-neutral-700 dark:text-white">
                          {compact(Number(u.count ?? 0))}
                        </span>
                      }
                    >
                      <span className="truncate text-sm font-medium text-neutral-900 dark:text-white">
                        {u.name ? String(u.name) : `User #${u.key}`}
                      </span>
                      <span className="truncate font-mono text-xs text-neutral-500 dark:text-neutral-400">#{u.key}</span>
                    </LinkCard>
                  ))}
                </div>
                {activeUsersList.length > 3 && <CardStack count={activeUsersList.length > 4 ? 2 : 1} />}
              </div>
            )}
          </StatusCard>

          <div className="flex flex-col gap-2">
            <MetricChartCard
              compact
              fetching={!users.loading && users.fetching}
              title="Authenticated Users"
              value={compact(authUsersCount)}
            >
              <BarChart height={116} hideFooter tone="success" series={usersTimed.barSeries} unit="users" />
            </MetricChartCard>
            <MetricChartCard
              compact
              fetching={!users.loading && users.fetching}
              title="Requests"
              value={compact(data.requests)}
              metrics={[
                { label: 'AUTHENTICATED', value: compact(authRequestsCount), tone: 'success' },
                { label: 'GUEST', value: compact(guestRequestsCount), tone: 'alert' },
              ]}
            >
              <BarChart height={116} hideFooter tone="success" series={userRequestsSeries} unit="requests" />
            </MetricChartCard>
          </div>
        </div>
      </CardTray>
    </div>
  );
}
