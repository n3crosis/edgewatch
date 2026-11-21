import { Activity, Bug, Database, Gauge, Plug, Radio } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { PROJECT_ID, USING_MOCK } from '@/lib/api';
import { RangeProvider, useRange } from '@/lib/range';
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
            {USING_MOCK && <Badge variant="outline" className="w-full border-amber-400/30 text-amber-300">Showing seed data</Badge>}
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center justify-between border-b px-8">
            <div className="text-sm text-muted-foreground">
              <span className="text-foreground">shop.example.com</span> · production
            </div>
            <RangePicker />
          </header>
          <main className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
            <Outlet />
          </main>
        </div>
      </div>
    </RangeProvider>
  );
}
