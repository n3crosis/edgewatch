import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { ExecutionSource } from '@/lib/types';
import { cn } from '@/lib/utils';

export function PageHeader({ title, subtitle, back, actions }: { title: ReactNode; subtitle?: ReactNode; back?: { to: string; label: string }; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div className="min-w-0">
        {back && (
          <Button asChild variant="ghost" size="xs" className="-ml-2 mb-2 text-muted-foreground">
            <Link to={back.to}>
              <ArrowLeft /> {back.label}
            </Link>
          </Button>
        )}
        <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-muted-foreground">{subtitle}</div>}
      </div>
      {actions}
    </div>
  );
}

/** Card with a bordered header row; content is flush so tables reach the edges. */
export function Panel({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={cn('gap-0 overflow-hidden py-0', className)}>
      {title && (
        <CardHeader className="border-b px-5 py-3 [.border-b]:pb-3">
          <CardTitle className="text-sm">{title}</CardTitle>
          {actions && <CardAction>{actions}</CardAction>}
        </CardHeader>
      )}
      <CardContent className="px-0">{children}</CardContent>
    </Card>
  );
}

const TONES = { default: '', bad: 'text-destructive', warn: 'text-amber-300', good: 'text-emerald-400' };

export function Stat({ label, value, hint, tone = 'default' }: { label: string; value: ReactNode; hint?: ReactNode; tone?: keyof typeof TONES }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-5">
        <CardDescription className="text-xs font-medium uppercase tracking-wide">{label}</CardDescription>
        <CardTitle className={cn('text-2xl font-semibold tabular-nums', TONES[tone])}>{value}</CardTitle>
      </CardHeader>
      {hint && <CardContent className="px-5 text-xs text-muted-foreground">{hint}</CardContent>}
    </Card>
  );
}

export function StatusBadge({ status, source }: { status: number | null; source: ExecutionSource }) {
  if (source !== 'request') {
    const ok = status === 0 || status === null;
    return <Badge variant="outline" className={cn('font-mono', ok ? 'border-emerald-500/30 text-emerald-400' : 'border-destructive/40 text-destructive')}>{ok ? 'OK' : `exit ${status}`}</Badge>;
  }
  const s = status ?? 0;
  const cls = s >= 500 ? 'border-destructive/40 text-destructive' : s >= 400 ? 'border-amber-400/30 text-amber-300' : s >= 300 ? 'border-sky-400/30 text-sky-300' : 'border-emerald-500/30 text-emerald-400';
  return <Badge variant="outline" className={cn('font-mono', cls)}>{s}</Badge>;
}

const SOURCE_STYLES: Record<ExecutionSource, string> = {
  request: 'bg-sky-500/15 text-sky-300',
  job: 'bg-violet-500/15 text-violet-300',
  command: 'bg-teal-500/15 text-teal-300',
  schedule: 'bg-orange-500/15 text-orange-300',
};

export function SourceBadge({ source }: { source: ExecutionSource }) {
  return <Badge variant="secondary" className={cn('uppercase tracking-wide text-[10px]', SOURCE_STYLES[source])}>{source}</Badge>;
}

export function Loading({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-5" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

export function ErrorState({ error }: { error: Error }) {
  return <Card className="border-destructive/40 bg-destructive/10 p-5 text-sm text-destructive">{error.message}</Card>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-16 text-center text-sm text-muted-foreground">{children}</div>;
}

const SQL_KEYWORDS = /(\b(?:select|from|where|and|or|in|insert into|values|update|set|delete|inner join|left join|on|group by|order by|limit|offset|for update|as|is null|desc|asc|count|sum|exists)\b|\?)/gi;

export function Sql({ sql, className = '' }: { sql: string; className?: string }) {
  return (
    <code className={cn('font-mono text-xs', className)}>
      {sql.split(SQL_KEYWORDS).map((p, i) =>
        p === '?' ? <span key={i} className="text-amber-300">?</span> : i % 2 === 1 ? <span key={i} className="text-primary">{p}</span> : <span key={i}>{p}</span>,
      )}
    </code>
  );
}
