import { Button } from '@cloudflare/kumo/components/button';
import { Popover } from '@cloudflare/kumo/components/popover';
import { cn } from '@cloudflare/kumo/utils';
import { timeWindow } from '@edgewatch/shared/time-window';
import { CalendarBlankIcon, CaretDownIcon, XIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { useRange } from '@/lib/range';
import type { Range } from '@/lib/types';

/** Exact Nightwatch presets (`Xr` in `AuthenticatedLayout-CUJ0-ea8.js`). */
const RANGES: { value: Range; label: string }[] = [
  { value: '1h', label: '1H' },
  { value: '24h', label: '24H' },
  { value: '7d', label: '7D' },
  { value: '14d', label: '14D' },
  { value: '30d', label: '30D' },
];

const toInputValue = (ms: number, utc: boolean) => {
  const date = new Date(ms);
  const shifted = utc ? date : new Date(ms - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
};

const fromInputValue = (value: string, utc: boolean) => {
  if (!value) return NaN;
  return utc ? Date.parse(`${value}:00Z`) : new Date(value).getTime();
};

const formatPrettyWindow = (range: Range, utc: boolean) => {
  const win = timeWindow(range);
  if (!win) return 'Custom';
  const fmt = (ts: number) =>
    new Date(ts).toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: utc ? 'UTC' : undefined,
    });
  return `${fmt(win.since)} - ${fmt(win.now)}`;
};

/** 1:1 Nightwatch time range picker (`Qr` & `Zr` in `AuthenticatedLayout-CUJ0-ea8.js`). */
export default function RangePicker() {
  const { range, setRange } = useRange();
  const isCustom = range.startsWith('custom:');
  const [open, setOpen] = useState(false);
  const [showUtc, setShowUtc] = useState(true);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const win = timeWindow(range);
    if (!win) return;
    setStart(toInputValue(win.since, showUtc));
    setEnd(toInputValue(win.now, showUtc));
    setError('');
  }, [range, showUtc]);

  const clearCustom = () => {
    setOpen(false);
    setRange('24h');
  };

  return (
    <div
      role="group"
      aria-label="Time range"
      className={cn(
        'flex h-8 items-center gap-px rounded-lg border p-0.5',
        isCustom
          ? 'border-blue-500 bg-blue-600 text-white'
          : 'border-neutral-200 bg-white dark:border-white/5 dark:bg-white/3',
      )}
    >
      {isCustom ? (
        <>
          <span className="whitespace-nowrap pl-3 font-mono text-xs">{formatPrettyWindow(range, showUtc)}</span>
          <button
            type="button"
            onClick={clearCustom}
            title="Clear custom date range"
            aria-label="Clear custom date range"
            className="ml-2 mr-1 rounded-full bg-white/20 p-0.5 transition-colors hover:bg-white/30"
          >
            <XIcon size={12} aria-hidden />
          </button>
        </>
      ) : (
        RANGES.map((item) => {
          const active = range === item.value;
          return (
            <button
              key={item.value}
              type="button"
              aria-pressed={active}
              onClick={() => {
                setOpen(false);
                setRange(item.value);
              }}
              className={cn(
                'h-full min-w-8 rounded-md border px-2.5 font-mono text-xs transition-colors',
                active
                  ? 'border-blue-500 bg-blue-600 text-white dark:text-white'
                  : 'border-transparent text-neutral-600 hover:bg-blue-100 hover:text-blue-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white',
              )}
            >
              {item.label}
            </button>
          );
        })
      )}

      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          render={
            <button
              type="button"
              aria-label="Custom range"
              aria-pressed={isCustom}
              className={cn(
                'group flex h-full items-center gap-1 rounded-md px-2 py-1 text-xs transition-all dark:hover:bg-white/10',
                open && (isCustom ? 'bg-white/10' : 'bg-neutral-100 dark:bg-white/10'),
                isCustom ? 'hover:bg-white/10' : 'hover:bg-neutral-100',
              )}
            >
              <CalendarBlankIcon
                size={12}
                className={cn(
                  isCustom
                    ? 'text-white group-hover:text-white'
                    : 'text-neutral-400 group-hover:text-neutral-900 dark:text-neutral-500 dark:group-hover:text-white',
                )}
                aria-hidden
              />
              <CaretDownIcon
                size={12}
                className={cn(
                  isCustom
                    ? 'text-neutral-200 group-hover:text-white'
                    : 'text-neutral-500 group-hover:text-neutral-900 dark:text-neutral-500 dark:group-hover:text-white',
                )}
                aria-hidden
              />
            </button>
          }
        />
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="end" sideOffset={8}>
            <Popover.Popup className="w-fit rounded-xl border border-neutral-200 bg-white p-4 shadow-xl shadow-black/15 dark:border-white/10 dark:bg-neutral-900">
              <form
                className="space-y-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  const fromMs = fromInputValue(start, showUtc);
                  const toMs = fromInputValue(end, showUtc);
                  const value = `custom:${fromMs}:${toMs}`;
                  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || !timeWindow(value)) {
                    setError('Choose a valid start time before the end time.');
                    return;
                  }
                  setError('');
                  setOpen(false);
                  setRange(value as Range);
                }}
              >
                {/* Exact Nightwatch UTC / Local segmented toggle */}
                <div className="flex h-8 items-center rounded-md border border-neutral-200 bg-neutral-100 p-0.5 dark:border-white/5 dark:bg-white/[0.03]">
                  {(['utc', 'local'] as const).map((tz) => {
                    const active = (tz === 'utc') === showUtc;
                    return (
                      <button
                        key={tz}
                        type="button"
                        onClick={() => setShowUtc(tz === 'utc')}
                        className={cn(
                          'flex h-full flex-1 items-center justify-center rounded text-xs font-medium uppercase transition-colors',
                          active
                            ? 'bg-white text-neutral-900 shadow-xs dark:bg-neutral-700 dark:text-white'
                            : 'text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white',
                        )}
                      >
                        {tz}
                      </button>
                    );
                  })}
                </div>

                <label className="block w-60 space-y-1.5">
                  <span className="block px-1 text-xs font-medium text-neutral-700 dark:text-neutral-300">Starting date</span>
                  <input
                    required
                    type="datetime-local"
                    className="block h-10 w-full rounded-lg border border-neutral-200 bg-white px-3 font-mono text-xs text-neutral-900 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-white"
                    value={start}
                    onChange={(event) => setStart(event.target.value)}
                  />
                </label>

                <label className="block w-60 space-y-1.5">
                  <span className="block px-1 text-xs font-medium text-neutral-700 dark:text-neutral-300">Ending date</span>
                  <input
                    required
                    type="datetime-local"
                    className="block h-10 w-full rounded-lg border border-neutral-200 bg-white px-3 font-mono text-xs text-neutral-900 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-white"
                    value={end}
                    onChange={(event) => setEnd(event.target.value)}
                  />
                </label>

                {error && <p role="alert" className="w-60 text-xs text-kumo-danger">{error}</p>}

                <Button type="submit" variant="primary" className="w-full justify-center">
                  Apply
                </Button>
              </form>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
