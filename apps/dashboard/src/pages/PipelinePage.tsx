import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { Table } from '@cloudflare/kumo/components/table';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import {
  ArrowClockwiseIcon,
  ChartLineIcon,
  CheckCircleIcon,
  DatabaseIcon,
  InfoIcon,
  LockSimpleIcon,
  QueueIcon,
  TimerIcon,
  WarningCircleIcon,
  WarningOctagonIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useState } from 'react';
import Link from '@/components/ScopedLink';
import { LineChart } from '@/components/charts';
import { Empty, ErrorState, Loading, PageHeader, PageSkeleton, Panel, Stat, TimeAgo, useRowNavigate } from '@/components/common';
import { api, useAsync } from '@/lib/api';
import { ago, bucketTime, compact, ms } from '@/lib/format';

/** Queue lag above this is shown as a warning (the consumer alert default is 10 minutes). */
const LAG_WARN_MS = 60_000;

export default function PipelinePage() {
  const rowNav = useRowNavigate();
  const permissions = useAsync(() => api.permissions(), []);
  const health = useAsync(() => api.pipeline(), [], { keepPreviousData: true });
  const [replayed, setReplayed] = useState(0);
  const dead = useAsync(() => api.deadLetters(), [replayed], { keepPreviousData: true });
  const usage = useAsync(() => api.usage(), [], { keepPreviousData: true });
  const [replay, setReplay] = useState<{ busy: boolean; message: string | null }>({ busy: false, message: null });

  const requestReplay = async () => {
    setReplay({ busy: true, message: null });
    try {
      const { requested } = await api.replayDeadLetters();
      setReplay({ busy: false, message: requested ? `${requested} dead letter(s) queued for replay; the consumer retries them within 5 minutes.` : 'Nothing to replay.' });
      setReplayed((n) => n + 1);
    } catch (e) {
      setReplay({ busy: false, message: e instanceof Error ? e.message : 'Replay request failed.' });
    }
  };

  if (health.error) return <ErrorState error={health.error} />;
  if (health.loading || !health.data) return <PageSkeleton stats={4} />;
  const { consumer, dead_letters: summary, minutes } = health.data;
  const peakLag = Math.max(0, ...minutes.map((m) => m.max_lag_ms));
  const degraded = summary.count > 0 || consumer.max_lag_ms_5m > LAG_WARN_MS;
  const idle = !degraded && consumer.messages_1h === 0;
  const todayUtc = new Date().toISOString().slice(0, 10);
  const usageTotal = usage.data?.reduce((sum, row) => sum + row.records, 0) ?? 0;
  const usageDays = new Set(usage.data?.map((row) => row.day) ?? []).size;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pipeline"
        subtitle="Queue throughput, processing lag, daily usage, and failed deliveries"
        actions={
          <Badge variant={degraded ? 'warning' : idle ? 'secondary' : 'success'}>
            {degraded ? <WarningCircleIcon /> : <CheckCircleIcon />}
            {degraded ? 'Attention needed' : idle ? 'Idle' : 'Healthy'}
          </Badge>
        }
      />

      <section className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Messages (1h)" icon={<QueueIcon size={14} />} value={compact(consumer.messages_1h)} hint={consumer.last_batch_at ? `last batch ${ago(consumer.last_batch_at)}` : 'no batches in the last hour'} />
        <Stat label="Retried (1h)" icon={<ArrowClockwiseIcon size={14} />} value={compact(consumer.retried_1h)} tone={consumer.retried_1h > 0 ? 'warn' : 'good'} />
        <Stat label="Queue lag (5m)" icon={<TimerIcon size={14} />} value={ms(consumer.max_lag_ms_5m)} tone={consumer.max_lag_ms_5m > LAG_WARN_MS ? 'warn' : 'good'} hint={`1h peak ${ms(consumer.max_lag_ms_1h)}`} />
        <Stat
          label="Dead letters"
          icon={<WarningOctagonIcon size={14} />}
          value={compact(summary.count)}
          tone={summary.count > 0 ? 'bad' : 'good'}
          hint={summary.replay_pending ? `${summary.replay_pending} replay pending` : summary.oldest_failed_at ? `oldest ${ago(summary.oldest_failed_at)}` : 'all clear'}
        />
      </section>

      <Panel fetching={!health.loading && health.fetching} title="Queue lag per minute (last hour)" actions={minutes.length > 0 ? <span className="text-xs tabular-nums text-kumo-subtle">peak {ms(peakLag)}</span> : undefined}>
        {minutes.length === 0 ? (
          <Empty icon={<ChartLineIcon size={32} className="text-kumo-subtle" />}>No consumer batches in the last hour.</Empty>
        ) : (
          <div className="p-6">
            <LineChart values={minutes.map((m) => m.max_lag_ms)} labels={minutes.map((m) => bucketTime(m.minute, '1h'))} format={ms} />
          </div>
        )}
      </Panel>

      <Panel
        fetching={!usage.loading && usage.fetching}
        title="Records per day (UTC, last 7 days)"
        actions={
          usageTotal > 0 ? (
            <span className="text-xs tabular-nums text-kumo-subtle">
              {compact(usageTotal)} total{usageDays > 0 ? ` · ${compact(Math.round(usageTotal / usageDays))} / day` : ''}
            </span>
          ) : undefined
        }
      >
        {usage.error ? (
          <ErrorState error={usage.error} />
        ) : usage.loading || !usage.data ? (
          <Loading rows={3} />
        ) : usage.data.length === 0 ? (
          <Empty icon={<DatabaseIcon size={32} className="text-kumo-subtle" />}>No records processed in the last 7 days.</Empty>
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Day</Table.Head>
                <Table.Head>Project</Table.Head>
                <Table.Head className="text-right">Records</Table.Head>
                <Table.Head className="text-right">Daily quota</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {usage.data.map((u) => {
                const ratio = u.quota ? Math.min(1, u.records / u.quota) : null;
                const barColor = u.blocked_at || (ratio !== null && ratio >= 1) ? 'bg-kumo-danger' : ratio !== null && ratio >= 0.8 ? 'bg-kumo-warning' : 'bg-kumo-brand';
                return (
                  <Table.Row key={`${u.day}-${u.project_id}`} className="transition-colors hover:bg-kumo-tint/50">
                    <Table.Cell className="font-mono text-xs tabular-nums text-kumo-subtle">
                      <span className="inline-flex items-center gap-2.5">
                        <span>{u.day}</span>
                        {u.day === todayUtc && <Badge variant="info">Today</Badge>}
                      </span>
                    </Table.Cell>
                    <Table.Cell className="font-mono text-xs">{u.project_id}</Table.Cell>
                    <Table.Cell className="text-right font-medium tabular-nums">{u.records.toLocaleString()}</Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {u.quota ? (
                        <div className="inline-flex items-center justify-end gap-3">
                          <div className="hidden h-2 w-24 overflow-hidden rounded-full bg-kumo-fill sm:block">
                            <div className={`h-full rounded-full ${barColor}`} style={{ width: `${Math.round((ratio ?? 0) * 100)}%` }} />
                          </div>
                          <span className={`text-xs ${u.blocked_at ? 'font-medium text-kumo-danger' : 'text-kumo-subtle'}`}>
                            {u.quota.toLocaleString()}
                            {u.blocked_at ? ' (reached)' : ''}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-kumo-subtle">Unlimited</span>
                      )}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        )}
      </Panel>

      <Panel
        fetching={!dead.loading && dead.fetching}
        title="Dead letters"
        actions={
          <Button
            size="sm"
            variant="secondary"
            icon={ArrowClockwiseIcon}
            loading={replay.busy}
            disabled={replay.busy || !dead.data?.length || !permissions.data?.can_manage}
            onClick={requestReplay}
          >
            Replay all
          </Button>
        }
      >
        {permissions.data && !permissions.data.can_manage && (
          <div className="flex items-center gap-2 border-b border-kumo-hairline bg-kumo-elevated/60 px-6 py-3 text-xs text-kumo-subtle">
            <LockSimpleIcon size={14} className="shrink-0" aria-hidden />
            <span>Replay requires an admin account.</span>
          </div>
        )}
        {replay.message && (
          <div className="flex items-center justify-between gap-3 border-b border-kumo-hairline bg-kumo-info-tint px-6 py-3 text-xs text-kumo-strong" role="status">
            <span className="flex items-center gap-2">
              <InfoIcon size={15} className="shrink-0" aria-hidden />
              <span>{replay.message}</span>
            </span>
            <Button variant="ghost" shape="square" size="xs" icon={XIcon} aria-label="Dismiss message" onClick={() => setReplay((r) => ({ ...r, message: null }))} />
          </div>
        )}
        {dead.error ? (
          <ErrorState error={dead.error} />
        ) : dead.loading || !dead.data ? (
          <Loading rows={3} />
        ) : dead.data.length === 0 ? (
          <Empty icon={<CheckCircleIcon size={32} className="text-kumo-success" />} description="Messages that fail all 20 retries are kept here for inspection and replay.">
            No dead letters
          </Empty>
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Failed</Table.Head>
                <Table.Head>Project</Table.Head>
                <Table.Head>Trace</Table.Head>
                <Table.Head className="text-right">Records</Table.Head>
                <Table.Head>Replay status</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {dead.data.map((d) => (
                <Table.Row
                  key={d.id}
                  onClick={d.trace_id ? rowNav(`/traces/${d.trace_id}`) : undefined}
                  className={`${d.trace_id ? 'cursor-pointer ' : ''}transition-colors hover:bg-kumo-tint/50`}
                >
                  <Table.Cell className="text-xs"><TimeAgo iso={d.failed_at} /></Table.Cell>
                  <Table.Cell className="font-mono text-xs">{d.project_id}</Table.Cell>
                  <Table.Cell className="font-mono text-xs">
                    {d.trace_id ? <Link className="text-kumo-link hover:underline" to={`/traces/${d.trace_id}`}>{d.trace_id}</Link> : <span className="text-kumo-subtle">—</span>}
                  </Table.Cell>
                  <Table.Cell className="text-right tabular-nums">{d.record_count}</Table.Cell>
                  <Table.Cell className="max-w-xs text-xs">
                    {d.replay_requested_at ? (
                      <Badge variant="warning">pending ({d.replay_attempts} tries)</Badge>
                    ) : d.last_error ? (
                      <Tooltip asChild content={d.last_error}>
                        <span className="block truncate text-kumo-danger">failed: {d.last_error}</span>
                      </Tooltip>
                    ) : (
                      <span className="text-kumo-subtle">—</span>
                    )}
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
