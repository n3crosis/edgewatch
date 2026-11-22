import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Empty, ErrorState, Loading, PageHeader, Panel, SourceBadge, Stat, StatusBadge } from '@/components/common';
import Waterfall, { SPAN_COLORS } from '@/components/Waterfall';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { Tabs } from '@cloudflare/kumo/components/tabs';
import { cn } from '@cloudflare/kumo/utils';
import { XIcon } from '@phosphor-icons/react';
import { api, useAsync } from '@/lib/api';
import { ms } from '@/lib/format';
import type { Span } from '@/lib/types';

function SpanSheet({ span, onClose }: { span: Span | null; onClose: () => void }) {
  return (
    <Dialog.Root open={span !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog size="lg" className="p-6">
        {span && (
          <>
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="flex items-center gap-2 text-lg font-semibold">
                  <span className={cn('size-2.5 rounded-full', SPAN_COLORS[span.type])} />
                  <span className="capitalize">{span.type.replace('-', ' ')}</span>
                </Dialog.Title>
                <Dialog.Description className="text-sm text-kumo-subtle">
                  {ms(span.duration_ms)} starting at +{ms(span.start_ms)}
                </Dialog.Description>
              </div>
              <Dialog.Close render={(props) => <Button {...props} variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />} />
            </div>
            <div className="space-y-4 text-sm">
              <pre className="whitespace-pre-wrap break-all rounded-lg bg-kumo-recessed p-3 font-mono text-xs">{span.label}</pre>
              <div className="border-t border-kumo-hairline" />
              <dl className="grid grid-cols-[100px_1fr] gap-y-2 text-xs">
                <dt className="text-kumo-subtle">Start</dt>
                <dd>{ms(span.start_ms)}</dd>
                <dt className="text-kumo-subtle">Duration</dt>
                <dd>{ms(span.duration_ms)}</dd>
                {Object.entries(span.meta ?? {}).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-kumo-subtle">{k}</dt>
                    <dd className="break-all font-mono">
                      {k === 'sql_hash' ? <Link className="text-kumo-link hover:underline" to={`/queries/${v}`}>{String(v)}</Link> : v}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </>
        )}
      </Dialog>
    </Dialog.Root>
  );
}

export default function TraceDetailPage() {
  const { traceId = '' } = useParams();
  const { data, error, loading } = useAsync(() => api.trace(traceId), [traceId]);
  const [selected, setSelected] = useState<Span | null>(null);
  const [tab, setTab] = useState('timeline');

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
        subtitle={
          <span className="flex items-center gap-2">
            <SourceBadge source={trace.execution_source} />
            <StatusBadge status={trace.status_code} source={trace.execution_source} />
            <span className="font-mono text-xs">{trace.trace_id}</span>
          </span>
        }
      />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Duration" value={ms(trace.duration_ms)} tone={trace.duration_ms > 500 ? 'warn' : 'default'} />
        <Stat label="Queries" value={trace.query_count} hint={`${ms(queryTime)} in database`} />
        <Stat label="Exceptions" value={trace.exception_count} tone={trace.exception_count ? 'bad' : 'good'} />
        <Stat label="User" value={trace.user ? `#${trace.user}` : '—'} />
        <Stat label="Server" value={trace.server} hint={new Date(trace.timestamp).toLocaleString()} />
      </div>
      <Tabs
        variant="underline"
        className="mt-4 mb-3"
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'timeline', label: 'Timeline' },
          { value: 'records', label: <span className="flex items-center gap-1.5">Raw records <Badge variant="secondary" className="text-[10px]">{records.length}</Badge></span> },
        ]}
      />
      {tab === 'timeline' ? (
          <Panel title="Waterfall" actions={<span className="text-xs text-kumo-subtle">Click a span for details</span>}>
            <div className="p-5">
              <Waterfall spans={spans} total={trace.duration_ms} onSelect={setSelected} selected={selected?.id} />
            </div>
          </Panel>
      ) : (
          <Panel title="Nightwatch records as stored in R2">
            <div className="h-[560px] overflow-auto">
              <pre className="p-5 font-mono text-xs">{JSON.stringify(records, null, 2)}</pre>
            </div>
          </Panel>
      )}
      <SpanSheet span={selected} onClose={() => setSelected(null)} />
    </>
  );
}
