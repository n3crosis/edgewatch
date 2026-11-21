import { Link, useParams } from 'react-router-dom';
import { Card, Empty, ErrorState, Loading, PageHeader, Sql, Stat, Td, Th } from '../components/ui';
import { api, useAsync } from '../lib/api';
import { ago, compact, ms } from '../lib/format';

export default function QueryDetailPage() {
  const { sqlHash = '' } = useParams();
  const { data, error, loading } = useAsync(() => api.query(sqlHash), [sqlHash]);

  if (error) return <ErrorState error={error} />;
  if (loading) return <Loading />;
  if (!data) return <Empty>Query not found.</Empty>;

  return (
    <>
      <PageHeader back={{ to: '/queries', label: 'Queries' }} title="Query" subtitle={<span className="font-mono">{data.connection} · sql_hash {data.sql_hash}</span>} />
      <Card className="mb-4"><pre className="whitespace-pre-wrap p-5"><Sql sql={data.sql} className="text-sm text-slate-200" /></pre></Card>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Calls (24h)" value={compact(data.calls)} />
        <Stat label="Total time" value={ms(data.total_ms)} />
        <Stat label="Average" value={ms(data.avg_ms)} />
        <Stat label="p95" value={ms(data.p95_ms)} tone={data.p95_ms > 100 ? 'warn' : 'default'} />
        <Stat label="Max" value={ms(data.max_ms)} />
      </div>
      <Card title="Slowest executions" className="mt-4">
        <table className="w-full text-sm">
          <thead><tr><Th>When</Th><Th>Trace</Th><Th>Location</Th><Th className="text-right">Duration</Th></tr></thead>
          <tbody>
            {data.samples.map((s, i) => (
              <tr key={`${s.trace_id}-${i}`} className="border-t border-slate-800/70">
                <Td className="text-xs text-slate-400">{ago(s.timestamp)}</Td>
                <Td><Link to={`/traces/${s.trace_id}`} className="font-mono text-xs text-sky-400 hover:underline">{s.name}</Link></Td>
                <Td className="font-mono text-xs text-slate-500">{s.file}:{s.line}</Td>
                <Td className="text-right tabular-nums">{ms(s.duration_ms)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
