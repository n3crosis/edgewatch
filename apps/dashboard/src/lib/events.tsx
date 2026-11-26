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
import type { MetricLegendItem } from '@/components/charts';
import { compact, ms } from './format';
import { splitClassName } from './ui-helpers';
import type { EventGroup, EventRow } from './types';

function renderClassKey(key: string) {
  const { short, namespace } = splitClassName(key);
  return (
    <span className="inline-flex min-w-0 items-baseline gap-2 font-mono text-xs">
      <span className="truncate font-medium">{short}</span>
      {namespace && <span className="truncate text-kumo-subtle">{namespace}</span>}
    </span>
  );
}

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
  unit?: string;
  barSeries?: { label: string; value: number; warn?: number; highlight?: number }[];
  lineValues?: number[];
  lineLabels?: string[];
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
  renderKey?: (key: string) => ReactNode;
  columns: EventColumn<EventGroup>[];
  rowColumns: EventColumn<EventRow>[];
  chartDeck?: (summary: Record<string, number>, rows: EventGroup[]) => EventChartDeck;
  filters?: { param: string; label: string; options: string[] }[];
  searchPlaceholder: string;
}

const statusBadge = (status: unknown) =>
  status ? <Badge variant={status === 'failed' ? 'error' : status === 'processed' ? 'success' : 'warning'}>{String(status)}</Badge> : <span className="text-kumo-subtle">—</span>;
const num = (v: unknown) => compact(Number(v ?? 0));
const pct = (v: unknown) => (v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(1)}%`);
const coloredPct = (v: unknown, goodThreshold: number, warnThreshold?: number) => {
  if (v === null || v === undefined) return <span className="text-kumo-subtle">—</span>;
  const n = Number(v);
  const cls = n >= goodThreshold ? 'font-medium text-kumo-success' : warnThreshold !== undefined && n < warnThreshold ? 'font-medium text-kumo-danger' : 'font-medium text-kumo-warning';
  return <span className={cls}>{`${(n * 100).toFixed(1)}%`}</span>;
};
const dur = (v: unknown) => (v === null || v === undefined ? <span className="text-kumo-subtle">—</span> : <span className="font-mono text-xs">{ms(Number(v))}</span>);

const LOG_LEVELS = ['emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'info', 'debug'];
const levelVariant = (level: string) => (LOG_LEVELS.indexOf(level) <= 3 ? 'error' : level === 'warning' ? 'warning' : 'secondary');

function durationCard(rows: EventGroup[], summaryAvg?: number): EventChartCardData {
  const avgVals = rows.map((r) => Number(r.avg_ms ?? 0)).filter((v) => v > 0);
  const maxVals = rows.map((r) => Number(r.max_ms ?? 0)).filter((v) => v > 0);
  const overallAvg = summaryAvg !== undefined && summaryAvg > 0
    ? summaryAvg
    : avgVals.length
      ? avgVals.reduce((a, b) => a + b, 0) / avgVals.length
      : 0;
  const overallMax = maxVals.length ? Math.max(...maxVals) : 0;
  const sample = rows.slice(0, 16);
  return {
    title: 'Duration',
    value: overallMax > 0 ? ms(overallMax) : overallAvg > 0 ? ms(overallAvg) : '—',
    metrics: [
      { label: 'AVG', value: overallAvg > 0 ? ms(overallAvg) : '—', tone: 'charcoal' },
      { label: 'MAX', value: overallMax > 0 ? ms(overallMax) : '—', tone: 'alert' },
    ],
    kind: 'line',
    lineValues: sample.map((r) => Number(r.max_ms ?? r.avg_ms ?? 0)),
    lineLabels: sample.map((r) => splitClassName(r.key).short),
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
    keyLabel: 'Job',
    sectionUnit: ['Job', 'Jobs'],
    emptyLabel: 'No jobs found',
    showUserFilter: true,
    isClassKey: true,
    renderKey: renderClassKey,
    columns: [
      { label: 'Queue', render: (g) => <span className="font-mono text-xs text-kumo-subtle">{g.queue ?? '—'}</span> },
      { label: 'Queued', align: 'right', render: (g) => num(g.queued) },
      { label: 'Attempts', align: 'right', render: (g) => num(g.attempts) },
      { label: 'Failed', align: 'right', render: (g) => <span className={Number(g.failed) ? 'font-medium text-kumo-danger' : 'text-kumo-subtle'}>{num(g.failed)}</span> },
      { label: 'Released', align: 'right', render: (g) => num(g.released) },
      { label: 'Avg', align: 'right', render: (g) => dur(g.avg_ms) },
      { label: 'Max', align: 'right', render: (g) => dur(g.max_ms) },
    ],
    rowColumns: [
      { label: 'Kind', render: (r) => <Badge variant="outline">{String(r.kind)}</Badge> },
      { label: 'Status', render: (r) => statusBadge(r.status) },
      { label: 'Attempt', align: 'right', render: (r) => (r.attempt ?? '—') as ReactNode },
      { label: 'Queue', render: (r) => <span className="font-mono text-xs text-kumo-subtle">{String(r.queue ?? '—')}</span> },
      { label: 'Duration', align: 'right', render: (r) => dur(r.duration_ms) },
    ],
    chartDeck: (s, rows) => {
      const attempts = Number(s.attempts ?? 0);
      const failed = Number(s.failed ?? 0);
      const released = Number(s.released ?? 0);
      const processed = Math.max(0, attempts - failed - released);
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
          barSeries: rows.slice(0, 16).map((r) => ({
            label: splitClassName(r.key).short,
            value: Number(r.attempts ?? r.count ?? 0),
            warn: Number(r.released ?? 0),
            highlight: Number(r.failed ?? 0),
          })),
        },
        right: durationCard(rows),
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
    renderKey: (key) => <span className="font-mono text-xs">{key}</span>,
    columns: [
      { label: 'Runs', align: 'right', render: (g) => num(g.count) },
      { label: 'Failed', align: 'right', render: (g) => <span className={Number(g.failed) ? 'font-medium text-kumo-danger' : 'text-kumo-subtle'}>{num(g.failed)}</span> },
      { label: 'Avg', align: 'right', render: (g) => dur(g.avg_ms) },
      { label: 'Max', align: 'right', render: (g) => dur(g.max_ms) },
    ],
    rowColumns: [
      { label: 'Exit code', render: (r) => (r.exit_code === null || r.exit_code === undefined ? '—' : <Badge variant={Number(r.exit_code) === 0 ? 'success' : 'error'} className="font-mono">{String(r.exit_code)}</Badge>) },
      { label: 'Command line', render: (r) => <span className="font-mono text-xs">{String(r.command ?? '—')}</span> },
      { label: 'Duration', align: 'right', render: (r) => dur(r.duration_ms) },
    ],
    chartDeck: (s, rows) => {
      const runs = Number(s.runs ?? 0);
      const failed = Number(s.failed ?? 0);
      const ok = Math.max(0, runs - failed);
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
          barSeries: rows.slice(0, 16).map((r) => ({
            label: r.key,
            value: Number(r.count ?? 0),
            highlight: Number(r.failed ?? 0),
          })),
        },
        right: durationCard(rows, s.avg_ms !== undefined ? Number(s.avg_ms) : undefined),
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
    renderKey: (key) => <span className="font-mono text-xs">{key}</span>,
    columns: [
      { label: 'Store', render: (g) => <span className="font-mono text-xs text-kumo-subtle">{g.store ?? '—'}</span> },
      { label: 'Hit ratio', align: 'right', render: (g) => coloredPct(g.hit_ratio, 0.8, 0.5) },
      { label: 'Hits', align: 'right', render: (g) => num(g.hits) },
      { label: 'Misses', align: 'right', render: (g) => num(g.misses) },
      { label: 'Writes', align: 'right', render: (g) => num(g.writes) },
      { label: 'Deletes', align: 'right', render: (g) => num(g.deletes) },
      { label: 'Failures', align: 'right', render: (g) => <span className={Number(g.failures) ? 'font-medium text-kumo-danger' : 'text-kumo-subtle'}>{num(g.failures)}</span> },
      { label: 'Avg', align: 'right', render: (g) => dur(g.avg_ms) },
    ],
    rowColumns: [
      { label: 'Type', render: (r) => <Badge variant={r.type === 'hit' ? 'success' : String(r.type).endsWith('failure') ? 'error' : r.type === 'miss' ? 'warning' : 'secondary'}>{String(r.type)}</Badge> },
      { label: 'Store', render: (r) => <span className="font-mono text-xs text-kumo-subtle">{String(r.store ?? '—')}</span> },
      { label: 'TTL', align: 'right', render: (r) => (r.ttl ? <span className="font-mono text-xs">{`${r.ttl}s`}</span> : '—') },
      { label: 'Duration', align: 'right', render: (r) => dur(r.duration_ms) },
    ],
    chartDeck: (s, rows) => {
      const hits = Number(s.hits ?? 0);
      const misses = Number(s.misses ?? 0);
      const writes = Number(s.writes ?? 0);
      const deletes = Number(s.deletes ?? 0);
      const total = hits + misses + writes + deletes;
      const totalFailures = rows.reduce((sum, r) => sum + Number(r.failures ?? 0), 0);
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
          barSeries: rows.slice(0, 16).map((r) => ({
            label: r.key,
            value: Number(r.hits ?? 0) + Number(r.misses ?? 0) + Number(r.writes ?? 0) + Number(r.deletes ?? 0),
            warn: Number(r.misses ?? 0),
            highlight: Number(r.deletes ?? 0),
          })),
        },
        right: {
          title: 'Failures',
          value: compact(totalFailures),
          metrics: [
            { label: 'HIT RATIO', value: pct(s.hit_ratio), tone: 'success' },
            { label: 'FAILURES', value: compact(totalFailures), tone: 'error' },
          ],
          kind: 'bar',
          unit: 'failures',
          barSeries: rows.slice(0, 16).map((r) => ({
            label: r.key,
            value: Number(r.failures ?? 0),
            highlight: Number(r.failures ?? 0),
          })),
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
    keyLabel: 'Domain',
    sectionUnit: ['Domain', 'Domains'],
    emptyLabel: 'No outgoing requests found',
    renderKey: (key) => <span className="font-mono text-xs">{key}</span>,
    columns: [
      { label: 'Methods', render: (g) => <span className="font-mono text-xs text-kumo-subtle">{g.methods ?? '—'}</span> },
      { label: 'Requests', align: 'right', render: (g) => num(g.count) },
      { label: 'Failed', align: 'right', render: (g) => <span className={Number(g.failed) ? 'font-medium text-kumo-danger' : 'text-kumo-subtle'}>{num(g.failed)}</span> },
      { label: 'Avg', align: 'right', render: (g) => dur(g.avg_ms) },
      { label: 'Max', align: 'right', render: (g) => dur(g.max_ms) },
    ],
    rowColumns: [
      { label: 'Status', render: (r) => (r.status_code === null || r.status_code === undefined ? <Badge variant="error">no response</Badge> : <Badge variant={Number(r.status_code) >= 400 ? 'error' : 'success'} className="font-mono">{String(r.status_code)}</Badge>) },
      { label: 'Request', render: (r) => <span className="font-mono text-xs">{`${r.method} ${r.url ?? ''}`}</span> },
      { label: 'Duration', align: 'right', render: (r) => dur(r.duration_ms) },
    ],
    chartDeck: (s, rows) => {
      const total = Number(s.requests ?? 0);
      const failed = Number(s.failed ?? 0);
      const ok = Math.max(0, total - failed);
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
          barSeries: rows.slice(0, 16).map((r) => ({
            label: r.key,
            value: Number(r.count ?? 0),
            highlight: Number(r.failed ?? 0),
          })),
        },
        right: durationCard(rows, s.avg_ms !== undefined ? Number(s.avg_ms) : undefined),
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
    keyLabel: 'Mailable',
    sectionUnit: ['mail', 'mails'],
    emptyLabel: 'No mail found',
    isClassKey: true,
    renderKey: renderClassKey,
    columns: [
      { label: 'Mailer', render: (g) => <span className="font-mono text-xs text-kumo-subtle">{g.mailers ?? '—'}</span> },
      { label: 'Sent', align: 'right', render: (g) => num(g.count) },
      { label: 'Recipients', align: 'right', render: (g) => num(g.recipients) },
      { label: 'Failed', align: 'right', render: (g) => <span className={Number(g.failed) ? 'font-medium text-kumo-danger' : 'text-kumo-subtle'}>{num(g.failed)}</span> },
      { label: 'Avg', align: 'right', render: (g) => dur(g.avg_ms) },
      { label: 'Max', align: 'right', render: (g) => dur(g.max_ms) },
    ],
    rowColumns: [
      { label: 'Status', render: (r) => <Badge variant={r.failed ? 'error' : 'success'}>{r.failed ? 'failed' : 'sent'}</Badge> },
      { label: 'Subject', render: (r) => <span className="text-sm">{String(r.subject ?? '—')}</span> },
      { label: 'To / CC / BCC', align: 'right', render: (r) => `${num(r.to_count)} / ${num(r.cc_count)} / ${num(r.bcc_count)}` },
      { label: 'Attachments', align: 'right', render: (r) => num(r.attachments) },
      { label: 'Duration', align: 'right', render: (r) => dur(r.duration_ms) },
    ],
    chartDeck: (s, rows) => {
      const sent = Number(s.sent ?? 0);
      const failed = Number(s.failed ?? 0);
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
          barSeries: rows.slice(0, 16).map((r) => ({
            label: splitClassName(r.key).short,
            value: Number(r.count ?? 0),
            highlight: Number(r.failed ?? 0),
          })),
        },
        right: durationCard(rows, s.avg_ms !== undefined ? Number(s.avg_ms) : undefined),
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
    renderKey: renderClassKey,
    columns: [
      { label: 'Channels', render: (g) => <span className="font-mono text-xs text-kumo-subtle">{g.channels ?? '—'}</span> },
      { label: 'Sent', align: 'right', render: (g) => num(g.count) },
      { label: 'Failed', align: 'right', render: (g) => <span className={Number(g.failed) ? 'font-medium text-kumo-danger' : 'text-kumo-subtle'}>{num(g.failed)}</span> },
      { label: 'Avg', align: 'right', render: (g) => dur(g.avg_ms) },
      { label: 'Max', align: 'right', render: (g) => dur(g.max_ms) },
    ],
    rowColumns: [
      { label: 'Status', render: (r) => <Badge variant={r.failed ? 'error' : 'success'}>{r.failed ? 'failed' : 'sent'}</Badge> },
      { label: 'Channel', render: (r) => <span className="font-mono text-xs text-kumo-subtle">{String(r.channel ?? '—')}</span> },
      { label: 'Duration', align: 'right', render: (r) => dur(r.duration_ms) },
    ],
    chartDeck: (s, rows) => {
      const sent = Number(s.sent ?? 0);
      const failed = Number(s.failed ?? 0);
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
          barSeries: rows.slice(0, 16).map((r) => ({
            label: splitClassName(r.key).short,
            value: Number(r.count ?? 0),
            highlight: Number(r.failed ?? 0),
          })),
        },
        right: durationCard(rows, s.avg_ms !== undefined ? Number(s.avg_ms) : undefined),
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
    renderKey: (key) => <span className="font-mono text-xs">{key}</span>,
    columns: [
      { label: 'Cron', render: (g) => <span className="font-mono text-xs text-kumo-subtle">{g.cron ?? '—'}</span> },
      { label: 'Runs', align: 'right', render: (g) => num(g.count) },
      { label: 'Processed', align: 'right', render: (g) => num(g.processed) },
      { label: 'Failed', align: 'right', render: (g) => <span className={Number(g.failed) ? 'font-medium text-kumo-danger' : 'text-kumo-subtle'}>{num(g.failed)}</span> },
      { label: 'Skipped', align: 'right', render: (g) => num(g.skipped) },
      { label: 'Avg', align: 'right', render: (g) => dur(g.avg_ms) },
      { label: 'Max', align: 'right', render: (g) => dur(g.max_ms) },
    ],
    rowColumns: [
      { label: 'Status', render: (r) => <Badge variant={r.status === 'failed' ? 'error' : r.status === 'skipped' ? 'secondary' : 'success'}>{String(r.status ?? '—')}</Badge> },
      { label: 'Cron', render: (r) => <span className="font-mono text-xs text-kumo-subtle">{`${r.cron ?? '—'}${r.timezone ? ` (${r.timezone})` : ''}`}</span> },
      { label: 'Duration', align: 'right', render: (r) => dur(r.duration_ms) },
    ],
    chartDeck: (s, rows) => {
      const runs = Number(s.runs ?? 0);
      const failed = Number(s.failed ?? 0);
      const skipped = Number(s.skipped ?? 0);
      const processed = Math.max(0, runs - failed - skipped);
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
          barSeries: rows.slice(0, 16).map((r) => ({
            label: r.key,
            value: Number(r.count ?? 0),
            warn: Number(r.skipped ?? 0),
            highlight: Number(r.failed ?? 0),
          })),
        },
        right: durationCard(rows, s.avg_ms !== undefined ? Number(s.avg_ms) : undefined),
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
    keyLabel: 'User ID',
    sectionUnit: ['User', 'Users'],
    emptyLabel: 'No users found',
    renderKey: (key) => <span className="font-mono text-xs">{key}</span>,
    columns: [
      { label: 'Name', render: (g) => <span className="text-sm">{g.name ?? '—'}</span> },
      { label: 'Traces', align: 'right', render: (g) => num(g.count) },
      { label: 'Requests', align: 'right', render: (g) => num(g.requests) },
      { label: '5xx', align: 'right', render: (g) => <span className={Number(g.server_errors) ? 'font-medium text-kumo-danger' : 'text-kumo-subtle'}>{num(g.server_errors)}</span> },
      { label: 'Exceptions', align: 'right', render: (g) => <span className={Number(g.exceptions) ? 'font-medium text-kumo-danger' : 'text-kumo-subtle'}>{num(g.exceptions)}</span> },
      { label: 'Avg', align: 'right', render: (g) => dur(g.avg_ms) },
    ],
    rowColumns: [
      { label: 'Status', render: (r) => (r.status_code === null || r.status_code === undefined ? '—' : <Badge variant={Number(r.status_code) >= 500 ? 'error' : Number(r.status_code) >= 400 ? 'warning' : 'success'} className="font-mono">{String(r.status_code)}</Badge>) },
      { label: 'Type', render: (r) => <Badge variant="outline">{String(r.execution_source ?? '—')}</Badge> },
      { label: 'Duration', align: 'right', render: (r) => dur(r.duration_ms) },
    ],
    chartDeck: (s, rows) => {
      const usersCount = Number(s.users ?? rows.length);
      const traces = Number(s.traces ?? 0);
      const exceptions = Number(s.exceptions ?? 0);
      return {
        left: {
          title: 'Authenticated Users',
          value: compact(usersCount),
          kind: 'bar',
          unit: 'requests',
          barSeries: rows.slice(0, 16).map((r) => ({
            label: r.name ? String(r.name) : `#${r.key}`,
            value: Number(r.requests ?? r.count ?? 0),
          })),
        },
        right: {
          title: 'Requests',
          value: compact(traces),
          metrics: [
            { label: 'AUTHENTICATED', value: compact(traces), tone: 'success' },
            { label: 'EXCEPTIONS', value: compact(exceptions), tone: 'error' },
          ],
          kind: 'bar',
          unit: 'traces',
          barSeries: rows.slice(0, 16).map((r) => ({
            label: r.name ? String(r.name) : `#${r.key}`,
            value: Number(r.count ?? 0),
            highlight: Number(r.exceptions ?? 0),
          })),
        },
      };
    },
    filters: [{ param: 'source', label: 'Type', options: ['all', 'request', 'command', 'job', 'schedule'] }],
    searchPlaceholder: 'Search users',
  },
];
