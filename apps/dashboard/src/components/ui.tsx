import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ExecutionSource } from '../lib/types';

export function PageHeader({ title, subtitle, back, actions }: { title: ReactNode; subtitle?: ReactNode; back?: { to: string; label: string }; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div className="min-w-0">
        {back && (
          <Link to={back.to} className="mb-2 inline-block text-xs text-slate-500 hover:text-slate-300">
            ← {back.label}
          </Link>
        )}
        <h1 className="truncate text-xl font-semibold text-white">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Card({ title, children, className = '', actions }: { title?: ReactNode; children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <section className={`rounded-xl border border-slate-800 bg-slate-900/50 ${className}`}>
      {title && (
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
          <h2 className="text-sm font-medium text-slate-200">{title}</h2>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone = 'default' }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'default' | 'bad' | 'warn' | 'good' }) {
  const color = { default: 'text-white', bad: 'text-rose-400', warn: 'text-amber-300', good: 'text-emerald-400' }[tone];
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 px-5 py-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-2 text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export function StatusBadge({ status, source }: { status: number | null; source: ExecutionSource }) {
  if (source !== 'request') {
    const ok = status === 0 || status === null;
    return <span className={`rounded px-1.5 py-0.5 font-mono text-xs ${ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>{ok ? 'OK' : `exit ${status}`}</span>;
  }
  const s = status ?? 0;
  const cls = s >= 500 ? 'bg-rose-500/10 text-rose-400' : s >= 400 ? 'bg-amber-500/10 text-amber-300' : s >= 300 ? 'bg-sky-500/10 text-sky-300' : 'bg-emerald-500/10 text-emerald-400';
  return <span className={`rounded px-1.5 py-0.5 font-mono text-xs ${cls}`}>{s}</span>;
}

export function SourceBadge({ source }: { source: ExecutionSource }) {
  const cls = { request: 'text-sky-300 bg-sky-500/10', job: 'text-violet-300 bg-violet-500/10', command: 'text-teal-300 bg-teal-500/10', schedule: 'text-orange-300 bg-orange-500/10' }[source];
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${cls}`}>{source}</span>;
}

export function Loading() {
  return <div className="py-16 text-center text-sm text-slate-500">Loading…</div>;
}

export function ErrorState({ error }: { error: Error }) {
  return <div className="rounded-xl border border-rose-900 bg-rose-950/40 p-5 text-sm text-rose-300">{error.message}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-16 text-center text-sm text-slate-500">{children}</div>;
}

export function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <th className={`px-5 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-slate-500 ${className}`}>{children}</th>;
}

export function Td({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <td className={`px-5 py-3 ${className}`}>{children}</td>;
}

export function Sql({ sql, className = '' }: { sql: string; className?: string }) {
  const parts = sql.split(/(\b(?:select|from|where|and|or|in|insert into|values|update|set|delete|inner join|left join|on|group by|order by|limit|offset|for update|as|is null|desc|asc|count|sum)\b|\?)/gi);
  return (
    <code className={`font-mono text-xs ${className}`}>
      {parts.map((p, i) =>
        p === '?' ? <span key={i} className="text-amber-300">?</span> : /^[a-z ]+$/i.test(p) && i % 2 === 1 ? <span key={i} className="text-sky-300">{p}</span> : <span key={i}>{p}</span>,
      )}
    </code>
  );
}
