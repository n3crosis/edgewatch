import { Badge } from '@cloudflare/kumo/components/badge';
import { Select } from '@cloudflare/kumo/components/select';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { WarningCircleIcon } from '@phosphor-icons/react';
import { useLocation } from 'react-router-dom';
import { api, useAsync } from '@/lib/api';
import { useEnvironment } from '@/lib/environment';
import { environmentScopedPath } from '@/lib/environment-scope';

export default function EnvironmentPicker() {
  const { environment, setEnvironment } = useEnvironment();
  const scoped = environmentScopedPath(useLocation().pathname);
  const { data, error } = useAsync(() => scoped ? api.environments() : Promise.resolve([]), [scoped]);

  if (!scoped) {
    return (
      <Tooltip asChild content="This page shows project-wide data across all environments.">
        <span className="inline-flex">
          <Badge variant="outline">Project-wide</Badge>
        </span>
      </Tooltip>
    );
  }

  const names = [...new Set([...(data ?? []).map((row) => row.name), ...(environment !== undefined ? [environment] : [])])].sort();
  return (
    <div className="flex items-center gap-2">
      <Select
        aria-label="Environment"
        size="sm"
        className="min-w-40"
        value={environment === undefined ? 'all' : `env:${environment}`}
        onValueChange={(value) => setEnvironment(value?.startsWith('env:') ? value.slice(4) : undefined)}
        items={[{ value: 'all', label: 'All environments' }, ...names.map((name) => ({ value: `env:${name}`, label: name }))]}
      />
      {error && (
        <Tooltip asChild content="Could not load environments.">
          <span role="alert" aria-label="Could not load environments" className="text-kumo-danger">
            <WarningCircleIcon size={16} />
          </span>
        </Tooltip>
      )}
    </div>
  );
}
