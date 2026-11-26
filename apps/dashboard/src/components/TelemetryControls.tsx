import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { ArrowClockwiseIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { environmentScopedPath } from '@/lib/environment-scope';
import { useRange } from '@/lib/range';
import EnvironmentPicker from './EnvironmentPicker';
import RangePicker from './RangePicker';

export function RefreshButton() {
  const { lastUpdated, refresh } = useRange();
  const [spinning, setSpinning] = useState(false);
  const triggerRefresh = () => {
    refresh();
    setSpinning(true);
    setTimeout(() => setSpinning(false), 450);
  };
  return (
    <Tooltip asChild content={`Refresh now · updated ${new Date(lastUpdated).toLocaleTimeString()}`}>
      <button
        type="button"
        aria-label="Refresh data"
        onClick={triggerRefresh}
        className="grid size-8 shrink-0 place-items-center rounded-lg border border-neutral-200 bg-white text-neutral-500 transition-colors hover:border-blue-500 hover:text-neutral-900 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-neutral-400 dark:hover:border-white/15 dark:hover:text-white"
      >
        <ArrowClockwiseIcon size={15} className={spinning ? 'animate-refresh' : undefined} />
      </button>
    </Tooltip>
  );
}

/** Inline telemetry controls (Refresh, Environment, Time Range) rendered on the right of the PageHeader row. */
export default function TelemetryControls() {
  const { pathname } = useLocation();
  const isTelemetryView = environmentScopedPath(pathname);
  const showControls = isTelemetryView || pathname === '/pipeline' || pathname.startsWith('/pipeline/');
  if (!showControls) return null;

  return (
    <>
      {isTelemetryView && <EnvironmentPicker />}
      <RefreshButton />
      {isTelemetryView && <RangePicker />}
    </>
  );
}
