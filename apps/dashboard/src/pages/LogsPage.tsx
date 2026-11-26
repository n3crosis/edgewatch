import UserFilter from '@/components/UserFilter';
import { useId } from 'react';
import LogInspector, { logLevelVariant } from '@/components/LogInspector';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { Select } from '@cloudflare/kumo/components/select';
import { Tabs } from '@cloudflare/kumo/components/tabs';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { ArrowRightIcon, FileTextIcon, ListBulletsIcon, XIcon } from '@phosphor-icons/react';
import { useSearchParams } from 'react-router-dom';
import Link from '@/components/ScopedLink';
import { Empty, ErrorState, FilterBar, Loading, PageHeader, PaginationBar, Panel, SearchBox, useRowNavigate } from '@/components/common';
import { api, useAsync } from '@/lib/api';
import { ago, time } from '@/lib/format';
import { useRange, rangeLabel } from '@/lib/range';
import { inlineLogContext } from '@/lib/ui-helpers';

const LEVELS = ['all', 'emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'info', 'debug'];
const QUICK_LEVELS = [
  { value: 'all', label: 'All' },
  { value: 'error', label: 'Error' },
  { value: 'warning', label: 'Warning' },
  { value: 'info', label: 'Info' },
] as const;

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
  const clock = sameDay ? time(iso) : `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time(iso)}`;
  return `${ago(iso)} · ${clock}`;
}

export default function LogsPage() {
  const { range } = useRange();
  const rowNav = useRowNavigate();
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
  const quickTabValue = QUICK_LEVELS.some((l) => l.value === level) ? level : '';

  return (
    <>
      <PageHeader title="Logs" subtitle={`Application logs over the ${rangeLabel(range)} — click any entry to inspect its full context`} />

      <FilterBar id={fallbackId} tabIndex={-1}>
        <Tabs
          variant="segmented"
          size="sm"
          value={quickTabValue}
          onValueChange={(value) => update({ level: value === 'all' ? null : value, cursor: null, entry: null })}
          tabs={QUICK_LEVELS.map((l) => ({ value: l.value, label: l.label }))}
        />
        <SearchBox className="min-w-60 flex-1" value={q} onChange={(value) => update({ q: value || null, cursor: null, entry: null })} placeholder="Search log messages…" />
        <Select
          aria-label="Log level"
          className="w-36"
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
          <Empty
            icon={<ListBulletsIcon size={32} className="text-kumo-subtle" />}
            action={hasFilters ? <Button variant="secondary" size="sm" onClick={() => update({ q: null, level: null, user: null, cursor: null, entry: null })}>Clear filters</Button> : undefined}
          >
            No logs match these filters.
          </Empty>
        ) : (
          <div className="divide-y divide-kumo-hairline">
            {data.data.map((row, i) => {
              const contextPreview = inlineLogContext(row.context);
              const inspectUrl = `/logs?${new URLSearchParams({ ...Object.fromEntries(params), entry: String(row.id) })}`;
              return (
                /* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard navigation is provided by the inner Details Link */
                <article
                  onClick={rowNav(inspectUrl)}
                  className={`cursor-pointer px-5 py-4.5 transition-colors hover:bg-kumo-tint/45 sm:px-6 ${levelAccent(row.level)}`}
                  key={String(row.id ?? `${row.trace_id}-${row.timestamp}-${i}`)}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2.5 text-xs text-kumo-subtle">
                      <Badge variant={logLevelVariant(row.level)}>{row.level}</Badge>
                      <Tooltip asChild content={new Date(row.timestamp).toLocaleString()}>
                        <time dateTime={row.timestamp} className="cursor-default font-mono tabular-nums">{logTimestamp(row.timestamp)}</time>
                      </Tooltip>
                      <span>·</span>
                      <span className="font-mono">{row.server || 'Unknown server'}</span>
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
                        className="inline-flex items-center gap-1 font-medium text-kumo-link hover:underline focus-visible:outline-2"
                        to={inspectUrl}
                      >
                        <FileTextIcon size={13} aria-hidden />
                        <span>Details</span>
                      </Link>
                      <Link className="inline-flex items-center gap-1 font-medium text-kumo-link hover:underline" to={`/traces/${row.trace_id}`}>
                        <span>Trace</span>
                        <ArrowRightIcon size={12} aria-hidden />
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
