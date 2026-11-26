import { ArrowUpRightIcon, ListBulletsIcon, XIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link, { scopedPath } from './ScopedLink';
import { CopyButton, Empty, ErrorState, Loading, UtcDate } from './common';
import { LogLevelTag } from '@/pages/LogsPage';
import { api, useAsync } from '@/lib/api';
import { useEnvironment } from '@/lib/environment';
import { useLayoutScroll } from '@/lib/preferences';
import { useProject } from '@/lib/project';
import type { Range } from '@/lib/types';

const SEVERE_LEVELS = new Set(['emergency', 'alert', 'critical', 'error']);
const SHEET_WIDTH_STORAGE_KEY = 'nightwatch:sheet-width-ratio';
const DEFAULT_WIDTH_RATIO = 0.34;
const MIN_WIDTH_RATIO = 0.2;
const MAX_WIDTH_RATIO = 0.55;

function readWidthRatio(): number {
  try {
    const raw = globalThis.localStorage?.getItem(SHEET_WIDTH_STORAGE_KEY);
    if (!raw) return DEFAULT_WIDTH_RATIO;
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed)) return Math.min(Math.max(parsed, MIN_WIDTH_RATIO), MAX_WIDTH_RATIO);
  } catch {
    /* Ignore storage errors. */
  }
  return DEFAULT_WIDTH_RATIO;
}

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

/** 1:1 Nightwatch `Sheet-BK3HXhaM.js` + `Logs-CkjZtI46.js` resizable right-aligned log inspector drawer. */
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
  const { scrollToTop } = useLayoutScroll();
  const lastEntry = useRef<string | null>(null);
  const ratioRef = useRef<number>(readWidthRatio());
  const [widthRatio, setWidthRatio] = useState<number>(ratioRef.current);
  const [resizing, setResizing] = useState(false);

  const open = entryId !== null;
  if (entryId) lastEntry.current = entryId;

  const { data, error, loading } = useAsync(
    () => (entryId ? api.logEntry(entryId, range, user) : Promise.resolve(null)),
    [entryId, range, user],
  );

  const restoreFocusAndClose = useCallback(() => {
    onClose();
    requestAnimationFrame(() => {
      (document.getElementById(`log-${lastEntry.current}`) ?? document.getElementById(fallbackId))?.focus();
    });
  }, [fallbackId, onClose]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        restoreFocusAndClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, restoreFocusAndClose]);

  useEffect(() => {
    if (!resizing) return;
    const onMove = (event: MouseEvent) => {
      const next = Math.min(Math.max((window.innerWidth - event.clientX) / window.innerWidth, MIN_WIDTH_RATIO), MAX_WIDTH_RATIO);
      ratioRef.current = next;
      setWidthRatio(next);
    };
    const onUp = () => {
      setResizing(false);
      try {
        localStorage.setItem(SHEET_WIDTH_STORAGE_KEY, ratioRef.current.toString());
      } catch {
        /* Ignore storage errors. */
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [resizing]);

  if (!open || typeof document === 'undefined') return null;

  const formattedContext = data ? formatLogContext(data.context) : '';
  const hasContext = Boolean(
    data && data.context !== null && data.context !== undefined && data.context !== '' && data.context !== '{}' && data.context !== '[]',
  );

  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Log entry details">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/70 backdrop-blur-[1px] transition-opacity"
        onClick={restoreFocusAndClose}
        aria-hidden
      />

      {/* Right-aligned resizable sheet (`Sheet-BK3HXhaM.js`) */}
      <div
        style={{ width: `max(340px, ${widthRatio * 100}vw)` }}
        className="fixed inset-y-0 right-0 z-50 flex max-w-[92vw] flex-col border-l border-neutral-200 bg-neutral-100 shadow-2xl dark:border-white/[0.08] dark:bg-neutral-900"
      >
        {/* Left-edge drag-to-resize handle + pill grip indicator */}
        <div
          onMouseDown={(event) => {
            event.preventDefault();
            setResizing(true);
          }}
          aria-hidden
          className="absolute top-0 -left-2 z-50 hidden h-full w-4 cursor-col-resize md:block"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute top-1/2 -left-1.25 z-50 hidden h-9 w-2.25 -translate-y-1/2 rounded-full border border-neutral-300 bg-white shadow-xs md:block dark:border-neutral-600 dark:bg-neutral-900"
        />

        {/* Top bar */}
        <div className="flex h-12 shrink-0 items-center space-x-4 border-b border-neutral-200 bg-white/80 dark:border-white/[0.08] dark:bg-neutral-900">
          <button
            type="button"
            onClick={restoreFocusAndClose}
            aria-label="Close log entry"
            className="flex h-full w-12 shrink-0 items-center justify-center border-r border-neutral-200 bg-neutral-100 text-neutral-600 transition-colors hover:bg-neutral-200 hover:text-neutral-900 dark:border-white/[0.08] dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
          >
            <XIcon size={16} aria-hidden />
          </button>
          <div className="min-w-0 truncate font-mono text-sm leading-4 font-normal text-neutral-900 dark:text-white">
            {data ? <UtcDate iso={data.timestamp} className="text-sm" /> : 'Log entry'}
          </div>
        </div>

        {/* Scrollable body */}
        <div className="min-h-0 flex-1 overflow-y-auto">
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
                {/* Source card matching Nightwatch `Logs-CkjZtI46.js` */}
                <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white font-mono text-sm leading-6 dark:border-white/[0.08] dark:bg-white/[0.02]">
                  <div className="inline-flex min-h-11 w-full items-center justify-between gap-2 border-b border-neutral-200 px-4 py-2.5 dark:border-white/[0.06] dark:bg-white/[0.02]">
                    <p className="text-left font-sans text-sm leading-5 font-medium text-neutral-900 dark:text-white">
                      Source
                    </p>
                    {data.execution_available ? (
                      <Link
                        to={scopedPath(`/traces/${data.trace_id}`, projectId, range, environment)}
                        onClick={scrollToTop}
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
      </div>
    </div>,
    document.body,
  );
}
