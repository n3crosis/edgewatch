import { useKumoToastManager } from '@cloudflare/kumo/components/toast';
import { envDotClass, EnvironmentProvider, useEnvironment } from '@/lib/environment';
import Link, { scopedPath } from './ScopedLink';
import { Button } from '@cloudflare/kumo/components/button';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { Popover } from '@cloudflare/kumo/components/popover';
import {
  ArrowsLeftRightIcon,
  BugIcon,
  CaretUpDownIcon,
  CheckIcon,
  DatabaseIcon,
  DotsThreeIcon,
  FolderSimpleIcon,
  GaugeIcon,
  KeyIcon,
  ListIcon,
  MoonIcon,
  SignOutIcon,
  SlidersHorizontalIcon,
  SunIcon,
  WarningOctagonIcon,
  XIcon,
} from '@phosphor-icons/react';
import { Suspense, useEffect, useId, useMemo, useState, type ComponentType } from 'react';
import CommandPalette from './CommandPalette';
import { isPaletteShortcut, type PaletteCommand } from '@/lib/command-palette';
import PageBoundary from './PageBoundary';
import { Loading } from './common';
import { Outlet, useLocation, useMatch, useNavigate, useResolvedPath } from 'react-router-dom';
import { useTheme } from '@/lib/theme';
import { EVENT_PAGES } from '@/lib/events';
import { api, USING_MOCK, useAsync } from '@/lib/api';
import { signOut, useSessionUser } from '@/lib/auth';
import { ProjectProvider, useProject } from '@/lib/project';
import { RangeProvider, useRange } from '@/lib/range';

const NAV = [
  { to: '/', label: 'Dashboard', icon: GaugeIcon, end: true },
  { to: '/issues', label: 'Issues', icon: WarningOctagonIcon },
  { to: '/requests', label: 'Requests', icon: ArrowsLeftRightIcon },
  { to: '/exceptions', label: 'Exceptions', icon: BugIcon },
  { to: '/queries', label: 'Queries', icon: DatabaseIcon },
  ...EVENT_PAGES.map((p) => ({ to: p.path, label: p.nav, icon: p.icon, end: false })),
  { to: '/setup', label: 'Settings', icon: SlidersHorizontalIcon },
  { to: '/accounts', label: 'Accounts', icon: KeyIcon },
];

const NAV_ICONS: Record<string, ComponentType<{ size?: number; className?: string }>> = Object.fromEntries(
  NAV.map((item) => [item.to, item.icon]),
);

const KEYWORDS: Record<string, string[]> = {
  '/': ['overview', 'home'],
  '/issues': ['problems', 'triage'],
  '/requests': ['routes', 'http'],
  '/exceptions': ['errors'],
  '/queries': ['sql', 'database', 'slow'],
  '/setup': ['settings', 'install', 'keys'],
  '/accounts': ['members', 'invitations', 'users', 'access'],
};

const TOP_NAV = NAV.filter((item) => ['/', '/issues'].includes(item.to));

/** Exact Nightwatch sidebar sections (`hi()` in `AuthenticatedLayout-CUJ0-ea8.js`). */
const NAV_SECTIONS = [
  {
    label: 'Activity',
    items: ['/requests', '/jobs', '/commands', '/scheduled-tasks', '/exceptions', '/queries', '/notifications', '/mail', '/cache', '/outgoing-requests']
      .map((path) => NAV.find((item) => item.to === path))
      .filter((item): item is (typeof NAV)[number] => Boolean(item)),
  },
  {
    label: 'Monitoring',
    items: ['/users', '/logs']
      .map((path) => NAV.find((item) => item.to === path))
      .filter((item): item is (typeof NAV)[number] => Boolean(item)),
  },
];

const BOTTOM_NAV = ['/setup', '/accounts']
  .map((path) => NAV.find((item) => item.to === path))
  .filter((item): item is (typeof NAV)[number] => Boolean(item));

function PaletteHost({ open, setOpen }: { open: boolean; setOpen: (open: boolean) => void }) {
  const { range } = useRange();
  const { projectId } = useProject();
  const { environment } = useEnvironment();
  const pages = useMemo<PaletteCommand[]>(
    () => NAV.map((item) => ({ id: item.to, label: item.label, to: item.to, keywords: KEYWORDS[item.to], group: 'Pages' })),
    [],
  );
  return (
    <CommandPalette
      open={open}
      onClose={() => setOpen(false)}
      pages={pages}
      icons={NAV_ICONS}
      range={range}
      scope={(to) => scopedPath(to, projectId, range, environment)}
    />
  );
}

function NavItem({ to, label, icon: Icon, end, badge }: (typeof NAV)[number] & { badge?: number }) {
  const { range } = useRange();
  const { projectId } = useProject();
  const { environment } = useEnvironment();
  const href = scopedPath(to, projectId, range, environment);
  const active = useMatch({ path: useResolvedPath(to).pathname, end: end ?? false }) !== null;
  return (
    <Link
      to={href}
      aria-current={active ? 'page' : undefined}
      className={
        active
          ? 'group relative flex h-9 w-full items-center gap-3 rounded-md border border-neutral-200 bg-white px-2 pr-0.5 text-sm font-normal text-neutral-900 shadow-lg shadow-black/[0.04] transition-colors dark:border-white/[0.05] dark:bg-white/[0.05] dark:text-white'
          : 'group relative flex h-9 w-full items-center gap-3 rounded-md border border-transparent px-2 pr-0.5 text-sm text-neutral-500 transition-colors hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white'
      }
    >
      <Icon
        size={16}
        weight={active ? 'duotone' : 'regular'}
        className={
          active
            ? 'shrink-0 text-blue-600 dark:text-emerald-500'
            : 'shrink-0 text-neutral-400 transition-colors group-hover:text-blue-500 dark:text-neutral-500 dark:group-hover:text-emerald-500'
        }
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span
          className={`mr-2 inline-flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded px-1 font-sans text-[11px] leading-none font-medium tabular-nums ${
            active
              ? 'bg-neutral-600 text-neutral-100 dark:bg-neutral-600 dark:text-white'
              : 'bg-black/[0.07] text-neutral-700 dark:bg-white/10 dark:text-neutral-200'
          }`}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </Link>
  );
}

/** 1:1 Nightwatch top-left Application + Environment switcher (`bi` & `vi` in `AuthenticatedLayout-CUJ0-ea8.js`). */
function ProjectHeaderSwitcher({ onClose }: { onClose?: () => void }) {
  const { projectId, projects, setProjectId } = useProject();
  const { range } = useRange();
  const { environment, setEnvironment, envRevision } = useEnvironment();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const envs = useAsync(() => (open ? api.environments().catch(() => []) : Promise.resolve([])), [open, projectId, envRevision]);
  const envItems = useMemo(() => {
    const map = new Map<string, { name: string; color?: string | null }>();
    for (const row of envs.data ?? []) map.set(row.name, { name: row.name, color: row.color });
    if (environment !== undefined && !map.has(environment)) map.set(environment, { name: environment, color: null });
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [envs.data, environment]);

  const list = projects.length ? projects : [{ id: projectId, name: projectId, host: undefined }];
  const active = list.find((p) => p.id === projectId) ?? list[0];
  const initial = (active?.name || projectId || 'E').trim().charAt(0).toUpperCase();

  const onChangeProject = (nextId: string) => {
    setOpen(false);
    if (nextId === projectId) return;
    setProjectId(nextId);
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length >= 2) {
      navigate(scopedPath(`/${segments[0]}`, nextId, range, environment), { replace: true });
    } else if (pathname === '/requests' && new URLSearchParams(search).has('route')) {
      navigate(scopedPath('/requests', nextId, range, environment), { replace: true });
    }
  };

  return (
    <div className="flex h-12 shrink-0 items-center border-b border-neutral-200 md:h-14 dark:border-white/[0.05]">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          render={
            <button
              type="button"
              data-testid="project-switcher"
              aria-label="Switch project and environment"
              className="group relative flex h-full min-w-0 flex-1 items-center justify-between gap-2.5 px-2 py-2 pr-4 text-left transition-all hover:bg-white dark:hover:bg-white/[0.01] focus-visible:outline-2 focus-visible:outline-kumo-link"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-md border border-neutral-200/80 bg-neutral-100 text-xs font-semibold text-neutral-800 dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-200">
                  {initial}
                </span>
                <span className="flex min-w-0 flex-col font-medium">
                  <span className="truncate text-sm/none text-neutral-900 dark:text-white">
                    {active.name}
                  </span>
                  <span className="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">
                    {environment || 'All environments'}
                  </span>
                </span>
              </span>
              <CaretUpDownIcon size={16} className="shrink-0 text-neutral-600 transition-colors group-hover:text-blue-600 dark:text-neutral-500 dark:group-hover:text-neutral-300" aria-hidden />
            </button>
          }
        />
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={4}>
            <Popover.Popup className="overflow-hidden rounded-xl border border-neutral-200 bg-white p-0 shadow-xl shadow-black/15 dark:border-white/10 dark:bg-neutral-900">
              <div className="flex max-h-[420px] flex-col sm:flex-row">
                {/* Projects column */}
                <div className="w-60 shrink-0 overflow-y-auto p-2">
                  <div className="px-2 pb-1.5 pt-1 text-xs font-medium text-neutral-400 dark:text-neutral-500">
                    Applications
                  </div>
                  <div className="space-y-0.5">
                    {list.map((project) => {
                      const selected = project.id === projectId;
                      const letter = (project.name || project.id).trim().charAt(0).toUpperCase();
                      return (
                        <button
                          key={project.id}
                          type="button"
                          onClick={() => onChangeProject(project.id)}
                          className={`flex h-9 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-sm transition-colors ${
                            selected
                              ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-white/[0.08] dark:text-white'
                              : 'text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-white/[0.04] dark:hover:text-white'
                          }`}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="grid size-5 shrink-0 place-items-center rounded bg-neutral-200/70 text-[11px] font-semibold text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200">
                              {letter}
                            </span>
                            <span className="truncate leading-tight">{project.name}</span>
                          </span>
                          {selected && <CheckIcon size={14} className="shrink-0 text-blue-600 dark:text-emerald-500" />}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Environments column (exact Nightwatch 2-pane switcher) */}
                <div className="w-56 shrink-0 overflow-y-auto border-t border-neutral-200 p-2 sm:border-l sm:border-t-0 dark:border-neutral-700/50">
                  <div className="px-2 pb-1.5 pt-1 text-xs font-medium text-neutral-400 dark:text-neutral-500">
                    Environments
                  </div>
                  <div className="space-y-0.5">
                    <button
                      type="button"
                      onClick={() => {
                        setEnvironment(undefined);
                        setOpen(false);
                      }}
                      className={`flex h-9 w-full items-center justify-between gap-2 rounded-md px-2.5 text-left text-sm transition-colors ${
                        environment === undefined
                          ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-white/[0.08] dark:text-white'
                          : 'text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-white/[0.04] dark:hover:text-white'
                      }`}
                    >
                      <span className="flex items-center gap-2.5 truncate">
                        <span className="size-2 shrink-0 rounded-full bg-blue-600 dark:bg-emerald-500" aria-hidden />
                        <span className="truncate">All environments</span>
                      </span>
                      {environment === undefined && <CheckIcon size={14} className="shrink-0 text-blue-600 dark:text-emerald-500" />}
                    </button>
                    {envItems.map((envItem, idx) => {
                      const selected = environment === envItem.name;
                      const dotColor = envDotClass(envItem.name, envItem.color, idx);
                      return (
                        <button
                          key={envItem.name}
                          type="button"
                          onClick={() => {
                            setEnvironment(envItem.name);
                            setOpen(false);
                          }}
                          className={`flex h-9 w-full items-center justify-between gap-2 rounded-md px-2.5 text-left text-sm transition-colors ${
                            selected
                              ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-white/[0.08] dark:text-white'
                              : 'text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-white/[0.04] dark:hover:text-white'
                          }`}
                        >
                          <span className="flex items-center gap-2.5 truncate">
                            <span className={`size-2 shrink-0 rounded-full ${dotColor}`} aria-hidden />
                            <span className="truncate">{envItem.name}</span>
                          </span>
                          {selected && <CheckIcon size={14} className="shrink-0 text-blue-600 dark:text-emerald-500" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {onClose && (
        <div className="pr-2">
          <Button variant="ghost" shape="square" size="sm" icon={XIcon} aria-label="Close menu" onClick={onClose} />
        </div>
      )}
    </div>
  );
}

function ProjectLabel() {
  const { projectId, projects } = useProject();
  const p = projects.find((x) => x.id === projectId);
  const label = p?.name ?? projectId;
  return (
    <div className="flex min-w-0 items-center gap-2 truncate text-sm text-neutral-500 dark:text-neutral-400">
      <FolderSimpleIcon size={15} className="shrink-0" aria-hidden />
      <span className="truncate font-semibold text-neutral-900 dark:text-white">{label}</span>
    </div>
  );
}

/** 1:1 Nightwatch sidebar footer (`AuthenticatedLayout-CUJ0-ea8.js`): avatar + name + `···` menu. */
function SidebarFooter({ onSignOut }: { onSignOut: () => void }) {
  const user = useSessionUser();
  const { theme, toggle } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const displayName = user?.name || user?.email || (USING_MOCK ? 'Demo' : 'Account');
  const initial = displayName.trim().charAt(0).toUpperCase();

  return (
    <div className="sticky bottom-0 z-10 w-full shrink-0 border-t border-neutral-200 p-1.5 dark:border-white/[0.05]">
      <div className="flex items-center gap-0.5">
        <Link
          to="/accounts"
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md p-2 transition-colors hover:bg-neutral-200/70 dark:hover:bg-white/10"
        >
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-neutral-200 text-xs font-medium text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200">
            {initial}
          </span>
          <span className="truncate text-sm text-neutral-900 dark:text-white">{displayName}</span>
        </Link>

        <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <Popover.Trigger
            render={
              <button
                type="button"
                aria-label="Account and appearance menu"
                className="flex size-8 shrink-0 items-center justify-center rounded-lg p-1 text-neutral-500 outline-none transition-colors hover:bg-neutral-200/70 dark:text-neutral-400 dark:hover:bg-white/10"
              >
                <DotsThreeIcon size={18} weight="bold" aria-hidden />
              </button>
            }
          />
          <Popover.Portal>
            <Popover.Positioner side="top" align="end" sideOffset={6}>
              <Popover.Popup className="w-48 rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl shadow-black/15 dark:border-white/10 dark:bg-neutral-900">
                <button
                  type="button"
                  data-testid="theme-toggle"
                  onClick={() => {
                    toggle();
                    setMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-white/[0.06] dark:hover:text-white"
                >
                  {theme === 'dark' ? (
                    <SunIcon size={15} className="shrink-0 text-neutral-500" aria-hidden />
                  ) : (
                    <MoonIcon size={15} className="shrink-0 text-neutral-500" aria-hidden />
                  )}
                  <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
                </button>
                {!USING_MOCK && (
                  <button
                    type="button"
                    data-testid="sign-out"
                    onClick={() => {
                      setMenuOpen(false);
                      onSignOut();
                    }}
                    className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-white/[0.06] dark:hover:text-white"
                  >
                    <SignOutIcon size={15} className="shrink-0 text-neutral-500" aria-hidden />
                    <span>Logout</span>
                  </button>
                )}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      </div>
    </div>
  );
}

function Sidebar({ onClose, onSignOut }: { onClose?: () => void; onSignOut: () => void }) {
  const { range } = useRange();
  const openIssues = useAsync(
    () => (USING_MOCK ? Promise.resolve(null) : api.issues(range, 'open', '', 0).catch(() => null)),
    [range],
    { keepPreviousData: true },
  );
  const issueCount = openIssues.data?.data.length;

  return (
    <div className="flex h-full flex-col bg-white dark:bg-transparent">
      <ProjectHeaderSwitcher onClose={onClose} />
      <nav className="flex flex-1 flex-col overflow-y-auto md:pt-1" aria-label="Main">
        <div className="flex w-full flex-col p-1.5">
          {TOP_NAV.map((item) => (
            <NavItem key={item.to} {...item} badge={item.to === '/issues' ? issueCount : undefined} />
          ))}
          {NAV_SECTIONS.map((section) => (
            <div key={section.label} className="flex flex-col">
              <div className="px-2 pt-4 pb-1 text-xs font-semibold text-neutral-500 dark:text-neutral-500">
                {section.label}
              </div>
              {section.items.map((item) => <NavItem key={item.to} {...item} />)}
            </div>
          ))}
        </div>
        <div className="mt-6 flex w-full flex-col gap-0.5 px-1.5 pb-4">
          {BOTTOM_NAV.map((item) => <NavItem key={item.to} {...item} />)}
        </div>
      </nav>
      <SidebarFooter onSignOut={onSignOut} />
    </div>
  );
}

export default function Layout() {
  const toasts = useKumoToastManager();
  const mainId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { pathname } = useLocation();
  const handleSignOut = () => {
    void signOut().catch(() => toasts.add({ title: 'Could not sign out. Please try again.', variant: 'error' }));
  };
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPaletteShortcut(e)) return;
      e.preventDefault();
      setMenuOpen(false);
      setPaletteOpen((open) => !open);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <ProjectProvider>
    <EnvironmentProvider>
    <RangeProvider>
      <a
        href={`#${mainId}`}
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-blue-600 focus:px-3.5 focus:py-2 focus:text-xs focus:font-medium focus:text-white focus:shadow-lg"
      >
        Skip to content
      </a>
      <div className="flex h-full bg-neutral-50 dark:bg-neutral-900">
        {/* Desktop: fixed 228px sidebar matching Nightwatch AuthenticatedLayout 1:1 */}
        <aside className="hidden w-[228px] shrink-0 flex-col border-r border-neutral-200 bg-white lg:flex dark:border-white/[0.05] dark:bg-transparent">
          <Sidebar onSignOut={handleSignOut} />
        </aside>
        <Dialog.Root open={menuOpen} onOpenChange={setMenuOpen} onOpenChangeComplete={(open) => {
          if (!open) document.querySelector<HTMLButtonElement>('[data-testid="menu-toggle"]')?.focus();
        }}>
          <Dialog className="max-h-[90dvh] w-72 max-w-[85vw] overflow-y-auto p-0">
            <Dialog.Title className="sr-only">Navigation</Dialog.Title>
            <Dialog.Description className="sr-only">Choose a project and dashboard page.</Dialog.Description>
            <Sidebar onClose={() => setMenuOpen(false)} onSignOut={handleSignOut} />
          </Dialog>
        </Dialog.Root>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-neutral-200 bg-white px-4 lg:hidden dark:border-white/[0.05] dark:bg-neutral-900">
            <Button variant="ghost" shape="square" size="sm" icon={ListIcon} aria-label="Open menu" onClick={() => setMenuOpen(true)} data-testid="menu-toggle" />
            <ProjectLabel />
          </header>
          <main id={mainId} className="relative min-w-0 flex-1 overflow-x-clip overflow-y-auto">
            <div className="ew-container min-h-full pt-1 pb-12 md:pt-5">
              <PageBoundary key={pathname}>
                <Suspense fallback={<Loading />}><Outlet /></Suspense>
              </PageBoundary>
            </div>
          </main>
        </div>
      </div>
      <PaletteHost open={paletteOpen} setOpen={setPaletteOpen} />
    </RangeProvider>
    </EnvironmentProvider>
    </ProjectProvider>
  );
}
