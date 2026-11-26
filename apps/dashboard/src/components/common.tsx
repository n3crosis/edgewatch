import { useEnvironment } from '@/lib/environment';
import { useLayoutScroll, useLocalPreferences } from '@/lib/preferences';
import Link, { scopedPath } from './ScopedLink';
import { useProject } from '@/lib/project';
import { useRange } from '@/lib/range';
import { ChartSyncProvider } from './charts';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Banner } from '@cloudflare/kumo/components/banner';
import { Button } from '@cloudflare/kumo/components/button';
import { InputGroup } from '@cloudflare/kumo/components/input-group';
import { LayerCard } from '@cloudflare/kumo/components/layer-card';
import { SkeletonLine } from '@cloudflare/kumo/components/loader';
import { Popover } from '@cloudflare/kumo/components/popover';
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
  SidebarSimpleIcon,
  TerminalIcon,
  TrayIcon,
  WarningCircleIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ago, compact, ms } from '@/lib/format';
import type { ExecutionSource } from '@/lib/types';
import { chartFooterDate } from './charts';
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
  leftSlot,
  actions,
  hideTitle = false,
  hideTelemetryControls = false,
}: {
  title: ReactNode;
  documentTitle?: string;
  subtitle?: ReactNode;
  back?: { to: string; label: string };
  leftSlot?: ReactNode;
  actions?: ReactNode;
  hideTitle?: boolean;
  hideTelemetryControls?: boolean;
}) {
  const { projectId, projects } = useProject();
  const { isScrolled } = useLayoutScroll();
  const pageTitle = documentTitle ?? (typeof title === 'string' ? title : undefined);
  const projectName = projects.find((p) => p.id === projectId)?.name ?? projectId;

  useEffect(() => {
    document.title = pageTitle ? `${pageTitle} · ${projectName} — EdgeWatch` : `${projectName} — EdgeWatch`;
  }, [pageTitle, projectName]);

  return (
    <>
      {back && (
        <nav aria-label="Breadcrumb" className="!mb-1 flex items-center gap-1.5 text-sm text-neutral-600 dark:text-neutral-400">
          <Link
            to={back.to}
            className="transition-colors hover:text-blue-600 dark:hover:text-emerald-500"
          >
            {back.label}
          </Link>
          <CaretRightIcon size={13} className="shrink-0 text-neutral-500 dark:text-neutral-500" aria-hidden />
          {pageTitle && <span className="truncate font-mono text-xs text-neutral-700 dark:text-neutral-300">{pageTitle}</span>}
        </nav>
      )}
      {/* 1:1 Nightwatch `AuthenticatedLayout-CCFtg7gs.js` sticky frosted header with shrinking title on scroll */}
      <header
        className={cn(
          'sticky top-0 z-30 -mx-5 !mb-3 flex min-h-12 flex-col justify-center gap-3 border-b px-5 py-1.5 transition-colors duration-150 sm:flex-row sm:items-center sm:justify-between sm:gap-6 md:min-h-14 xl:-mx-10 xl:px-10',
          isScrolled
            ? 'border-neutral-200 bg-white/60 backdrop-blur-md dark:border-white/5 dark:bg-neutral-900/70'
            : 'border-transparent bg-transparent',
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {!hideTitle && (
            <h1
              className={cn(
                'break-words font-semibold text-neutral-900 transition-all duration-100 ease-in-out dark:text-white',
                isScrolled ? 'text-lg md:text-xl' : 'text-xl md:text-2xl',
              )}
            >
              {title}
            </h1>
          )}
          {leftSlot}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
          {!hideTelemetryControls && <TelemetryControls />}
        </div>
      </header>
      {subtitle && <div className="!-mt-1 !mb-2 max-w-3xl text-sm leading-relaxed text-kumo-subtle">{subtitle}</div>}
    </>
  );
}

export interface SegmentedOption {
  value: string;
  label: string;
  count?: { value: number; tone?: 'default' | 'warning' | 'error' };
}

/** 1:1 Nightwatch `ToggleGroup-CSdg-TYt.js` + `ToggleFilter-BjlkNkYQ.js` segmented control with inline count pills. */
export function SegmentedToggle({
  value,
  onChange,
  options,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SegmentedOption[];
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      className={cn(
        'relative inline-flex h-8 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-200/40 p-0.5 dark:border-neutral-700/50 dark:bg-neutral-800',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        const badgeTone = option.count?.tone ?? 'default';
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex h-full items-center justify-center gap-2 whitespace-nowrap rounded-md px-2.5 text-sm transition-colors',
              active
                ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-neutral-100'
                : 'text-neutral-600 hover:bg-neutral-200/30 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-900/20 dark:hover:text-neutral-100',
            )}
          >
            <span>{option.label}</span>
            {option.count !== undefined && option.count.value > 0 && (
              <span
                className={cn(
                  '-mr-0.5 inline-flex h-4.5 min-w-4.5 items-center justify-center rounded px-1 font-sans text-[11px] leading-none font-medium tabular-nums',
                  badgeTone === 'error'
                    ? 'bg-rose-500 text-white'
                    : badgeTone === 'warning'
                      ? 'bg-amber-500 text-white'
                      : active
                        ? 'bg-neutral-200/80 text-neutral-800 dark:bg-neutral-600 dark:text-white'
                        : 'bg-black/[0.07] text-neutral-700 dark:bg-white/10 dark:text-neutral-200',
                )}
              >
                {option.count.value.toLocaleString()}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** 1:1 Nightwatch sortable column header label with dual sort triangles (`Table-yTpK8UQF.js` `P`). */
export function SortableLabel({
  active,
  direction = 'desc',
  align = 'right',
  onClick,
  children,
}: {
  active: boolean;
  direction?: 'asc' | 'desc';
  align?: 'left' | 'right';
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2 uppercase transition-colors hover:text-neutral-900 dark:hover:text-white',
        align === 'right' && 'justify-end',
        active && 'text-neutral-900 dark:text-white',
      )}
    >
      <span className="relative flex items-center pr-3">
        {children}
        <span className="absolute right-0 flex flex-col gap-[2px]" aria-hidden>
          <span
            className={cn(
              'inline-block h-0 w-0 border-x-[3.5px] border-b-[4px] border-x-transparent',
              active && direction === 'asc'
                ? 'border-b-blue-500 dark:border-b-white'
                : 'border-b-neutral-300 dark:border-b-neutral-600',
            )}
          />
          <span
            className={cn(
              'inline-block h-0 w-0 rotate-180 border-x-[3.5px] border-b-[4px] border-x-transparent',
              active && direction === 'desc'
                ? 'border-b-blue-500 dark:border-b-white'
                : 'border-b-neutral-300 dark:border-b-neutral-600',
            )}
          />
        </span>
      </span>
    </button>
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
    <div className={cn('mb-4 flex flex-col items-start justify-between gap-2 md:flex-row md:items-center md:gap-12', className)}>
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
    <ChartSyncProvider>
      <section
        data-slot="card-container"
        className={cn(
          'grid gap-2 rounded-xl border border-neutral-200/70 bg-white/50 p-1.5 dark:border-white/[0.05] dark:bg-white/[0.03]',
          className,
        )}
      >
        {(title || action) && (
          <div className="flex items-center justify-between gap-3 p-2 pb-1.5">
            <div className="flex min-w-0 items-center gap-2.5">
              {icon && (
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-neutral-300 bg-white text-neutral-400 dark:border-white/10 dark:bg-neutral-700/75 dark:text-neutral-400 [&_svg]:size-3">
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
    </ChartSyncProvider>
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
    return (
      <span
        className={cn(
          'inline-flex items-center rounded px-1.5 py-0.5 font-mono text-xs font-semibold uppercase',
          ok
            ? 'bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300'
            : 'bg-rose-600 text-white',
        )}
      >
        {ok ? 'OK' : `exit ${status}`}
      </span>
    );
  }
  const s = status ?? 0;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 font-mono text-xs font-semibold tabular-nums',
        s >= 500
          ? 'bg-rose-600 text-white'
          : s >= 400
            ? 'bg-amber-500/15 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300'
            : 'bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
      )}
    >
      {s}
    </span>
  );
}

/** 1:1 Capture table status code (`StatusCode-DK2EgVE-.js`): plain emerald/orange bold mono text, solid rose badge on 5xx. */
export function StatusCodeText({ status, source = 'request' }: { status: number | null; source?: ExecutionSource }) {
  if (source !== 'request') {
    const ok = status === 0 || status === null;
    return ok ? (
      <span className="font-mono text-xs font-semibold text-emerald-600 dark:text-emerald-500">OK</span>
    ) : (
      <span className="inline-flex items-center rounded bg-rose-600 px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase text-white">
        {`exit ${status}`}
      </span>
    );
  }
  const s = status ?? 0;
  if (s >= 500) {
    return (
      <span className="inline-flex items-center rounded bg-rose-600 px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-white">
        {s}
      </span>
    );
  }
  return (
    <span
      className={cn(
        'font-mono text-xs font-semibold tabular-nums',
        s >= 400 ? 'text-orange-500 dark:text-orange-400' : 'text-emerald-600 dark:text-emerald-500',
      )}
    >
      {s}
    </span>
  );
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

/** 1:1 Capture bordered uppercase source chip (`REQUEST`, `JOB`, `COMMAND`, `SCHEDULE`) used in Logs/Queries/Issues tables. */
export function SourceTag({ source }: { source: string }) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center rounded border border-neutral-200 bg-white px-1.5 font-mono text-[10px] font-medium uppercase tracking-wide text-neutral-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-neutral-400">
      {source}
    </span>
  );
}

/** 1:1 Capture plain colored monospace HTTP method for table rows (`HttpMethod-CaZTeVJx.js`). */
export function HttpMethodText({ method, className }: { method: string; className?: string }) {
  const upper = method.toUpperCase();
  const tone =
    upper === 'POST'
      ? 'text-emerald-600 dark:text-emerald-500'
      : upper === 'PUT' || upper === 'PATCH'
        ? 'text-blue-500 dark:text-blue-400'
        : upper === 'DELETE'
          ? 'text-rose-600 dark:text-rose-400'
          : 'text-neutral-500 dark:text-neutral-400';
  return <span className={cn('font-mono text-xs font-semibold whitespace-nowrap', tone, className)}>{upper}</span>;
}

/** 1:1 Capture soft-tinted HTTP method badge for detail page headers (`HttpMethod-CaZTeVJx.js`). */
export function MethodBadge({ method }: { method: string }) {
  const upper = method.toUpperCase();
  const tone =
    upper === 'POST'
      ? 'bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300'
      : upper === 'PUT' || upper === 'PATCH'
        ? 'bg-blue-500/15 text-blue-600 dark:bg-blue-500/20 dark:text-blue-300'
        : upper === 'DELETE'
          ? 'bg-rose-500/15 text-rose-600 dark:bg-rose-500/20 dark:text-rose-300'
          : 'bg-neutral-200/70 text-neutral-700 dark:bg-white/10 dark:text-neutral-300';
  return (
    <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 font-mono text-xs font-semibold uppercase', tone)}>
      {upper}
    </span>
  );
}

/** 1:1 Capture amber triangle warning counter cell (`4XX`, `RELEASED`, `SKIPPED`). */
export function WarningCount({ count }: { count: number }) {
  if (!count) return <span className="font-mono text-xs tabular-nums text-neutral-500 dark:text-neutral-500">0</span>;
  return (
    <span className="inline-flex items-center justify-end gap-1.5 font-mono text-xs font-medium tabular-nums text-amber-600 dark:text-amber-400">
      <WarningIcon size={13} weight="fill" className="shrink-0 text-amber-500" aria-hidden />
      <span>{count.toLocaleString()}</span>
    </span>
  );
}

/** 1:1 Capture rose alert-circle error counter cell (`5XX`, `FAILED`, `EXCEPTIONS`). */
export function ErrorCount({ count }: { count: number }) {
  if (!count) return <span className="font-mono text-xs tabular-nums text-neutral-500 dark:text-neutral-500">0</span>;
  return (
    <span className="inline-flex items-center justify-end gap-1.5 font-mono text-xs font-medium tabular-nums text-rose-600 dark:text-rose-400">
      <WarningCircleIcon size={13} weight="fill" className="shrink-0 text-rose-500" aria-hidden />
      <span>{count.toLocaleString()}</span>
    </span>
  );
}

/** 1:1 Nightwatch `Table-DS6Cy-yG.js` right-aligned row action pill (`[Preview] [View ↗]`). */
export function RowActionLink({
  to,
  label = 'View',
  onPreview,
}: {
  to: string;
  label?: string;
  onPreview?: () => void;
}) {
  return (
    <div className="inline-flex items-center justify-end">
      <div className="inline-flex items-center rounded-sm border border-neutral-200/70 bg-neutral-50/70 text-neutral-500 transition-colors hover:border-neutral-300 dark:border-white/[0.08] dark:bg-white/[0.02] dark:text-neutral-400 dark:hover:border-white/20">
        {onPreview && (
          <Tooltip content="Preview" asChild>
            <button
              type="button"
              aria-label="Preview"
              onClick={(e) => {
                e.stopPropagation();
                onPreview();
              }}
              className="inline-flex size-6 items-center justify-center rounded-l-sm transition-colors hover:bg-white hover:text-blue-600 dark:hover:bg-white/[0.06] dark:hover:text-emerald-400"
            >
              <SidebarSimpleIcon size={13} aria-hidden />
            </button>
          </Tooltip>
        )}
        <Tooltip content="View" asChild>
          <Link
            to={to}
            aria-label={label}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'inline-flex size-6 items-center justify-center transition-colors hover:bg-white hover:text-blue-600 dark:hover:bg-white/[0.06] dark:hover:text-white',
              onPreview ? 'rounded-r-sm border-l border-neutral-200/70 dark:border-white/[0.08]' : 'rounded-sm',
            )}
          >
            <ArrowUpRightIcon size={13} aria-hidden />
          </Link>
        </Tooltip>
      </div>
    </div>
  );
}

function localTzShort(): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? 'LOCAL';
  } catch {
    return 'LOCAL';
  }
}

function localTzName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local';
  } catch {
    return 'Local';
  }
}

function formatDateTimeMs(iso: string, utc: boolean): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (utc) {
    return `${pad(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
  }
  return `${pad(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function formatLocalDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${pad(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function MiniCopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1000);
        });
      }}
      className="inline-flex shrink-0 items-center justify-center rounded p-0.5 text-neutral-400 transition-colors hover:text-white"
    >
      {copied ? <CheckIcon size={12} weight="bold" className="text-emerald-400" aria-hidden /> : <CopyIcon size={12} aria-hidden />}
    </button>
  );
}

/** Shared hover-activated interactive dark popover (Nightwatch `Date-Dpo70E7n.js` & `Duration-CWrOZ_r-.js`). */
function HoverPopover({
  trigger,
  content,
  delayMs = 300,
  side = 'top',
  popupClassName,
}: {
  trigger: ReactNode;
  content: ReactNode;
  delayMs?: number;
  side?: 'top' | 'bottom';
  popupClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };

  useEffect(() => clearTimers, []);

  const scheduleOpen = () => {
    clearTimers();
    openTimer.current = setTimeout(() => setOpen(true), delayMs);
  };

  const scheduleClose = () => {
    clearTimers();
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            onMouseEnter={scheduleOpen}
            onMouseLeave={scheduleClose}
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
            className="inline-flex items-center bg-transparent p-0 text-inherit"
          >
            {trigger}
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side={side} align="center" sideOffset={8}>
          <Popover.Popup
            onMouseEnter={clearTimers}
            onMouseLeave={scheduleClose}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'z-50 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900 p-0 text-white shadow-2xl shadow-black/50 dark:border-neutral-700/50 dark:bg-neutral-800',
              popupClassName,
            )}
          >
            {content}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function RichDatePopupContent({ iso, showDefaultToggle }: { iso: string; showDefaultToggle: boolean }) {
  const { showUtc, setShowUtc } = useLocalPreferences();
  const utcMs = formatDateTimeMs(iso, true);
  const localMs = formatDateTimeMs(iso, false);
  const tzShort = localTzShort();
  const tzName = localTzName();
  const relative = ago(iso);

  return (
    <div className="min-w-[260px] font-mono">
      <div className="grid gap-3.5 p-3.5 pr-4">
        <div className="grid gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-xs/none text-neutral-400">UTC</span>
            <MiniCopyButton value={`${utcMs} UTC`} label="Copy UTC datetime" />
          </div>
          <span className="text-xs/none text-white">{utcMs}</span>
        </div>
        <div className="grid gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-xs/none text-neutral-400">{tzName}</span>
            <MiniCopyButton value={`${localMs} ${tzShort}`} label="Copy local datetime" />
          </div>
          <span className="text-xs/none text-white">{localMs}</span>
        </div>
        <div className="grid gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-xs/none text-neutral-400">Time ago</span>
            <MiniCopyButton value={relative} label="Copy time ago" />
          </div>
          <span className="text-xs/none text-white first-letter:uppercase">{relative}</span>
        </div>
      </div>

      {showDefaultToggle && (
        <div className="flex items-center justify-between gap-3 border-t border-white/10 bg-white/[0.03] px-3.5 py-2.5">
          <span className="text-xs/none text-neutral-400">DEFAULT</span>
          <div className="flex overflow-hidden rounded-md border border-white/20 bg-neutral-900">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowUtc(true);
              }}
              className={cn(
                'flex w-13 items-center justify-center rounded-sm px-1 py-1 text-[11px] transition-colors',
                showUtc ? 'bg-white text-neutral-900 font-medium' : 'bg-transparent text-neutral-400 hover:bg-neutral-800',
              )}
            >
              UTC
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowUtc(false);
              }}
              className={cn(
                'flex w-13 items-center justify-center rounded-sm px-1 py-1 text-[11px] transition-colors',
                !showUtc ? 'bg-white text-neutral-900 font-medium' : 'bg-transparent text-neutral-400 hover:bg-neutral-800',
              )}
            >
              LOCAL
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 1:1 Nightwatch `Date-Dpo70E7n.js` timestamp with interactive UTC/Local copy tooltip & global UTC/LOCAL preference toggle. */
export function UtcDate({ iso, className }: { iso: string; className?: string }) {
  const { showUtc } = useLocalPreferences();
  const display = showUtc ? chartFooterDate(iso) : formatLocalDate(iso);
  const tz = showUtc ? 'UTC' : localTzShort();
  return (
    <HoverPopover
      delayMs={350}
      trigger={
        <time
          dateTime={iso}
          className={cn('cursor-default whitespace-nowrap font-mono text-xs tabular-nums text-neutral-900 dark:text-neutral-200', className)}
        >
          {display}
          <span className="ml-1 text-neutral-400 dark:text-neutral-500">{tz}</span>
        </time>
      }
      content={<RichDatePopupContent iso={iso} showDefaultToggle />}
    />
  );
}

/** 1:1 Capture dotted-leader key-value description list (`DescriptionList-jv5GUTHT.js`). */
export function DescriptionList({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn('flex max-w-full flex-col gap-3 text-sm', className)}>{children}</dl>;
}

export function DescriptionRow({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex max-w-full items-baseline gap-1', className)}>
      <dt className="shrink-0 font-mono text-xs font-medium uppercase text-neutral-600 md:h-6 dark:text-neutral-400">
        {label}
      </dt>
      <div className="relative -bottom-px min-w-6 grow border-b-2 border-dotted border-neutral-300 dark:border-white/20" aria-hidden />
      <dd className="min-w-0 truncate text-right font-mono text-sm text-neutral-900 dark:text-white">{children}</dd>
    </div>
  );
}

/** 1:1 Nightwatch `Date-Dpo70E7n.js` relative timestamp with interactive UTC/Local/TimeAgo copy tooltip. */
export function TimeAgo({ iso, className }: { iso: string; className?: string }) {
  return (
    <HoverPopover
      delayMs={350}
      trigger={
        <time dateTime={iso} className={cn('cursor-default whitespace-nowrap font-mono tabular-nums text-kumo-subtle', className)}>
          {ago(iso)}
        </time>
      }
      content={<RichDatePopupContent iso={iso} showDefaultToggle={false} />}
    />
  );
}

/** 1:1 Nightwatch `PrettyLargeNumberTooltip-CU8S_mRH.js`: shows compact number with exact value tooltip when >= 1,000. */
export function CompactNumber({ value, className }: { value: number; className?: string }) {
  if (value < 1000) {
    return <span className={cn('tabular-nums', className)}>{compact(value)}</span>;
  }
  return (
    <Tooltip content={value.toLocaleString()} asChild>
      <span className={cn('cursor-default tabular-nums', className)}>{compact(value)}</span>
    </Tooltip>
  );
}

/** 1:1 Nightwatch `Duration-CWrOZ_r-.js` hover card displaying Min / Avg / P95 / Max breakdown. */
export function DurationHover({
  value,
  min,
  avg,
  p95,
  max,
  className,
}: {
  value: number | null;
  min?: number | null;
  avg?: number | null;
  p95?: number | null;
  max?: number | null;
  className?: string;
}) {
  const rows = [
    min !== undefined ? { label: 'Min', val: min } : null,
    avg !== undefined ? { label: 'Avg', val: avg } : null,
    p95 !== undefined ? { label: 'P95', val: p95 } : null,
    max !== undefined ? { label: 'Max', val: max } : null,
  ].filter((r): r is { label: string; val: number | null } => r !== null);

  const label = value === null ? '—' : ms(value);
  if (rows.length <= 1) {
    return <span className={cn('font-mono tabular-nums', className)}>{label}</span>;
  }

  return (
    <HoverPopover
      delayMs={200}
      popupClassName="min-w-[170px]"
      trigger={<span className={cn('cursor-default font-mono tabular-nums', className)}>{label}</span>}
      content={
        <dl className="grid gap-1.5 p-2.5 font-mono text-xs">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-4">
              <dt className="uppercase text-neutral-400">{row.label}</dt>
              <dd className="tabular-nums text-white">{row.val === null ? 'N/A' : ms(row.val)}</dd>
            </div>
          ))}
        </dl>
      }
    />
  );
}

/** 1:1 Nightwatch `Total-D-CPdEcd.js` status count with hover card showing exact count, % of total, and progress bar. */
export function StatusCountHover({
  value,
  total,
  variant = 'default',
  to,
}: {
  value: number;
  total: number;
  variant?: 'default' | 'warning' | 'error';
  to?: string;
}) {
  if (value === 0) {
    return <span className="font-mono text-xs tabular-nums text-neutral-500 dark:text-neutral-500">0</span>;
  }
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  const textTone =
    variant === 'warning'
      ? 'text-amber-600 dark:text-amber-400'
      : variant === 'error'
        ? 'text-rose-600 dark:text-rose-400'
        : 'text-neutral-900 dark:text-neutral-100';
  const barTone =
    variant === 'warning'
      ? 'bg-amber-500 dark:bg-amber-400'
      : variant === 'error'
        ? 'bg-rose-500 dark:bg-rose-400'
        : 'bg-neutral-200';

  const countNode = (
    <span className={cn('inline-flex items-center gap-1.5 font-mono text-xs font-medium tabular-nums', textTone)}>
      {variant === 'warning' && <WarningIcon size={12} weight="fill" className="shrink-0 text-amber-500" aria-hidden />}
      {variant === 'error' && <WarningCircleIcon size={12} weight="fill" className="shrink-0 text-rose-500" aria-hidden />}
      <span>{compact(value)}</span>
    </span>
  );

  const trigger = to ? (
    <Link
      to={to}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center border-b border-dashed border-transparent py-[2px] transition-colors hover:border-neutral-400 dark:hover:border-white/70"
    >
      {countNode}
    </Link>
  ) : (
    countNode
  );

  return (
    <HoverPopover
      delayMs={200}
      popupClassName="min-w-[180px]"
      trigger={trigger}
      content={
        <div className="flex flex-col gap-2.5 p-3 font-mono">
          <div className="flex items-center justify-between gap-6">
            <span className={cn('text-sm/none font-medium tabular-nums', variant === 'default' ? 'text-white' : textTone)}>
              {value.toLocaleString()}
            </span>
            <span className="text-xs text-neutral-300 tabular-nums">
              {Math.round(pct)}% of {total.toLocaleString()}
            </span>
          </div>
          <div className="h-0.5 w-full overflow-hidden rounded-full bg-neutral-700 dark:bg-neutral-900">
            <div className={cn('h-full', barTone)} style={{ width: `${pct}%` }} />
          </div>
        </div>
      }
    />
  );
}

function extractUrlPath(raw: string): string {
  try {
    const parsed = new URL(raw);
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || '/';
  } catch {
    return raw;
  }
}

/** 1:1 Nightwatch `UrlFormatDisplay-CfhTexHD.js`: displays PATH or full URL with interactive copy + global toggle popover. */
export function UrlFormatDisplay({ url, className }: { url: string; className?: string }) {
  const { urlFormat, setUrlFormat } = useLocalPreferences();
  const path = extractUrlPath(url);
  const shown = urlFormat === 'path' ? path : url;

  return (
    <HoverPopover
      delayMs={350}
      popupClassName="max-w-sm"
      trigger={
        <span className={cn('truncate font-mono whitespace-nowrap', className)}>
          {shown}
        </span>
      }
      content={
        <div className="min-w-[260px] font-mono">
          <div className="grid gap-3.5 p-3.5 pr-4">
            <div className="grid gap-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs/none text-neutral-400">PATH</span>
                <MiniCopyButton value={path} label="Copy path" />
              </div>
              <span className="break-all text-xs/snug text-white">{path}</span>
            </div>
            <div className="grid gap-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs/none text-neutral-400">URL</span>
                <MiniCopyButton value={url} label="Copy URL" />
              </div>
              <span className="break-all text-xs/snug text-white">{url}</span>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-white/10 bg-white/[0.03] px-3.5 py-2.5">
            <span className="text-xs/none text-neutral-400">DEFAULT</span>
            <div className="flex overflow-hidden rounded-md border border-white/20 bg-neutral-900">
              {(['path', 'full'] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setUrlFormat(opt);
                  }}
                  className={cn(
                    'flex w-13 items-center justify-center rounded-sm px-1 py-1 text-[11px] transition-colors',
                    urlFormat === opt ? 'bg-white text-neutral-900 font-medium' : 'bg-transparent text-neutral-400 hover:bg-neutral-800',
                  )}
                >
                  {opt === 'path' ? 'PATH' : 'URL'}
                </button>
              ))}
            </div>
          </div>
        </div>
      }
    />
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
    <div className="relative flex min-h-48 w-full flex-col items-center justify-center overflow-hidden rounded-lg border border-neutral-200 px-5 py-10 text-center dark:border-neutral-800/60">
      {/* Exact TableEmptyState-Dk0HfMaw.js hash-matrix backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 flex flex-col justify-between overflow-hidden px-4 py-2 font-mono text-xs leading-6 tracking-widest text-neutral-300 uppercase select-none dark:text-neutral-700/50"
        style={{ maskImage: 'radial-gradient(ellipse 85% 85% at 50% 50%, black 45%, transparent 100%)' }}
      >
        {[...MATRIX_ROWS, ...MATRIX_ROWS].map((row, idx) => (
          <div key={idx} className="truncate whitespace-nowrap">
            {row}
          </div>
        ))}
      </div>
      <div className="relative z-10 flex flex-col items-center gap-1.5">
        <div className="inline-flex items-center rounded-[2px] bg-amber-300 px-1.5 py-0.5 font-mono text-sm/none font-medium uppercase tracking-wide text-amber-950 select-none dark:bg-amber-400 dark:text-neutral-950">
          <span>{children.replace(/\.$/, '')}</span>
        </div>
        <div className="max-w-lg rounded-[2px] bg-neutral-900 px-1.5 py-0.5 font-mono text-sm/none uppercase tracking-wide text-white select-none dark:bg-neutral-500 dark:text-neutral-950">
          {description ?? 'Try adjusting any filters or time range'}
        </div>
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}

const SQL_TOKENS = /(\b(?:select|from|where|and|or|in|insert into|values|update|set|delete|inner join|left join|right join|join|on|group by|order by|limit|offset|for update|as|is|not|desc|asc|count|sum|exists|distinct)\b|\b(?:null|true|false|\d+)\b|\?)/gi;

export function Sql({ sql, className = '' }: { sql: string; className?: string }) {
  return (
    <code className={cn('font-mono text-xs leading-relaxed text-neutral-900 dark:text-neutral-100', className)}>
      {sql.split(SQL_TOKENS).map((part, i) => {
        if (i % 2 === 0) return <span key={i}>{part}</span>;
        if (part === '?') return <span key={i} className="text-neutral-500 dark:text-neutral-400">?</span>;
        if (/^(?:null|true|false|\d+)$/i.test(part)) {
          return <span key={i} className="text-emerald-600 dark:text-emerald-400">{part}</span>;
        }
        return <span key={i} className="text-blue-600 dark:text-blue-400">{part}</span>;
      })}
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
