import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, LinkButton } from '@cloudflare/kumo/components/button';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { Input } from '@cloudflare/kumo/components/input';
import { Popover } from '@cloudflare/kumo/components/popover';
import { Select } from '@cloudflare/kumo/components/select';
import { useKumoToastManager } from '@cloudflare/kumo/components/toast';
import { cn } from '@cloudflare/kumo/utils';
import {
  ArrowUpRightIcon,
  CheckIcon,
  DesktopIcon,
  DotsThreeVerticalIcon,
  GlobeIcon,
  MoonIcon,
  PencilSimpleIcon,
  PlusIcon,
  SunIcon,
  TrashIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import Link, { scopedPath } from '@/components/ScopedLink';
import { CopyButton, PageHeader, TimeAgo } from '@/components/common';
import { SettingsRow, SettingsRowGroup, SettingsSection, SettingsTabs } from '@/components/SettingsPrimitives';
import { api, USING_MOCK, useAsync } from '@/lib/api';
import { useSessionUser } from '@/lib/auth';
import { defaultEnvColor, ENV_COLOR_OPTIONS, envDotClass, useEnvironment } from '@/lib/environment';
import { compact } from '@/lib/format';
import { useProject } from '@/lib/project';
import { useRange } from '@/lib/range';
import { useTheme, type ThemePreference } from '@/lib/theme';
import type { EnvironmentColor, EnvironmentInfo } from '@/lib/types';

type SettingsTab = 'general' | 'environments' | 'preferences';

const SAMPLE_KEYS = [
  { name: 'Owner ingest (all projects)', key: 'ew_live_owner_7f3a8d1c2e9b4f0a', scope: 'ingest' },
  { name: 'Dashboard (read, all projects)', key: 'ew_read_owner_c91e4b2a7d0f6e3c', scope: 'read' },
];

function CopyField({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-neutral-50/70 pr-1.5 pl-3 font-mono text-xs text-neutral-800 dark:border-white/[0.08] dark:bg-neutral-900/70 dark:text-neutral-200">
      <span className="min-w-0 truncate">{value}</span>
      <CopyButton text={value} label={label} className="shrink-0" />
    </div>
  );
}

function CodeBlock({ code, label }: { code: string; label: string }) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50/80 dark:border-white/[0.08] dark:bg-neutral-900/80">
      <pre className="overflow-x-auto p-4 pr-12 font-mono text-xs leading-6 text-neutral-800 dark:text-neutral-200">
        {code}
      </pre>
      <CopyButton text={code} label={label} className="absolute top-2.5 right-2.5" />
    </div>
  );
}

/** 1:1 Nightwatch `ColorSelector` dot palette. */
function ColorSelector({
  value,
  onChange,
}: {
  value: EnvironmentColor;
  onChange: (next: EnvironmentColor) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Environment color">
      {ENV_COLOR_OPTIONS.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.label}
            title={option.label}
            onClick={() => onChange(option.value)}
            className={cn(
              'grid size-7 place-items-center rounded-full border transition-all',
              selected
                ? 'border-neutral-900 ring-2 ring-neutral-900/20 dark:border-white dark:ring-white/25'
                : 'border-transparent hover:border-neutral-300 dark:hover:border-white/20',
            )}
          >
            <span className={cn('size-4 rounded-full', option.dotClass)} aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

function EnvColorPopover({
  item,
  index,
  disabled,
  onSelectColor,
}: {
  item: EnvironmentInfo;
  index: number;
  disabled: boolean;
  onSelectColor: (color: EnvironmentColor) => void;
}) {
  const [open, setOpen] = useState(false);
  const dotClass = envDotClass(item.name, item.color, index);
  const activeColor = (item.color as EnvironmentColor | null) ?? defaultEnvColor(item.name, index);

  if (disabled) {
    return <span className={cn('size-2.5 shrink-0 rounded-full', dotClass)} aria-hidden />;
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            aria-label={`Change color for ${item.name}`}
            title="Change color"
            className="grid size-7 shrink-0 place-items-center rounded-md border border-transparent transition-colors hover:border-neutral-200 hover:bg-neutral-50 dark:hover:border-white/10 dark:hover:bg-white/[0.04]"
          >
            <span className={cn('size-2.5 rounded-full', dotClass)} aria-hidden />
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4}>
          <Popover.Popup className="rounded-md border border-neutral-800 bg-neutral-900 p-2.5 text-white shadow-2xl shadow-black/50 dark:border-neutral-700/50 dark:bg-neutral-800">
            <ColorSelector
              value={activeColor}
              onChange={(color) => {
                setOpen(false);
                onSelectColor(color);
              }}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function EnvironmentActionsMenu({
  item,
  onEdit,
  onDelete,
}: {
  item: EnvironmentInfo;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            aria-label={`Manage ${item.name} environment`}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-500 transition-colors hover:border-neutral-300 hover:bg-neutral-50 hover:text-neutral-900 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
          >
            <DotsThreeVerticalIcon size={15} weight="bold" aria-hidden />
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4}>
          <Popover.Popup className="w-44 rounded-md border border-neutral-800 bg-neutral-900 p-1 text-white shadow-2xl shadow-black/50 dark:border-neutral-700/50 dark:bg-neutral-800">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onEdit();
              }}
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-neutral-200 transition-colors hover:bg-neutral-800 hover:text-white dark:hover:bg-neutral-700/70"
            >
              <PencilSimpleIcon size={14} className="shrink-0 text-neutral-400" aria-hidden />
              <span>Edit environment</span>
            </button>
            <div className="my-1 border-t border-neutral-800 dark:border-neutral-700/50" />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-rose-400 transition-colors hover:bg-rose-950/60 hover:text-rose-300"
            >
              <TrashIcon size={14} className="shrink-0" aria-hidden />
              <span>Delete</span>
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export default function SetupPage() {
  const { projectId, projects, refreshProjects } = useProject();
  const { range } = useRange();
  const { environment, setEnvironment, envRevision, refreshEnvironments } = useEnvironment();
  const user = useSessionUser();
  const { preference, setPreference } = useTheme();
  const toasts = useKumoToastManager();
  const [params, setParams] = useSearchParams();

  const rawTab = params.get('tab');
  const activeTab: SettingsTab =
    rawTab === 'environments' || rawTab === 'preferences' ? rawTab : 'general';
  const setTab = (next: SettingsTab) =>
    setParams((prev) => {
      const copy = new URLSearchParams(prev);
      if (next === 'general') copy.delete('tab');
      else copy.set('tab', next);
      return copy;
    });

  const activeProject = projects.find((p) => p.id === projectId);
  const projectName = activeProject?.name ?? projectId;

  const permissions = useAsync(() => api.permissions(), []);
  const environments = useAsync(() => api.environments(), [envRevision], { keepPreviousData: true });
  const canManage = Boolean(permissions.data?.can_manage);

  // General settings state
  const [nameInput, setNameInput] = useState(projectName);
  const [quotaInput, setQuotaInput] = useState('');
  const [retentionInput, setRetentionInput] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);

  // Environment CRUD modal state
  const [addEnvOpen, setAddEnvOpen] = useState(false);
  const [newEnvName, setNewEnvName] = useState('');
  const [newEnvColor, setNewEnvColor] = useState<EnvironmentColor>('emerald');
  const [newEnvUrl, setNewEnvUrl] = useState('');
  const [editEnvTarget, setEditEnvTarget] = useState<EnvironmentInfo | null>(null);
  const [editEnvColor, setEditEnvColor] = useState<EnvironmentColor>('blue');
  const [editEnvUrl, setEditEnvUrl] = useState('');
  const [deleteEnvTarget, setDeleteEnvTarget] = useState<EnvironmentInfo | null>(null);
  const [envBusy, setEnvBusy] = useState(false);

  useEffect(() => {
    setNameInput(activeProject?.name ?? projectId);
    setQuotaInput(
      activeProject?.daily_record_quota !== undefined && activeProject?.daily_record_quota !== null
        ? String(activeProject.daily_record_quota)
        : '',
    );
    setRetentionInput(
      activeProject?.retention_days !== undefined && activeProject?.retention_days !== null
        ? String(activeProject.retention_days)
        : '',
    );
  }, [activeProject?.id, activeProject?.name, activeProject?.daily_record_quota, activeProject?.retention_days, projectId]);

  const parsedQuota = quotaInput.trim() === '' ? null : Number(quotaInput.trim());
  const parsedRetention = retentionInput.trim() === '' ? null : Number(retentionInput.trim());
  const nameDirty = nameInput.trim() !== projectName;
  const quotaOrRetentionDirty =
    parsedQuota !== (activeProject?.daily_record_quota ?? null) ||
    parsedRetention !== (activeProject?.retention_days ?? null);
  const settingsValid =
    Boolean(nameInput.trim()) &&
    (parsedQuota === null || (Number.isSafeInteger(parsedQuota) && parsedQuota >= 0)) &&
    (parsedRetention === null || (Number.isSafeInteger(parsedRetention) && parsedRetention >= 0));
  const settingsDirty = nameDirty || quotaOrRetentionDirty;

  async function saveProjectSettings() {
    if (!canManage || !settingsValid || !settingsDirty || savingSettings) return;
    setSavingSettings(true);
    try {
      if (nameDirty) {
        await api.renameProject(projectId, nameInput.trim());
      }
      if (quotaOrRetentionDirty) {
        await api.updateProjectSettings({
          daily_record_quota: parsedQuota,
          retention_days: parsedRetention,
        });
      }
      refreshProjects();
      toasts.add({ variant: 'success', title: 'Application settings saved.' });
    } catch (err) {
      toasts.add({
        variant: 'error',
        title: err instanceof Error ? err.message : 'Could not save settings.',
      });
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleAddEnvironment(event: FormEvent) {
    event.preventDefault();
    if (envBusy || !newEnvName.trim()) return;
    setEnvBusy(true);
    try {
      const created = await api.createEnvironment({
        name: newEnvName.trim(),
        color: newEnvColor,
        url: newEnvUrl.trim() || null,
      });
      setAddEnvOpen(false);
      setNewEnvName('');
      setNewEnvUrl('');
      refreshEnvironments();
      toasts.add({ variant: 'success', title: `Environment "${created.name}" added.` });
    } catch (err) {
      toasts.add({
        variant: 'error',
        title: err instanceof Error ? err.message : 'Could not add environment.',
      });
    } finally {
      setEnvBusy(false);
    }
  }

  async function handleUpdateEnvironment(event: FormEvent) {
    event.preventDefault();
    if (envBusy || !editEnvTarget) return;
    setEnvBusy(true);
    try {
      await api.updateEnvironment(editEnvTarget.name, {
        color: editEnvColor,
        url: editEnvUrl.trim() || null,
      });
      setEditEnvTarget(null);
      refreshEnvironments();
      toasts.add({ variant: 'success', title: 'Environment updated.' });
    } catch (err) {
      toasts.add({
        variant: 'error',
        title: err instanceof Error ? err.message : 'Could not update environment.',
      });
    } finally {
      setEnvBusy(false);
    }
  }

  async function handleQuickColorChange(item: EnvironmentInfo, color: EnvironmentColor) {
    try {
      await api.updateEnvironment(item.name, { color });
      refreshEnvironments();
      toasts.add({ variant: 'success', title: `Updated "${item.name}" color.` });
    } catch (err) {
      toasts.add({
        variant: 'error',
        title: err instanceof Error ? err.message : 'Could not update environment color.',
      });
    }
  }

  async function handleDeleteEnvironment() {
    if (envBusy || !deleteEnvTarget) return;
    setEnvBusy(true);
    try {
      const targetName = deleteEnvTarget.name;
      await api.deleteEnvironment(targetName);
      setDeleteEnvTarget(null);
      if (environment === targetName) setEnvironment(undefined);
      refreshEnvironments();
      toasts.add({ variant: 'success', title: `Environment "${targetName}" deleted.` });
    } catch (err) {
      toasts.add({
        variant: 'error',
        title: err instanceof Error ? err.message : 'Could not delete environment.',
      });
    } finally {
      setEnvBusy(false);
    }
  }

  const envList = environments.data ?? [];
  const envSnippet = `# .env (app and agent)
NIGHTWATCH_TOKEN=ew_live_${projectId}_••••••••

# agent only: replace with your EdgeWatch ingest worker URL
NIGHTWATCH_BASE_URL=https://ingest.edgewatch.dev`;

  return (
    <div className="space-y-4 md:space-y-6">
      {/* 1:1 Nightwatch Application Settings header + underline tabs (`General-xIm8QZi-.js` + `Tabs-BrRBw4o6.js`) */}
      <PageHeader
        hideTelemetryControls
        documentTitle={`Settings · ${projectName}`}
        title={projectName}
      />
      <SettingsTabs
        value={activeTab}
        onChange={setTab}
        tabs={[
          { value: 'general', label: 'General' },
          { value: 'environments', label: 'Environments & Agent' },
          { value: 'preferences', label: 'Preferences' },
        ]}
      />

      {activeTab === 'general' && (
        <div className="space-y-6">
          <SettingsSection
            title="General"
            description="Common settings for your application."
          >
            <SettingsRowGroup>
              <SettingsRow title="Application name" description="Displayed across the dashboard switcher">
                <div className="w-full md:max-w-xs">
                  <Input
                    type="text"
                    maxLength={100}
                    aria-label="Application name"
                    disabled={!canManage}
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    className="h-10 text-sm"
                  />
                </div>
              </SettingsRow>

              <SettingsRow title="Application ID" description="Unique project slug used in API routes and ingest tokens">
                <div className="w-full md:max-w-xs">
                  <CopyField value={projectId} label="Copy application ID" />
                </div>
              </SettingsRow>

              <SettingsRow title="Last telemetry received" description="Most recent trace recorded for this application">
                <span className="font-mono text-xs text-neutral-600 dark:text-neutral-400">
                  {activeProject?.last_seen ? <TimeAgo iso={activeProject.last_seen} /> : 'No data yet'}
                </span>
              </SettingsRow>

              <SettingsRow
                title="Daily record quota"
                description="Max ingested records per day (0 = unlimited, blank = worker default)"
              >
                <div className="w-full md:max-w-xs">
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    placeholder="Worker default"
                    aria-label="Daily record quota"
                    disabled={!canManage || USING_MOCK}
                    value={quotaInput}
                    onChange={(e) => setQuotaInput(e.target.value)}
                    className="h-10 font-mono text-sm"
                  />
                </div>
              </SettingsRow>

              <SettingsRow
                title="Retention period"
                description="Days to retain telemetry before pruning (0 = keep forever, blank = worker default)"
                footer={
                  canManage && settingsDirty ? (
                    <div className="flex items-center justify-end gap-2 pt-1">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={savingSettings}
                        onClick={() => {
                          setNameInput(projectName);
                          setQuotaInput(
                            activeProject?.daily_record_quota !== undefined && activeProject?.daily_record_quota !== null
                              ? String(activeProject.daily_record_quota)
                              : '',
                          );
                          setRetentionInput(
                            activeProject?.retention_days !== undefined && activeProject?.retention_days !== null
                              ? String(activeProject.retention_days)
                              : '',
                          );
                        }}
                      >
                        Reset
                      </Button>
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        disabled={!settingsValid || savingSettings}
                        loading={savingSettings}
                        onClick={() => void saveProjectSettings()}
                      >
                        Save changes
                      </Button>
                    </div>
                  ) : undefined
                }
              >
                <div className="w-full md:max-w-xs">
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    placeholder="Worker default"
                    aria-label="Retention period in days"
                    disabled={!canManage || USING_MOCK}
                    value={retentionInput}
                    onChange={(e) => setRetentionInput(e.target.value)}
                    className="h-10 font-mono text-sm"
                  />
                </div>
              </SettingsRow>
            </SettingsRowGroup>
          </SettingsSection>

          <SettingsSection
            title="API keys"
            description="Authenticate telemetry sent from your applications."
          >
            {USING_MOCK ? (
              <div className="flex flex-col gap-1.5 px-1.5 pb-1.5">
                {SAMPLE_KEYS.map((item) => (
                  <div
                    key={item.key}
                    className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-3 shadow-2xs md:flex-row md:items-center md:justify-between dark:border-white/[0.08] dark:bg-white/[0.03]"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-neutral-900 dark:text-white">{item.name}</span>
                        <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[10px] uppercase text-neutral-600 dark:bg-white/10 dark:text-neutral-300">
                          {item.scope}
                        </span>
                      </div>
                    </div>
                    <div className="w-full md:w-80">
                      <CopyField value={item.key} label={`Copy ${item.name}`} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <SettingsRowGroup>
                <SettingsRow
                  title="Manage ingest keys"
                  description="List or mint scoped ingest keys from your terminal"
                >
                  <div className="w-full">
                    <CopyField
                      value="bun run --filter @edgewatch/ingest keys list --remote"
                      label="Copy CLI command"
                    />
                  </div>
                </SettingsRow>
                <SettingsRow
                  title="Dashboard access"
                  description="Manage applications, teammates, and account roles"
                >
                  <Link
                    to="/accounts"
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-700 transition-colors hover:border-blue-500 hover:text-neutral-900 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-neutral-300 dark:hover:border-white/15 dark:hover:text-white"
                  >
                    <span>Manage accounts</span>
                    <ArrowUpRightIcon size={13} aria-hidden />
                  </Link>
                </SettingsRow>
              </SettingsRowGroup>
            )}
          </SettingsSection>
        </div>
      )}

      {activeTab === 'environments' && (
        <div className="space-y-6">
          {/* 1:1 Nightwatch `Environments-GekIxGuJ.js` & `EnvironmentItem-Yk2VdqJ5.js` */}
          <SettingsSection
            title={`${envList.length} ${envList.length === 1 ? 'environment' : 'environments'}`}
            description="Configure environments for this application. Added and telemetry-discovered environments appear in the sidebar switcher."
            action={
              canManage ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  icon={PlusIcon}
                  onClick={() => {
                    setNewEnvName('');
                    setNewEnvColor('emerald');
                    setNewEnvUrl('');
                    setAddEnvOpen(true);
                  }}
                >
                  Add environment
                </Button>
              ) : undefined
            }
          >
            {envList.length === 0 ? (
              <SettingsRowGroup>
                <div className="px-4 py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
                  No environments configured or reported yet. Add an environment above or start the agent below.
                </div>
              </SettingsRowGroup>
            ) : (
              <div className="flex flex-col gap-1.5 px-1.5 pb-1.5">
                {envList.map((item, idx) => {
                  const isActive = environment === item.name;
                  return (
                    <div
                      key={item.name}
                      className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 shadow-2xs sm:flex-row sm:items-center sm:justify-between dark:border-white/[0.08] dark:bg-white/[0.03]"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <EnvColorPopover
                          item={item}
                          index={idx}
                          disabled={!canManage}
                          onSelectColor={(color) => void handleQuickColorChange(item, color)}
                        />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-medium text-neutral-900 dark:text-white">
                              {item.name}
                            </span>
                            <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-neutral-500 dark:bg-white/[0.06] dark:text-neutral-400">
                              {item.traces > 0
                                ? `${compact(item.traces)} ${item.traces === 1 ? 'trace' : 'traces'}`
                                : 'No traces yet'}
                            </span>
                          </div>
                          {item.url && (
                            <a
                              href={item.url}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-0.5 inline-flex items-center gap-1 truncate font-mono text-xs text-neutral-500 hover:text-blue-600 dark:text-neutral-400 dark:hover:text-emerald-400"
                            >
                              <span className="truncate">{item.url}</span>
                              <ArrowUpRightIcon size={11} className="shrink-0" aria-hidden />
                            </a>
                          )}
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          type="button"
                          variant={isActive ? 'primary' : 'secondary'}
                          size="sm"
                          icon={isActive ? CheckIcon : undefined}
                          onClick={() => setEnvironment(isActive ? undefined : item.name)}
                        >
                          {isActive ? 'Selected' : 'Filter'}
                        </Button>

                        {canManage && (
                          <EnvironmentActionsMenu
                            item={item}
                            onEdit={() => {
                              setEditEnvTarget(item);
                              setEditEnvColor((item.color as EnvironmentColor | null) ?? defaultEnvColor(item.name, idx));
                              setEditEnvUrl(item.url ?? '');
                            }}
                            onDelete={() => setDeleteEnvTarget(item)}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </SettingsSection>

          <SettingsSection
            title="Agent setup"
            description="Point the official laravel/nightwatch agent at your EdgeWatch ingest endpoint."
          >
            <SettingsRowGroup>
              <div className="space-y-3 p-4">
                <div className="space-y-0.5">
                  <h4 className="text-sm font-medium text-neutral-900 dark:text-white">
                    1. Configure environment variables
                  </h4>
                  <p className="text-xs font-light text-neutral-600 dark:text-neutral-400">
                    Existing <code className="font-mono">NIGHTWATCH_*</code> sampling and filter settings stay unchanged.
                  </p>
                </div>
                <CodeBlock code={envSnippet} label="Copy .env configuration" />
              </div>

              <div className="space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <h4 className="text-sm font-medium text-neutral-900 dark:text-white">
                      2. Start the Nightwatch agent
                    </h4>
                    <p className="text-xs font-light text-neutral-600 dark:text-neutral-400">
                      Authenticates via <code className="font-mono">POST /api/agent-auth</code> and streams gzipped batches.
                    </p>
                  </div>
                  <LinkButton
                    href={scopedPath('/requests', projectId, range, environment)}
                    variant="secondary"
                    size="sm"
                    icon={GlobeIcon}
                  >
                    View requests
                  </LinkButton>
                </div>
                <CopyField value="php artisan nightwatch:agent" label="Copy artisan command" />
              </div>
            </SettingsRowGroup>
          </SettingsSection>
        </div>
      )}

      {activeTab === 'preferences' && (
        <div className="space-y-6">
          {/* 1:1 Nightwatch `Edit-BNPUMNNe.js` Profile + Preferences sections */}
          <SettingsSection
            title="Profile"
            description="Your signed-in EdgeWatch account information."
          >
            <SettingsRowGroup>
              <SettingsRow title="Full name">
                <span className="text-sm font-medium text-neutral-900 dark:text-white">
                  {user?.name ?? 'Demo User'}
                </span>
              </SettingsRow>
              <SettingsRow title="Email address">
                <span className="font-mono text-xs text-neutral-600 dark:text-neutral-400">
                  {user?.email ?? 'demo@edgewatch.dev'}
                </span>
              </SettingsRow>
              <SettingsRow title="Role">
                <span className="inline-flex h-6 items-center rounded-md bg-neutral-100 px-2 font-mono text-xs uppercase text-neutral-700 dark:bg-white/10 dark:text-neutral-200">
                  {user?.role ?? 'owner'}
                </span>
              </SettingsRow>
            </SettingsRowGroup>
          </SettingsSection>

          <SettingsSection
            title="Preferences"
            description="Customize your local dashboard experience."
          >
            <SettingsRowGroup>
              <SettingsRow title="Theme" description="Choose your preferred color scheme">
                <div className="w-40">
                  <Select
                    aria-label="Theme"
                    value={preference}
                    onValueChange={(value) => setPreference(value as ThemePreference)}
                  >
                    <Select.Option value="light">
                      <span className="inline-flex items-center gap-2">
                        <SunIcon size={14} aria-hidden />
                        <span>Light</span>
                      </span>
                    </Select.Option>
                    <Select.Option value="dark">
                      <span className="inline-flex items-center gap-2">
                        <MoonIcon size={14} aria-hidden />
                        <span>Dark</span>
                      </span>
                    </Select.Option>
                    <Select.Option value="system">
                      <span className="inline-flex items-center gap-2">
                        <DesktopIcon size={14} aria-hidden />
                        <span>System</span>
                      </span>
                    </Select.Option>
                  </Select>
                </div>
              </SettingsRow>
            </SettingsRowGroup>
          </SettingsSection>
        </div>
      )}

      {/* Add Environment Modal (1:1 Nightwatch `Environments-GekIxGuJ.js`) */}
      <Dialog.Root open={addEnvOpen} onOpenChange={(open) => { if (!envBusy) setAddEnvOpen(open); }}>
        <Dialog className="space-y-6 p-6 sm:max-w-md sm:p-7">
          <div className="space-y-1">
            <Dialog.Title className="text-lg font-semibold text-neutral-900 dark:text-white">
              Add environment
            </Dialog.Title>
            <Dialog.Description className="text-sm text-neutral-500 dark:text-neutral-400">
              Create a new environment for {projectName} (for example, production, staging, or local).
            </Dialog.Description>
          </div>

          <form onSubmit={handleAddEnvironment} className="space-y-5">
            <Input
              label="Environment name"
              type="text"
              required
              maxLength={64}
              placeholder="staging"
              value={newEnvName}
              onChange={(event) => {
                const value = event.target.value;
                setNewEnvName(value);
                if (value.trim()) setNewEnvColor(defaultEnvColor(value));
              }}
              className="h-11"
            />

            <div className="space-y-2">
              <div className="text-sm font-medium text-neutral-900 dark:text-neutral-200">Color</div>
              <ColorSelector value={newEnvColor} onChange={setNewEnvColor} />
            </div>

            <Input
              label="Environment URL (optional)"
              type="url"
              maxLength={256}
              placeholder="https://staging.example.com"
              value={newEnvUrl}
              onChange={(event) => setNewEnvUrl(event.target.value)}
              className="h-11 font-mono text-sm"
            />

            <div className="flex justify-end gap-2.5 pt-1">
              <Button type="button" variant="secondary" size="sm" disabled={envBusy} onClick={() => setAddEnvOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm" loading={envBusy} disabled={envBusy || !newEnvName.trim()}>
                Add environment
              </Button>
            </div>
          </form>
        </Dialog>
      </Dialog.Root>

      {/* Edit Environment Modal */}
      <Dialog.Root open={editEnvTarget !== null} onOpenChange={(open) => { if (!open && !envBusy) setEditEnvTarget(null); }}>
        <Dialog className="space-y-6 p-6 sm:max-w-md sm:p-7">
          <div className="space-y-1">
            <Dialog.Title className="text-lg font-semibold text-neutral-900 dark:text-white">
              Edit {editEnvTarget?.name}
            </Dialog.Title>
            <Dialog.Description className="text-sm text-neutral-500 dark:text-neutral-400">
              Update the indicator color and optional URL for this environment.
            </Dialog.Description>
          </div>

          <form onSubmit={handleUpdateEnvironment} className="space-y-5">
            <div className="space-y-2">
              <div className="text-sm font-medium text-neutral-900 dark:text-neutral-200">Color</div>
              <ColorSelector value={editEnvColor} onChange={setEditEnvColor} />
            </div>

            <Input
              label="Environment URL (optional)"
              type="url"
              maxLength={256}
              placeholder="https://example.com"
              value={editEnvUrl}
              onChange={(event) => setEditEnvUrl(event.target.value)}
              className="h-11 font-mono text-sm"
            />

            <div className="flex justify-end gap-2.5 pt-1">
              <Button type="button" variant="secondary" size="sm" disabled={envBusy} onClick={() => setEditEnvTarget(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm" loading={envBusy} disabled={envBusy}>
                Save changes
              </Button>
            </div>
          </form>
        </Dialog>
      </Dialog.Root>

      {/* Delete Environment Confirmation Modal */}
      <Dialog.Root open={deleteEnvTarget !== null} onOpenChange={(open) => { if (!open && !envBusy) setDeleteEnvTarget(null); }}>
        <Dialog className="space-y-5 p-6 sm:max-w-md sm:p-7">
          <div className="flex items-start gap-3">
            <WarningIcon size={20} className="mt-0.5 shrink-0 text-rose-500" aria-hidden />
            <div className="space-y-1.5">
              <Dialog.Title className="text-lg font-semibold text-neutral-900 dark:text-white">
                Delete environment
              </Dialog.Title>
              <Dialog.Description className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                Remove <strong className="font-medium text-neutral-900 dark:text-white">{deleteEnvTarget?.name}</strong> from{' '}
                {projectName}? Existing traces remain available under All environments unless new telemetry arrives with this environment name.
              </Dialog.Description>
            </div>
          </div>
          <div className="flex justify-end gap-2.5 pt-1">
            <Button variant="secondary" size="sm" disabled={envBusy} onClick={() => setDeleteEnvTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={envBusy}
              loading={envBusy}
              onClick={() => void handleDeleteEnvironment()}
            >
              Delete environment
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  );
}
