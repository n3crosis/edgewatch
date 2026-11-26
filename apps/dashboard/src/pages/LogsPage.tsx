import UserFilter from '@/components/UserFilter';
import { useId } from 'react';
import LogInspector, { logLevelVariant } from '@/components/LogInspector';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { Select } from '@cloudflare/kumo/components/select';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { XIcon } from '@phosphor-icons/react';
import { useSearchParams } from 'react-router-dom';
import Link from '@/components/ScopedLink';
import { Empty, ErrorState, FilterBar, Loading, PageHeader, PaginationBar, Panel, SearchBox } from '@/components/common';
import { api, useAsync } from '@/lib/api';
import { time } from '@/lib/format';
import { useRange, rangeLabel } from '@/lib/range';
import { inlineLogContext } from '@/lib/ui-helpers';

const LEVELS = ['all', 'emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'info', 'debug'];

function levelAccent(level: unknown): string {
  const variant = logLevelVariant(level);
  if (variant === 'error') return 'border-l-[3px] border-l-kumo-danger';
  if (variant === 'warning') return 'border-l-[3px] border-l-kumo-warning';
  return 'border-l-[3px] border-l-transparent';
}

function logTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return sameDay ? time(iso) : `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time(iso)}`;
}

export default function LogsPage() {
  const { range } = useRange();
  const fallbackId = useId();
  const [params, setParams] = useSearchParams();
  const user = params.get('user') || undefined;
  const level = params.get('level') ?? 'all';
  const q = params.get('q') ?? '';
  const cursor = params.get('cursor');
  const entryId = params.get('entry');
  const { data, loading, fetching, error } = useAsync(() => api.logEntries(range, level, q, cursor, user), [range, level, q, cursor, user], { keepPreviousData: true });

  const update = (patch: Record<string, string | null>) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    for (const [key, value] of Object.entries(patch)) value === null ? next.delete(key) : next.set(key, value);
    return next;
  });

  const hasFilters = Boolean(q || level !== 'all' || user);

  return (
    <>
      <PageHeader title="Logs" subtitle={`Individual entries, newest first · ${rangeLabel(range)} · search matches captured message text`} />

      <FilterBar id={fallbackId} tabIndex={-1}>
        <SearchBox className="min-w-64 flex-1" value={q} onChange={(value) => update({ q: value || null, cursor: null, entry: null })} placeholder="Search log messages…" />
        <Select
          aria-label="Log level"
          className="w-40"
          value={level}
          onValueChange={(value) => update({ level: value === 'all' ? null : String(value ?? 'all'), cursor: null, entry: null })}
          items={LEVELS.map((value) => ({ value, label: value === 'all' ? 'All levels' : value.charAt(0).toUpperCase() + value.slice(1) }))}
        />
        <UserFilter />
        {hasFilters && (
          <Button variant="ghost" size="sm" icon={XIcon} onClick={() => update({ q: null, level: null, user: null, cursor: null, entry: null })}>
            Clear
          </Button>
        )}
      </FilterBar>

      <Panel fetching={!loading && fetching}>
        {error ? (
          <ErrorState error={error} />
        ) : loading || !data ? (
          <Loading />
        ) : data.data.length === 0 ? (
          <Empty action={hasFilters ? <Button variant="secondary" size="sm" onClick={() => update({ q: null, level: null, user: null, cursor: null, entry: null })}>Clear filters</Button> : undefined}>
            No logs match these filters.
          </Empty>
        ) : (
          <div className="divide-y divide-kumo-hairline">
            {data.data.map((row, i) => {
              const contextPreview = inlineLogContext(row.context);
              return (
                <article
                  className={`px-5 py-4.5 transition-colors hover:bg-kumo-tint/40 sm:px-6 ${levelAccent(row.level)}`}
                  key={String(row.id ?? `${row.trace_id}-${row.timestamp}-${i}`)}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2.5 text-xs text-kumo-subtle">
                      <Badge variant={logLevelVariant(row.level)}>{row.level}</Badge>
                      <Tooltip asChild content={new Date(row.timestamp).toLocaleString()}>
                        <time dateTime={row.timestamp} className="cursor-default font-mono tabular-nums">{logTimestamp(row.timestamp)}</time>
                      </Tooltip>
                      <span>·</span>
                      <span className="font-mono">{row.server ?? 'Unknown server'}</span>
                      {row.user && (
                        <>
                          <span>·</span>
                          <span className="font-mono">#{row.user}</span>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-4 text-xs">
                      <Link
                        id={`log-${row.id}`}
                        aria-haspopup="dialog"
                        className="font-medium text-kumo-link hover:underline focus-visible:outline-2"
                        to={`/logs?${new URLSearchParams({ ...Object.fromEntries(params), entry: String(row.id) })}`}
                      >
                        Inspect
                      </Link>
                      <Link className="font-medium text-kumo-link hover:underline" to={`/traces/${row.trace_id}`}>
                        Open trace →
                      </Link>
                    </div>
                  </div>
                  <p className="mt-2.5 whitespace-pre-wrap break-words font-mono text-xs leading-6 text-kumo-strong">{row.message}</p>
                  {contextPreview && (
                    <div className="mt-2 truncate rounded-lg bg-kumo-recessed/70 px-3 py-1.5 font-mono text-xs text-kumo-subtle">
                      {contextPreview}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
        <PaginationBar
          status={data ? `Showing ${data.data.length} log ${data.data.length === 1 ? 'entry' : 'entries'}` : undefined}
          onFirst={() => update({ cursor: null })}
          firstDisabled={!cursor || fetching}
          onNext={() => update({ cursor: data?.next_cursor ?? null })}
          nextDisabled={fetching || !!error || !data?.next_cursor}
          nextLabel="Older"
        />
      </Panel>

      <LogInspector
        user={user}
        entryId={entryId}
        range={range}
        fallbackId={fallbackId}
        onClose={() => setParams((previous) => {
          const next = new URLSearchParams(previous);
          next.delete('entry');
          return next;
        }, { replace: true })}
      />
    </>
  );
}
