import { Button } from '@cloudflare/kumo/components/button';
import { cn } from '@cloudflare/kumo/utils';
import { PlusIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

/** 1:1 Nightwatch `Card-Bs8QNqhz.js` (`p` + `g`) Settings section tray with optional `+` or custom header action. */
export function SettingsSection({
  title,
  description,
  onAdd,
  addLabel = 'Add',
  action,
  className,
  children,
}: {
  title: string;
  description?: string;
  onAdd?: () => void;
  addLabel?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-slot="card-container"
      className={cn(
        'rounded-xl border border-neutral-200/70 bg-white/50 p-1.5 dark:border-white/5 dark:bg-white/[0.03]',
        className,
      )}
    >
      <div className="flex items-center justify-between pt-2 pr-2 pb-4 pl-3.5">
        <div className="flex flex-col">
          <div className="flex flex-row items-center space-x-2">
            <h3 className="text-lg font-semibold text-neutral-900 dark:text-white">{title}</h3>
          </div>
          {description && (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">{description}</p>
          )}
        </div>
        {action ??
          (onAdd && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              shape="square"
              icon={<PlusIcon size={15} />}
              aria-label={addLabel}
              onClick={onAdd}
            />
          ))}
      </div>
      {children}
    </div>
  );
}

/** 1:1 Nightwatch `SettingsRow-B-GE3UOk.js` (`r`) white/dark divided card for setting rows. */
export function SettingsRowGroup({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white shadow-md shadow-black/5 dark:divide-white/[0.08] dark:border-white/[0.08] dark:bg-white/[0.03]',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** 1:1 Nightwatch `SettingsRow-B-GE3UOk.js` (`i`) horizontal label/description + right-aligned control row. */
export function SettingsRow({
  title,
  description,
  footer,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-3 py-3 pr-2.5 pl-4', className)}>
      <div className="flex flex-col justify-between gap-3 md:min-h-9 md:flex-row md:items-center md:gap-4">
        <div className="space-y-1">
          <h4 className="text-sm leading-tight font-medium text-neutral-900 dark:text-white">{title}</h4>
          {description && (
            <p className="text-xs font-light text-pretty text-neutral-600 md:leading-snug dark:text-neutral-400">
              {description}
            </p>
          )}
        </div>
        <div className="flex grow items-center md:max-w-[50%] md:justify-end md:text-right">{children}</div>
      </div>
      {footer && (
        <div className="flex justify-end">
          <div className="w-full md:w-1/2">{footer}</div>
        </div>
      )}
    </div>
  );
}

/** 1:1 Nightwatch `Tabs-BrRBw4o6.js` underline tab strip for Settings sub-views. */
export function SettingsTabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (next: T) => void;
  tabs: { value: T; label: string }[];
}) {
  return (
    <div className="flex gap-5 border-b border-neutral-200 dark:border-neutral-800" role="tablist">
      {tabs.map((tab) => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.value)}
            className={cn(
              'cursor-pointer border-b-2 px-1 py-3.5 text-sm whitespace-nowrap transition-colors',
              active
                ? 'border-blue-600 font-medium text-neutral-900 dark:border-white dark:text-white'
                : 'border-transparent text-neutral-500 hover:border-neutral-400 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white',
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
