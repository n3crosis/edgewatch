import { useKumoToastManager } from '@cloudflare/kumo/components/toast';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { envDotClass, EnvironmentProvider, useEnvironment } from '@/lib/environment';
import Link, { scopedPath } from './ScopedLink';
import { Button } from '@cloudflare/kumo/components/button';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { Popover } from '@cloudflare/kumo/components/popover';
import {
  ArrowsLeftRightIcon,
  BugIcon,
  CaretRightIcon,
  CaretUpDownIcon,
  CheckIcon,
  DatabaseIcon,
  DotsThreeIcon,
  FolderSimpleIcon,
  GaugeIcon,
  KeyIcon,
  ListIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  PlusIcon,
  SignOutIcon,
  SlidersHorizontalIcon,
  SunIcon,
  WarningOctagonIcon,
  XIcon,
} from '@phosphor-icons/react';
import { Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentType } from 'react';
import CommandPalette from './CommandPalette';
import { isPaletteShortcut, type PaletteCommand } from '@/lib/command-palette';
import PageBoundary from './PageBoundary';
import { Loading } from './common';
import { Outlet, useLocation, useMatch, useNavigate, useResolvedPath } from 'react-router-dom';
import { useTheme } from '@/lib/theme';
import { EVENT_PAGES } from '@/lib/events';
import { api, USING_MOCK, useAsync } from '@/lib/api';
import { signOut, useSessionUser } from '@/lib/auth';
import { LayoutScrollContext, LocalPreferencesProvider } from '@/lib/preferences';
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
  '/accounts': ['members', 'invitations', 'users', 'access', 'applications'],
};

const TOP_NAV = NAV.filter((item) => ['/', '/issues'].includes(item.to));

/** Exact Nightwatch sidebar sections (`hi()` in `AuthenticatedLayout-CCFtg7gs.js`). */
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

function NavItem({
  to,
  label,
  icon: Icon,
  end,
  badge,
  compactRail = false,
}: (typeof NAV)[number] & { badge?: number; compactRail?: boolean }) {
  const { range } = useRange();
  const { projectId } = useProject();
  const { environment } = useEnvironment();
  const href = scopedPath(to, projectId, range, environment);
  const active = useMatch({ path: useResolvedPath(to).pathname, end: end ?? false }) !== null;

  const linkNode = (
    <Link
      to={href}
      aria-current={active ? 'page' : undefined}
      aria-label={compactRail ? label : undefined}
      className={
        active
          ? `group relative flex h-9 w-full items-center rounded-md border border-neutral-200 bg-white text-sm font-normal text-neutral-900 shadow-lg shadow-black/[0.04] transition-colors dark:border-white/[0.05] dark:bg-white/[0.05] dark:text-white ${
              compactRail ? 'justify-center px-0 lg:justify-start lg:gap-3 lg:px-2 lg:pr-0.5' : 'gap-3 px-2 pr-0.5'
            }`
          : `group relative flex h-9 w-full items-center rounded-md border border-transparent text-sm text-neutral-500 transition-colors hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white ${
              compactRail ? 'justify-center px-0 lg:justify-start lg:gap-3 lg:px-2 lg:pr-0.5' : 'gap-3 px-2 pr-0.5'
            }`
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
      <span className={`min-w-0 flex-1 truncate ${compactRail ? 'hidden lg:inline' : ''}`}>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span
          className={`mr-2 inline-flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded px-1 font-sans text-[11px] leading-none font-medium tabular-nums ${
            compactRail ? 'hidden lg:inline-flex' : ''
          } ${
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

  if (compactRail) {
    return (
      <Tooltip content={label} side="right" asChild>
        {linkNode}
      </Tooltip>
    );
  }
  return linkNode;
}

/** 1:1 Nightwatch top-left Application + Environment switcher (`bi` & `vi` in `AuthenticatedLayout-CCFtg7gs.js`). */
function ProjectHeaderSwitcher({ onClose, compactRail = false }: { onClose?: () => void; compactRail?: boolean }) {
  const { projectId, projects, setProjectId } = useProject();
  const { range } = useRange();
  const { environment, setEnvironment, envRevision } = useEnvironment();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [appSearch, setAppSearch] = useState('');
  const [hoveredProjectId, setHoveredProjectId] = useState<string>(projectId);
  const [envCache, setEnvCache] = useState<Record<string, { name: string; color?: string | null }[]>>({});

  useEffect(() => {
    setHoveredProjectId(projectId);
  }, [projectId, open]);

  const targetProjectId = hoveredProjectId || projectId;
  const envs = useAsync(
    () => (open ? api.environments(targetProjectId).catch(() => []) : Promise.resolve([])),
    [open, targetProjectId, envRevision],
  );

  useEffect(() => {
    if (!open || !envs.data) return;
    setEnvCache((prev) => ({
      ...prev,
      [targetProjectId]: envs.data!.map((row) => ({ name: row.name, color: row.color })),
    }));
  }, [open, envs.data, targetProjectId]);

  const envItems = useMemo(() => {
    const source = envs.data ?? envCache[targetProjectId] ?? [];
    const map = new Map<string, { name: string; color?: string | null }>();
    for (const row of source) map.set(row.name, { name: row.name, color: row.color });
    if (targetProjectId === projectId && environment !== undefined && !map.has(environment)) {
      map.set(environment, { name: environment, color: null });
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [envs.data, envCache, targetProjectId, projectId, environment]);

  const list = projects.length ? projects : [{ id: projectId, name: projectId, host: undefined }];
  const filteredApps = useMemo(() => {
    const needle = appSearch.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (p) => p.name.toLowerCase().includes(needle) || p.id.toLowerCase().includes(needle),
    );
  }, [list, appSearch]);

  const active = list.find((p) => p.id === projectId) ?? list[0];
  const initial = (active?.name || projectId || 'E').trim().charAt(0).toUpperCase();

  useEffect(() => {
    if (!open) setAppSearch('');
  }, [open]);

  const onChangeProject = (nextId: string, nextEnv?: string | null) => {
    setOpen(false);
    const resolvedEnv = nextEnv === undefined ? environment : nextEnv === null ? undefined : nextEnv;
    if (nextEnv !== undefined) setEnvironment(resolvedEnv);
    if (nextId === projectId) return;
    setProjectId(nextId);
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length >= 2) {
      navigate(scopedPath(`/${segments[0]}`, nextId, range, resolvedEnv), { replace: true });
    } else if (pathname === '/requests' && new URLSearchParams(search).has('route')) {
      navigate(scopedPath('/requests', nextId, range, resolvedEnv), { replace: true });
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
              className={`group relative flex h-full min-w-0 flex-1 items-center transition-all hover:bg-white dark:hover:bg-white/[0.01] focus-visible:outline-2 focus-visible:outline-kumo-link ${
                compactRail ? 'justify-center px-1.5 lg:justify-between lg:gap-2.5 lg:px-2 lg:pr-4' : 'justify-between gap-2.5 px-2 py-2 pr-4'
              } text-left`}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-md border border-neutral-200/80 bg-neutral-100 text-xs font-semibold text-neutral-800 dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-200">
                  {initial}
                </span>
                <span className={`min-w-0 flex-col font-medium ${compactRail ? 'hidden lg:flex' : 'flex'}`}>
                  <span className="truncate text-sm/none text-neutral-900 dark:text-white">
                    {active.name}
                  </span>
                  <span className="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">
                    {environment || 'All environments'}
                  </span>
                </span>
              </span>
              <CaretUpDownIcon
                size={16}
                className={`shrink-0 text-neutral-600 transition-colors group-hover:text-blue-600 dark:text-neutral-500 dark:group-hover:text-neutral-300 ${
                  compactRail ? 'hidden lg:block' : ''
                }`}
                aria-hidden
              />
            </button>
          }
        />
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={4}>
            {/* 1:1 Nightwatch `.dropdown dark` 2-pane Application & Environment switcher */}
            <Popover.Popup className="overflow-hidden rounded-md border border-neutral-800 bg-neutral-900 p-0 text-white shadow-2xl shadow-black/50 dark:border-neutral-700/50 dark:bg-neutral-800">
              <div className="flex max-h-[450px] flex-col sm:flex-row">
                {/* Projects column with live search + New Application button */}
                <div className="flex w-[260px] shrink-0 flex-col">
                  <div className="flex h-11 items-center border-b border-neutral-800 px-3 dark:border-neutral-700/50">
                    <MagnifyingGlassIcon size={15} className="mr-2 shrink-0 text-neutral-400 opacity-60" aria-hidden />
                    <input
                      type="text"
                      value={appSearch}
                      onChange={(e) => setAppSearch(e.target.value)}
                      placeholder="Find application..."
                      aria-label="Find application"
                      className="flex w-full bg-transparent text-sm leading-tight text-white outline-none placeholder:font-light placeholder:text-neutral-500"
                    />
                    {appSearch && (
                      <button
                        type="button"
                        onClick={() => setAppSearch('')}
                        aria-label="Clear application search"
                        className="ml-1 text-neutral-400 hover:text-white"
                      >
                        <XIcon size={12} aria-hidden />
                      </button>
                    )}
                  </div>

                  <div className="max-h-[340px] flex-1 overflow-y-auto p-2">
                    <div className="px-2 pb-1.5 pt-1 text-xs font-medium text-neutral-400 dark:text-neutral-500">
                      Applications
                    </div>
                    {filteredApps.length === 0 ? (
                      <div className="py-5 text-center text-sm text-neutral-500">No results found</div>
                    ) : (
                      <div className="space-y-0.5">
                        {filteredApps.map((project) => {
                          const selected = project.id === projectId;
                          const previewed = project.id === targetProjectId;
                          const letter = (project.name || project.id).trim().charAt(0).toUpperCase();
                          return (
                            <button
                              key={project.id}
                              type="button"
                              onMouseEnter={() => setHoveredProjectId(project.id)}
                              onFocus={() => setHoveredProjectId(project.id)}
                              onClick={() => onChangeProject(project.id)}
                              className={`group/app flex h-9 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-sm transition-colors ${
                                previewed
                                  ? 'bg-neutral-800 font-medium text-white dark:bg-neutral-700/80'
                                  : 'text-neutral-300 hover:bg-neutral-800/80 hover:text-white dark:hover:bg-neutral-700/50'
                              }`}
                            >
                              <span className="flex min-w-0 items-center gap-2">
                                <span className="grid size-5 shrink-0 place-items-center rounded bg-white/10 text-[11px] font-semibold text-white">
                                  {letter}
                                </span>
                                <span className="truncate leading-tight">{project.name}</span>
                              </span>
                              <span className="flex shrink-0 items-center gap-1">
                                {selected && <CheckIcon size={14} className="text-emerald-400" />}
                                <CaretRightIcon size={12} className="text-neutral-500 group-hover/app:text-white" aria-hidden />
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      navigate(scopedPath('/accounts', projectId, range, environment));
                    }}
                    className="flex h-10 w-full shrink-0 items-center gap-2 border-t border-neutral-800 px-4 text-sm text-neutral-300 transition-colors hover:bg-white/5 hover:text-white dark:border-neutral-700/75"
                  >
                    <PlusIcon size={13} aria-hidden />
                    <span>New Application</span>
                  </button>
                </div>

                {/* Environments column (exact Nightwatch 2-pane switcher) */}
                <div className="w-[230px] shrink-0 overflow-y-auto border-t border-neutral-800 p-2 sm:border-l sm:border-t-0 dark:border-neutral-700/50">
                  <div className="px-2 pb-1.5 pt-1 text-xs font-medium text-neutral-400 dark:text-neutral-500">
                    Environments
                  </div>
                  <div className="space-y-0.5">
                    <button
                      type="button"
                      onClick={() => onChangeProject(targetProjectId, null)}
                      className={`ew-fade-in-up flex h-9 w-full items-center justify-between gap-2 rounded-md px-2.5 text-left text-sm transition-colors ${
                        targetProjectId === projectId && environment === undefined
                          ? 'bg-neutral-800 font-medium text-white dark:bg-neutral-700/80'
                          : 'text-neutral-300 hover:bg-neutral-800/80 hover:text-white dark:hover:bg-neutral-700/50'
                      }`}
                    >
                      <span className="flex items-center gap-2.5 truncate">
                        <span className="size-2 shrink-0 rounded-full bg-blue-500 dark:bg-emerald-500" aria-hidden />
                        <span className="truncate">All environments</span>
                      </span>
                      {targetProjectId === projectId && environment === undefined && <CheckIcon size={14} className="shrink-0 text-emerald-400" />}
                    </button>
                    {envItems.map((envItem, idx) => {
                      const selected = targetProjectId === projectId && environment === envItem.name;
                      const dotColor = envDotClass(envItem.name, envItem.color, idx);
                      return (
                        <button
                          key={`${targetProjectId}-${envItem.name}`}
                          type="button"
                          style={{ animationDelay: `${Math.min(idx + 1, 6) * 40}ms` }}
                          onClick={() => onChangeProject(targetProjectId, envItem.name)}
                          className={`ew-fade-in-up flex h-9 w-full items-center justify-between gap-2 rounded-md px-2.5 text-left text-sm transition-colors ${
                            selected
                              ? 'bg-neutral-800 font-medium text-white dark:bg-neutral-700/80'
                              : 'text-neutral-300 hover:bg-neutral-800/80 hover:text-white dark:hover:bg-neutral-700/50'
                          }`}
                        >
                          <span className="flex items-center gap-2.5 truncate">
                            <span className={`size-2 shrink-0 rounded-full ${dotColor}`} aria-hidden />
                            <span className="truncate">{envItem.name}</span>
                          </span>
                          {selected && <CheckIcon size={14} className="shrink-0 text-emerald-400" />}
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

/** 1:1 Nightwatch sidebar footer (`AuthenticatedLayout-CCFtg7gs.js`): avatar + name + `···` dark menu. */
function SidebarFooter({
  onSignOut,
  onNavigate,
  compactRail = false,
}: {
  onSignOut: () => void;
  onNavigate?: () => void;
  compactRail?: boolean;
}) {
  const user = useSessionUser();
  const { theme, toggle } = useTheme();
  const { projectId } = useProject();
  const { range } = useRange();
  const { environment } = useEnvironment();
  const [menuOpen, setMenuOpen] = useState(false);
  const displayName = user?.name || user?.email || (USING_MOCK ? 'Demo' : 'Account');
  const initial = displayName.trim().charAt(0).toUpperCase();
  const settingsHref = scopedPath('/setup', projectId, range, environment);
  const accountsHref = scopedPath('/accounts', projectId, range, environment);

  return (
    <div className="sticky bottom-0 z-10 w-full shrink-0 border-t border-neutral-200 p-1.5 dark:border-white/[0.05]">
      <div className={`flex items-center gap-0.5 ${compactRail ? 'flex-col justify-center lg:flex-row' : 'flex-row'}`}>
        <Link
          to={accountsHref}
          onClick={onNavigate}
          className={`flex h-8 min-w-0 items-center gap-2 rounded-md p-2 transition-colors hover:bg-neutral-200/70 dark:hover:bg-white/10 ${
            compactRail ? 'justify-center lg:flex-1 lg:justify-start' : 'flex-1'
          }`}
          title={displayName}
        >
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-neutral-200 text-xs font-medium text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200">
            {initial}
          </span>
          <span className={`truncate text-sm text-neutral-900 dark:text-white ${compactRail ? 'hidden lg:inline' : ''}`}>
            {displayName}
          </span>
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
              <Popover.Popup className="w-48 rounded-md border border-neutral-800 bg-neutral-900 p-1 text-white shadow-2xl shadow-black/50 dark:border-neutral-700/50 dark:bg-neutral-800">
                <button
                  type="button"
                  data-testid="theme-toggle"
                  onClick={() => {
                    toggle();
                    setMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-neutral-200 transition-colors hover:bg-neutral-800 hover:text-white dark:hover:bg-neutral-700/70"
                >
                  {theme === 'dark' ? (
                    <SunIcon size={15} className="shrink-0 text-neutral-400" aria-hidden />
                  ) : (
                    <MoonIcon size={15} className="shrink-0 text-neutral-400" aria-hidden />
                  )}
                  <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
                </button>
                <div className="my-1 border-t border-neutral-800 dark:border-neutral-700/60" aria-hidden />
                <Link
                  to={settingsHref}
                  onClick={() => {
                    setMenuOpen(false);
                    onNavigate?.();
                  }}
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-neutral-200 transition-colors hover:bg-neutral-800 hover:text-white dark:hover:bg-neutral-700/70"
                >
                  <SlidersHorizontalIcon size={15} className="shrink-0 text-neutral-400" aria-hidden />
                  <span>Settings</span>
                </Link>
                <Link
                  to={accountsHref}
                  onClick={() => {
                    setMenuOpen(false);
                    onNavigate?.();
                  }}
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-neutral-200 transition-colors hover:bg-neutral-800 hover:text-white dark:hover:bg-neutral-700/70"
                >
                  <KeyIcon size={15} className="shrink-0 text-neutral-400" aria-hidden />
                  <span>Accounts</span>
                </Link>
                {!USING_MOCK && (
                  <button
                    type="button"
                    data-testid="sign-out"
                    onClick={() => {
                      setMenuOpen(false);
                      onSignOut();
                    }}
                    className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-neutral-200 transition-colors hover:bg-neutral-800 hover:text-white dark:hover:bg-neutral-700/70"
                  >
                    <SignOutIcon size={15} className="shrink-0 text-neutral-400" aria-hidden />
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

function Sidebar({
  onClose,
  onSignOut,
  compactRail = false,
}: {
  onClose?: () => void;
  onSignOut: () => void;
  compactRail?: boolean;
}) {
  const { range } = useRange();
  const openIssues = useAsync(
    () => (USING_MOCK ? Promise.resolve(null) : api.issues(range, 'open', '', 0).catch(() => null)),
    [range],
    { keepPreviousData: true },
  );
  const issueCount = openIssues.data?.data.length;

  return (
    <div className="flex h-full flex-col bg-white dark:bg-transparent">
      <ProjectHeaderSwitcher onClose={onClose} compactRail={compactRail} />
      <nav className="flex flex-1 flex-col overflow-y-auto md:pt-1" aria-label="Main">
        <div className="flex w-full flex-col p-1.5">
          {TOP_NAV.map((item) => (
            <NavItem
              key={item.to}
              {...item}
              compactRail={compactRail}
              badge={item.to === '/issues' ? issueCount : undefined}
            />
          ))}
          {NAV_SECTIONS.map((section) => (
            <div key={section.label} className="flex flex-col">
              <div
                className={`px-2 pt-4 pb-1 text-xs font-semibold text-neutral-500 dark:text-neutral-500 ${
                  compactRail ? 'hidden lg:block' : ''
                }`}
              >
                {section.label}
              </div>
              {compactRail && <div className="my-2 border-t border-neutral-200 lg:hidden dark:border-white/[0.06]" aria-hidden />}
              {section.items.map((item) => (
                <NavItem key={item.to} {...item} compactRail={compactRail} />
              ))}
            </div>
          ))}
        </div>
      </nav>
      <SidebarFooter onSignOut={onSignOut} onNavigate={onClose} compactRail={compactRail} />
    </div>
  );
}

export default function Layout() {
  const toasts = useKumoToastManager();
  const mainId = useId();
  const mainRef = useRef<HTMLElement>(null);
  const [isScrolled, setIsScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { pathname } = useLocation();

  const scrollToTop = useCallback(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, []);

  const handleSignOut = () => {
    void signOut().catch(() => toasts.add({ title: 'Could not sign out. Please try again.', variant: 'error' }));
  };

  useEffect(() => {
    setMenuOpen(false);
    if (mainRef.current) {
      mainRef.current.scrollTop = 0;
      setIsScrolled(false);
    }
  }, [pathname]);

  // Exact Nightwatch `AuthenticatedLayout-CCFtg7gs.js` scroll listener (`e.scrollTop > 24`)
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const onScroll = () => setIsScrolled(el.scrollTop > 24);
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

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
    <LocalPreferencesProvider>
    <ProjectProvider>
    <EnvironmentProvider>
    <RangeProvider>
    <LayoutScrollContext.Provider value={{ isScrolled, scrollToTop }}>
      <a
        href={`#${mainId}`}
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-blue-600 focus:px-3.5 focus:py-2 focus:text-xs focus:font-medium focus:text-white focus:shadow-lg"
      >
        Skip to content
      </a>
      <div className="flex h-svh w-full overflow-hidden bg-neutral-50 dark:bg-neutral-900">
        {/* Desktop & tablet: exact Nightwatch responsive sidebar (48px icon rail on md, 228px full on lg) */}
        <aside className="hidden h-dvh shrink-0 flex-col border-r border-neutral-200 bg-white transition-[width] duration-200 md:flex md:w-[48px] lg:w-[228px] dark:border-white/[0.05] dark:bg-transparent">
          <Sidebar onSignOut={handleSignOut} compactRail />
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
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-neutral-200 bg-white px-4 md:hidden dark:border-white/[0.05] dark:bg-neutral-900">
            <Button variant="ghost" shape="square" size="sm" icon={ListIcon} aria-label="Open menu" onClick={() => setMenuOpen(true)} data-testid="menu-toggle" />
            <ProjectLabel />
          </header>
          <main ref={mainRef} id={mainId} className="relative min-w-0 flex-1 overflow-x-clip overflow-y-auto">
            <div className="ew-container min-h-full pt-1 pb-12 md:pt-5">
              <PageBoundary key={pathname}>
                <Suspense fallback={<Loading />}><Outlet /></Suspense>
              </PageBoundary>
            </div>
          </main>
        </div>
      </div>
      <PaletteHost open={paletteOpen} setOpen={setPaletteOpen} />
    </LayoutScrollContext.Provider>
    </RangeProvider>
    </EnvironmentProvider>
    </ProjectProvider>
    </LocalPreferencesProvider>
  );
}
