import { useMemo, useState } from 'react';
import { Button } from '@cloudflare/kumo/components/button';
import { useKumoToastManager } from '@cloudflare/kumo/components/toast';
import { CaretUpDownIcon, CheckIcon, CopyIcon, FolderIcon, FolderOpenIcon } from '@phosphor-icons/react';
import { formatStackTrace } from '@/lib/ui-helpers';
import type { ExceptionDetail } from '@/lib/types';

export type ExceptionFrame = ExceptionDetail['stack'][number];

function FrameSource({ source }: { source: string }) {
  const parenIdx = source.indexOf('(');
  const fnPart = parenIdx >= 0 ? source.slice(0, parenIdx) : source;
  const argPart = parenIdx >= 0 ? source.slice(parenIdx) : '';
  return (
    <span className="truncate font-mono text-xs">
      <span className="text-violet-500 dark:text-violet-400">{fnPart}</span>
      {argPart && <span className="text-orange-400 dark:text-orange-300">{argPart}</span>}
    </span>
  );
}

function VendorFrameGroup({ frames }: { frames: ExceptionFrame[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className={`group rounded-lg border ${
        expanded
          ? 'bg-white dark:border-white/5 dark:bg-white/5'
          : 'border-dashed border-neutral-300 bg-neutral-50 opacity-90 dark:border-white/10 dark:bg-white/[0.015]'
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex h-11 w-full items-center gap-2.5 rounded-lg pr-2.5 pl-4 text-left transition-colors hover:bg-white/50 dark:hover:bg-white/[0.02]"
      >
        {expanded ? (
          <FolderOpenIcon size={13} className="shrink-0 text-emerald-500" aria-hidden />
        ) : (
          <FolderIcon size={13} className="shrink-0 text-neutral-400 group-hover:text-emerald-500" aria-hidden />
        )}
        <span className="flex-1 font-mono text-xs leading-3 text-neutral-600 dark:text-neutral-400">
          {frames.length.toLocaleString()} vendor {frames.length === 1 ? 'frame' : 'frames'}
        </span>
        <span className="inline-flex size-6 items-center justify-center rounded-md border bg-white text-neutral-500 group-hover:text-emerald-500 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-neutral-400">
          <CaretUpDownIcon size={12} aria-hidden />
        </span>
      </button>
      {expanded && (
        <div className="divide-y divide-neutral-100 border-t border-neutral-100 dark:divide-white/5 dark:border-white/5">
          {frames.map((frame, i) => (
            <div key={i} className="flex h-11 items-center justify-between gap-6 px-3">
              <FrameSource source={frame.source || 'Entrypoint'} />
              <span className="shrink-0 font-mono text-xs text-neutral-700 dark:text-neutral-300">{frame.file}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 1:1 Nightwatch `ExceptionCard-DPB90xMt.js` shared by ExceptionDetailPage and IssueDetailPage. */
export default function ExceptionCard({
  className: exceptionClass,
  message,
  handled,
  file,
  line,
  stack = [],
}: {
  className: string;
  message: string;
  handled: boolean;
  file?: string;
  line?: number;
  stack?: ExceptionFrame[];
}) {
  const toasts = useKumoToastManager();
  const [copiedMd, setCopiedMd] = useState(false);

  const frameGroups = useMemo(() => {
    const groups: { vendor: boolean; frames: ExceptionFrame[] }[] = [];
    for (const frame of stack) {
      const isVendor = frame.file.startsWith('vendor/') || frame.file.startsWith('[');
      const last = groups[groups.length - 1];
      if (!last || last.vendor !== isVendor) {
        groups.push({ vendor: isVendor, frames: [frame] });
      } else {
        last.frames.push(frame);
      }
    }
    return groups;
  }, [stack]);

  const stackMarkdown = formatStackTrace(exceptionClass, message, stack);

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(stackMarkdown);
      setCopiedMd(true);
      toasts.add({ title: 'Exception details copied to clipboard.', variant: 'success' });
      setTimeout(() => setCopiedMd(false), 1500);
    } catch {
      toasts.add({ title: 'Could not copy stack trace.', variant: 'error' });
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-md shadow-black/[0.04] dark:border-white/[0.06] dark:bg-white/[0.02]">
      <div className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {!handled && (
              <span className="inline-flex h-5 items-center rounded bg-rose-600 px-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white">
                Unhandled
              </span>
            )}
          </div>
          <Button
            variant="secondary"
            size="xs"
            icon={copiedMd ? CheckIcon : CopyIcon}
            onClick={copyMarkdown}
          >
            {copiedMd ? 'Copied' : 'Copy as Markdown'}
          </Button>
        </div>
        <div className="mt-1 break-all text-xl font-semibold leading-tight text-neutral-900 sm:text-2xl/none dark:text-white">
          {exceptionClass}
        </div>
        <div className="max-h-48 overflow-y-auto whitespace-pre-wrap text-sm text-neutral-600 dark:text-neutral-400">
          {message}
        </div>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-neutral-200 bg-neutral-50 p-2.5 dark:border-white/[0.06] dark:bg-neutral-900/60">
        {frameGroups.length === 0 ? (
          <div className="flex h-11 items-center justify-between gap-6 rounded-lg border border-neutral-200 bg-white px-4 font-mono text-xs text-neutral-600 dark:border-white/10 dark:bg-white/[0.03] dark:text-neutral-400">
            <span>Stack trace not available</span>
            {file && <span>{line ? `${file}:${line}` : file}</span>}
          </div>
        ) : (
          frameGroups.map((grp, gIdx) =>
            grp.vendor ? (
              <VendorFrameGroup key={gIdx} frames={grp.frames} />
            ) : (
              grp.frames.map((frame, fIdx) => (
                <div
                  key={`${gIdx}-${fIdx}`}
                  className="flex h-11 items-center gap-3 rounded-lg border border-neutral-200 bg-white px-4 dark:border-white/[0.08] dark:bg-white/[0.03]"
                >
                  <span className="size-2 shrink-0 rounded-full bg-neutral-300 dark:bg-neutral-600" aria-hidden />
                  <div className="flex min-w-0 flex-1 items-center justify-between gap-6">
                    <FrameSource source={frame.source || 'Entrypoint'} />
                    <span className="shrink-0 font-mono text-xs text-neutral-700 dark:text-neutral-300">
                      {frame.file}
                    </span>
                  </div>
                </div>
              ))
            ),
          )
        )}
      </div>
    </div>
  );
}
