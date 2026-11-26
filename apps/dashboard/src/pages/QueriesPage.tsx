import { Popover } from '@cloudflare/kumo/components/popover';
import { cn } from '@cloudflare/kumo/utils';
import { timeWindow } from '@edgewatch/shared/time-window';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { groupListState, groupListLink, updateGroupList } from '@/lib/group-list';
import Link from '@/components/ScopedLink';
import { QueryDetailsDrawer } from '@/components/DetailsDrawer';
import { BarChart, LineChart, MetricChartCard, durationRangeLabel, rangeFooterBounds } from '@/components/charts';
import {
  CardTray,
  CompactNumber,
  DurationHover,
  Empty,
  ErrorState,
  FloatingTablePanel,
  Loading,
  PageHeader,
  PaginationBar,
  Panel,
  RowActionLink,
  SearchBox,
  SectionBar,
  SortableLabel,
  Sql,
  useRowNavigate,
} from '@/components/common';
import { Button } from '@cloudflare/kumo/components/button';
import { Table } from '@cloudflare/kumo/components/table';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { CaretDownIcon, CheckIcon, DatabaseIcon, MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react';
import { api, useAsync } from '@/lib/api';
import { bucketTime, compact, ms } from '@/lib/format';
import { useRange } from '@/lib/range';
import type { QuerySort } from '@/lib/group-list';

/** 1:1 Nightwatch `Index-jsn76ZLU.js` connection selector (`fe`) shown in header when >1 connection exists. */
function ConnectionFilter({
  connections,
  value,
  onChange,
}: {
  connections: string[];
  value: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const filtered = search.trim()
    ? connections.filter((c) => c.toLowerCase().includes(search.trim().toLowerCase()))
    : connections;
  const active = Boolean(value);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            aria-label="Filter by connection"
            className={cn(
              'group flex h-8 items-center gap-2 rounded-lg border px-2.5 text-sm transition-colors',
              active
                ? 'border-blue-500 bg-blue-600 text-white hover:bg-blue-600/90 dark:border-blue-500 dark:bg-blue-600'
                : 'border-neutral-200 bg-white text-neutral-900 hover:border-blue-500 hover:bg-white dark:border-neutral-700/50 dark:bg-neutral-800 dark:text-white dark:hover:border-white/10 dark:hover:bg-neutral-700',
            )}
          >
            <DatabaseIcon
              size={13}
              className={cn(
                'shrink-0',
                active
                  ? 'text-white group-hover:text-white'
                  : 'text-neutral-500 group-hover:text-blue-600 dark:text-neutral-400 dark:group-hover:text-white',
              )}
              aria-hidden
            />
            <span className="max-w-32 truncate whitespace-nowrap">{value || 'All Connections'}</span>
            <CaretDownIcon
              size={14}
              className={cn(
                'shrink-0 transition-transform duration-200',
                open && 'rotate-180',
                active
                  ? 'text-white group-hover:text-white'
                  : 'text-neutral-500 group-hover:text-blue-600 dark:text-neutral-400 dark:group-hover:text-white',
              )}
              aria-hidden
            />
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4}>
          {/* 1:1 Nightwatch `.dropdown dark` surface */}
          <Popover.Popup className="w-[280px] overflow-hidden rounded-md border border-neutral-800 bg-neutral-900 p-0 text-white shadow-2xl shadow-black/50 dark:border-neutral-700/50 dark:bg-neutral-800">
            <div className="flex h-11 items-center border-b border-neutral-800 px-3 dark:border-neutral-700/50">
              <MagnifyingGlassIcon size={15} className="mr-2 shrink-0 text-neutral-400 opacity-60" aria-hidden />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search connections..."
                aria-label="Search connections"
                className="flex w-full bg-transparent text-sm leading-tight text-white outline-none placeholder:font-light placeholder:text-neutral-500"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  className="ml-1 text-neutral-400 hover:text-white"
                >
                  <XIcon size={12} aria-hidden />
                </button>
              )}
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              {active && (
                <button
                  type="button"
                  onClick={() => {
                    onChange('');
                    setOpen(false);
                  }}
                  className="mb-0.5 flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white dark:hover:bg-neutral-700/70"
                >
                  <XIcon size={12} aria-hidden />
                  <span>Clear filter</span>
                </button>
              )}
              {filtered.length === 0 ? (
                <div className="py-5 text-center text-sm text-neutral-500">No connections found</div>
              ) : (
                filtered.map((conn) => (
                  <button
                    key={conn}
                    type="button"
                    onClick={() => {
                      onChange(conn);
                      setOpen(false);
                    }}
                    className="flex h-9 w-full items-center justify-between gap-2 rounded-md px-2.5 text-left text-sm text-neutral-200 transition-colors hover:bg-neutral-800 hover:text-white dark:hover:bg-neutral-700/70"
                  >
                    <span className="truncate">{conn}</span>
                    <CheckIcon size={14} className={cn('shrink-0 text-emerald-400', value === conn ? 'opacity-100' : 'opacity-0')} />
                  </button>
                ))
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export default function QueriesPage() {
  const { range } = useRange();
  const rowNav = useRowNavigate();
  const [params, setParams] = useSearchParams();
  const [previewHash, setPreviewHash] = useState<string | null>(null);
  const { q, sort, offset } = groupListState(params);
  const connection = params.get('connection') ?? '';
  const update = (patch: Record<string, string>) => setParams((previous) => updateGroupList(previous, patch));
  const setConnection = (nextConn: string) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (nextConn) next.set('connection', nextConn);
      else next.delete('connection');
      next.delete('offset');
      return next;
    });

  const { data, error, loading, fetching } = useAsync(
    () => api.queryList(range, q, sort, offset),
    [range, q, sort, offset],
    { keepPreviousData: true },
  );
  const needle = q.trim();
  const allRows = data?.data ?? [];
  const connections = useMemo(
    () => [...new Set(allRows.map((r) => r.connection).filter(Boolean))].sort(),
    [allRows],
  );
  const rows = connection ? allRows.filter((r) => r.connection === connection) : allRows;

  const win = timeWindow(range);
  const bucketCount = rows[0]?.trend.length ?? 24;
  const callSeries = Array.from({ length: bucketCount }, (_, idx) => {
    let calls = 0;
    let weightedP95 = 0;
    let weightedAvg = 0;
    for (const row of rows) {
      const c = row.trend[idx] ?? 0;
      calls += c;
      weightedP95 += c * row.p95_ms;
      weightedAvg += c * row.avg_ms;
    }
    return {
      label: win ? bucketTime(win.since + idx * win.width, range) : `#${idx + 1}`,
      ts: win ? Math.round(win.since + idx * win.width) : undefined,
      calls,
      p95: calls > 0 ? weightedP95 / calls : null,
      avg: calls > 0 ? weightedAvg / calls : null,
    };
  });
  const totalCalls = rows.reduce((sum, r) => sum + r.calls, 0);
  const weightedAvg = totalCalls > 0 ? rows.reduce((sum, r) => sum + r.total_ms, 0) / totalCalls : 0;
  const maxP95 = rows.length ? Math.max(...rows.map((r) => r.p95_ms)) : 0;
  const durationHeadline = durationRangeLabel(rows.flatMap((r) => [r.avg_ms, r.p95_ms]));

  const onSort = (next: QuerySort) => update({ sort: next });

  return (
    <div className="space-y-4 md:space-y-6 xl:space-y-10">
      <PageHeader
        title="Queries"
        actions={connections.length > 1 ? <ConnectionFilter connections={connections} value={connection} onChange={setConnection} /> : undefined}
      />

      {/* 1:1 Nightwatch 2-card Calls + Duration chart deck */}
      <CardTray>
        <div className="grid min-w-0 grid-cols-1 gap-2 xl:grid-cols-2">
          <MetricChartCard fetching={!loading && fetching} title="Calls" value={compact(totalCalls)}>
            <BarChart
              bounds={rangeFooterBounds(range)}
              series={callSeries.map((b) => ({ label: b.label, ts: b.ts, value: b.calls }))}
              unit="calls"
            />
          </MetricChartCard>
          <MetricChartCard
            fetching={!loading && fetching}
            title="Duration"
            value={durationHeadline}
            metrics={[
              { label: 'AVG', value: weightedAvg > 0 ? ms(weightedAvg) : '—', tone: 'charcoal' },
              { label: 'P95', value: maxP95 > 0 ? ms(maxP95) : '—', tone: 'alert' },
            ]}
          >
            <LineChart
              bounds={rangeFooterBounds(range)}
              values={callSeries.map((b) => b.p95)}
              secondaryValues={callSeries.map((b) => b.avg)}
              labels={callSeries.map((b) => b.label)}
              timestamps={callSeries.every((b) => b.ts !== undefined) ? callSeries.map((b) => b.ts as number) : undefined}
              format={ms}
            />
          </MetricChartCard>
        </div>
      </CardTray>

      <div>
        <SectionBar
          icon={<DatabaseIcon />}
          title={`${rows.length} ${rows.length === 1 ? 'Query' : 'Queries'}`}
          controls={
            <SearchBox value={q} onChange={(value) => update({ q: value })} placeholder="Search queries" className="w-full sm:w-64" />
          }
        />

        {error ? (
          <ErrorState error={error} />
        ) : loading || !data ? (
          <Panel><Loading /></Panel>
        ) : rows.length === 0 ? (
          <Empty
            action={needle || connection ? <Button variant="secondary" size="sm" onClick={() => { update({ q: '' }); setConnection(''); }}>Clear search</Button> : undefined}
          >
            {offset > 0 ? 'No queries on this page' : 'No queries found'}
          </Empty>
        ) : (
          <FloatingTablePanel
            fetching={!loading && fetching}
            footer={
              offset > 0 || data.next_offset != null ? (
                <PaginationBar
                  status={`${rows.length} query group${rows.length === 1 ? '' : 's'} on this page`}
                  onPrevious={() => update({ offset: String(Math.max(0, offset - 200)) })}
                  previousDisabled={offset === 0 || fetching}
                  onNext={() => update({ offset: String(data?.next_offset ?? 0) })}
                  nextDisabled={fetching || !!error || data?.next_offset == null}
                />
              ) : undefined
            }
          >
            <Table layout="fixed" className="min-w-[820px]">
              <Table.Header>
                <Table.Row>
                  <Table.Head className="w-[48%]">Query</Table.Head>
                  <Table.Head className="w-[12%] text-right">Connection</Table.Head>
                  <Table.Head className="w-[9%] text-right">
                    <SortableLabel active={sort === 'calls'} onClick={() => onSort('calls')}>Calls</SortableLabel>
                  </Table.Head>
                  <Table.Head className="w-[9%] text-right">
                    <SortableLabel active={sort === 'total_ms'} onClick={() => onSort('total_ms')}>Total</SortableLabel>
                  </Table.Head>
                  <Table.Head className="w-[8%] text-right">Avg</Table.Head>
                  <Table.Head className="w-[8%] text-right">
                    <SortableLabel active={sort === 'p95_ms'} onClick={() => onSort('p95_ms')}>P95</SortableLabel>
                  </Table.Head>
                  <Table.Head className="w-[6%]" />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((row) => {
                  const target = groupListLink(`/queries/${row.sql_hash}`, params);
                  return (
                    <Table.Row key={row.sql_hash} onClick={rowNav(target)} className="cursor-pointer">
                      <Table.Cell>
                        <Tooltip asChild content={<span className="block max-w-xl font-mono text-xs">{row.sql}</span>}>
                          <Link to={target} className="flex items-center gap-2.5 truncate hover:underline">
                            <DatabaseIcon size={14} className="shrink-0 text-neutral-400" aria-hidden />
                            <span className="truncate"><Sql sql={row.sql} /></span>
                          </Link>
                        </Tooltip>
                      </Table.Cell>
                      <Table.Cell className="text-right text-neutral-600 dark:text-neutral-400">{row.connection}</Table.Cell>
                      <Table.Cell className="text-right font-medium"><CompactNumber value={row.calls} /></Table.Cell>
                      <Table.Cell className="text-right">{ms(row.total_ms)}</Table.Cell>
                      <Table.Cell className="text-right">
                        <DurationHover value={row.avg_ms} avg={row.avg_ms} p95={row.p95_ms} max={row.max_ms} />
                      </Table.Cell>
                      <Table.Cell className="text-right">
                        <DurationHover value={row.p95_ms} avg={row.avg_ms} p95={row.p95_ms} max={row.max_ms} />
                      </Table.Cell>
                      <Table.Cell className="text-right">
                        <RowActionLink
                          to={target}
                          label="Inspect query"
                          onPreview={() => setPreviewHash(row.sql_hash)}
                        />
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </FloatingTablePanel>
        )}
      </div>

      <QueryDetailsDrawer sqlHash={previewHash} onClose={() => setPreviewHash(null)} />
    </div>
  );
}
