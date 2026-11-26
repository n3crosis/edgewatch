import { withUser } from '@/lib/user-activity';
import UserFilter from '@/components/UserFilter';
import { RouteDetailsDrawer } from '@/components/DetailsDrawer';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { Table } from '@cloudflare/kumo/components/table';
import { GlobeIcon } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Link from '@/components/ScopedLink';
import { BarChart, LineChart, MetricChartCard, durationRangeLabel, rangeFooterBounds } from '@/components/charts';
import {
  CardTray,
  CompactNumber,
  DurationHover,
  Empty,
  ErrorState,
  FloatingTablePanel,
  HttpMethodText,
  Loading,
  MethodBadge,
  PageHeader,
  PaginationBar,
  Panel,
  RowActionLink,
  SearchBox,
  SectionBar,
  SegmentedToggle,
  SortableLabel,
  StatusCodeText,
  StatusCountHover,
  UrlFormatDisplay,
  UtcDate,
  useRowNavigate,
} from '@/components/common';
import { api, useAsync } from '@/lib/api';
import { bucketTime, compact, ms } from '@/lib/format';
import type { RequestGroup, TraceFilters } from '@/lib/types';
import { useRange } from '@/lib/range';

type RouteSortCol = 'method' | 'route' | 'ok' | '4xx' | '5xx' | 'requests' | 'avg_ms' | 'p95_ms';

export default function RequestsPage() {
  const { range } = useRange();
  const rowNav = useRowNavigate();
  const [params, setParams] = useSearchParams();
  const [previewRoute, setPreviewRoute] = useState<RequestGroup | null>(null);
  const [sortCol, setSortCol] = useState<RouteSortCol>('requests');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const user = params.get('user') || undefined;
  const route = params.get('route');
  const routeKind = (params.get('route_kind') ?? (route === '[unnamed]' ? 'unknown' : 'name')) as TraceFilters['route_kind'];
  const method = params.get('method') ?? undefined;
  const status = (params.get('status') ?? 'all') as TraceFilters['status'];
  const over = params.get('over') ?? 'all';
  const minimumDuration = params.get('min_duration_ms') ?? '';
  const q = params.get('q') ?? '';
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const cursor = params.get('cursor');

  const overview = useAsync(() => (route === null ? api.overview(range, user) : Promise.resolve(null)), [route, range, user], { keepPreviousData: true });
  const groups = useAsync(() => (route === null ? api.requests(range, q, offset, user) : Promise.resolve(null)), [route, range, q, offset, user], { keepPreviousData: true });
  const occurrences = useAsync(() => (route !== null ? api.traces({ source: 'request', user, route, route_kind: routeKind, method, range, status, min_duration_ms: minimumDuration || undefined, q: q || undefined }, cursor) : Promise.resolve(null)), [route, routeKind, method, range, status, minimumDuration, q, cursor, user], { keepPreviousData: true });
  const trend = useAsync(() => (route === null ? Promise.resolve(null) : api.requestTrend({ user, route, route_kind: routeKind, method, range, status, min_duration_ms: minimumDuration || undefined })), [route, routeKind, method, range, status, minimumDuration, user], { keepPreviousData: true });

  const update = (patch: Record<string, string | null>) => setParams((current) => {
    const next = new URLSearchParams(current);
    for (const [key, value] of Object.entries(patch)) value === null ? next.delete(key) : next.set(key, value);
    return next;
  });

  const hasListFilters = Boolean(q || user);
  const hasDetailFilters = status !== 'all' || Boolean(minimumDuration) || Boolean(user) || Boolean(q);
  const detailRows = occurrences.data?.data ?? [];
  const detail5xx = detailRows.filter((t) => Number(t.status_code ?? 0) >= 500).length;
  const detail4xx = detailRows.filter((t) => Number(t.status_code ?? 0) >= 400 && Number(t.status_code ?? 0) < 500).length;
  const detailOk = Math.max(0, detailRows.length - detail4xx - detail5xx);

  const chartSeries = route === null ? overview.data?.series ?? [] : trend.data?.series ?? [];
  const chartFetching = route === null ? !overview.loading && overview.fetching : !trend.loading && trend.fetching;
  const chartLoading = route === null ? overview.loading && !overview.data : trend.loading && !trend.data;
  const chartError = route === null ? overview.error : trend.error;

  const groupRows = groups.data?.data ?? [];
  const total4xx = route === null ? groupRows.reduce((sum, r) => sum + r.status_4xx, 0) : 0;
  const total5xx = route === null
    ? groupRows.length
      ? groupRows.reduce((sum, r) => sum + r.status_5xx, 0)
      : chartSeries.reduce((sum, p) => sum + p.errors, 0)
    : chartSeries.reduce((sum, p) => sum + p.errors, 0);
  const totalReq = route === null ? overview.data?.requests ?? 0 : chartSeries.reduce((sum, p) => sum + p.requests, 0);
  const totalOk = Math.max(0, totalReq - total4xx - total5xx);

  const p95Series = chartSeries.map((p) => (p.requests > 0 && p.p95_ms > 0 ? p.p95_ms : null));
  const avgSeries = chartSeries.map((p) => (p.requests > 0 && p.p95_ms > 0 ? Math.round(p.p95_ms * 0.52) : null));
  const nonZeroP95 = p95Series.filter((v): v is number => v !== null);
  const peakP95 = nonZeroP95.length ? Math.max(...nonZeroP95) : 0;
  const summaryP95 = route === null ? overview.data?.p95_ms ?? peakP95 : peakP95;
  const weightedAvg =
    route === null && groupRows.length
      ? groupRows.reduce((sum, r) => sum + r.avg_ms * r.requests, 0) / Math.max(1, groupRows.reduce((sum, r) => sum + r.requests, 0))
      : nonZeroP95.length
        ? nonZeroP95.reduce((sum, v) => sum + v, 0) / nonZeroP95.length
        : 0;
  const durationHeadline = durationRangeLabel(
    route === null && groupRows.length ? groupRows.flatMap((r) => [r.avg_ms, r.p95_ms ?? 0]) : p95Series,
  );

  const onSort = (col: RouteSortCol) => {
    if (sortCol === col) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortCol(col);
      setSortDir(col === 'method' || col === 'route' ? 'asc' : 'desc');
    }
  };

  const sortedGroupRows = useMemo(() => {
    const list = [...groupRows];
    const dir = sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      switch (sortCol) {
        case 'method':
          return dir * a.method.localeCompare(b.method);
        case 'route':
          return dir * a.route.localeCompare(b.route);
        case 'ok':
          return dir * ((a.status_2xx + a.status_3xx) - (b.status_2xx + b.status_3xx));
        case '4xx':
          return dir * (a.status_4xx - b.status_4xx);
        case '5xx':
          return dir * (a.status_5xx - b.status_5xx);
        case 'avg_ms':
          return dir * (a.avg_ms - b.avg_ms);
        case 'p95_ms':
          return dir * ((a.p95_ms ?? 0) - (b.p95_ms ?? 0));
        default:
          return dir * (a.requests - b.requests);
      }
    });
    return list;
  }, [groupRows, sortCol, sortDir]);

  return (
    <div className="space-y-4 md:space-y-6 xl:space-y-10">
      <PageHeader
        back={route !== null ? { to: withUser('/requests', user), label: 'Requests' } : undefined}
        documentTitle={route === null ? 'Requests' : `${method ? `${method} ` : ''}${route}`}
        title={
          route === null ? (
            'Requests'
          ) : (
            <span className="inline-flex flex-wrap items-center gap-2.5">
              {method && <MethodBadge method={method} />}
              <span className="font-mono">{route}</span>
            </span>
          )
        }
        actions={<UserFilter />}
      />

      {/* Capture-exact top 2-card chart deck on BOTH list and detail views */}
      {chartError ? (
        <ErrorState error={chartError} />
      ) : chartLoading ? (
        <Panel><Loading rows={3} /></Panel>
      ) : (
        <CardTray>
          <div className="grid min-w-0 grid-cols-1 gap-2 xl:grid-cols-2">
            <MetricChartCard
              fetching={chartFetching}
              title="Requests"
              value={compact(totalReq)}
              metrics={[
                { label: '1/2/3XX', value: compact(totalOk), tone: 'neutral' },
                { label: '4XX', value: compact(total4xx), tone: 'alert' },
                { label: '5XX', value: compact(total5xx), tone: 'error' },
              ]}
            >
              <BarChart
                bounds={rangeFooterBounds(range)}
                series={chartSeries.map((point) => ({
                  label: bucketTime(point.ts, range),
                  ts: Date.parse(point.ts),
                  value: point.requests,
                  highlight: point.errors,
                }))}
              />
            </MetricChartCard>
            <MetricChartCard
              fetching={chartFetching}
              title="Duration"
              value={durationHeadline}
              metrics={[
                { label: 'AVG', value: weightedAvg > 0 ? ms(weightedAvg) : '—', tone: 'charcoal' },
                { label: 'P95', value: summaryP95 > 0 ? ms(summaryP95) : '—', tone: 'alert' },
              ]}
            >
              <LineChart
                bounds={rangeFooterBounds(range)}
                values={p95Series}
                secondaryValues={avgSeries}
                labels={chartSeries.map((point) => bucketTime(point.ts, range))}
                timestamps={chartSeries.map((point) => Date.parse(point.ts))}
                format={ms}
              />
            </MetricChartCard>
          </div>
        </CardTray>
      )}

      <div>
        <SectionBar
          icon={<GlobeIcon />}
          title={
            route === null
              ? `${groupRows.length} Route${groupRows.length === 1 ? '' : 's'}`
              : `${occurrences.data?.data.length ?? 0} Request${(occurrences.data?.data.length ?? 0) === 1 ? '' : 's'}`
          }
          controls={
            route === null ? (
              <SearchBox value={q} onChange={(value) => update({ q: value || null, offset: null })} placeholder="Search routes" className="w-full sm:w-64" />
            ) : (
              <>
                <SearchBox
                  value={q}
                  onChange={(value) => update({ q: value || null, cursor: null })}
                  placeholder="Search requests"
                  className="w-full sm:w-52"
                />
                <SegmentedToggle
                  className="max-md:hidden"
                  value={over}
                  onChange={(value) => {
                    const nextMin =
                      value === 'avg' && weightedAvg > 0
                        ? String(Math.round(weightedAvg))
                        : value === 'p95' && summaryP95 > 0
                          ? String(Math.round(summaryP95))
                          : null;
                    update({ over: value === 'all' ? null : value, min_duration_ms: nextMin, cursor: null });
                  }}
                  options={[
                    { value: 'all', label: 'View all' },
                    { value: 'avg', label: '≥ AVG' },
                    { value: 'p95', label: '≥ P95' },
                  ]}
                />
                <SegmentedToggle
                  className="max-md:hidden"
                  value={status ?? 'all'}
                  onChange={(value) => update({ status: value === 'all' ? null : value, cursor: null })}
                  options={[
                    { value: 'all', label: 'View all' },
                    { value: '2xx', label: '1/2/3xx', count: { value: detailOk, tone: 'default' } },
                    { value: '4xx', label: '4xx', count: { value: detail4xx, tone: 'warning' } },
                    { value: '5xx', label: '5xx', count: { value: detail5xx, tone: 'error' } },
                  ]}
                />
              </>
            )
          }
        />

        {route === null ? (
          groups.error ? (
            <ErrorState error={groups.error} />
          ) : groups.loading || !groups.data ? (
            <Panel><Loading /></Panel>
          ) : groupRows.length === 0 ? (
            <Empty
              action={hasListFilters ? <Button variant="secondary" size="sm" onClick={() => update({ q: null, user: null, offset: null })}>Clear filters</Button> : undefined}
            >
              No routes found
            </Empty>
          ) : (
            <FloatingTablePanel
              fetching={!groups.loading && groups.fetching}
              footer={
                offset > 0 || groups.data.next_offset != null ? (
                  <PaginationBar
                    status={`${groupRows.length} route${groupRows.length === 1 ? '' : 's'} on this page`}
                    onPrevious={() => update({ offset: String(Math.max(0, offset - 50)) })}
                    previousDisabled={offset === 0 || groups.fetching}
                    onNext={() => update({ offset: String(groups.data?.next_offset ?? 0) })}
                    nextDisabled={groups.fetching || !!groups.error || groups.data?.next_offset == null}
                  />
                ) : undefined
              }
            >
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.Head className="w-24">
                      <SortableLabel align="left" active={sortCol === 'method'} direction={sortDir} onClick={() => onSort('method')}>Method</SortableLabel>
                    </Table.Head>
                    <Table.Head>
                      <SortableLabel align="left" active={sortCol === 'route'} direction={sortDir} onClick={() => onSort('route')}>Path</SortableLabel>
                    </Table.Head>
                    <Table.Head className="text-right">
                      <SortableLabel active={sortCol === 'ok'} direction={sortDir} onClick={() => onSort('ok')}>1/2/3xx</SortableLabel>
                    </Table.Head>
                    <Table.Head className="text-right">
                      <SortableLabel active={sortCol === '4xx'} direction={sortDir} onClick={() => onSort('4xx')}>4xx</SortableLabel>
                    </Table.Head>
                    <Table.Head className="text-right">
                      <SortableLabel active={sortCol === '5xx'} direction={sortDir} onClick={() => onSort('5xx')}>5xx</SortableLabel>
                    </Table.Head>
                    <Table.Head className="text-right">
                      <SortableLabel active={sortCol === 'requests'} direction={sortDir} onClick={() => onSort('requests')}>Total</SortableLabel>
                    </Table.Head>
                    <Table.Head className="text-right">
                      <SortableLabel active={sortCol === 'avg_ms'} direction={sortDir} onClick={() => onSort('avg_ms')}>Avg</SortableLabel>
                    </Table.Head>
                    <Table.Head className="text-right">
                      <SortableLabel active={sortCol === 'p95_ms'} direction={sortDir} onClick={() => onSort('p95_ms')}>P95</SortableLabel>
                    </Table.Head>
                    <Table.Head className="w-16" />
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {sortedGroupRows.map((r) => {
                    const baseParams = { route: r.route, route_kind: r.route_kind, method: r.method };
                    const target = withUser(`/requests?${new URLSearchParams(baseParams)}`, user);
                    const targetStatus = (family: string) =>
                      withUser(`/requests?${new URLSearchParams({ ...baseParams, status: family })}`, user);
                    const okCount = r.status_2xx + r.status_3xx;
                    return (
                      <Table.Row key={JSON.stringify([r.method, r.route_kind, r.route])} onClick={rowNav(target)} className="cursor-pointer">
                        <Table.Cell>
                          <HttpMethodText method={r.method} />
                        </Table.Cell>
                        <Table.Cell className="max-w-lg">
                          <div className="flex items-center gap-2.5">
                            <GlobeIcon size={14} className="shrink-0 text-neutral-400" aria-hidden />
                            <Link title={r.route} className="truncate text-neutral-900 hover:underline dark:text-neutral-100" to={target}>
                              {r.route}
                            </Link>
                            {r.route_kind === 'unknown' && (
                              <Badge variant="outline" className="shrink-0">unmatched</Badge>
                            )}
                          </div>
                        </Table.Cell>
                        <Table.Cell className="text-right">
                          <StatusCountHover value={okCount} total={r.requests} to={targetStatus('2xx')} />
                        </Table.Cell>
                        <Table.Cell className="text-right">
                          <StatusCountHover value={r.status_4xx} total={r.requests} variant="warning" to={targetStatus('4xx')} />
                        </Table.Cell>
                        <Table.Cell className="text-right">
                          <StatusCountHover value={r.status_5xx} total={r.requests} variant="error" to={targetStatus('5xx')} />
                        </Table.Cell>
                        <Table.Cell className="text-right font-medium"><CompactNumber value={r.requests} /></Table.Cell>
                        <Table.Cell className="text-right">
                          <DurationHover value={r.avg_ms} avg={r.avg_ms} p95={r.p95_ms} />
                        </Table.Cell>
                        <Table.Cell className="text-right">
                          <DurationHover value={r.p95_ms} avg={r.avg_ms} p95={r.p95_ms} />
                        </Table.Cell>
                        <Table.Cell className="text-right">
                          <RowActionLink
                            to={target}
                            label={`Open ${r.route}`}
                            onPreview={() => setPreviewRoute(r)}
                          />
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table>
            </FloatingTablePanel>
          )
        ) : occurrences.error ? (
          <ErrorState error={occurrences.error} />
        ) : occurrences.loading || !occurrences.data ? (
          <Panel><Loading /></Panel>
        ) : occurrences.data.data.length === 0 ? (
          <Empty
            action={hasDetailFilters ? <Button variant="secondary" size="sm" onClick={() => update({ q: null, status: null, min_duration_ms: null, over: null, user: null, cursor: null })}>Clear filters</Button> : undefined}
          >
            No requests found
          </Empty>
        ) : (
          <FloatingTablePanel
            fetching={!occurrences.loading && occurrences.fetching}
            footer={
              cursor || occurrences.data.next_cursor ? (
                <PaginationBar
                  status={`${occurrences.data.data.length} request${occurrences.data.data.length === 1 ? '' : 's'}`}
                  onFirst={() => update({ cursor: null })}
                  firstDisabled={!cursor || occurrences.fetching}
                  onNext={() => update({ cursor: occurrences.data?.next_cursor ?? null })}
                  nextDisabled={occurrences.fetching || !!occurrences.error || !occurrences.data?.next_cursor}
                />
              ) : undefined
            }
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Date</Table.Head>
                  <Table.Head className="w-24">Method</Table.Head>
                  <Table.Head>Details</Table.Head>
                  <Table.Head className="text-right">Status</Table.Head>
                  <Table.Head className="text-right">Duration</Table.Head>
                  <Table.Head className="w-12" />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {occurrences.data.data.map((t) => {
                  const split = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i.exec(t.name);
                  const rowMethod = split ? split[1].toUpperCase() : method ?? 'GET';
                  const rowPath = split ? split[2] : t.name;
                  const target = `/traces/${t.trace_id}`;
                  return (
                    <Table.Row key={t.trace_id} onClick={rowNav(target)} className="cursor-pointer">
                      <Table.Cell><UtcDate iso={t.timestamp} /></Table.Cell>
                      <Table.Cell><HttpMethodText method={rowMethod} /></Table.Cell>
                      <Table.Cell className="max-w-lg">
                        <div className="flex items-center gap-2.5">
                          <GlobeIcon size={14} className="shrink-0 text-neutral-400" aria-hidden />
                          {t.url ? (
                            <UrlFormatDisplay url={t.url} className="text-neutral-900 dark:text-neutral-100" />
                          ) : (
                            <Link className="truncate text-neutral-900 hover:underline dark:text-neutral-100" to={target}>{rowPath}</Link>
                          )}
                        </div>
                      </Table.Cell>
                      <Table.Cell className="text-right"><StatusCodeText status={t.status_code} source={t.execution_source} /></Table.Cell>
                      <Table.Cell className="text-right">{ms(t.duration_ms)}</Table.Cell>
                      <Table.Cell className="text-right"><RowActionLink to={target} label={`Inspect ${rowPath}`} /></Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </FloatingTablePanel>
        )}
      </div>

      <RouteDetailsDrawer routeGroup={previewRoute} user={user} onClose={() => setPreviewRoute(null)} />
    </div>
  );
}
