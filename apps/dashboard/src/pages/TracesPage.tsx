import { Button } from '@cloudflare/kumo/components/button';
import { Select } from '@cloudflare/kumo/components/select';
import { CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Empty, ErrorState, Loading, PageHeader, Panel, SearchBox, SourceBadge, StatusBadge } from '@/components/common';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Table } from '@cloudflare/kumo/components/table';
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
        <SearchBox className="min-w-64 flex-1" value={filters.q ?? ''} onChange={(q) => update({ q })} placeholder="Search route, trace ID or user…" />
        <Select
          aria-label="Execution type"
          size="sm"
          className="w-36"
          value={filters.source}
          onValueChange={(v) => update({ source: (v ?? 'all') as TraceFilters['source'] })}
          items={SOURCES.map((s) => ({ value: s.value as string, label: s.label }))}
        />
        <Select
          aria-label="Status"
          size="sm"
          className="w-32"
          value={filters.status}
          onValueChange={(v) => update({ status: (v ?? 'all') as TraceFilters['status'] })}
          items={STATUSES.map((s) => ({ value: s.value as string, label: s.label }))}
        />
      </div>
      <Panel>
        {error ? <ErrorState error={error} /> : loading || !data ? <Loading rows={10} /> : data.data.length === 0 ? <Empty>No traces match these filters.</Empty> : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head className="px-5">When</Table.Head>
                <Table.Head>Type</Table.Head>
                <Table.Head>Name</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head className="text-right">Duration</Table.Head>
                <Table.Head className="text-right">Queries</Table.Head>
                <Table.Head>User</Table.Head>
                <Table.Head className="px-5">Server</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.data.map((t) => (
                <Table.Row key={t.trace_id} onClick={() => navigate(`/traces/${t.trace_id}`)} className="cursor-pointer">
                  <Table.Cell className="px-5 text-xs text-kumo-subtle">{ago(t.timestamp)}</Table.Cell>
                  <Table.Cell><SourceBadge source={t.execution_source} /></Table.Cell>
                  <Table.Cell className="max-w-md truncate font-mono text-xs">
                    {t.name}
                    {t.exception_count > 0 && <Badge variant="error" className="ml-2 text-[10px]">exception</Badge>}
                  </Table.Cell>
                  <Table.Cell><StatusBadge status={t.status_code} source={t.execution_source} /></Table.Cell>
                  <Table.Cell className={`text-right tabular-nums ${t.duration_ms > 500 ? 'text-kumo-warning' : ''}`}>{ms(t.duration_ms)}</Table.Cell>
                  <Table.Cell className="text-right tabular-nums text-kumo-subtle">{t.query_count}</Table.Cell>
                  <Table.Cell className="text-xs text-kumo-subtle">{t.user ? `#${t.user}` : '—'}</Table.Cell>
                  <Table.Cell className="px-5 text-xs text-kumo-subtle">{t.server}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
        <div className="flex justify-end gap-2 border-t border-kumo-hairline px-5 py-3">
          <Button variant="secondary" size="sm" icon={CaretLeftIcon} disabled={history.length === 0} onClick={() => { setCursor(history[history.length - 1]); setHistory(history.slice(0, -1)); }}>
            Previous
          </Button>
          <Button variant="secondary" size="sm" disabled={!data?.next_cursor} onClick={() => { setHistory([...history, cursor]); setCursor(data!.next_cursor); }}>
            Next <CaretRightIcon />
          </Button>
        </div>
      </Panel>
    </>
  );
}
