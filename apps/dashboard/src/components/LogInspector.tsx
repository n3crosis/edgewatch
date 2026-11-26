import { Dialog } from '@cloudflare/kumo/components/dialog';
import { ArrowUpRightIcon, ListBulletsIcon, XIcon } from '@phosphor-icons/react';
import { useRef } from 'react';
import { isoUtcTimestamp } from './charts';
import Link, { scopedPath } from './ScopedLink';
import { CopyButton, Empty, ErrorState, Loading } from './common';
import { LogLevelTag } from '@/pages/LogsPage';
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
  const { data, error, loading } = useAsync(
    () => (entryId ? api.logEntry(entryId, range, user) : Promise.resolve(null)),
    [entryId, range, user],
  );
  const formattedContext = data ? formatLogContext(data.context) : '';
  const hasContext = Boolean(data && data.context !== null && data.context !== undefined && data.context !== '' && data.context !== '{}' && data.context !== '[]');

  return (
    <Dialog.Root
      open={entryId !== null}
      onOpenChange={(open) => !open && onClose()}
      onOpenChangeComplete={(open) => {
        if (!open) (document.getElementById(`log-${lastEntry.current}`) ?? document.getElementById(fallbackId))?.focus();
      }}
    >
      {/* 1:1 Nightwatch `Logs-C7KeUP_O.js` (`S`) header + Source card + Log Context drawer */}
      <Dialog size="xl" className="max-h-[85vh] overflow-hidden p-0">
        <div className="flex h-12 items-center space-x-4 border-b border-neutral-200 dark:border-white/[0.08]">
          <Dialog.Close
            render={(props) => (
              <button
                {...props}
                type="button"
                aria-label="Close log entry"
                className="flex h-full w-12 shrink-0 items-center justify-center border-r border-neutral-200 bg-neutral-100 text-neutral-600 transition-colors hover:bg-neutral-200 hover:text-neutral-900 dark:border-white/[0.08] dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
              >
                <XIcon size={16} aria-hidden />
              </button>
            )}
          />
          <Dialog.Title className="font-mono text-sm leading-4 font-normal text-neutral-900 dark:text-white">
            {data ? `${isoUtcTimestamp(data.timestamp)} UTC` : 'Log entry'}
          </Dialog.Title>
        </div>

        <div className="max-h-[calc(85vh-3rem)] overflow-y-auto">
          {error ? (
            <div className="p-6"><ErrorState error={error} /></div>
          ) : loading ? (
            <div className="p-6"><Loading /></div>
          ) : !data ? (
            <div className="p-6">
              <Empty icon={<ListBulletsIcon size={32} className="text-kumo-subtle" />}>
                This log entry is unavailable in the selected project, environment, user or time window. It may have expired.
              </Empty>
            </div>
          ) : (
            <>
              <div className="mx-6 mt-6 flex items-start justify-between gap-3 font-mono text-sm leading-6">
                <div className="min-w-0 space-x-2">
                  <LogLevelTag level={data.level} />
                  <span className="whitespace-pre-wrap break-words text-neutral-900 dark:text-neutral-100">
                    {data.message}
                  </span>
                </div>
                <CopyButton text={String(data.message ?? '')} label="Copy message" className="shrink-0" />
              </div>

              <div className="space-y-4 p-6">
                {/* Source card matching Nightwatch `Logs-C7KeUP_O.js` */}
                <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white font-mono text-sm leading-6 dark:border-white/[0.08] dark:bg-white/[0.02]">
                  <div className="inline-flex min-h-11 w-full items-center justify-between gap-2 border-b border-neutral-200 px-4 py-2.5 dark:border-white/[0.06] dark:bg-white/[0.02]">
                    <p className="text-left font-sans text-sm leading-5 font-medium text-neutral-900 dark:text-white">
                      Source
                    </p>
                    {data.execution_available ? (
                      <Link
                        to={scopedPath(`/traces/${data.trace_id}`, projectId, range, environment)}
                        className="inline-flex h-6 items-center gap-1 rounded-md border border-neutral-200 bg-white px-2 font-mono text-[11px] font-medium uppercase text-neutral-700 transition-colors hover:border-blue-500 hover:text-neutral-900 dark:border-white/10 dark:bg-white/[0.04] dark:text-neutral-200 dark:hover:bg-neutral-700 dark:hover:text-white"
                      >
                        <span>{data.server ? 'REQUEST' : 'TRACE'}</span>
                        <ArrowUpRightIcon size={13} className="text-emerald-500" aria-hidden />
                      </Link>
                    ) : (
                      <span className="font-mono text-xs text-neutral-500">Unavailable</span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 p-4 text-xs leading-6 text-neutral-700 dark:text-neutral-300">
                    <span>{data.server || data.trace_id}</span>
                    {data.user && <span className="text-neutral-500 dark:text-neutral-400">User #{data.user}</span>}
                  </div>
                </div>

                {/* Log Context card */}
                <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.02]">
                  <div className="inline-flex min-h-11 w-full items-center justify-between gap-2 border-b border-neutral-200 px-4 py-2.5 dark:border-white/[0.06] dark:bg-white/[0.02]">
                    <p className="text-left text-sm leading-5 font-medium text-neutral-900 dark:text-white">
                      Log Context
                    </p>
                    {hasContext && <CopyButton text={formattedContext} label="Copy context" />}
                  </div>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6 text-neutral-700 dark:text-neutral-300">
                    {formattedContext}
                  </pre>
                </div>
              </div>
            </>
          )}
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
