import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { LayerCard } from '@cloudflare/kumo/components/layer-card';
import { Table } from '@cloudflare/kumo/components/table';
import { Tabs } from '@cloudflare/kumo/components/tabs';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';
import { PageHeader, Panel } from '@/components/common';
import { PROJECT_ID } from '@/lib/api';

function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg bg-kumo-recessed p-4 pr-12 font-mono text-xs leading-relaxed text-kumo-default">{children}</pre>
      <Tooltip content={copied ? 'Copied' : 'Copy'} asChild>
        <Button variant="ghost" size="sm" shape="square" className="absolute right-2 top-2" onClick={copy} aria-label="Copy" icon={copied ? CheckIcon : CopyIcon} />
      </Tooltip>
    </div>
  );
}

function Guide({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex-col items-start gap-1">
        <div className="text-kumo-strong">{title}</div>
        <div className="text-sm font-normal">{description}</div>
      </LayerCard.Secondary>
      <LayerCard.Primary className="gap-3 text-sm text-kumo-subtle">{children}</LayerCard.Primary>
    </LayerCard>
  );
}

const KEYS = [
  { name: 'Production ingest', key: `ew_live_${PROJECT_ID}_7f3a…`, scope: 'ingest', created: '2026-11-21' },
  { name: 'Dashboard (read)', key: `ew_read_${PROJECT_ID}_c91e…`, scope: 'read', created: '2026-11-21' },
  { name: 'Storefront (browser)', key: `ew_pub_${PROJECT_ID}_4b02…`, scope: 'browser', created: '2026-11-22' },
];

export default function SetupPage() {
  const [tab, setTab] = useState('nightwatch');
  return (
    <>
      <PageHeader title="Setup" subtitle="Send data with the official Laravel Nightwatch agent or the EdgeWatch client" />
      <Tabs
        variant="underline"
        className="mb-3"
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'nightwatch', label: 'laravel/nightwatch (drop-in)' },
          { value: 'edgewatch', label: 'laravel-edgewatch (agentless)' },
          { value: 'browser', label: 'Browser errors' },
        ]}
      />
      {tab === 'nightwatch' && (
        <Guide title="Keep the official Nightwatch client" description={<>Point the agent at EdgeWatch. Application code and <span className="font-mono">NIGHTWATCH_*</span> settings stay as they are.</>}>
          <Code>{`# .env (app and agent)
NIGHTWATCH_TOKEN=ew_live_${PROJECT_ID}_••••••••

# agent only: undocumented override read by agent.phar
NIGHTWATCH_BASE_URL=https://ingest.edgewatch.dev

php artisan nightwatch:agent`}</Code>
          <p>
            The agent calls <span className="font-mono text-kumo-strong">POST /api/agent-auth</span>, then sends gzip batches to the returned{' '}
            <span className="font-mono text-kumo-strong">ingest_url</span>.
          </p>
        </Guide>
      )}
      {tab === 'edgewatch' && (
        <Guide title="edgewatch/laravel-edgewatch" description="No agent process. Events are buffered (500 records) and sent over HTTPS with a 500ms timeout.">
          <Code>{`composer require edgewatch/laravel-edgewatch

# .env
EDGEWATCH_TOKEN=ew_live_${PROJECT_ID}_••••••••
EDGEWATCH_INGEST_URI=https://ingest.edgewatch.dev/api/ingest`}</Code>
          <p>
            Every <span className="font-mono">EDGEWATCH_*</span> key falls back to its <span className="font-mono">NIGHTWATCH_*</span> twin.
          </p>
        </Guide>
      )}
      {tab === 'browser' && (
        <Guide title="@edgewatch/browser" description="EdgeWatch extension (not part of the Nightwatch wire format): uncaught browser errors go to POST /api/browser with a public browser-scope key.">
          <Code>{`import { init } from '@edgewatch/browser';

init({
  endpoint: 'https://ingest.edgewatch.dev',
  key: 'ew_pub_${PROJECT_ID}_••••••••',
});`}</Code>
        </Guide>
      )}
      <Panel title="API keys" className="mt-4">
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.Head className="px-5">Name</Table.Head>
              <Table.Head>Key</Table.Head>
              <Table.Head>Scope</Table.Head>
              <Table.Head className="px-5">Created</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {KEYS.map((k) => (
              <Table.Row key={k.key}>
                <Table.Cell className="px-5">{k.name}</Table.Cell>
                <Table.Cell className="font-mono text-xs text-kumo-subtle">{k.key}</Table.Cell>
                <Table.Cell><Badge variant={k.scope === 'ingest' ? 'primary' : k.scope === 'browser' ? 'beta' : 'secondary'}>{k.scope}</Badge></Table.Cell>
                <Table.Cell className="px-5 text-xs text-kumo-subtle">{k.created}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </Panel>
    </>
  );
}
