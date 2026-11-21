import { Card, PageHeader } from '../components/ui';
import { PROJECT_ID } from '../lib/api';

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-lg bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-200">{children}</pre>;
}

export default function SetupPage() {
  return (
    <>
      <PageHeader title="Setup" subtitle="Send data with the official Laravel Nightwatch agent or the EdgeWatch client" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Option A — keep laravel/nightwatch (drop-in)">
          <div className="space-y-3 p-5 text-sm text-slate-400">
            <p>Point the Nightwatch agent at EdgeWatch. Your application code and <span className="font-mono">NIGHTWATCH_*</span> settings stay as they are.</p>
            <Code>{`# .env (app and agent)
NIGHTWATCH_TOKEN=ew_live_${PROJECT_ID}_••••••••

# agent only — undocumented override read by agent.phar
NIGHTWATCH_BASE_URL=https://ingest.edgewatch.dev

php artisan nightwatch:agent`}</Code>
            <p>The agent calls <span className="font-mono text-slate-300">POST /api/agent-auth</span>, then sends gzip batches to the returned <span className="font-mono text-slate-300">ingest_url</span>.</p>
          </div>
        </Card>
        <Card title="Option B — edgewatch/laravel-edgewatch (agentless)">
          <div className="space-y-3 p-5 text-sm text-slate-400">
            <p>No agent process needed. Events are buffered (500 records) and sent over HTTPS with a 500ms timeout.</p>
            <Code>{`composer require edgewatch/laravel-edgewatch

# .env
EDGEWATCH_TOKEN=ew_live_${PROJECT_ID}_••••••••
EDGEWATCH_INGEST_URI=https://ingest.edgewatch.dev/api/ingest`}</Code>
            <p>Every <span className="font-mono">EDGEWATCH_*</span> key falls back to its <span className="font-mono">NIGHTWATCH_*</span> twin.</p>
          </div>
        </Card>
        <Card title="API keys" className="lg:col-span-2">
          <table className="w-full text-sm">
            <tbody>
              {[
                { name: 'Production ingest', key: `ew_live_${PROJECT_ID}_7f3a…`, scope: 'ingest', created: '2026-11-21' },
                { name: 'Dashboard (read)', key: `ew_read_${PROJECT_ID}_c91e…`, scope: 'read', created: '2026-11-21' },
              ].map((k) => (
                <tr key={k.key} className="border-t border-slate-800/70 first:border-t-0">
                  <td className="px-5 py-3 text-slate-200">{k.name}</td>
                  <td className="px-5 py-3 font-mono text-xs text-slate-400">{k.key}</td>
                  <td className="px-5 py-3"><span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs">{k.scope}</span></td>
                  <td className="px-5 py-3 text-xs text-slate-500">{k.created}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}
