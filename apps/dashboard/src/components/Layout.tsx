import { useKumoToastManager } from '@cloudflare/kumo/components/toast';
import EnvironmentPicker from './EnvironmentPicker';
import { EnvironmentProvider, useEnvironment } from '@/lib/environment';
import { environmentScopedPath } from '@/lib/environment-scope';
import { scopedPath } from './ScopedLink';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button, LinkButton } from '@cloudflare/kumo/components/button';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import RangePicker from './RangePicker';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import {
  ArrowClockwiseIcon,
  ArrowsLeftRightIcon,
  BroadcastIcon,
  BugIcon,
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
  UserCircleIcon,
  WarningOctagonIcon,
  XIcon,
} from '@phosphor-icons/react';
import { Suspense, useEffect, useId, useMemo, useState, type ComponentType } from 'react';
import CommandPalette from './CommandPalette';
import { isPaletteShortcut, type PaletteCommand } from '@/lib/command-palette';
import PageBoundary from './PageBoundary';
import { Loading } from './common';
import { Select } from '@cloudflare/kumo/components/select';
import { Outlet, useLocation, useMatch, useNavigate, useResolvedPath } from 'react-router-dom';
import { useTheme } from '@/lib/theme';
import { EVENT_PAGES } from '@/lib/events';
import { USING_MOCK } from '@/lib/api';
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

const NAV_SECTIONS = [
  { label: 'Overview', items: NAV.filter((item) => ['/', '/issues'].includes(item.to)) },
  { label: 'HTTP & Code', items: NAV.filter((item) => ['/requests', '/traces', '/exceptions', '/queries', '/logs'].includes(item.to)) },
  { label: 'Background & Services', items: NAV.filter((item) => ['/jobs', '/scheduled-tasks', '/commands', '/outgoing-requests', '/cache', '/mail', '/notifications'].includes(item.to)) },
  { label: 'Audience', items: NAV.filter((item) => ['/users'].includes(item.to)) },
  { label: 'Manage', items: NAV.filter((item) => ['/pipeline', '/setup', '/accounts'].includes(item.to)) },
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

function NavItem({ to, label, icon: Icon, end }: (typeof NAV)[number]) {
  const { range } = useRange();
  const { projectId } = useProject();
  const { environment } = useEnvironment();
  const href = scopedPath(to, projectId, range, environment);
  const active = useMatch({ path: useResolvedPath(to).pathname, end: end ?? false }) !== null;
  return (
    <LinkButton
      href={href}
      variant={active ? 'secondary' : 'ghost'}
      size="sm"
      icon={<Icon weight={active ? 'duotone' : 'regular'} />}
      aria-current={active ? 'page' : undefined}
      className={`h-9 w-full justify-start gap-3 px-3 text-sm ${active ? 'font-medium text-kumo-strong' : 'text-kumo-subtle hover:text-kumo-default'}`}
    >
      {label}
    </LinkButton>
  );
}

function ProjectSwitcher() {
  const { projectId, projects, setProjectId } = useProject();
  const { range } = useRange();
  const { environment } = useEnvironment();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const items = (projects.length ? projects : [{ id: projectId, name: projectId }]).map((p) => ({ value: p.id, label: p.name }));

  const onChange = (nextId: string) => {
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
    <Select
      aria-label="Project"
      className="w-full"
      value={projectId}
      onValueChange={(v) => v && onChange(String(v))}
      items={items}
      data-testid="project-switcher"
    />
  );
}

function ProjectLabel() {
  const { projectId, projects } = useProject();
  const p = projects.find((x) => x.id === projectId);
  const label = p?.name ?? projectId;
  return (
    <div className="flex min-w-0 items-center gap-2 truncate text-sm text-kumo-subtle">
      <FolderSimpleIcon size={15} className="shrink-0 text-kumo-subtle" aria-hidden />
      <span className="truncate font-semibold text-kumo-strong">{label}</span>
      {p?.host && <span className="hidden truncate xl:inline">· {p.host}</span>}
      {label !== projectId && (
        <span className="hidden rounded-md bg-kumo-recessed px-2 py-0.5 font-mono text-xs text-kumo-subtle md:inline">{projectId}</span>
      )}
    </div>
  );
}

function RefreshButton() {
  const { lastUpdated, refresh } = useRange();
  const [spinning, setSpinning] = useState(false);
  const triggerRefresh = () => {
    refresh();
    setSpinning(true);
    setTimeout(() => setSpinning(false), 450);
  };
  return (
    <Tooltip asChild content={`Refresh now · updated ${new Date(lastUpdated).toLocaleTimeString()}`}>
      <Button
        variant="ghost"
        shape="square"
        size="sm"
        aria-label="Refresh data"
        onClick={triggerRefresh}
        icon={<ArrowClockwiseIcon className={spinning ? 'animate-refresh' : undefined} />}
      />
    </Tooltip>
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

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-kumo-brand text-white shadow-xs">
        <BroadcastIcon size={19} weight="bold" />
      </div>
      <div className="min-w-0">
        <div className="text-[15px] font-semibold leading-tight text-kumo-strong">EdgeWatch</div>
        <div className="mt-0.5 truncate text-xs text-kumo-subtle">Application Monitoring</div>
      </div>
    </div>
  );
}

function SidebarFooter({ onSignOut }: { onSignOut: () => void }) {
  const user = useSessionUser();
  return (
    <div className="mt-auto border-t border-kumo-hairline px-4 py-3.5">
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
              <UserCircleIcon size={22} className="shrink-0 text-kumo-subtle" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-kumo-strong">{user.name || user.email}</div>
                <div className="truncate text-xs capitalize text-kumo-subtle">{user.role}</div>
              </div>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
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
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-kumo-hairline px-5 py-4">
        <Brand />
        {onClose && <Button variant="ghost" shape="square" size="sm" icon={XIcon} aria-label="Close menu" onClick={onClose} />}
      </div>
      <div className="space-y-3 border-b border-kumo-hairline px-4 py-4">
        <div>
          <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-kumo-subtle">Project</div>
          <ProjectSwitcher />
        </div>
        <button
          type="button"
          onClick={() => {
            onClose?.();
            onOpenPalette();
          }}
          aria-label="Search"
          aria-keyshortcuts="Meta+K Control+K"
          data-testid="palette-toggle"
          className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-kumo-hairline bg-kumo-recessed/60 px-3 text-xs text-kumo-subtle transition-colors hover:border-kumo-line hover:bg-kumo-tint/60 hover:text-kumo-strong focus-visible:outline-2 focus-visible:outline-kumo-link"
        >
          <span className="flex items-center gap-2">
            <MagnifyingGlassIcon size={14} aria-hidden />
            <span>Search…</span>
          </span>
          <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1.5 py-0.5 font-sans text-[10px] leading-none text-kumo-subtle">⌘K</kbd>
        </button>
      </div>
      <nav className="flex-1 space-y-6 overflow-y-auto px-3.5 py-5" aria-label="Main">
        {NAV_SECTIONS.map((section) => (
          <div key={section.label} className="space-y-1">
            <div className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-kumo-subtle">
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
  const isTelemetryView = environmentScopedPath(pathname);
  const showHeaderControls = isTelemetryView || pathname === '/pipeline' || pathname.startsWith('/pipeline/');
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
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-kumo-brand focus:px-3.5 focus:py-2 focus:text-xs focus:font-medium focus:text-white focus:shadow-lg"
      >
        Skip to content
      </a>
      <div className="flex h-full">
        {/* Desktop: fixed sidebar. Mobile: slide-over drawer opened from the header. */}
        <aside className="hidden w-64 shrink-0 flex-col border-r border-kumo-hairline bg-kumo-elevated lg:flex">
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
          <header
            className={`flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-kumo-hairline bg-kumo-elevated/75 px-5 py-3 sm:px-8 lg:min-h-16 lg:px-10 ${!showHeaderControls ? 'lg:hidden' : ''}`}
          >
            <div className="flex min-w-0 items-center gap-3">
              <Button variant="ghost" shape="square" size="sm" icon={ListIcon} aria-label="Open menu" onClick={() => setMenuOpen(true)} data-testid="menu-toggle" className="lg:hidden" />
              <ProjectLabel />
            </div>
            {showHeaderControls && (
              <div className="flex w-full flex-wrap items-center gap-3 lg:w-auto">
                <RefreshButton />
                {isTelemetryView && (
                  <>
                    <EnvironmentPicker />
                    <RangePicker />
                  </>
                )}
              </div>
            )}
          </header>
          <main id={mainId} className="min-w-0 flex-1 overflow-y-auto px-5 py-7 sm:px-8 sm:py-8 lg:px-10 lg:py-9">
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
