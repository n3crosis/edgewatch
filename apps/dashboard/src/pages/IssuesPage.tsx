import { useEnvironment } from '@/lib/environment';
import { useProject } from '@/lib/project';
import { useState } from 'react';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button, LinkButton } from '@cloudflare/kumo/components/button';
import { Textarea } from '@cloudflare/kumo/components/input';
import { Tabs } from '@cloudflare/kumo/components/tabs';
import { ArrowSquareOutIcon, XIcon } from '@phosphor-icons/react';
import { useParams, useSearchParams } from 'react-router-dom';
import Link, { scopedPath } from '@/components/ScopedLink';
import { Empty, ErrorState, FilterBar, Loading, PageHeader, PaginationBar, Panel, SearchBox, Stat, TimeAgo } from '@/components/common';
import { api, USING_MOCK, useAsync } from '@/lib/api';
import { ago, compact } from '@/lib/format';
import { useRange, rangeLabel } from '@/lib/range';
import type { IssueStatus } from '@/lib/types';

const statuses: IssueStatus[] = ['open', 'resolved', 'ignored'];
const date = (value: number) => new Date(value).toLocaleString();
const statusVariant = (status: IssueStatus): 'error' | 'success' | 'secondary' =>
  status === 'open' ? 'error' : status === 'resolved' ? 'success' : 'secondary';
const statusLabel = (status: string) =>
  status === 'all' ? 'All' : status.charAt(0).toUpperCase() + status.slice(1);

export default function IssuesPage() {
  const { range } = useRange();
  const { environment } = useEnvironment();
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
        subtitle={`${environment ? 'Groups with retained occurrences in this environment during the' : 'Unhandled exception groups last seen within the'} ${rangeLabel(range)}. Resolved issues reopen on a new occurrence; ignored issues stay ignored.`}
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
          <Empty action={hasFilters && !USING_MOCK ? <Button variant="secondary" size="sm" onClick={() => update({ q: null, status: 'open', offset: null })}>Reset filters</Button> : undefined}>
            {USING_MOCK ? 'Issue lifecycle data is available when connected to your API.' : 'No issues match these filters.'}
          </Empty>
        ) : (
          <ul className="divide-y divide-kumo-hairline">
            {data.data.map((issue) => (
              <li key={issue.group_hash} className="px-6 py-5 transition-colors hover:bg-kumo-tint/50">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Badge variant={statusVariant(issue.status)}>{statusLabel(issue.status)}</Badge>
                    <Link className="truncate font-mono text-xs font-medium text-kumo-link hover:underline" to={`/issues/${issue.group_hash}`}>
                      {issue.class}
                    </Link>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-xs text-kumo-subtle">
                    <span>First seen <TimeAgo iso={new Date(issue.first_seen).toISOString()} /></span>
                    <span>·</span>
                    <span>Last seen <TimeAgo iso={new Date(issue.last_seen).toISOString()} /></span>
                  </div>
                </div>
                <p className="mt-2 break-words text-sm leading-relaxed text-kumo-default">{issue.message}</p>
              </li>
            ))}
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
  const [revision, refresh] = useState(0);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<Error | null>(null);
  const { data, error, loading } = useAsync(() => api.issue(group), [group, revision]);
  const permissions = useAsync(() => api.permissions(), []);

  async function change(status: IssueStatus) {
    if (!data || busy) return;
    setBusy(true);
    setMutationError(null);
    try {
      await api.updateIssue(group, status, data.issue.status, data.issue.revision, reason);
      setReason('');
      refresh((value) => value + 1);
    } catch (err) {
      setMutationError(err instanceof Error ? err : new Error(String(err)));
      refresh((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorState error={error} />;
  if (loading) return <Loading />;
  if (!data) return <Empty>Issue not found.</Empty>;

  const { issue, impact, changes } = data;
  return (
    <div className="space-y-6">
      <PageHeader
        documentTitle={issue.class.split('\\').pop() || issue.class}
        title={<span className="font-mono text-kumo-danger">{issue.class}</span>}
        subtitle={
          <span className="mt-1.5 flex flex-wrap items-center gap-2.5">
            <Badge variant={statusVariant(issue.status)}>{statusLabel(issue.status)}</Badge>
            <span className="text-kumo-default">{issue.message}</span>
          </span>
        }
        back={{ to: '/issues', label: 'Issues' }}
        actions={
          <LinkButton href={scopedPath(`/exceptions/${group}`, projectId, range, environment)} variant="secondary" size="sm" icon={ArrowSquareOutIcon}>
            Stack trace & occurrences
          </LinkButton>
        }
      />

      <section className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Retained occurrences" value={compact(impact.occurrences)} tone={impact.occurrences > 0 ? 'bad' : 'default'} hint="In selected environment" />
        <Stat label="Identified users" value={compact(impact.users)} hint="In selected environment" />
        <Stat label="First seen" value={ago(new Date(issue.first_seen).toISOString())} hint={date(issue.first_seen)} />
        <Stat label="Last seen" value={ago(new Date(issue.last_seen).toISOString())} hint={date(issue.last_seen)} />
      </section>

      <Panel title="Triage status">
        <div className="space-y-5 p-6 text-sm">
          <p className="max-w-3xl text-xs leading-relaxed text-kumo-subtle">
            Status changes and lifecycle history apply to all environments in this project. Impact counts decrease as event retention expires, while issue history persists.
          </p>
          {permissions.data?.can_manage ? (
            <form className="max-w-2xl space-y-4" onSubmit={(event) => event.preventDefault()}>
              <Textarea
                label="Reason for change"
                placeholder="Describe why this issue is being resolved, ignored, or reopened…"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
                rows={3}
              />
              <div className="flex flex-wrap gap-2.5">
                {statuses.filter((s) => s !== issue.status).map((s) => (
                  <Button
                    key={s}
                    size="sm"
                    variant={s === 'resolved' ? 'primary' : 'secondary'}
                    disabled={busy || !reason.trim()}
                    loading={busy}
                    onClick={() => void change(s)}
                  >
                    {s === 'open' ? 'Reopen' : s === 'resolved' ? 'Resolve' : 'Ignore'}
                  </Button>
                ))}
              </div>
            </form>
          ) : (
            <p className="rounded-xl border border-kumo-hairline bg-kumo-elevated/60 px-4 py-3 text-xs text-kumo-subtle">
              An admin account is required to change issue status.
            </p>
          )}
          {mutationError && <ErrorState error={mutationError} />}
        </div>
      </Panel>

      <Panel title={`Change history (${changes.length})`}>
        {!changes.length ? (
          <Empty>No status changes recorded.</Empty>
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
