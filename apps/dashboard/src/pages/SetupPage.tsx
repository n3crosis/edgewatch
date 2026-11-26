import { USING_MOCK } from '@/lib/config';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Table } from '@cloudflare/kumo/components/table';
import type { ReactNode } from 'react';
import { CopyButton, PageHeader, Panel } from '@/components/common';
import { useProject } from '@/lib/project';

function Code({ children }: { children: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-xl border border-kumo-hairline bg-kumo-recessed p-5 pr-14 font-mono text-xs leading-6 text-kumo-default">
        {children}
      </pre>
      <CopyButton text={children} label="Copy snippet" className="absolute right-3 top-3" />
    </div>
  );
}

function Guide({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <Panel title={title} description={description}>
      <div className="space-y-4 p-6 text-sm text-kumo-subtle">{children}</div>
    </Panel>
  );
}

const SAMPLE_KEYS = [
  { name: 'Owner ingest (all projects)', key: 'ew_live_owner_7f3a…', scope: 'ingest', created: '2026-11-21' },
  { name: 'Dashboard (read, all projects)', key: 'ew_read_owner_c91e…', scope: 'read', created: '2026-11-21' },
];

export default function SetupPage() {
  const { projectId: PROJECT_ID, projects } = useProject();
  const projectName = projects.find((p) => p.id === PROJECT_ID)?.name ?? PROJECT_ID;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Setup"
        subtitle="Send telemetry with the official Laravel Nightwatch agent"
        actions={
          <Badge variant="outline" className="font-mono">
            {projectName} · {PROJECT_ID}
          </Badge>
        }
      />

      <Guide
        title="Use the official laravel/nightwatch agent"
        description={<>Point the Nightwatch agent at EdgeWatch. Application code and <span className="font-mono">NIGHTWATCH_*</span> settings stay as they are.</>}
      >
        <Code>{`# .env (app and agent)
NIGHTWATCH_TOKEN=ew_live_${PROJECT_ID}_••••••••

# agent only: point the agent at your EdgeWatch ingest endpoint
NIGHTWATCH_BASE_URL=https://ingest.edgewatch.dev

php artisan nightwatch:agent`}</Code>
        <p className="text-xs leading-relaxed">
          The agent calls <code className="rounded bg-kumo-recessed px-1.5 py-0.5 font-mono text-kumo-strong">POST /api/agent-auth</code>, then sends gzip batches to the returned{' '}
          <code className="rounded bg-kumo-recessed px-1.5 py-0.5 font-mono text-kumo-strong">ingest_url</code>.
        </p>
      </Guide>

      <Panel title={USING_MOCK ? 'Example API keys' : 'API keys'}>
        {USING_MOCK ? (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Name</Table.Head>
                <Table.Head>Key</Table.Head>
                <Table.Head>Scope</Table.Head>
                <Table.Head>Created</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {SAMPLE_KEYS.map((k) => (
                <Table.Row key={k.key} className="transition-colors hover:bg-kumo-tint/50">
                  <Table.Cell className="font-medium text-kumo-strong">{k.name}</Table.Cell>
                  <Table.Cell className="font-mono text-xs text-kumo-subtle">{k.key}</Table.Cell>
                  <Table.Cell>
                    <Badge variant={k.scope === 'ingest' ? 'primary' : 'secondary'}>{k.scope}</Badge>
                  </Table.Cell>
                  <Table.Cell className="font-mono text-xs text-kumo-subtle">{k.created}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        ) : (
          <div className="space-y-4 p-6 text-sm">
            <p className="text-kumo-default">API keys connect your applications to EdgeWatch. Dashboard access is managed separately in Accounts.</p>
            <p className="text-xs text-kumo-subtle">The installation operator can list and create application keys with the key management command:</p>
            <Code>bun run --filter @edgewatch/ingest keys list --remote</Code>
          </div>
        )}
      </Panel>
    </div>
  );
}
