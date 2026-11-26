import { useMemo, useState } from 'react';
import UserFilter from '@/components/UserFilter';
import { userActivityLinks, withUser } from '@/lib/user-activity';
import { Table } from '@cloudflare/kumo/components/table';
import { GlobeIcon } from '@phosphor-icons/react';
import { useParams, useSearchParams } from 'react-router-dom';
import { BarChart, LineChart, MetricChartCard, bucketTimeSeries, durationRangeLabel, rangeFooterBounds } from '@/components/charts';
import {
  CardTray,
  CompactNumber,
  DescriptionList,
  DescriptionRow,
  Empty,
  ErrorState,
  FloatingTablePanel,
  HttpMethodText,
  Loading,
  PageHeader,
  Panel,
  RowActionLink,
  SearchBox,
  SectionBar,
  SegmentedToggle,
  StatusCodeText,
  UrlFormatDisplay,
  UtcDate,
  useRowNavigate,
} from '@/components/common';
import { api, useAsync } from '@/lib/api';
import { useEnvironment } from '@/lib/environment';
import type { EventPage } from '@/lib/events';
import { compact, ms } from '@/lib/format';
import Link, { scopedPath } from '@/components/ScopedLink';
import { useProject } from '@/lib/project';
import { useRange } from '@/lib/range';
import { splitClassName } from '@/lib/ui-helpers';
import { cn } from '@cloudflare/kumo/utils';

function splitTraceName(name: string): { method: string; url: string } {
  const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i.exec(name);
  return m ? { method: m[1].toUpperCase(), url: m[2] } : { method: 'GET', url: name };
}

function quantile95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

export default function EventDetailPage({ page }: { page: EventPage }) {
  const key = useParams().key ?? '';
  const { range } = useRange();
  const rowNav = useRowNavigate();
  const { projectId } = useProject();
  const { environment } = useEnvironment();
  const [params] = useSearchParams();
  const user = params.get('user') || undefined;
  const [search, setSearch] = useState('');
  const [over, setOver] = useState<'all' | 'avg' | 'p95'>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const { data, error, loading, fetching } = useAsync(
    () => api.eventRows(page.path, key, range, user),
    [page.path, key, range, user],
    { keepPreviousData: true },
  );
  const PageIcon = page.icon;

  const isUserDetail = page.path === '/users';
  const isJobsDetail = page.path === '/jobs';
  const isCommandsDetail = page.path === '/commands';
  const isTasksDetail = page.path === '/scheduled-tasks';
  const isOutgoingDetail = page.path === '/outgoing-requests';

  const durations = useMemo(
    () => (data ?? []).map((r) => Number(r.duration_ms ?? 0)).filter((d) => Number.isFinite(d) && d > 0),
    [data],
  );
  const avgMs = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const p95Ms = quantile95(durations);

  const filteredData = useMemo(() => {
    const rows = data ?? [];
    const needle = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (over !== 'all') {
        const d = Number(r.duration_ms ?? 0);
        if (over === 'avg' && d < avgMs) return false;
        if (over === 'p95' && d < p95Ms) return false;
      }
      if (statusFilter !== 'all') {
        if (isUserDetail || isOutgoingDetail) {
          const code = Number(r.status_code ?? 0);
          if (statusFilter === '2xx' && (code >= 400 || code === 0)) return false;
          if (statusFilter === '4xx' && (code < 400 || code >= 500)) return false;
          if (statusFilter === '5xx' && code < 500) return false;
        } else if (isJobsDetail || isTasksDetail) {
          if (String(r.status ?? '').toLowerCase() !== statusFilter) return false;
        } else if (isCommandsDetail) {
          const failed = Number(r.exit_code ?? 0) !== 0;
          if (statusFilter === '0' && failed) return false;
          if (statusFilter === '1' && !failed) return false;
        }
      }
      if (needle) {
        const haystack = `${r.trace_name ?? ''} ${r.url ?? ''} ${r.command ?? ''} ${r.trace_id ?? ''}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [data, search, over, avgMs, p95Ms, statusFilter, isUserDetail, isOutgoingDetail, isJobsDetail, isTasksDetail, isCommandsDetail]);

  if (error) return <ErrorState error={error} />;
  if (loading) return <Loading />;
  if (!data) {
    return (
      <div className="space-y-5">
        <PageHeader back={{ to: withUser(page.path, user), label: page.title }} title={`${page.keyLabel} not found`} />
        <Empty description="No executions match this item in the selected project or time window">
          {`${page.keyLabel} not found`}
        </Empty>
      </div>
    );
  }

  const classSplit = page.isClassKey ? splitClassName(key) : null;
  const headingText = classSplit ? classSplit.short : key;
  const bounds = rangeFooterBounds(range);
  const lastSeenIso = data[0]?.timestamp;

  const timed = bucketTimeSeries(data, range, {
    timestamp: (r) => r.timestamp,
    value: () => 1,
    warn: (r) => {
      if (isUserDetail || isOutgoingDetail) {
        const code = Number(r.status_code ?? 0);
        return code >= 400 && code < 500 ? 1 : 0;
      }
      if (isJobsDetail) return String(r.status ?? '').toLowerCase() === 'released' ? 1 : 0;
      if (isTasksDetail) return String(r.status ?? '').toLowerCase() === 'skipped' ? 1 : 0;
      return 0;
    },
    highlight: (r) => {
      if (isUserDetail || isOutgoingDetail) return Number(r.status_code ?? 0) >= 500 ? 1 : 0;
      if (isCommandsDetail) return Number(r.exit_code ?? 0) !== 0 ? 1 : 0;
      if (isJobsDetail || isTasksDetail) return String(r.status ?? '').toLowerCase() === 'failed' ? 1 : 0;
      return 0;
    },
    p95: (r) => Number(r.duration_ms ?? 0),
    avg: (r) => Number(r.duration_ms ?? 0),
    buckets: 36,
  });

  // Status counts for segmented toggles
  const count5xx = data.filter((r) => Number(r.status_code ?? 0) >= 500).length;
  const count4xx = data.filter((r) => Number(r.status_code ?? 0) >= 400 && Number(r.status_code ?? 0) < 500).length;
  const countOk = Math.max(0, data.length - count4xx - count5xx);

  const countProcessed = data.filter((r) => String(r.status ?? '').toLowerCase() === 'processed').length;
  const countReleased = data.filter((r) => String(r.status ?? '').toLowerCase() === 'released').length;
  const countSkipped = data.filter((r) => String(r.status ?? '').toLowerCase() === 'skipped').length;
  const countFailed = data.filter((r) =>
    isCommandsDetail ? Number(r.exit_code ?? 0) !== 0 : String(r.status ?? '').toLowerCase() === 'failed',
  ).length;
  const countCmdSuccess = Math.max(0, data.length - countFailed);

  const countTitle = isJobsDetail
    ? 'Attempts'
    : isTasksDetail
      ? 'Runs'
      : isCommandsDetail
        ? 'Calls'
        : page.path === '/mail'
          ? 'Mails'
          : page.path === '/notifications'
            ? 'Notifications'
            : 'Requests';

  const sectionSingular = isJobsDetail
    ? 'Attempt'
    : isTasksDetail
      ? 'Run'
      : isCommandsDetail
        ? 'Command'
        : page.path === '/mail'
          ? 'Mail'
          : page.path === '/notifications'
            ? 'Notification'
            : 'Request';

  const sectionPlural = isJobsDetail
    ? 'Attempts'
    : isTasksDetail
      ? 'Runs'
      : isCommandsDetail
        ? 'Commands'
        : page.path === '/mail'
          ? 'Mail'
          : page.path === '/notifications'
            ? 'Notifications'
            : 'Requests';

  return (
    <div className="space-y-4 md:space-y-6 xl:space-y-10">
      <PageHeader
        back={{ to: withUser(page.path, user), label: page.title }}
        documentTitle={`${page.title}: ${headingText}`}
        title={page.path === '/logs' && page.renderKey ? page.renderKey(key) : <span className="font-mono">{isUserDetail ? `User #${key}` : key}</span>}
        actions={isJobsDetail ? <UserFilter /> : undefined}
      />

      {/* 1:1 Capture User Detail Info + Requests CardTray (`Show-DcOlkrSF.js`) */}
      {isUserDetail ? (
        <CardTray>
          <div className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-2">
            <div className="flex flex-col justify-between gap-4 rounded-lg border border-neutral-200 bg-white p-5 shadow-md shadow-black/[0.04] dark:border-white/[0.06] dark:bg-white/[0.02]">
              <h3 className="text-base font-semibold text-neutral-900 dark:text-white">Info</h3>
              <DescriptionList>
                <DescriptionRow label="ID">{key}</DescriptionRow>
                {lastSeenIso && <DescriptionRow label="Last Seen"><UtcDate iso={lastSeenIso} /></DescriptionRow>}
                <DescriptionRow label="Requests"><CompactNumber value={data.length} /></DescriptionRow>
                <DescriptionRow label="Avg Duration">{avgMs > 0 ? ms(avgMs) : '—'}</DescriptionRow>
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <dt className="font-mono text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                    Filter By
                  </dt>
                  <dd className="flex flex-wrap items-center gap-1.5">
                    {userActivityLinks(key).map((link) => (
                      <Link
                        key={link.label}
                        to={scopedPath(link.to, projectId, range, environment)}
                        className="inline-flex h-7 items-center rounded-md border border-neutral-200 bg-white px-2.5 text-xs font-medium text-neutral-700 transition-colors hover:border-blue-500 hover:text-neutral-900 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-neutral-300 dark:hover:border-white/15 dark:hover:text-white"
                      >
                        {link.label}
                      </Link>
                    ))}
                  </dd>
                </div>
              </DescriptionList>
            </div>
            <MetricChartCard
              fetching={!loading && fetching}
              title="Requests"
              value={compact(data.length)}
              metrics={[
                { label: '1/2/3XX', value: compact(countOk), tone: 'neutral' },
                { label: '4XX', value: compact(count4xx), tone: 'alert' },
                { label: '5XX', value: compact(count5xx), tone: 'error' },
              ]}
            >
              <BarChart
                bounds={bounds}
                series={timed.barSeries}
                unit="requests"
              />
            </MetricChartCard>
          </div>
        </CardTray>
      ) : (
        /* 1:1 Capture Detail 2-card deck for Jobs, Commands, Tasks, Notifications, Mail, Outgoing Requests */
        <CardTray>
          <div className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-2">
            <MetricChartCard
              fetching={!loading && fetching}
              title={countTitle}
              value={compact(data.length)}
              metrics={
                isJobsDetail
                  ? [
                      { label: 'PROCESSED', value: compact(countProcessed), tone: 'neutral' },
                      { label: 'RELEASED', value: compact(countReleased), tone: 'alert' },
                      { label: 'FAILED', value: compact(countFailed), tone: 'error' },
                    ]
                  : isCommandsDetail
                    ? [
                        { label: 'SUCCESSFUL', value: compact(countCmdSuccess), tone: 'neutral' },
                        { label: 'UNSUCCESSFUL', value: compact(countFailed), tone: 'error' },
                      ]
                    : isTasksDetail
                      ? [
                          { label: 'PROCESSED', value: compact(countProcessed), tone: 'neutral' },
                          { label: 'SKIPPED', value: compact(countSkipped), tone: 'alert' },
                          { label: 'FAILED', value: compact(countFailed), tone: 'error' },
                        ]
                      : isOutgoingDetail
                        ? [
                            { label: '1/2/3XX', value: compact(countOk), tone: 'neutral' },
                            { label: '4XX', value: compact(count4xx), tone: 'alert' },
                            { label: '5XX', value: compact(count5xx), tone: 'error' },
                          ]
                        : undefined
              }
            >
              <BarChart
                bounds={bounds}
                series={timed.barSeries}
                unit={sectionPlural.toLowerCase()}
              />
            </MetricChartCard>
            <MetricChartCard
              fetching={!loading && fetching}
              title="Duration"
              value={durationRangeLabel(durations)}
              metrics={[
                { label: 'AVG', value: avgMs > 0 ? ms(avgMs) : '—', tone: 'charcoal' },
                { label: 'P95', value: p95Ms > 0 ? ms(p95Ms) : '—', tone: 'alert' },
              ]}
            >
              <LineChart
                bounds={bounds}
                values={timed.p95Values}
                secondaryValues={timed.avgValues}
                labels={timed.labels}
                timestamps={timed.timestamps}
                format={ms}
              />
            </MetricChartCard>
          </div>
        </CardTray>
      )}

      {/* 1:1 Capture SectionBar + SegmentedToggle filters + FloatingTablePanel */}
      <div className="grid gap-1 md:gap-4">
        <SectionBar
          icon={<PageIcon />}
          title={`${compact(filteredData.length)} ${filteredData.length === 1 ? sectionSingular : sectionPlural}`}
          controls={
            <>
              {isUserDetail && (
                <SearchBox
                  value={search}
                  onChange={setSearch}
                  placeholder="Search requests"
                  className="w-full sm:w-56"
                />
              )}
              <SegmentedToggle
                className="max-md:hidden"
                value={over}
                onChange={(v) => setOver(v as 'all' | 'avg' | 'p95')}
                options={[
                  { value: 'all', label: 'View all' },
                  { value: 'avg', label: '≥ AVG' },
                  { value: 'p95', label: '≥ P95' },
                ]}
              />
              {(isUserDetail || isOutgoingDetail) && (
                <SegmentedToggle
                  className="max-md:hidden"
                  value={statusFilter}
                  onChange={setStatusFilter}
                  options={[
                    { value: 'all', label: 'View all' },
                    { value: '2xx', label: '1/2/3xx', count: { value: countOk, tone: 'default' } },
                    { value: '4xx', label: '4xx', count: { value: count4xx, tone: 'warning' } },
                    { value: '5xx', label: '5xx', count: { value: count5xx, tone: 'error' } },
                  ]}
                />
              )}
              {isJobsDetail && (
                <SegmentedToggle
                  className="max-md:hidden"
                  value={statusFilter}
                  onChange={setStatusFilter}
                  options={[
                    { value: 'all', label: 'View all' },
                    { value: 'processed', label: 'Processed', count: { value: countProcessed, tone: 'default' } },
                    { value: 'released', label: 'Released', count: { value: countReleased, tone: 'warning' } },
                    { value: 'failed', label: 'Failed', count: { value: countFailed, tone: 'error' } },
                  ]}
                />
              )}
              {isCommandsDetail && (
                <SegmentedToggle
                  className="max-md:hidden"
                  value={statusFilter}
                  onChange={setStatusFilter}
                  options={[
                    { value: 'all', label: 'View all' },
                    { value: '0', label: 'Successful', count: { value: countCmdSuccess, tone: 'default' } },
                    { value: '1', label: 'Failed', count: { value: countFailed, tone: 'error' } },
                  ]}
                />
              )}
              {isTasksDetail && (
                <SegmentedToggle
                  className="max-md:hidden"
                  value={statusFilter}
                  onChange={setStatusFilter}
                  options={[
                    { value: 'all', label: 'View all' },
                    { value: 'skipped', label: 'Skipped', count: { value: countSkipped, tone: 'default' } },
                    { value: 'failed', label: 'Failed', count: { value: countFailed, tone: 'error' } },
                  ]}
                />
              )}
            </>
          }
        />

        {filteredData.length === 0 ? (
          <Panel>
            <Empty variant="clean" icon={<PageIcon size={24} className="text-kumo-subtle" />}>
              {`No ${sectionPlural.toLowerCase()} found`}
            </Empty>
          </Panel>
        ) : isUserDetail ? (
          /* 1:1 Capture `Show-DcOlkrSF.js` User Requests table: Date | Method | URL | Status | Duration | [↗] */
          <FloatingTablePanel fetching={!loading && fetching}>
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Date</Table.Head>
                  <Table.Head>Method</Table.Head>
                  <Table.Head>URL</Table.Head>
                  <Table.Head className="text-center">Status</Table.Head>
                  <Table.Head className="text-right">Duration</Table.Head>
                  <Table.Head className="w-12" />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {filteredData.map((r, i) => {
                  const { method, url } = splitTraceName(String(r.trace_name ?? r.trace_id));
                  const statusCode = Number(r.status_code ?? 0);
                  const hasError = statusCode >= 500;
                  return (
                    <Table.Row
                      key={`${r.trace_id}-${i}`}
                      onClick={rowNav(`/traces/${r.trace_id}`)}
                      className={cn(
                        'cursor-pointer',
                        hasError && 'bg-rose-50/70 hover:bg-rose-50 dark:bg-rose-950/35 dark:hover:bg-rose-950/50',
                      )}
                    >
                      <Table.Cell><UtcDate iso={r.timestamp} /></Table.Cell>
                      <Table.Cell>
                        <HttpMethodText method={method} className={hasError ? 'text-rose-500 dark:text-white' : undefined} />
                      </Table.Cell>
                      <Table.Cell className="max-w-lg">
                        <div className="flex min-w-0 items-center gap-2">
                          <GlobeIcon size={13} className="shrink-0 text-neutral-400 max-md:hidden" aria-hidden />
                          {r.url ? (
                            <UrlFormatDisplay url={String(r.url)} className="text-neutral-900 dark:text-white" />
                          ) : (
                            <Link className="truncate text-neutral-900 hover:underline dark:text-white" to={`/traces/${r.trace_id}`}>
                              {url}
                            </Link>
                          )}
                        </div>
                      </Table.Cell>
                      <Table.Cell className="text-center font-mono font-semibold">
                        {statusCode > 0 ? <StatusCodeText status={statusCode} /> : '—'}
                      </Table.Cell>
                      <Table.Cell className="text-right">{ms(Number(r.duration_ms ?? 0))}</Table.Cell>
                      <Table.Cell className="text-right"><RowActionLink to={`/traces/${r.trace_id}`} label="Open trace" /></Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </FloatingTablePanel>
        ) : (
          <FloatingTablePanel fetching={!loading && fetching}>
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Date</Table.Head>
                  {page.rowColumns.map((col) => (
                    <Table.Head key={col.label} className={col.align === 'right' ? 'text-right' : ''}>
                      {col.label}
                    </Table.Head>
                  ))}
                  <Table.Head>Source</Table.Head>
                  <Table.Head className="w-12" />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {filteredData.map((r, i) => {
                  const isError =
                    Number(r.status_code ?? 0) >= 500 ||
                    String(r.status ?? '').toLowerCase() === 'failed' ||
                    (isCommandsDetail && Number(r.exit_code ?? 0) !== 0);
                  return (
                    <Table.Row
                      key={`${r.trace_id}-${i}`}
                      onClick={rowNav(`/traces/${r.trace_id}`)}
                      className={cn(
                        'cursor-pointer',
                        isError && 'bg-rose-50/70 hover:bg-rose-50 dark:bg-rose-950/35 dark:hover:bg-rose-950/50',
                      )}
                    >
                      <Table.Cell><UtcDate iso={r.timestamp} /></Table.Cell>
                      {page.rowColumns.map((col) => (
                        <Table.Cell key={col.label} className={col.align === 'right' ? 'text-right' : ''}>
                          {col.render(r)}
                        </Table.Cell>
                      ))}
                      <Table.Cell className="max-w-xs truncate">
                        <Link className="text-neutral-900 hover:underline dark:text-white" to={`/traces/${r.trace_id}`}>
                          {r.trace_name ?? r.trace_id}
                        </Link>
                      </Table.Cell>
                      <Table.Cell className="text-right"><RowActionLink to={`/traces/${r.trace_id}`} label="Open trace" /></Table.Cell>
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
