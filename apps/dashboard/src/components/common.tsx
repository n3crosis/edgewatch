import { useEnvironment } from '@/lib/environment';
import Link, { scopedPath } from './ScopedLink';
import { useProject } from '@/lib/project';
import { useRange } from '@/lib/range';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Banner } from '@cloudflare/kumo/components/banner';
import { Button, LinkButton } from '@cloudflare/kumo/components/button';
import { Empty as KumoEmpty } from '@cloudflare/kumo/components/empty';
import { InputGroup } from '@cloudflare/kumo/components/input-group';
import { LayerCard } from '@cloudflare/kumo/components/layer-card';
import { SkeletonLine } from '@cloudflare/kumo/components/loader';
import { useKumoToastManager } from '@cloudflare/kumo/components/toast';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { cn } from '@cloudflare/kumo/utils';
import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
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
}: {
  title: ReactNode;
  documentTitle?: string;
  subtitle?: ReactNode;
  back?: { to: string; label: string };
  actions?: ReactNode;
}) {
  const { projectId, projects } = useProject();
  const { range } = useRange();
  const { environment } = useEnvironment();
  const pageTitle = documentTitle ?? (typeof title === 'string' ? title : undefined);
  const projectName = projects.find((p) => p.id === projectId)?.name ?? projectId;

  useEffect(() => {
    document.title = pageTitle ? `${pageTitle} · ${projectName} — EdgeWatch` : `${projectName} — EdgeWatch`;
  }, [pageTitle, projectName]);

  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
      <div className="min-w-0">
        {back && (
          <LinkButton
            href={scopedPath(back.to, projectId, range, environment)}
            variant="ghost"
            size="sm"
            icon={ArrowLeftIcon}
            className="-ml-2 mb-2 text-kumo-subtle"
          >
            {back.label}
          </LinkButton>
        )}
        <h1 className="break-words text-2xl font-semibold tracking-tight text-kumo-strong sm:text-[26px] sm:leading-tight">
          {title}
        </h1>
        {subtitle && <div className="mt-2 max-w-3xl text-sm leading-relaxed text-kumo-subtle">{subtitle}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2.5">{actions}</div>}
    </div>
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
        'mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-kumo-hairline bg-kumo-elevated/55 p-3.5 sm:px-4 sm:py-3.5',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Kumo LayerCard with a spacious header row; content is flush so tables reach the edges. */
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
    <LayerCard className={cn('ew-panel relative flex flex-col overflow-hidden', className)}>
      {fetching && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-kumo-brand/15" aria-hidden>
          <div className="ew-indeterminate h-full w-1/3 rounded-full bg-kumo-brand" />
        </div>
      )}
      {title && (
        <div className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-2.5 border-b border-kumo-hairline px-5 py-3.5 sm:px-6">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold leading-snug text-kumo-strong">{title}</div>
            {description && <div className="mt-0.5 text-xs text-kumo-subtle">{description}</div>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2.5">{actions}</div>}
        </div>
      )}
      {/* Wide tables scroll horizontally on small screens instead of squashing columns. */}
      <div className={cn('min-w-0 overflow-x-auto transition-opacity duration-150', fetching && 'opacity-65')}>{children}</div>
    </LayerCard>
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
        'flex h-full flex-col justify-between p-5 transition-colors sm:p-6',
        to && 'group-hover:bg-kumo-tint/50',
        !to && className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs font-medium tracking-wide text-kumo-subtle">
          {icon && <span className="shrink-0 text-kumo-subtle" aria-hidden>{icon}</span>}
          <span className="truncate">{label}</span>
        </div>
        {to && (
          <ArrowUpRightIcon
            size={14}
            className="shrink-0 text-kumo-subtle opacity-0 transition-opacity group-hover:opacity-100"
            aria-hidden
          />
        )}
      </div>
      <div className={cn('mt-3 truncate text-2xl font-semibold leading-none tracking-tight tabular-nums sm:text-[28px]', TONES[tone])}>
        {value}
      </div>
      {hint ? (
        <div className="mt-2.5 truncate text-xs text-kumo-subtle">{hint}</div>
      ) : (
        <div className="mt-2.5 h-4" aria-hidden />
      )}
    </LayerCard>
  );
  if (to) {
    return (
      <Link to={to} className={cn('group block rounded-xl focus-visible:outline-2 focus-visible:outline-kumo-link', className)}>
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
  GET: 'info',
  HEAD: 'secondary',
  POST: 'success',
  PUT: 'warning',
  PATCH: 'warning',
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
      <time dateTime={iso} className={cn('cursor-default whitespace-nowrap tabular-nums text-kumo-subtle', className)}>
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
    <div className="flex flex-wrap items-center justify-between gap-4 border-t border-kumo-hairline px-5 py-3.5 sm:px-6">
      <div className="text-xs text-kumo-subtle">{status}</div>
      <div className="flex items-center gap-2.5">
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
      <div className="mb-8 space-y-2.5">
        <div className="w-48"><SkeletonLine blockHeight={28} /></div>
        <div className="w-80"><SkeletonLine blockHeight={16} /></div>
      </div>
      <div className={cn('grid grid-cols-1 gap-5', cols)}>
        {Array.from({ length: stats }, (_, i) => (
          <LayerCard key={i} className="space-y-3.5 p-6">
            <SkeletonLine minWidth={40} maxWidth={60} />
            <SkeletonLine blockHeight={28} minWidth={45} maxWidth={70} />
            <SkeletonLine minWidth={30} maxWidth={50} />
          </LayerCard>
        ))}
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        {[0, 1].map((i) => (
          <LayerCard key={i} className="p-6"><SkeletonLine blockHeight={208} /></LayerCard>
        ))}
      </div>
      <LayerCard className="mt-6"><Loading rows={5} /></LayerCard>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const { refresh } = useRange();
  const retry = onRetry ?? refresh;
  return (
    <div className="flex flex-col gap-3.5 p-2 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <Banner variant="error" icon={<WarningCircleIcon />} title="Could not load data" description={error.message} />
      </div>
      <Button variant="secondary" size="sm" icon={ArrowClockwiseIcon} onClick={retry} className="shrink-0 self-start sm:self-center">
        Retry
      </Button>
    </div>
  );
}

export function Empty({
  children,
  description,
  action,
  icon,
}: {
  children: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="px-6 py-16">
      <KumoEmpty
        size="sm"
        icon={icon ?? <TrayIcon size={32} className="text-kumo-subtle" />}
        title={children}
        description={description}
        contents={action}
      />
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
    <InputGroup className={className}>
      <InputGroup.Addon align="start">
        <MagnifyingGlassIcon className="text-kumo-subtle" />
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
