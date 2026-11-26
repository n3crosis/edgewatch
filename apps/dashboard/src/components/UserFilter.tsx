import { Popover } from '@cloudflare/kumo/components/popover';
import { cn } from '@cloudflare/kumo/utils';
import {
  CaretDownIcon,
  CheckIcon,
  MagnifyingGlassIcon,
  ShieldCheckIcon,
  SpinnerGapIcon,
  UserIcon,
  UsersIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, useAsync } from '@/lib/api';
import { useRange } from '@/lib/range';

/**
 * 1:1 Nightwatch `UserFilter-CH64ybSf.js` + `Popover-CdZFIrma.js` (`.dropdown dark`) combobox:
 * - Always-dark popover (`bg-neutral-900 border-neutral-800 text-white`, dark `bg-neutral-800`)
 * - Includes `Clear filter`, `Authenticated Users` (`type:authenticated`), `Guest Users` (`type:guest`),
 *   separator, and live searchable `/users` list with checkmarks.
 */
export default function UserFilter({ className }: { className?: string }) {
  const { range } = useRange();
  const [params, setParams] = useSearchParams();
  const value = params.get('user') ?? '';
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const isTypeFilter = value === 'type:authenticated' || value === 'type:guest';

  const users = useAsync(
    () => (open || (Boolean(value) && !isTypeFilter) ? api.events('/users', range, { q: search.trim() || undefined }) : Promise.resolve(null)),
    [open, Boolean(value) && !isTypeFilter, range, search],
    { keepPreviousData: true },
  );

  const items = users.data?.data ?? [];
  const activeUser = useMemo(() => (!isTypeFilter && value ? items.find((u) => u.key === value) : undefined), [items, value, isTypeFilter]);

  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  const applyUser = (nextValue: string) => {
    const trimmed = nextValue.trim();
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (trimmed) next.set('user', trimmed);
      else next.delete('user');
      for (const key of ['cursor', 'offset', 'entry']) next.delete(key);
      return next;
    });
    setSearch('');
    setOpen(false);
  };

  const isActive = Boolean(value);
  const triggerLabel =
    value === 'type:authenticated'
      ? 'Authenticated Users'
      : value === 'type:guest'
        ? 'Guest Users'
        : isActive
          ? activeUser?.name
            ? String(activeUser.name)
            : value
          : 'All Users';

  const trimmedSearch = search.trim();
  const filteredItems = trimmedSearch
    ? items.filter((u) => {
        const needle = trimmedSearch.toLowerCase();
        return (
          u.key.toLowerCase().includes(needle) ||
          (u.name ? String(u.name).toLowerCase().includes(needle) : false)
        );
      })
    : items;

  const exactMatch = filteredItems.some((u) => u.key === trimmedSearch);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            aria-label="Filter by user"
            className={cn(
              'group flex h-8 items-center gap-2 rounded-lg border px-2.5 text-sm transition-colors',
              isActive
                ? 'border-blue-500 bg-blue-600 text-white hover:bg-blue-600/90 dark:border-blue-500 dark:bg-blue-600'
                : 'border-neutral-200 bg-white text-neutral-900 hover:border-blue-500 hover:bg-white dark:border-neutral-700/50 dark:bg-neutral-800 dark:text-white dark:hover:border-white/10 dark:hover:bg-neutral-700',
              className,
            )}
          >
            <UserIcon
              size={12}
              className={cn(
                'shrink-0',
                isActive
                  ? 'text-white group-hover:text-white'
                  : 'text-neutral-500 group-hover:text-blue-600 dark:text-neutral-400 dark:group-hover:text-white',
              )}
              aria-hidden
            />
            <span className="max-w-48 truncate whitespace-nowrap">{triggerLabel}</span>
            <CaretDownIcon
              size={14}
              className={cn(
                'shrink-0 transition-transform duration-200',
                open && 'rotate-180',
                isActive
                  ? 'text-white group-hover:text-white'
                  : 'text-neutral-500 group-hover:text-blue-600 dark:text-neutral-400 dark:group-hover:text-white',
              )}
              aria-hidden
            />
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4}>
          {/* 1:1 Nightwatch `.dropdown dark` surface */}
          <Popover.Popup className="w-[280px] overflow-hidden rounded-md border border-neutral-800 bg-neutral-900 p-0 text-white shadow-2xl shadow-black/50 dark:border-neutral-700/50 dark:bg-neutral-800">
            <div className="flex h-11 items-center border-b border-neutral-800 px-3 dark:border-neutral-700/50">
              <MagnifyingGlassIcon size={15} className="mr-2 shrink-0 text-neutral-400 opacity-60" aria-hidden />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && trimmedSearch) {
                    e.preventDefault();
                    applyUser(filteredItems[0]?.key ?? trimmedSearch);
                  }
                }}
                placeholder="Search users..."
                aria-label="Search users"
                className="flex w-full bg-transparent text-sm leading-tight text-white outline-none placeholder:font-light placeholder:text-neutral-500"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  className="ml-1 text-neutral-400 hover:text-white"
                >
                  <XIcon size={12} aria-hidden />
                </button>
              )}
            </div>

            <div className="max-h-[450px] overflow-x-hidden overflow-y-auto">
              {/* Top filter group: Clear filter + Authenticated Users + Guest Users */}
              <div className="p-1">
                {isActive && (
                  <button
                    type="button"
                    onClick={() => applyUser('')}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-white dark:hover:bg-white/5"
                  >
                    <XIcon size={12} className="shrink-0 text-neutral-400" aria-hidden />
                    <span>Clear filter</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => applyUser('type:authenticated')}
                  className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm text-white transition-colors hover:bg-neutral-700 dark:hover:bg-white/5"
                >
                  <span className="flex items-center gap-2">
                    <ShieldCheckIcon size={13} className="shrink-0 text-emerald-500" aria-hidden />
                    <span>Authenticated Users</span>
                  </span>
                  <CheckIcon
                    size={15}
                    className={cn('shrink-0 text-white', value === 'type:authenticated' ? 'opacity-100' : 'opacity-0')}
                    aria-hidden
                  />
                </button>

                <button
                  type="button"
                  onClick={() => applyUser('type:guest')}
                  className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm text-white transition-colors hover:bg-neutral-700 dark:hover:bg-white/5"
                >
                  <span className="flex items-center gap-2">
                    <UsersIcon size={13} className="shrink-0 text-emerald-500" aria-hidden />
                    <span>Guest Users</span>
                  </span>
                  <CheckIcon
                    size={15}
                    className={cn('shrink-0 text-white', value === 'type:guest' ? 'opacity-100' : 'opacity-0')}
                    aria-hidden
                  />
                </button>
              </div>

              <div className="h-px bg-neutral-700/50" />

              {/* Individual users group */}
              <div className="p-1">
                {users.loading && !users.data ? (
                  <div className="flex items-center justify-center py-6">
                    <SpinnerGapIcon size={16} className="animate-spin text-neutral-400" aria-hidden />
                  </div>
                ) : filteredItems.length === 0 && !trimmedSearch ? (
                  <div className="py-6 text-center text-sm text-neutral-400">No users found</div>
                ) : (
                  <>
                    {filteredItems.map((u) => {
                      const selected = value === u.key;
                      const primary = u.name ? String(u.name) : u.key;
                      return (
                        <button
                          key={u.key}
                          type="button"
                          onClick={() => applyUser(u.key)}
                          className="mb-0.5 flex h-10 w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-white transition-colors last:mb-0 hover:bg-neutral-700 dark:hover:bg-white/5"
                        >
                          <div className="flex min-w-0 flex-col">
                            <span className="truncate" title={primary}>{primary}</span>
                            {u.name && (
                              <span className="truncate text-xs text-neutral-400" title={`#${u.key}`}>
                                #{u.key}
                              </span>
                            )}
                          </div>
                          <CheckIcon
                            size={15}
                            className={cn('shrink-0 text-white', selected ? 'opacity-100' : 'opacity-0')}
                            aria-hidden
                          />
                        </button>
                      );
                    })}

                    {trimmedSearch && !exactMatch && (
                      <button
                        type="button"
                        onClick={() => applyUser(trimmedSearch)}
                        className="flex h-10 w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-neutral-300 transition-colors hover:bg-neutral-700 hover:text-white dark:hover:bg-white/5"
                      >
                        <span className="truncate">
                          Filter by ID <span className="font-mono text-white">#{trimmedSearch}</span>
                        </span>
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
