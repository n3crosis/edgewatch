import { Button } from '@cloudflare/kumo/components/button';
import { Popover } from '@cloudflare/kumo/components/popover';
import { Tabs } from '@cloudflare/kumo/components/tabs';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { timeWindow } from '@edgewatch/shared/time-window';
import { CalendarBlankIcon, CheckIcon, ClockIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { useRange } from '@/lib/range';
import type { Range } from '@/lib/types';

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
    <div className="flex items-center gap-2">
      <Tabs
        variant="segmented"
        size="sm"
        value={isCustom ? '' : range}
        onValueChange={(value) => {
          setOpen(false);
          setRange(value as Range);
        }}
        tabs={['1h', '6h', '24h', '7d'].map((value) => ({ value, label: value }))}
      />
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Tooltip asChild content={isCustom ? shortWindow(range) : 'Choose a custom time window'}>
          <Popover.Trigger
            render={
              <Button
                type="button"
                size="sm"
                variant={isCustom ? 'primary' : 'secondary'}
                icon={CalendarBlankIcon}
                aria-label="Custom range"
              >
                {isCustom ? (
                  <>
                    <span className="sm:hidden">Custom</span>
                    <span className="hidden max-w-48 truncate font-mono text-xs sm:inline">{shortWindow(range)}</span>
                  </>
                ) : (
                  'Custom'
                )}
              </Button>
            }
          />
        </Tooltip>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="end" sideOffset={10}>
            <Popover.Popup className="w-96 max-w-[calc(100vw-2rem)] rounded-xl border border-kumo-line bg-kumo-overlay p-5 shadow-lg">
              <Popover.Title className="text-base font-semibold text-kumo-strong">Custom time window</Popover.Title>
              <Popover.Description className="mt-1 text-xs leading-relaxed text-kumo-subtle">
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
                className="mt-4 space-y-4 border-t border-kumo-hairline pt-4"
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
                  <span className="text-xs font-medium text-kumo-subtle">Start (local time)</span>
                  <input
                    required
                    type="datetime-local"
                    step="1"
                    className="block h-9 w-full rounded-lg border border-kumo-line bg-kumo-control px-3 text-xs text-kumo-strong outline-none focus:border-kumo-focus"
                    value={start}
                    onChange={(event) => setStart(event.target.value)}
                  />
                </label>
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-kumo-subtle">End (local time)</span>
                  <input
                    required
                    type="datetime-local"
                    step="1"
                    className="block h-9 w-full rounded-lg border border-kumo-line bg-kumo-control px-3 text-xs text-kumo-strong outline-none focus:border-kumo-focus"
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
