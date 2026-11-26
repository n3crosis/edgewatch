import { useSearchParams } from 'react-router-dom';
import { groupListState, groupListLink, updateGroupList } from '@/lib/group-list';
import Link from '@/components/ScopedLink';
import { Sparkline } from '@/components/charts';
import { Empty, ErrorState, FilterBar, Loading, PageHeader, PaginationBar, Panel, SearchBox, Sql, useRowNavigate } from '@/components/common';
import { Button } from '@cloudflare/kumo/components/button';
import { Table } from '@cloudflare/kumo/components/table';
import { Tabs } from '@cloudflare/kumo/components/tabs';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { DatabaseIcon, SortDescendingIcon, XIcon } from '@phosphor-icons/react';
import { api, useAsync } from '@/lib/api';
import { compact, ms } from '@/lib/format';
import { rangeLabel, useRange } from '@/lib/range';
import type { QuerySort } from '@/lib/group-list';

const SORTS: { key: QuerySort; label: string }[] = [
  { key: 'total_ms', label: 'Total time' },
  { key: 'calls', label: 'Calls' },
  { key: 'p95_ms', label: 'p95' },
];

export default function QueriesPage() {
  const { range } = useRange();
  const rowNav = useRowNavigate();
  const [params, setParams] = useSearchParams();
  const { q, sort, offset } = groupListState(params);
  const update = (patch: Record<string, string>) => setParams((previous) => updateGroupList(previous, patch));
  const { data, error, loading, fetching } = useAsync(() => api.queryList(range, q, sort, offset), [range, q, sort, offset], { keepPreviousData: true });
  const needle = q.trim();
  const rows = data?.data ?? [];
  const totalTimeSum = Math.max(1, rows.reduce((sum, r) => sum + r.total_ms, 0));

  return (
    <>
      <PageHeader
        title="Queries"
        subtitle="Database queries grouped by pattern — click any query to inspect slow executions"
        actions={
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-1.5 text-xs text-kumo-subtle sm:inline-flex">
              <SortDescendingIcon size={14} aria-hidden />
              <span>Sort</span>
            </span>
            <Tabs
              variant="segmented"
              size="sm"
              value={sort}
              onValueChange={(value) => update({ sort: value })}
              tabs={SORTS.map((s) => ({ value: s.key, label: s.label }))}
            />
          </div>
        }
      />

      <FilterBar>
        <SearchBox value={q} onChange={(value) => update({ q: value })} placeholder="Search SQL, connection or hash…" className="min-w-64 flex-1" />
        {needle && (
          <Button variant="ghost" size="sm" icon={XIcon} onClick={() => update({ q: '' })}>
            Clear
          </Button>
        )}
      </FilterBar>

      <Panel
        fetching={!loading && fetching}
        title={`${rows.length} query group${rows.length === 1 ? '' : 's'}`}
      >
        {error ? (
          <ErrorState error={error} />
        ) : loading || !data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty
            icon={<DatabaseIcon size={32} className="text-kumo-subtle" />}
            action={needle ? <Button variant="secondary" size="sm" onClick={() => update({ q: '' })}>Clear search</Button> : undefined}
          >
            {offset > 0 ? 'No query groups on this page.' : needle ? 'No queries match your search.' : `No queries recorded in the ${rangeLabel(range)}.`}
          </Empty>
        ) : (
          <Table layout="fixed" className="min-w-[880px]">
            <Table.Header>
              <Table.Row>
                <Table.Head className="w-[38%]">Query</Table.Head>
                <Table.Head className="w-[9%] text-right">Calls</Table.Head>
                <Table.Head className="w-[13%] text-right">Total</Table.Head>
                <Table.Head className="w-[9%] text-right">Avg</Table.Head>
                <Table.Head className="w-[9%] text-right">p95</Table.Head>
                <Table.Head className="w-[9%] text-right">Max</Table.Head>
                <Table.Head className="w-[13%]">Trend</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((row) => {
                const share = Math.max(3, Math.round((row.total_ms / totalTimeSum) * 100));
                const target = groupListLink(`/queries/${row.sql_hash}`, params);
                return (
                  <Table.Row key={row.sql_hash} onClick={rowNav(target)} className="cursor-pointer transition-colors hover:bg-kumo-tint/50">
                    <Table.Cell>
                      <Tooltip asChild content={<span className="block max-w-xl font-mono text-xs">{row.sql}</span>}>
                        <Link to={target} className="block truncate hover:underline">
                          <Sql sql={row.sql} />
                        </Link>
                      </Tooltip>
                      <div className="mt-1.5 inline-flex items-center gap-1.5 font-mono text-xs text-kumo-subtle">
                        <DatabaseIcon size={12} aria-hidden />
                        <span>{row.connection}</span>
                      </div>
                    </Table.Cell>
                    <Table.Cell className="text-right font-medium tabular-nums">{compact(row.calls)}</Table.Cell>
                    <Table.Cell className="text-right font-mono text-xs tabular-nums">
                      <div className="inline-flex flex-col items-end gap-1.5">
                        <span>{ms(row.total_ms)}</span>
                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-kumo-fill">
                          <div className="h-full rounded-full bg-kumo-info/75" style={{ width: `${share}%` }} />
                        </div>
                      </div>
                    </Table.Cell>
                    <Table.Cell className="text-right font-mono text-xs tabular-nums text-kumo-subtle">{ms(row.avg_ms)}</Table.Cell>
                    <Table.Cell className={`text-right font-mono text-xs tabular-nums ${row.p95_ms > 500 ? 'font-medium text-kumo-danger' : row.p95_ms > 100 ? 'font-medium text-kumo-warning' : ''}`}>
                      {ms(row.p95_ms)}
                    </Table.Cell>
                    <Table.Cell className="text-right font-mono text-xs tabular-nums text-kumo-subtle">{ms(row.max_ms)}</Table.Cell>
                    <Table.Cell><Sparkline values={row.trend} width={88} className="text-kumo-info" label="calls" /></Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        )}
        <PaginationBar
          status={`${rows.length} group${rows.length === 1 ? '' : 's'} on this page`}
          onPrevious={() => update({ offset: String(Math.max(0, offset - 200)) })}
          previousDisabled={offset === 0 || fetching}
          onNext={() => update({ offset: String(data?.next_offset ?? 0) })}
          nextDisabled={fetching || !!error || data?.next_offset == null}
        />
      </Panel>
    </>
  );
}
