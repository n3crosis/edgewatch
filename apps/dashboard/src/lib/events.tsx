import { Badge } from '@cloudflare/kumo/components/badge';
import {
  ArrowCounterClockwiseIcon,
  BellIcon,
  BriefcaseIcon,
  BugIcon,
  CalendarCheckIcon,
  CheckCircleIcon,
  EnvelopeIcon,
  FastForwardIcon,
  GaugeIcon,
  GitBranchIcon,
  GlobeIcon,
  LightningIcon,
  ListBulletsIcon,
  PencilSimpleIcon,
  QueueIcon,
  SpeedometerIcon,
  TerminalIcon,
  TimerIcon,
  UsersIcon,
  WarningCircleIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import type { ComponentType, ReactNode } from 'react';
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

/** One dashboard view over an event table served by workers/api (see workers/api/src/events.ts). */
export interface EventPage {
  path: string;
  title: string;
  nav: string;
  icon: typeof BriefcaseIcon;
  subtitle: string;
  keyLabel: string;
  isClassKey?: boolean;
  renderKey?: (key: string) => ReactNode;
  columns: EventColumn<EventGroup>[];
  rowColumns: EventColumn<EventRow>[];
  summary?: {
    label: string;
    icon?: ComponentType<{ size?: number; className?: string }>;
    render: (s: Record<string, number>) => ReactNode;
    tone?: (s: Record<string, number>) => 'bad' | 'good' | 'warn' | 'default';
  }[];
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

export const EVENT_PAGES: EventPage[] = [
  {
    path: '/jobs',
    title: 'Jobs',
    nav: 'Jobs',
    icon: BriefcaseIcon,
    subtitle: 'Background jobs grouped by class — click any job to inspect attempts',
    keyLabel: 'Job',
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
    summary: [
      { label: 'Queued', icon: QueueIcon, render: (s) => num(s.queued) },
      { label: 'Attempts', icon: BriefcaseIcon, render: (s) => num(s.attempts) },
      { label: 'Failed', icon: WarningCircleIcon, render: (s) => num(s.failed), tone: (s) => (s.failed ? 'bad' : 'good') },
      { label: 'Released', icon: ArrowCounterClockwiseIcon, render: (s) => num(s.released), tone: (s) => (s.released ? 'warn' : 'default') },
    ],
    filters: [{ param: 'status', label: 'Status', options: ['all', 'processed', 'released', 'failed'] }],
    searchPlaceholder: 'Search job class or queue…',
  },
  {
    path: '/commands',
    title: 'Commands',
    nav: 'Commands',
    icon: TerminalIcon,
    subtitle: 'Artisan command runs grouped by command name',
    keyLabel: 'Command',
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
    summary: [
      { label: 'Runs', icon: TerminalIcon, render: (s) => num(s.runs) },
      { label: 'Failed', icon: WarningCircleIcon, render: (s) => num(s.failed), tone: (s) => (s.failed ? 'bad' : 'good') },
      { label: 'Avg duration', icon: TimerIcon, render: (s) => (s.avg_ms === null || s.avg_ms === undefined ? '—' : ms(Number(s.avg_ms))) },
    ],
    filters: [{ param: 'status', label: 'Status', options: ['all', 'success', 'failed'] }],
    searchPlaceholder: 'Search command…',
  },
  {
    path: '/cache',
    title: 'Cache',
    nav: 'Cache',
    icon: LightningIcon,
    subtitle: 'Cache hits, misses, writes and deletes grouped by key',
    keyLabel: 'Key',
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
    summary: [
      { label: 'Hit ratio', icon: GaugeIcon, render: (s) => pct(s.hit_ratio), tone: (s) => (s.hit_ratio === null || s.hit_ratio === undefined ? 'default' : s.hit_ratio >= 0.8 ? 'good' : s.hit_ratio >= 0.5 ? 'warn' : 'bad') },
      { label: 'Hits', icon: CheckCircleIcon, render: (s) => num(s.hits) },
      { label: 'Misses', icon: LightningIcon, render: (s) => num(s.misses) },
      { label: 'Writes / deletes', icon: PencilSimpleIcon, render: (s) => `${num(s.writes)} / ${num(s.deletes)}` },
    ],
    filters: [{ param: 'type', label: 'Type', options: ['all', 'hit', 'miss', 'write', 'delete', 'write-failure', 'delete-failure'] }],
    searchPlaceholder: 'Search key or store…',
  },
  {
    path: '/outgoing-requests',
    title: 'Outgoing HTTP',
    nav: 'Outgoing HTTP',
    icon: GlobeIcon,
    subtitle: 'HTTP calls your app made to other services, grouped by host',
    keyLabel: 'Host',
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
    summary: [
      { label: 'Requests', icon: GlobeIcon, render: (s) => num(s.requests) },
      { label: 'Failed', icon: WarningCircleIcon, render: (s) => num(s.failed), tone: (s) => (s.failed ? 'bad' : 'good') },
      { label: 'Avg duration', icon: TimerIcon, render: (s) => (s.avg_ms === null || s.avg_ms === undefined ? '—' : ms(Number(s.avg_ms))) },
    ],
    filters: [
      { param: 'method', label: 'Method', options: ['all', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      { param: 'status', label: 'Status', options: ['all', '2xx', '3xx', '4xx', '5xx', 'error'] },
    ],
    searchPlaceholder: 'Search host or URL…',
  },
  {
    path: '/mail',
    title: 'Mail',
    nav: 'Mail',
    icon: EnvelopeIcon,
    subtitle: 'Emails your app sent, grouped by mailable',
    keyLabel: 'Mailable',
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
    summary: [
      { label: 'Sent', icon: EnvelopeIcon, render: (s) => num(s.sent) },
      { label: 'Failed', icon: WarningCircleIcon, render: (s) => num(s.failed), tone: (s) => (s.failed ? 'bad' : 'good') },
      { label: 'Avg duration', icon: TimerIcon, render: (s) => (s.avg_ms === null || s.avg_ms === undefined ? '—' : ms(Number(s.avg_ms))) },
    ],
    filters: [{ param: 'status', label: 'Status', options: ['all', 'sent', 'failed'] }],
    searchPlaceholder: 'Search mailable or subject…',
  },
  {
    path: '/notifications',
    title: 'Notifications',
    nav: 'Notifications',
    icon: BellIcon,
    subtitle: 'Notifications your app sent, grouped by class',
    keyLabel: 'Notification',
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
    summary: [
      { label: 'Sent', icon: BellIcon, render: (s) => num(s.sent) },
      { label: 'Failed', icon: WarningCircleIcon, render: (s) => num(s.failed), tone: (s) => (s.failed ? 'bad' : 'good') },
      { label: 'Avg duration', icon: TimerIcon, render: (s) => (s.avg_ms === null || s.avg_ms === undefined ? '—' : ms(Number(s.avg_ms))) },
    ],
    filters: [
      { param: 'channel', label: 'Channel', options: ['all', 'mail', 'database', 'broadcast', 'slack', 'vonage'] },
      { param: 'status', label: 'Status', options: ['all', 'sent', 'failed'] },
    ],
    searchPlaceholder: 'Search notification or channel…',
  },
  {
    path: '/scheduled-tasks',
    title: 'Scheduled tasks',
    nav: 'Scheduled tasks',
    icon: CalendarCheckIcon,
    subtitle: 'Runs of your scheduled tasks, grouped by task',
    keyLabel: 'Task',
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
    summary: [
      { label: 'Runs', icon: CalendarCheckIcon, render: (s) => num(s.runs) },
      { label: 'Failed', icon: WarningCircleIcon, render: (s) => num(s.failed), tone: (s) => (s.failed ? 'bad' : 'good') },
      { label: 'Skipped', icon: FastForwardIcon, render: (s) => num(s.skipped) },
      { label: 'Avg duration', icon: TimerIcon, render: (s) => (s.avg_ms === null || s.avg_ms === undefined ? '—' : ms(Number(s.avg_ms))) },
    ],
    filters: [{ param: 'status', label: 'Status', options: ['all', 'processed', 'failed', 'skipped'] }],
    searchPlaceholder: 'Search task or cron…',
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
    summary: [
      { label: 'Entries', icon: ListBulletsIcon, render: (s) => num(s.logs) },
      { label: 'Errors', icon: WarningCircleIcon, render: (s) => num(s.errors), tone: (s) => (s.errors ? 'bad' : 'good') },
      { label: 'Warnings', icon: WarningIcon, render: (s) => num(s.warnings), tone: (s) => (s.warnings ? 'warn' : 'good') },
    ],
    filters: [{ param: 'level', label: 'Level', options: ['all', ...LOG_LEVELS] }],
    searchPlaceholder: 'Search message or context…',
  },
  {
    path: '/web-vitals',
    title: 'Web vitals',
    nav: 'Web vitals',
    icon: SpeedometerIcon,
    subtitle: 'Core Web Vitals per page (averages across page loads)',
    keyLabel: 'Page',
    renderKey: (key) => <span className="font-mono text-xs">{key}</span>,
    columns: [
      { label: 'Views', align: 'right', render: (g) => num(g.count) },
      { label: 'LCP', align: 'right', render: (g) => dur(g.lcp_ms) },
      { label: 'INP', align: 'right', render: (g) => dur(g.inp_ms) },
      { label: 'CLS', align: 'right', render: (g) => (g.cls === null || g.cls === undefined ? '—' : <span className="font-mono text-xs">{Number(g.cls).toFixed(3)}</span>) },
      { label: 'LCP good', align: 'right', render: (g) => coloredPct(g.lcp_good, 0.75, 0.5) },
      { label: 'INP good', align: 'right', render: (g) => coloredPct(g.inp_good, 0.75, 0.5) },
      { label: 'CLS good', align: 'right', render: (g) => coloredPct(g.cls_good, 0.75, 0.5) },
    ],
    rowColumns: [
      { label: 'LCP', align: 'right', render: (r) => dur(r.lcp_ms) },
      { label: 'INP', align: 'right', render: (r) => dur(r.inp_ms) },
      { label: 'CLS', align: 'right', render: (r) => (r.cls === null || r.cls === undefined ? '—' : <span className="font-mono text-xs">{Number(r.cls).toFixed(3)}</span>) },
      { label: 'FCP', align: 'right', render: (r) => dur(r.fcp_ms) },
      { label: 'TTFB', align: 'right', render: (r) => dur(r.ttfb_ms) },
    ],
    summary: [
      { label: 'Page views', icon: SpeedometerIcon, render: (s) => num(s.views) },
      { label: 'LCP good', icon: GaugeIcon, render: (s) => pct(s.lcp_good), tone: (s) => (s.lcp_good === null ? 'default' : s.lcp_good >= 0.75 ? 'good' : 'warn') },
      { label: 'INP good', icon: LightningIcon, render: (s) => pct(s.inp_good), tone: (s) => (s.inp_good === null ? 'default' : s.inp_good >= 0.75 ? 'good' : 'warn') },
      { label: 'CLS good', icon: CheckCircleIcon, render: (s) => pct(s.cls_good), tone: (s) => (s.cls_good === null ? 'default' : s.cls_good >= 0.75 ? 'good' : 'warn') },
    ],
    searchPlaceholder: 'Search page path…',
  },
  {
    path: '/users',
    title: 'Users',
    nav: 'Users',
    icon: UsersIcon,
    subtitle: 'Authenticated users and the traces they triggered',
    keyLabel: 'User ID',
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
    summary: [
      { label: 'Users', icon: UsersIcon, render: (s) => num(s.users) },
      { label: 'Traces', icon: GitBranchIcon, render: (s) => num(s.traces) },
      { label: 'Exceptions', icon: BugIcon, render: (s) => num(s.exceptions), tone: (s) => (s.exceptions ? 'bad' : 'good') },
    ],
    filters: [{ param: 'source', label: 'Type', options: ['all', 'request', 'command', 'job', 'schedule'] }],
    searchPlaceholder: 'Search user ID or trace…',
  },
];
