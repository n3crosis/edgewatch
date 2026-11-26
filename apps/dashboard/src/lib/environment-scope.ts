let selected: string | undefined;
export const activeEnvironment = () => selected;
export const setActiveEnvironment = (value: string | undefined) => { selected = value; };

/** Operational views and environment discovery are intentionally project-wide. */
export function environmentScopedPath(path: string): boolean {
  return path === '/' || /^\/(overview|requests|traces|exceptions|queries|log-entries|issues|jobs|commands|cache|outgoing-requests|mail|notifications|scheduled-tasks|logs|web-vitals|users)(?:\/|\?|$)/.test(path);
}

export function environmentParams(path: string, params: Record<string, string | undefined>, environment = selected) {
  return environmentScopedPath(path) ? { ...params, environment: params.environment ?? environment } : params;
}

export function selectEnvironment(params: URLSearchParams, environment: string | undefined) {
  const next = new URLSearchParams(params);
  if (environment !== undefined && environment !== '') next.set('environment', environment); else next.delete('environment');
  next.delete('cursor'); next.delete('offset');
  return next;
}
