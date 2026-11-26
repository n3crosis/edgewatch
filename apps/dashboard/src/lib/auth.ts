import { useSyncExternalStore } from 'react';
import { API_URL } from './config';

/**
 * The read key is never built into the bundle: the owner enters it once and it stays in this browser
 * (sessionStorage, or localStorage with "remember on this device"). A 401 from the API clears it.
 */
const STORAGE_KEY = 'edgewatch.read_key';
const listeners = new Set<() => void>();
let memory: string | null = null;
export interface SessionUser { id: string; email: string; name: string; role: 'owner' | 'admin' | 'viewer' }
export interface SessionStatus { setupRequired: boolean; setupTokenRequired: boolean }
const DEFAULT_STATUS: SessionStatus = { setupRequired: false, setupTokenRequired: false };
let user: SessionUser | null = null;
let status: SessionStatus = DEFAULT_STATUS;
export const sessionUser = () => user;
export const sessionStatus = () => status;
export const useSessionUser = () => useSyncExternalStore(onReadKeyChange, sessionUser, () => null);
export const useSessionStatus = () => useSyncExternalStore(onReadKeyChange, sessionStatus, () => DEFAULT_STATUS);
export function setSessionUser(value: SessionUser | null) {
  user = value;
  if (value) status = { ...status, setupRequired: false };
  forget();
  emit();
}

export async function accountRequest(path: string, body?: unknown, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(`${API_URL}/auth/${path}`, {
    credentials: 'include', method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Could not connect. Please try again.');
  return data;
}
export async function refreshSession() {
  const data = await accountRequest('session');
  status = {
    setupRequired: Boolean(data?.setup_required),
    setupTokenRequired: Boolean(data?.setup_token_required),
  };
  setSessionUser(data?.user ?? null);
}
export async function signOut() {
  await accountRequest('logout', {});
  setSessionUser(null);
}

const storage = (kind: 'sessionStorage' | 'localStorage'): Storage | undefined => {
  try {
    return globalThis[kind];
  } catch {
    return undefined;
  }
};
const emit = () => listeners.forEach((fn) => fn());

export function readKey(): string | null {
  return memory ?? storage('sessionStorage')?.getItem(STORAGE_KEY) ?? storage('localStorage')?.getItem(STORAGE_KEY) ?? null;
}

function forget() {
  memory = null;
  storage('sessionStorage')?.removeItem(STORAGE_KEY);
  storage('localStorage')?.removeItem(STORAGE_KEY);
}

export function saveReadKey(key: string, remember: boolean): void {
  forget();
  const target = storage(remember ? 'localStorage' : 'sessionStorage');
  if (target) target.setItem(STORAGE_KEY, key);
  else memory = key;
  emit();
}

export function clearReadKey(): void {
  forget();
  emit();
}

export function onReadKeyChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const useReadKey = () => useSyncExternalStore(onReadKeyChange, readKey, () => null);

export class UnauthorizedError extends Error {}

/** fetch with the stored read key; a 401 signs the dashboard out so the key prompt comes back. */
export async function fetchApi(url: string | URL, init: RequestInit = {}, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const key = readKey();
  const headers = { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) };
  const res = await fetchImpl(url, { ...init, credentials: 'include', headers });
  if (res.status === 401) {
    setSessionUser(null);
    throw new UnauthorizedError('Your session has expired. Please sign in again.');
  }
  return res;
}

/** Checks a key against /v1/projects before storing it. Returns an error message, or null when the key works. */
export async function verifyReadKey(apiUrl: string, key: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!key.trim()) return 'Enter a read key.';
  const res = await fetchImpl(`${apiUrl}/v1/projects`, { headers: { authorization: `Bearer ${key.trim()}` } }).catch(() => null);
  if (!res) return `Could not reach the EdgeWatch API at ${apiUrl}.`;
  if (res.status === 401) return 'That key was not accepted. Use an active read key (ew_read_...).';
  if (!res.ok) return `The API answered HTTP ${res.status}. Try again.`;
  return null;
}
