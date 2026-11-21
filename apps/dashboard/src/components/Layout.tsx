import { Activity, Bug, Database, Gauge, Plug, Radio } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { PROJECT_ID, USING_MOCK } from '../lib/api';
import { RangeProvider, useRange } from '../lib/range';
import type { Range } from '../lib/types';

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
    <div className="flex rounded-lg border border-slate-800 bg-slate-900 p-0.5 text-xs">
      {(['1h', '6h', '24h'] as Range[]).map((r) => (
        <button
          key={r}
          onClick={() => setRange(r)}
          className={`rounded-md px-3 py-1.5 font-medium transition ${range === r ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}
        >
          {r}
        </button>
      ))}
    </div>
  );
}

export default function Layout() {
  return (
    <RangeProvider>
      <div className="flex h-full">
        <aside className="flex w-60 shrink-0 flex-col border-r border-slate-800 bg-slate-950">
          <div className="flex items-center gap-2.5 px-5 py-5">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-sky-500/15 text-sky-400">
              <Radio size={18} />
            </div>
            <div>
              <div className="text-sm font-semibold text-white">EdgeWatch</div>
              <div className="text-[11px] text-slate-500">Nightwatch-compatible APM</div>
            </div>
          </div>
          <nav className="flex flex-col gap-0.5 px-3">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${isActive ? 'bg-slate-800/80 text-white' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'}`
                }
              >
                <Icon size={16} />
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="mt-auto space-y-2 p-4 text-xs text-slate-500">
            <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
              <div className="text-slate-400">Project</div>
              <div className="mt-0.5 font-mono text-slate-200">{PROJECT_ID}</div>
            </div>
            {USING_MOCK && <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-amber-300">Showing seed data</div>}
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-800 px-8">
            <div className="text-sm text-slate-400">
              <span className="text-slate-200">shop.example.com</span> · production
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
