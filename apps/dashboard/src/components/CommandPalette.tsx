import { Badge } from '@cloudflare/kumo/components/badge';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { ArrowDownIcon, ArrowUpIcon, GitBranchIcon, KeyReturnIcon, MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react';
import { useEffect, useId, useMemo, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { asTraceId, matchCommands, moveSelection, shouldSearchTraces, type PaletteCommand } from '@/lib/command-palette';
import type { Range } from '@/lib/types';

interface Props {
  open: boolean;
  onClose: () => void;
  pages: PaletteCommand[];
  icons?: Record<string, ComponentType<{ size?: number; className?: string }>>;
  range: Range;
  /** Adds the current project, range and environment to a path. */
  scope: (path: string) => string;
}

const SEARCH_DELAY_MS = 200;
const MAX_TRACES = 6;

export default function CommandPalette({ open, onClose, pages, icons, range, scope }: Props) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const listId = useId();
  const optionId = (i: number) => `${listId}-option-${i}`;
  const input = useRef<HTMLInputElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [traces, setTraces] = useState<PaletteCommand[]>([]);
  const [search, setSearch] = useState<'idle' | 'loading' | 'error'>('idle');

  // Remember what had focus, focus the input, and hand focus back on close.
  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery('');
    setSelected(0);
    input.current?.focus();
  }, [open]);

  useEffect(() => {
    setTraces([]);
    if (!open || !shouldSearchTraces(query)) return setSearch('idle');
    let current = true;
    setSearch('loading');
    const timer = setTimeout(() => {
      api
        .traces({ q: query.trim(), source: 'all', range }, null)
        .then((page) => {
          if (!current) return;
          setTraces(page.data.slice(0, MAX_TRACES).map((t) => ({ id: `trace-${t.trace_id}`, label: t.name, to: `/traces/${t.trace_id}`, keywords: [t.url ?? '', t.trace_id], group: 'Traces' })));
          setSearch('idle');
        })
        .catch(() => current && setSearch('error'));
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, query, range]);

  const items = useMemo(() => {
    const id = asTraceId(query);
    const direct: PaletteCommand[] = id ? [{ id: 'open-trace', label: `Open trace ${id}`, to: `/traces/${id}`, group: 'Traces' }] : [];
    return [...direct, ...matchCommands(query, pages), ...traces];
  }, [query, pages, traces]);

  useEffect(() => setSelected((i) => moveSelection(i, '', items.length)), [items.length]);
  useEffect(() => {
    if (open && selected >= 0) document.getElementById(optionId(selected))?.scrollIntoView?.({ block: 'nearest' });
  }, [open, selected]);

  const go = (item: PaletteCommand | undefined) => {
    if (!item) return;
    restore.current = null;
    onClose();
    navigate(scope(item.to));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      setSelected((i) => moveSelection(i, e.key, items.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(items[selected]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(value) => { if (!value) onClose(); }} onOpenChangeComplete={(value) => { if (!value) restore.current?.focus(); }}>
      <Dialog className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden p-0" data-testid="command-palette">
        <Dialog.Title className="sr-only">Command palette</Dialog.Title>
        <Dialog.Description className="sr-only">Find a page or search traces. Use arrow keys to select a result.</Dialog.Description>
        <div className="flex items-center gap-3 border-b border-kumo-hairline px-5">
          <MagnifyingGlassIcon size={18} className="shrink-0 text-kumo-subtle" aria-hidden />
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={selected >= 0 && items.length ? optionId(selected) : undefined}
            aria-label="Go to a page or search traces"
            placeholder="Go to a page, search traces, or paste a trace ID…"
            className="h-14 w-full min-w-0 bg-transparent text-sm text-kumo-strong outline-none placeholder:text-kumo-subtle"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                input.current?.focus();
              }}
              aria-label="Clear search"
              className="grid size-6 shrink-0 place-items-center rounded-md text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-strong"
            >
              <XIcon size={14} />
            </button>
          )}
        </div>
        <div id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-3">
          {items.map((item, i) => {
            const Icon = item.group === 'Traces' ? GitBranchIcon : icons?.[item.to];
            return (
              <div key={item.id} role="presentation">
                {(i === 0 || items[i - 1]?.group !== item.group) && (
                  <div className="px-3.5 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wider text-kumo-subtle first:pt-1">
                    {item.group}
                  </div>
                )}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection goes through the combobox input (aria-activedescendant) */}
                <div
                  id={optionId(i)}
                  tabIndex={-1}
                  role="option"
                  aria-selected={i === selected}
                  className={`flex cursor-pointer items-center justify-between gap-4 rounded-lg px-3.5 py-2.5 text-sm transition-colors ${i === selected ? 'bg-kumo-tint text-kumo-strong ring-1 ring-inset ring-kumo-hairline' : 'text-kumo-default'}`}
                  onMouseMove={() => setSelected(i)}
                  onClick={() => go(item)}
                >
                  <span className="flex min-w-0 items-center gap-3">
                    {Icon && <Icon size={16} className={i === selected ? 'shrink-0 text-kumo-strong' : 'shrink-0 text-kumo-subtle'} />}
                    <span className={`truncate ${item.group === 'Traces' ? 'font-mono text-xs' : ''}`}>{item.label}</span>
                  </span>
                  {item.group === 'Pages' && (item.to === '/' ? pathname === '/' : pathname === item.to || pathname.startsWith(`${item.to}/`)) && (
                    <Badge variant="outline" className="shrink-0">Current</Badge>
                  )}
                  {item.group === 'Traces' && item.id !== 'open-trace' && (
                    <span className="shrink-0 rounded-md bg-kumo-recessed px-2 py-0.5 font-mono text-xs text-kumo-subtle">{item.to.slice(8, 16)}</span>
                  )}
                </div>
              </div>
            );
          })}
          {items.length === 0 && search !== 'loading' && (
            <div className="flex flex-col items-center gap-2 px-4 py-12 text-center text-sm text-kumo-subtle">
              <MagnifyingGlassIcon size={24} className="text-kumo-subtle/70" aria-hidden />
              <span>No pages or traces match.</span>
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-kumo-hairline bg-kumo-elevated/60 px-5 py-3 text-xs text-kumo-subtle" aria-live="polite">
          <span>{search === 'loading' ? 'Searching traces…' : search === 'error' ? <span className="text-kumo-danger">Trace search failed.</span> : `${items.length} result${items.length === 1 ? '' : 's'}`}</span>
          <span className="hidden items-center gap-3 sm:inline-flex">
            <span className="inline-flex items-center gap-1">
              <kbd className="inline-flex items-center gap-0.5 rounded border border-kumo-hairline bg-kumo-base px-1.5 py-0.5"><ArrowUpIcon size={10} /><ArrowDownIcon size={10} /></kbd>
              <span>move</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <kbd className="inline-flex items-center rounded border border-kumo-hairline bg-kumo-base px-1.5 py-0.5"><KeyReturnIcon size={10} /></kbd>
              <span>open</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1.5 py-0.5 font-sans text-[10px]">Esc</kbd>
              <span>close</span>
            </span>
          </span>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
