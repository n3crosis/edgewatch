import { Link } from 'react-router-dom';
import { BarChart, LineChart } from '@/components/charts';
import { ErrorState, Loading, PageHeader, Panel, Stat } from '@/components/common';
import { LinkButton } from '@cloudflare/kumo/components/button';
import { Table } from '@cloudflare/kumo/components/table';
import { api, useAsync } from '@/lib/api';
import { compact, ms, percent, time } from '@/lib/format';
import { useRange } from '@/lib/range';

const PER_MINUTE = { '1h': 60, '6h': 360, '24h': 1440 };

function ViewAll({ to, label = 'View' }: { to: string; label?: string }) {
  return (
    <LinkButton href={to} variant="ghost" size="xs" className="text-kumo-link">
      {label} →
    </LinkButton>
  );
}

export default function OverviewPage() {
  const { range } = useRange();
  const { data, error, loading } = useAsync(() => api.overview(range), [range]);
  const exceptions = useAsync(() => api.exceptions(range), [range]);
  const queries = useAsync(() => api.queries(range), [range]);

  if (error) return <ErrorState error={error} />;
  if (loading || !data) return <Loading />;

  return (
    <>
      <PageHeader title="Overview" subtitle={`Application health over the last ${range}`} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Requests" value={compact(data.requests)} hint={`${(data.requests / PER_MINUTE[range]).toFixed(1)} / min`} />
        <Stat label="Error rate" value={percent(data.error_rate)} tone={data.error_rate > 0.01 ? 'bad' : 'good'} hint="5xx responses" />
        <Stat label="p95 latency" value={ms(data.p95_ms)} tone={data.p95_ms > 500 ? 'warn' : 'default'} />
        <Stat label="Exceptions" value={compact(data.exceptions)} tone={data.exceptions > 0 ? 'bad' : 'good'} />
        <Stat label="Slow queries" value={compact(data.slow_queries)} hint="> 100ms" tone={data.slow_queries > 0 ? 'warn' : 'good'} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Requests & errors">
          <div className="px-5 pb-4 pt-6">
            <BarChart series={data.series.map((s) => ({ label: time(s.ts), value: s.requests, highlight: s.errors }))} />
          </div>
        </Panel>
        <Panel title="p95 latency">
          <div className="px-5 pb-4 pt-6">
            <LineChart values={data.series.map((s) => s.p95_ms)} />
          </div>
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Panel title="Routes" className="xl:col-span-2" actions={<ViewAll to="/traces" label="All traces" />}>
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head className="px-5">Route</Table.Head>
                <Table.Head className="text-right">Requests</Table.Head>
                <Table.Head className="text-right">p95</Table.Head>
                <Table.Head className="px-5 text-right">Errors</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.top_routes.map((r) => (
                <Table.Row key={r.route}>
                  <Table.Cell className="px-5 font-mono text-xs">{r.route}</Table.Cell>
                  <Table.Cell className="text-right tabular-nums">{compact(r.requests)}</Table.Cell>
                  <Table.Cell className={`text-right tabular-nums ${r.p95_ms > 500 ? 'text-kumo-warning' : ''}`}>{ms(r.p95_ms)}</Table.Cell>
                  <Table.Cell className={`px-5 text-right tabular-nums ${r.error_rate > 0.01 ? 'text-kumo-danger' : 'text-kumo-subtle'}`}>{percent(r.error_rate)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </Panel>
        <div className="space-y-4">
          <Panel title="Top exceptions" actions={<ViewAll to="/exceptions" />}>
            {exceptions.data?.slice(0, 3).map((e, i) => (
              <div key={e.group}>
                {i > 0 && <div className="border-t border-kumo-hairline" />}
                <Link to={`/exceptions/${e.group}`} className="block px-5 py-3 transition-colors hover:bg-kumo-tint">
                  <div className="flex justify-between gap-3 text-xs">
                    <span className="truncate font-mono text-kumo-danger">{e.class.split('\\').pop()}</span>
                    <span className="tabular-nums text-kumo-subtle">{e.count}×</span>
                  </div>
                  <div className="mt-1 truncate text-xs text-kumo-subtle">{e.message}</div>
                </Link>
              </div>
            ))}
          </Panel>
          <Panel title="Slowest queries" actions={<ViewAll to="/queries" />}>
            {queries.data &&
              [...queries.data].sort((a, b) => b.p95_ms - a.p95_ms).slice(0, 3).map((q, i) => (
                <div key={q.sql_hash}>
                  {i > 0 && <div className="border-t border-kumo-hairline" />}
                  <Link to={`/queries/${q.sql_hash}`} className="flex items-center justify-between gap-3 px-5 py-3 text-xs transition-colors hover:bg-kumo-tint">
                    <span className="truncate font-mono">{q.sql}</span>
                    <span className="shrink-0 tabular-nums text-kumo-warning">{ms(q.p95_ms)}</span>
                  </Link>
                </div>
              ))}
          </Panel>
        </div>
      </div>
    </>
  );
}
