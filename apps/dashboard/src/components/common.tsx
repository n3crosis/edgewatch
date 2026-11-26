import { useEnvironment } from '@/lib/environment';
import Link, { scopedPath } from './ScopedLink';
import { useProject } from '@/lib/project';
import { useRange } from '@/lib/range';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Banner } from '@cloudflare/kumo/components/banner';
import { Button } from '@cloudflare/kumo/components/button';
import { InputGroup } from '@cloudflare/kumo/components/input-group';
import { LayerCard } from '@cloudflare/kumo/components/layer-card';
import { SkeletonLine } from '@cloudflare/kumo/components/loader';
import { useKumoToastManager } from '@cloudflare/kumo/components/toast';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { cn } from '@cloudflare/kumo/utils';
import {
  ArrowClockwiseIcon,
  ArrowUpRightIcon,
  ArrowsLeftRightIcon,
  BriefcaseIcon,
  CalendarCheckIcon,
  CaretDoubleLeftIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CheckIcon,
  CopyIcon,
  MagnifyingGlassIcon,
  TerminalIcon,
  TrayIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ago } from '@/lib/format';
import type { ExecutionSource } from '@/lib/types';
import TelemetryControls from './TelemetryControls';

/**
 * Returns a row click handler that navigates smoothly while ignoring clicks on nested links/buttons,
 * modifier-key clicks, and text selection drags.
 */
export function useRowNavigate() {
  const navigate = useNavigate();
  const { projectId } = useProject();
  const { range } = useRange();
  const { environment } = useEnvironment();
  return (to: string) => (event: MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('a, button, input, select, textarea, [role="button"]')) return;
    if (window.getSelection()?.toString()) return;
    navigate(scopedPath(to, projectId, range, environment));
  };
}

export function PageHeader({
  title,
  documentTitle,
  subtitle,
  back,
  actions,
  hideTelemetryControls = false,
}: {
  title: ReactNode;
  documentTitle?: string;
  subtitle?: ReactNode;
  back?: { to: string; label: string };
  actions?: ReactNode;
  hideTelemetryControls?: boolean;
}) {
  const { projectId, projects } = useProject();
  const pageTitle = documentTitle ?? (typeof title === 'string' ? title : undefined);
  const projectName = projects.find((p) => p.id === projectId)?.name ?? projectId;

  useEffect(() => {
    document.title = pageTitle ? `${pageTitle} · ${projectName} — EdgeWatch` : `${projectName} — EdgeWatch`;
  }, [pageTitle, projectName]);

  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        {back && (
          <nav aria-label="Breadcrumb" className="mb-1.5 flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
            <Link
              to={back.to}
              className="transition-colors hover:text-neutral-900 dark:hover:text-white"
            >
              {back.label}
            </Link>
            <CaretRightIcon size={11} className="shrink-0 text-neutral-400 dark:text-neutral-500" aria-hidden />
            {pageTitle && <span className="truncate font-mono text-neutral-700 dark:text-neutral-300">{pageTitle}</span>}
          </nav>
        )}
        <h1 className="break-words text-xl font-semibold tracking-tight text-neutral-900 md:text-2xl dark:text-white">
          {title}
        </h1>
        {subtitle && <div className="mt-1.5 max-w-3xl text-sm leading-relaxed text-kumo-subtle">{subtitle}</div>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {actions}
        {!hideTelemetryControls && <TelemetryControls />}
      </div>
    </div>
  );
}

/** Capture-exact table section bar: blue icon + count title on the left, inline search/filters on the right. */
export function SectionBar({
  icon,
  title,
  controls,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  controls?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-3 flex flex-col items-start justify-between gap-3 md:flex-row md:items-center md:gap-6', className)}>
      <h2 className="flex shrink-0 items-center gap-2 text-lg font-medium text-neutral-900 dark:text-white [&_svg]:size-4 [&_svg]:text-blue-600 dark:[&_svg]:text-emerald-500">
        {icon}
        <span>{title}</span>
      </h2>
      {controls && <div className="flex w-full flex-wrap items-center justify-end gap-2 md:w-auto">{controls}</div>}
    </div>
  );
}

/** Capture-exact floating card-row container for standalone Kumo tables (no bulky outer frame). */
export function FloatingTablePanel({
  children,
  footer,
  fetching = false,
  className,
}: {
  children: ReactNode;
  footer?: ReactNode;
  fetching?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('relative', className)}>
      {fetching && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden rounded-full bg-blue-600/15" aria-hidden>
          <div className="ew-indeterminate h-full w-1/3 rounded-full bg-blue-600 dark:bg-emerald-500" />
        </div>
      )}
      <div className={cn('ew-floating-table min-w-0 overflow-x-auto transition-opacity duration-150', fetching && 'opacity-65')}>
        {children}
      </div>
      {footer && <div className="mt-2 rounded-lg border border-neutral-200 bg-white dark:border-white/[0.06] dark:bg-white/[0.025]">{footer}</div>}
    </div>
  );
}

/** Signature capture outer frosted tray (`data-slot="card-container"`) wrapping elevated white cards. */
export function CardTray({
  title,
  icon,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  icon?: ReactNode;
  action?: { to: string; label: string } | ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const { projectId } = useProject();
  const { range } = useRange();
  const { environment } = useEnvironment();
  const isLinkAction = action && typeof action === 'object' && 'to' in action && 'label' in action;

  return (
    <section
      data-slot="card-container"
      className={cn(
        'rounded-xl border border-neutral-200/80 bg-white/55 p-1.5 dark:border-white/[0.06] dark:bg-white/[0.03]',
        className,
      )}
    >
      {(title || action) && (
        <div className="flex items-center justify-between gap-3 px-2 pt-1.5 pb-2">
          <div className="flex min-w-0 items-center gap-2.5">
            {icon && (
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-neutral-300/90 bg-white text-neutral-500 dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-400">
                {icon}
              </span>
            )}
            {title && <h2 className="truncate text-base font-medium text-neutral-900 dark:text-white">{title}</h2>}
          </div>
          {isLinkAction ? (
            <Link
              to={scopedPath(action.to, projectId, range, environment)}
              className="group inline-flex h-8 shrink-0 items-center gap-2 rounded-md border border-neutral-200 bg-white/75 px-3 text-sm text-neutral-600 transition-colors hover:border-blue-500 hover:bg-white hover:text-neutral-900 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-neutral-400 dark:hover:border-white/15 dark:hover:bg-neutral-800 dark:hover:text-white"
            >
              <span>{action.label}</span>
              <ArrowUpRightIcon size={14} className="text-neutral-400 transition-colors group-hover:text-blue-600 dark:group-hover:text-white" aria-hidden />
            </Link>
          ) : (
            action && <div className="flex shrink-0 items-center gap-2">{action}</div>
          )}
        </div>
      )}
      {children}
    </section>
  );
}

/** Dedicated, calm container for page-level search and filter controls. */
export function FilterBar({
  children,
  className,
  id,
  tabIndex,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
  tabIndex?: number;
}) {
  return (
    <div
      id={id}
      tabIndex={tabIndex}
      className={cn(
        'mb-5 flex flex-wrap items-center gap-2.5 rounded-xl border border-neutral-200/80 bg-white/60 p-2.5 sm:px-3 dark:border-white/[0.06] dark:bg-white/[0.03]',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Layered card panel matching capture's nested tray + crisp white inner surface. */
export function Panel({
  title,
  description,
  actions,
  children,
  className,
  fetching = false,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  fetching?: boolean;
}) {
  return (
    <div
      data-slot="card-container"
      className={cn(
        'rounded-xl border border-neutral-200/80 bg-white/55 p-1.5 dark:border-white/[0.06] dark:bg-white/[0.03]',
        className,
      )}
    >
      <LayerCard className="ew-panel relative flex flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm shadow-black/[0.04] dark:border-white/[0.06] dark:bg-white/[0.025] dark:shadow-black/20">
        {fetching && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-blue-600/15" aria-hidden>
            <div className="ew-indeterminate h-full w-1/3 rounded-full bg-blue-600 dark:bg-emerald-500" />
          </div>
        )}
        {title && (
          <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-neutral-200/80 px-4 py-3 sm:px-5 dark:border-white/[0.06]">
            <div className="min-w-0">
              <div className="text-[15px] font-medium leading-snug text-neutral-900 dark:text-white">{title}</div>
              {description && <div className="mt-0.5 text-xs text-kumo-subtle">{description}</div>}
            </div>
            {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
          </div>
        )}
        {/* Wide tables scroll horizontally on small screens instead of squashing columns. */}
        <div className={cn('min-w-0 overflow-x-auto transition-opacity duration-150', fetching && 'opacity-65')}>{children}</div>
      </LayerCard>
    </div>
  );
}

const TONES = {
  default: 'text-kumo-strong',
  bad: 'text-kumo-danger',
  warn: 'text-kumo-warning',
  good: 'text-kumo-success',
};

export function Stat({
  label,
  value,
  hint,
  icon,
  tone = 'default',
  to,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: keyof typeof TONES;
  to?: string;
  className?: string;
}) {
  const inner = (
    <LayerCard
      className={cn(
        'flex h-full flex-col justify-between rounded-lg border border-neutral-200 bg-white p-4 shadow-sm shadow-black/[0.04] transition-colors sm:p-5 dark:border-white/[0.06] dark:bg-white/[0.025] dark:shadow-black/20',
        to && 'group-hover:border-blue-400/70 dark:group-hover:border-white/15',
        !to && className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {icon && <span className="shrink-0 text-neutral-400 dark:text-neutral-500" aria-hidden>{icon}</span>}
          <span className="truncate">{label}</span>
        </div>
        {to && (
          <ArrowUpRightIcon
            size={14}
            className="shrink-0 text-neutral-400 opacity-0 transition-all group-hover:text-blue-600 group-hover:opacity-100 dark:group-hover:text-emerald-400"
            aria-hidden
          />
        )}
      </div>
      <div className={cn('mt-2.5 truncate text-2xl font-semibold leading-none tracking-tight tabular-nums', TONES[tone])}>
        {value}
      </div>
      {hint ? (
        <div className="mt-2 truncate text-xs text-kumo-subtle">{hint}</div>
      ) : (
        <div className="mt-2 h-4" aria-hidden />
      )}
    </LayerCard>
  );
  if (to) {
    return (
      <Link to={to} className={cn('group block rounded-lg focus-visible:outline-2 focus-visible:outline-kumo-link', className)}>
        {inner}
      </Link>
    );
  }
  return inner;
}

export function StatusBadge({ status, source }: { status: number | null; source: ExecutionSource }) {
  if (source !== 'request') {
    const ok = status === 0 || status === null;
    return <Badge variant={ok ? 'success' : 'error'} className="font-mono">{ok ? 'OK' : `exit ${status}`}</Badge>;
  }
  const s = status ?? 0;
  const variant = s >= 500 ? 'error' : s >= 400 ? 'warning' : s >= 300 ? 'info' : 'success';
  return <Badge variant={variant} className="font-mono">{s}</Badge>;
}

const SOURCE_META = {
  request: { variant: 'info', label: 'Request', icon: ArrowsLeftRightIcon },
  job: { variant: 'secondary', label: 'Job', icon: BriefcaseIcon },
  command: { variant: 'outline', label: 'Command', icon: TerminalIcon },
  schedule: { variant: 'warning', label: 'Scheduled', icon: CalendarCheckIcon },
} as const satisfies Record<ExecutionSource, { variant: 'info' | 'secondary' | 'outline' | 'warning' | 'beta'; label: string; icon: typeof ArrowsLeftRightIcon }>;

export function SourceBadge({ source }: { source: ExecutionSource }) {
  const meta = SOURCE_META[source];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} className="inline-flex items-center gap-1.5">
      <Icon size={12} aria-hidden />
      <span>{meta.label}</span>
    </Badge>
  );
}

const METHOD_VARIANTS: Record<string, 'info' | 'success' | 'warning' | 'error' | 'secondary'> = {
  GET: 'secondary',
  HEAD: 'secondary',
  OPTIONS: 'secondary',
  POST: 'success',
  PUT: 'info',
  PATCH: 'info',
  DELETE: 'error',
};

export function MethodBadge({ method }: { method: string }) {
  const upper = method.toUpperCase();
  return <Badge variant={METHOD_VARIANTS[upper] ?? 'secondary'} className="font-mono">{upper}</Badge>;
}

export function TimeAgo({ iso, className }: { iso: string; className?: string }) {
  const formatted = new Date(iso).toLocaleString();
  return (
    <Tooltip asChild content={formatted}>
      <time dateTime={iso} className={cn('cursor-default whitespace-nowrap font-mono tabular-nums text-kumo-subtle', className)}>
        {ago(iso)}
      </time>
    </Tooltip>
  );
}

export function CopyButton({
  text,
  label = 'Copy',
  toastMessage = 'Copied to clipboard.',
  className,
}: {
  text: string;
  label?: string;
  toastMessage?: string;
  className?: string;
}) {
  const toasts = useKumoToastManager();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toasts.add({ title: toastMessage, variant: 'success' });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toasts.add({ title: 'Could not copy. Select and copy the text manually.', variant: 'error' });
    }
  };
  return (
    <Tooltip content={copied ? 'Copied' : label} asChild>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        shape="square"
        className={className}
        onClick={copy}
        aria-label={label}
        icon={copied ? CheckIcon : CopyIcon}
      />
    </Tooltip>
  );
}

export function PaginationBar({
  onFirst,
  firstDisabled,
  firstLabel = 'Newest',
  onPrevious,
  previousDisabled,
  previousLabel = 'Previous',
  onNext,
  nextDisabled,
  nextLabel = 'Next',
  status,
}: {
  onFirst?: () => void;
  firstDisabled?: boolean;
  firstLabel?: string;
  onPrevious?: () => void;
  previousDisabled?: boolean;
  previousLabel?: string;
  onNext?: () => void;
  nextDisabled?: boolean;
  nextLabel?: string;
  status?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-t border-neutral-200/80 px-4 py-3 sm:px-5 dark:border-white/[0.06]">
      <div className="font-mono text-xs text-kumo-subtle">{status}</div>
      <div className="flex items-center gap-2">
        {onFirst && (
          <Button variant="secondary" size="sm" icon={CaretDoubleLeftIcon} disabled={firstDisabled} onClick={onFirst}>
            {firstLabel}
          </Button>
        )}
        {onPrevious && (
          <Button variant="secondary" size="sm" icon={CaretLeftIcon} disabled={previousDisabled} onClick={onPrevious}>
            {previousLabel}
          </Button>
        )}
        {onNext && (
          <Button variant="secondary" size="sm" disabled={nextDisabled} onClick={onNext}>
            {nextLabel}
            <CaretRightIcon />
          </Button>
        )}
      </div>
    </div>
  );
}

/** Table-shaped skeleton: a header line, then rows of varying width. */
export function Loading({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-4 p-6" role="status" aria-label="Loading">
      <SkeletonLine minWidth={25} maxWidth={40} />
      {Array.from({ length: rows }, (_, i) => <SkeletonLine key={i} minWidth={60} maxWidth={100} />)}
    </div>
  );
}

/** Page-shaped skeleton (stat cards, two charts, a table) so the layout does not jump when data arrives. */
export function PageSkeleton({ stats = 5 }: { stats?: number }) {
  const cols = stats === 4 ? 'sm:grid-cols-2 xl:grid-cols-4' : stats === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5';
  return (
    <div role="status" aria-label="Loading">
      <div className="mb-6 space-y-2">
        <div className="w-44"><SkeletonLine blockHeight={26} /></div>
        <div className="w-72"><SkeletonLine blockHeight={15} /></div>
      </div>
      <div className="rounded-xl border border-neutral-200/80 bg-white/55 p-1.5 dark:border-white/[0.06] dark:bg-white/[0.03]">
        <div className="grid gap-2 xl:grid-cols-2">
          {[0, 1].map((i) => (
            <LayerCard key={i} className="rounded-lg border border-neutral-200 bg-white p-5 dark:border-white/[0.06] dark:bg-white/[0.025]">
              <SkeletonLine blockHeight={200} />
            </LayerCard>
          ))}
        </div>
      </div>
      <div className={cn('mt-5 grid grid-cols-1 gap-3', cols)}>
        {Array.from({ length: stats }, (_, i) => (
          <LayerCard key={i} className="space-y-3 rounded-lg border border-neutral-200 bg-white p-5 dark:border-white/[0.06] dark:bg-white/[0.025]">
            <SkeletonLine minWidth={40} maxWidth={60} />
            <SkeletonLine blockHeight={24} minWidth={45} maxWidth={70} />
            <SkeletonLine minWidth={30} maxWidth={50} />
          </LayerCard>
        ))}
      </div>
      <div className="mt-5 rounded-xl border border-neutral-200/80 bg-white/55 p-1.5 dark:border-white/[0.06] dark:bg-white/[0.03]">
        <LayerCard className="rounded-lg border border-neutral-200 bg-white dark:border-white/[0.06] dark:bg-white/[0.025]">
          <Loading rows={5} />
        </LayerCard>
      </div>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const { refresh } = useRange();
  const retry = onRetry ?? refresh;
  return (
    <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <Banner variant="error" icon={<WarningCircleIcon />} title="Could not load data" description={error.message} />
      </div>
      <Button variant="secondary" size="sm" icon={ArrowClockwiseIcon} onClick={retry} className="shrink-0 self-start sm:self-center">
        Retry
      </Button>
    </div>
  );
}

const MATRIX_ROWS = [
  'E{)7GTTS\\8   YZTIMIS:400Q   CJZOS6Y_CWK+K;{   {J]XB{9EH>L3KLQ   M/{JK   MCU|A   ]5.TK   Q0LY-KPHILLIP=I3$WY//]',
  '/CV]9   U-DSJKTAYLORP#[   %|R<89J,BO   ?3VNN|92Q%MN3I=   BQU{}   AXKRYUTA@   0WRWYM&JESSIAFYH_IY.0#Y   ;+A%B',
  '{   X3<-7   \'G)DJ   +J\'YM4/R20NXSH\\   O[VRW   UQQ9YCZ1X*R1{PO   |EZ{@V5J>Z?\\3J   T%L;SNWX\'=   ET%MJ   ^TAYLOR',
  'DLAN<   \\FP%Q   J@J\'|   {AVF(   .JPDE   QY7OP   IIYN$+   $9CSJ   T|7T\\   D*4072>3X^A[]ML   =<580Y   RV2<8VC(',
];

export function Empty({
  children,
  description,
  action,
  icon,
  variant = 'matrix',
}: {
  children: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
  variant?: 'matrix' | 'clean';
}) {
  if (variant === 'clean') {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
        <div className="mb-3">{icon ?? <TrayIcon size={28} className="text-kumo-subtle" />}</div>
        <div className="text-sm font-medium text-neutral-900 dark:text-white">{children}</div>
        {description && <p className="mt-1.5 max-w-md text-xs leading-relaxed text-kumo-subtle">{description}</p>}
        {action && <div className="mt-4">{action}</div>}
      </div>
    );
  }

  return (
    <div className="relative flex min-h-52 flex-col items-center justify-center overflow-hidden rounded-lg border border-neutral-200 bg-white px-5 py-12 text-center dark:border-white/[0.06] dark:bg-white/[0.025]">
      {/* Capture-exact deterministic monospace hash-matrix backdrop (`TableEmptyState`) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 flex flex-col justify-between overflow-hidden px-4 py-2.5 font-mono text-xs leading-7 tracking-widest text-neutral-300/60 select-none dark:text-neutral-700/45"
        style={{ maskImage: 'radial-gradient(ellipse 85% 85% at 50% 50%, black 45%, transparent 100%)' }}
      >
        {[...MATRIX_ROWS, ...MATRIX_ROWS].map((row, idx) => (
          <div key={idx} className="truncate whitespace-nowrap">
            {row}
          </div>
        ))}
      </div>
      <div className="relative z-10 flex flex-col items-center gap-2">
        <div className="inline-flex items-center gap-1.5 rounded-[3px] bg-yellow-300 px-2 py-0.5 font-mono text-xs font-medium uppercase tracking-wider text-neutral-950 dark:bg-amber-400 dark:text-neutral-950">
          <span>{children.replace(/\.$/, '')}</span>
        </div>
        <div className="max-w-lg rounded-[3px] bg-neutral-950 px-2.5 py-0.5 font-mono text-xs uppercase tracking-wider text-white dark:bg-neutral-200 dark:text-neutral-950">
          {description ?? 'Try adjusting any filters or time range'}
        </div>
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}

const SQL_KEYWORDS = /(\b(?:select|from|where|and|or|in|insert into|values|update|set|delete|inner join|left join|on|group by|order by|limit|offset|for update|as|is null|desc|asc|count|sum|exists)\b|\?)/gi;

export function Sql({ sql, className = '' }: { sql: string; className?: string }) {
  return (
    <code className={cn('font-mono text-xs leading-relaxed', className)}>
      {sql.split(SQL_KEYWORDS).map((p, i) =>
        p === '?' ? (
          <span key={i} className="text-kumo-warning">?</span>
        ) : i % 2 === 1 ? (
          <span key={i} className="text-kumo-link">{p}</span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </code>
  );
}

const DEBOUNCE_MS = 180;

export function SearchBox({
  value,
  onChange,
  placeholder,
  className = 'w-full sm:w-80',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const commit = (next: string, immediate = false) => {
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    if (immediate) {
      onChange(next);
    } else {
      timer.current = setTimeout(() => onChange(next), DEBOUNCE_MS);
    }
  };

  return (
    <InputGroup className={cn('h-8 bg-white dark:bg-white/[0.03]', className)}>
      <InputGroup.Addon align="start">
        <MagnifyingGlassIcon size={14} className="text-neutral-400 dark:text-neutral-500" />
      </InputGroup.Addon>
      <InputGroup.Input
        value={draft}
        onChange={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(draft, true);
          else if (e.key === 'Escape' && draft) commit('', true);
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-8 text-sm"
      />
      {draft && (
        <InputGroup.Addon align="end">
          <button
            type="button"
            onClick={() => commit('', true)}
            aria-label="Clear search"
            className="grid size-5 place-items-center rounded text-kumo-subtle transition-colors hover:text-kumo-strong"
          >
            <XIcon size={12} />
          </button>
        </InputGroup.Addon>
      )}
    </InputGroup>
  );
}
