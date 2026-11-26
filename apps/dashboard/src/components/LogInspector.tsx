import { Badge } from '@cloudflare/kumo/components/badge';
import { Button, LinkButton } from '@cloudflare/kumo/components/button';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { ArrowSquareOutIcon, ClockIcon, CloudIcon, FolderSimpleIcon, HardDrivesIcon, ListBulletsIcon, UserIcon, XIcon } from '@phosphor-icons/react';
import { useRef } from 'react';
import { scopedPath } from './ScopedLink';
import { CopyButton, Empty, ErrorState, Loading } from './common';
import { api, useAsync } from '@/lib/api';
import { useEnvironment } from '@/lib/environment';
import { useProject } from '@/lib/project';
import type { Range } from '@/lib/types';

const SEVERE_LEVELS = new Set(['emergency', 'alert', 'critical', 'error']);

export function logLevelVariant(level: unknown): 'error' | 'warning' | 'info' | 'secondary' {
  const lower = String(level ?? '').toLowerCase();
  if (SEVERE_LEVELS.has(lower)) return 'error';
  if (lower === 'warning') return 'warning';
  if (lower === 'notice' || lower === 'info') return 'info';
  return 'secondary';
}

export function formatLogContext(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Context was not captured.';
  try {
    return JSON.stringify(JSON.parse(String(value)), null, 2);
  } catch {
    return String(value);
  }
}

export default function LogInspector({
  entryId,
  range,
  onClose,
  fallbackId,
  user,
}: {
  entryId: string | null;
  range: Range;
  onClose: () => void;
  fallbackId: string;
  user?: string;
}) {
  const { projectId } = useProject();
  const { environment } = useEnvironment();
  const lastEntry = useRef<string | null>(null);
  if (entryId) lastEntry.current = entryId;
  const { data, error, loading } = useAsync(() => entryId ? api.logEntry(entryId, range, user) : Promise.resolve(null), [entryId, range, user]);
  const formattedContext = data ? formatLogContext(data.context) : '';

  return (
    <Dialog.Root
      open={entryId !== null}
      onOpenChange={(open) => !open && onClose()}
      onOpenChangeComplete={(open) => {
        if (!open) (document.getElementById(`log-${lastEntry.current}`) ?? document.getElementById(fallbackId))?.focus();
      }}
    >
      <Dialog size="xl" className="max-h-[85vh] overflow-auto p-6 sm:p-8">
        <div className="mb-6 flex items-start justify-between gap-4 border-b border-kumo-hairline pb-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <Dialog.Title className="text-lg font-semibold text-kumo-strong">Log entry</Dialog.Title>
              {data && <Badge variant={logLevelVariant(data.level)}>{data.level}</Badge>}
            </div>
            <Dialog.Description className="mt-1 text-xs text-kumo-subtle">
              Captured message, structured context, and originating execution
            </Dialog.Description>
          </div>
          <Dialog.Close render={(props) => <Button {...props} variant="ghost" shape="square" size="sm" icon={<XIcon />} aria-label="Close log entry" />} />
        </div>
        {error ? (
          <ErrorState error={error} />
        ) : loading ? (
          <Loading />
        ) : !data ? (
          <Empty icon={<ListBulletsIcon size={32} className="text-kumo-subtle" />}>
            This log entry is unavailable in the selected project, environment, user or time window. It may have expired.
          </Empty>
        ) : (
          <div className="space-y-6 text-sm">
            <dl className="grid grid-cols-2 gap-x-8 gap-y-4 rounded-xl border border-kumo-hairline bg-kumo-elevated/60 p-5 sm:grid-cols-3">
              <div>
                <dt className="flex items-center gap-1.5 text-xs font-medium text-kumo-subtle"><ClockIcon size={13} aria-hidden />Timestamp</dt>
                <dd className="mt-1 font-mono text-xs text-kumo-strong">{new Date(data.timestamp).toLocaleString()}</dd>
              </div>
              <div>
                <dt className="flex items-center gap-1.5 text-xs font-medium text-kumo-subtle"><FolderSimpleIcon size={13} aria-hidden />Project</dt>
                <dd className="mt-1 font-mono text-xs text-kumo-strong">{data.project_id}</dd>
              </div>
              <div>
                <dt className="flex items-center gap-1.5 text-xs font-medium text-kumo-subtle"><CloudIcon size={13} aria-hidden />Environment</dt>
                <dd className="mt-1 text-xs text-kumo-strong">{data.environment || 'Unknown'}</dd>
              </div>
              <div>
                <dt className="flex items-center gap-1.5 text-xs font-medium text-kumo-subtle"><HardDrivesIcon size={13} aria-hidden />Server</dt>
                <dd className="mt-1 font-mono text-xs text-kumo-strong">{data.server || 'Not captured'}</dd>
              </div>
              <div>
                <dt className="flex items-center gap-1.5 text-xs font-medium text-kumo-subtle"><UserIcon size={13} aria-hidden />User</dt>
                <dd className="mt-1 font-mono text-xs text-kumo-strong">{data.user ? `#${data.user}` : 'Not captured'}</dd>
              </div>
            </dl>
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">Message</h3>
                <CopyButton text={String(data.message ?? '')} label="Copy message" />
              </div>
              <pre className="whitespace-pre-wrap break-words rounded-xl border border-kumo-hairline bg-kumo-recessed p-4 font-mono text-xs leading-6 text-kumo-strong">{data.message}</pre>
            </section>
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">Context</h3>
                {data.context !== null && data.context !== undefined && data.context !== '' && <CopyButton text={formattedContext} label="Copy context" />}
              </div>
              <pre className="whitespace-pre-wrap break-words rounded-xl border border-kumo-hairline bg-kumo-recessed p-4 font-mono text-xs leading-6 text-kumo-default">{formattedContext}</pre>
            </section>
            <section className="flex flex-wrap items-center justify-between gap-4 border-t border-kumo-hairline pt-5">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">Originating execution</h3>
                {!data.execution_available && (
                  <p className="mt-1 text-xs text-kumo-subtle">The originating execution is unavailable. It may not have been captured or may have expired.</p>
                )}
              </div>
              {data.execution_available && (
                <LinkButton
                  href={scopedPath(`/traces/${data.trace_id}`, projectId, range, environment)}
                  variant="secondary"
                  size="sm"
                  icon={ArrowSquareOutIcon}
                  className="font-mono"
                >
                  {data.trace_id}
                </LinkButton>
              )}
            </section>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  );
}
