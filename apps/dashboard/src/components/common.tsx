import { Badge } from '@cloudflare/kumo/components/badge';
import { Banner } from '@cloudflare/kumo/components/banner';
import { LinkButton } from '@cloudflare/kumo/components/button';
import { Empty as KumoEmpty } from '@cloudflare/kumo/components/empty';
import { InputGroup } from '@cloudflare/kumo/components/input-group';
import { LayerCard } from '@cloudflare/kumo/components/layer-card';
import { SkeletonLine } from '@cloudflare/kumo/components/loader';
import { cn } from '@cloudflare/kumo/utils';
import { ArrowLeftIcon, MagnifyingGlassIcon, WarningCircleIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import type { ExecutionSource } from '@/lib/types';

export function PageHeader({ title, subtitle, back, actions }: { title: ReactNode; subtitle?: ReactNode; back?: { to: string; label: string }; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div className="min-w-0">
        {back && (
          <LinkButton href={back.to} variant="ghost" size="xs" icon={ArrowLeftIcon} className="-ml-1.5 mb-2 text-kumo-subtle">
            {back.label}
          </LinkButton>
        )}
        <h1 className="truncate text-xl font-semibold tracking-tight text-kumo-strong">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-kumo-subtle">{subtitle}</div>}
      </div>
      {actions}
    </div>
  );
}

/** Kumo LayerCard with a header row; content is flush so tables reach the edges. */
export function Panel({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <LayerCard className={cn('flex flex-col', className)}>
      {title && (
        <div className="flex min-h-12 items-center justify-between gap-3 border-b border-kumo-hairline px-5 py-2.5">
          <div className="text-sm font-medium text-kumo-strong">{title}</div>
          {actions}
        </div>
      )}
      <div className="min-w-0">{children}</div>
    </LayerCard>
  );
}

const TONES = { default: 'text-kumo-strong', bad: 'text-kumo-danger', warn: 'text-kumo-warning', good: 'text-kumo-success' };

export function Stat({ label, value, hint, tone = 'default' }: { label: string; value: ReactNode; hint?: ReactNode; tone?: keyof typeof TONES }) {
  return (
    <LayerCard className="px-5 py-4">
      <div className="text-xs font-medium uppercase tracking-wide text-kumo-subtle">{label}</div>
      <div className={cn('mt-1 truncate text-2xl font-semibold tabular-nums', TONES[tone])}>{value}</div>
      {hint && <div className="mt-1 text-xs text-kumo-subtle">{hint}</div>}
    </LayerCard>
  );
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

const SOURCE_VARIANTS = { request: 'info', job: 'secondary', command: 'outline', schedule: 'warning', browser: 'beta' } as const satisfies Record<ExecutionSource, string>;

export function SourceBadge({ source }: { source: ExecutionSource }) {
  return <Badge variant={SOURCE_VARIANTS[source]} className="text-[10px] uppercase tracking-wide">{source}</Badge>;
}

export function Loading({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-4 p-5" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <SkeletonLine key={i} />)}
    </div>
  );
}

export function ErrorState({ error }: { error: Error }) {
  return <Banner variant="error" icon={<WarningCircleIcon />} title="Could not load data" description={error.message} />;
}

export function Empty({ children }: { children: string }) {
  return <KumoEmpty size="sm" title={children} />;
}

const SQL_KEYWORDS = /(\b(?:select|from|where|and|or|in|insert into|values|update|set|delete|inner join|left join|on|group by|order by|limit|offset|for update|as|is null|desc|asc|count|sum|exists)\b|\?)/gi;

export function Sql({ sql, className = '' }: { sql: string; className?: string }) {
  return (
    <code className={cn('font-mono text-xs', className)}>
      {sql.split(SQL_KEYWORDS).map((p, i) =>
        p === '?' ? <span key={i} className="text-kumo-warning">?</span> : i % 2 === 1 ? <span key={i} className="text-kumo-link">{p}</span> : <span key={i}>{p}</span>,
      )}
    </code>
  );
}

export function SearchBox({ value, onChange, placeholder, className = 'w-72' }: { value: string; onChange: (v: string) => void; placeholder: string; className?: string }) {
  return (
    <InputGroup className={className} size="sm">
      <InputGroup.Addon align="start">
        <MagnifyingGlassIcon className="text-kumo-subtle" />
      </InputGroup.Addon>
      <InputGroup.Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
    </InputGroup>
  );
}
