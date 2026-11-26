import { useEnvironment } from '@/lib/environment';
import { useProject } from '@/lib/project';
import { useState } from 'react';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button, LinkButton } from '@cloudflare/kumo/components/button';
import { Textarea } from '@cloudflare/kumo/components/input';
import { Table } from '@cloudflare/kumo/components/table';
import { Tabs } from '@cloudflare/kumo/components/tabs';
import { useKumoToastManager } from '@cloudflare/kumo/components/toast';
import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  ArrowUpRightIcon,
  CheckCircleIcon,
  ClockCounterClockwiseIcon,
  EyeSlashIcon,
  LockSimpleIcon,
  WarningOctagonIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useParams, useSearchParams } from 'react-router-dom';
import Link, { scopedPath } from '@/components/ScopedLink';
import { Empty, ErrorState, FloatingTablePanel, Loading, PageHeader, PaginationBar, Panel, SearchBox, TimeAgo, useRowNavigate } from '@/components/common';
import { api, USING_MOCK, useAsync } from '@/lib/api';
import { ago, compact } from '@/lib/format';
import { useRange, rangeLabel } from '@/lib/range';
import { splitClassName } from '@/lib/ui-helpers';
import type { IssueStatus } from '@/lib/types';

const QUICK_REASONS = ['Fixed in latest deploy', 'Transient upstream error', 'Expected behavior'] as const;

const statuses: IssueStatus[] = ['open', 'resolved', 'ignored'];
const date = (value: number) => new Date(value).toLocaleString();
const statusVariant = (status: IssueStatus): 'error' | 'success' | 'secondary' =>
  status === 'open' ? 'error' : status === 'resolved' ? 'success' : 'secondary';
const statusLabel = (status: string) =>
  status === 'all' ? 'All' : status.charAt(0).toUpperCase() + status.slice(1);

export default function IssuesPage() {
  const { range } = useRange();
  const rowNav = useRowNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'open';
  const q = params.get('q') ?? '';
  const offset = Number(params.get('offset')) || 0;
  const { data, error, loading, fetching } = useAsync(() => api.issues(range, status, q, offset), [range, status, q, offset], { keepPreviousData: true });
  const update = (patch: Record<string, string | null>) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    return next;
  });

  const hasFilters = Boolean(q.trim() || status !== 'open');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Issues"
        actions={
          <>
            <SearchBox value={q} onChange={(value) => update({ q: value || null, offset: null })} placeholder="Search" className="w-44 sm:w-56" />
            <Tabs
              variant="segmented"
              size="sm"
              value={status}
              onValueChange={(value) => update({ status: value, offset: null })}
              tabs={[...statuses, 'all'].map((value) => ({ value, label: statusLabel(value) }))}
            />
            {hasFilters && (
              <Button variant="ghost" size="sm" icon={XIcon} onClick={() => update({ q: null, status: 'open', offset: null })}>
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
      ) : !data.data.length ? (
        <Empty
          description={USING_MOCK ? 'Connect your API to manage issue lifecycle' : 'Try adjusting any filters or time range'}
          action={hasFilters && !USING_MOCK ? <Button variant="secondary" size="sm" onClick={() => update({ q: null, status: 'open', offset: null })}>Reset filters</Button> : undefined}
        >
          {USING_MOCK ? 'Issue tracking requires live API' : 'No issues found'}
        </Empty>
      ) : (
        <FloatingTablePanel
          fetching={!loading && fetching}
          footer={
            <PaginationBar
              status={`${data.data.length} issue${data.data.length === 1 ? '' : 's'} on this page`}
              onPrevious={() => update({ offset: offset <= 50 ? null : String(offset - 50) })}
              previousDisabled={offset === 0 || fetching}
              onNext={() => update({ offset: String(data?.next_offset ?? 0) })}
              nextDisabled={fetching || data?.next_offset == null}
            />
          }
        >
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Status</Table.Head>
                <Table.Head>Issue</Table.Head>
                <Table.Head className="text-right">First seen</Table.Head>
                <Table.Head className="text-right">Last seen</Table.Head>
                <Table.Head className="w-12 text-right" />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.data.map((issue) => {
                const { short, namespace } = splitClassName(issue.class);
                const target = `/issues/${issue.group_hash}`;
                return (
                  <Table.Row
                    key={issue.group_hash}
                    onClick={rowNav(target)}
                    className="group cursor-pointer"
                  >
                    <Table.Cell>
                      <Badge variant={statusVariant(issue.status)}>{statusLabel(issue.status)}</Badge>
                    </Table.Cell>
                    <Table.Cell className="max-w-xl whitespace-normal">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <Link className="font-mono text-sm font-semibold text-neutral-900 hover:underline dark:text-white" to={target}>
                          {short}
                        </Link>
                        {namespace && <span className="truncate font-mono text-xs text-kumo-subtle">{namespace}</span>}
                      </div>
                      <p title={issue.message} className="mt-1 truncate text-xs text-kumo-subtle">{issue.message}</p>
                    </Table.Cell>
                    <Table.Cell className="text-right text-xs">
                      <TimeAgo iso={new Date(issue.first_seen).toISOString()} />
                    </Table.Cell>
                    <Table.Cell className="text-right text-xs">
                      <TimeAgo iso={new Date(issue.last_seen).toISOString()} />
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      <Link
                        to={target}
                        aria-label={`Open ${short}`}
                        className="inline-grid size-7 place-items-center rounded-md border border-neutral-200 bg-white text-neutral-500 transition-colors group-hover:border-blue-500 group-hover:text-blue-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-neutral-400 dark:group-hover:border-white/20 dark:group-hover:text-white"
                      >
                        <ArrowUpRightIcon size={14} aria-hidden />
                      </Link>
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
      <>
        <PageHeader back={{ to: '/issues', label: 'Issues' }} title="Issue not found" />
        <Panel>
          <Empty
            icon={<WarningOctagonIcon size={16} />}
            description="This issue does not exist in the selected project"
          >
            Issue not found
          </Empty>
        </Panel>
      </>
    );
  }

  const { issue, impact, changes } = data;
  const { short, namespace } = splitClassName(issue.class);

  return (
    <div className="space-y-6">
      <PageHeader
        documentTitle={short}
        title={
          <span className="flex flex-wrap items-center gap-2.5">
            <span className="font-mono text-neutral-900 dark:text-white">{short}</span>
            <span className="inline-flex items-center rounded bg-rose-600 px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-white">
              Unhandled
            </span>
          </span>
        }
        subtitle={
          <div className="mt-1 space-y-1">
            {namespace && <div className="font-mono text-xs text-kumo-subtle">{namespace}</div>}
            <div className="text-sm text-kumo-default">{issue.message}</div>
          </div>
        }
        back={{ to: '/issues', label: 'Issues' }}
      />

      {/* Capture-inspired 2-column detail + Manage/Details/Occurrences sidebar */}
      <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
        <div className="min-w-0 flex-1 space-y-6">
          <Panel title="Triage status">
            <div className="space-y-4 p-5 text-sm">
              <p className="max-w-3xl text-xs leading-relaxed text-kumo-subtle">
                Resolved issues reopen automatically if a new occurrence arrives; ignored issues stay ignored. Status changes apply across all environments in this project.
              </p>
              {permissions.loading && !permissions.data ? (
                <Loading rows={2} />
              ) : permissions.data?.can_manage ? (
                <form className="max-w-2xl space-y-4" onSubmit={(event) => event.preventDefault()}>
                  <div className="space-y-2.5">
                    <Textarea
                      label="Triage note"
                      placeholder="Add a short note explaining why you are resolving, ignoring, or reopening…"
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      maxLength={500}
                      rows={2}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[11px] uppercase tracking-wider text-kumo-subtle">Quick notes:</span>
                      {QUICK_REASONS.map((preset) => (
                        <Button key={preset} type="button" size="xs" variant="secondary" onClick={() => setReason(preset)}>
                          {preset}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2.5">
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
                    {!reason.trim() && (
                      <span className="text-xs text-kumo-subtle">Enter a note or pick a quick note above to update status.</span>
                    )}
                  </div>
                </form>
              ) : permissions.data ? (
                <p className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs text-kumo-subtle dark:border-white/[0.08] dark:bg-white/[0.03]">
                  <LockSimpleIcon size={14} className="shrink-0" aria-hidden />
                  <span>An admin account is required to change issue status.</span>
                </p>
              ) : null}
              {mutationError && <ErrorState error={mutationError} />}
            </div>
          </Panel>

          <Panel fetching={!loading && fetching} title={`Change history (${changes.length})`}>
            {!changes.length ? (
              <Empty variant="clean" icon={<ClockCounterClockwiseIcon size={26} className="text-kumo-subtle" />}>
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

        {/* Right-hand Manage / Details / Occurrences card matching capture */}
        <aside className="w-full shrink-0 space-y-3 xl:w-80">
          <Panel>
            <div className="divide-y divide-neutral-200/80 text-sm dark:divide-white/[0.06]">
              <div>
                <div className="bg-neutral-50/90 px-4 py-2.5 text-xs font-semibold text-neutral-900 dark:bg-white/[0.03] dark:text-white">
                  Manage
                </div>
                <dl className="space-y-3 px-4 py-3.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-kumo-subtle">Status</dt>
                    <dd><Badge variant={statusVariant(issue.status)}>{statusLabel(issue.status)}</Badge></dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-kumo-subtle">Environment</dt>
                    <dd className="flex items-center gap-1.5 font-medium text-kumo-strong">
                      <span className="size-2 rounded-full bg-blue-600 dark:bg-emerald-500" aria-hidden />
                      <span>{environment || 'All environments'}</span>
                    </dd>
                  </div>
                </dl>
              </div>
              <div>
                <div className="bg-neutral-50/90 px-4 py-2.5 text-xs font-semibold text-neutral-900 dark:bg-white/[0.03] dark:text-white">
                  Details
                </div>
                <dl className="space-y-3 px-4 py-3.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-kumo-subtle">First seen</dt>
                    <dd className="font-mono text-kumo-strong" title={date(issue.first_seen)}>{ago(new Date(issue.first_seen).toISOString())}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-kumo-subtle">Last seen</dt>
                    <dd className="font-mono text-kumo-strong" title={date(issue.last_seen)}>{ago(new Date(issue.last_seen).toISOString())}</dd>
                  </div>
                </dl>
              </div>
              <div>
                <div className="flex items-center justify-between bg-neutral-50/90 px-4 py-2.5 text-xs dark:bg-white/[0.03]">
                  <span className="font-semibold text-neutral-900 dark:text-white">Occurrences</span>
                  <span className="text-kumo-subtle">{rangeLabel(range)}</span>
                </div>
                <dl className="space-y-3 px-4 py-3.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-kumo-subtle">Retained events</dt>
                    <dd className="font-mono font-semibold tabular-nums text-kumo-danger">{compact(impact.occurrences)}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-kumo-subtle">Identified users</dt>
                    <dd className="font-mono font-medium tabular-nums text-kumo-strong">{compact(impact.users)}</dd>
                  </div>
                </dl>
              </div>
            </div>
          </Panel>
          <LinkButton
            href={scopedPath(`/exceptions/${group}`, projectId, range, environment)}
            variant="secondary"
            size="sm"
            icon={ArrowSquareOutIcon}
            className="w-full justify-center"
          >
            Stack trace & occurrences
          </LinkButton>
        </aside>
      </div>
    </div>
  );
}
