import { useEnvironment } from '@/lib/environment';
import { useProject } from '@/lib/project';
import { useState } from 'react';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button, LinkButton } from '@cloudflare/kumo/components/button';
import { Textarea } from '@cloudflare/kumo/components/input';
import { Tabs } from '@cloudflare/kumo/components/tabs';
import { useKumoToastManager } from '@cloudflare/kumo/components/toast';
import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  BugIcon,
  CheckCircleIcon,
  ClockCounterClockwiseIcon,
  ClockIcon,
  EyeSlashIcon,
  LockSimpleIcon,
  UsersIcon,
  WarningOctagonIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useParams, useSearchParams } from 'react-router-dom';
import Link, { scopedPath } from '@/components/ScopedLink';
import { Empty, ErrorState, FilterBar, Loading, PageHeader, PaginationBar, Panel, SearchBox, Stat, TimeAgo, useRowNavigate } from '@/components/common';
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
  const { environment } = useEnvironment();
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
    <>
      <PageHeader
        title="Issues"
        subtitle={`Unhandled exceptions ${environment ? `in ${environment} ` : ''}over the ${rangeLabel(range)}`}
      />

      <FilterBar>
        <Tabs
          variant="segmented"
          size="sm"
          value={status}
          onValueChange={(value) => update({ status: value, offset: null })}
          tabs={[...statuses, 'all'].map((value) => ({ value, label: statusLabel(value) }))}
        />
        <SearchBox value={q} onChange={(value) => update({ q: value || null, offset: null })} placeholder="Search exception class or message…" className="min-w-64 flex-1" />
        {hasFilters && (
          <Button variant="ghost" size="sm" icon={XIcon} onClick={() => update({ q: null, status: 'open', offset: null })}>
            Clear
          </Button>
        )}
      </FilterBar>

      <Panel fetching={!loading && fetching}>
        {error ? (
          <ErrorState error={error} />
        ) : loading || !data ? (
          <Loading />
        ) : !data.data.length ? (
          <Empty
            icon={
              !USING_MOCK && !hasFilters ? (
                <CheckCircleIcon size={32} className="text-kumo-success" />
              ) : (
                <WarningOctagonIcon size={32} className="text-kumo-subtle" />
              )
            }
            action={hasFilters && !USING_MOCK ? <Button variant="secondary" size="sm" onClick={() => update({ q: null, status: 'open', offset: null })}>Reset filters</Button> : undefined}
          >
            {USING_MOCK ? 'Issue lifecycle data is available when connected to your API.' : 'No issues match these filters.'}
          </Empty>
        ) : (
          <ul className="divide-y divide-kumo-hairline">
            {data.data.map((issue) => {
              const { short, namespace } = splitClassName(issue.class);
              const target = `/issues/${issue.group_hash}`;
              return (
                /* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard navigation is provided by the inner Link */
                <li
                  key={issue.group_hash}
                  onClick={rowNav(target)}
                  className="cursor-pointer px-6 py-5 transition-colors hover:bg-kumo-tint/50"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-2.5">
                      <Badge variant={statusVariant(issue.status)}>{statusLabel(issue.status)}</Badge>
                      <Link className="truncate font-mono text-sm font-semibold text-kumo-link hover:underline" to={target}>
                        {short}
                      </Link>
                      {namespace && <span className="truncate font-mono text-xs text-kumo-subtle">{namespace}</span>}
                    </div>
                    <div className="flex shrink-0 items-center gap-3 text-xs text-kumo-subtle">
                      <span>First seen <TimeAgo iso={new Date(issue.first_seen).toISOString()} /></span>
                      <span>·</span>
                      <span>Last seen <TimeAgo iso={new Date(issue.last_seen).toISOString()} /></span>
                    </div>
                  </div>
                  <p className="mt-2 break-words text-sm leading-relaxed text-kumo-default">{issue.message}</p>
                </li>
              );
            })}
          </ul>
        )}
        <PaginationBar
          status={data ? `${data.data.length} issue${data.data.length === 1 ? '' : 's'} on this page` : undefined}
          onPrevious={() => update({ offset: offset <= 50 ? null : String(offset - 50) })}
          previousDisabled={offset === 0 || fetching}
          onNext={() => update({ offset: String(data?.next_offset ?? 0) })}
          nextDisabled={fetching || data?.next_offset == null}
        />
      </Panel>
    </>
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
            icon={<WarningOctagonIcon size={32} className="text-kumo-subtle" />}
            description="This issue does not exist in the selected project."
          >
            Issue not found.
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
        title={<span className="font-mono text-kumo-danger">{short}</span>}
        subtitle={
          <div className="mt-1.5 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <Badge variant={statusVariant(issue.status)}>{statusLabel(issue.status)}</Badge>
              {namespace && <span className="font-mono text-xs text-kumo-subtle">{namespace}</span>}
            </div>
            <div className="text-sm text-kumo-default">{issue.message}</div>
          </div>
        }
        back={{ to: '/issues', label: 'Issues' }}
        actions={
          <LinkButton href={scopedPath(`/exceptions/${group}`, projectId, range, environment)} variant="secondary" size="sm" icon={ArrowSquareOutIcon}>
            Stack trace & occurrences
          </LinkButton>
        }
      />

      <section className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Retained occurrences" icon={<BugIcon size={14} />} value={compact(impact.occurrences)} tone={impact.occurrences > 0 ? 'bad' : 'default'} hint="In selected environment" />
        <Stat label="Identified users" icon={<UsersIcon size={14} />} value={compact(impact.users)} hint="In selected environment" />
        <Stat label="First seen" icon={<ClockIcon size={14} />} value={ago(new Date(issue.first_seen).toISOString())} hint={date(issue.first_seen)} />
        <Stat label="Last seen" icon={<ClockIcon size={14} />} value={ago(new Date(issue.last_seen).toISOString())} hint={date(issue.last_seen)} />
      </section>

      <Panel title="Triage status">
        <div className="space-y-5 p-6 text-sm">
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
                  <span className="text-xs text-kumo-subtle">Quick notes:</span>
                  {QUICK_REASONS.map((preset) => (
                    <Button key={preset} type="button" size="xs" variant="secondary" onClick={() => setReason(preset)}>
                      {preset}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
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
            <p className="flex items-center gap-2 rounded-xl border border-kumo-hairline bg-kumo-elevated/60 px-4 py-3 text-xs text-kumo-subtle">
              <LockSimpleIcon size={14} className="shrink-0" aria-hidden />
              <span>An admin account is required to change issue status.</span>
            </p>
          ) : null}
          {mutationError && <ErrorState error={mutationError} />}
        </div>
      </Panel>

      <Panel fetching={!loading && fetching} title={`Change history (${changes.length})`}>
        {!changes.length ? (
          <Empty icon={<ClockCounterClockwiseIcon size={32} className="text-kumo-subtle" />}>No status changes recorded.</Empty>
        ) : (
          <ol className="divide-y divide-kumo-hairline">
            {changes.map((entry) => (
              <li className="px-6 py-4.5 text-sm" key={entry.id}>
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
  );
}
