import { Link, useParams } from 'react-router-dom';
import { BarChart } from '@/components/charts';
import { Empty, ErrorState, Loading, PageHeader, Panel, Stat } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, useAsync } from '@/lib/api';
import { ago } from '@/lib/format';

export default function ExceptionDetailPage() {
  const { group = '' } = useParams();
  const { data, error, loading } = useAsync(() => api.exception(group), [group]);

  if (error) return <ErrorState error={error} />;
  if (loading) return <Loading />;
  if (!data) return <Empty>Exception group not found.</Empty>;

  return (
    <>
      <PageHeader
        back={{ to: '/exceptions', label: 'Exceptions' }}
        title={<span className="font-mono text-destructive">{data.class}</span>}
        subtitle={
          <span className="flex items-center gap-2">
            <Badge variant={data.handled ? 'secondary' : 'destructive'}>{data.handled ? 'handled' : 'unhandled'}</Badge>
            {data.message}
          </span>
        }
      />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Events (24h)" value={data.count} tone="bad" />
        <Stat label="Users affected" value={data.users} />
        <Stat label="First seen" value={ago(data.first_seen)} />
        <Stat label="Last seen" value={ago(data.last_seen)} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Stack trace">
          <ol className="font-mono text-xs">
            {data.stack.map((f, i) => (
              <li key={i}>
                {i > 0 && <Separator />}
                <div className={`px-5 py-2.5 ${f.file.startsWith('vendor/') ? 'text-muted-foreground/60' : ''}`}>
                  <div>{f.source}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{f.file}</div>
                </div>
              </li>
            ))}
          </ol>
        </Panel>
        <div className="space-y-4">
          <Panel title="Occurrences over 24h">
            <div className="px-5 pb-4 pt-6">
              <BarChart height={100} series={data.trend.map((v, i) => ({ label: `${24 - i}h ago`, value: v }))} />
            </div>
          </Panel>
          <Panel title="Recent occurrences">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-5">When</TableHead>
                  <TableHead>Trace</TableHead>
                  <TableHead className="px-5">User</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.occurrences.slice(0, 8).map((o) => (
                  <TableRow key={o.trace_id}>
                    <TableCell className="px-5 text-xs text-muted-foreground">{ago(o.timestamp)}</TableCell>
                    <TableCell><Link to={`/traces/${o.trace_id}`} className="font-mono text-xs text-primary hover:underline">{o.name}</Link></TableCell>
                    <TableCell className="px-5 text-xs text-muted-foreground">{o.user ? `#${o.user}` : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
        </div>
      </div>
    </>
  );
}
