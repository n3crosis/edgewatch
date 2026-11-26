import { useMemo, useState } from 'react';
import { withUser } from '@/lib/user-activity';
import UserFilter from '@/components/UserFilter';
import { EventDetailsDrawer } from '@/components/DetailsDrawer';
import { BarChart, LineChart, MetricChartCard, rangeFooterBounds } from '@/components/charts';
import { Button } from '@cloudflare/kumo/components/button';
import { Table } from '@cloudflare/kumo/components/table';
import { useSearchParams } from 'react-router-dom';
import Link from '@/components/ScopedLink';
import {
  CardTray,
  Empty,
  ErrorState,
  FloatingTablePanel,
  Loading,
  PageHeader,
  Panel,
  RowActionLink,
  SearchBox,
  SectionBar,
  SortableLabel,
  TimeAgo,
  useRowNavigate,
} from '@/components/common';
import { api, useAsync } from '@/lib/api';
import type { EventChartCardData, EventPage } from '@/lib/events';
import { useRange } from '@/lib/range';
import type { EventGroup } from '@/lib/types';

function EventChartCard({
  card,
  bounds,
  fetching,
}: {
  card: EventChartCardData;
  bounds: [string, string] | null;
  fetching: boolean;
}) {
  return (
    <MetricChartCard
      fetching={fetching}
      title={card.title}
      value={card.value}
      metrics={card.metrics}
    >
      {card.kind === 'line' ? (
        <LineChart
          bounds={bounds}
          values={card.lineValues ?? []}
          secondaryValues={card.secondaryLineValues}
          labels={card.lineLabels ?? []}
          timestamps={card.lineTimestamps}
          format={card.format}
        />
      ) : (
        <BarChart
          bounds={bounds}
          tone={card.barTone ?? 'neutral'}
          series={card.barSeries ?? []}
          unit={card.unit ?? 'events'}
        />
      )}
    </MetricChartCard>
  );
}

export default function EventsPage({ page }: { page: EventPage }) {
  const { range } = useRange();
  const rowNav = useRowNavigate();
  const [params, setParams] = useSearchParams();
  const [previewGroup, setPreviewGroup] = useState<EventGroup | null>(null);
  const [sortCol, setSortCol] = useState<string>('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const user = params.get('user') || undefined;
  const q = params.get('q') ?? '';
  const update = (key: string, value: string) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    if (value) next.set(key, value); else next.delete(key);
    return next;
  });
  const clearAll = () => setParams((previous) => {
    const next = new URLSearchParams(previous);
    next.delete('q');
    next.delete('user');
    return next;
  });
  const { data, error, loading, fetching } = useAsync(
    () => api.events(page.path, range, { q: q || undefined, user }),
    [page.path, range, q, user],
    { keepPreviousData: true },
  );

  const PageIcon = page.icon;
  const isUsersPage = page.path === '/users';
  const isCachePage = page.path === '/cache';
  const showUserFilter = !isUsersPage && (Boolean(page.showUserFilter) || Boolean(user));
  const showActionArrow = !isUsersPage && !isCachePage;
  const summary = data?.summary ?? {};
  const rows = data?.data ?? [];
  const hasFilters = Boolean(q || (!isUsersPage && user));
  const count = rows.length;
  const [singular, plural] = page.sectionUnit ?? [page.keyLabel, `${page.keyLabel}s`];
  const bounds = rangeFooterBounds(range);
  const deck = page.chartDeck ? page.chartDeck(summary, rows, range) : null;

  const toggleSort = (col: string, defaultDir: 'asc' | 'desc' = 'desc') => {
    if (sortCol === col) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortCol(col);
      setSortDir(defaultDir);
    }
  };

  const sortedRows = useMemo(() => {
    if (!sortCol) return rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    const list = [...rows];
    if (sortCol === '__key__') {
      list.sort((a, b) => dir * a.key.localeCompare(b.key));
      return list;
    }
    if (sortCol === '__last_seen__') {
      list.sort((a, b) => dir * (Date.parse(a.last_seen) - Date.parse(b.last_seen)));
      return list;
    }
    const column = page.columns.find((c) => c.label === sortCol);
    if (!column?.sortValue) return rows;
    const getVal = column.sortValue;
    list.sort((a, b) => {
      const av = getVal(a);
      const bv = getVal(b);
      if (typeof av === 'string' && typeof bv === 'string') return dir * av.localeCompare(bv);
      return dir * (Number(av) - Number(bv));
    });
    return list;
  }, [rows, sortCol, sortDir, page.columns]);

  return (
    <div className="space-y-4 md:space-y-6 xl:space-y-10">
      <PageHeader
        title={page.title}
        actions={showUserFilter ? <UserFilter /> : undefined}
      />

      {deck && (
        <CardTray>
          <div className="grid min-w-0 grid-cols-1 gap-2 xl:grid-cols-2">
            <EventChartCard card={deck.left} bounds={bounds} fetching={!loading && fetching} />
            <EventChartCard card={deck.right} bounds={bounds} fetching={!loading && fetching} />
          </div>
        </CardTray>
      )}

      <div>
        <SectionBar
          icon={<PageIcon />}
          title={`${isCachePage && count === 100 ? 'Top ' : ''}${count} ${count === 1 ? singular : plural}`}
          controls={
            !isCachePage ? (
              <SearchBox value={q} onChange={(value) => update('q', value)} placeholder={page.searchPlaceholder} className="w-full sm:w-64" />
            ) : undefined
          }
        />

        {error ? (
          <ErrorState error={error} />
        ) : loading || !data ? (
          <Panel><Loading /></Panel>
        ) : rows.length === 0 ? (
          <Empty
            action={hasFilters ? <Button variant="secondary" size="sm" onClick={clearAll}>Clear filters</Button> : undefined}
          >
            {page.emptyLabel ?? `No ${page.title.toLowerCase()} found`}
          </Empty>
        ) : (
          <FloatingTablePanel fetching={!loading && fetching}>
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>
                    <SortableLabel
                      align="left"
                      active={sortCol === '__key__'}
                      direction={sortDir}
                      onClick={() => toggleSort('__key__', 'asc')}
                    >
                      {page.keyLabel}
                    </SortableLabel>
                  </Table.Head>
                  {page.columns.map((col) => (
                    <Table.Head key={col.label} className={col.align === 'right' ? 'text-right' : ''}>
                      {col.sortValue ? (
                        <SortableLabel
                          align={col.align ?? 'left'}
                          active={sortCol === col.label}
                          direction={sortDir}
                          onClick={() => toggleSort(col.label, col.align === 'right' ? 'desc' : 'asc')}
                        >
                          {col.label}
                        </SortableLabel>
                      ) : (
                        col.label
                      )}
                    </Table.Head>
                  ))}
                  {isUsersPage && (
                    <Table.Head className="text-right">
                      <SortableLabel
                        align="right"
                        active={sortCol === '__last_seen__'}
                        direction={sortDir}
                        onClick={() => toggleSort('__last_seen__', 'desc')}
                      >
                        Last seen
                      </SortableLabel>
                    </Table.Head>
                  )}
                  {showActionArrow && <Table.Head className="w-16" />}
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {sortedRows.map((g) => {
                  const target = withUser(`${page.path}/${encodeURIComponent(g.key)}`, user);
                  return (
                    <Table.Row key={g.key} onClick={isCachePage ? undefined : rowNav(target)} className={isCachePage ? undefined : 'cursor-pointer'}>
                      <Table.Cell className="max-w-lg truncate">
                        {isCachePage ? (
                          <span className="inline-flex max-w-full items-center gap-2.5 text-neutral-900 dark:text-neutral-100">
                            <PageIcon size={14} className="shrink-0 text-neutral-400" aria-hidden />
                            <span className="truncate">{page.renderKey ? page.renderKey(g.key, g) : g.key}</span>
                          </span>
                        ) : (
                          <Link className="inline-flex max-w-full items-center gap-2.5 text-neutral-900 hover:underline dark:text-neutral-100" to={target}>
                            {!isUsersPage && <PageIcon size={14} className="shrink-0 text-neutral-400" aria-hidden />}
                            <span className="truncate">{page.renderKey ? page.renderKey(g.key, g) : g.key}</span>
                          </Link>
                        )}
                      </Table.Cell>
                      {page.columns.map((col) => <Table.Cell key={col.label} className={col.align === 'right' ? 'text-right' : ''}>{col.render(g)}</Table.Cell>)}
                      {isUsersPage && <Table.Cell className="text-right"><TimeAgo iso={g.last_seen} /></Table.Cell>}
                      {showActionArrow && (
                        <Table.Cell className="text-right">
                          <RowActionLink
                            to={target}
                            label={`Inspect ${g.key}`}
                            onPreview={() => setPreviewGroup(g)}
                          />
                        </Table.Cell>
                      )}
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </FloatingTablePanel>
        )}
      </div>

      {showActionArrow && (
        <EventDetailsDrawer
          page={page}
          group={previewGroup}
          user={user}
          onClose={() => setPreviewGroup(null)}
        />
      )}
    </div>
  );
}
