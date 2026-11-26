import { Button } from '@cloudflare/kumo/components/button';
import { Popover } from '@cloudflare/kumo/components/popover';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { timeWindow } from '@edgewatch/shared/time-window';
import { CalendarBlankIcon, CaretDownIcon, CheckIcon, ClockIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { useRange } from '@/lib/range';
import type { Range } from '@/lib/types';

const RANGES: { value: Range; label: string }[] = [
  { value: '1h', label: '1H' },
  { value: '6h', label: '6H' },
  { value: '24h', label: '24H' },
  { value: '7d', label: '7D' },
];

const QUICK_PRESETS = [
  { label: 'Last 15m', ms: 15 * 60_000 },
  { label: 'Last 30m', ms: 30 * 60_000 },
  { label: 'Last 12h', ms: 12 * 3600_000 },
  { label: 'Last 3d', ms: 3 * 86_400_000 },
] as const;

const localInput = (ms: number) => {
  const date = new Date(ms);
  return new Date(ms - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
};

const shortWindow = (range: Range) => {
  const win = timeWindow(range);
  if (!win) return 'Custom';
  const fmt = (ts: number) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `${fmt(win.since)} – ${fmt(win.now)}`;
};

export default function RangePicker() {
  const { range, setRange } = useRange();
  const isCustom = range.startsWith('custom:');
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const window = timeWindow(range);
    if (!window) return;
    setStart(localInput(window.since));
    setEnd(localInput(window.now));
    setError('');
  }, [range]);

  const applyPreset = (durationMs: number) => {
    const now = Date.now();
    const value = `custom:${now - durationMs}:${now}`;
    if (!timeWindow(value)) return;
    setError('');
    setOpen(false);
    setRange(value as Range);
  };

  return (
    <div
      role="group"
      aria-label="Time range"
      className="flex h-8 items-center gap-px rounded-lg border border-neutral-200 bg-white p-0.5 dark:border-white/[0.08] dark:bg-white/[0.03]"
    >
      {RANGES.map((item) => {
        const active = !isCustom && range === item.value;
        return (
          <button
            key={item.value}
            type="button"
            aria-pressed={active}
            onClick={() => {
              setOpen(false);
              setRange(item.value);
            }}
            className={`h-full min-w-8 rounded-md border px-2.5 font-mono text-xs transition-colors ${
              active
                ? 'border-blue-500 bg-blue-600 text-white'
                : 'border-transparent text-neutral-600 hover:bg-blue-50 hover:text-blue-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white'
            }`}
          >
            {item.label}
          </button>
        );
      })}
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Tooltip asChild content={isCustom ? shortWindow(range) : 'Choose a custom time window'}>
          <Popover.Trigger
            render={
              <button
                type="button"
                aria-label="Custom range"
                aria-pressed={isCustom}
                className={`group flex h-full items-center gap-1 rounded-md border px-2 font-mono text-xs transition-colors ${
                  isCustom
                    ? 'border-blue-500 bg-blue-600 text-white'
                    : 'border-transparent text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-white'
                }`}
              >
                <CalendarBlankIcon size={13} aria-hidden />
                {isCustom && <span className="hidden max-w-44 truncate sm:inline">{shortWindow(range)}</span>}
                <CaretDownIcon size={11} aria-hidden />
              </button>
            }
          />
        </Tooltip>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="end" sideOffset={10}>
            <Popover.Popup className="w-96 max-w-[calc(100vw-2rem)] rounded-xl border border-neutral-200 bg-white p-5 shadow-xl shadow-black/10 dark:border-white/10 dark:bg-neutral-900">
              <Popover.Title className="text-base font-semibold text-neutral-900 dark:text-white">Custom time window</Popover.Title>
              <Popover.Description className="mt-1 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                Pick a quick preset or enter exact bounds in your local timezone.
              </Popover.Description>
              <div className="mt-4 flex flex-wrap gap-2">
                {QUICK_PRESETS.map((preset) => (
                  <Button key={preset.label} type="button" size="sm" variant="secondary" icon={ClockIcon} onClick={() => applyPreset(preset.ms)}>
                    {preset.label}
                  </Button>
                ))}
              </div>
              <form
                className="mt-4 space-y-4 border-t border-neutral-200 pt-4 dark:border-white/[0.08]"
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = `custom:${new Date(start).getTime()}:${new Date(end).getTime()}`;
                  if (!timeWindow(value)) {
                    setError('Choose a valid start time before the end time.');
                    return;
                  }
                  setError('');
                  setOpen(false);
                  setRange(value as Range);
                }}
              >
                <label className="block space-y-1.5">
                  <span className="font-mono text-[11px] uppercase tracking-wider text-neutral-500 dark:text-neutral-400">Start (local time)</span>
                  <input
                    required
                    type="datetime-local"
                    step="1"
                    className="block h-9 w-full rounded-lg border border-neutral-200 bg-white px-3 font-mono text-xs text-neutral-900 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-white"
                    value={start}
                    onChange={(event) => setStart(event.target.value)}
                  />
                </label>
                <label className="block space-y-1.5">
                  <span className="font-mono text-[11px] uppercase tracking-wider text-neutral-500 dark:text-neutral-400">End (local time)</span>
                  <input
                    required
                    type="datetime-local"
                    step="1"
                    className="block h-9 w-full rounded-lg border border-neutral-200 bg-white px-3 font-mono text-xs text-neutral-900 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-white"
                    value={end}
                    onChange={(event) => setEnd(event.target.value)}
                  />
                </label>
                {error && <p role="alert" className="text-xs text-kumo-danger">{error}</p>}
                <div className="flex justify-end gap-2.5 pt-1">
                  <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button type="submit" size="sm" variant="primary" icon={CheckIcon}>Apply window</Button>
                </div>
              </form>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
