import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { PageHeader, Panel } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
      <pre className="overflow-x-auto rounded-lg bg-muted p-4 pr-12 font-mono text-xs leading-relaxed">{children}</pre>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="absolute right-2 top-2" onClick={copy} aria-label="Copy">
            {copied ? <Check /> : <Copy />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{copied ? 'Copied' : 'Copy'}</TooltipContent>
      </Tooltip>
    </div>
  );
}

const KEYS = [
  { name: 'Production ingest', key: `ew_live_${PROJECT_ID}_7f3a…`, scope: 'ingest', created: '2026-11-21' },
  { name: 'Dashboard (read)', key: `ew_read_${PROJECT_ID}_c91e…`, scope: 'read', created: '2026-11-21' },
];

export default function SetupPage() {
  return (
    <>
      <PageHeader title="Setup" subtitle="Send data with the official Laravel Nightwatch agent or the EdgeWatch client" />
      <Tabs defaultValue="nightwatch">
        <TabsList>
          <TabsTrigger value="nightwatch">laravel/nightwatch (drop-in)</TabsTrigger>
          <TabsTrigger value="edgewatch">laravel-edgewatch (agentless)</TabsTrigger>
        </TabsList>
        <TabsContent value="nightwatch">
          <Card>
            <CardHeader>
              <CardTitle>Keep the official Nightwatch client</CardTitle>
              <CardDescription>
                Point the agent at EdgeWatch. Application code and <span className="font-mono">NIGHTWATCH_*</span> settings stay as they are.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <Code>{`# .env (app and agent)
NIGHTWATCH_TOKEN=ew_live_${PROJECT_ID}_••••••••

# agent only: undocumented override read by agent.phar
NIGHTWATCH_BASE_URL=https://ingest.edgewatch.dev

php artisan nightwatch:agent`}</Code>
              <p>
                The agent calls <span className="font-mono text-foreground">POST /api/agent-auth</span>, then sends gzip batches to the returned{' '}
                <span className="font-mono text-foreground">ingest_url</span>.
              </p>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="edgewatch">
          <Card>
            <CardHeader>
              <CardTitle>edgewatch/laravel-edgewatch</CardTitle>
              <CardDescription>No agent process. Events are buffered (500 records) and sent over HTTPS with a 500ms timeout.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <Code>{`composer require edgewatch/laravel-edgewatch

# .env
EDGEWATCH_TOKEN=ew_live_${PROJECT_ID}_••••••••
EDGEWATCH_INGEST_URI=https://ingest.edgewatch.dev/api/ingest`}</Code>
              <p>
                Every <span className="font-mono">EDGEWATCH_*</span> key falls back to its <span className="font-mono">NIGHTWATCH_*</span> twin.
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      <Panel title="API keys" className="mt-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-5">Name</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead className="px-5">Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {KEYS.map((k) => (
              <TableRow key={k.key}>
                <TableCell className="px-5">{k.name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{k.key}</TableCell>
                <TableCell><Badge variant={k.scope === 'ingest' ? 'default' : 'secondary'}>{k.scope}</Badge></TableCell>
                <TableCell className="px-5 text-xs text-muted-foreground">{k.created}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
    </>
  );
}
