import { withUser } from '@/lib/user-activity';
import UserFilter from '@/components/UserFilter';
import { Button } from '@cloudflare/kumo/components/button';
import { Select } from '@cloudflare/kumo/components/select';
import { Table } from '@cloudflare/kumo/components/table';
import { XIcon } from '@phosphor-icons/react';
import { useSearchParams } from 'react-router-dom';
import Link from '@/components/ScopedLink';
import { Empty, ErrorState, FilterBar, Loading, PageHeader, Panel, SearchBox, Stat, TimeAgo } from '@/components/common';
import { api, useAsync } from '@/lib/api';
import type { EventPage } from '@/lib/events';
import { useRange, rangeLabel } from '@/lib/range';

export default function EventsPage({ page }: { page: EventPage }) {
  const { range } = useRange();
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
  const { data, error, loading, fetching } = useAsync(() => api.events(page.path, range, { ...filters, q: q || undefined, user }), [page.path, range, filters, q, user], { keepPreviousData: true });

  const summary = data?.summary;
  const hasFilters = Boolean(q || user || Object.values(filters).some((v) => v !== 'all'));
  const summaryCols = page.summary?.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2 xl:grid-cols-4';

  return (
    <>
      <PageHeader title={page.title} subtitle={page.subtitle} />

      {page.summary && summary && (
        <section className={`mb-6 grid grid-cols-1 gap-5 ${summaryCols}`}>
          {page.summary.map((s) => <Stat key={s.label} label={s.label} value={s.render(summary)} tone={s.tone?.(summary)} />)}
        </section>
      )}

      <FilterBar>
        <SearchBox value={q} onChange={(value) => update('q', value)} placeholder={page.searchPlaceholder} className="min-w-64 flex-1" />
        {page.filters?.map((f) => (
          <Select
            key={f.param}
            aria-label={f.label}
            className="w-40"
            value={filters[f.param] ?? 'all'}
            onValueChange={(v) => update(f.param, String(v ?? 'all'))}
            items={f.options.map((o) => ({ value: o, label: o === 'all' ? `All ${f.label.toLowerCase()}` : o }))}
          />
        ))}
        <UserFilter />
        {hasFilters && (
          <Button variant="ghost" size="sm" icon={XIcon} onClick={clearAll}>
            Clear
          </Button>
        )}
      </FilterBar>

      <Panel
        fetching={!loading && fetching}
        title={`${data?.data.length ?? 0} ${page.keyLabel.toLowerCase()} group${(data?.data.length ?? 0) === 1 ? '' : 's'}`}
      >
        {error ? (
          <ErrorState error={error} />
        ) : loading || !data ? (
          <Loading />
        ) : data.data.length === 0 ? (
          <Empty
            description={`Nothing matches the selected filters in the ${rangeLabel(range)}.`}
            action={hasFilters ? <Button variant="secondary" size="sm" onClick={clearAll}>Clear filters</Button> : undefined}
          >
            {`No ${page.title.toLowerCase()}`}
          </Empty>
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>{page.keyLabel}</Table.Head>
                {page.columns.map((col) => <Table.Head key={col.label} className={col.align === 'right' ? 'text-right' : ''}>{col.label}</Table.Head>)}
                <Table.Head className="text-right">Last seen</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.data.map((g) => (
                <Table.Row key={g.key} className="transition-colors hover:bg-kumo-tint/50">
                  <Table.Cell className="max-w-md truncate">
                    <Link className="text-kumo-link hover:underline" to={withUser(`${page.path}/${encodeURIComponent(g.key)}`, user)}>
                      {page.renderKey ? page.renderKey(g.key) : g.key}
                    </Link>
                  </Table.Cell>
                  {page.columns.map((col) => <Table.Cell key={col.label} className={`tabular-nums ${col.align === 'right' ? 'text-right' : ''}`}>{col.render(g)}</Table.Cell>)}
                  <Table.Cell className="text-right text-xs"><TimeAgo iso={g.last_seen} /></Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </Panel>
    </>
  );
}
