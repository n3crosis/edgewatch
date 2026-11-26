import { exceptionHandling } from '@/lib/exception-handling';
import UserFilter from '@/components/UserFilter';
import { timeWindow } from '@edgewatch/shared/time-window';
import { useSearchParams } from 'react-router-dom';
import { groupListState, groupListLink, updateGroupList } from '@/lib/group-list';
import Link from '@/components/ScopedLink';
import { BarChart, MetricChartCard, Sparkline, rangeFooterBounds } from '@/components/charts';
import {
  CardTray,
  Empty,
  ErrorState,
  FloatingTablePanel,
  Loading,
  PageHeader,
  PaginationBar,
  Panel,
  SearchBox,
  SectionBar,
  TimeAgo,
  useRowNavigate,
} from '@/components/common';
import { splitClassName } from '@/lib/ui-helpers';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { Table } from '@cloudflare/kumo/components/table';
import { Tabs } from '@cloudflare/kumo/components/tabs';
import { BugIcon, XIcon } from '@phosphor-icons/react';
import { api, useAsync } from '@/lib/api';
import { bucketTime, compact } from '@/lib/format';
import { useRange } from '@/lib/range';

export default function ExceptionsPage() {
  const { range } = useRange();
  const rowNav = useRowNavigate();
  const [params, setParams] = useSearchParams();
  const user = params.get('user') || undefined;
  const { q, handled, offset } = groupListState(params);
  const update = (patch: Record<string, string>) => setParams((previous) => updateGroupList(previous, patch));
  const clearFilters = () => setParams((previous) => {
    const next = updateGroupList(previous, { q: '', handled: '' });
    next.delete('user');
    return next;
  });
  const { data: page, error, loading, fetching } = useAsync(() => api.exceptionList(range, q, handled, offset, user), [range, q, handled, offset, user], { keepPreviousData: true });
  const needle = q.trim();
  const data = page?.data ?? [];
  const hasFilters = Boolean(needle || handled !== 'all' || user);

  const win = timeWindow(range);
  const bucketCount = data[0]?.trend.length ?? 24;
  const aggSeries = Array.from({ length: bucketCount }, (_, idx) => {
    let total = 0;
    let unhandled = 0;
    for (const row of data) {
      const v = row.trend[idx] ?? 0;
      total += v;
      if (!row.handled) unhandled += v;
    }
    return {
      label: win ? bucketTime(win.since + idx * win.width, range) : `#${idx + 1}`,
      value: total,
      highlight: unhandled,
    };
  });
  const totalOccurrences = data.reduce((sum, e) => sum + e.count, 0);
  const handledTotal = data.reduce((sum, e) => sum + (e.handled_count ?? (e.handled ? e.count : 0)), 0);
  const unhandledTotal = data.reduce((sum, e) => sum + (e.unhandled_count ?? (e.handled ? 0 : e.count)), 0);

  return (
    <div className="space-y-6">
      <PageHeader title="Exceptions" actions={<UserFilter />} />

      {/* Capture-exact full-width Occurrences chart card */}
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
          <BarChart bounds={rangeFooterBounds(range)} series={aggSeries} tone="neutral" unit="occurrences" />
        </MetricChartCard>
      </CardTray>

      <div>
        <SectionBar
          icon={<BugIcon />}
          title={`${data.length} Exception${data.length === 1 ? '' : 's'}`}
          controls={
            <>
              <SearchBox value={q} onChange={(value) => update({ q: value })} placeholder="Search exceptions" className="w-full sm:w-64" />
              <Tabs
                variant="segmented"
                size="sm"
                value={handled}
                onValueChange={(value) => update({ handled: value })}
                tabs={[{ value: 'all', label: 'View all' }, { value: 'handled', label: 'Handled' }, { value: 'unhandled', label: 'Unhandled' }]}
              />
              {hasFilters && (
                <Button variant="ghost" size="sm" icon={XIcon} onClick={clearFilters}>
                  Clear
                </Button>
              )}
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
              <PaginationBar
                status={`${data.length} exception group${data.length === 1 ? '' : 's'} on this page`}
                onPrevious={() => update({ offset: String(Math.max(0, offset - 100)) })}
                previousDisabled={offset === 0 || fetching}
                onNext={() => update({ offset: String(page?.next_offset ?? 0) })}
                nextDisabled={fetching || !!error || page?.next_offset == null}
              />
            }
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Exception</Table.Head>
                  <Table.Head>Trend</Table.Head>
                  <Table.Head className="text-right">Events</Table.Head>
                  <Table.Head className="text-right">Users</Table.Head>
                  <Table.Head className="text-right">Last seen</Table.Head>
                  <Table.Head className="text-right">First seen</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.map((e) => {
                  const { short, namespace } = splitClassName(e.class);
                  const target = groupListLink(`/exceptions/${e.group}`, params);
                  return (
                    <Table.Row key={e.group} onClick={rowNav(target)} className="cursor-pointer">
                      <Table.Cell className="max-w-xl whitespace-normal">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link to={target} className="truncate font-mono text-sm font-semibold text-kumo-danger hover:underline">
                            {short}
                          </Link>
                          <Badge variant={e.handled ? 'secondary' : 'error'} className="shrink-0 font-mono uppercase">{exceptionHandling(e)}</Badge>
                          {namespace && <span className="truncate font-mono text-xs text-kumo-subtle">{namespace}</span>}
                        </div>
                        <div title={e.message} className="mt-1 truncate text-xs text-kumo-default">{e.message}</div>
                        <div title={`${e.file}:${e.line}`} className="mt-0.5 truncate font-mono text-[11px] text-kumo-subtle">{e.file}:{e.line}</div>
                      </Table.Cell>
                      <Table.Cell><Sparkline values={e.trend} className="text-kumo-danger" label="occurrences" /></Table.Cell>
                      <Table.Cell className="text-right font-mono font-medium tabular-nums">{compact(e.count)}</Table.Cell>
                      <Table.Cell className="text-right font-mono tabular-nums text-kumo-subtle">{compact(e.users)}</Table.Cell>
                      <Table.Cell className="text-right text-xs"><TimeAgo iso={e.last_seen} /></Table.Cell>
                      <Table.Cell className="text-right text-xs"><TimeAgo iso={e.first_seen} /></Table.Cell>
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
