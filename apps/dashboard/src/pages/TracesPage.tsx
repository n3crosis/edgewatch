import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Empty, ErrorState, Loading, PageHeader, Panel, SourceBadge, StatusBadge } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, useAsync } from '@/lib/api';
import { useRange } from '@/lib/range';
import { ago, ms } from '@/lib/format';
import type { TraceFilters } from '@/lib/types';

const SOURCES = [
  { value: 'all', label: 'All types' },
  { value: 'request', label: 'Requests' },
  { value: 'job', label: 'Jobs' },
  { value: 'command', label: 'Commands' },
  { value: 'schedule', label: 'Scheduled' },
  { value: 'browser', label: 'Browser' },
] as const;
const STATUSES = [
  { value: 'all', label: 'Any status' },
  { value: '2xx', label: '2xx' },
  { value: '3xx', label: '3xx' },
  { value: '4xx', label: '4xx' },
  { value: '5xx', label: '5xx' },
] as const;

export default function TracesPage() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<TraceFilters>({ source: 'all', status: 'all', q: '' });
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<(string | null)[]>([]);
  const { range } = useRange();
  const { data, error, loading } = useAsync(() => api.traces({ ...filters, range }, cursor), [filters.source, filters.status, filters.q, range, cursor]);

  const update = (patch: TraceFilters) => {
    setFilters((f) => ({ ...f, ...patch }));
    setCursor(null);
    setHistory([]);
  };

  return (
    <>
      <PageHeader title="Traces" subtitle="Every request, queued job and command, newest first" />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-64 flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={filters.q} onChange={(e) => update({ q: e.target.value })} placeholder="Search route, trace ID or user…" className="pl-9" />
        </div>
        <Select value={filters.source} onValueChange={(v) => update({ source: v as TraceFilters['source'] })}>
          <SelectTrigger className="w-36" aria-label="Execution type"><SelectValue /></SelectTrigger>
          <SelectContent>{SOURCES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={filters.status} onValueChange={(v) => update({ status: v as TraceFilters['status'] })}>
          <SelectTrigger className="w-32" aria-label="Status"><SelectValue /></SelectTrigger>
          <SelectContent>{STATUSES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <Panel>
        {error ? <ErrorState error={error} /> : loading || !data ? <Loading rows={10} /> : data.data.length === 0 ? <Empty>No traces match these filters.</Empty> : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-5">When</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead className="text-right">Queries</TableHead>
                <TableHead>User</TableHead>
                <TableHead className="px-5">Server</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.data.map((t) => (
                <TableRow key={t.trace_id} onClick={() => navigate(`/traces/${t.trace_id}`)} className="cursor-pointer">
                  <TableCell className="px-5 text-xs text-muted-foreground">{ago(t.timestamp)}</TableCell>
                  <TableCell><SourceBadge source={t.execution_source} /></TableCell>
                  <TableCell className="max-w-md truncate font-mono text-xs">
                    {t.name}
                    {t.exception_count > 0 && <Badge variant="destructive" className="ml-2 h-4 px-1.5 text-[10px]">exception</Badge>}
                  </TableCell>
                  <TableCell><StatusBadge status={t.status_code} source={t.execution_source} /></TableCell>
                  <TableCell className={`text-right tabular-nums ${t.duration_ms > 500 ? 'text-amber-300' : ''}`}>{ms(t.duration_ms)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{t.query_count}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{t.user ? `#${t.user}` : '—'}</TableCell>
                  <TableCell className="px-5 text-xs text-muted-foreground">{t.server}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <div className="flex justify-end gap-2 border-t px-5 py-3">
          <Button variant="outline" size="sm" disabled={history.length === 0} onClick={() => { setCursor(history[history.length - 1]); setHistory(history.slice(0, -1)); }}>
            <ChevronLeft /> Previous
          </Button>
          <Button variant="outline" size="sm" disabled={!data?.next_cursor} onClick={() => { setHistory([...history, cursor]); setCursor(data!.next_cursor); }}>
            Next <ChevronRight />
          </Button>
        </div>
      </Panel>
    </>
  );
}
