import { USING_MOCK } from '@/lib/config';
import { Badge } from '@cloudflare/kumo/components/badge';
import { LinkButton } from '@cloudflare/kumo/components/button';
import { Table } from '@cloudflare/kumo/components/table';
import { FolderSimpleIcon, GitBranchIcon, KeyIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import Link, { scopedPath } from '@/components/ScopedLink';
import { CopyButton, PageHeader, Panel } from '@/components/common';
import { useEnvironment } from '@/lib/environment';
import { useProject } from '@/lib/project';
import { useRange } from '@/lib/range';

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

function StepCard({ step, title, description, children }: { step: number; title: string; description: ReactNode; children: ReactNode }) {
  return (
    <Panel
      title={
        <span className="flex items-center gap-3">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-kumo-brand/15 font-mono text-xs font-semibold text-kumo-brand">
            {step}
          </span>
          <span>{title}</span>
        </span>
      }
      description={description}
    >
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
  const { range } = useRange();
  const { environment } = useEnvironment();
  const projectName = projects.find((p) => p.id === PROJECT_ID)?.name ?? PROJECT_ID;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Setup"
        subtitle="Connect your Laravel application to EdgeWatch in two quick steps"
        actions={
          <Badge variant="outline" className="inline-flex items-center gap-1.5 font-mono">
            <FolderSimpleIcon size={13} aria-hidden />
            <span>{projectName === PROJECT_ID ? PROJECT_ID : `${projectName} · ${PROJECT_ID}`}</span>
          </Badge>
        }
      />

      <StepCard
        step={1}
        title="Configure your Laravel environment"
        description={<>Point the official <span className="font-mono">laravel/nightwatch</span> agent at your EdgeWatch ingest URL. Existing <span className="font-mono">NIGHTWATCH_*</span> settings stay unchanged.</>}
      >
        <Code>{`# .env (app and agent)
NIGHTWATCH_TOKEN=ew_live_${PROJECT_ID}_••••••••

# agent only: replace with your EdgeWatch ingest worker URL
NIGHTWATCH_BASE_URL=https://ingest.edgewatch.dev`}</Code>
      </StepCard>

      <StepCard
        step={2}
        title="Start the agent"
        description="Run the agent alongside your application; telemetry appears in the dashboard within seconds."
      >
        <Code>php artisan nightwatch:agent</Code>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="text-xs leading-relaxed">
            The agent authenticates via <code className="rounded bg-kumo-recessed px-1.5 py-0.5 font-mono text-kumo-strong">POST /api/agent-auth</code> and streams gzipped batches to the returned ingest endpoint.
          </p>
          <LinkButton href={scopedPath('/traces', PROJECT_ID, range, environment)} variant="secondary" size="sm" icon={GitBranchIcon}>
            View incoming traces
          </LinkButton>
        </div>
      </StepCard>

      <Panel
        title={
          <span className="flex items-center gap-2">
            <KeyIcon size={16} className="text-kumo-subtle" aria-hidden />
            <span>{USING_MOCK ? 'Example API keys' : 'API keys'}</span>
          </span>
        }
      >
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
            <p className="text-kumo-default">
              API keys authenticate telemetry sent from your applications. Dashboard access is managed separately in{' '}
              <Link to="/accounts" className="font-medium text-kumo-link hover:underline">Accounts</Link>.
            </p>
            <p className="text-xs text-kumo-subtle">List or create ingest keys from your terminal:</p>
            <Code>bun run --filter @edgewatch/ingest keys list --remote</Code>
          </div>
        )}
      </Panel>
    </div>
  );
}
