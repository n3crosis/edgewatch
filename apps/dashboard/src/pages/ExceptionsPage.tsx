import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkline } from '@/components/charts';
import { Empty, ErrorState, Loading, PageHeader, Panel, SearchBox } from '@/components/common';
import { Tabs } from '@cloudflare/kumo/components/tabs';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Table } from '@cloudflare/kumo/components/table';
import { api, useAsync } from '@/lib/api';
import { ago } from '@/lib/format';
import { useRange } from '@/lib/range';

export default function ExceptionsPage() {
  const { range } = useRange();
  const navigate = useNavigate();
  const { data: all, error, loading } = useAsync(() => api.exceptions(range), [range]);
  const [q, setQ] = useState('');
  const [handled, setHandled] = useState<'all' | 'handled' | 'unhandled'>('all');
  const needle = q.toLowerCase().trim();
  const data = all?.filter(
    (e) => (handled === 'all' || e.handled === (handled === 'handled')) && (!needle || `${e.class} ${e.message} ${e.file}`.toLowerCase().includes(needle)),
  );

  return (
    <>
      <PageHeader title="Exceptions" subtitle="Grouped by class, code and location" />
      <Panel
        title={`${data?.length ?? 0} groups`}
        actions={
          <div className="flex items-center gap-2">
            <Tabs
              variant="segmented"
              size="sm"
              value={handled}
              onValueChange={(v) => setHandled(v as typeof handled)}
              tabs={[{ value: 'all', label: 'All' }, { value: 'unhandled', label: 'Unhandled' }, { value: 'handled', label: 'Handled' }]}
            />
            <SearchBox value={q} onChange={setQ} placeholder="Search class, message or file…" />
          </div>
        }
      >
        {error ? <ErrorState error={error} /> : loading || !data ? <Loading /> : data.length === 0 ? <Empty>{needle || handled !== 'all' ? 'No exceptions match these filters.' : `No exceptions in the last ${range}.`}</Empty> : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head className="px-5">Exception</Table.Head>
                <Table.Head>Trend</Table.Head>
                <Table.Head className="text-right">Events</Table.Head>
                <Table.Head className="text-right">Users</Table.Head>
                <Table.Head>Last seen</Table.Head>
                <Table.Head className="px-5">First seen</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.map((e) => (
                <Table.Row key={e.group} onClick={() => navigate(`/exceptions/${e.group}`)} className="cursor-pointer">
                  <Table.Cell className="max-w-xl px-5 py-3 whitespace-normal">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-xs text-kumo-danger">{e.class}</span>
                      <Badge variant={e.handled ? 'secondary' : 'error'} className="text-[10px]">{e.handled ? 'handled' : 'unhandled'}</Badge>
                    </div>
                    <div className="mt-1 truncate text-xs text-kumo-subtle">{e.message}</div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-kumo-inactive">{e.file}:{e.line}</div>
                  </Table.Cell>
                  <Table.Cell><Sparkline values={e.trend} className="text-kumo-danger" /></Table.Cell>
                  <Table.Cell className="text-right tabular-nums">{e.count}</Table.Cell>
                  <Table.Cell className="text-right tabular-nums text-kumo-subtle">{e.users}</Table.Cell>
                  <Table.Cell className="text-xs text-kumo-subtle">{ago(e.last_seen)}</Table.Cell>
                  <Table.Cell className="px-5 text-xs text-kumo-subtle">{ago(e.first_seen)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </Panel>
    </>
  );
}
