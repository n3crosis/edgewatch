import { useMemo, useState } from 'react';
import { groupListLink } from '@/lib/group-list';
import { useRange } from '@/lib/range';
import { useParams, useSearchParams } from 'react-router-dom';
import Link from '@/components/ScopedLink';
import { BarChart, LineChart, MetricChartCard, bucketTimeSeries, durationRangeLabel, rangeFooterBounds } from '@/components/charts';
import {
  CardTray,
  CopyButton,
  DescriptionList,
  DescriptionRow,
  Empty,
  ErrorState,
  FloatingTablePanel,
  Loading,
  PageHeader,
  Panel,
  SectionBar,
  SegmentedToggle,
  SourceTag,
  Sql,
  UtcDate,
  useRowNavigate,
} from '@/components/common';
import { Table } from '@cloudflare/kumo/components/table';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { DatabaseIcon, FolderIcon } from '@phosphor-icons/react';
import { api, useAsync } from '@/lib/api';
import { compact, ms } from '@/lib/format';
import { sqlSummary } from '@/lib/ui-helpers';

export default function QueryDetailPage() {
  const { sqlHash = '' } = useParams();
  const { range } = useRange();
  const rowNav = useRowNavigate();
  const [params] = useSearchParams();
  const [over, setOver] = useState<'all' | 'avg' | 'p95'>('all');
  const { data, error, loading, fetching } = useAsync(
    () => api.query(sqlHash, range),
    [sqlHash, range],
    { keepPreviousData: true },
  );

  const filteredSamples = useMemo(() => {
    const samples = data?.samples ?? [];
    if (!data || over === 'all') return samples;
    const threshold = over === 'p95' ? data.p95_ms : data.avg_ms;
    return samples.filter((s) => s.duration_ms >= threshold);
  }, [data, over]);

  if (error) return <ErrorState error={error} />;
  if (loading) return <Loading />;
  if (!data) {
    return (
      <div className="space-y-5">
        <PageHeader back={{ to: groupListLink('/queries', params), label: 'Queries' }} title="Query not found" />
        <Empty description="This query pattern has no executions in the selected project or time window">
          Query not found
        </Empty>
      </div>
    );
  }

  const title = sqlSummary(data.sql);
  const bounds = rangeFooterBounds(range);
  const timed = bucketTimeSeries(data.samples, range, {
    timestamp: (s) => s.timestamp,
    value: () => 1,
    p95: (s) => s.duration_ms,
    avg: (s) => s.duration_ms,
    buckets: 36,
  });

  return (
    <div className="space-y-4 md:space-y-6 xl:space-y-10">
      <PageHeader
        back={{ to: groupListLink('/queries', params), label: 'Queries' }}
        documentTitle={title}
        title={<span className="font-mono text-lg sm:text-xl">{data.sql}</span>}
      />

      {/* 1:1 Capture `Show-CogNsIzM.js` Top 2-card Calls + Duration deck */}
      <CardTray>
        <div className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-2">
          <MetricChartCard fetching={!loading && fetching} title="Calls" value={compact(data.calls)}>
            <BarChart
              bounds={bounds}
              series={timed.barSeries}
              unit="calls"
            />
          </MetricChartCard>
          <MetricChartCard
            fetching={!loading && fetching}
            title="Duration"
            value={durationRangeLabel([data.avg_ms, data.p95_ms, data.max_ms])}
            metrics={[
              { label: 'AVG', value: ms(data.avg_ms), tone: 'charcoal' },
              { label: 'P95', value: ms(data.p95_ms), tone: 'alert' },
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

      {/* 1:1 Capture `Show-CogNsIzM.js` Info + Formatted SQL 2-column CardTray */}
      <CardTray>
        <div className="flex max-md:flex-col md:gap-12">
          <div className="space-y-4 p-4 md:w-1/2">
            <h3 className="text-base font-semibold text-neutral-900 dark:text-white">Info</h3>
            <DescriptionList>
              <DescriptionRow label="Total Time">{ms(data.total_ms)}</DescriptionRow>
              <DescriptionRow label="Avg Time">{ms(data.avg_ms)}</DescriptionRow>
              <DescriptionRow label="P95">{ms(data.p95_ms)}</DescriptionRow>
              <DescriptionRow label="Calls">{data.calls.toLocaleString()}</DescriptionRow>
            </DescriptionList>
          </div>
          <div className="relative rounded-lg border border-neutral-200 bg-white md:w-1/2 dark:border-white/[0.08] dark:bg-neutral-900">
            <pre className="h-full max-h-64 overflow-auto whitespace-pre-wrap break-words p-4 pr-12 font-mono text-xs leading-6">
              <Sql sql={data.sql} />
            </pre>
            <CopyButton text={data.sql} label="Copy SQL" toastMessage="SQL copied to clipboard." className="absolute right-2.5 top-2.5" />
          </div>
        </div>
      </CardTray>

      {/* 1:1 Capture `Show-CogNsIzM.js` Calls section with ≥ AVG / ≥ P95 SegmentedToggle and 5 columns */}
      <div className="grid gap-1 md:gap-4">
        <SectionBar
          icon={<DatabaseIcon />}
          title={`${compact(over === 'all' ? data.calls : filteredSamples.length)} ${(over === 'all' ? data.calls : filteredSamples.length) === 1 ? 'Call' : 'Calls'}`}
          controls={
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
          }
        />
        {filteredSamples.length === 0 ? (
          <Panel><Empty variant="clean" icon={<DatabaseIcon size={24} className="text-kumo-subtle" />}>No calls found</Empty></Panel>
        ) : (
          <FloatingTablePanel fetching={!loading && fetching}>
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Date</Table.Head>
                  <Table.Head>Source</Table.Head>
                  <Table.Head>Location</Table.Head>
                  <Table.Head>Connection</Table.Head>
                  <Table.Head className="text-right">Duration</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {filteredSamples.map((s, i) => (
                  <Table.Row key={`${s.trace_id}-${i}`} onClick={rowNav(`/traces/${s.trace_id}`)} className="cursor-pointer">
                    <Table.Cell><UtcDate iso={s.timestamp} /></Table.Cell>
                    <Table.Cell className="max-w-xs">
                      <div className="flex items-center gap-2">
                        <SourceTag source="REQUEST" />
                        <Link title={s.name} to={`/traces/${s.trace_id}`} className="truncate text-neutral-900 hover:underline dark:text-white">
                          {s.name}
                        </Link>
                      </div>
                    </Table.Cell>
                    <Table.Cell className="max-w-xs">
                      <Tooltip asChild content={`${s.file}:${s.line}`}>
                        <span className="inline-flex max-w-full items-center gap-1.5 text-neutral-600 dark:text-neutral-400">
                          <FolderIcon size={13} className="shrink-0 text-neutral-400 max-md:hidden" aria-hidden />
                          <span className="truncate">{s.file}:{s.line}</span>
                        </span>
                      </Tooltip>
                    </Table.Cell>
                    <Table.Cell className="text-neutral-600 dark:text-neutral-400">{data.connection}</Table.Cell>
                    <Table.Cell className="text-right">{ms(s.duration_ms)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </FloatingTablePanel>
        )}
      </div>
    </div>
  );
}
