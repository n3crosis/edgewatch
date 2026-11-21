import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkline } from '../components/charts';
import { Card, Empty, ErrorState, Loading, PageHeader, Sql, Td, Th } from '../components/ui';
import { api, useAsync } from '../lib/api';
import { compact, ms } from '../lib/format';
import { useRange } from '../lib/range';
import type { QueryGroup } from '../lib/types';

const SORTS: { key: keyof QueryGroup; label: string }[] = [
  { key: 'total_ms', label: 'Total time' },
  { key: 'calls', label: 'Calls' },
  { key: 'p95_ms', label: 'p95' },
];

export default function QueriesPage() {
  const { range } = useRange();
  const navigate = useNavigate();
  const [sort, setSort] = useState<keyof QueryGroup>('total_ms');
  const { data, error, loading } = useAsync(() => api.queries(range), [range]);
  const rows = data ? [...data].sort((a, b) => Number(b[sort]) - Number(a[sort])) : [];

  return (
    <>
      <PageHeader
        title="Queries"
        subtitle="Grouped by sql_hash — literals are stripped before hashing, so values never leave your app"
        actions={
          <div className="flex rounded-lg border border-slate-800 bg-slate-900 p-0.5 text-xs">
            {SORTS.map((s) => (
              <button key={s.key} onClick={() => setSort(s.key)} className={`rounded-md px-3 py-1.5 ${sort === s.key ? 'bg-slate-700 text-white' : 'text-slate-400'}`}>{s.label}</button>
            ))}
          </div>
        }
      />
      <Card>
        {error ? <ErrorState error={error} /> : loading || !data ? <Loading /> : rows.length === 0 ? <Empty>No queries recorded.</Empty> : (
          <table className="w-full table-fixed text-sm">
            <thead><tr><Th className="w-[46%]">Query</Th><Th>Calls</Th><Th className="text-right">Total</Th><Th className="text-right">Avg</Th><Th className="text-right">p95</Th><Th className="text-right">Max</Th><Th>Trend</Th></tr></thead>
            <tbody>
              {rows.map((q) => (
                <tr key={q.sql_hash} onClick={() => navigate(`/queries/${q.sql_hash}`)} className="cursor-pointer border-t border-slate-800/70 hover:bg-slate-800/30">
                  <Td>
                    <div className="truncate"><Sql sql={q.sql} className="text-slate-300" /></div>
                    <div className="mt-1 font-mono text-[11px] text-slate-600">{q.connection} · {q.sql_hash.slice(0, 12)}</div>
                  </Td>
                  <Td className="tabular-nums">{compact(q.calls)}</Td>
                  <Td className="text-right tabular-nums">{ms(q.total_ms)}</Td>
                  <Td className="text-right tabular-nums text-slate-400">{ms(q.avg_ms)}</Td>
                  <Td className={`text-right tabular-nums ${q.p95_ms > 100 ? 'text-amber-300' : ''}`}>{ms(q.p95_ms)}</Td>
                  <Td className="text-right tabular-nums text-slate-400">{ms(q.max_ms)}</Td>
                  <Td><Sparkline values={q.trend} width={90} className="text-amber-300" /></Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
