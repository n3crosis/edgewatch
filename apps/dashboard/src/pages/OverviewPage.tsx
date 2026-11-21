import { Link } from 'react-router-dom';
import { BarChart, LineChart } from '../components/charts';
import { Card, ErrorState, Loading, PageHeader, Stat, Td, Th } from '../components/ui';
import { api, useAsync } from '../lib/api';
import { compact, ms, percent, time } from '../lib/format';
import { useRange } from '../lib/range';

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
        <Stat label="Requests" value={compact(data.requests)} hint={`${(data.requests / ({ '1h': 60, '6h': 360, '24h': 1440 }[range])).toFixed(1)} / min`} />
        <Stat label="Error rate" value={percent(data.error_rate)} tone={data.error_rate > 0.01 ? 'bad' : 'good'} hint="5xx responses" />
        <Stat label="p95 latency" value={ms(data.p95_ms)} tone={data.p95_ms > 500 ? 'warn' : 'default'} />
        <Stat label="Exceptions" value={compact(data.exceptions)} tone={data.exceptions > 0 ? 'bad' : 'good'} />
        <Stat label="Slow queries" value={compact(data.slow_queries)} hint="> 100ms" tone={data.slow_queries > 0 ? 'warn' : 'good'} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Requests & errors">
          <div className="px-5 pb-3 pt-10">
            <BarChart series={data.series.map((s) => ({ label: time(s.ts), value: s.requests, highlight: s.errors }))} />
          </div>
        </Card>
        <Card title="p95 latency">
          <div className="px-5 pb-3 pt-10">
            <LineChart values={data.series.map((s) => s.p95_ms)} />
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card title="Routes" className="xl:col-span-2" actions={<Link to="/traces" className="text-xs text-sky-400 hover:underline">All traces →</Link>}>
          <table className="w-full text-sm">
            <thead><tr><Th>Route</Th><Th className="text-right">Requests</Th><Th className="text-right">p95</Th><Th className="text-right">Errors</Th></tr></thead>
            <tbody>
              {data.top_routes.map((r) => (
                <tr key={r.route} className="border-t border-slate-800/70">
                  <Td className="font-mono text-xs text-slate-200">{r.route}</Td>
                  <Td className="text-right tabular-nums">{compact(r.requests)}</Td>
                  <Td className={`text-right tabular-nums ${r.p95_ms > 500 ? 'text-amber-300' : ''}`}>{ms(r.p95_ms)}</Td>
                  <Td className={`text-right tabular-nums ${r.error_rate > 0.01 ? 'text-rose-400' : 'text-slate-400'}`}>{percent(r.error_rate)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <div className="space-y-4">
          <Card title="Top exceptions" actions={<Link to="/exceptions" className="text-xs text-sky-400 hover:underline">View →</Link>}>
            <ul className="divide-y divide-slate-800/70">
              {exceptions.data?.slice(0, 3).map((e) => (
                <li key={e.group}>
                  <Link to={`/exceptions/${e.group}`} className="block px-5 py-3 hover:bg-slate-800/30">
                    <div className="flex justify-between gap-3 text-xs">
                      <span className="truncate font-mono text-rose-300">{e.class.split('\\').pop()}</span>
                      <span className="tabular-nums text-slate-400">{e.count}×</span>
                    </div>
                    <div className="mt-1 truncate text-xs text-slate-500">{e.message}</div>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Slowest queries" actions={<Link to="/queries" className="text-xs text-sky-400 hover:underline">View →</Link>}>
            <ul className="divide-y divide-slate-800/70">
              {queries.data && [...queries.data].sort((a, b) => b.p95_ms - a.p95_ms).slice(0, 3).map((q) => (
                <li key={q.sql_hash}>
                  <Link to={`/queries/${q.sql_hash}`} className="flex items-center justify-between gap-3 px-5 py-3 text-xs hover:bg-slate-800/30">
                    <span className="truncate font-mono text-slate-300">{q.sql}</span>
                    <span className="shrink-0 tabular-nums text-amber-300">{ms(q.p95_ms)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
