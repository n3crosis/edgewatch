import { Link } from 'react-router-dom';
import { BarChart, LineChart } from '@/components/charts';
import { ErrorState, Loading, PageHeader, Panel, Stat } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, useAsync } from '@/lib/api';
import { compact, ms, percent, time } from '@/lib/format';
import { useRange } from '@/lib/range';

const PER_MINUTE = { '1h': 60, '6h': 360, '24h': 1440 };

function ViewAll({ to, label = 'View' }: { to: string; label?: string }) {
  return (
    <Button asChild variant="link" size="xs" className="h-auto p-0">
      <Link to={to}>{label} →</Link>
    </Button>
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
            <TableHeader>
              <TableRow>
                <TableHead className="px-5">Route</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead className="text-right">p95</TableHead>
                <TableHead className="px-5 text-right">Errors</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.top_routes.map((r) => (
                <TableRow key={r.route}>
                  <TableCell className="px-5 font-mono text-xs">{r.route}</TableCell>
                  <TableCell className="text-right tabular-nums">{compact(r.requests)}</TableCell>
                  <TableCell className={`text-right tabular-nums ${r.p95_ms > 500 ? 'text-amber-300' : ''}`}>{ms(r.p95_ms)}</TableCell>
                  <TableCell className={`px-5 text-right tabular-nums ${r.error_rate > 0.01 ? 'text-destructive' : 'text-muted-foreground'}`}>{percent(r.error_rate)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
        <div className="space-y-4">
          <Panel title="Top exceptions" actions={<ViewAll to="/exceptions" />}>
            {exceptions.data?.slice(0, 3).map((e, i) => (
              <div key={e.group}>
                {i > 0 && <Separator />}
                <Link to={`/exceptions/${e.group}`} className="block px-5 py-3 transition-colors hover:bg-muted/50">
                  <div className="flex justify-between gap-3 text-xs">
                    <span className="truncate font-mono text-destructive">{e.class.split('\\').pop()}</span>
                    <span className="tabular-nums text-muted-foreground">{e.count}×</span>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">{e.message}</div>
                </Link>
              </div>
            ))}
          </Panel>
          <Panel title="Slowest queries" actions={<ViewAll to="/queries" />}>
            {queries.data &&
              [...queries.data].sort((a, b) => b.p95_ms - a.p95_ms).slice(0, 3).map((q, i) => (
                <div key={q.sql_hash}>
                  {i > 0 && <Separator />}
                  <Link to={`/queries/${q.sql_hash}`} className="flex items-center justify-between gap-3 px-5 py-3 text-xs transition-colors hover:bg-muted/50">
                    <span className="truncate font-mono">{q.sql}</span>
                    <span className="shrink-0 tabular-nums text-amber-300">{ms(q.p95_ms)}</span>
                  </Link>
                </div>
              ))}
          </Panel>
        </div>
      </div>
    </>
  );
}
