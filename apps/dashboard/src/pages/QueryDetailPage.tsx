import { Link, useParams } from 'react-router-dom';
import { Empty, ErrorState, Loading, PageHeader, Panel, Sql, Stat } from '@/components/common';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Table } from '@cloudflare/kumo/components/table';
import { api, useAsync } from '@/lib/api';
import { ago, compact, ms } from '@/lib/format';

export default function QueryDetailPage() {
  const { sqlHash = '' } = useParams();
  const { data, error, loading } = useAsync(() => api.query(sqlHash), [sqlHash]);

  if (error) return <ErrorState error={error} />;
  if (loading) return <Loading />;
  if (!data) return <Empty>Query not found.</Empty>;

  return (
    <>
      <PageHeader
        back={{ to: '/queries', label: 'Queries' }}
        title="Query"
        subtitle={
          <span className="flex items-center gap-2">
            <Badge variant="outline">{data.connection}</Badge>
            <span className="font-mono text-xs">sql_hash {data.sql_hash}</span>
          </span>
        }
      />
      <Panel className="mb-4">
        <pre className="whitespace-pre-wrap p-5"><Sql sql={data.sql} className="text-sm" /></pre>
      </Panel>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Calls (24h)" value={compact(data.calls)} />
        <Stat label="Total time" value={ms(data.total_ms)} />
        <Stat label="Average" value={ms(data.avg_ms)} />
        <Stat label="p95" value={ms(data.p95_ms)} tone={data.p95_ms > 100 ? 'warn' : 'default'} />
        <Stat label="Max" value={ms(data.max_ms)} />
      </div>
      <Panel title="Slowest executions" className="mt-4">
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.Head className="px-5">When</Table.Head>
              <Table.Head>Trace</Table.Head>
              <Table.Head>Location</Table.Head>
              <Table.Head className="px-5 text-right">Duration</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data.samples.map((s, i) => (
              <Table.Row key={`${s.trace_id}-${i}`}>
                <Table.Cell className="px-5 text-xs text-kumo-subtle">{ago(s.timestamp)}</Table.Cell>
                <Table.Cell><Link to={`/traces/${s.trace_id}`} className="font-mono text-xs text-kumo-link hover:underline">{s.name}</Link></Table.Cell>
                <Table.Cell className="font-mono text-xs text-kumo-subtle">{s.file}:{s.line}</Table.Cell>
                <Table.Cell className="px-5 text-right tabular-nums">{ms(s.duration_ms)}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </Panel>
    </>
  );
}
