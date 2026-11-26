import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { InputGroup } from '@cloudflare/kumo/components/input-group';
import { Select } from '@cloudflare/kumo/components/select';
import { Table } from '@cloudflare/kumo/components/table';
import { BugIcon, FunnelSimpleIcon, HardDrivesIcon, TimerIcon, UserIcon, WarningCircleIcon, XIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import Link from '@/components/ScopedLink';
import {
  Empty,
  ErrorState,
  FilterBar,
  FloatingTablePanel,
  Loading,
  PageHeader,
  PaginationBar,
  Panel,
  RowActionLink,
  SearchBox,
  SourceTag,
  StatusCodeText,
  UtcDate,
  useRowNavigate,
} from '@/components/common';
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
  className = 'w-44',
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
  const rowNav = useRowNavigate();
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
  const advancedCount = [filters.min_duration_ms, filters.user, filters.server].filter(Boolean).length;
  const moreFilterCount = [filters.min_duration_ms && filters.min_duration_ms !== '500', filters.user, filters.server].filter(Boolean).length;
  const [showMore, setShowMore] = useState(moreFilterCount > 0);
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

  const hasFilters = Boolean(filters.q || filters.source !== 'all' || filters.status !== 'all' || advancedCount > 0);
  const isErrorsOnly = filters.status === '5xx';
  const isSlowOnly = filters.min_duration_ms === '500';

  const clearFilters = () => update({ q: '', source: 'all', status: 'all', min_duration_ms: '', user: '', server: '' });

  return (
    <>
      <PageHeader title="Traces" />

      <FilterBar className="flex-col items-stretch">
        <div className="flex flex-wrap items-center gap-3">
          <SearchBox className="min-w-64 flex-1" value={filters.q ?? ''} onChange={(q) => update({ q })} placeholder="Search route, job name, or trace ID…" />
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
          <Button
            variant={isErrorsOnly ? 'primary' : 'secondary'}
            size="sm"
            icon={WarningCircleIcon}
            onClick={() => update({ status: isErrorsOnly ? 'all' : '5xx' })}
          >
            Errors (5xx)
          </Button>
          <Button
            variant={isSlowOnly ? 'primary' : 'secondary'}
            size="sm"
            icon={TimerIcon}
            onClick={() => update({ min_duration_ms: isSlowOnly ? '' : '500' })}
          >
            Slow (&gt;500ms)
          </Button>
          <Button
            variant={showMore || moreFilterCount > 0 ? 'secondary' : 'ghost'}
            size="sm"
            icon={FunnelSimpleIcon}
            aria-expanded={showMore}
            onClick={() => setShowMore((open) => !open)}
          >
            More filters
            {moreFilterCount > 0 && <Badge variant="primary" className="ml-1">{moreFilterCount}</Badge>}
          </Button>
          {hasFilters && (
            <Button variant="ghost" size="sm" icon={XIcon} onClick={clearFilters}>
              Clear
            </Button>
          )}
        </div>
        {showMore && (
          <div className="flex flex-wrap items-center gap-3 border-t border-kumo-hairline pt-3">
            <DebouncedFilterInput
              type="number"
              className="w-44"
              icon={<TimerIcon className="text-kumo-subtle" />}
              placeholder="Min duration (ms)"
              ariaLabel="Minimum duration (ms)"
              value={filters.min_duration_ms ?? ''}
              onChange={(min_duration_ms) => update({ min_duration_ms })}
            />
            <DebouncedFilterInput
              className="w-44"
              icon={<UserIcon className="text-kumo-subtle" />}
              placeholder="User ID"
              ariaLabel="User ID"
              value={filters.user ?? ''}
              onChange={(user) => update({ user })}
            />
            <DebouncedFilterInput
              className="w-48"
              icon={<HardDrivesIcon className="text-kumo-subtle" />}
              placeholder="Server host"
              ariaLabel="Server"
              value={filters.server ?? ''}
              onChange={(server) => update({ server })}
            />
          </div>
        )}
      </FilterBar>

      {error ? (
        <ErrorState error={error} />
      ) : loading || !data ? (
        <Panel><Loading rows={10} /></Panel>
      ) : data.data.length === 0 ? (
        <Empty
          action={hasFilters ? <Button variant="secondary" size="sm" onClick={clearFilters}>Clear filters</Button> : undefined}
        >
          No traces found
        </Empty>
      ) : (
        <FloatingTablePanel
          fetching={!loading && fetching}
          footer={
            cursor || history.length > 0 || data.next_cursor ? (
              <PaginationBar
                status={`Showing ${data.data.length} trace${data.data.length === 1 ? '' : 's'}`}
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
            ) : undefined
          }
        >
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Date</Table.Head>
                <Table.Head>Type</Table.Head>
                <Table.Head>Execution</Table.Head>
                <Table.Head className="text-right">Status</Table.Head>
                <Table.Head className="text-right">Duration</Table.Head>
                <Table.Head className="text-right">Queries</Table.Head>
                <Table.Head>Server</Table.Head>
                <Table.Head className="w-12" />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.data.map((t) => (
                <Table.Row
                  key={t.trace_id}
                  onClick={rowNav(`/traces/${t.trace_id}`)}
                  className="cursor-pointer"
                >
                  <Table.Cell><UtcDate iso={t.timestamp} /></Table.Cell>
                  <Table.Cell><SourceTag source={t.execution_source} /></Table.Cell>
                  <Table.Cell className="max-w-md">
                    <div className="flex items-center gap-2">
                      <Link title={t.name} className="truncate text-neutral-900 hover:underline dark:text-white" to={`/traces/${t.trace_id}`}>
                        {t.name}
                      </Link>
                      {t.exception_count > 0 && (
                        <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded bg-rose-600 px-1.5 font-mono text-[10px] font-semibold uppercase text-white">
                          <BugIcon size={11} aria-hidden />
                          <span>{t.exception_count}</span>
                        </span>
                      )}
                    </div>
                  </Table.Cell>
                  <Table.Cell className="text-right"><StatusCodeText status={t.status_code} source={t.execution_source} /></Table.Cell>
                  <Table.Cell className="text-right">{ms(t.duration_ms)}</Table.Cell>
                  <Table.Cell className="text-right text-neutral-600 dark:text-neutral-400">{t.query_count}</Table.Cell>
                  <Table.Cell className="text-neutral-600 dark:text-neutral-400">{t.server}</Table.Cell>
                  <Table.Cell className="text-right"><RowActionLink to={`/traces/${t.trace_id}`} label={`Inspect ${t.name}`} /></Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </FloatingTablePanel>
      )}
    </>
  );
}
