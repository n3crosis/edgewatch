import { Link, useParams } from 'react-router-dom';
import { BarChart } from '../components/charts';
import { Card, Empty, ErrorState, Loading, PageHeader, Stat, Td, Th } from '../components/ui';
import { api, useAsync } from '../lib/api';
import { ago } from '../lib/format';

export default function ExceptionDetailPage() {
  const { group = '' } = useParams();
  const { data, error, loading } = useAsync(() => api.exception(group), [group]);

  if (error) return <ErrorState error={error} />;
  if (loading) return <Loading />;
  if (!data) return <Empty>Exception group not found.</Empty>;

  return (
    <>
      <PageHeader back={{ to: '/exceptions', label: 'Exceptions' }} title={<span className="font-mono text-rose-300">{data.class}</span>} subtitle={data.message} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Events (24h)" value={data.count} tone="bad" />
        <Stat label="Users affected" value={data.users} />
        <Stat label="First seen" value={ago(data.first_seen)} />
        <Stat label="Last seen" value={ago(data.last_seen)} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Stack trace">
          <ol className="divide-y divide-slate-800/70 font-mono text-xs">
            {data.stack.map((f, i) => (
              <li key={i} className={`px-5 py-2.5 ${f.file.startsWith('vendor/') ? 'text-slate-600' : 'text-slate-300'}`}>
                <div>{f.source}</div>
                <div className="mt-0.5 text-[11px] text-slate-500">{f.file}</div>
              </li>
            ))}
          </ol>
        </Card>
        <div className="space-y-4">
          <Card title="Occurrences over 24h">
            <div className="px-5 pb-3 pt-10"><BarChart height={100} series={data.trend.map((v, i) => ({ label: `${24 - i}h ago`, value: v }))} /></div>
          </Card>
          <Card title="Recent occurrences">
            <table className="w-full text-sm">
              <thead><tr><Th>When</Th><Th>Trace</Th><Th>User</Th></tr></thead>
              <tbody>
                {data.occurrences.slice(0, 8).map((o) => (
                  <tr key={o.trace_id} className="border-t border-slate-800/70">
                    <Td className="text-xs text-slate-400">{ago(o.timestamp)}</Td>
                    <Td><Link to={`/traces/${o.trace_id}`} className="font-mono text-xs text-sky-400 hover:underline">{o.name}</Link></Td>
                    <Td className="text-xs text-slate-400">{o.user ? `#${o.user}` : '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      </div>
    </>
  );
}
