import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { InputGroup } from '@cloudflare/kumo/components/input-group';
import { Select } from '@cloudflare/kumo/components/select';
import { Table } from '@cloudflare/kumo/components/table';
import { HardDrivesIcon, TimerIcon, UserIcon, XIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import Link from '@/components/ScopedLink';
import { Empty, ErrorState, FilterBar, Loading, PageHeader, PaginationBar, Panel, SearchBox, SourceBadge, StatusBadge, TimeAgo } from '@/components/common';
import { api, useAsync } from '@/lib/api';
import { ms } from '@/lib/format';
import { useProject } from '@/lib/project';
import { useRange } from '@/lib/range';
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

function DebouncedFilterInput({
  value,
  onChange,
  icon,
  placeholder,
  ariaLabel,
  type = 'text',
  className = 'w-40',
}: {
  value: string;
  onChange: (value: string) => void;
  icon: ReactNode;
  placeholder: string;
  ariaLabel: string;
  type?: 'text' | 'number';
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const commit = (next: string, immediate = false) => {
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    if (immediate) onChange(next);
    else timer.current = setTimeout(() => onChange(next), 180);
  };

  return (
    <InputGroup className={className}>
      <InputGroup.Addon align="start">{icon}</InputGroup.Addon>
      <InputGroup.Input
        type={type}
        min={type === 'number' ? '0' : undefined}
        step={type === 'number' ? 'any' : undefined}
        placeholder={placeholder}
        aria-label={ariaLabel}
        value={draft}
        onChange={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit(draft, true);
          else if (event.key === 'Escape' && draft) commit('', true);
        }}
      />
      {draft && (
        <InputGroup.Addon align="end">
          <button
            type="button"
            onClick={() => commit('', true)}
            aria-label={`Clear ${ariaLabel}`}
            className="grid size-5 place-items-center rounded text-kumo-subtle transition-colors hover:text-kumo-strong"
          >
            <XIcon size={12} />
          </button>
        </InputGroup.Addon>
      )}
    </InputGroup>
  );
}

export default function TracesPage() {
  const [params, setParams] = useSearchParams();
  const filters: TraceFilters = {
    source: (params.get('source') ?? 'all') as TraceFilters['source'],
    status: (params.get('status') ?? 'all') as TraceFilters['status'],
    q: params.get('q') ?? '',
    user: params.get('user') || undefined,
    server: params.get('server') || undefined,
    environment: params.get('environment') || undefined,
    min_duration_ms: params.get('min_duration_ms') || undefined,
  };
  const cursor = params.get('cursor');
  const { range } = useRange();
  const { projectId } = useProject();
  const scope = JSON.stringify([projectId, range, filters]);
  const [paging, setPaging] = useState<{ scope: string; cursor: string | null; history: (string | null)[] }>({ scope, cursor, history: [] });
  const history = paging.scope === scope && paging.cursor === cursor ? paging.history : [];
  const { data, error, loading, fetching } = useAsync(() => api.traces({ ...filters, range }, cursor), [scope, cursor], { keepPreviousData: true });

  const setCursor = (value: string | null) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    if (value) next.set('cursor', value); else next.delete('cursor');
    return next;
  });

  const pageTo = (value: string | null, nextHistory: (string | null)[]) => {
    setCursor(value);
    setPaging({ scope, cursor: value, history: nextHistory });
  };

  const update = (patch: TraceFilters) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(patch)) {
        if (value && (['q', 'user', 'server', 'environment', 'min_duration_ms'].includes(key) || value !== 'all')) next.set(key, value);
        else next.delete(key);
      }
      next.delete('cursor');
      return next;
    }, { replace: true });
    setPaging({ scope, cursor: null, history: [] });
  };

  const hasFilters = Boolean(filters.q || filters.source !== 'all' || filters.status !== 'all' || filters.min_duration_ms || filters.user || filters.server);

  const clearFilters = () => update({ q: '', source: 'all', status: 'all', min_duration_ms: '', user: '', server: '' });

  return (
    <>
      <PageHeader title="Traces" subtitle="Every request, queued job and command, newest first" />

      <FilterBar>
        <SearchBox className="min-w-64 flex-1" value={filters.q ?? ''} onChange={(q) => update({ q })} placeholder="Search route, trace ID or user…" />
        <Select
          aria-label="Execution type"
          className="w-36"
          value={filters.source}
          onValueChange={(v) => update({ source: (v ?? 'all') as TraceFilters['source'] })}
          items={SOURCES.map((s) => ({ value: s.value as string, label: s.label }))}
        />
        <Select
          aria-label="Status"
          className="w-32"
          value={filters.status}
          onValueChange={(v) => update({ status: (v ?? 'all') as TraceFilters['status'] })}
          items={STATUSES.map((s) => ({ value: s.value as string, label: s.label }))}
        />
        <DebouncedFilterInput
          type="number"
          className="w-36"
          icon={<TimerIcon className="text-kumo-subtle" />}
          placeholder="Min ms"
          ariaLabel="Minimum duration (ms)"
          value={filters.min_duration_ms ?? ''}
          onChange={(min_duration_ms) => update({ min_duration_ms })}
        />
        <DebouncedFilterInput
          className="w-40"
          icon={<UserIcon className="text-kumo-subtle" />}
          placeholder="User ID"
          ariaLabel="User ID"
          value={filters.user ?? ''}
          onChange={(user) => update({ user })}
        />
        <DebouncedFilterInput
          className="w-40"
          icon={<HardDrivesIcon className="text-kumo-subtle" />}
          placeholder="Server"
          ariaLabel="Server"
          value={filters.server ?? ''}
          onChange={(server) => update({ server })}
        />
        {hasFilters && (
          <Button variant="ghost" size="sm" icon={XIcon} onClick={clearFilters}>
            Clear
          </Button>
        )}
      </FilterBar>

      <Panel fetching={!loading && fetching}>
        {error ? (
          <ErrorState error={error} />
        ) : loading || !data ? (
          <Loading rows={10} />
        ) : data.data.length === 0 ? (
          <Empty
            description={hasFilters ? 'Try broadening your filters or choosing a wider time window.' : undefined}
            action={hasFilters ? <Button variant="secondary" size="sm" onClick={clearFilters}>Clear filters</Button> : undefined}
          >
            No traces match these filters.
          </Empty>
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>When</Table.Head>
                <Table.Head>Type</Table.Head>
                <Table.Head>Execution</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head className="text-right">Duration</Table.Head>
                <Table.Head className="text-right">Queries</Table.Head>
                <Table.Head>User</Table.Head>
                <Table.Head>Origin</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.data.map((t) => (
                <Table.Row key={t.trace_id} className="transition-colors hover:bg-kumo-tint/50">
                  <Table.Cell className="text-xs"><TimeAgo iso={t.timestamp} /></Table.Cell>
                  <Table.Cell><SourceBadge source={t.execution_source} /></Table.Cell>
                  <Table.Cell className="max-w-md">
                    <div className="flex items-center gap-2.5">
                      <Link className="truncate font-mono text-xs text-kumo-link hover:underline" to={`/traces/${t.trace_id}`}>
                        {t.name}
                      </Link>
                      {t.exception_count > 0 && <Badge variant="error" className="shrink-0">exception</Badge>}
                    </div>
                  </Table.Cell>
                  <Table.Cell><StatusBadge status={t.status_code} source={t.execution_source} /></Table.Cell>
                  <Table.Cell className={`text-right font-mono text-xs tabular-nums ${t.duration_ms > 2000 ? 'font-medium text-kumo-danger' : t.duration_ms > 500 ? 'font-medium text-kumo-warning' : ''}`}>
                    {ms(t.duration_ms)}
                  </Table.Cell>
                  <Table.Cell className="text-right tabular-nums text-kumo-subtle">{t.query_count}</Table.Cell>
                  <Table.Cell className="font-mono text-xs text-kumo-subtle">{t.user ? `#${t.user}` : '—'}</Table.Cell>
                  <Table.Cell>
                    <div className="font-mono text-xs text-kumo-default">{t.server}</div>
                    <div className="mt-0.5 text-xs text-kumo-subtle">{t.environment || 'Unknown'}</div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
        <PaginationBar
          status={data ? `Showing ${data.data.length} trace${data.data.length === 1 ? '' : 's'}` : undefined}
          onFirst={() => pageTo(null, [])}
          firstDisabled={!cursor}
          onPrevious={() => pageTo(history[history.length - 1], history.slice(0, -1))}
          previousDisabled={history.length === 0}
          onNext={() => {
            const next = data?.next_cursor;
            if (next) pageTo(next, [...history, cursor]);
          }}
          nextDisabled={fetching || !!error || !data?.next_cursor}
        />
      </Panel>
    </>
  );
}
