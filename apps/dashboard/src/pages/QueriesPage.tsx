import { timeWindow } from '@edgewatch/shared/time-window';
import { useSearchParams } from 'react-router-dom';
import { groupListState, groupListLink, updateGroupList } from '@/lib/group-list';
import Link from '@/components/ScopedLink';
import { BarChart, LineChart, MetricChartCard, Sparkline, rangeFooterBounds } from '@/components/charts';
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
  Sql,
  useRowNavigate,
} from '@/components/common';
import { Button } from '@cloudflare/kumo/components/button';
import { Table } from '@cloudflare/kumo/components/table';
import { Tabs } from '@cloudflare/kumo/components/tabs';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { DatabaseIcon, XIcon } from '@phosphor-icons/react';
import { api, useAsync } from '@/lib/api';
import { bucketTime, compact, ms } from '@/lib/format';
import { useRange } from '@/lib/range';
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

  const win = timeWindow(range);
  const bucketCount = rows[0]?.trend.length ?? 24;
  const callSeries = Array.from({ length: bucketCount }, (_, idx) => {
    let calls = 0;
    let weightedMs = 0;
    for (const row of rows) {
      const c = row.trend[idx] ?? 0;
      calls += c;
      weightedMs += c * row.p95_ms;
    }
    return {
      label: win ? bucketTime(win.since + idx * win.width, range) : `#${idx + 1}`,
      calls,
      p95: calls > 0 ? weightedMs / calls : 0,
    };
  });
  const totalCalls = rows.reduce((sum, r) => sum + r.calls, 0);
  const weightedAvg = totalCalls > 0 ? rows.reduce((sum, r) => sum + r.total_ms, 0) / totalCalls : 0;
  const maxP95 = rows.length ? Math.max(...rows.map((r) => r.p95_ms)) : 0;

  return (
    <div className="space-y-6">
      <PageHeader title="Queries" />

      {/* Capture-exact 2-card Calls + Duration chart deck */}
      <CardTray>
        <div className="grid min-w-0 grid-cols-1 gap-2 xl:grid-cols-2">
          <MetricChartCard fetching={!loading && fetching} title="Calls" value={compact(totalCalls)}>
            <BarChart bounds={rangeFooterBounds(range)} series={callSeries.map((b) => ({ label: b.label, value: b.calls }))} unit="calls" />
          </MetricChartCard>
          <MetricChartCard
            fetching={!loading && fetching}
            title="Duration"
            value={maxP95 ? ms(maxP95) : '—'}
            metrics={[
              { label: 'AVG', value: weightedAvg ? ms(weightedAvg) : '—', tone: 'charcoal' },
              { label: 'P95', value: maxP95 ? ms(maxP95) : '—', tone: 'alert' },
            ]}
          >
            <LineChart bounds={rangeFooterBounds(range)} values={callSeries.map((b) => b.p95)} labels={callSeries.map((b) => b.label)} format={ms} />
          </MetricChartCard>
        </div>
      </CardTray>

      <div>
        <SectionBar
          icon={<DatabaseIcon />}
          title={`${rows.length} Quer${rows.length === 1 ? 'y' : 'ies'}`}
          controls={
            <>
              <SearchBox value={q} onChange={(value) => update({ q: value })} placeholder="Search queries" className="w-full sm:w-64" />
              <Tabs
                variant="segmented"
                size="sm"
                value={sort}
                onValueChange={(value) => update({ sort: value })}
                tabs={SORTS.map((s) => ({ value: s.key, label: s.label }))}
              />
              {needle && (
                <Button variant="ghost" size="sm" icon={XIcon} onClick={() => update({ q: '' })}>
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
            action={needle ? <Button variant="secondary" size="sm" onClick={() => update({ q: '' })}>Clear search</Button> : undefined}
          >
            {offset > 0 ? 'No queries on this page' : 'No queries found'}
          </Empty>
        ) : (
          <FloatingTablePanel
            fetching={!loading && fetching}
            footer={
              <PaginationBar
                status={`${rows.length} query group${rows.length === 1 ? '' : 's'} on this page`}
                onPrevious={() => update({ offset: String(Math.max(0, offset - 200)) })}
                previousDisabled={offset === 0 || fetching}
                onNext={() => update({ offset: String(data?.next_offset ?? 0) })}
                nextDisabled={fetching || !!error || data?.next_offset == null}
              />
            }
          >
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
                    <Table.Row key={row.sql_hash} onClick={rowNav(target)} className="cursor-pointer">
                      <Table.Cell>
                        <Tooltip asChild content={<span className="block max-w-xl font-mono text-xs">{row.sql}</span>}>
                          <Link to={target} className="block truncate hover:underline">
                            <Sql sql={row.sql} />
                          </Link>
                        </Tooltip>
                        <div className="mt-1 inline-flex items-center gap-1.5 font-mono text-[11px] text-kumo-subtle">
                          <DatabaseIcon size={11} aria-hidden />
                          <span>{row.connection}</span>
                        </div>
                      </Table.Cell>
                      <Table.Cell className="text-right font-mono font-medium tabular-nums">{compact(row.calls)}</Table.Cell>
                      <Table.Cell className="text-right font-mono text-xs tabular-nums">
                        <div className="inline-flex flex-col items-end gap-1.5">
                          <span>{ms(row.total_ms)}</span>
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-neutral-200/80 dark:bg-white/10">
                            <div className="h-full rounded-full bg-blue-600/80 dark:bg-emerald-500/80" style={{ width: `${share}%` }} />
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
          </FloatingTablePanel>
        )}
      </div>
    </div>
  );
}
