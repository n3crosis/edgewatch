import { Badge } from '@cloudflare/kumo/components/badge';
import { LinkButton } from '@cloudflare/kumo/components/button';
import { Switch } from '@cloudflare/kumo/components/switch';
import { Tabs } from '@cloudflare/kumo/components/tabs';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { BroadcastIcon, BugIcon, CloudIcon, DatabaseIcon, FlaskIcon, GaugeIcon, PlugIcon, PulseIcon } from '@phosphor-icons/react';
import { Outlet, useMatch, useResolvedPath } from 'react-router-dom';
import { API_URL, PROJECT_ID, USING_MOCK } from '@/lib/api';
import { POLL_INTERVAL_MS, RangeProvider, useRange } from '@/lib/range';
import type { Range } from '@/lib/types';

const NAV = [
  { to: '/', label: 'Overview', icon: GaugeIcon, end: true },
  { to: '/traces', label: 'Traces', icon: PulseIcon },
  { to: '/exceptions', label: 'Exceptions', icon: BugIcon },
  { to: '/queries', label: 'Queries', icon: DatabaseIcon },
  { to: '/setup', label: 'Setup', icon: PlugIcon },
];

function NavItem({ to, label, icon, end }: (typeof NAV)[number]) {
  const active = useMatch({ path: useResolvedPath(to).pathname, end: end ?? false }) !== null;
  return (
    <LinkButton href={to} variant={active ? 'secondary' : 'ghost'} icon={icon} aria-current={active ? 'page' : undefined} className={`w-full justify-start ${active ? '' : 'text-kumo-subtle'}`}>
      {label}
    </LinkButton>
  );
}

function RangePicker() {
  const { range, setRange } = useRange();
  return (
    <Tabs
      variant="segmented"
      size="sm"
      value={range}
      onValueChange={(v) => setRange(v as Range)}
      tabs={(['1h', '6h', '24h'] as Range[]).map((r) => ({ value: r, label: r }))}
    />
  );
}

function DataSource() {
  const host = USING_MOCK ? '' : (() => { try { return new URL(API_URL).host; } catch { return API_URL; } })();
  return (
    <Tooltip asChild content={USING_MOCK ? 'VITE_API_URL is not set: showing generated seed data.' : `Reading live data from workers/api at ${API_URL}`}>
      <span data-testid="data-source">
        <Badge variant={USING_MOCK ? 'warning' : 'success'}>
          {USING_MOCK ? <FlaskIcon /> : <CloudIcon />}
          {USING_MOCK ? 'Seed data' : `API · ${host}`}
        </Badge>
      </span>
    </Tooltip>
  );
}

function LiveToggle() {
  const { live, setLive, lastUpdated } = useRange();
  return (
    <Tooltip asChild content={live ? `Refreshing every ${POLL_INTERVAL_MS / 1000}s · last ${new Date(lastUpdated).toLocaleTimeString()}` : `Refresh every ${POLL_INTERVAL_MS / 1000}s`}>
      <span className="flex items-center">
        <Switch size="sm" label={live ? `Live · ${POLL_INTERVAL_MS / 1000}s` : 'Live'} checked={live} onCheckedChange={setLive} />
      </span>
    </Tooltip>
  );
}

export default function Layout() {
  return (
    <RangeProvider>
      <div className="flex h-full">
        <aside className="flex w-60 shrink-0 flex-col border-r border-kumo-hairline bg-kumo-elevated">
          <div className="flex items-center gap-2.5 border-b border-kumo-hairline px-5 py-5">
            <div className="grid size-8 place-items-center rounded-lg bg-kumo-brand text-white">
              <BroadcastIcon size={18} weight="bold" />
            </div>
            <div>
              <div className="text-sm font-semibold text-kumo-strong">EdgeWatch</div>
              <div className="text-[11px] text-kumo-subtle">Nightwatch-compatible APM</div>
            </div>
          </div>
          <nav className="flex flex-col gap-1 p-3">
            {NAV.map((item) => <NavItem key={item.to} {...item} />)}
          </nav>
          <div className="mt-auto border-t border-kumo-hairline p-4 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-kumo-subtle">Project</span>
              <span className="font-mono">{PROJECT_ID}</span>
            </div>
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-kumo-hairline px-8">
            <div className="text-sm text-kumo-subtle">
              <span className="text-kumo-strong">shop.example.com</span> · production
            </div>
            <div className="flex items-center gap-3">
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
