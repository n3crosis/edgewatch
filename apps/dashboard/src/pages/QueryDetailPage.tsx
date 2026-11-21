import { Link, useParams } from 'react-router-dom';
import { Empty, ErrorState, Loading, PageHeader, Panel, Sql, Stat } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
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
          <TableHeader>
            <TableRow>
              <TableHead className="px-5">When</TableHead>
              <TableHead>Trace</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="px-5 text-right">Duration</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.samples.map((s, i) => (
              <TableRow key={`${s.trace_id}-${i}`}>
                <TableCell className="px-5 text-xs text-muted-foreground">{ago(s.timestamp)}</TableCell>
                <TableCell><Link to={`/traces/${s.trace_id}`} className="font-mono text-xs text-primary hover:underline">{s.name}</Link></TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{s.file}:{s.line}</TableCell>
                <TableCell className="px-5 text-right tabular-nums">{ms(s.duration_ms)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
    </>
  );
}
