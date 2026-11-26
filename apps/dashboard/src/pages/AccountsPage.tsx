import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@cloudflare/kumo/components/button';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { Input } from '@cloudflare/kumo/components/input';
import { Popover } from '@cloudflare/kumo/components/popover';
import { useKumoToastManager } from '@cloudflare/kumo/components/toast';
import { cn } from '@cloudflare/kumo/utils';
import {
  ArrowUpRightIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  CrownSimpleIcon,
  DotsThreeVerticalIcon,
  EnvelopeSimpleIcon,
  EyeIcon,
  KeyIcon,
  LockSimpleIcon,
  PencilSimpleIcon,
  PlusIcon,
  ProhibitIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  TrashIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import { scopedPath } from '@/components/ScopedLink';
import { ErrorState, Loading, PageHeader, TimeAgo } from '@/components/common';
import { SettingsRow, SettingsRowGroup, SettingsSection } from '@/components/SettingsPrimitives';
import { api, useAsync } from '@/lib/api';
import { accountRequest, useSessionUser } from '@/lib/auth';
import { useProject, type ProjectInfo } from '@/lib/project';
import { useRange } from '@/lib/range';

interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
  disabled: number;
}
interface Invitation {
  email: string;
  role: string;
  expires_at: number;
}
interface Directory {
  users: Member[];
  invitations: Invitation[];
}

interface UnifiedMemberRow {
  key: string;
  type: 'user' | 'invite';
  id?: string;
  name: string;
  email: string;
  role: string;
  disabled?: boolean;
  expired?: boolean;
  expiresAt?: number;
}

const ROLE_META: Record<string, { label: string; description: string; icon: typeof EyeIcon }> = {
  owner: {
    label: 'Owner',
    description: 'Full installation and account control',
    icon: CrownSimpleIcon,
  },
  admin: {
    label: 'Admin',
    description: 'Triage issues and configure settings',
    icon: ShieldCheckIcon,
  },
  viewer: {
    label: 'Viewer',
    description: 'Read-only access to application telemetry',
    icon: EyeIcon,
  },
};

function slugifyProjectId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[-._]+$/g, '')
    .slice(0, 64);
}

function MemberAvatar({ name, muted }: { name: string; muted?: boolean }) {
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  return (
    <span
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold',
        muted
          ? 'bg-neutral-200 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'
          : 'bg-neutral-900 text-white dark:bg-white/15 dark:text-white',
      )}
      aria-hidden
    >
      {initial}
    </span>
  );
}

/** 1:1 Nightwatch `Edit-tQlumie6.js` `···` row action menu built with Kumo Popover. */
function RowActionsMenu({
  label,
  actionText,
  icon: Icon,
  onAction,
}: {
  label: string;
  actionText: string;
  icon: typeof TrashIcon;
  onAction: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            aria-label={label}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-white text-neutral-500 transition-colors hover:border-neutral-300 hover:bg-neutral-50 hover:text-neutral-900 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
          >
            <DotsThreeVerticalIcon size={16} weight="bold" aria-hidden />
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6}>
          <Popover.Popup className="w-44 rounded-lg border border-neutral-200 bg-white p-1 shadow-xl shadow-black/15 dark:border-white/10 dark:bg-neutral-900">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onAction();
              }}
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-rose-600 transition-colors hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/50"
            >
              <Icon size={14} className="shrink-0" aria-hidden />
              <span>{actionText}</span>
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ApplicationActionsMenu({
  project,
  onOpenSettings,
  onRename,
  onDelete,
}: {
  project: ProjectInfo;
  onOpenSettings: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            aria-label={`Manage ${project.name}`}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-white text-neutral-500 transition-colors hover:border-neutral-300 hover:bg-neutral-50 hover:text-neutral-900 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
          >
            <DotsThreeVerticalIcon size={16} weight="bold" aria-hidden />
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6}>
          <Popover.Popup className="w-48 rounded-lg border border-neutral-200 bg-white p-1 shadow-xl shadow-black/15 dark:border-white/10 dark:bg-neutral-900">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-neutral-700 transition-colors hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-white/[0.06]"
            >
              <SlidersHorizontalIcon size={14} className="shrink-0 text-neutral-400" aria-hidden />
              <span>Settings</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onRename();
              }}
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-neutral-700 transition-colors hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-white/[0.06]"
            >
              <PencilSimpleIcon size={14} className="shrink-0 text-neutral-400" aria-hidden />
              <span>Rename</span>
            </button>
            <div className="my-1 border-t border-neutral-200 dark:border-white/10" />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-rose-600 transition-colors hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/50"
            >
              <TrashIcon size={14} className="shrink-0" aria-hidden />
              <span>Delete application</span>
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export default function AccountsPage() {
  const user = useSessionUser();
  const { projectId, projects, setProjectId, refreshProjects } = useProject();
  const { range } = useRange();
  const navigate = useNavigate();
  const toasts = useKumoToastManager();

  const permissions = useAsync(() => api.permissions(), []);
  const canManage = Boolean(permissions.data?.can_manage);
  const owner = user?.role === 'owner';

  // Member management state
  const [revision, setRevision] = useState(0);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'viewer' | 'admin'>('viewer');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState('');
  const [copiedLink, setCopiedLink] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    path: string;
    body: object;
    title: string;
    label: string;
    actionLabel: string;
  } | null>(null);

  // Application management state
  const [addAppOpen, setAddAppOpen] = useState(false);
  const [appName, setAppName] = useState('');
  const [appSlug, setAppSlug] = useState('');
  const [appSlugTouched, setAppSlugTouched] = useState(false);
  const [createdKey, setCreatedKey] = useState<{ id: string; name: string; key: string } | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ProjectInfo | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ProjectInfo | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');

  const { data, error, loading } = useAsync<Directory | null>(
    () => (owner ? accountRequest('manage/accounts') : Promise.resolve(null)),
    [owner, revision],
    { keepPreviousData: true },
  );

  const notify = (err: unknown) =>
    toasts.add({ variant: 'error', title: err instanceof Error ? err.message : 'Please try again.' });

  const copyText = (value: string, label: string, setCopied: (v: boolean) => void) => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        toasts.add({ title: label, variant: 'success' });
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(notify);
  };

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const result = await accountRequest('invitations', { email, role });
      const inviteUrl = `${window.location.origin}/#invite=${encodeURIComponent(result.token)}`;
      setLink(inviteUrl);
      setEmail('');
      setInviteOpen(false);
      setRevision((n) => n + 1);
      toasts.add({ variant: 'success', title: 'Invitation created. Share the link with your teammate.' });
    } catch (err) {
      notify(err);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!confirmation || busy) return;
    setBusy(true);
    try {
      await accountRequest(confirmation.path, confirmation.body);
      setConfirmation(null);
      setRevision((n) => n + 1);
      toasts.add({ variant: 'success', title: 'Account access updated.' });
    } catch (err) {
      notify(err);
    } finally {
      setBusy(false);
    }
  };

  const handleCreateApp = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !appName.trim()) return;
    setBusy(true);
    try {
      const created = await api.createProject({
        name: appName.trim(),
        id: appSlug.trim() || undefined,
        mint_ingest_key: true,
      });
      if (created.ingest_key) {
        setCreatedKey({ id: created.id, name: created.name, key: created.ingest_key });
      }
      setAppName('');
      setAppSlug('');
      setAppSlugTouched(false);
      setAddAppOpen(false);
      refreshProjects();
      toasts.add({ variant: 'success', title: `Application "${created.name}" added.` });
    } catch (err) {
      notify(err);
    } finally {
      setBusy(false);
    }
  };

  const handleRenameApp = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !renameTarget || !renameValue.trim()) return;
    setBusy(true);
    try {
      await api.renameProject(renameTarget.id, renameValue.trim());
      setRenameTarget(null);
      refreshProjects();
      toasts.add({ variant: 'success', title: 'Application renamed.' });
    } catch (err) {
      notify(err);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteApp = async () => {
    if (busy || !deleteTarget || deleteConfirm.trim() !== deleteTarget.id) return;
    setBusy(true);
    try {
      const targetId = deleteTarget.id;
      const targetName = deleteTarget.name;
      await api.deleteProject(targetId);
      setDeleteTarget(null);
      setDeleteConfirm('');
      if (targetId === projectId) {
        const remaining = projects.filter((p) => p.id !== targetId);
        if (remaining.length > 0) setProjectId(remaining[0].id);
      }
      refreshProjects();
      toasts.add({ variant: 'success', title: `Application "${targetName}" deleted.` });
    } catch (err) {
      notify(err);
    } finally {
      setBusy(false);
    }
  };

  const openApplication = (app: ProjectInfo) => {
    setProjectId(app.id);
    navigate(scopedPath('/', app.id, range));
  };

  const openApplicationSettings = (app: ProjectInfo) => {
    setProjectId(app.id);
    navigate(scopedPath('/setup', app.id, range));
  };

  // Unified Nightwatch-style member list (active users + pending invitations sorted alphabetically)
  const rows: UnifiedMemberRow[] = data
    ? [
        ...data.users.map((m) => ({
          key: `user-${m.id}`,
          type: 'user' as const,
          id: m.id,
          name: m.name,
          email: m.email,
          role: m.role,
          disabled: Boolean(m.disabled),
        })),
        ...data.invitations.map((inv) => ({
          key: `invite-${inv.email}`,
          type: 'invite' as const,
          name: inv.email.split('@')[0] || inv.email,
          email: inv.email,
          role: inv.role,
          expired: inv.expires_at <= Date.now(),
          expiresAt: inv.expires_at,
        })),
      ].sort((a, b) => {
        if (a.role === 'owner' && b.role !== 'owner') return -1;
        if (b.role === 'owner' && a.role !== 'owner') return 1;
        if (a.type !== b.type) return a.type === 'user' ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        hideTelemetryControls
        title="Accounts"
        subtitle="Manage applications and who can access this EdgeWatch installation."
      />

      {/* One-time generated ingest key banner for newly added application */}
      {createdKey && (
        <SettingsSection
          title={`Ingest token for ${createdKey.name}`}
          description="Shown once — add this to NIGHTWATCH_TOKEN in your application's .env file."
          action={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              shape="square"
              icon={<XIcon size={14} />}
              aria-label="Dismiss ingest token"
              onClick={() => setCreatedKey(null)}
            />
          }
        >
          <div className="flex flex-col gap-2 rounded-lg border border-emerald-200/80 bg-white p-3 sm:flex-row sm:items-center dark:border-emerald-900/60 dark:bg-white/[0.03]">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-white/[0.08] dark:bg-neutral-900">
              <KeyIcon size={14} className="shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              <input
                type="text"
                readOnly
                value={createdKey.key}
                onFocus={(e) => e.target.select()}
                aria-label="Ingest token"
                className="min-w-0 flex-1 bg-transparent font-mono text-xs text-neutral-800 outline-none dark:text-neutral-200"
              />
            </div>
            <Button
              type="button"
              variant="primary"
              size="sm"
              icon={copiedKey ? CheckIcon : CopyIcon}
              onClick={() => copyText(createdKey.key, 'Ingest token copied.', setCopiedKey)}
            >
              {copiedKey ? 'Copied' : 'Copy token'}
            </Button>
          </div>
        </SettingsSection>
      )}

      {/* Applications tray matching Nightwatch floating row geometry */}
      <SettingsSection
        title={`${projects.length} ${projects.length === 1 ? 'application' : 'applications'}`}
        description="Applications connected to this EdgeWatch installation."
        action={
          canManage ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              icon={PlusIcon}
              onClick={() => {
                setAppName('');
                setAppSlug('');
                setAppSlugTouched(false);
                setAddAppOpen(true);
              }}
            >
              Add application
            </Button>
          ) : undefined
        }
      >
        {projects.length === 0 ? (
          <SettingsRowGroup>
            <div className="px-4 py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
              No applications added yet. Add your first application to generate an ingest token.
            </div>
          </SettingsRowGroup>
        ) : (
          <div className="flex flex-col gap-1">
            {projects.map((app) => {
              const isSelected = app.id === projectId;
              const letter = (app.name || app.id).trim().charAt(0).toUpperCase();
              return (
                <div
                  key={app.id}
                  className="flex gap-1 max-md:flex-col max-md:gap-2 max-md:rounded-md max-md:border max-md:border-neutral-200 max-md:p-2 dark:max-md:border-white/10 dark:max-md:bg-neutral-800/75"
                >
                  {/* Left application identity card (`h-11` floating card) */}
                  <div className="flex h-11 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-white px-2.5 dark:border-white/[0.08] dark:bg-white/[0.03]">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span
                        className="grid size-6 shrink-0 place-items-center rounded-md border border-neutral-200/80 bg-neutral-100 text-[11px] font-semibold text-neutral-800 dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-200"
                        aria-hidden
                      >
                        {letter}
                      </span>
                      <span className="truncate text-sm font-medium text-neutral-900 dark:text-white">
                        {app.name}
                      </span>
                      <span className="hidden rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-600 sm:inline dark:bg-white/[0.07] dark:text-neutral-400">
                        {app.id}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 pr-1">
                      {isSelected && (
                        <span className="rounded bg-blue-50 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase text-blue-700 dark:bg-emerald-500/15 dark:text-emerald-400">
                          Active
                        </span>
                      )}
                      <span className="font-mono text-xs text-neutral-400">
                        {app.last_seen ? <TimeAgo iso={app.last_seen} /> : 'No data yet'}
                      </span>
                    </div>
                  </div>

                  {/* Right controls */}
                  <div className="flex shrink-0 items-center gap-1 max-md:justify-end">
                    <button
                      type="button"
                      onClick={() => openApplication(app)}
                      className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 text-sm text-neutral-700 transition-colors hover:border-blue-500 hover:text-neutral-900 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-neutral-300 dark:hover:border-white/15 dark:hover:text-white"
                    >
                      <span>{isSelected ? 'Dashboard' : 'Open'}</span>
                      <ArrowUpRightIcon size={13} aria-hidden />
                    </button>

                    {canManage && (
                      <ApplicationActionsMenu
                        project={app}
                        onOpenSettings={() => openApplicationSettings(app)}
                        onRename={() => {
                          setRenameTarget(app);
                          setRenameValue(app.name);
                        }}
                        onDelete={() => {
                          setDeleteTarget(app);
                          setDeleteConfirm('');
                        }}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>

      {/* Members & Access Control */}
      {!owner ? (
        <SettingsSection
          title="Members"
          description="Only the installation owner can invite teammates or modify account roles."
        >
          <SettingsRowGroup>
            <div className="flex items-center gap-3 px-4 py-5 text-sm text-neutral-600 dark:text-neutral-400">
              <LockSimpleIcon size={18} className="shrink-0 text-neutral-400" aria-hidden />
              <span>
                You are signed in as <strong className="font-medium text-neutral-900 dark:text-white">{user?.email ?? 'viewer'}</strong> ({user?.role ?? 'viewer'}). Ask the owner to update team access.
              </span>
            </div>
          </SettingsRowGroup>
        </SettingsSection>
      ) : (
        <div className="space-y-6">
          {/* One-time generated invitation link banner */}
          {link && (
            <SettingsSection
              title="Invitation link ready"
              description="Shown once — share this link directly with the invited teammate. No email is sent automatically."
              action={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  shape="square"
                  icon={<XIcon size={14} />}
                  aria-label="Dismiss invitation link"
                  onClick={() => setLink('')}
                />
              }
            >
              <div className="flex flex-col gap-2 rounded-lg border border-emerald-200/80 bg-white p-3 sm:flex-row sm:items-center dark:border-emerald-900/60 dark:bg-white/[0.03]">
                <input
                  type="text"
                  readOnly
                  value={link}
                  onFocus={(e) => e.target.select()}
                  aria-label="Invitation link"
                  className="h-9 min-w-0 flex-1 rounded-md border border-neutral-200 bg-neutral-50 px-3 font-mono text-xs text-neutral-800 outline-none dark:border-white/[0.08] dark:bg-neutral-900 dark:text-neutral-200"
                />
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  icon={copiedLink ? CheckIcon : CopyIcon}
                  onClick={() => copyText(link, 'Invitation link copied.', setCopiedLink)}
                >
                  {copiedLink ? 'Copied' : 'Copy link'}
                </Button>
              </div>
            </SettingsSection>
          )}

          {error ? (
            <ErrorState error={error} />
          ) : loading && !data ? (
            <SettingsSection title="Members">
              <SettingsRowGroup>
                <div className="p-4"><Loading rows={4} /></div>
              </SettingsRowGroup>
            </SettingsSection>
          ) : (
            <>
              {/* 1:1 Nightwatch `Edit-tQlumie6.js` Members tray with `+` button and dual-column floating rows */}
              <SettingsSection
                title={`${rows.length} ${rows.length === 1 ? 'member' : 'members'}`}
                description="Active installation accounts and pending invitations."
                action={
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    icon={PlusIcon}
                    onClick={() => setInviteOpen(true)}
                  >
                    Invite member
                  </Button>
                }
              >
                <div className="flex flex-col gap-1">
                  {rows.map((row) => {
                    const meta = ROLE_META[row.role] ?? ROLE_META.viewer;
                    const RoleIcon = meta.icon;
                    const isSelf = row.type === 'user' && user?.email === row.email;
                    const canDisable = row.type === 'user' && row.role !== 'owner' && !row.disabled;
                    const canRevoke = row.type === 'invite';

                    return (
                      <div
                        key={row.key}
                        className="flex gap-1 max-md:flex-col max-md:gap-2 max-md:rounded-md max-md:border max-md:border-neutral-200 max-md:p-2 dark:max-md:border-white/10 dark:max-md:bg-neutral-800/75"
                      >
                        {/* Left identity pill (exact `h-11` Nightwatch member card) */}
                        <div
                          className={cn(
                            'flex h-11 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-white px-2.5 dark:border-white/[0.08] dark:bg-white/[0.03]',
                            row.disabled && 'opacity-65',
                          )}
                        >
                          <div className="flex min-w-0 items-center gap-2.5">
                            <MemberAvatar name={row.name} muted={row.disabled || row.type === 'invite'} />
                            <div className="shrink-0 text-sm font-medium text-neutral-900 dark:text-white">
                              {row.type === 'invite' ? row.email : row.name}
                            </div>
                            {row.type === 'user' && (
                              <div className="truncate text-sm text-neutral-500 dark:text-neutral-400">
                                {row.email}
                              </div>
                            )}
                          </div>

                          <div className="flex shrink-0 items-center gap-2 pr-1">
                            {isSelf && (
                              <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[10px] uppercase text-neutral-600 dark:bg-white/10 dark:text-neutral-300">
                                You
                              </span>
                            )}
                            {row.disabled && (
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-neutral-400">
                                <ProhibitIcon size={13} aria-hidden />
                                <span>Disabled</span>
                              </span>
                            )}
                            {row.type === 'invite' && (
                              <span
                                className={cn(
                                  'inline-flex items-center gap-1 text-xs font-medium',
                                  row.expired ? 'text-amber-600 dark:text-amber-400' : 'text-neutral-400',
                                )}
                                title={
                                  row.expiresAt
                                    ? row.expired
                                      ? 'Invitation expired'
                                      : `Expires ${new Date(row.expiresAt).toLocaleString()}`
                                    : undefined
                                }
                              >
                                {row.expired ? (
                                  <>
                                    <ClockIcon size={13} aria-hidden />
                                    <span>Expired</span>
                                  </>
                                ) : (
                                  <>
                                    <EnvelopeSimpleIcon size={13} aria-hidden />
                                    <span>Invite sent</span>
                                  </>
                                )}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Right role + action menu (exact `w-1/2 gap-1` Nightwatch geometry) */}
                        <div className="flex w-1/2 shrink-0 gap-1 max-md:w-full">
                          <div className="flex h-11 w-full items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-white px-3 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]">
                            <span className="inline-flex items-center gap-2 font-medium text-neutral-900 dark:text-neutral-100">
                              <RoleIcon size={14} className="shrink-0 text-neutral-500 dark:text-neutral-400" aria-hidden />
                              <span>{meta.label}</span>
                            </span>
                            <span className="hidden truncate text-xs text-neutral-400 xl:inline">
                              {meta.description}
                            </span>
                          </div>

                          {canDisable && row.id && (
                            <RowActionsMenu
                              label={`Manage ${row.email}`}
                              actionText="Disable account"
                              icon={ProhibitIcon}
                              onAction={() =>
                                setConfirmation({
                                  path: 'manage/disable',
                                  body: { id: row.id },
                                  title: 'Disable account',
                                  label: `Disable access for ${row.email}? All active sessions will end immediately.`,
                                  actionLabel: 'Disable account',
                                })
                              }
                            />
                          )}
                          {canRevoke && (
                            <RowActionsMenu
                              label={`Manage invitation for ${row.email}`}
                              actionText="Revoke invitation"
                              icon={TrashIcon}
                              onAction={() =>
                                setConfirmation({
                                  path: 'manage/revoke-invitation',
                                  body: { email: row.email },
                                  title: 'Revoke invitation',
                                  label: `Revoke the pending invitation for ${row.email}? The invite link will immediately stop working.`,
                                  actionLabel: 'Revoke invitation',
                                })
                              }
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </SettingsSection>

              {/* Roles reference card using Nightwatch SettingsRowGroup */}
              <SettingsSection
                title="Roles & permissions"
                description="Access levels available for EdgeWatch accounts."
              >
                <SettingsRowGroup>
                  {(['owner', 'admin', 'viewer'] as const).map((key) => {
                    const meta = ROLE_META[key];
                    const Icon = meta.icon;
                    return (
                      <SettingsRow key={key} title={meta.label} description={meta.description}>
                        <span className="inline-flex items-center gap-1.5 font-mono text-xs uppercase text-neutral-500 dark:text-neutral-400">
                          <Icon size={14} aria-hidden />
                          <span>{key}</span>
                        </span>
                      </SettingsRow>
                    );
                  })}
                </SettingsRowGroup>
              </SettingsSection>
            </>
          )}
        </div>
      )}

      {/* Add Application Modal */}
      <Dialog.Root open={addAppOpen} onOpenChange={(open) => { if (!busy) setAddAppOpen(open); }}>
        <Dialog className="space-y-6 p-6 sm:max-w-md sm:p-7">
          <div className="space-y-1">
            <Dialog.Title className="text-lg font-semibold text-neutral-900 dark:text-white">
              Add application
            </Dialog.Title>
            <Dialog.Description className="text-sm text-neutral-500 dark:text-neutral-400">
              Register a new Laravel application and generate an initial ingest token.
            </Dialog.Description>
          </div>

          <form onSubmit={handleCreateApp} className="space-y-5">
            <Input
              label="Application name"
              type="text"
              required
              maxLength={100}
              placeholder="Acme Storefront"
              value={appName}
              onChange={(event) => {
                const next = event.target.value;
                setAppName(next);
                if (!appSlugTouched) setAppSlug(slugifyProjectId(next));
              }}
              className="h-11"
            />

            <Input
              label="Application ID"
              type="text"
              required
              maxLength={64}
              placeholder="acme-storefront"
              description="Unique slug used in API routes and ingest tokens."
              value={appSlug}
              onChange={(event) => {
                setAppSlugTouched(true);
                setAppSlug(event.target.value);
              }}
              className="h-11 font-mono text-sm"
            />

            <div className="flex justify-end gap-2.5 pt-1">
              <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => setAddAppOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm" loading={busy} disabled={busy || !appName.trim() || !appSlug.trim()}>
                Create application
              </Button>
            </div>
          </form>
        </Dialog>
      </Dialog.Root>

      {/* Rename Application Modal */}
      <Dialog.Root open={renameTarget !== null} onOpenChange={(open) => { if (!open && !busy) setRenameTarget(null); }}>
        <Dialog className="space-y-6 p-6 sm:max-w-md sm:p-7">
          <div className="space-y-1">
            <Dialog.Title className="text-lg font-semibold text-neutral-900 dark:text-white">
              Rename application
            </Dialog.Title>
            <Dialog.Description className="text-sm text-neutral-500 dark:text-neutral-400">
              Update the display name for <span className="font-mono">{renameTarget?.id}</span>.
            </Dialog.Description>
          </div>

          <form onSubmit={handleRenameApp} className="space-y-5">
            <Input
              label="Application name"
              type="text"
              required
              maxLength={100}
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              className="h-11"
            />
            <div className="flex justify-end gap-2.5 pt-1">
              <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => setRenameTarget(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm" loading={busy} disabled={busy || !renameValue.trim()}>
                Save name
              </Button>
            </div>
          </form>
        </Dialog>
      </Dialog.Root>

      {/* Delete Application Modal (type-to-confirm) */}
      <Dialog.Root open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !busy) setDeleteTarget(null); }}>
        <Dialog className="space-y-5 p-6 sm:max-w-md sm:p-7">
          <div className="flex items-start gap-3">
            <WarningIcon size={20} className="mt-0.5 shrink-0 text-rose-500" aria-hidden />
            <div className="space-y-1.5">
              <Dialog.Title className="text-lg font-semibold text-neutral-900 dark:text-white">
                Delete {deleteTarget?.name}
              </Dialog.Title>
              <Dialog.Description className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                This permanently deletes the application, its configured environments, and all indexed telemetry rows for{' '}
                <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-xs text-neutral-900 dark:bg-white/10 dark:text-white">
                  {deleteTarget?.id}
                </code>
                .
              </Dialog.Description>
            </div>
          </div>

          <Input
            label={`Type "${deleteTarget?.id ?? ''}" to confirm`}
            type="text"
            placeholder={deleteTarget?.id ?? ''}
            value={deleteConfirm}
            onChange={(event) => setDeleteConfirm(event.target.value)}
            className="h-10 font-mono text-sm"
          />

          <div className="flex justify-end gap-2.5 pt-1">
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy || deleteConfirm.trim() !== deleteTarget?.id}
              loading={busy}
              onClick={() => void handleDeleteApp()}
            >
              Delete application
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>

      {/* Invite Member Modal matching Nightwatch `Edit-tQlumie6.js` Dialog */}
      <Dialog.Root open={inviteOpen} onOpenChange={(open) => { if (!busy) setInviteOpen(open); }}>
        <Dialog className="space-y-6 p-6 sm:max-w-md sm:p-7">
          <div className="space-y-1">
            <Dialog.Title className="text-lg font-semibold text-neutral-900 dark:text-white">
              Invite member
            </Dialog.Title>
            <Dialog.Description className="text-sm text-neutral-500 dark:text-neutral-400">
              Generate a one-time invitation link valid for 7 days.
            </Dialog.Description>
          </div>

          <form onSubmit={invite} className="space-y-5">
            <Input
              label="Email address"
              type="email"
              required
              maxLength={254}
              placeholder="teammate@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-11"
            />

            <div className="space-y-2">
              <div className="text-sm font-medium text-neutral-900 dark:text-neutral-200">Role</div>
              <div className="grid grid-cols-1 gap-2">
                {(['viewer', 'admin'] as const).map((option) => {
                  const meta = ROLE_META[option];
                  const Icon = meta.icon;
                  const active = role === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setRole(option)}
                      className={cn(
                        'flex items-start justify-between gap-3 rounded-lg border p-3 text-left transition-colors',
                        active
                          ? 'border-blue-600 bg-blue-50/60 dark:border-blue-500 dark:bg-blue-950/40'
                          : 'border-neutral-200 bg-white hover:border-neutral-300 dark:border-white/[0.08] dark:bg-white/[0.02] dark:hover:border-white/15',
                      )}
                    >
                      <div className="flex items-start gap-2.5">
                        <Icon
                          size={16}
                          className={cn('mt-0.5 shrink-0', active ? 'text-blue-600 dark:text-blue-400' : 'text-neutral-400')}
                          aria-hidden
                        />
                        <div className="space-y-0.5">
                          <div className="text-sm font-medium text-neutral-900 dark:text-white">{meta.label}</div>
                          <div className="text-xs text-neutral-500 dark:text-neutral-400">{meta.description}</div>
                        </div>
                      </div>
                      {active && <CheckIcon size={15} className="mt-0.5 shrink-0 text-blue-600 dark:text-blue-400" aria-hidden />}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex justify-end gap-2.5 pt-1">
              <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => setInviteOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm" loading={busy} disabled={busy || !email.trim()}>
                Create invitation
              </Button>
            </div>
          </form>
        </Dialog>
      </Dialog.Root>

      {/* Confirm Access Change Modal */}
      <Dialog.Root open={confirmation !== null} onOpenChange={(open) => { if (!open && !busy) setConfirmation(null); }}>
        <Dialog className="space-y-5 p-6 sm:max-w-md sm:p-7">
          <div className="flex items-start gap-3">
            <WarningIcon size={20} className="mt-0.5 shrink-0 text-rose-500" aria-hidden />
            <div className="space-y-1.5">
              <Dialog.Title className="text-lg font-semibold text-neutral-900 dark:text-white">
                {confirmation?.title ?? 'Confirm access change'}
              </Dialog.Title>
              <Dialog.Description className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                {confirmation?.label}
              </Dialog.Description>
            </div>
          </div>
          <div className="flex justify-end gap-2.5 pt-1">
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirmation(null)}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" disabled={busy} loading={busy} onClick={confirm}>
              {confirmation?.actionLabel ?? 'Confirm'}
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  );
}
