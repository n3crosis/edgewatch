import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchApi } from './auth';
import { API_URL, USING_MOCK } from './config';
import { MOCK_PROJECTS, setMockProject } from './mock';

export interface ProjectInfo {
  id: string;
  name: string;
  host?: string;
  last_seen?: string | null;
  daily_record_quota?: number | null;
  retention_days?: number | null;
}

const DEFAULT_PROJECT = (import.meta.env.VITE_PROJECT_ID as string | undefined) || (USING_MOCK ? MOCK_PROJECTS[0].id : 'demo');
const STORAGE_KEY = 'edgewatch.project';

/** Module-level copy so the data layer (api.ts / mock.ts) always reads the project the UI has selected. */
let current = DEFAULT_PROJECT;
try { current = globalThis.localStorage?.getItem(STORAGE_KEY) || DEFAULT_PROJECT; } catch { /* Use the configured default. */ }
setMockProject(current);
export const activeProjectId = () => current;

interface ProjectState {
  projectId: string;
  projects: ProjectInfo[];
  setProjectId: (id: string) => void;
  refreshProjects: () => void;
}
const ProjectContext = createContext<ProjectState>({
  projectId: current,
  projects: [],
  setProjectId: () => {},
  refreshProjects: () => {},
});

async function loadProjects(): Promise<ProjectInfo[]> {
  if (USING_MOCK) return MOCK_PROJECTS.map(({ id, name, host }) => ({ id, name, host }));
  try {
    const res = await fetchApi(`${API_URL}/v1/projects`);
    if (!res.ok) throw new Error(String(res.status));
    return ((await res.json()) as { data: ProjectInfo[] }).data;
  } catch {
    return [{ id: DEFAULT_PROJECT, name: DEFAULT_PROJECT }];
  }
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const [fallbackProject, setState] = useState(current);
  const explicitProject = params.get('project');
  const projectId = explicitProject || fallbackProject;
  current = projectId;
  setMockProject(projectId);
  useEffect(() => { if (explicitProject) setState(explicitProject); }, [explicitProject]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [reloadTick, setReloadTick] = useState(0);
  const refreshProjects = () => setReloadTick((n) => n + 1);

  const setProjectId = (id: string) => {
    current = id;
    setMockProject(id);
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* Storage can be unavailable in private browsing. */ }
    setParams((previous) => { const next = new URLSearchParams(previous); next.set('project', id); next.delete('cursor'); next.delete('offset'); return next; });
    setState(id);
  };

  useEffect(() => {
    let cancelled = false;
    void loadProjects().then((list) => {
      if (cancelled) return;
      setProjects(list);
      if (!explicitProject && list.length && !list.some((p) => p.id === current)) setProjectId(list[0].id);
    });
    return () => { cancelled = true; };
  }, [explicitProject, reloadTick]);

  return <ProjectContext.Provider value={{ projectId, projects, setProjectId, refreshProjects }}>{children}</ProjectContext.Provider>;
}

export const useProject = () => useContext(ProjectContext);
