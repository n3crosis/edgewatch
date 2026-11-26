import { withUser } from '@/lib/user-activity';
import UserFilter from '@/components/UserFilter';
import { BarChart, LineChart, MetricChartCard, rangeFooterBounds } from '@/components/charts';
import { Button } from '@cloudflare/kumo/components/button';
import { Select } from '@cloudflare/kumo/components/select';
import { Table } from '@cloudflare/kumo/components/table';
import { XIcon } from '@phosphor-icons/react';
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
  SearchBox,
  SectionBar,
  TimeAgo,
  useRowNavigate,
} from '@/components/common';
import { api, useAsync } from '@/lib/api';
import type { EventChartCardData, EventPage } from '@/lib/events';
import { useRange } from '@/lib/range';

const ALL_LABELS: Record<string, string> = {
  status: 'All statuses',
  type: 'All types',
  method: 'All methods',
  channel: 'All channels',
  level: 'All levels',
  source: 'All types',
};

function formatOptionLabel(param: string, label: string, option: string): string {
  if (option === 'all') return ALL_LABELS[param] ?? `All ${label.toLowerCase()}`;
  if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|\dxx)$/.test(option)) return option;
  return option.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

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
          labels={card.lineLabels ?? []}
          format={card.format}
        />
      ) : (
        <BarChart
          bounds={bounds}
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
  const user = params.get('user') || undefined;
  const q = params.get('q') ?? '';
  const filters = Object.fromEntries((page.filters ?? []).map((f) => [f.param, params.get(f.param) ?? 'all']));
  const update = (key: string, value: string) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    if (value && (key === 'q' || value !== 'all')) next.set(key, value); else next.delete(key);
    return next;
  });
  const clearAll = () => setParams((previous) => {
    const next = new URLSearchParams(previous);
    next.delete('q');
    next.delete('user');
    for (const f of page.filters ?? []) next.delete(f.param);
    return next;
  });
  const { data, error, loading, fetching } = useAsync(
    () => api.events(page.path, range, { ...filters, q: q || undefined, user }),
    [page.path, range, filters, q, user],
    { keepPreviousData: true },
  );

  const PageIcon = page.icon;
  const isUsersPage = page.path === '/users';
  const showUserFilter = !isUsersPage && (Boolean(page.showUserFilter) || Boolean(user));
  const summary = data?.summary ?? {};
  const rows = data?.data ?? [];
  const hasFilters = Boolean(q || (!isUsersPage && user) || Object.values(filters).some((v) => v !== 'all'));
  const count = rows.length;
  const [singular, plural] = page.sectionUnit ?? [page.keyLabel, `${page.keyLabel}s`];
  const bounds = rangeFooterBounds(range);
  const deck = page.chartDeck ? page.chartDeck(summary, rows) : null;

  return (
    <div className="space-y-6">
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
          title={`${count} ${count === 1 ? singular : plural}`}
          controls={
            <>
              <SearchBox value={q} onChange={(value) => update('q', value)} placeholder={page.searchPlaceholder} className="w-full sm:w-64" />
              {page.filters?.map((f) => (
                <Select
                  key={f.param}
                  aria-label={f.label}
                  className="w-36"
                  value={filters[f.param] ?? 'all'}
                  onValueChange={(v) => update(f.param, String(v ?? 'all'))}
                  items={f.options.map((o) => ({ value: o, label: formatOptionLabel(f.param, f.label, o) }))}
                />
              ))}
              {hasFilters && (
                <Button variant="ghost" size="sm" icon={XIcon} onClick={clearAll}>
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
                  <Table.Head>{page.keyLabel}</Table.Head>
                  {page.columns.map((col) => <Table.Head key={col.label} className={col.align === 'right' ? 'text-right' : ''}>{col.label}</Table.Head>)}
                  <Table.Head className="text-right">Last seen</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((g) => {
                  const target = withUser(`${page.path}/${encodeURIComponent(g.key)}`, user);
                  return (
                    <Table.Row key={g.key} onClick={rowNav(target)} className="cursor-pointer">
                      <Table.Cell className="max-w-md truncate">
                        <Link className="text-kumo-strong hover:text-kumo-link hover:underline" to={target}>
                          {page.renderKey ? page.renderKey(g.key) : g.key}
                        </Link>
                      </Table.Cell>
                      {page.columns.map((col) => <Table.Cell key={col.label} className={`tabular-nums ${col.align === 'right' ? 'text-right' : ''}`}>{col.render(g)}</Table.Cell>)}
                      <Table.Cell className="text-right text-xs"><TimeAgo iso={g.last_seen} /></Table.Cell>
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
