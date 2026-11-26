import { useEnvironment } from '@/lib/environment';
import { useProject } from '@/lib/project';
import { scopedPath } from '@/components/ScopedLink';
import { timeWindow } from '@edgewatch/shared/time-window';
import Link from '@/components/ScopedLink';
import { BarChart, Legend, LineChart } from '@/components/charts';
import { Empty, ErrorState, Loading, MethodBadge, PageHeader, PageSkeleton, Panel, Sql, Stat } from '@/components/common';
import { Badge } from '@cloudflare/kumo/components/badge';
import { LinkButton } from '@cloudflare/kumo/components/button';
import { Table } from '@cloudflare/kumo/components/table';
import { PlugIcon, PulseIcon } from '@phosphor-icons/react';
import { api, useAsync } from '@/lib/api';
import { compact, ms, percent, time } from '@/lib/format';
import { useRange, rangeLabel } from '@/lib/range';

function ViewAll({ to, label = 'View all' }: { to: string; label?: string }) {
  return (
    <Link to={to} className="text-xs font-medium text-kumo-link hover:underline">
      {label} →
    </Link>
  );
}

function splitRoute(route: string): { method: string | null; path: string } {
  const match = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i.exec(route);
  return match ? { method: match[1].toUpperCase(), path: match[2] } : { method: null, path: route };
}

export default function OverviewPage() {
  const { range } = useRange();
  const { projectId } = useProject();
  const { environment } = useEnvironment();
  const { data, error, loading, fetching } = useAsync(() => api.overview(range), [range], { keepPreviousData: true });
  const exceptions = useAsync(() => api.exceptions(range), [range], { keepPreviousData: true });
  const queries = useAsync(() => api.queries(range), [range], { keepPreviousData: true });

  if (error) return <ErrorState error={error} />;
  if (loading || !data) return <PageSkeleton />;
  if (data.requests === 0 && data.exceptions === 0) {
    return (
      <>
        <PageHeader title="Dashboard" subtitle={`Application health over the ${rangeLabel(range)}`} />
        <Panel>
          <Empty
            icon={<PulseIcon size={36} className="text-kumo-subtle" />}
            description="Point the Laravel Nightwatch agent at this project's ingest URL and telemetry will appear here within seconds."
            action={
              <LinkButton href={scopedPath('/setup', projectId, range, environment)} variant="primary" icon={PlugIcon}>
                Connect an app
              </LinkButton>
            }
          >
            {`No traffic in the ${rangeLabel(range)}`}
          </Empty>
        </Panel>
      </>
    );
  }

  const win = timeWindow(range);
  const windowMinutes = Math.max(1 / 60, win ? (win.width * 24) / 60000 : 1440);
  const rpm = data.requests / windowMinutes;
  const peakLatency = Math.max(0, ...data.series.map((s) => s.p95_ms));
  const maxRouteRequests = Math.max(1, ...data.top_routes.map((r) => r.requests));

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" subtitle={`Application health over the ${rangeLabel(range)}`} />

      <section className="grid grid-cols-1 gap-5 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
        <Stat label="Requests" value={compact(data.requests)} hint={`${rpm.toFixed(1)} / min`} to="/requests" />
        <Stat
          label="Error rate"
          value={percent(data.error_rate)}
          tone={data.error_rate > 0.01 ? 'bad' : 'good'}
          hint="5xx responses"
          to="/traces?source=request&status=5xx"
        />
        <Stat
          label="p95 latency"
          value={ms(data.p95_ms)}
          tone={data.p95_ms > 500 ? 'warn' : 'default'}
          hint={`peak ${ms(peakLatency)}`}
          to="/traces?source=request&min_duration_ms=500"
        />
        <Stat
          label="Exceptions"
          value={compact(data.exceptions)}
          tone={data.exceptions > 0 ? 'bad' : 'good'}
          hint={data.exceptions > 0 ? 'recorded in window' : 'none recorded'}
          to="/exceptions"
        />
        <Stat
          label="Slow queries"
          value={compact(data.slow_queries)}
          hint="> 100ms"
          tone={data.slow_queries > 0 ? 'warn' : 'good'}
          to="/queries?sort=p95_ms"
        />
      </section>

      <section className="grid grid-cols-1 gap-6 [&>*]:min-w-0 xl:grid-cols-2">
        <Panel
          fetching={!loading && fetching}
          title="Requests & errors"
          actions={<Legend items={[{ label: 'Requests', className: 'bg-kumo-brand/65' }, { label: 'Errors', className: 'bg-kumo-danger' }]} />}
        >
          <div className="p-6">
            <BarChart series={data.series.map((s) => ({ label: time(s.ts), value: s.requests, highlight: s.errors }))} />
          </div>
        </Panel>
        <Panel
          fetching={!loading && fetching}
          title="p95 latency"
          actions={<span className="text-xs tabular-nums text-kumo-subtle">peak {ms(peakLatency)}</span>}
        >
          <div className="p-6">
            <LineChart values={data.series.map((s) => s.p95_ms)} labels={data.series.map((s) => time(s.ts))} format={ms} />
          </div>
        </Panel>
      </section>

      <section className="grid grid-cols-1 gap-6 [&>*]:min-w-0 xl:grid-cols-3">
        <Panel fetching={!loading && fetching} title="Top routes" className="xl:col-span-2" actions={<ViewAll to="/requests" label="All routes" />}>
          {data.top_routes.length === 0 ? (
            <Empty>No routes recorded in this window.</Empty>
          ) : (
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Route</Table.Head>
                  <Table.Head className="text-right">Requests</Table.Head>
                  <Table.Head className="text-right">p95</Table.Head>
                  <Table.Head className="text-right">Errors</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.top_routes.map((r) => {
                  const { method, path } = splitRoute(r.route);
                  const share = Math.max(4, Math.round((r.requests / maxRouteRequests) * 100));
                  return (
                    <Table.Row key={r.route} className="transition-colors hover:bg-kumo-tint/50">
                      <Table.Cell className="max-w-md">
                        <Link to={`/traces?${new URLSearchParams({ q: r.route, source: 'request' })}`} className="inline-flex max-w-full items-center gap-2.5 hover:underline">
                          {method && <MethodBadge method={method} />}
                          <span className="truncate font-mono text-xs text-kumo-strong">{path}</span>
                        </Link>
                      </Table.Cell>
                      <Table.Cell className="text-right tabular-nums">
                        <div className="inline-flex flex-col items-end gap-1.5">
                          <span className="font-medium">{compact(r.requests)}</span>
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-kumo-fill">
                            <div className="h-full rounded-full bg-kumo-brand/70" style={{ width: `${share}%` }} />
                          </div>
                        </div>
                      </Table.Cell>
                      <Table.Cell className={`text-right font-mono text-xs tabular-nums ${r.p95_ms > 500 ? 'font-medium text-kumo-warning' : ''}`}>
                        {ms(r.p95_ms)}
                      </Table.Cell>
                      <Table.Cell className={`text-right font-mono text-xs tabular-nums ${r.error_rate > 0.01 ? 'font-medium text-kumo-danger' : 'text-kumo-subtle'}`}>
                        {percent(r.error_rate)}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          )}
        </Panel>

        <div className="space-y-6">
          <Panel fetching={!exceptions.loading && exceptions.fetching} title="Top exceptions" actions={<ViewAll to="/exceptions" />}>
            {exceptions.error ? (
              <ErrorState error={exceptions.error} />
            ) : exceptions.loading && !exceptions.data ? (
              <Loading rows={3} />
            ) : exceptions.data?.length === 0 ? (
              <Empty>No exceptions</Empty>
            ) : (
              <div className="divide-y divide-kumo-hairline">
                {exceptions.data?.slice(0, 3).map((e) => (
                  <Link key={e.group} to={`/exceptions/${e.group}`} className="block px-6 py-4 transition-colors hover:bg-kumo-tint/60">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate font-mono text-xs font-medium text-kumo-danger">{e.class.split('\\').pop()}</span>
                      <Badge variant={e.handled ? 'secondary' : 'error'} className="shrink-0 tabular-nums">{e.count}×</Badge>
                    </div>
                    <div className="mt-1.5 truncate text-xs text-kumo-subtle">{e.message}</div>
                  </Link>
                ))}
              </div>
            )}
          </Panel>

          <Panel fetching={!queries.loading && queries.fetching} title="Slowest queries" actions={<ViewAll to="/queries" />}>
            {queries.error ? (
              <ErrorState error={queries.error} />
            ) : queries.loading && !queries.data ? (
              <Loading rows={3} />
            ) : queries.data?.length === 0 ? (
              <Empty>No queries</Empty>
            ) : (
              <div className="divide-y divide-kumo-hairline">
                {queries.data &&
                  [...queries.data].sort((a, b) => b.p95_ms - a.p95_ms).slice(0, 3).map((q) => (
                    <Link key={q.sql_hash} to={`/queries/${q.sql_hash}`} className="block px-6 py-4 transition-colors hover:bg-kumo-tint/60">
                      <div className="flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate"><Sql sql={q.sql} /></span>
                        <span className="shrink-0 font-mono text-xs font-medium tabular-nums text-kumo-warning">{ms(q.p95_ms)}</span>
                      </div>
                      <div className="mt-1.5 flex items-center justify-between text-xs text-kumo-subtle">
                        <span className="font-mono">{q.connection}</span>
                        <span className="tabular-nums">{compact(q.calls)} calls</span>
                      </div>
                    </Link>
                  ))}
              </div>
            )}
          </Panel>
        </div>
      </section>
    </div>
  );
}
