import { useKumoToastManager } from '@cloudflare/kumo/components/toast';
import { EnvironmentProvider, useEnvironment } from '@/lib/environment';
import Link, { scopedPath } from './ScopedLink';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { Popover } from '@cloudflare/kumo/components/popover';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import {
  ArrowsLeftRightIcon,
  BugIcon,
  CaretUpDownIcon,
  CheckIcon,
  DatabaseIcon,
  FlaskIcon,
  FolderSimpleIcon,
  GaugeIcon,
  GitBranchIcon,
  KeyIcon,
  ListIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  PlugIcon,
  QueueIcon,
  SignOutIcon,
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
  { to: '/traces', label: 'Traces', icon: GitBranchIcon },
  { to: '/exceptions', label: 'Exceptions', icon: BugIcon },
  { to: '/queries', label: 'Queries', icon: DatabaseIcon },
  ...EVENT_PAGES.map((p) => ({ to: p.path, label: p.nav, icon: p.icon, end: false })),
  { to: '/pipeline', label: 'Pipeline', icon: QueueIcon },
  { to: '/setup', label: 'Setup', icon: PlugIcon },
  { to: '/accounts', label: 'Accounts', icon: KeyIcon },
];

const NAV_ICONS: Record<string, ComponentType<{ size?: number; className?: string }>> = Object.fromEntries(
  NAV.map((item) => [item.to, item.icon]),
);

const KEYWORDS: Record<string, string[]> = {
  '/': ['overview', 'home'],
  '/issues': ['problems', 'triage'],
  '/requests': ['routes', 'http'],
  '/traces': ['executions', 'spans', 'waterfall'],
  '/exceptions': ['errors'],
  '/queries': ['sql', 'database', 'slow'],
  '/pipeline': ['queue', 'dead letters', 'usage', 'health'],
  '/setup': ['install', 'keys'],
  '/accounts': ['members', 'invitations', 'users', 'access'],
};

const TOP_NAV = NAV.filter((item) => ['/', '/issues'].includes(item.to));

const NAV_SECTIONS = [
  {
    label: 'Activity',
    items: ['/requests', '/traces', '/jobs', '/commands', '/scheduled-tasks', '/exceptions', '/queries', '/notifications', '/mail', '/cache', '/outgoing-requests']
      .map((path) => NAV.find((item) => item.to === path))
      .filter((item): item is (typeof NAV)[number] => Boolean(item)),
  },
  {
    label: 'Monitoring',
    items: ['/users', '/logs']
      .map((path) => NAV.find((item) => item.to === path))
      .filter((item): item is (typeof NAV)[number] => Boolean(item)),
  },
  {
    label: 'Manage',
    items: ['/pipeline', '/setup', '/accounts']
      .map((path) => NAV.find((item) => item.to === path))
      .filter((item): item is (typeof NAV)[number] => Boolean(item)),
  },
];

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
          ? 'group relative flex h-9 w-full items-center gap-2.5 rounded-md border border-neutral-200 bg-white px-2.5 text-sm font-medium text-neutral-900 shadow-sm shadow-black/[0.04] transition-colors dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-white'
          : 'group relative flex h-9 w-full items-center gap-2.5 rounded-md border border-transparent px-2.5 text-sm text-neutral-500 transition-colors hover:bg-neutral-100/70 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/[0.03] dark:hover:text-white'
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
          className={`inline-flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded px-1 font-sans text-[11px] leading-none font-medium tabular-nums ${
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

function ProjectHeaderSwitcher({ onClose }: { onClose?: () => void }) {
  const { projectId, projects, setProjectId } = useProject();
  const { range } = useRange();
  const { environment } = useEnvironment();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const list = projects.length ? projects : [{ id: projectId, name: projectId, host: undefined }];
  const active = list.find((p) => p.id === projectId) ?? list[0];
  const initial = (active?.name || projectId || 'E').trim().charAt(0).toUpperCase();

  const onChange = (nextId: string) => {
    setOpen(false);
    if (nextId === projectId) return;
    setProjectId(nextId);
    // Avoid stranding users on a project-specific detail URL (e.g. /traces/:id) when switching projects.
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length >= 2) {
      navigate(scopedPath(`/${segments[0]}`, nextId, range, environment), { replace: true });
    } else if (pathname === '/requests' && new URLSearchParams(search).has('route')) {
      navigate(scopedPath('/requests', nextId, range, environment), { replace: true });
    }
  };

  return (
    <div className="flex h-14 shrink-0 items-center border-b border-neutral-200 dark:border-white/[0.06]">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          render={
            <button
              type="button"
              data-testid="project-switcher"
              aria-label="Switch project"
              className="group flex h-full min-w-0 flex-1 items-center justify-between gap-2.5 px-3 text-left transition-colors hover:bg-neutral-50 dark:hover:bg-white/[0.02] focus-visible:outline-2 focus-visible:outline-kumo-link"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-md border border-neutral-200/80 bg-neutral-100 text-xs font-semibold text-neutral-800 dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-200">
                  {initial}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm/tight font-medium text-neutral-900 dark:text-white">
                    {active.name}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-neutral-500 dark:text-neutral-400">
                    {environment || 'All environments'}
                  </span>
                </span>
              </span>
              <CaretUpDownIcon size={15} className="shrink-0 text-neutral-400 transition-colors group-hover:text-blue-600 dark:group-hover:text-neutral-200" aria-hidden />
            </button>
          }
        />
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={6}>
            <Popover.Popup className="w-60 rounded-xl border border-neutral-200 bg-white p-1.5 shadow-lg shadow-black/10 dark:border-white/10 dark:bg-neutral-900">
              <div className="px-2.5 py-1.5 font-mono text-[10px] font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                Projects
              </div>
              <div className="space-y-0.5">
                {list.map((project) => {
                  const selected = project.id === projectId;
                  const letter = (project.name || project.id).trim().charAt(0).toUpperCase();
                  return (
                    <button
                      key={project.id}
                      type="button"
                      onClick={() => onChange(project.id)}
                      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                        selected
                          ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-white/[0.08] dark:text-white'
                          : 'text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-white/[0.04] dark:hover:text-white'
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span className="grid size-6 shrink-0 place-items-center rounded bg-neutral-200/70 text-[11px] font-semibold text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200">
                          {letter}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate leading-tight">{project.name}</span>
                          {project.name !== project.id && (
                            <span className="block truncate font-mono text-[11px] text-neutral-400">{project.id}</span>
                          )}
                        </span>
                      </span>
                      {selected && <CheckIcon size={14} className="shrink-0 text-blue-600 dark:text-emerald-500" />}
                    </button>
                  );
                })}
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

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <Tooltip asChild content={label}>
      <Button variant="ghost" shape="square" size="sm" icon={theme === 'dark' ? SunIcon : MoonIcon} aria-label={label} onClick={toggle} data-testid="theme-toggle" />
    </Tooltip>
  );
}

function SidebarFooter({ onSignOut }: { onSignOut: () => void }) {
  const user = useSessionUser();
  const displayName = user?.name || user?.email || 'Account';
  const initial = displayName.trim().charAt(0).toUpperCase();
  return (
    <div className="mt-auto border-t border-neutral-200 px-3 py-2.5 dark:border-white/[0.06]">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          {USING_MOCK ? (
            <Tooltip asChild content="VITE_API_URL is not set: showing generated seed data.">
              <span data-testid="data-source" className="inline-flex">
                <Badge variant="warning">
                  <FlaskIcon />
                  Seed data
                </Badge>
              </span>
            </Tooltip>
          ) : user ? (
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="grid size-7 shrink-0 place-items-center rounded-md border border-neutral-200/80 bg-neutral-100 text-xs font-medium text-neutral-800 dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-200">
                {initial}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm/tight font-medium text-neutral-900 dark:text-white">{displayName}</div>
                <div className="truncate text-[11px] capitalize text-neutral-500 dark:text-neutral-400">{user.role}</div>
              </div>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <ThemeToggle />
          {!USING_MOCK && (
            <Tooltip asChild content="Sign out">
              <Button
                variant="ghost"
                shape="square"
                size="sm"
                icon={SignOutIcon}
                aria-label="Sign out"
                onClick={onSignOut}
                data-testid="sign-out"
              />
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}

function Sidebar({ onClose, onOpenPalette, onSignOut }: { onClose?: () => void; onOpenPalette: () => void; onSignOut: () => void }) {
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
      <div className="px-2.5 pt-2.5">
        <button
          type="button"
          onClick={() => {
            onClose?.();
            onOpenPalette();
          }}
          aria-label="Search"
          aria-keyshortcuts="Meta+K Control+K"
          data-testid="palette-toggle"
          className="flex h-8 w-full items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-neutral-50/80 px-2.5 text-xs text-neutral-500 transition-colors hover:border-blue-400 hover:bg-white hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-kumo-link dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-neutral-400 dark:hover:border-white/15 dark:hover:text-white"
        >
          <span className="flex items-center gap-2">
            <MagnifyingGlassIcon size={13} aria-hidden />
            <span>Search…</span>
          </span>
          <kbd className="rounded border border-neutral-200 bg-white px-1.5 py-0.5 font-mono text-[10px] leading-none text-neutral-500 dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-400">
            ⌘K
          </kbd>
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-2.5" aria-label="Main">
        <div className="space-y-0.5">
          {TOP_NAV.map((item) => (
            <NavItem key={item.to} {...item} badge={item.to === '/issues' ? issueCount : undefined} />
          ))}
        </div>
        {NAV_SECTIONS.map((section) => (
          <div key={section.label} className="mt-4 space-y-0.5">
            <div className="px-2.5 pb-1 text-xs font-semibold text-neutral-500 dark:text-neutral-500">
              {section.label}
            </div>
            {section.items.map((item) => <NavItem key={item.to} {...item} />)}
          </div>
        ))}
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
        {/* Desktop: fixed 228px sidebar matching capture width & crisp white rail. Mobile: slide-over drawer. */}
        <aside className="hidden w-[228px] shrink-0 flex-col border-r border-neutral-200 bg-white lg:flex dark:border-white/[0.06] dark:bg-neutral-950/35">
          <Sidebar onOpenPalette={() => setPaletteOpen(true)} onSignOut={handleSignOut} />
        </aside>
        <Dialog.Root open={menuOpen} onOpenChange={setMenuOpen} onOpenChangeComplete={(open) => {
          if (!open) document.querySelector<HTMLButtonElement>('[data-testid="menu-toggle"]')?.focus();
        }}>
          <Dialog className="max-h-[90dvh] w-72 max-w-[85vw] overflow-y-auto p-0">
            <Dialog.Title className="sr-only">Navigation</Dialog.Title>
            <Dialog.Description className="sr-only">Choose a project and dashboard page.</Dialog.Description>
            <Sidebar onClose={() => setMenuOpen(false)} onOpenPalette={() => setPaletteOpen(true)} onSignOut={handleSignOut} />
          </Dialog>
        </Dialog.Root>
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Mobile-only navigation header; desktop puts title + telemetry controls on ONE unified PageHeader row */}
          <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-neutral-200 bg-white px-4 lg:hidden dark:border-white/[0.06] dark:bg-neutral-900">
            <Button variant="ghost" shape="square" size="sm" icon={ListIcon} aria-label="Open menu" onClick={() => setMenuOpen(true)} data-testid="menu-toggle" />
            <ProjectLabel />
          </header>
          <main id={mainId} className="min-w-0 flex-1 overflow-y-auto px-5 py-5 sm:px-8 lg:px-10 lg:py-6">
            <div className="mx-auto w-full max-w-[1440px]">
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
