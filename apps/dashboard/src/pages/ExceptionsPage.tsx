import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkline } from '@/components/charts';
import { Empty, ErrorState, Loading, PageHeader, Panel, SearchBox } from '@/components/common';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, useAsync } from '@/lib/api';
import { ago } from '@/lib/format';
import { useRange } from '@/lib/range';

export default function ExceptionsPage() {
  const { range } = useRange();
  const navigate = useNavigate();
  const { data: all, error, loading } = useAsync(() => api.exceptions(range), [range]);
  const [q, setQ] = useState('');
  const [handled, setHandled] = useState<'all' | 'handled' | 'unhandled'>('all');
  const needle = q.toLowerCase().trim();
  const data = all?.filter(
    (e) => (handled === 'all' || e.handled === (handled === 'handled')) && (!needle || `${e.class} ${e.message} ${e.file}`.toLowerCase().includes(needle)),
  );

  return (
    <>
      <PageHeader title="Exceptions" subtitle="Grouped by class, code and location" />
      <Panel
        title={`${data?.length ?? 0} groups`}
        actions={
          <div className="flex items-center gap-2">
            <ToggleGroup type="single" variant="outline" size="sm" value={handled} onValueChange={(v) => v && setHandled(v as typeof handled)} aria-label="Handled filter">
              {(['all', 'unhandled', 'handled'] as const).map((h) => (
                <ToggleGroupItem key={h} value={h} className="px-3 text-xs capitalize">{h}</ToggleGroupItem>
              ))}
            </ToggleGroup>
            <SearchBox value={q} onChange={setQ} placeholder="Search class, message or file…" />
          </div>
        }
      >
        {error ? <ErrorState error={error} /> : loading || !data ? <Loading /> : data.length === 0 ? <Empty>{needle || handled !== 'all' ? 'No exceptions match these filters.' : `No exceptions in the last ${range}.`}</Empty> : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-5">Exception</TableHead>
                <TableHead>Trend</TableHead>
                <TableHead className="text-right">Events</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead className="px-5">First seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((e) => (
                <TableRow key={e.group} onClick={() => navigate(`/exceptions/${e.group}`)} className="cursor-pointer">
                  <TableCell className="max-w-xl px-5 py-3 whitespace-normal">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-xs text-destructive">{e.class}</span>
                      <Badge variant={e.handled ? 'secondary' : 'destructive'} className="h-4 px-1.5 text-[10px]">{e.handled ? 'handled' : 'unhandled'}</Badge>
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">{e.message}</div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/70">{e.file}:{e.line}</div>
                  </TableCell>
                  <TableCell><Sparkline values={e.trend} className="text-chart-2" /></TableCell>
                  <TableCell className="text-right tabular-nums">{e.count}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{e.users}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{ago(e.last_seen)}</TableCell>
                  <TableCell className="px-5 text-xs text-muted-foreground">{ago(e.first_seen)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </>
  );
}
