import { Button } from '@cloudflare/kumo/components/button';
import { cn } from '@cloudflare/kumo/utils';
import { CaretDownIcon, WarningIcon, XIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CopyButton } from './common';

const WIDTH_KEY = 'nightwatch:sheet-width-ratio';
const DEFAULT_RATIO = 0.36;
const MIN_RATIO = 0.22;
const MAX_RATIO = 0.58;
const MAX_CONTEXT_BYTES = 65535;

function readWidthRatio(): number {
  try {
    const raw = globalThis.localStorage?.getItem(WIDTH_KEY);
    if (!raw) return DEFAULT_RATIO;
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n)) return Math.min(Math.max(n, MIN_RATIO), MAX_RATIO);
  } catch {
    /* ignore */
  }
  return DEFAULT_RATIO;
}

export function parseTraceContext(raw: unknown): Record<string, unknown> | string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return Object.keys(obj).length ? obj : null;
  }
  const str = String(raw).trim();
  if (!str) return null;
  try {
    const parsed = JSON.parse(str);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed).length ? (parsed as Record<string, unknown>) : null;
    }
    return str;
  } catch {
    return str;
  }
}

/** 1:1 Nightwatch `ContextDrawer-WABm-Lk-.js` resizable slide-over Sheet with Collapse all + collapsible JSON cards. */
export default function ContextDrawer({
  open,
  context,
  onClose,
}: {
  open: boolean;
  context: Record<string, unknown> | string | null;
  onClose: () => void;
}) {
  const ratioRef = useRef<number>(readWidthRatio());
  const [widthRatio, setWidthRatio] = useState<number>(ratioRef.current);
  const [resizing, setResizing] = useState(false);

  const keys = useMemo(
    () => (context && typeof context === 'object' ? Object.keys(context) : []),
    [context],
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return;
    const next: Record<string, boolean> = {};
    for (const k of keys) next[k] = true;
    setExpanded(next);
  }, [open, keys]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      const next = Math.min(Math.max((window.innerWidth - e.clientX) / window.innerWidth, MIN_RATIO), MAX_RATIO);
      ratioRef.current = next;
      setWidthRatio(next);
    };
    const onUp = () => {
      setResizing(false);
      try {
        localStorage.setItem(WIDTH_KEY, ratioRef.current.toString());
      } catch {
        /* ignore */
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

  if (!open || !context || typeof document === 'undefined') return null;

  const hasNested =
    typeof context === 'object' &&
    Object.values(context).some((v) => v !== null && typeof v === 'object');
  const allCollapsed = hasNested && keys.every((k) => !expanded[k]);

  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Execution context">
      <div className="fixed inset-0 bg-black/70 backdrop-blur-[1px]" onClick={onClose} aria-hidden />
      <div
        style={{ width: `max(360px, ${widthRatio * 100}vw)` }}
        className="fixed inset-y-0 right-0 z-50 flex max-w-[92vw] flex-col border-l border-neutral-200 bg-neutral-100 shadow-2xl dark:border-white/[0.08] dark:bg-neutral-900"
      >
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            setResizing(true);
          }}
          aria-hidden
          className="absolute top-0 -left-2 z-50 hidden h-full w-4 cursor-col-resize md:block"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute top-1/2 -left-1.25 z-50 hidden h-9 w-2.25 -translate-y-1/2 rounded-full border border-neutral-300 bg-white shadow-xs md:block dark:border-neutral-600 dark:bg-neutral-900"
        />

        <div className="flex h-12 shrink-0 items-center border-b border-neutral-200 bg-white/80 dark:border-white/[0.08] dark:bg-neutral-900">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close context"
            className="flex h-full w-12 shrink-0 items-center justify-center border-r border-neutral-200 bg-neutral-100 text-neutral-600 transition-colors hover:bg-neutral-200 hover:text-neutral-900 dark:border-white/[0.08] dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
          >
            <XIcon size={16} aria-hidden />
          </button>
          <div className="flex h-full flex-1 items-center justify-between px-4">
            <h2 className="font-medium text-neutral-900 dark:text-white">Context</h2>
            {hasNested && (
              <Button
                variant="secondary"
                size="sm"
                disabled={allCollapsed}
                onClick={() => {
                  const next: Record<string, boolean> = {};
                  for (const k of keys) next[k] = false;
                  setExpanded(next);
                }}
              >
                Collapse all
              </Button>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3 font-mono">
          {typeof context === 'string' ? (
            <div className="divide-y divide-neutral-200 overflow-hidden rounded-md border border-neutral-200 bg-white dark:divide-neutral-800 dark:border-white/[0.06] dark:bg-white/[0.02]">
              <div className="flex items-center gap-2 px-4 py-2.5 text-sm text-neutral-700 dark:text-neutral-300">
                <WarningIcon size={15} className="shrink-0 text-amber-500" aria-hidden />
                <span>
                  {context.length === MAX_CONTEXT_BYTES
                    ? `Context exceeded limit (trimmed to ${MAX_CONTEXT_BYTES.toLocaleString()} bytes)`
                    : 'Unable to parse'}
                </span>
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words px-4 py-3 text-xs text-neutral-800 dark:text-neutral-200">
                {context}
              </pre>
            </div>
          ) : (
            Object.entries(context).map(([key, value]) => {
              const isObj = value !== null && typeof value === 'object';
              const isOpen = Boolean(expanded[key]);
              if (!isObj) {
                return (
                  <div
                    key={key}
                    className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm dark:border-white/[0.06] dark:bg-white/[0.02]"
                  >
                    <span className="break-all text-neutral-900 dark:text-neutral-200">{key}</span>
                    <span className={cn('break-all text-right text-xs', value === null ? 'text-neutral-400' : 'text-neutral-700 dark:text-neutral-300')}>
                      {String(value)}
                    </span>
                  </div>
                );
              }
              const count = Array.isArray(value) ? value.length : Object.keys(value).length;
              const pretty = JSON.stringify(value, null, 2);
              return (
                <div
                  key={key}
                  className="overflow-hidden rounded-md border border-neutral-200 bg-white dark:border-white/[0.06] dark:bg-white/[0.02]"
                >
                  <button
                    type="button"
                    onClick={() => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))}
                    className="group flex min-h-11 w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-sm transition-colors hover:bg-neutral-50 dark:hover:bg-white/[0.03]"
                  >
                    <span className="break-all text-neutral-900 dark:text-neutral-100">{key}</span>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-neutral-500">
                      <span>
                        {count} {count === 1 ? 'item' : 'items'}
                      </span>
                      <CaretDownIcon
                        size={14}
                        className={cn(
                          'transition-transform duration-200',
                          isOpen && 'rotate-180 text-emerald-500',
                        )}
                        aria-hidden
                      />
                    </span>
                  </button>
                  {isOpen && (
                    <div className="relative border-t border-neutral-200/80 dark:border-neutral-800">
                      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all px-4 py-3 pr-12 text-xs leading-6 text-neutral-800 dark:text-neutral-200">
                        {pretty}
                      </pre>
                      <CopyButton text={pretty} label={`Copy ${key}`} className="absolute right-2.5 top-2.5" />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
