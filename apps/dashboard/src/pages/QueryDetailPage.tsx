import { groupListLink } from '@/lib/group-list';
import { useRange, rangeLabel } from '@/lib/range';
import { useParams, useSearchParams } from 'react-router-dom';
import Link from '@/components/ScopedLink';
import { CardTray, CopyButton, Empty, ErrorState, Loading, PageHeader, Panel, Sql, Stat, TimeAgo, useRowNavigate } from '@/components/common';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Table } from '@cloudflare/kumo/components/table';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { ClockIcon, DatabaseIcon, GaugeIcon, LightningIcon, TimerIcon } from '@phosphor-icons/react';
import { api, useAsync } from '@/lib/api';
import { compact, ms } from '@/lib/format';
import { sqlSummary } from '@/lib/ui-helpers';

export default function QueryDetailPage() {
  const { sqlHash = '' } = useParams();
  const { range } = useRange();
  const rowNav = useRowNavigate();
  const [params] = useSearchParams();
  const { data, error, loading, fetching } = useAsync(() => api.query(sqlHash, range), [sqlHash, range], { keepPreviousData: true });

  if (error) return <ErrorState error={error} />;
  if (loading) return <Loading />;
  if (!data) {
    return (
      <>
        <PageHeader back={{ to: groupListLink('/queries', params), label: 'Queries' }} title="Query not found" />
        <Panel>
          <Empty
            icon={<DatabaseIcon size={32} className="text-kumo-subtle" />}
            description="This query pattern has no executions in the selected project or time window."
          >
            Query not found.
          </Empty>
        </Panel>
      </>
    );
  }

  const title = sqlSummary(data.sql);

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ to: groupListLink('/queries', params), label: 'Queries' }}
        documentTitle={title}
        title={title}
        subtitle={
          <span className="mt-1.5 flex flex-wrap items-center gap-2.5">
            <Badge variant="outline" className="inline-flex items-center gap-1.5 font-mono">
              <DatabaseIcon size={12} aria-hidden />
              <span>{data.connection}</span>
            </Badge>
            <span className="inline-flex items-center gap-1.5 rounded-md bg-kumo-recessed px-2.5 py-1 font-mono text-xs text-kumo-subtle">
              {data.sql_hash.slice(0, 16)}
              <CopyButton text={data.sql_hash} label="Copy SQL hash" toastMessage="SQL hash copied." className="size-5" />
            </span>
          </span>
        }
      />

      <Panel title="Normalized SQL" actions={<CopyButton text={data.sql} label="Copy SQL" toastMessage="SQL copied to clipboard." />}>
        <pre className="whitespace-pre-wrap bg-kumo-recessed/40 p-6 leading-7"><Sql sql={data.sql} className="text-sm" /></pre>
      </Panel>

      <CardTray>
        <section className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
          <Stat label={`Calls (${rangeLabel(range)})`} icon={<DatabaseIcon size={13} />} value={compact(data.calls)} />
          <Stat label="Total time" icon={<ClockIcon size={13} />} value={ms(data.total_ms)} />
          <Stat label="Average" icon={<TimerIcon size={13} />} value={ms(data.avg_ms)} />
          <Stat label="p95" icon={<GaugeIcon size={13} />} value={ms(data.p95_ms)} tone={data.p95_ms > 500 ? 'bad' : data.p95_ms > 100 ? 'warn' : 'default'} />
          <Stat label="Max" icon={<LightningIcon size={13} />} value={ms(data.max_ms)} tone={data.max_ms > 500 ? 'warn' : 'default'} />
        </section>
      </CardTray>

      <Panel fetching={!loading && fetching} title="Slowest executions">
        {data.samples.length === 0 ? (
          <Empty icon={<DatabaseIcon size={32} className="text-kumo-subtle" />}>No sample executions recorded.</Empty>
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>When</Table.Head>
                <Table.Head>Trace</Table.Head>
                <Table.Head>Location</Table.Head>
                <Table.Head className="text-right">Duration</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.samples.map((s, i) => (
                <Table.Row key={`${s.trace_id}-${i}`} onClick={rowNav(`/traces/${s.trace_id}`)} className="cursor-pointer transition-colors hover:bg-kumo-tint/50">
                  <Table.Cell className="text-xs"><TimeAgo iso={s.timestamp} /></Table.Cell>
                  <Table.Cell className="max-w-xs truncate">
                    <Link title={s.name} to={`/traces/${s.trace_id}`} className="font-mono text-xs text-kumo-link hover:underline">{s.name}</Link>
                  </Table.Cell>
                  <Table.Cell className="max-w-xs">
                    <Tooltip asChild content={`${s.file}:${s.line}`}>
                      <span className="block truncate font-mono text-xs text-kumo-subtle">{s.file}:{s.line}</span>
                    </Tooltip>
                  </Table.Cell>
                  <Table.Cell className={`text-right font-mono text-xs tabular-nums ${s.duration_ms > 500 ? 'font-medium text-kumo-danger' : s.duration_ms > 100 ? 'font-medium text-kumo-warning' : ''}`}>
                    {ms(s.duration_ms)}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </Panel>
    </div>
  );
}
