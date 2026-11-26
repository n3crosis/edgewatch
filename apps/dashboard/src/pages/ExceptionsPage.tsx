import { exceptionHandling } from '@/lib/exception-handling';
import UserFilter from '@/components/UserFilter';
import { useSearchParams } from 'react-router-dom';
import { groupListState, groupListLink, updateGroupList } from '@/lib/group-list';
import Link from '@/components/ScopedLink';
import { Sparkline } from '@/components/charts';
import { Empty, ErrorState, FilterBar, Loading, PageHeader, PaginationBar, Panel, SearchBox, TimeAgo, useRowNavigate } from '@/components/common';
import { splitClassName } from '@/lib/ui-helpers';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { Table } from '@cloudflare/kumo/components/table';
import { Tabs } from '@cloudflare/kumo/components/tabs';
import { CheckCircleIcon, MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react';
import { api, useAsync } from '@/lib/api';
import { compact } from '@/lib/format';
import { useRange, rangeLabel } from '@/lib/range';

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
  const data = page?.data;
  const hasFilters = Boolean(needle || handled !== 'all' || user);

  return (
    <>
      <PageHeader title="Exceptions" subtitle="Grouped by class, code and location" />

      <FilterBar>
        <Tabs
          variant="segmented"
          size="sm"
          value={handled}
          onValueChange={(value) => update({ handled: value })}
          tabs={[{ value: 'all', label: 'All' }, { value: 'unhandled', label: 'Unhandled' }, { value: 'handled', label: 'Handled' }]}
        />
        <SearchBox value={q} onChange={(value) => update({ q: value })} placeholder="Search class, message or file…" className="min-w-64 flex-1" />
        <UserFilter />
        {hasFilters && (
          <Button variant="ghost" size="sm" icon={XIcon} onClick={clearFilters}>
            Clear
          </Button>
        )}
      </FilterBar>

      <Panel
        fetching={!loading && fetching}
        title={`${data?.length ?? 0} exception group${(data?.length ?? 0) === 1 ? '' : 's'}`}
      >
        {error ? (
          <ErrorState error={error} />
        ) : loading || !data ? (
          <Loading />
        ) : data.length === 0 ? (
          <Empty
            icon={
              hasFilters ? (
                <MagnifyingGlassIcon size={32} className="text-kumo-subtle" />
              ) : (
                <CheckCircleIcon size={32} className="text-kumo-success" />
              )
            }
            action={hasFilters ? <Button variant="secondary" size="sm" onClick={clearFilters}>Clear filters</Button> : undefined}
          >
            {offset > 0
              ? 'No exception groups on this page.'
              : hasFilters
                ? 'No exceptions match these filters.'
                : `No exceptions in the ${rangeLabel(range)}.`}
          </Empty>
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Exception</Table.Head>
                <Table.Head>Trend</Table.Head>
                <Table.Head className="text-right">Events</Table.Head>
                <Table.Head className="text-right">Users</Table.Head>
                <Table.Head>Last seen</Table.Head>
                <Table.Head>First seen</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.map((e) => {
                const { short, namespace } = splitClassName(e.class);
                const target = groupListLink(`/exceptions/${e.group}`, params);
                return (
                  <Table.Row key={e.group} onClick={rowNav(target)} className="cursor-pointer transition-colors hover:bg-kumo-tint/50">
                    <Table.Cell className="max-w-xl whitespace-normal">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link to={target} className="truncate font-mono text-sm font-semibold text-kumo-danger hover:underline">
                          {short}
                        </Link>
                        <Badge variant={e.handled ? 'secondary' : 'error'} className="shrink-0">{exceptionHandling(e)}</Badge>
                        {namespace && <span className="truncate font-mono text-xs text-kumo-subtle">{namespace}</span>}
                      </div>
                      <div title={e.message} className="mt-1.5 truncate text-sm text-kumo-default">{e.message}</div>
                      <div title={`${e.file}:${e.line}`} className="mt-1 truncate font-mono text-xs text-kumo-subtle">{e.file}:{e.line}</div>
                    </Table.Cell>
                    <Table.Cell><Sparkline values={e.trend} className="text-kumo-danger" label="occurrences" /></Table.Cell>
                    <Table.Cell className="text-right font-medium tabular-nums">{compact(e.count)}</Table.Cell>
                    <Table.Cell className="text-right tabular-nums text-kumo-subtle">{compact(e.users)}</Table.Cell>
                    <Table.Cell className="text-xs"><TimeAgo iso={e.last_seen} /></Table.Cell>
                    <Table.Cell className="text-xs"><TimeAgo iso={e.first_seen} /></Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        )}
        <PaginationBar
          status={data ? `${data.length} group${data.length === 1 ? '' : 's'} on this page` : undefined}
          onPrevious={() => update({ offset: String(Math.max(0, offset - 100)) })}
          previousDisabled={offset === 0 || fetching}
          onNext={() => update({ offset: String(page?.next_offset ?? 0) })}
          nextDisabled={fetching || !!error || page?.next_offset == null}
        />
      </Panel>
    </>
  );
}
