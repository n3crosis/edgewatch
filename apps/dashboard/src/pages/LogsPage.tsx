import UserFilter from '@/components/UserFilter';
import { useEffect, useId, useMemo, useState } from 'react';
import LogInspector from '@/components/LogInspector';
import { chartFooterDate, localTzLabel } from '@/components/charts';
import { Button } from '@cloudflare/kumo/components/button';
import { Popover } from '@cloudflare/kumo/components/popover';
import { cn } from '@cloudflare/kumo/utils';
import { CaretDownIcon, CheckIcon, SidebarSimpleIcon } from '@phosphor-icons/react';
import { useSearchParams } from 'react-router-dom';
import Link from '@/components/ScopedLink';
import { ErrorState, Loading, PageHeader, PaginationBar, Panel, SearchBox, SourceTag, UtcDate } from '@/components/common';
import { api, useAsync } from '@/lib/api';
import { useLocalPreferences } from '@/lib/preferences';
import { useRange } from '@/lib/range';
import { inlineLogContext } from '@/lib/ui-helpers';

const LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'] as const;
type LogLevel = (typeof LEVELS)[number];

/** 1:1 Capture log level styling (`Logs-C7KeUP_O.js` `x`). */
export function LogLevelTag({ level }: { level: unknown }) {
  const lower = String(level ?? 'info').toLowerCase();
  if (lower === 'emergency') {
    return (
      <span className="inline-flex h-5 items-center rounded bg-rose-600 px-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-white">
        Emergency
      </span>
    );
  }
  if (lower === 'alert') {
    return (
      <span className="inline-flex h-5 items-center rounded bg-amber-500 px-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-white">
        Alert
      </span>
    );
  }
  if (lower === 'critical') {
    return (
      <span className="inline-flex h-5 items-center rounded bg-amber-300/90 px-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-amber-950 dark:bg-amber-400/25 dark:text-amber-300">
        Critical
      </span>
    );
  }
  const color =
    lower === 'error'
      ? 'text-rose-500 dark:text-rose-400'
      : lower === 'warning'
        ? 'text-orange-400 dark:text-orange-300'
        : lower === 'notice'
          ? 'text-emerald-500 dark:text-emerald-400'
          : lower === 'info'
            ? 'text-blue-600 dark:text-blue-400'
            : 'text-neutral-600 dark:text-neutral-400';
  return <span className={`font-mono text-xs uppercase ${color}`}>[{lower}]</span>;
}

/** 1:1 Capture `LevelFilter-C5qPcF6y.js` multi-select `[LEVEL All v]` popover with Clear + Apply. */
function LevelFilter({
  selected,
  onApply,
}: {
  selected: LogLevel[];
  onApply: (next: LogLevel[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<LogLevel[]>(selected);

  useEffect(() => {
    setDraft(selected);
  }, [selected, open]);

  const toggle = (lvl: LogLevel) => {
    setDraft((prev) => (prev.includes(lvl) ? prev.filter((item) => item !== lvl) : [...prev, lvl]));
  };

  const apply = (next: LogLevel[]) => {
    onApply(next);
    setOpen(false);
  };

  const isActive = selected.length > 0;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            aria-label="Log level"
            className={cn(
              'flex h-8 items-center rounded-md border px-2 py-1 transition-all',
              isActive
                ? 'border-blue-600 bg-blue-600 text-white hover:bg-blue-700'
                : 'border-neutral-200 bg-white text-neutral-800 hover:border-neutral-700 dark:border-white/[0.05] dark:bg-neutral-800 dark:text-neutral-200 dark:hover:border-white/10',
            )}
          >
            <div className="flex items-baseline gap-2.5">
              <span
                className={cn(
                  'font-mono text-[11px] uppercase',
                  isActive ? 'text-white/80 dark:text-white/50' : 'text-neutral-600 dark:text-white/50',
                )}
              >
                Level
              </span>
              <span className="whitespace-nowrap text-sm">
                {selected.length === 0
                  ? 'All'
                  : selected
                      .slice(0, 2)
                      .map((l) => l.charAt(0).toUpperCase() + l.slice(1))
                      .join(', ')}
              </span>
            </div>
            {selected.length > 2 && (
              <span className="ml-2 inline-flex items-center rounded bg-white/20 px-1.5 py-0.5 font-mono text-[10px] leading-none text-white">
                +{selected.length - 2}
              </span>
            )}
            <CaretDownIcon size={14} className="ml-2.5 shrink-0 opacity-80" aria-hidden />
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4}>
          {/* 1:1 Nightwatch `.dropdown dark` surface */}
          <Popover.Popup className="w-[260px] rounded-md border border-neutral-800 bg-neutral-900 p-2 text-white shadow-2xl shadow-black/50 dark:border-neutral-700/50 dark:bg-neutral-800">
            <ul className="space-y-0.5">
              {LEVELS.map((lvl) => {
                const checked = draft.includes(lvl);
                return (
                  <li key={lvl}>
                    <button
                      type="button"
                      onClick={() => toggle(lvl)}
                      className="flex w-full items-center justify-between rounded-md px-3.5 py-2 text-sm text-neutral-200 transition-colors hover:bg-neutral-800 hover:text-white dark:hover:bg-neutral-700/60"
                    >
                      <span className="capitalize">{lvl}</span>
                      <CheckIcon
                        size={14}
                        className={cn('mr-1 shrink-0 transition-opacity', checked ? 'opacity-100 text-emerald-400' : 'opacity-0')}
                        aria-hidden
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="mt-3 grid grid-cols-2 gap-2.5 border-t border-neutral-800 px-1 pt-3 pb-1 dark:border-neutral-700/50">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="w-full justify-center"
                onClick={() => {
                  setDraft([]);
                  apply([]);
                }}
              >
                Clear
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                className="w-full justify-center"
                onClick={() => apply(draft)}
              >
                Apply
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export default function LogsPage() {
  const { range } = useRange();
  const { showUtc } = useLocalPreferences();
  const fallbackId = useId();
  const [params, setParams] = useSearchParams();
  const user = params.get('user') || undefined;
  const rawLevels = params.get('levels') ?? params.get('level') ?? '';
  const selectedLevels = useMemo(
    () =>
      rawLevels
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s): s is LogLevel => (LEVELS as readonly string[]).includes(s)),
    [rawLevels],
  );
  const apiLevel = selectedLevels.length === 1 ? selectedLevels[0] : 'all';
  const q = params.get('q') ?? '';
  const cursor = params.get('cursor');
  const entryId = params.get('entry');
  const { data, loading, fetching, error } = useAsync(
    () => api.logEntries(range, apiLevel, q, cursor, user),
    [range, apiLevel, q, cursor, user],
    { keepPreviousData: true },
  );

  const visibleRows = useMemo(() => {
    const rows = data?.data ?? [];
    if (selectedLevels.length <= 1) return rows;
    const allowed = new Set<string>(selectedLevels);
    return rows.filter((row) => allowed.has(String(row.level ?? '').toLowerCase()));
  }, [data?.data, selectedLevels]);

  const update = (patch: Record<string, string | null>) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) next.delete(key);
        else next.set(key, value);
      }
      return next;
    });

  const latestTimestamp = chartFooterDate(Date.now(), showUtc);
  const latestTz = showUtc ? 'UTC' : localTzLabel();

  return (
    <div id={fallbackId} tabIndex={-1} className="space-y-4 md:space-y-6">
      {/* 1:1 Nightwatch `Index-D7SUa4GT.js` header: Search logs + LevelFilter + UserFilter + RangePicker */}
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
            <LevelFilter
              selected={selectedLevels}
              onApply={(next) =>
                update({
                  level: null,
                  levels: next.length === 0 ? null : next.join(','),
                  cursor: null,
                  entry: null,
                })
              }
            />
            <UserFilter />
          </>
        }
      />

      {error ? (
        <ErrorState error={error} />
      ) : loading && !data ? (
        <Panel><Loading /></Panel>
      ) : (
        <section>
          {/* 1:1 Nightwatch `Index-D7SUa4GT.js`: only show "End of logs" when list is empty */}
          {visibleRows.length === 0 && (
            <div className="flex h-16 w-full items-center justify-center">
              <div className="w-full rounded-lg border border-neutral-200 bg-white p-3 text-center font-mono text-sm uppercase dark:border-white/5 dark:bg-white/[0.02]">
                End of logs
              </div>
            </div>
          )}

          {/* 1:1 Capture CSS subgrid single-line floating log cards (`Logs-C7KeUP_O.js`) */}
          {visibleRows.length > 0 && (
            <div
              className={cn(
                'grid grid-cols-[auto_auto_auto_1fr_auto] gap-x-4 gap-y-1 transition-opacity duration-150',
                !loading && fetching && 'opacity-65',
              )}
            >
              {visibleRows.map((row, i) => {
                const hasContext = Boolean(inlineLogContext(row.context));
                const isSelected = entryId === String(row.id);
                const isEmergency = String(row.level).toLowerCase() === 'emergency';
                return (
                  <div
                    key={String(row.id ?? `${row.trace_id}-${row.timestamp}-${i}`)}
                    id={`log-${row.id}`}
                    role="button"
                    tabIndex={0}
                    aria-haspopup="dialog"
                    onClick={() => update({ entry: String(row.id) })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        update({ entry: String(row.id) });
                      }
                    }}
                    className={cn(
                      'group/log col-span-full grid cursor-pointer grid-cols-subgrid items-start rounded-md border py-1.5 pr-2 pl-3 text-left font-mono text-xs leading-loose shadow-2xs transition-colors',
                      isEmergency
                        ? 'border-rose-200 bg-rose-100 hover:bg-rose-200 dark:border-rose-900 dark:bg-[#4C0519]/80 dark:hover:bg-rose-800'
                        : isSelected
                          ? 'border-neutral-400 bg-neutral-50 dark:border-neutral-700/50 dark:bg-neutral-800/80'
                          : 'border-neutral-200 bg-white hover:bg-neutral-50 dark:border-neutral-700/20 dark:bg-neutral-800/25 dark:hover:bg-neutral-800',
                    )}
                  >
                    <UtcDate iso={row.timestamp} />
                    <span className="flex min-w-0 items-center gap-2">
                      <SourceTag source={row.server ? 'REQUEST' : 'LOG'} />
                      <Link
                        to={`/traces/${row.trace_id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="max-w-36 truncate text-neutral-600 hover:text-neutral-900 hover:underline dark:text-neutral-400 dark:hover:text-white"
                        title={String(row.server || row.trace_id)}
                      >
                        {row.server || row.trace_id.slice(0, 12)}
                      </Link>
                    </span>
                    <span className="whitespace-nowrap">
                      <LogLevelTag level={row.level} />
                    </span>
                    <span className="min-w-0 break-all text-neutral-900 dark:text-neutral-100">
                      {row.message}
                    </span>
                    <span className="relative flex size-6 items-center justify-center">
                      <SidebarSimpleIcon
                        size={13}
                        className="hidden text-neutral-500 group-hover/log:block dark:text-neutral-400"
                        aria-hidden
                      />
                      {hasContext && (
                        <span
                          className="size-[5px] rounded-full bg-neutral-400 group-hover/log:hidden dark:bg-neutral-700"
                          aria-hidden
                        />
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {(cursor || data?.next_cursor) && (
            <div className="mt-4 rounded-lg border border-neutral-200 bg-white dark:border-white/[0.06] dark:bg-white/[0.025]">
              <PaginationBar
                status={`Showing ${visibleRows.length} log ${visibleRows.length === 1 ? 'entry' : 'entries'}`}
                onFirst={() => update({ cursor: null })}
                firstDisabled={!cursor || fetching}
                onNext={() => update({ cursor: data?.next_cursor ?? null })}
                nextDisabled={fetching || !!error || !data?.next_cursor}
                nextLabel="Older"
              />
            </div>
          )}

          {/* 1:1 Nightwatch `Index-D7SUa4GT.js` footer */}
          <div className="w-full rounded-md pt-16 pb-24 text-center font-mono text-sm uppercase text-neutral-600 dark:text-white/20">
            Latest as of {latestTimestamp} {latestTz}
          </div>
        </section>
      )}

      <LogInspector
        user={user}
        entryId={entryId}
        range={range}
        fallbackId={fallbackId}
        onClose={() =>
          setParams(
            (previous) => {
              const next = new URLSearchParams(previous);
              next.delete('entry');
              return next;
            },
            { replace: true },
          )
        }
      />
    </div>
  );
}
