import { Fragment, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Waterfall from '../components/Waterfall';
import { Card, Empty, ErrorState, Loading, PageHeader, SourceBadge, Stat, StatusBadge } from '../components/ui';
import { api, useAsync } from '../lib/api';
import { ms } from '../lib/format';
import type { Span } from '../lib/types';

export default function TraceDetailPage() {
  const { traceId = '' } = useParams();
  const { data, error, loading } = useAsync(() => api.trace(traceId), [traceId]);
  const [tab, setTab] = useState<'timeline' | 'records'>('timeline');
  const [selected, setSelected] = useState<Span | null>(null);

  if (error) return <ErrorState error={error} />;
  if (loading) return <Loading />;
  if (!data) return <Empty>Trace not found.</Empty>;

  const { trace, spans, records } = data;
  const queryTime = spans.filter((s) => s.type === 'query').reduce((a, s) => a + s.duration_ms, 0);

  return (
    <>
      <PageHeader
        back={{ to: '/traces', label: 'Traces' }}
        title={<span className="font-mono">{trace.name}</span>}
        subtitle={<span className="flex items-center gap-2"><SourceBadge source={trace.execution_source} /><StatusBadge status={trace.status_code} source={trace.execution_source} /><span className="font-mono text-xs">{trace.trace_id}</span></span>}
      />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Duration" value={ms(trace.duration_ms)} tone={trace.duration_ms > 500 ? 'warn' : 'default'} />
        <Stat label="Queries" value={trace.query_count} hint={`${ms(queryTime)} in database`} />
        <Stat label="Exceptions" value={trace.exception_count} tone={trace.exception_count ? 'bad' : 'good'} />
        <Stat label="User" value={trace.user ? `#${trace.user}` : '—'} />
        <Stat label="Server" value={trace.server} hint={new Date(trace.timestamp).toLocaleString()} />
      </div>
      <Card className="mt-4">
        <div className="flex gap-4 border-b border-slate-800 px-5 text-sm">
          {(['timeline', 'records'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`-mb-px border-b-2 py-3 capitalize ${tab === t ? 'border-sky-400 text-white' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
              {t === 'records' ? `Raw records (${records.length})` : 'Timeline'}
            </button>
          ))}
        </div>
        {tab === 'timeline' ? (
          <div className="grid lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="p-5"><Waterfall spans={spans} total={trace.duration_ms} onSelect={setSelected} selected={selected?.id} /></div>
            <aside className="border-t border-slate-800 p-5 text-xs lg:border-l lg:border-t-0">
              {selected ? (
                <div className="space-y-3">
                  <div className="text-[11px] uppercase tracking-wide text-slate-500">{selected.type}</div>
                  <pre className="whitespace-pre-wrap break-all rounded-lg bg-slate-950 p-3 font-mono text-slate-200">{selected.label}</pre>
                  <dl className="grid grid-cols-[90px_1fr] gap-y-1.5">
                    <dt className="text-slate-500">Start</dt><dd>{ms(selected.start_ms)}</dd>
                    <dt className="text-slate-500">Duration</dt><dd>{ms(selected.duration_ms)}</dd>
                    {Object.entries(selected.meta ?? {}).map(([k, v]) => (
                      <Fragment key={k}><dt className="text-slate-500">{k}</dt><dd className="break-all font-mono">{k === 'sql_hash' ? <Link className="text-sky-400 hover:underline" to={`/queries/${v}`}>{String(v).slice(0, 12)}…</Link> : v}</dd></Fragment>
                    ))}
                  </dl>
                </div>
              ) : <div className="text-slate-500">Select a span to inspect it.</div>}
            </aside>
          </div>
        ) : (
          <pre className="max-h-[560px] overflow-auto p-5 font-mono text-xs text-slate-300">{JSON.stringify(records, null, 2)}</pre>
        )}
      </Card>
    </>
  );
}
