import { Badge } from '@cloudflare/kumo/components/badge';
import {
  BellIcon,
  BriefcaseIcon,
  CalendarCheckIcon,
  EnvelopeIcon,
  GlobeIcon,
  LightningIcon,
  ListBulletsIcon,
  TerminalIcon,
  UsersIcon,
} from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { bucketTimeSeries, durationRangeLabel, type BarDatum, type MetricLegendItem } from '@/components/charts';
import { ErrorCount, StatusCodeText, WarningCount } from '@/components/common';
import { compact, ms } from './format';
import type { EventGroup, EventRow, Range } from './types';

export interface EventColumn<T> {
  label: string;
  align?: 'right';
  render: (row: T) => ReactNode;
}

export interface EventChartCardData {
  title: string;
  value: ReactNode;
  metrics?: MetricLegendItem[];
  kind: 'bar' | 'line';
  barTone?: 'neutral' | 'brand' | 'danger' | 'success';
  unit?: string;
  barSeries?: BarDatum[];
  lineValues?: (number | null)[];
  secondaryLineValues?: (number | null)[];
  lineLabels?: string[];
  lineTimestamps?: number[];
  format?: (n: number) => string;
}

export interface EventChartDeck {
  left: EventChartCardData;
  right: EventChartCardData;
}

/** One dashboard view over an event table served by workers/api (see workers/api/src/events.ts). */
export interface EventPage {
  path: string;
  title: string;
  nav: string;
  icon: typeof BriefcaseIcon;
  subtitle: string;
  keyLabel: string;
  sectionUnit?: [string, string];
  emptyLabel?: string;
  showUserFilter?: boolean;
  isClassKey?: boolean;
  renderKey?: (key: string, row?: EventGroup) => ReactNode;
  columns: EventColumn<EventGroup>[];
  rowColumns: EventColumn<EventRow>[];
  chartDeck?: (summary: Record<string, number>, rows: EventGroup[], range: Range) => EventChartDeck;
  filters?: { param: string; label: string; options: string[] }[];
  searchPlaceholder: string;
}

const statusBadge = (status: unknown) =>
  status ? <Badge variant={status === 'failed' ? 'error' : status === 'processed' ? 'success' : 'warning'}>{String(status)}</Badge> : <span className="text-kumo-subtle">—</span>;
const num = (v: unknown) => compact(Number(v ?? 0));
const pct = (v: unknown) => (v === null || v === undefined ? '—' : `${Math.round(Number(v) * 100)}%`);
const dur = (v: unknown) => (v === null || v === undefined ? <span className="text-neutral-400">—</span> : ms(Number(v)));

const LOG_LEVELS = ['emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'info', 'debug'];
const levelVariant = (level: string) => (LOG_LEVELS.indexOf(level) <= 3 ? 'error' : level === 'warning' ? 'warning' : 'secondary');

function durationCard(rows: EventGroup[], range: Range, summaryAvg?: number): EventChartCardData {
  const avgVals = rows.map((r) => Number(r.avg_ms ?? 0)).filter((v) => v > 0);
  const maxVals = rows.map((r) => Number(r.max_ms ?? 0)).filter((v) => v > 0);
  const overallAvg =
    summaryAvg !== undefined && summaryAvg > 0
      ? summaryAvg
      : avgVals.length
        ? avgVals.reduce((a, b) => a + b, 0) / avgVals.length
        : 0;
  const overallMax = maxVals.length ? Math.max(...maxVals) : 0;
  const timed = bucketTimeSeries(rows, range, {
    timestamp: (r) => r.last_seen,
    p95: (r) => Number(r.max_ms ?? r.avg_ms ?? 0),
    avg: (r) => Number(r.avg_ms ?? 0),
    buckets: 36,
  });
  return {
    title: 'Duration',
    value: durationRangeLabel([...avgVals, ...maxVals]),
    metrics: [
      { label: 'AVG', value: overallAvg > 0 ? ms(overallAvg) : '—', tone: 'charcoal' },
      { label: 'P95', value: overallMax > 0 ? ms(overallMax) : '—', tone: 'alert' },
    ],
    kind: 'line',
    lineValues: timed.p95Values,
    secondaryLineValues: timed.avgValues,
    lineLabels: timed.labels,
    lineTimestamps: timed.timestamps,
    format: ms,
  };
}

export const EVENT_PAGES: EventPage[] = [
  {
    path: '/jobs',
    title: 'Jobs',
    nav: 'Jobs',
    icon: BriefcaseIcon,
    subtitle: 'Background jobs grouped by class — click any job to inspect attempts',
    keyLabel: 'Jobs',
    sectionUnit: ['Job', 'Jobs'],
    emptyLabel: 'No jobs found',
    showUserFilter: true,
    isClassKey: true,
    columns: [
      { label: 'Queued', align: 'right', render: (g) => num(g.queued) },
      { label: 'Processed', align: 'right', render: (g) => num(Math.max(0, Number(g.attempts ?? 0) - Number(g.failed ?? 0) - Number(g.released ?? 0))) },
      { label: 'Released', align: 'right', render: (g) => <WarningCount count={Number(g.released ?? 0)} /> },
      { label: 'Failed', align: 'right', render: (g) => <ErrorCount count={Number(g.failed ?? 0)} /> },
      { label: 'Total', align: 'right', render: (g) => <span className="font-medium">{num(g.attempts)}</span> },
      { label: 'Avg', align: 'right', render: (g) => dur(g.avg_ms) },
      { label: 'P95', align: 'right', render: (g) => dur(g.max_ms) },
    ],
    rowColumns: [
      { label: 'Kind', render: (r) => <Badge variant="outline">{String(r.kind)}</Badge> },
      { label: 'Status', render: (r) => statusBadge(r.status) },
      { label: 'Attempt', align: 'right', render: (r) => (r.attempt ?? '—') as ReactNode },
      { label: 'Queue', render: (r) => <span className="text-neutral-500">{String(r.queue ?? '—')}</span> },
      { label: 'Duration', align: 'right', render: (r) => dur(r.duration_ms) },
    ],
    chartDeck: (s, rows, range) => {
      const attempts = Number(s.attempts ?? 0);
      const failed = Number(s.failed ?? 0);
      const released = Number(s.released ?? 0);
      const processed = Math.max(0, attempts - failed - released);
      const timed = bucketTimeSeries(rows, range, {
        timestamp: (r) => r.last_seen,
        value: (r) => Number(r.attempts ?? r.count ?? 0),
        warn: (r) => Number(r.released ?? 0),
        highlight: (r) => Number(r.failed ?? 0),
        buckets: 36,
      });
      return {
        left: {
          title: 'Attempts',
          value: compact(attempts),
          metrics: [
            { label: 'FAILED', value: compact(failed), tone: 'error' },
            { label: 'PROCESSED', value: compact(processed), tone: 'neutral' },
            { label: 'RELEASED', value: compact(released), tone: 'alert' },
          ],
          kind: 'bar',
          unit: 'attempts',
          barSeries: timed.barSeries,
        },
        right: durationCard(rows, range),
      };
    },
    filters: [{ param: 'status', label: 'Status', options: ['all', 'processed', 'released', 'failed'] }],
    searchPlaceholder: 'Search jobs',
  },
  {
    path: '/commands',
    title: 'Commands',
    nav: 'Commands',
    icon: TerminalIcon,
    subtitle: 'Artisan command runs grouped by command name',
    keyLabel: 'Command',
    sectionUnit: ['Command', 'Commands'],
    emptyLabel: 'No commands found',
    columns: [
      { label: 'Success', align: 'right', render: (g) => num(Math.max(0, Number(g.count ?? 0) - Number(g.failed ?? 0))) },
      { label: 'Failed', align: 'right', render: (g) => <ErrorCount count={Number(g.failed ?? 0)} /> },
      { label: 'Total', align: 'right', render: (g) => <span className="font-medium">{num(g.count)}</span> },
      { label: 'Avg', align: 'right', render: (g) => dur(g.avg_ms) },
      { label: 'P95', align: 'right', render: (g) => dur(g.max_ms) },
    ],
    rowColumns: [
      { label: 'Exit code', render: (r) => (r.exit_code === null || r.exit_code === undefined ? '—' : <StatusCodeText status={Number(r.exit_code)} source="command" />) },
      { label: 'Command line', render: (r) => <span>{String(r.command ?? '—')}</span> },
      { label: 'Duration', align: 'right', render: (r) => dur(r.duration_ms) },
    ],
    chartDeck: (s, rows, range) => {
      const runs = Number(s.runs ?? 0);
      const failed = Number(s.failed ?? 0);
      const ok = Math.max(0, runs - failed);
      const timed = bucketTimeSeries(rows, range, {
        timestamp: (r) => r.last_seen,
        value: (r) => Number(r.count ?? 0),
        highlight: (r) => Number(r.failed ?? 0),
        buckets: 36,
      });
      return {
        left: {
          title: 'Calls',
          value: compact(runs),
          metrics: [
            { label: 'UNSUCCESSFUL', value: compact(failed), tone: 'error' },
            { label: 'SUCCESSFUL', value: compact(ok), tone: 'neutral' },
          ],
          kind: 'bar',
          unit: 'calls',
          barSeries: timed.barSeries,
        },
        right: durationCard(rows, range, s.avg_ms !== undefined ? Number(s.avg_ms) : undefined),
      };
    },
    filters: [{ param: 'status', label: 'Status', options: ['all', 'success', 'failed'] }],
    searchPlaceholder: 'Search commands',
  },
  {
    path: '/cache',
    title: 'Cache',
    nav: 'Cache',
    icon: LightningIcon,
    subtitle: 'Cache hits, misses, writes and deletes grouped by key',
    keyLabel: 'Key',
    sectionUnit: ['key', 'keys'],
    emptyLabel: 'No cache keys found',
    columns: [
      { label: 'Hit %', align: 'right', render: (g) => pct(g.hit_ratio) },
      { label: 'Hits', align: 'right', render: (g) => num(g.hits) },
      { label: 'Misses', align: 'right', render: (g) => num(g.misses) },
      { label: 'Writes', align: 'right', render: (g) => num(g.writes) },
      { label: 'Deletes', align: 'right', render: (g) => num(g.deletes) },
      { label: 'Failures', align: 'right', render: (g) => <ErrorCount count={Number(g.failures ?? 0)} /> },
      { label: 'Total', align: 'right', render: (g) => <span className="font-medium">{num(Number(g.hits ?? 0) + Number(g.misses ?? 0) + Number(g.writes ?? 0) + Number(g.deletes ?? 0))}</span> },
    ],
    rowColumns: [
      { label: 'Type', render: (r) => <Badge variant={r.type === 'hit' ? 'success' : String(r.type).endsWith('failure') ? 'error' : r.type === 'miss' ? 'warning' : 'secondary'}>{String(r.type)}</Badge> },
      { label: 'Store', render: (r) => <span className="text-neutral-500">{String(r.store ?? '—')}</span> },
      { label: 'TTL', align: 'right', render: (r) => (r.ttl ? `${r.ttl}s` : '—') },
      { label: 'Duration', align: 'right', render: (r) => dur(r.duration_ms) },
    ],
    chartDeck: (s, rows, range) => {
      const hits = Number(s.hits ?? 0);
      const misses = Number(s.misses ?? 0);
      const writes = Number(s.writes ?? 0);
      const deletes = Number(s.deletes ?? 0);
      const total = hits + misses + writes + deletes;
      const totalFailures = rows.reduce((sum, r) => sum + Number(r.failures ?? 0), 0);
      const timedEvents = bucketTimeSeries(rows, range, {
        timestamp: (r) => r.last_seen,
        value: (r) => Number(r.hits ?? 0) + Number(r.misses ?? 0) + Number(r.writes ?? 0) + Number(r.deletes ?? 0),
        extra: (r) => Number(r.writes ?? 0),
        warn: (r) => Number(r.misses ?? 0),
        highlight: (r) => Number(r.deletes ?? 0),
        buckets: 36,
      });
      const timedFailures = bucketTimeSeries(rows, range, {
        timestamp: (r) => r.last_seen,
        value: (r) => Number(r.failures ?? 0),
        highlight: (r) => Number(r.failures ?? 0),
        buckets: 36,
      });
      return {
        left: {
          title: 'Events',
          value: compact(total),
          metrics: [
            { label: 'DELETES', value: compact(deletes), tone: 'error' },
            { label: 'HITS', value: compact(hits), tone: 'neutral' },
            { label: 'MISSES', value: compact(misses), tone: 'alert' },
            { label: 'WRITES', value: compact(writes), tone: 'blue' },
          ],
          kind: 'bar',
          unit: 'events',
          barSeries: timedEvents.barSeries,
        },
        right: {
          title: 'Failures',
          value: compact(totalFailures),
          metrics: [
            { label: 'DELETE', value: compact(0), tone: 'error' },
            { label: 'WRITE', value: compact(totalFailures), tone: 'alert' },
          ],
          kind: 'bar',
          unit: 'failures',
          barSeries: timedFailures.barSeries,
        },
      };
    },
    filters: [{ param: 'type', label: 'Type', options: ['all', 'hit', 'miss', 'write', 'delete', 'write-failure', 'delete-failure'] }],
    searchPlaceholder: 'Search keys',
  },
  {
    path: '/outgoing-requests',
    title: 'Outgoing Requests',
    nav: 'Outgoing Requests',
    icon: GlobeIcon,
    subtitle: 'HTTP calls your app made to other services, grouped by host',
    keyLabel: 'Host',
    sectionUnit: ['Domain', 'Domains'],
    emptyLabel: 'No outgoing requests found',
    columns: [
      { label: '1/2/3xx', align: 'right', render: (g) => num(Math.max(0, Number(g.count ?? 0) - Number(g.failed ?? 0))) },
      { label: 'Failed', align: 'right', render: (g) => <ErrorCount count={Number(g.failed ?? 0)} /> },
      { label: 'Total', align: 'right', render: (g) => <span className="font-medium">{num(g.count)}</span> },
      { label: 'Avg', align: 'right', render: (g) => dur(g.avg_ms) },
      { label: 'P95', align: 'right', render: (g) => dur(g.max_ms) },
    ],
    rowColumns: [
      { label: 'Status', render: (r) => (r.status_code === null || r.status_code === undefined ? <Badge variant="error">no response</Badge> : <StatusCodeText status={Number(r.status_code)} source="request" />) },
      { label: 'Request', render: (r) => <span>{`${r.method} ${r.url ?? ''}`}</span> },
      { label: 'Duration', align: 'right', render: (r) => dur(r.duration_ms) },
    ],
    chartDeck: (s, rows, range) => {
      const total = Number(s.requests ?? 0);
      const failed = Number(s.failed ?? 0);
      const ok = Math.max(0, total - failed);
      const timed = bucketTimeSeries(rows, range, {
        timestamp: (r) => r.last_seen,
        value: (r) => Number(r.count ?? 0),
        highlight: (r) => Number(r.failed ?? 0),
        buckets: 36,
      });
      return {
        left: {
          title: 'Requests',
          value: compact(total),
          metrics: [
            { label: '1/2/3XX', value: compact(ok), tone: 'neutral' },
            { label: '4XX/5XX', value: compact(failed), tone: 'error' },
          ],
          kind: 'bar',
          unit: 'requests',
          barSeries: timed.barSeries,
        },
        right: durationCard(rows, range, s.avg_ms !== undefined ? Number(s.avg_ms) : undefined),
      };
    },
    filters: [
      { param: 'method', label: 'Method', options: ['all', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      { param: 'status', label: 'Status', options: ['all', '2xx', '3xx', '4xx', '5xx', 'error'] },
    ],
    searchPlaceholder: 'Search domains',
  },
  {
    path: '/mail',
    title: 'Mail',
    nav: 'Mail',
    icon: EnvelopeIcon,
    subtitle: 'Emails your app sent, grouped by mailable',
    keyLabel: 'Mail',
    sectionUnit: ['Mail', 'Mails'],
    emptyLabel: 'No mail found',
    isClassKey: true,
    columns: [
      { label: 'Count', align: 'right', render: (g) => <span className="font-medium">{num(g.count)}</span> },
      { label: 'Avg', align: 'right', render: (g) => dur(g.avg_ms) },
      { label: 'P95', align: 'right', render: (g) => dur(g.max_ms) },
    ],
    rowColumns: [
      { label: 'Status', render: (r) => <Badge variant={r.failed ? 'error' : 'success'}>{r.failed ? 'failed' : 'sent'}</Badge> },
      { label: 'Subject', render: (r) => <span className="font-sans text-xs">{String(r.subject ?? '—')}</span> },
      { label: 'To / CC / BCC', align: 'right', render: (r) => `${num(r.to_count)} / ${num(r.cc_count)} / ${num(r.bcc_count)}` },
      { label: 'Duration', align: 'right', render: (r) => dur(r.duration_ms) },
    ],
    chartDeck: (s, rows, range) => {
      const sent = Number(s.sent ?? 0);
      const failed = Number(s.failed ?? 0);
      const timed = bucketTimeSeries(rows, range, {
        timestamp: (r) => r.last_seen,
        value: (r) => Number(r.count ?? 0),
        highlight: (r) => Number(r.failed ?? 0),
        buckets: 36,
      });
      return {
        left: {
          title: 'Mails',
          value: compact(sent),
          metrics: failed > 0
            ? [
                { label: 'SENT', value: compact(Math.max(0, sent - failed)), tone: 'neutral' },
                { label: 'FAILED', value: compact(failed), tone: 'error' },
              ]
            : undefined,
          kind: 'bar',
          unit: 'mails',
          barSeries: timed.barSeries,
        },
        right: durationCard(rows, range, s.avg_ms !== undefined ? Number(s.avg_ms) : undefined),
      };
    },
    filters: [{ param: 'status', label: 'Status', options: ['all', 'sent', 'failed'] }],
    searchPlaceholder: 'Search mail',
  },
  {
    path: '/notifications',
    title: 'Notifications',
    nav: 'Notifications',
    icon: BellIcon,
    subtitle: 'Notifications your app sent, grouped by class',
    keyLabel: 'Notification',
    sectionUnit: ['Notification', 'Notifications'],
    emptyLabel: 'No notifications found',
    isClassKey: true,
    columns: [
      { label: 'Count', align: 'right', render: (g) => <span className="font-medium">{num(g.count)}</span> },
      { label: 'Avg', align: 'right', render: (g) => dur(g.avg_ms) },
      { label: 'P95', align: 'right', render: (g) => dur(g.max_ms) },
    ],
    rowColumns: [
      { label: 'Status', render: (r) => <Badge variant={r.failed ? 'error' : 'success'}>{r.failed ? 'failed' : 'sent'}</Badge> },
      { label: 'Channel', render: (r) => <span className="text-neutral-500">{String(r.channel ?? '—')}</span> },
      { label: 'Duration', align: 'right', render: (r) => dur(r.duration_ms) },
    ],
    chartDeck: (s, rows, range) => {
      const sent = Number(s.sent ?? 0);
      const failed = Number(s.failed ?? 0);
      const timed = bucketTimeSeries(rows, range, {
        timestamp: (r) => r.last_seen,
        value: (r) => Number(r.count ?? 0),
        highlight: (r) => Number(r.failed ?? 0),
        buckets: 36,
      });
      return {
        left: {
          title: 'Notifications',
          value: compact(sent),
          metrics: failed > 0
            ? [
                { label: 'SENT', value: compact(Math.max(0, sent - failed)), tone: 'neutral' },
                { label: 'FAILED', value: compact(failed), tone: 'error' },
              ]
            : undefined,
          kind: 'bar',
          unit: 'notifications',
          barSeries: timed.barSeries,
        },
        right: durationCard(rows, range, s.avg_ms !== undefined ? Number(s.avg_ms) : undefined),
      };
    },
    filters: [
      { param: 'channel', label: 'Channel', options: ['all', 'mail', 'database', 'broadcast', 'slack', 'vonage'] },
      { param: 'status', label: 'Status', options: ['all', 'sent', 'failed'] },
    ],
    searchPlaceholder: 'Search notifications',
  },
  {
    path: '/scheduled-tasks',
    title: 'Scheduled Tasks',
    nav: 'Scheduled Tasks',
    icon: CalendarCheckIcon,
    subtitle: 'Runs of your scheduled tasks, grouped by task',
    keyLabel: 'Task',
    sectionUnit: ['Task', 'Tasks'],
    emptyLabel: 'No scheduled tasks found',
    columns: [
      { label: 'Schedule', render: (g) => <span className="text-neutral-600 dark:text-neutral-400">{g.cron ?? '—'}</span> },
      { label: 'Processed', align: 'right', render: (g) => num(g.processed) },
      { label: 'Skipped', align: 'right', render: (g) => <WarningCount count={Number(g.skipped ?? 0)} /> },
      { label: 'Failed', align: 'right', render: (g) => <ErrorCount count={Number(g.failed ?? 0)} /> },
      { label: 'Total', align: 'right', render: (g) => <span className="font-medium">{num(g.count)}</span> },
      { label: 'Avg', align: 'right', render: (g) => dur(g.avg_ms) },
      { label: 'P95', align: 'right', render: (g) => dur(g.max_ms) },
    ],
    rowColumns: [
      { label: 'Status', render: (r) => <Badge variant={r.status === 'failed' ? 'error' : r.status === 'skipped' ? 'secondary' : 'success'}>{String(r.status ?? '—')}</Badge> },
      { label: 'Cron', render: (r) => <span className="text-neutral-500">{`${r.cron ?? '—'}${r.timezone ? ` (${r.timezone})` : ''}`}</span> },
      { label: 'Duration', align: 'right', render: (r) => dur(r.duration_ms) },
    ],
    chartDeck: (s, rows, range) => {
      const runs = Number(s.runs ?? 0);
      const failed = Number(s.failed ?? 0);
      const skipped = Number(s.skipped ?? 0);
      const processed = Math.max(0, runs - failed - skipped);
      const timed = bucketTimeSeries(rows, range, {
        timestamp: (r) => r.last_seen,
        value: (r) => Number(r.count ?? 0),
        warn: (r) => Number(r.skipped ?? 0),
        highlight: (r) => Number(r.failed ?? 0),
        buckets: 36,
      });
      return {
        left: {
          title: 'Scheduled Tasks',
          value: compact(runs),
          metrics: [
            { label: 'FAILED', value: compact(failed), tone: 'error' },
            { label: 'PROCESSED', value: compact(processed), tone: 'neutral' },
            { label: 'SKIPPED', value: compact(skipped), tone: 'alert' },
          ],
          kind: 'bar',
          unit: 'runs',
          barSeries: timed.barSeries,
        },
        right: durationCard(rows, range, s.avg_ms !== undefined ? Number(s.avg_ms) : undefined),
      };
    },
    filters: [{ param: 'status', label: 'Status', options: ['all', 'processed', 'failed', 'skipped'] }],
    searchPlaceholder: 'Search tasks',
  },
  {
    path: '/logs',
    title: 'Logs',
    nav: 'Logs',
    icon: ListBulletsIcon,
    subtitle: 'Application log entries grouped by severity level',
    keyLabel: 'Level',
    renderKey: (key) => <Badge variant={levelVariant(key)}>{key}</Badge>,
    columns: [
      { label: 'Entries', align: 'right', render: (g) => num(g.count) },
      { label: 'Traces', align: 'right', render: (g) => num(g.traces) },
    ],
    rowColumns: [
      { label: 'Level', render: (r) => <Badge variant={levelVariant(String(r.level))}>{String(r.level)}</Badge> },
      { label: 'Message', render: (r) => <span className="text-sm">{String(r.message)}</span> },
      { label: 'Context', render: (r) => <span className="break-all font-mono text-xs text-kumo-subtle">{r.context ? String(r.context) : '—'}</span> },
    ],
    filters: [{ param: 'level', label: 'Level', options: ['all', ...LOG_LEVELS] }],
    searchPlaceholder: 'Search logs',
  },
  {
    path: '/users',
    title: 'Users',
    nav: 'Users',
    icon: UsersIcon,
    subtitle: 'Authenticated users and the traces they triggered',
    keyLabel: 'User',
    sectionUnit: ['User', 'Users'],
    emptyLabel: 'No users found',
    renderKey: (key, row) => (
      <span className="inline-flex min-w-0 items-baseline gap-2.5">
        <span className="truncate font-medium text-neutral-900 dark:text-white">{row?.name ? String(row.name) : `User #${key}`}</span>
        <span className="truncate text-neutral-500 dark:text-neutral-400">#{key}</span>
      </span>
    ),
    columns: [
      { label: '1/2/3xx', align: 'right', render: (g) => num(Math.max(0, Number(g.requests ?? 0) - Number(g.server_errors ?? 0))) },
      { label: '4xx', align: 'right', render: (g) => <WarningCount count={Number(g.client_errors ?? 0)} /> },
      { label: '5xx', align: 'right', render: (g) => <ErrorCount count={Number(g.server_errors ?? 0)} /> },
      { label: 'Requests', align: 'right', render: (g) => <span className="font-medium">{num(g.requests)}</span> },
      { label: 'Queued Jobs', align: 'right', render: (g) => num(g.queued_jobs ?? 0) },
      { label: 'Exceptions', align: 'right', render: (g) => <ErrorCount count={Number(g.exceptions ?? 0)} /> },
    ],
    rowColumns: [
      { label: 'Status', render: (r) => (r.status_code === null || r.status_code === undefined ? '—' : <StatusCodeText status={Number(r.status_code)} source="request" />) },
      { label: 'Type', render: (r) => <Badge variant="outline">{String(r.execution_source ?? '—')}</Badge> },
      { label: 'Duration', align: 'right', render: (r) => dur(r.duration_ms) },
    ],
    chartDeck: (s, rows, range) => {
      const usersCount = Number(s.users ?? rows.length);
      const traces = Number(s.traces ?? 0);
      const exceptions = Number(s.exceptions ?? 0);
      const timedUsers = bucketTimeSeries(rows, range, {
        timestamp: (r) => r.last_seen,
        value: () => 1,
        buckets: 36,
      });
      const timedTraces = bucketTimeSeries(rows, range, {
        timestamp: (r) => r.last_seen,
        value: (r) => Number(r.count ?? 0),
        highlight: (r) => Number(r.exceptions ?? 0),
        buckets: 36,
      });
      return {
        left: {
          title: 'Authenticated Users',
          value: compact(usersCount),
          kind: 'bar',
          barTone: 'success',
          unit: 'users',
          barSeries: timedUsers.barSeries,
        },
        right: {
          title: 'Requests',
          value: compact(traces),
          metrics: [
            { label: 'AUTHENTICATED', value: compact(traces), tone: 'success' },
            { label: 'EXCEPTIONS', value: compact(exceptions), tone: 'error' },
          ],
          kind: 'bar',
          barTone: 'success',
          unit: 'requests',
          barSeries: timedTraces.barSeries,
        },
      };
    },
    filters: [{ param: 'source', label: 'Type', options: ['all', 'request', 'command', 'job', 'schedule'] }],
    searchPlaceholder: 'Search users',
  },
];
