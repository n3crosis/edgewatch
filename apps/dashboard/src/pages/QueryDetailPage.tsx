import { groupListLink } from '@/lib/group-list';
import { useRange, rangeLabel } from '@/lib/range';
import { useParams, useSearchParams } from 'react-router-dom';
import Link from '@/components/ScopedLink';
import { CopyButton, Empty, ErrorState, Loading, PageHeader, Panel, Sql, Stat, TimeAgo } from '@/components/common';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Table } from '@cloudflare/kumo/components/table';
import { api, useAsync } from '@/lib/api';
import { compact, ms } from '@/lib/format';

export default function QueryDetailPage() {
  const { sqlHash = '' } = useParams();
  const { range } = useRange();
  const [params] = useSearchParams();
  const { data, error, loading } = useAsync(() => api.query(sqlHash, range), [sqlHash, range]);

  if (error) return <ErrorState error={error} />;
  if (loading) return <Loading />;
  if (!data) return <Empty>Query not found.</Empty>;

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ to: groupListLink('/queries', params), label: 'Queries' }}
        documentTitle={`Query ${data.sql_hash.slice(0, 8)}`}
        title="Query"
        subtitle={
          <span className="mt-1.5 flex flex-wrap items-center gap-2.5">
            <Badge variant="outline" className="font-mono">{data.connection}</Badge>
            <span className="inline-flex items-center gap-1.5 rounded-md bg-kumo-recessed px-2.5 py-1 font-mono text-xs text-kumo-subtle">
              sql_hash {data.sql_hash}
              <CopyButton text={data.sql_hash} label="Copy SQL hash" toastMessage="SQL hash copied." className="size-5" />
            </span>
          </span>
        }
      />

      <Panel title="Normalized SQL" actions={<CopyButton text={data.sql} label="Copy SQL" toastMessage="SQL copied to clipboard." />}>
        <pre className="whitespace-pre-wrap bg-kumo-recessed/40 p-6 leading-7"><Sql sql={data.sql} className="text-sm" /></pre>
      </Panel>

      <section className="grid grid-cols-1 gap-5 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
        <Stat label={`Calls (${rangeLabel(range)})`} value={compact(data.calls)} />
        <Stat label="Total time" value={ms(data.total_ms)} />
        <Stat label="Average" value={ms(data.avg_ms)} />
        <Stat label="p95" value={ms(data.p95_ms)} tone={data.p95_ms > 500 ? 'bad' : data.p95_ms > 100 ? 'warn' : 'default'} />
        <Stat label="Max" value={ms(data.max_ms)} tone={data.max_ms > 500 ? 'warn' : 'default'} />
      </section>

      <Panel title="Slowest executions">
        {data.samples.length === 0 ? (
          <Empty>No sample executions recorded.</Empty>
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
                <Table.Row key={`${s.trace_id}-${i}`} className="transition-colors hover:bg-kumo-tint/50">
                  <Table.Cell className="text-xs"><TimeAgo iso={s.timestamp} /></Table.Cell>
                  <Table.Cell>
                    <Link to={`/traces/${s.trace_id}`} className="font-mono text-xs text-kumo-link hover:underline">{s.name}</Link>
                  </Table.Cell>
                  <Table.Cell className="font-mono text-xs text-kumo-subtle">{s.file}:{s.line}</Table.Cell>
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
