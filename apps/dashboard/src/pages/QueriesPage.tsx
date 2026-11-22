import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkline } from '@/components/charts';
import { Empty, ErrorState, Loading, PageHeader, Panel, SearchBox, Sql } from '@/components/common';
import { Table } from '@cloudflare/kumo/components/table';
import { Tabs } from '@cloudflare/kumo/components/tabs';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
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
          <Tabs variant="segmented" size="sm" value={sort} onValueChange={(v) => setSort(v as keyof QueryGroup)} tabs={SORTS.map((s) => ({ value: s.key, label: s.label }))} />
        }
      />
      <Panel title={`${rows.length} query groups`} actions={<SearchBox value={q} onChange={setQ} placeholder="Search SQL, connection or hash…" />}>
        {error ? <ErrorState error={error} /> : loading || !data ? <Loading /> : rows.length === 0 ? <Empty>{needle ? 'No queries match your search.' : 'No queries recorded.'}</Empty> : (
          <Table layout="fixed">
            <Table.Header>
              <Table.Row>
                <Table.Head className="w-[46%] px-5">Query</Table.Head>
                <Table.Head>Calls</Table.Head>
                <Table.Head className="text-right">Total</Table.Head>
                <Table.Head className="text-right">Avg</Table.Head>
                <Table.Head className="text-right">p95</Table.Head>
                <Table.Head className="text-right">Max</Table.Head>
                <Table.Head className="px-5">Trend</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((q) => (
                <Table.Row key={q.sql_hash} onClick={() => navigate(`/queries/${q.sql_hash}`)} className="cursor-pointer">
                  <Table.Cell className="px-5 py-3">
                    <Tooltip asChild content={<span className="block max-w-xl font-mono">{q.sql}</span>}>
                      <div className="truncate"><Sql sql={q.sql} /></div>
                    </Tooltip>
                    <div className="mt-1 font-mono text-[11px] text-kumo-subtle">{q.connection} · {q.sql_hash.slice(0, 12)}</div>
                  </Table.Cell>
                  <Table.Cell className="tabular-nums">{compact(q.calls)}</Table.Cell>
                  <Table.Cell className="text-right tabular-nums">{ms(q.total_ms)}</Table.Cell>
                  <Table.Cell className="text-right tabular-nums text-kumo-subtle">{ms(q.avg_ms)}</Table.Cell>
                  <Table.Cell className={`text-right tabular-nums ${q.p95_ms > 100 ? 'text-kumo-warning' : ''}`}>{ms(q.p95_ms)}</Table.Cell>
                  <Table.Cell className="text-right tabular-nums text-kumo-subtle">{ms(q.max_ms)}</Table.Cell>
                  <Table.Cell className="px-5"><Sparkline values={q.trend} width={90} className="text-kumo-info" /></Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </Panel>
    </>
  );
}
