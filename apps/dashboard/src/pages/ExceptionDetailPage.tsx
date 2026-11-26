import ExceptionCard from '@/components/ExceptionCard';
import UserFilter from '@/components/UserFilter';
import { groupListLink } from '@/lib/group-list';
import { timeWindow } from '@edgewatch/shared/time-window';
import { useEnvironment } from '@/lib/environment';
import { useProject } from '@/lib/project';
import { useRange } from '@/lib/range';
import { useParams, useSearchParams } from 'react-router-dom';
import Link, { scopedPath } from '@/components/ScopedLink';
import { BarChart, MetricChartCard, rangeFooterBounds } from '@/components/charts';
import {
  CardTray,
  DescriptionList,
  DescriptionRow,
  Empty,
  ErrorState,
  FloatingTablePanel,
  Loading,
  PageHeader,
  Panel,
  SectionBar,
  SourceTag,
  UtcDate,
  useRowNavigate,
} from '@/components/common';
import { LinkButton } from '@cloudflare/kumo/components/button';
import { Table } from '@cloudflare/kumo/components/table';
import { WarningIcon, WarningOctagonIcon } from '@phosphor-icons/react';
import { api, USING_MOCK, useAsync } from '@/lib/api';
import { bucketTime, compact } from '@/lib/format';
import { splitClassName } from '@/lib/ui-helpers';

export default function ExceptionDetailPage() {
  const { group = '' } = useParams();
  const { range } = useRange();
  const { projectId } = useProject();
  const { environment } = useEnvironment();
  const [params] = useSearchParams();
  const rowNav = useRowNavigate();
  const user = params.get('user') || undefined;
  const { data, error, loading, fetching } = useAsync(
    () => api.exception(group, range, user),
    [group, range, user],
    { keepPreviousData: true },
  );

  if (error) return <ErrorState error={error} />;
  if (loading) return <Loading />;
  if (!data) {
    return (
      <div className="space-y-5">
        <PageHeader back={{ to: groupListLink('/exceptions', params), label: 'Exceptions' }} title="Exception not found" />
        <Empty description="No occurrences for this exception group exist in the selected project or time window">
          Exception group not found
        </Empty>
      </div>
    );
  }

  const { short } = splitClassName(data.class);
  const win = timeWindow(range);

  return (
    <div className="space-y-4 md:space-y-6 xl:space-y-10">
      {/* 1:1 Capture `Show-f4VrUNA_.js`: Related Issues + UserFilter + RangePicker */}
      <PageHeader
        back={{ to: groupListLink('/exceptions', params), label: 'Exceptions' }}
        documentTitle={short}
        title={<span className="line-clamp-2">{data.message || short}</span>}
        actions={
          <>
            {!USING_MOCK && !data.handled && (
              <LinkButton
                href={scopedPath(`/issues/${data.group}`, projectId, range, environment)}
                variant="secondary"
                size="sm"
                icon={WarningOctagonIcon}
              >
                Issue
              </LinkButton>
            )}
            <UserFilter />
          </>
        }
      />

      {/* 1:1 Capture `Show-f4VrUNA_.js` Top 2-column CardTray: Dotted-leader metadata + Occurrences chart */}
      <CardTray>
        <div className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-2">
          <div className="rounded-lg border border-neutral-200 bg-white p-5 shadow-md shadow-black/[0.04] dark:border-white/[0.06] dark:bg-white/[0.02]">
            <DescriptionList className="md:gap-5">
              <DescriptionRow label="Last Seen"><UtcDate iso={data.last_seen} /></DescriptionRow>
              <DescriptionRow label="First Seen"><UtcDate iso={data.first_seen} /></DescriptionRow>
              <DescriptionRow label="Impacted Users">{compact(data.users)}</DescriptionRow>
              <DescriptionRow label="Occurrences">
                <span className="inline-flex items-center gap-2">
                  <span>{compact(data.count)}</span>
                  {data.unhandled_count !== undefined && (
                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-600 dark:bg-white/10 dark:text-neutral-300">
                      {compact(data.unhandled_count)} unhandled
                    </span>
                  )}
                </span>
              </DescriptionRow>
              <DescriptionRow label="Location">{`${data.file}:${data.line}`}</DescriptionRow>
            </DescriptionList>
          </div>
          <MetricChartCard
            fetching={!loading && fetching}
            title="Occurrences"
            value={compact(data.count)}
            metrics={[
              { label: 'Handled', value: compact(data.handled_count ?? (data.handled ? data.count : 0)), tone: 'neutral' },
              { label: 'Unhandled', value: compact(data.unhandled_count ?? (data.handled ? 0 : data.count)), tone: 'error' },
            ]}
          >
            <BarChart
              height={196}
              tone="neutral"
              unit="occurrences"
              bounds={rangeFooterBounds(range)}
              series={data.trend.map((v, i) => ({
                label: win ? bucketTime(win.since + i * win.width, range) : `#${i + 1}`,
                ts: win ? Math.round(win.since + i * win.width) : undefined,
                value: v,
                highlight: data.handled ? 0 : v,
              }))}
            />
          </MetricChartCard>
        </div>
      </CardTray>

      {/* 1:1 Capture Exception Stack Trace Card (`ExceptionCard-DPB90xMt.js`) */}
      <CardTray>
        <ExceptionCard
          className={data.class}
          message={data.message}
          handled={data.handled}
          file={data.file}
          line={data.line}
          stack={data.stack}
        />
      </CardTray>

      {/* 1:1 Capture `Show-f4VrUNA_.js` Occurrences section: Date | Source | Message | User */}
      <div className="grid gap-1 md:gap-4">
        <SectionBar
          icon={<WarningIcon />}
          title={`${data.occurrences.length} ${data.occurrences.length === 1 ? 'occurrence' : 'occurrences'}`}
        />
        {data.occurrences.length === 0 ? (
          <Panel><Empty variant="clean" icon={<WarningIcon size={24} className="text-kumo-subtle" />}>No occurrences found</Empty></Panel>
        ) : (
          <FloatingTablePanel fetching={!loading && fetching}>
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Date</Table.Head>
                  <Table.Head>Source</Table.Head>
                  <Table.Head>Message</Table.Head>
                  <Table.Head className="text-right">User</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.occurrences.slice(0, 25).map((o) => (
                  <Table.Row key={o.trace_id} onClick={rowNav(`/traces/${o.trace_id}`)} className="cursor-pointer">
                    <Table.Cell><UtcDate iso={o.timestamp} /></Table.Cell>
                    <Table.Cell className="max-w-xs">
                      <div className="flex items-center gap-2">
                        <SourceTag source="REQUEST" />
                        <Link to={`/traces/${o.trace_id}`} className="truncate text-neutral-900 hover:underline dark:text-white">
                          {o.name}
                        </Link>
                      </div>
                    </Table.Cell>
                    <Table.Cell className="max-w-lg truncate text-neutral-600 dark:text-neutral-300">
                      {data.message}
                    </Table.Cell>
                    <Table.Cell className="text-right text-neutral-500 dark:text-neutral-400">
                      {o.user ? (
                        <Link
                          to={`/users/${encodeURIComponent(o.user)}`}
                          onClick={(e) => e.stopPropagation()}
                          className="hover:text-neutral-900 hover:underline dark:hover:text-white"
                        >
                          #{o.user}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </Table.Cell>
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
