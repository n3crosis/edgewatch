import { Badge } from '@cloudflare/kumo/components/badge';
import { Popover } from '@cloudflare/kumo/components/popover';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { CaretDownIcon, CheckIcon, GlobeIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api, useAsync } from '@/lib/api';
import { useEnvironment } from '@/lib/environment';
import { environmentScopedPath } from '@/lib/environment-scope';

export default function EnvironmentPicker() {
  const { environment, setEnvironment } = useEnvironment();
  const scoped = environmentScopedPath(useLocation().pathname);
  const { data, error } = useAsync(() => (scoped ? api.environments() : Promise.resolve([])), [scoped]);
  const [open, setOpen] = useState(false);

  if (!scoped) {
    return (
      <Tooltip asChild content="This page shows project-wide data across all environments.">
        <span className="inline-flex">
          <Badge variant="outline" className="inline-flex items-center gap-1.5">
            <GlobeIcon size={12} aria-hidden />
            <span>Project-wide</span>
          </Badge>
        </span>
      </Tooltip>
    );
  }

  const names = [...new Set([...(data ?? []).map((row) => row.name), ...(environment !== undefined ? [environment] : [])])].sort();

  return (
    <div className="flex items-center gap-1.5">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          render={
            <button
              type="button"
              aria-label="Environment"
              className="group inline-flex h-8 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-2.5 text-sm text-neutral-700 transition-colors hover:border-blue-500 hover:text-neutral-900 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-neutral-300 dark:hover:border-white/15 dark:hover:text-white"
            >
              <span className="size-2 shrink-0 rounded-full bg-blue-600 dark:bg-emerald-500" aria-hidden />
              <span className="max-w-32 truncate whitespace-nowrap">{environment ?? 'All environments'}</span>
              <CaretDownIcon size={12} className="shrink-0 text-neutral-500 group-hover:text-blue-600 dark:text-neutral-400 dark:group-hover:text-white" aria-hidden />
            </button>
          }
        />
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="end" sideOffset={8}>
            <Popover.Popup className="w-48 rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl shadow-black/10 dark:border-white/10 dark:bg-neutral-900">
              <div className="px-2.5 py-1 font-mono text-[10px] font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                Environment
              </div>
              <button
                type="button"
                onClick={() => {
                  setEnvironment(undefined);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                  environment === undefined
                    ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-white/[0.08] dark:text-white'
                    : 'text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-white/[0.04] dark:hover:text-white'
                }`}
              >
                <span>All environments</span>
                {environment === undefined && <CheckIcon size={13} className="text-blue-600 dark:text-emerald-500" />}
              </button>
              {names.map((name) => {
                const selected = environment === name;
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => {
                      setEnvironment(name);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                      selected
                        ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-white/[0.08] dark:text-white'
                        : 'text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-white/[0.04] dark:hover:text-white'
                    }`}
                  >
                    <span className="truncate">{name}</span>
                    {selected && <CheckIcon size={13} className="text-blue-600 dark:text-emerald-500" />}
                  </button>
                );
              })}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {error && (
        <Tooltip asChild content="Could not load environments.">
          <span role="alert" aria-label="Could not load environments" className="text-kumo-danger">
            <WarningCircleIcon size={15} />
          </span>
        </Tooltip>
      )}
    </div>
  );
}
