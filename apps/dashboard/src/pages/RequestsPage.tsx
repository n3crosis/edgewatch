import { withUser } from '@/lib/user-activity';
import UserFilter from '@/components/UserFilter';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { InputGroup } from '@cloudflare/kumo/components/input-group';
import { Select } from '@cloudflare/kumo/components/select';
import { Table } from '@cloudflare/kumo/components/table';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { ArrowsLeftRightIcon, TimerIcon, WarningCircleIcon, XIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Link from '@/components/ScopedLink';
import { BarChart, LineChart, Legend } from '@/components/charts';
import { Empty, ErrorState, FilterBar, Loading, MethodBadge, PageHeader, PaginationBar, Panel, SearchBox, StatusBadge, TimeAgo, useRowNavigate } from '@/components/common';
import { api, useAsync } from '@/lib/api';
import { bucketTime, compact, ms } from '@/lib/format';
import type { RequestGroup, TraceFilters } from '@/lib/types';
import { useRange, rangeLabel } from '@/lib/range';

function StatusMix({ row }: { row: RequestGroup }) {
  const total = Math.max(1, row.requests);
  const segments = [
    { count: row.status_2xx, label: '2xx', color: 'bg-kumo-success' },
    { count: row.status_3xx, label: '3xx', color: 'bg-kumo-info' },
    { count: row.status_4xx, label: '4xx', color: 'bg-kumo-warning' },
    { count: row.status_5xx, label: '5xx', color: 'bg-kumo-danger' },
    { count: row.status_other, label: 'other', color: 'bg-kumo-interact' },
  ].filter((s) => s.count > 0);

  return (
    <Tooltip
      asChild
      content={segments.map((s) => `${s.label}: ${s.count.toLocaleString()}`).join(' · ') || 'No responses'}
    >
      <div className="space-y-1.5">
        <div className="flex h-2 w-28 overflow-hidden rounded-full bg-kumo-fill">
          {segments.map((s) => (
            <div key={s.label} className={s.color} style={{ width: `${(s.count / total) * 100}%` }} />
          ))}
        </div>
        <div className="flex items-center gap-2.5 text-[11px] tabular-nums text-kumo-subtle">
          {row.status_2xx > 0 && <span>2xx {compact(row.status_2xx)}</span>}
          {row.status_3xx > 0 && <span className="text-kumo-info">3xx {compact(row.status_3xx)}</span>}
          {row.status_4xx > 0 && <span className="text-kumo-warning">4xx {compact(row.status_4xx)}</span>}
          {row.status_5xx > 0 && <span className="font-medium text-kumo-danger">5xx {compact(row.status_5xx)}</span>}
        </div>
      </div>
    </Tooltip>
  );
}

export default function RequestsPage() {
  const { range } = useRange();
  const rowNav = useRowNavigate();
  const [params, setParams] = useSearchParams();
  const user = params.get('user') || undefined;
  const route = params.get('route');
  const routeKind = (params.get('route_kind') ?? (route === '[unnamed]' ? 'unknown' : 'name')) as TraceFilters['route_kind'];
  const method = params.get('method') ?? undefined;
  const status = (params.get('status') ?? 'all') as TraceFilters['status'];
  const minimumDuration = params.get('min_duration_ms') ?? '';
  const q = params.get('q') ?? '';
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const cursor = params.get('cursor');

  const [minDraft, setMinDraft] = useState(minimumDuration);
  const minTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setMinDraft(minimumDuration), [minimumDuration]);
  useEffect(() => () => { if (minTimer.current) clearTimeout(minTimer.current); }, []);

  const groups = useAsync(() => route === null ? api.requests(range, q, offset, user) : Promise.resolve(null), [route, range, q, offset, user], { keepPreviousData: true });
  const occurrences = useAsync(() => route !== null ? api.traces({ source: 'request', user, route, route_kind: routeKind, method, range, status, min_duration_ms: minimumDuration || undefined }, cursor) : Promise.resolve(null), [route, routeKind, method, range, status, minimumDuration, cursor, user], { keepPreviousData: true });
  const trend = useAsync(() => route === null ? Promise.resolve(null) : api.requestTrend({ user, route, route_kind: routeKind, method, range, status, min_duration_ms: minimumDuration || undefined }), [route, routeKind, method, range, status, minimumDuration, user], { keepPreviousData: true });

  const update = (patch: Record<string, string | null>) => setParams((current) => {
    const next = new URLSearchParams(current);
    for (const [key, value] of Object.entries(patch)) value === null ? next.delete(key) : next.set(key, value);
    return next;
  });

  const commitMin = (val: string, immediate = false) => {
    setMinDraft(val);
    if (minTimer.current) clearTimeout(minTimer.current);
    if (immediate) update({ min_duration_ms: val || null, cursor: null });
    else minTimer.current = setTimeout(() => update({ min_duration_ms: val || null, cursor: null }), 180);
  };

  const hasListFilters = Boolean(q || user);
  const hasDetailFilters = status !== 'all' || Boolean(minimumDuration) || Boolean(user);

  return (
    <>
      <PageHeader
        back={route !== null ? { to: withUser('/requests', user), label: 'All routes' } : undefined}
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
        subtitle={route === null ? `HTTP routes over the ${rangeLabel(range)} — click any route to see latency trends and executions` : `Executions for this route over the ${rangeLabel(range)}`}
      />

      <FilterBar>
        {route === null ? (
          <SearchBox value={q} onChange={(value) => update({ q: value || null, offset: null })} placeholder="Search route name or method…" className="min-w-64 flex-1" />
        ) : (
          <>
            <Select
              aria-label="HTTP status"
              className="w-40"
              value={status}
              onValueChange={(value) => update({ status: value === 'all' ? null : String(value ?? 'all'), cursor: null })}
              items={['all', '2xx', '3xx', '4xx', '5xx'].map((value) => ({ value, label: value === 'all' ? 'Any HTTP status' : value }))}
            />
            <InputGroup className="w-40">
              <InputGroup.Addon align="start"><TimerIcon className="text-kumo-subtle" /></InputGroup.Addon>
              <InputGroup.Input
                type="number"
                min="0"
                step="any"
                placeholder="Min ms"
                aria-label="Minimum duration (ms)"
                value={minDraft}
                onChange={(event) => commitMin(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitMin(minDraft, true);
                  else if (event.key === 'Escape' && minDraft) commitMin('', true);
                }}
              />
              {minDraft && (
                <InputGroup.Addon align="end">
                  <button
                    type="button"
                    onClick={() => commitMin('', true)}
                    aria-label="Clear minimum duration"
                    className="grid size-5 place-items-center rounded text-kumo-subtle transition-colors hover:text-kumo-strong"
                  >
                    <XIcon size={12} />
                  </button>
                </InputGroup.Addon>
              )}
            </InputGroup>
            <Button
              variant={status === '5xx' ? 'primary' : 'secondary'}
              size="sm"
              icon={WarningCircleIcon}
              onClick={() => update({ status: status === '5xx' ? null : '5xx', cursor: null })}
            >
              Errors (5xx)
            </Button>
            <Button
              variant={minimumDuration === '500' ? 'primary' : 'secondary'}
              size="sm"
              icon={TimerIcon}
              onClick={() => commitMin(minimumDuration === '500' ? '' : '500', true)}
            >
              Slow (&gt;500ms)
            </Button>
          </>
        )}
        <UserFilter />
        {route === null && hasListFilters && (
          <Button variant="ghost" size="sm" icon={XIcon} onClick={() => update({ q: null, user: null, offset: null })}>
            Clear
          </Button>
        )}
        {route !== null && hasDetailFilters && (
          <Button variant="ghost" size="sm" icon={XIcon} onClick={() => update({ status: null, min_duration_ms: null, user: null, cursor: null })}>
            Clear
          </Button>
        )}
      </FilterBar>

      {route !== null && (
        <div className="mb-6">
          {trend.error ? (
            <ErrorState error={trend.error} />
          ) : trend.loading || !trend.data ? (
            <Loading rows={3} />
          ) : (
            <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-2">
              <Panel
                fetching={!trend.loading && trend.fetching}
                title="Matching requests & 5xx errors"
                actions={<Legend items={[{ label: 'Requests', className: 'bg-kumo-brand/65' }, { label: '5xx', className: 'bg-kumo-danger' }]} />}
              >
                <div className="p-6">
                  <BarChart series={trend.data.series.map((point) => ({ label: bucketTime(point.ts, range), value: point.requests, highlight: point.errors }))} />
                </div>
              </Panel>
              <Panel
                fetching={!trend.loading && trend.fetching}
                title="p95 latency of matching requests"
                actions={<span className="text-xs tabular-nums text-kumo-subtle">peak {ms(Math.max(0, ...trend.data.series.map((p) => p.p95_ms)))}</span>}
              >
                <div className="p-6">
                  <LineChart values={trend.data.series.map((point) => point.p95_ms)} labels={trend.data.series.map((point) => bucketTime(point.ts, range))} format={ms} />
                </div>
              </Panel>
            </div>
          )}
        </div>
      )}

      <Panel
        title={route !== null ? 'Matching executions' : undefined}
        fetching={route === null ? !groups.loading && groups.fetching : !occurrences.loading && occurrences.fetching}
      >
        {route === null ? (
          groups.error ? (
            <ErrorState error={groups.error} />
          ) : groups.loading || !groups.data ? (
            <Loading />
          ) : groups.data.data.length === 0 ? (
            <Empty
              icon={<ArrowsLeftRightIcon size={32} className="text-kumo-subtle" />}
              action={hasListFilters ? <Button variant="secondary" size="sm" onClick={() => update({ q: null, user: null, offset: null })}>Clear filters</Button> : undefined}
            >
              No requests match this window.
            </Empty>
          ) : (
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Route</Table.Head>
                  <Table.Head>Status distribution</Table.Head>
                  <Table.Head className="text-right">Requests</Table.Head>
                  <Table.Head className="text-right">Avg</Table.Head>
                  <Table.Head className="text-right">p95</Table.Head>
                  <Table.Head className="text-right">5xx</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {groups.data.data.map((r) => {
                  const target = withUser(`/requests?${new URLSearchParams({ route: r.route, route_kind: r.route_kind, method: r.method })}`, user);
                  return (
                    <Table.Row key={JSON.stringify([r.method, r.route_kind, r.route])} onClick={rowNav(target)} className="cursor-pointer transition-colors hover:bg-kumo-tint/50">
                      <Table.Cell className="max-w-lg">
                        <div className="flex items-center gap-2.5">
                          <MethodBadge method={r.method} />
                          <Link title={r.route} className="truncate font-mono text-xs text-kumo-link hover:underline" to={target}>
                            {r.route}
                          </Link>
                          {r.route_kind === 'unknown' && (
                            <Badge variant="outline" className="shrink-0">unmatched</Badge>
                          )}
                        </div>
                      </Table.Cell>
                      <Table.Cell><StatusMix row={r} /></Table.Cell>
                      <Table.Cell className="text-right font-medium tabular-nums">{compact(r.requests)}</Table.Cell>
                      <Table.Cell className="text-right font-mono text-xs tabular-nums text-kumo-subtle">{ms(r.avg_ms)}</Table.Cell>
                      <Table.Cell className={`text-right font-mono text-xs tabular-nums ${r.p95_ms !== null && r.p95_ms > 500 ? 'font-medium text-kumo-warning' : ''}`}>
                        {r.p95_ms === null ? '—' : ms(r.p95_ms)}
                      </Table.Cell>
                      <Table.Cell className={`text-right font-mono text-xs tabular-nums ${r.status_5xx > 0 ? 'font-medium text-kumo-danger' : 'text-kumo-subtle'}`}>
                        {compact(r.status_5xx)}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          )
        ) : occurrences.error ? (
          <ErrorState error={occurrences.error} />
        ) : occurrences.loading || !occurrences.data ? (
          <Loading />
        ) : occurrences.data.data.length === 0 ? (
          <Empty
            icon={<ArrowsLeftRightIcon size={32} className="text-kumo-subtle" />}
            action={hasDetailFilters ? <Button variant="secondary" size="sm" onClick={() => update({ status: null, min_duration_ms: null, user: null, cursor: null })}>Clear filters</Button> : undefined}
          >
            No executions in this window.
          </Empty>
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>When</Table.Head>
                <Table.Head>Execution</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head className="text-right">Duration</Table.Head>
                <Table.Head>User</Table.Head>
                <Table.Head>Server</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {occurrences.data.data.map((t) => (
                <Table.Row key={t.trace_id} onClick={rowNav(`/traces/${t.trace_id}`)} className="cursor-pointer transition-colors hover:bg-kumo-tint/50">
                  <Table.Cell className="text-xs"><TimeAgo iso={t.timestamp} /></Table.Cell>
                  <Table.Cell className="max-w-md truncate font-mono text-xs">
                    <Link className="text-kumo-link hover:underline" to={`/traces/${t.trace_id}`}>{t.name}</Link>
                  </Table.Cell>
                  <Table.Cell><StatusBadge status={t.status_code} source={t.execution_source} /></Table.Cell>
                  <Table.Cell className={`text-right font-mono text-xs tabular-nums ${t.duration_ms > 500 ? 'font-medium text-kumo-warning' : ''}`}>
                    {ms(t.duration_ms)}
                  </Table.Cell>
                  <Table.Cell className="font-mono text-xs text-kumo-subtle">{t.user ? `#${t.user}` : '—'}</Table.Cell>
                  <Table.Cell className="font-mono text-xs text-kumo-subtle">{t.server}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
        {route === null ? (
          <PaginationBar
            status={groups.data ? `${groups.data.data.length} route${groups.data.data.length === 1 ? '' : 's'} on this page` : undefined}
            onPrevious={() => update({ offset: String(Math.max(0, offset - 50)) })}
            previousDisabled={offset === 0 || groups.fetching}
            onNext={() => update({ offset: String(groups.data?.next_offset ?? 0) })}
            nextDisabled={groups.fetching || !!groups.error || groups.data?.next_offset == null}
          />
        ) : (
          <PaginationBar
            status={occurrences.data ? `${occurrences.data.data.length} execution${occurrences.data.data.length === 1 ? '' : 's'}` : undefined}
            onFirst={() => update({ cursor: null })}
            firstDisabled={!cursor || occurrences.fetching}
            onNext={() => update({ cursor: occurrences.data?.next_cursor ?? null })}
            nextDisabled={occurrences.fetching || !!occurrences.error || !occurrences.data?.next_cursor}
          />
        )}
      </Panel>
    </>
  );
}
