import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Empty, ErrorState, Loading, PageHeader, Panel, SourceBadge, Stat, StatusBadge } from '@/components/common';
import Waterfall, { SPAN_COLORS } from '@/components/Waterfall';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, useAsync } from '@/lib/api';
import { ms } from '@/lib/format';
import type { Span } from '@/lib/types';
import { cn } from '@/lib/utils';

function SpanSheet({ span, onClose }: { span: Span | null; onClose: () => void }) {
  return (
    <Sheet open={span !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="sm:max-w-md">
        {span && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <span className={cn('size-2.5 rounded-full', SPAN_COLORS[span.type])} />
                <span className="capitalize">{span.type.replace('-', ' ')}</span>
              </SheetTitle>
              <SheetDescription>
                {ms(span.duration_ms)} starting at +{ms(span.start_ms)}
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-4 px-4 text-sm">
              <pre className="whitespace-pre-wrap break-all rounded-lg bg-muted p-3 font-mono text-xs">{span.label}</pre>
              <Separator />
              <dl className="grid grid-cols-[100px_1fr] gap-y-2 text-xs">
                <dt className="text-muted-foreground">Start</dt>
                <dd>{ms(span.start_ms)}</dd>
                <dt className="text-muted-foreground">Duration</dt>
                <dd>{ms(span.duration_ms)}</dd>
                {Object.entries(span.meta ?? {}).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="break-all font-mono">
                      {k === 'sql_hash' ? <Link className="text-primary hover:underline" to={`/queries/${v}`}>{String(v)}</Link> : v}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default function TraceDetailPage() {
  const { traceId = '' } = useParams();
  const { data, error, loading } = useAsync(() => api.trace(traceId), [traceId]);
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
      <Tabs defaultValue="timeline" className="mt-4">
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="records">
            Raw records <Badge variant="secondary" className="ml-1 h-4 px-1.5 text-[10px]">{records.length}</Badge>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="timeline">
          <Panel title="Waterfall" actions={<span className="text-xs text-muted-foreground">Click a span for details</span>}>
            <div className="p-5">
              <Waterfall spans={spans} total={trace.duration_ms} onSelect={setSelected} selected={selected?.id} />
            </div>
          </Panel>
        </TabsContent>
        <TabsContent value="records">
          <Panel title="Nightwatch records as stored in R2">
            <ScrollArea className="h-[560px]">
              <pre className="p-5 font-mono text-xs">{JSON.stringify(records, null, 2)}</pre>
            </ScrollArea>
          </Panel>
        </TabsContent>
      </Tabs>
      <SpanSheet span={selected} onClose={() => setSelected(null)} />
    </>
  );
}
