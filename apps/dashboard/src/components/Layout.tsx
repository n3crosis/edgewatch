import { Activity, Bug, Cloud, Database, FlaskConical, Gauge, Pause, Play, Plug, Radio } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { API_URL, PROJECT_ID, USING_MOCK } from '@/lib/api';
import { POLL_INTERVAL_MS, RangeProvider, useRange } from '@/lib/range';
import type { Range } from '@/lib/types';

const NAV = [
  { to: '/', label: 'Overview', icon: Gauge, end: true },
  { to: '/traces', label: 'Traces', icon: Activity },
  { to: '/exceptions', label: 'Exceptions', icon: Bug },
  { to: '/queries', label: 'Queries', icon: Database },
  { to: '/setup', label: 'Setup', icon: Plug },
];

function RangePicker() {
  const { range, setRange } = useRange();
  return (
    <ToggleGroup type="single" variant="outline" size="sm" value={range} onValueChange={(v) => v && setRange(v as Range)} aria-label="Time range">
      {(['1h', '6h', '24h'] as Range[]).map((r) => (
        <ToggleGroupItem key={r} value={r} className="px-3 text-xs">
          {r}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function DataSource() {
  const host = USING_MOCK ? '' : (() => { try { return new URL(API_URL).host; } catch { return API_URL; } })();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" data-testid="data-source" className={USING_MOCK ? 'gap-1.5 border-amber-400/30 text-amber-300' : 'gap-1.5 border-emerald-400/30 text-emerald-300'}>
          {USING_MOCK ? <FlaskConical /> : <Cloud />}
          {USING_MOCK ? 'Seed data' : `API · ${host}`}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        {USING_MOCK ? 'VITE_API_URL is not set: showing generated seed data.' : `Reading live data from workers/api at ${API_URL}`}
      </TooltipContent>
    </Tooltip>
  );
}

function LiveToggle() {
  const { live, setLive, lastUpdated } = useRange();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant={live ? 'secondary' : 'outline'} size="sm" onClick={() => setLive(!live)} aria-pressed={live} className="gap-1.5 text-xs">
          {live ? <Pause /> : <Play />}
          {live ? (
            <>
              <span className="relative flex size-2"><span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" /><span className="relative inline-flex size-2 rounded-full bg-emerald-400" /></span>
              Live · {POLL_INTERVAL_MS / 1000}s
            </>
          ) : 'Live'}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{live ? `Refreshing every ${POLL_INTERVAL_MS / 1000}s · last ${new Date(lastUpdated).toLocaleTimeString()}` : `Refresh every ${POLL_INTERVAL_MS / 1000}s`}</TooltipContent>
    </Tooltip>
  );
}

export default function Layout() {
  return (
    <RangeProvider>
      <div className="flex h-full">
        <aside className="flex w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
          <div className="flex items-center gap-2.5 px-5 py-5">
            <div className="grid size-8 place-items-center rounded-lg bg-primary/15 text-primary">
              <Radio size={18} />
            </div>
            <div>
              <div className="text-sm font-semibold">EdgeWatch</div>
              <div className="text-[11px] text-muted-foreground">Nightwatch-compatible APM</div>
            </div>
          </div>
          <Separator />
          <nav className="flex flex-col gap-1 p-3">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink key={to} to={to} end={end}>
                {({ isActive }) => (
                  <Button variant={isActive ? 'secondary' : 'ghost'} className={`w-full justify-start gap-3 ${isActive ? '' : 'text-muted-foreground'}`}>
                    <Icon /> {label}
                  </Button>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="mt-auto space-y-3 p-4 text-xs">
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Project</span>
              <span className="font-mono">{PROJECT_ID}</span>
            </div>
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center justify-between border-b px-8">
            <div className="text-sm text-muted-foreground">
              <span className="text-foreground">shop.example.com</span> · production
            </div>
            <div className="flex items-center gap-2">
              <DataSource />
              <LiveToggle />
              <RangePicker />
            </div>
          </header>
          <main className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
            <Outlet />
          </main>
        </div>
      </div>
    </RangeProvider>
  );
}
