import { useMemo, useState } from 'react';
import UserFilter from '@/components/UserFilter';
import { timeWindow } from '@edgewatch/shared/time-window';
import { useSearchParams } from 'react-router-dom';
import { groupListState, groupListLink, updateGroupList } from '@/lib/group-list';
import Link from '@/components/ScopedLink';
import { BarChart, MetricChartCard, rangeFooterBounds } from '@/components/charts';
import {
  CardTray,
  CompactNumber,
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
  SegmentedToggle,
  SortableLabel,
  TimeAgo,
  useRowNavigate,
} from '@/components/common';
import { Button } from '@cloudflare/kumo/components/button';
import { Table } from '@cloudflare/kumo/components/table';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { api, useAsync } from '@/lib/api';
import { bucketTime, compact } from '@/lib/format';
import { useRange } from '@/lib/range';

type ExcSort = 'last_seen' | 'count' | 'users';

export default function ExceptionsPage() {
  const { range } = useRange();
  const rowNav = useRowNavigate();
  const [params, setParams] = useSearchParams();
  const user = params.get('user') || undefined;
  const { q, handled, offset } = groupListState(params);
  const [sortBy, setSortBy] = useState<ExcSort>('last_seen');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const update = (patch: Record<string, string>) => setParams((previous) => updateGroupList(previous, patch));
  const clearFilters = () =>
    setParams((previous) => {
      const next = updateGroupList(previous, { q: '', handled: '' });
      next.delete('user');
      return next;
    });

  const { data: page, error, loading, fetching } = useAsync(
    () => api.exceptionList(range, q, handled, offset, user),
    [range, q, handled, offset, user],
    { keepPreviousData: true },
  );

  const needle = q.trim();
  const rawData = page?.data ?? [];
  const hasFilters = Boolean(needle || handled !== 'all' || user);

  const toggleSort = (col: ExcSort) => {
    if (sortBy === col) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortBy(col);
      setSortDir('desc');
    }
  };

  const data = useMemo(() => {
    const dir = sortDir === 'desc' ? -1 : 1;
    return [...rawData].sort((a, b) => {
      if (sortBy === 'count') return (a.count - b.count) * dir;
      if (sortBy === 'users') return (a.users - b.users) * dir;
      return (Date.parse(a.last_seen) - Date.parse(b.last_seen)) * dir;
    });
  }, [rawData, sortBy, sortDir]);

  const win = timeWindow(range);
  const bucketCount = rawData[0]?.trend.length ?? 24;
  const aggSeries = Array.from({ length: bucketCount }, (_, idx) => {
    let total = 0;
    let unhandled = 0;
    for (const row of rawData) {
      const v = row.trend[idx] ?? 0;
      total += v;
      if (!row.handled) unhandled += v;
    }
    return {
      label: win ? bucketTime(win.since + idx * win.width, range) : `#${idx + 1}`,
      ts: win ? Math.round(win.since + idx * win.width) : undefined,
      value: total,
      highlight: unhandled,
    };
  });

  const totalOccurrences = rawData.reduce((sum, e) => sum + e.count, 0);
  const handledTotal = rawData.reduce((sum, e) => sum + (e.handled_count ?? (e.handled ? e.count : 0)), 0);
  const unhandledTotal = rawData.reduce((sum, e) => sum + (e.unhandled_count ?? (e.handled ? 0 : e.count)), 0);
  const handledGroups = rawData.filter((e) => e.handled).length;
  const unhandledGroups = rawData.filter((e) => !e.handled).length;

  return (
    <div className="space-y-4 md:space-y-6 xl:space-y-10">
      <PageHeader title="Exceptions" actions={<UserFilter />} />

      {/* 1:1 Nightwatch `Index-SImc_d6u.js` full-width Occurrences chart card */}
      <CardTray>
        <MetricChartCard
          fetching={!loading && fetching}
          title="Occurrences"
          value={compact(totalOccurrences)}
          metrics={[
            { label: 'Handled', value: compact(handledTotal), tone: 'neutral' },
            { label: 'Unhandled', value: compact(unhandledTotal), tone: 'error' },
          ]}
        >
          <BarChart height={238} bounds={rangeFooterBounds(range)} series={aggSeries} tone="neutral" unit="occurrences" />
        </MetricChartCard>
      </CardTray>

      {/* 1:1 Nightwatch `Index-SImc_d6u.js` section — no SectionBar icon, Search + Handled/Unhandled toggle with counts */}
      <div className="grid gap-1 md:gap-4">
        <SectionBar
          title={`${data.length} Exception${data.length === 1 ? '' : 's'}`}
          controls={
            <>
              <SearchBox
                value={q}
                onChange={(value) => update({ q: value })}
                placeholder="Search exceptions"
                className="w-full sm:w-64"
              />
              <SegmentedToggle
                className="max-md:hidden"
                value={handled}
                onChange={(value) => update({ handled: value })}
                options={[
                  { value: 'all', label: 'View all' },
                  { value: 'handled', label: 'Handled', count: { value: handledGroups, tone: 'default' } },
                  { value: 'unhandled', label: 'Unhandled', count: { value: unhandledGroups, tone: 'error' } },
                ]}
              />
            </>
          }
        />

        {error ? (
          <ErrorState error={error} />
        ) : loading && !page ? (
          <Panel><Loading /></Panel>
        ) : data.length === 0 ? (
          <Empty
            action={hasFilters ? <Button variant="secondary" size="sm" onClick={clearFilters}>Clear filters</Button> : undefined}
          >
            {offset > 0 ? 'No exceptions on this page' : 'No exceptions found'}
          </Empty>
        ) : (
          <FloatingTablePanel
            fetching={!loading && fetching}
            footer={
              offset > 0 || page?.next_offset != null ? (
                <PaginationBar
                  status={`${data.length} exception group${data.length === 1 ? '' : 's'} on this page`}
                  onPrevious={() => update({ offset: String(Math.max(0, offset - 100)) })}
                  previousDisabled={offset === 0 || fetching}
                  onNext={() => update({ offset: String(page?.next_offset ?? 0) })}
                  nextDisabled={fetching || !!error || page?.next_offset == null}
                />
              ) : undefined
            }
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head className="w-28 text-right">
                    <SortableLabel align="right" active={sortBy === 'last_seen'} direction={sortDir} onClick={() => toggleSort('last_seen')}>
                      Last Seen
                    </SortableLabel>
                  </Table.Head>
                  <Table.Head>Exception</Table.Head>
                  <Table.Head className="w-24 text-right">
                    <SortableLabel align="right" active={sortBy === 'count'} direction={sortDir} onClick={() => toggleSort('count')}>
                      Count
                    </SortableLabel>
                  </Table.Head>
                  <Table.Head className="w-24 text-right">
                    <SortableLabel align="right" active={sortBy === 'users'} direction={sortDir} onClick={() => toggleSort('users')}>
                      Users
                    </SortableLabel>
                  </Table.Head>
                  <Table.Head className="w-12" />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.map((e) => {
                  const target = groupListLink(`/exceptions/${e.group}`, params);
                  return (
                    <Table.Row key={e.group} onClick={rowNav(target)} className="cursor-pointer">
                      <Table.Cell className="text-right">
                        <TimeAgo iso={e.last_seen} />
                      </Table.Cell>
                      <Table.Cell className="max-w-2xl">
                        <div className="flex min-w-0 items-center gap-2.5">
                          {!e.handled && (
                            <span className="inline-flex h-5 shrink-0 items-center rounded bg-rose-600 px-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-white">
                              Unhandled
                            </span>
                          )}
                          <Link
                            to={target}
                            className="shrink-0 font-mono text-xs font-medium text-neutral-700 hover:underline max-md:truncate dark:text-neutral-100"
                          >
                            {e.class}
                          </Link>
                          {e.message && (
                            <span title={e.message} className="min-w-0 truncate text-neutral-500 max-md:hidden dark:text-neutral-400">
                              {e.message}
                            </span>
                          )}
                        </div>
                      </Table.Cell>
                      <Table.Cell className="text-right font-medium"><CompactNumber value={e.count} /></Table.Cell>
                      <Table.Cell className="text-right text-neutral-600 dark:text-neutral-400">
                        <Tooltip content={`${e.users.toLocaleString()} ${e.users === 1 ? 'user' : 'users'}`} asChild>
                          <span className="cursor-default tabular-nums">{compact(e.users)}</span>
                        </Tooltip>
                      </Table.Cell>
                      <Table.Cell className="text-right">
                        <RowActionLink to={target} label={`Inspect ${e.class}`} />
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </FloatingTablePanel>
        )}
      </div>
    </div>
  );
}
