import { exceptionHandling } from '@/lib/exception-handling';
import { groupListLink } from '@/lib/group-list';
import { timeWindow } from '@edgewatch/shared/time-window';
import { useEnvironment } from '@/lib/environment';
import { useProject } from '@/lib/project';
import { useRange, rangeLabel } from '@/lib/range';
import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import Link, { scopedPath } from '@/components/ScopedLink';
import { BarChart } from '@/components/charts';
import { CopyButton, Empty, ErrorState, Loading, PageHeader, Panel, Stat, TimeAgo } from '@/components/common';
import { Badge } from '@cloudflare/kumo/components/badge';
import { LinkButton } from '@cloudflare/kumo/components/button';
import { Table } from '@cloudflare/kumo/components/table';
import { Tabs } from '@cloudflare/kumo/components/tabs';
import { WarningOctagonIcon } from '@phosphor-icons/react';
import { api, USING_MOCK, useAsync } from '@/lib/api';
import { ago, compact } from '@/lib/format';
import { formatStackTrace } from '@/lib/ui-helpers';

export default function ExceptionDetailPage() {
  const { group = '' } = useParams();
  const { range } = useRange();
  const { projectId } = useProject();
  const { environment } = useEnvironment();
  const [params] = useSearchParams();
  const user = params.get('user') || undefined;
  const [frameFilter, setFrameFilter] = useState<'all' | 'app'>('all');
  const { data, error, loading } = useAsync(() => api.exception(group, range, user), [group, range, user]);

  if (error) return <ErrorState error={error} />;
  if (loading) return <Loading />;
  if (!data) return <Empty>Exception group not found.</Empty>;

  const appFrames = data.stack.filter((f) => !f.file.startsWith('vendor/'));
  const hasVendorFrames = appFrames.length > 0 && appFrames.length < data.stack.length;
  const indexedFrames = data.stack
    .map((frame, index) => ({ frame, index, vendor: frame.file.startsWith('vendor/') }))
    .filter((item) => frameFilter === 'all' || !item.vendor);
  const stackText = formatStackTrace(
    data.class,
    data.message,
    indexedFrames.map((item) => item.frame),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ to: groupListLink('/exceptions', params), label: 'Exceptions' }}
        documentTitle={data.class.split('\\').pop() || data.class}
        title={<span className="font-mono text-kumo-danger">{data.class}</span>}
        subtitle={
          <div className="mt-1.5 space-y-2">
            <div className="flex flex-wrap items-center gap-2.5">
              <Badge variant={data.handled ? 'secondary' : 'error'}>{exceptionHandling(data)}</Badge>
              {user && <Badge variant="outline" className="font-mono">User #{user}</Badge>}
              <span className="text-kumo-default">{data.message}</span>
            </div>
            {data.handled_count !== undefined && data.unhandled_count !== undefined && (
              <div className="text-xs text-kumo-subtle">
                {data.unhandled_count} unhandled · {data.handled_count} handled occurrences in this scope
              </div>
            )}
          </div>
        }
        actions={
          !USING_MOCK && !data.handled ? (
            <LinkButton href={scopedPath(`/issues/${data.group}`, projectId, range, environment)} variant="secondary" size="sm" icon={WarningOctagonIcon}>
              Triage issue
            </LinkButton>
          ) : undefined
        }
      />

      <section className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={`Events (${rangeLabel(range)})`} value={compact(data.count)} tone="bad" />
        <Stat label="Users affected" value={compact(data.users)} />
        <Stat label="First seen" value={ago(data.first_seen)} hint={new Date(data.first_seen).toLocaleString()} />
        <Stat label="Last seen" value={ago(data.last_seen)} hint={new Date(data.last_seen).toLocaleString()} />
      </section>

      <section className="grid grid-cols-1 gap-6 [&>*]:min-w-0 xl:grid-cols-2">
        <Panel
          title={`Stack trace (${indexedFrames.length}${frameFilter === 'app' ? ` of ${data.stack.length}` : ''} frames)`}
          actions={
            <div className="flex items-center gap-2.5">
              {hasVendorFrames && (
                <Tabs
                  variant="segmented"
                  size="sm"
                  value={frameFilter}
                  onValueChange={(value) => setFrameFilter(value as 'all' | 'app')}
                  tabs={[
                    { value: 'all', label: `All (${data.stack.length})` },
                    { value: 'app', label: `App (${appFrames.length})` },
                  ]}
                />
              )}
              <CopyButton text={stackText} label="Copy stack trace" toastMessage="Stack trace copied." />
            </div>
          }
        >
          <ol className="divide-y divide-kumo-hairline font-mono text-xs">
            {indexedFrames.map(({ frame, index, vendor }) => (
              <li
                key={index}
                className={`flex gap-4 px-6 py-3.5 ${vendor ? 'bg-kumo-recessed/30 text-kumo-subtle' : 'border-l-2 border-l-kumo-danger/70 text-kumo-strong'}`}
              >
                <span className="w-7 shrink-0 select-none text-right tabular-nums text-kumo-subtle">#{index}</span>
                <div className="min-w-0 flex-1">
                  <div className="break-words leading-relaxed">{frame.source}</div>
                  <div className="mt-1 break-all text-kumo-subtle">{frame.file}</div>
                </div>
              </li>
            ))}
          </ol>
        </Panel>

        <div className="space-y-6">
          <Panel title={`Occurrences over ${rangeLabel(range)}`}>
            <div className="p-6">
              <BarChart
                height={168}
                tone="danger"
                unit="occurrences"
                series={data.trend.map((v, i) => ({
                  label: new Date(timeWindow(range)!.since + i * timeWindow(range)!.width).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                  value: v,
                }))}
              />
            </div>
          </Panel>

          <Panel title="Recent occurrences">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>When</Table.Head>
                  <Table.Head>Trace</Table.Head>
                  <Table.Head>User</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.occurrences.slice(0, 8).map((o) => (
                  <Table.Row key={o.trace_id} className="transition-colors hover:bg-kumo-tint/50">
                    <Table.Cell className="text-xs"><TimeAgo iso={o.timestamp} /></Table.Cell>
                    <Table.Cell className="max-w-xs truncate">
                      <Link to={`/traces/${o.trace_id}`} className="font-mono text-xs text-kumo-link hover:underline">{o.name}</Link>
                    </Table.Cell>
                    <Table.Cell className="font-mono text-xs text-kumo-subtle">{o.user ? `#${o.user}` : '—'}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </Panel>
        </div>
      </section>
    </div>
  );
}
