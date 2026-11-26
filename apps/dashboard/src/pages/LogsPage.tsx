import UserFilter from '@/components/UserFilter';
import { useId, useState } from 'react';
import LogInspector, { logLevelVariant } from '@/components/LogInspector';
import { chartFooterDate } from '@/components/charts';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { Popover } from '@cloudflare/kumo/components/popover';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { cn } from '@cloudflare/kumo/utils';
import { ArrowRightIcon, CaretDownIcon, CheckIcon, FileTextIcon, XIcon } from '@phosphor-icons/react';
import { useSearchParams } from 'react-router-dom';
import Link from '@/components/ScopedLink';
import { ErrorState, Loading, PageHeader, PaginationBar, Panel, SearchBox, useRowNavigate } from '@/components/common';
import { api, useAsync } from '@/lib/api';
import { ago, time } from '@/lib/format';
import { useRange } from '@/lib/range';
import { inlineLogContext } from '@/lib/ui-helpers';

const LEVELS = ['all', 'emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'info', 'debug'] as const;

function levelAccent(level: unknown): string {
  const variant = logLevelVariant(level);
  if (variant === 'error') return 'border-l-[3px] border-l-kumo-danger';
  if (variant === 'warning') return 'border-l-[3px] border-l-kumo-warning';
  return 'border-l-[3px] border-l-transparent';
}

function LogLevelTag({ level }: { level: unknown }) {
  const lower = String(level ?? 'info').toLowerCase();
  if (lower === 'emergency') return <Badge variant="error" className="font-mono uppercase">Emergency</Badge>;
  if (lower === 'alert') return <Badge variant="warning" className="font-mono uppercase">Alert</Badge>;
  if (lower === 'critical') return <Badge variant="warning" className="font-mono uppercase">Critical</Badge>;
  const color =
    lower === 'error'
      ? 'text-rose-500 dark:text-rose-400'
      : lower === 'warning'
        ? 'text-orange-500 dark:text-orange-300'
        : lower === 'notice'
          ? 'text-emerald-600 dark:text-emerald-400'
          : lower === 'info'
            ? 'text-blue-600 dark:text-blue-400'
            : 'text-neutral-500 dark:text-neutral-400';
  return <span className={`font-mono text-xs font-medium uppercase ${color}`}>[{lower}]</span>;
}

function logTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  const clock = sameDay ? time(iso) : `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time(iso)}`;
  return `${ago(iso)} · ${clock}`;
}

/** Capture-exact `[LEVEL  All v]` filter pill backed by a Kumo Popover. */
function LevelPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = value === 'all' ? 'All' : value.charAt(0).toUpperCase() + value.slice(1);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            aria-label="Log level"
            className={cn(
              'group inline-flex h-8 items-center gap-2 rounded-lg border px-2.5 text-sm transition-colors',
              value !== 'all'
                ? 'border-blue-500/70 bg-blue-50/70 text-blue-900 dark:border-blue-500/40 dark:bg-blue-950/50 dark:text-blue-200'
                : 'border-neutral-200 bg-white text-neutral-800 hover:border-blue-500 hover:text-neutral-950 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-neutral-200 dark:hover:border-white/15 dark:hover:text-white',
            )}
          >
            <span className="font-mono text-[11px] uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
              Level
            </span>
            <span className="font-medium">{label}</span>
            <CaretDownIcon size={12} className="shrink-0 text-neutral-500 group-hover:text-blue-600 dark:text-neutral-400 dark:group-hover:text-white" aria-hidden />
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8}>
          <Popover.Popup className="w-44 rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl shadow-black/10 dark:border-white/10 dark:bg-neutral-900">
            <div className="space-y-0.5">
              {LEVELS.map((option) => {
                const active = option === value;
                const optionLabel = option === 'all' ? 'All levels' : option.charAt(0).toUpperCase() + option.slice(1);
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => {
                      onChange(option);
                      setOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs transition-colors',
                      active
                        ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-white/[0.08] dark:text-white'
                        : 'text-neutral-600 hover:bg-neutral-100/70 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/[0.04] dark:hover:text-white',
                    )}
                  >
                    <span>{optionLabel}</span>
                    {active && <CheckIcon size={12} className="text-blue-600 dark:text-emerald-400" aria-hidden />}
                  </button>
                );
              })}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
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
  const { data, loading, fetching, error } = useAsync(
    () => api.logEntries(range, level, q, cursor, user),
    [range, level, q, cursor, user],
    { keepPreviousData: true },
  );

  const update = (patch: Record<string, string | null>) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    for (const [key, value] of Object.entries(patch)) value === null ? next.delete(key) : next.set(key, value);
    return next;
  });

  const hasFilters = Boolean(q || level !== 'all' || user);
  const latestTimestamp = chartFooterDate(Date.now());

  return (
    <div id={fallbackId} tabIndex={-1} className="space-y-5">
      <PageHeader
        title="Logs"
        actions={
          <>
            <SearchBox
              className="w-44 sm:w-52"
              value={q}
              onChange={(value) => update({ q: value || null, cursor: null, entry: null })}
              placeholder="Search logs"
            />
            <LevelPicker
              value={level}
              onChange={(value) => update({ level: value === 'all' ? null : value, cursor: null, entry: null })}
            />
            <UserFilter />
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                icon={XIcon}
                onClick={() => update({ q: null, level: null, user: null, cursor: null, entry: null })}
              >
                Clear
              </Button>
            )}
          </>
        }
      />

      {error ? (
        <ErrorState error={error} />
      ) : loading || !data ? (
        <Panel><Loading /></Panel>
      ) : data.data.length === 0 ? (
        <div className="space-y-10">
          <div className="rounded-lg border border-neutral-200 bg-white px-4 py-3 text-center font-mono text-xs uppercase tracking-widest text-neutral-900 dark:border-white/[0.06] dark:bg-white/[0.025] dark:text-neutral-200">
            End of logs
          </div>
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="font-mono text-xs uppercase tracking-widest text-neutral-600 dark:text-neutral-400">
              Latest as of {latestTimestamp} <span className="text-neutral-400 dark:text-neutral-500">UTC</span>
            </div>
            {hasFilters && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => update({ q: null, level: null, user: null, cursor: null, entry: null })}
              >
                Clear filters
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <Panel fetching={!loading && fetching}>
            <div className="divide-y divide-kumo-hairline">
              {data.data.map((row, i) => {
                const contextPreview = inlineLogContext(row.context);
                const inspectUrl = `/logs?${new URLSearchParams({ ...Object.fromEntries(params), entry: String(row.id) })}`;
                return (
                  /* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard navigation is provided by the inner Details Link */
                  <article
                    onClick={rowNav(inspectUrl)}
                    className={`cursor-pointer px-5 py-3.5 transition-colors hover:bg-neutral-50 sm:px-6 dark:hover:bg-white/[0.03] ${levelAccent(row.level)}`}
                    key={String(row.id ?? `${row.trace_id}-${row.timestamp}-${i}`)}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-2.5 text-xs text-kumo-subtle">
                        <LogLevelTag level={row.level} />
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
                    <p className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-6 text-kumo-strong">{row.message}</p>
                    {contextPreview && (
                      <div className="mt-2 truncate rounded-lg bg-kumo-recessed/70 px-3 py-1.5 font-mono text-xs text-kumo-subtle">
                        {contextPreview}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
            {(cursor || data.next_cursor) && (
              <PaginationBar
                status={`Showing ${data.data.length} log ${data.data.length === 1 ? 'entry' : 'entries'}`}
                onFirst={() => update({ cursor: null })}
                firstDisabled={!cursor || fetching}
                onNext={() => update({ cursor: data.next_cursor ?? null })}
                nextDisabled={fetching || !!error || !data.next_cursor}
                nextLabel="Older"
              />
            )}
          </Panel>
          {!data.next_cursor && (
            <div className="rounded-lg border border-neutral-200 bg-white px-4 py-3 text-center font-mono text-xs uppercase tracking-widest text-neutral-700 dark:border-white/[0.06] dark:bg-white/[0.025] dark:text-neutral-300">
              End of logs
            </div>
          )}
        </div>
      )}

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
    </div>
  );
}
