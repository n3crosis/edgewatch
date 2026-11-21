import { useNavigate } from 'react-router-dom';
import { Sparkline } from '../components/charts';
import { Card, Empty, ErrorState, Loading, PageHeader, Td, Th } from '../components/ui';
import { api, useAsync } from '../lib/api';
import { ago } from '../lib/format';
import { useRange } from '../lib/range';

export default function ExceptionsPage() {
  const { range } = useRange();
  const navigate = useNavigate();
  const { data, error, loading } = useAsync(() => api.exceptions(range), [range]);

  return (
    <>
      <PageHeader title="Exceptions" subtitle="Grouped by class, code and location" />
      <Card>
        {error ? <ErrorState error={error} /> : loading || !data ? <Loading /> : data.length === 0 ? <Empty>No exceptions in the last {range}. 🎉</Empty> : (
          <table className="w-full text-sm">
            <thead><tr><Th>Exception</Th><Th>Trend</Th><Th className="text-right">Events</Th><Th className="text-right">Users</Th><Th>Last seen</Th><Th>First seen</Th></tr></thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.group} onClick={() => navigate(`/exceptions/${e.group}`)} className="cursor-pointer border-t border-slate-800/70 hover:bg-slate-800/30">
                  <Td className="max-w-xl">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-xs text-rose-300">{e.class}</span>
                      <span className={`rounded px-1.5 text-[10px] ${e.handled ? 'bg-slate-800 text-slate-400' : 'bg-rose-500/15 text-rose-300'}`}>{e.handled ? 'handled' : 'unhandled'}</span>
                    </div>
                    <div className="mt-1 truncate text-xs text-slate-400">{e.message}</div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-slate-600">{e.file}:{e.line}</div>
                  </Td>
                  <Td><Sparkline values={e.trend} className="text-rose-400" /></Td>
                  <Td className="text-right tabular-nums">{e.count}</Td>
                  <Td className="text-right tabular-nums text-slate-400">{e.users}</Td>
                  <Td className="whitespace-nowrap text-xs text-slate-400">{ago(e.last_seen)}</Td>
                  <Td className="whitespace-nowrap text-xs text-slate-500">{ago(e.first_seen)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
