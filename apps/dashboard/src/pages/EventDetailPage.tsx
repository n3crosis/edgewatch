import { userActivityLinks, withUser } from '@/lib/user-activity';
import { Badge } from '@cloudflare/kumo/components/badge';
import { LinkButton } from '@cloudflare/kumo/components/button';
import { Table } from '@cloudflare/kumo/components/table';
import {
  ArrowsLeftRightIcon,
  BriefcaseIcon,
  BugIcon,
  GitBranchIcon,
  ListBulletsIcon,
  TimerIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { useParams, useSearchParams } from 'react-router-dom';
import { CopyButton, Empty, ErrorState, Loading, PageHeader, Panel, Stat, TimeAgo, useRowNavigate } from '@/components/common';
import { api, useAsync } from '@/lib/api';
import { useEnvironment } from '@/lib/environment';
import type { EventPage } from '@/lib/events';
import { compact, ms } from '@/lib/format';
import Link, { scopedPath } from '@/components/ScopedLink';
import { useProject } from '@/lib/project';
import { useRange, rangeLabel } from '@/lib/range';
import { splitClassName } from '@/lib/ui-helpers';

const USER_LINK_ICONS = {
  Requests: ArrowsLeftRightIcon,
  Jobs: BriefcaseIcon,
  Exceptions: BugIcon,
  Logs: ListBulletsIcon,
} as const;

export default function EventDetailPage({ page }: { page: EventPage }) {
  const key = useParams().key ?? '';
  const { range } = useRange();
  const rowNav = useRowNavigate();
  const { projectId } = useProject();
  const { environment } = useEnvironment();
  const [params] = useSearchParams();
  const user = params.get('user') || undefined;
  const { data, error, loading, fetching } = useAsync(() => api.eventRows(page.path, key, range, user), [page.path, key, range, user], { keepPreviousData: true });
  const PageIcon = page.icon;

  if (error) return <ErrorState error={error} />;
  if (loading) return <Loading />;
  if (!data) {
    return (
      <>
        <PageHeader back={{ to: withUser(page.path, user), label: page.title }} title={`${page.keyLabel} not found`} />
        <Panel>
          <Empty
            icon={<PageIcon size={32} className="text-kumo-subtle" />}
            description="No executions match this item in the selected project or time window."
          >
            {`${page.keyLabel} not found.`}
          </Empty>
        </Panel>
      </>
    );
  }

  const isUserDetail = page.path === '/users';
  const classSplit = page.isClassKey ? splitClassName(key) : null;
  const headingText = classSplit ? classSplit.short : key;
  const userErrors = isUserDetail ? data.filter((r) => Number(r.status_code ?? 0) >= 500 || Number(r.exception_count ?? 0) > 0).length : 0;
  const userDurations = isUserDetail ? data.map((r) => Number(r.duration_ms ?? 0)).filter((d) => Number.isFinite(d) && d > 0) : [];
  const userAvgMs = userDurations.length ? userDurations.reduce((a, b) => a + b, 0) / userDurations.length : null;

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ to: withUser(page.path, user), label: page.title }}
        documentTitle={`${page.title}: ${headingText}`}
        title={page.path === '/logs' && page.renderKey ? page.renderKey(key) : <span className="font-mono">{headingText}</span>}
        subtitle={
          <span className="mt-1.5 flex flex-wrap items-center gap-2.5">
            {classSplit?.namespace && <span className="font-mono text-xs text-kumo-subtle">{classSplit.namespace}</span>}
            <span>{data.length} most recent · {rangeLabel(range)}</span>
            {user && <Badge variant="outline" className="font-mono">User #{user}</Badge>}
            <CopyButton text={key} label={`Copy ${page.keyLabel.toLowerCase()}`} toastMessage={`${page.keyLabel} copied.`} className="size-6" />
          </span>
        }
      />

      {isUserDetail && (
        <>
          <section className="grid grid-cols-1 gap-5 sm:grid-cols-3">
            <Stat label="Recent executions" icon={<GitBranchIcon size={14} />} value={compact(data.length)} hint={`Latest in ${rangeLabel(range)}`} />
            <Stat label="Errors" icon={<WarningCircleIcon size={14} />} value={compact(userErrors)} tone={userErrors > 0 ? 'bad' : 'good'} hint="5xx or exceptions" />
            <Stat label="Avg duration" icon={<TimerIcon size={14} />} value={userAvgMs === null ? '—' : ms(userAvgMs)} />
          </section>
          <nav aria-label="User activity" className="flex flex-wrap items-center gap-2.5">
            {userActivityLinks(key).map((link) => (
              <LinkButton
                key={link.label}
                href={scopedPath(link.to, projectId, range, environment)}
                variant="secondary"
                size="sm"
                icon={USER_LINK_ICONS[link.label as keyof typeof USER_LINK_ICONS]}
              >
                {link.label}
              </LinkButton>
            ))}
          </nav>
        </>
      )}

      <Panel fetching={!loading && fetching} title="Recent executions">
        {data.length === 0 ? (
          <Empty icon={<PageIcon size={32} className="text-kumo-subtle" />}>No executions recorded in this window.</Empty>
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>When</Table.Head>
                {page.rowColumns.map((col) => <Table.Head key={col.label} className={col.align === 'right' ? 'text-right' : ''}>{col.label}</Table.Head>)}
                <Table.Head>Trace</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.map((r, i) => (
                <Table.Row key={`${r.trace_id}-${i}`} onClick={rowNav(`/traces/${r.trace_id}`)} className="cursor-pointer transition-colors hover:bg-kumo-tint/50">
                  <Table.Cell className="text-xs"><TimeAgo iso={r.timestamp} /></Table.Cell>
                  {page.rowColumns.map((col) => <Table.Cell key={col.label} className={`tabular-nums ${col.align === 'right' ? 'text-right' : ''}`}>{col.render(r)}</Table.Cell>)}
                  <Table.Cell className="max-w-xs truncate font-mono text-xs">
                    <Link className="text-kumo-link hover:underline" to={`/traces/${r.trace_id}`}>{r.trace_name ?? r.trace_id}</Link>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </Panel>
    </div>
  );
}
