import { useEnvironment } from '@/lib/environment';
import { Link, type LinkProps } from 'react-router-dom';
import { useProject } from '@/lib/project';
import { useRange } from '@/lib/range';

export function scopedSearch(search: string, project: string, range: string, environment?: string): string {
  const params = new URLSearchParams(search);
  params.set('project', project); params.set('range', range);
  if (environment !== undefined) params.set('environment', environment); else params.delete('environment');
  return `?${params}`;
}

export function scopedPath(path: string, project: string, range: string, environment?: string): string {
  const url = new URL(path, 'https://edgewatch.invalid');
  url.search = scopedSearch(url.search, project, range, environment);
  return `${url.pathname}${url.search}${url.hash}`;
}

export default function ScopedLink({ to, ...props }: LinkProps) {
  const { projectId } = useProject();
  const { range } = useRange();
  const { environment } = useEnvironment();
  return <Link {...props} to={typeof to === 'string' ? scopedPath(to, projectId, range, environment) : { ...to, search: scopedSearch(to.search ?? '', projectId, range, environment) }} />;
}
