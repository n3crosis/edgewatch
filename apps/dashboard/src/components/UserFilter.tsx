import { Button } from '@cloudflare/kumo/components/button';
import { InputGroup } from '@cloudflare/kumo/components/input-group';
import { Popover } from '@cloudflare/kumo/components/popover';
import { cn } from '@cloudflare/kumo/utils';
import { CaretDownIcon, CheckIcon, UserIcon, XIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/** 1:1 Capture `All Users v` header pill backed by a Kumo Popover for exact user ID filtering. */
export default function UserFilter({ className }: { className?: string }) {
  const [params, setParams] = useSearchParams();
  const value = params.get('user') ?? '';
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const applyUser = (nextValue: string) => {
    const trimmed = nextValue.trim();
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (trimmed) next.set('user', trimmed);
      else next.delete('user');
      for (const key of ['cursor', 'offset', 'entry']) next.delete(key);
      return next;
    });
    setOpen(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            aria-label="Filter by user"
            className={cn(
              'group inline-flex h-8 items-center gap-2 rounded-lg border px-2.5 text-sm transition-colors',
              value
                ? 'border-blue-500/70 bg-blue-50/70 text-blue-900 dark:border-blue-500/40 dark:bg-blue-950/50 dark:text-blue-200'
                : 'border-neutral-200 bg-white text-neutral-700 hover:border-blue-500 hover:text-neutral-900 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-neutral-300 dark:hover:border-white/15 dark:hover:text-white',
              className,
            )}
          >
            <UserIcon size={13} className="shrink-0 text-neutral-500 group-hover:text-blue-600 dark:text-neutral-400 dark:group-hover:text-white" aria-hidden />
            <span className="max-w-36 truncate whitespace-nowrap">{value ? `User #${value}` : 'All Users'}</span>
            <CaretDownIcon size={12} className="shrink-0 text-neutral-500 group-hover:text-blue-600 dark:text-neutral-400 dark:group-hover:text-white" aria-hidden />
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8}>
          <Popover.Popup className="w-72 rounded-xl border border-neutral-200 bg-white p-4 shadow-xl shadow-black/10 dark:border-white/10 dark:bg-neutral-900">
            <Popover.Title className="text-sm font-semibold text-neutral-900 dark:text-white">Filter by user</Popover.Title>
            <Popover.Description className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
              Show telemetry triggered by a specific authenticated user ID.
            </Popover.Description>
            <form
              className="mt-3 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                applyUser(draft);
              }}
            >
              <InputGroup>
                <InputGroup.Addon align="start">
                  <UserIcon className="text-kumo-subtle" />
                </InputGroup.Addon>
                <InputGroup.Input
                  autoFocus
                  type="text"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="User ID (e.g. 42)"
                  aria-label="User ID"
                />
                {draft && (
                  <InputGroup.Addon align="end">
                    <button
                      type="button"
                      onClick={() => setDraft('')}
                      aria-label="Clear input"
                      className="grid size-5 place-items-center rounded text-kumo-subtle hover:text-kumo-strong"
                    >
                      <XIcon size={12} />
                    </button>
                  </InputGroup.Addon>
                )}
              </InputGroup>
              <div className="flex items-center justify-between gap-2">
                {value ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => applyUser('')}>
                    All Users
                  </Button>
                ) : (
                  <span />
                )}
                <Button type="submit" variant="primary" size="sm" icon={CheckIcon}>
                  Apply
                </Button>
              </div>
            </form>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
