import { Search } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Empty, ErrorState, Loading, PageHeader, SourceBadge, StatusBadge, Td, Th } from '../components/ui';
import { api, useAsync } from '../lib/api';
import { ago, ms } from '../lib/format';
import type { TraceFilters } from '../lib/types';

const SOURCES = ['all', 'request', 'job', 'command'] as const;
const STATUSES = ['all', '2xx', '3xx', '4xx', '5xx'] as const;

export default function TracesPage() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<TraceFilters>({ source: 'all', status: 'all', q: '' });
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<(string | null)[]>([]);
  const { data, error, loading } = useAsync(() => api.traces(filters, cursor), [filters.source, filters.status, filters.q, cursor]);

  const update = (patch: TraceFilters) => {
    setFilters((f) => ({ ...f, ...patch }));
    setCursor(null);
    setHistory([]);
  };

  return (
    <>
      <PageHeader title="Traces" subtitle="Every request, queued job and command, newest first" />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="relative flex-1 min-w-64">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={filters.q}
            onChange={(e) => update({ q: e.target.value })}
            placeholder="Search route, trace ID or user…"
            className="w-full rounded-lg border border-slate-800 bg-slate-900 py-2 pl-9 pr-3 text-sm placeholder:text-slate-600 focus:border-sky-600 focus:outline-none"
          />
        </label>
        <Segmented options={SOURCES} value={filters.source!} onChange={(source) => update({ source })} />
        <Segmented options={STATUSES} value={filters.status!} onChange={(status) => update({ status })} />
      </div>
      <Card>
        {error ? <ErrorState error={error} /> : loading || !data ? <Loading /> : data.data.length === 0 ? <Empty>No traces match these filters.</Empty> : (
          <table className="w-full text-sm">
            <thead><tr><Th>When</Th><Th>Type</Th><Th>Name</Th><Th>Status</Th><Th className="text-right">Duration</Th><Th className="text-right">Queries</Th><Th>User</Th><Th>Server</Th></tr></thead>
            <tbody>
              {data.data.map((t) => (
                <tr key={t.trace_id} onClick={() => navigate(`/traces/${t.trace_id}`)} className="cursor-pointer border-t border-slate-800/70 hover:bg-slate-800/30">
                  <Td className="whitespace-nowrap text-xs text-slate-400">{ago(t.timestamp)}</Td>
                  <Td><SourceBadge source={t.execution_source} /></Td>
                  <Td className="max-w-md truncate font-mono text-xs text-slate-200">
                    {t.name}
                    {t.exception_count > 0 && <span className="ml-2 rounded bg-rose-500/15 px-1 text-[10px] text-rose-300">exception</span>}
                  </Td>
                  <Td><StatusBadge status={t.status_code} source={t.execution_source} /></Td>
                  <Td className={`text-right tabular-nums ${t.duration_ms > 500 ? 'text-amber-300' : ''}`}>{ms(t.duration_ms)}</Td>
                  <Td className="text-right tabular-nums text-slate-400">{t.query_count}</Td>
                  <Td className="text-xs text-slate-400">{t.user ? `#${t.user}` : '—'}</Td>
                  <Td className="text-xs text-slate-500">{t.server}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-3 text-xs">
          <button disabled={history.length === 0} onClick={() => { setCursor(history[history.length - 1]); setHistory(history.slice(0, -1)); }} className="rounded-md border border-slate-800 px-3 py-1.5 disabled:opacity-40">Previous</button>
          <button disabled={!data?.next_cursor} onClick={() => { setHistory([...history, cursor]); setCursor(data!.next_cursor); }} className="rounded-md border border-slate-800 px-3 py-1.5 disabled:opacity-40">Next</button>
        </div>
      </Card>
    </>
  );
}

function Segmented<T extends string>({ options, value, onChange }: { options: readonly T[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-lg border border-slate-800 bg-slate-900 p-0.5 text-xs">
      {options.map((o) => (
        <button key={o} onClick={() => onChange(o)} className={`rounded-md px-3 py-1.5 capitalize ${value === o ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}>{o}</button>
      ))}
    </div>
  );
}
