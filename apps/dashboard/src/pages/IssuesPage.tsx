import { useMemo, useState } from 'react';
import ExceptionCard from '@/components/ExceptionCard';
import { useEnvironment } from '@/lib/environment';
import { useProject } from '@/lib/project';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { Textarea } from '@cloudflare/kumo/components/input';
import { Table } from '@cloudflare/kumo/components/table';
import { useKumoToastManager } from '@cloudflare/kumo/components/toast';
import { cn } from '@cloudflare/kumo/utils';
import {
  ArrowCounterClockwiseIcon,
  ArrowUpRightIcon,
  CheckCircleIcon,
  ClockCounterClockwiseIcon,
  EyeSlashIcon,
  LockSimpleIcon,
  WarningOctagonIcon,
} from '@phosphor-icons/react';
import { useParams, useSearchParams } from 'react-router-dom';
import Link, { scopedPath } from '@/components/ScopedLink';
import {
  Empty,
  ErrorState,
  FloatingTablePanel,
  Loading,
  PageHeader,
  PaginationBar,
  Panel,
  RowActionLink,
  SearchBox,
  SegmentedToggle,
  SortableLabel,
  SourceTag,
  TimeAgo,
  useRowNavigate,
} from '@/components/common';
import { api, USING_MOCK, useAsync } from '@/lib/api';
import { ago, compact } from '@/lib/format';
import { useRange, rangeLabel } from '@/lib/range';
import type { IssueStatus } from '@/lib/types';

const QUICK_REASONS = ['Fixed in latest deploy', 'Transient upstream error', 'Expected behavior'] as const;
const statuses: IssueStatus[] = ['open', 'resolved', 'ignored'];
const date = (value: number) => new Date(value).toLocaleString();
const statusVariant = (status: IssueStatus): 'error' | 'success' | 'secondary' =>
  status === 'open' ? 'error' : status === 'resolved' ? 'success' : 'secondary';
const statusLabel = (status: string) => status.charAt(0).toUpperCase() + status.slice(1);

type IssueSort = 'id' | 'title' | 'count' | 'users' | 'first_seen' | 'last_seen';

function StatusIndicator({ status }: { status: IssueStatus }) {
  if (status === 'resolved') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-neutral-900 dark:text-white">
        <CheckCircleIcon size={14} weight="fill" className="text-emerald-500" aria-hidden />
        <span>Resolved</span>
      </span>
    );
  }
  if (status === 'ignored') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-neutral-600 dark:text-neutral-300">
        <EyeSlashIcon size={14} className="text-neutral-400" aria-hidden />
        <span>Ignored</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-neutral-900 dark:text-white">
      <span className="grid size-3.5 place-items-center rounded-full border-2 border-blue-600 dark:border-blue-400" aria-hidden>
        <span className="size-1.5 rounded-full bg-blue-600 dark:bg-blue-400" />
      </span>
      <span>Open</span>
    </span>
  );
}

export default function IssuesPage() {
  const { range } = useRange();
  const rowNav = useRowNavigate();
  const [params, setParams] = useSearchParams();
  const issueType = params.get('type') === 'performance' ? 'performance' : 'exception';
  const rawStatus = params.get('status') ?? 'open';
  const status: IssueStatus = rawStatus === 'resolved' || rawStatus === 'ignored' ? rawStatus : 'open';
  const q = params.get('q') ?? '';
  const offset = Number(params.get('offset')) || 0;
  const [sortBy, setSortBy] = useState<IssueSort>('last_seen');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const { data, error, loading, fetching } = useAsync(
    () => (issueType === 'performance' ? Promise.resolve({ data: [], next_offset: null }) : api.issues(range, status, q, offset)),
    [issueType, range, status, q, offset],
    { keepPreviousData: true },
  );
  const openCountQuery = useAsync(
    () => (status === 'open' && issueType === 'exception' ? Promise.resolve(null) : api.issues(range, 'open', '', 0)),
    [range, status, issueType],
    { keepPreviousData: true },
  );
  // Enrich issue rows with exact COUNT and USERS from exceptions in the same window (matching Nightwatch `Index-Bat4cuWO.js`)
  const exceptionStats = useAsync(
    () => (issueType === 'exception' ? api.exceptions(range) : Promise.resolve([])),
    [issueType, range],
    { keepPreviousData: true },
  );

  const statsByGroup = useMemo(() => {
    const map = new Map<string, { count: number; users: number }>();
    for (const e of exceptionStats.data ?? []) {
      map.set(e.group, { count: e.unhandled_count ?? e.count, users: e.users });
    }
    return map;
  }, [exceptionStats.data]);

  const update = (patch: Record<string, string | null>) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
      }
      return next;
    });

  const toggleSort = (col: IssueSort) => {
    if (sortBy === col) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortBy(col);
      setSortDir(col === 'title' || col === 'id' ? 'asc' : 'desc');
    }
  };

  const rawRows = data?.data ?? [];
  const enrichedRows = useMemo(() => {
    const dir = sortDir === 'desc' ? -1 : 1;
    return rawRows
      .map((issue, idx) => {
        const stats = statsByGroup.get(issue.group_hash);
        return {
          issue,
          seq: offset + rawRows.length - idx,
          count: stats?.count ?? 0,
          users: stats?.users ?? 0,
        };
      })
      .sort((a, b) => {
        if (sortBy === 'id') return (a.seq - b.seq) * dir;
        if (sortBy === 'title') return a.issue.class.localeCompare(b.issue.class) * dir;
        if (sortBy === 'count') return (a.count - b.count) * dir;
        if (sortBy === 'users') return (a.users - b.users) * dir;
        if (sortBy === 'first_seen') return (a.issue.first_seen - b.issue.first_seen) * dir;
        return (a.issue.last_seen - b.issue.last_seen) * dir;
      });
  }, [rawRows, statsByGroup, offset, sortBy, sortDir]);

  const hasFilters = Boolean(q.trim() || status !== 'open');
  const openCount = status === 'open' && issueType === 'exception' ? rawRows.length : (openCountQuery.data?.data.length ?? 0);

  return (
    <div className="space-y-4 md:space-y-6">
      {/* 1:1 Nightwatch `Index-Bat4cuWO.js`: leftSlot `Exceptions [n] | Performance [0]`, rightSlot `Search` + `Open [n] | Resolved | Ignored` */}
      <PageHeader
        documentTitle="Issues"
        title="Issues"
        hideTitle
        hideTelemetryControls
        leftSlot={
          <SegmentedToggle
            className="max-md:hidden"
            value={issueType}
            onChange={(value) => update({ type: value === 'exception' ? null : value, offset: null })}
            options={[
              {
                value: 'exception',
                label: 'Exceptions',
                count: { value: openCount, tone: 'default' },
              },
              {
                value: 'performance',
                label: 'Performance',
                count: { value: 0, tone: 'default' },
              },
            ]}
          />
        }
        actions={
          <>
            <SearchBox
              value={q}
              onChange={(value) => update({ q: value || null, offset: null })}
              placeholder="Search"
              className="w-44 sm:w-56 max-md:hidden"
            />
            <SegmentedToggle
              className="max-md:hidden"
              value={status}
              onChange={(value) => update({ status: value, offset: null })}
              options={[
                { value: 'open', label: 'Open', count: { value: openCount, tone: 'default' } },
                { value: 'resolved', label: 'Resolved' },
                { value: 'ignored', label: 'Ignored' },
              ]}
            />
          </>
        }
      />

      {error ? (
        <ErrorState error={error} />
      ) : loading && !data ? (
        <Panel><Loading /></Panel>
      ) : !enrichedRows.length ? (
        <Empty
          description={USING_MOCK ? 'Connect your API to manage issue lifecycle' : undefined}
          action={
            hasFilters && !USING_MOCK ? (
              <Button variant="secondary" size="sm" onClick={() => update({ q: null, status: 'open', offset: null })}>
                Reset filters
              </Button>
            ) : undefined
          }
        >
          {USING_MOCK ? 'Issue tracking requires live API' : 'No issues found'}
        </Empty>
      ) : (
        /* 1:1 Nightwatch `Index-Bat4cuWO.js` table: ID | ISSUE | COUNT | USERS | FIRST SEEN | LAST SEEN | [↗] */
        <FloatingTablePanel
          fetching={!loading && fetching}
          footer={
            offset > 0 || data?.next_offset != null ? (
              <PaginationBar
                status={`${enrichedRows.length} issue${enrichedRows.length === 1 ? '' : 's'} on this page`}
                onPrevious={() => update({ offset: offset <= 50 ? null : String(offset - 50) })}
                previousDisabled={offset === 0 || fetching}
                onNext={() => update({ offset: String(data?.next_offset ?? 0) })}
                nextDisabled={fetching || data?.next_offset == null}
              />
            ) : undefined
          }
        >
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head className="w-16">
                  <SortableLabel align="left" active={sortBy === 'id'} direction={sortDir} onClick={() => toggleSort('id')}>
                    ID
                  </SortableLabel>
                </Table.Head>
                <Table.Head className="min-w-[240px]">
                  <SortableLabel align="left" active={sortBy === 'title'} direction={sortDir} onClick={() => toggleSort('title')}>
                    Issue
                  </SortableLabel>
                </Table.Head>
                <Table.Head className="w-24 text-right">
                  <SortableLabel align="right" active={sortBy === 'count'} direction={sortDir} onClick={() => toggleSort('count')}>
                    Count
                  </SortableLabel>
                </Table.Head>
                <Table.Head className="w-24 text-right">
                  <SortableLabel align="right" active={sortBy === 'users'} direction={sortDir} onClick={() => toggleSort('users')}>
                    Users
                  </SortableLabel>
                </Table.Head>
                <Table.Head className="w-28 whitespace-nowrap text-right max-md:hidden">
                  <SortableLabel align="right" active={sortBy === 'first_seen'} direction={sortDir} onClick={() => toggleSort('first_seen')}>
                    First Seen
                  </SortableLabel>
                </Table.Head>
                <Table.Head className="w-28 whitespace-nowrap text-right">
                  <SortableLabel align="right" active={sortBy === 'last_seen'} direction={sortDir} onClick={() => toggleSort('last_seen')}>
                    Last Seen
                  </SortableLabel>
                </Table.Head>
                <Table.Head className="w-12 text-right" />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {enrichedRows.map(({ issue, seq, count, users }) => {
                const target = `/issues/${issue.group_hash}`;
                return (
                  <Table.Row
                    key={issue.group_hash}
                    onClick={rowNav(target)}
                    className="group cursor-pointer"
                  >
                    <Table.Cell className="font-sans text-sm text-neutral-700 dark:text-neutral-300">
                      {seq}
                    </Table.Cell>
                    <Table.Cell className="max-w-xl whitespace-normal !py-2.5">
                      <Link
                        className="block truncate font-sans text-sm font-medium text-neutral-900 hover:underline dark:text-white"
                        to={target}
                      >
                        {issue.class}
                      </Link>
                      <p title={issue.message} className="mt-0.5 truncate font-mono text-xs tracking-tight text-neutral-500 dark:text-neutral-400">
                        {issue.message}
                      </p>
                    </Table.Cell>
                    <Table.Cell className="text-right text-neutral-600 dark:text-neutral-400">
                      {count > 0 ? compact(count) : '—'}
                    </Table.Cell>
                    <Table.Cell className="text-right text-neutral-600 dark:text-neutral-400">
                      {users > 0 ? compact(users) : '—'}
                    </Table.Cell>
                    <Table.Cell className="text-right text-neutral-500 max-md:hidden dark:text-neutral-400">
                      <TimeAgo iso={new Date(issue.first_seen).toISOString()} />
                    </Table.Cell>
                    <Table.Cell className="text-right text-neutral-500 dark:text-neutral-400">
                      <TimeAgo iso={new Date(issue.last_seen).toISOString()} />
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      <RowActionLink to={target} label={`Open ${issue.class}`} />
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </FloatingTablePanel>
      )}
    </div>
  );
}

export function IssueDetailPage() {
  const { group = '' } = useParams();
  const { projectId } = useProject();
  const { range } = useRange();
  const { environment } = useEnvironment();
  const toasts = useKumoToastManager();
  const [revision, refresh] = useState(0);
  const [reason, setReason] = useState('');
  const [busyStatus, setBusyStatus] = useState<IssueStatus | null>(null);
  const [mutationError, setMutationError] = useState<Error | null>(null);

  const { data, error, loading, fetching } = useAsync(() => api.issue(group), [group, revision], { keepPreviousData: true });
  const exceptionDetail = useAsync(() => api.exception(group, range), [group, range], { keepPreviousData: true });
  const permissions = useAsync(() => api.permissions(), []);

  async function change(status: IssueStatus) {
    if (!data || busyStatus) return;
    setBusyStatus(status);
    setMutationError(null);
    try {
      await api.updateIssue(group, status, data.issue.status, data.issue.revision, reason);
      setReason('');
      refresh((value) => value + 1);
      toasts.add({
        variant: 'success',
        title: status === 'open' ? 'Issue reopened.' : `Issue marked as ${status}.`,
      });
    } catch (err) {
      setMutationError(err instanceof Error ? err : new Error(String(err)));
      refresh((value) => value + 1);
    } finally {
      setBusyStatus(null);
    }
  }

  if (error) return <ErrorState error={error} />;
  if (loading) return <Loading />;
  if (!data) {
    return (
      <div className="space-y-4 md:space-y-6">
        <PageHeader hideTelemetryControls back={{ to: '/issues', label: 'Issues' }} title="Issue not found" />
        <Panel>
          <Empty
            icon={<WarningOctagonIcon size={16} />}
            description="This issue does not exist in the selected project"
          >
            Issue not found
          </Empty>
        </Panel>
      </div>
    );
  }

  const { issue, impact, changes } = data;
  const exc = exceptionDetail.data;
  const occurrences = exc?.occurrences ?? [];
  const shortId = group.slice(0, 6).toUpperCase();
  const excUrl = scopedPath(`/exceptions/${group}`, projectId, range, environment);

  return (
    <div className="space-y-6">
      {/* 1:1 Nightwatch `issues-1` (`Show-CWKUTMgg.js`) breadcrumb + full `Class: message` title + 2-column body */}
      <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
        <div className="min-w-0 flex-1 space-y-6">
          <PageHeader
            hideTelemetryControls
            back={{ to: `/issues?status=${issue.status}`, label: statusLabel(issue.status) }}
            documentTitle={shortId}
            title={
              <span className="break-words text-xl font-semibold leading-snug text-neutral-900 md:text-2xl dark:text-white">
                {issue.message ? `${issue.class}: ${issue.message}` : issue.class}
              </span>
            }
          />

          {/* Compact Triage / Note Card matching Nightwatch top editor box */}
          <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm shadow-black/[0.04] dark:border-white/[0.06] dark:bg-white/[0.02]">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 px-4 py-2.5 dark:border-white/[0.06]">
              <span className="border-b-2 border-blue-600 pb-1 text-sm font-medium text-neutral-900 dark:border-white dark:text-white">
                Triage note
              </span>
              {permissions.data?.can_manage && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {QUICK_REASONS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setReason(preset)}
                      className="rounded-md border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs text-neutral-600 transition-colors hover:border-neutral-300 hover:bg-white hover:text-neutral-900 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-neutral-400 dark:hover:text-white"
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-3 p-4">
              {permissions.loading && !permissions.data ? (
                <Loading rows={2} />
              ) : permissions.data?.can_manage ? (
                <form className="space-y-3" onSubmit={(event) => event.preventDefault()}>
                  <Textarea
                    aria-label="Triage note"
                    placeholder="Add a short note explaining why you are resolving, ignoring, or reopening…"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={500}
                    rows={2}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">
                      Resolved issues reopen automatically on a new occurrence.
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                      {statuses.filter((s) => s !== issue.status).map((s) => (
                        <Button
                          key={s}
                          size="sm"
                          variant={s === 'resolved' ? 'primary' : 'secondary'}
                          icon={s === 'open' ? ArrowCounterClockwiseIcon : s === 'resolved' ? CheckCircleIcon : EyeSlashIcon}
                          disabled={busyStatus !== null || !reason.trim()}
                          loading={busyStatus === s}
                          onClick={() => void change(s)}
                        >
                          {s === 'open' ? 'Reopen' : s === 'resolved' ? 'Resolve' : 'Ignore'}
                        </Button>
                      ))}
                    </div>
                  </div>
                </form>
              ) : permissions.data ? (
                <p className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                  <LockSimpleIcon size={14} className="shrink-0" aria-hidden />
                  <span>An admin account is required to change issue status.</span>
                </p>
              ) : null}
              {mutationError && <ErrorState error={mutationError} />}
            </div>
          </div>

          {/* 1:1 Nightwatch Embedded ExceptionCard (`UNHANDLED` + `Copy as Markdown` + Stack frames) */}
          <ExceptionCard
            className={exc?.class ?? issue.class}
            message={exc?.message ?? issue.message}
            handled={exc?.handled ?? false}
            file={exc?.file}
            line={exc?.line}
            stack={exc?.stack ?? []}
          />

          {/* 1:1 Nightwatch `N occurrences` card right below ExceptionCard */}
          <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm shadow-black/[0.04] dark:border-white/[0.06] dark:bg-white/[0.02]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 px-5 py-3.5 dark:border-white/[0.06]">
              <h3 className="text-base font-semibold text-neutral-900 dark:text-white">
                {compact(impact.occurrences)} {impact.occurrences === 1 ? 'occurrence' : 'occurrences'}
              </h3>
              <div className="flex items-center gap-2.5">
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  {rangeLabel(range)}
                </span>
                <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-neutral-200 bg-neutral-50 px-2.5 text-xs font-medium text-neutral-800 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-neutral-200">
                  <span className="size-2 rounded-full bg-blue-600 dark:bg-emerald-500" aria-hidden />
                  <span>{environment || 'All environments'}</span>
                </span>
                <Link
                  to={excUrl}
                  className="inline-flex h-7 items-center rounded-md border border-neutral-200 bg-white px-2.5 text-xs font-medium text-neutral-700 transition-colors hover:border-blue-500 hover:text-neutral-900 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-neutral-300 dark:hover:border-white/15 dark:hover:text-white"
                >
                  View all
                </Link>
              </div>
            </div>
            {occurrences.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
                No retained occurrences in the selected time window.
              </div>
            ) : (
              <div className="divide-y divide-neutral-100 dark:divide-white/[0.05]">
                {occurrences.slice(0, 8).map((o) => (
                  <Link
                    key={o.trace_id}
                    to={`/traces/${o.trace_id}`}
                    className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1.2fr)_auto_auto] items-center gap-4 px-5 py-3 font-mono text-xs transition-colors hover:bg-neutral-50 dark:hover:bg-white/[0.03]"
                  >
                    <span className="whitespace-nowrap text-neutral-500 dark:text-neutral-400">
                      <TimeAgo iso={o.timestamp} />
                    </span>
                    <span className="flex min-w-0 items-center gap-2">
                      <SourceTag source="REQUEST" />
                      <span className="truncate text-neutral-800 dark:text-neutral-200">{o.name}</span>
                    </span>
                    <span className="truncate text-neutral-600 max-md:hidden dark:text-neutral-400">
                      {exc?.message ?? issue.message}
                    </span>
                    <span className="whitespace-nowrap text-neutral-500 dark:text-neutral-400">
                      {o.user ? `#${o.user}` : '—'}
                    </span>
                    <ArrowUpRightIcon size={13} className="shrink-0 text-neutral-400" aria-hidden />
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Activity / Change history */}
          <Panel fetching={!loading && fetching} title={`Activity (${changes.length})`}>
            {!changes.length ? (
              <Empty variant="clean" icon={<ClockCounterClockwiseIcon size={24} className="text-kumo-subtle" />}>
                No status changes recorded.
              </Empty>
            ) : (
              <ol className="divide-y divide-neutral-200/70 dark:divide-white/[0.06]">
                {changes.map((entry) => (
                  <li className="px-5 py-4 text-sm" key={entry.id}>
                    <div className="flex flex-wrap items-center gap-2.5 text-xs text-kumo-subtle">
                      <Badge variant={statusVariant(entry.status)}>{statusLabel(entry.status)}</Badge>
                      <span className="font-medium text-kumo-strong">{entry.actor}</span>
                      <span>·</span>
                      <TimeAgo iso={new Date(entry.timestamp).toISOString()} />
                    </div>
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-kumo-default">{entry.reason}</p>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>

        {/* 1:1 Nightwatch `issues-1` Right Sidebar: Manage / Details / Occurrences */}
        <aside className="w-full shrink-0 space-y-3 xl:w-80 xl:pt-2">
          <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm shadow-black/[0.04] dark:border-white/[0.06] dark:bg-white/[0.02]">
            <div className="divide-y divide-neutral-200/80 dark:divide-white/[0.06]">
              <div>
                <div className="bg-neutral-100/80 px-4 py-3 text-sm font-medium text-neutral-900 dark:bg-white/[0.04] dark:text-white">
                  Manage
                </div>
                <dl className="space-y-3 px-4 py-4 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-neutral-500 dark:text-neutral-400">Status</dt>
                    <dd><StatusIndicator status={issue.status} /></dd>
                  </div>
                </dl>
              </div>
              <div>
                <div className="bg-neutral-100/80 px-4 py-3 text-sm font-medium text-neutral-900 dark:bg-white/[0.04] dark:text-white">
                  Details
                </div>
                <dl className="space-y-3 px-4 py-4 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-neutral-500 dark:text-neutral-400">First seen</dt>
                    <dd className="font-medium text-neutral-900 dark:text-white" title={date(issue.first_seen)}>
                      {ago(new Date(issue.first_seen).toISOString())}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-neutral-500 dark:text-neutral-400">Last seen</dt>
                    <dd className="font-medium text-neutral-900 dark:text-white" title={date(issue.last_seen)}>
                      {ago(new Date(issue.last_seen).toISOString())}
                    </dd>
                  </div>
                </dl>
              </div>
              <div>
                <div className="flex items-center justify-between bg-neutral-100/80 px-4 py-3 text-sm dark:bg-white/[0.04]">
                  <span className="font-medium text-neutral-900 dark:text-white">Occurrences</span>
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">{rangeLabel(range)}</span>
                </div>
                <dl className="space-y-3 px-4 py-4 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="flex items-center gap-2 text-neutral-700 dark:text-neutral-300">
                      <span className={cn('size-2 rounded-full bg-blue-600 dark:bg-emerald-500')} aria-hidden />
                      <span>{environment || 'All environments'}</span>
                    </dt>
                    <dd>
                      <Link
                        to={excUrl}
                        className="inline-flex items-center gap-1 font-mono font-medium tabular-nums text-neutral-900 hover:underline dark:text-white"
                      >
                        <span>{compact(impact.occurrences)}</span>
                        <ArrowUpRightIcon size={13} className="text-neutral-400" aria-hidden />
                      </Link>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-neutral-500 dark:text-neutral-400">Impacted users</dt>
                    <dd className="font-mono font-medium tabular-nums text-neutral-900 dark:text-white">
                      {compact(impact.users)}
                    </dd>
                  </div>
                </dl>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
