import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkline } from '@/components/charts';
import { Empty, ErrorState, Loading, PageHeader, Panel, SearchBox, Sql } from '@/components/common';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api, useAsync } from '@/lib/api';
import { compact, ms } from '@/lib/format';
import { useRange } from '@/lib/range';
import type { QueryGroup } from '@/lib/types';

const SORTS: { key: keyof QueryGroup; label: string }[] = [
  { key: 'total_ms', label: 'Total time' },
  { key: 'calls', label: 'Calls' },
  { key: 'p95_ms', label: 'p95' },
];

export default function QueriesPage() {
  const { range } = useRange();
  const navigate = useNavigate();
  const [sort, setSort] = useState<keyof QueryGroup>('total_ms');
  const { data, error, loading } = useAsync(() => api.queries(range), [range]);
  const [q, setQ] = useState('');
  const needle = q.toLowerCase().trim();
  const rows = data
    ? [...data].filter((g) => !needle || `${g.sql} ${g.connection} ${g.sql_hash}`.toLowerCase().includes(needle)).sort((a, b) => Number(b[sort]) - Number(a[sort]))
    : [];

  return (
    <>
      <PageHeader
        title="Queries"
        subtitle="Grouped by sql_hash — literals are stripped before hashing, so values never leave your app"
        actions={
          <ToggleGroup type="single" variant="outline" size="sm" value={sort} onValueChange={(v) => v && setSort(v as keyof QueryGroup)} aria-label="Sort by">
            {SORTS.map((s) => (
              <ToggleGroupItem key={s.key} value={s.key} className="px-3 text-xs">{s.label}</ToggleGroupItem>
            ))}
          </ToggleGroup>
        }
      />
      <Panel title={`${rows.length} query groups`} actions={<SearchBox value={q} onChange={setQ} placeholder="Search SQL, connection or hash…" />}>
        {error ? <ErrorState error={error} /> : loading || !data ? <Loading /> : rows.length === 0 ? <Empty>{needle ? 'No queries match your search.' : 'No queries recorded.'}</Empty> : (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[46%] px-5">Query</TableHead>
                <TableHead>Calls</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Avg</TableHead>
                <TableHead className="text-right">p95</TableHead>
                <TableHead className="text-right">Max</TableHead>
                <TableHead className="px-5">Trend</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((q) => (
                <TableRow key={q.sql_hash} onClick={() => navigate(`/queries/${q.sql_hash}`)} className="cursor-pointer">
                  <TableCell className="px-5 py-3">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="truncate"><Sql sql={q.sql} /></div>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xl font-mono">{q.sql}</TooltipContent>
                    </Tooltip>
                    <div className="mt-1 font-mono text-[11px] text-muted-foreground">{q.connection} · {q.sql_hash.slice(0, 12)}</div>
                  </TableCell>
                  <TableCell className="tabular-nums">{compact(q.calls)}</TableCell>
                  <TableCell className="text-right tabular-nums">{ms(q.total_ms)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{ms(q.avg_ms)}</TableCell>
                  <TableCell className={`text-right tabular-nums ${q.p95_ms > 100 ? 'text-amber-300' : ''}`}>{ms(q.p95_ms)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{ms(q.max_ms)}</TableCell>
                  <TableCell className="px-5"><Sparkline values={q.trend} width={90} className="text-chart-3" /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </>
  );
}
