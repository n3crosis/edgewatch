import { useSyncExternalStore } from 'react';
import { API_URL } from './config';

/**
 * The read key is never built into the bundle, a URL or a log line: the owner enters it once and it lives in
 * sessionStorage (memory when storage is unavailable), sent only as an Authorization header. Sign-out and any
 * 401 clear it, as does closing the tab. Keys a previous version kept in localStorage are removed, not read.
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
  try {
    await accountRequest('logout', {});
  } catch (e) {
    clearReadKey(); // the session cookie may still be live, but the read key never outlives a sign-out attempt
    throw e;
  }
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

const KEY_FORMAT = /^ew_[a-z]{2,8}_[A-Za-z0-9_-]{1,256}$/;

/** Normalizes a pasted key (surrounding whitespace, a "Bearer " prefix) and returns it only if it has the EdgeWatch key shape. */
export function sanitizeReadKey(raw: string | null | undefined): string | null {
  const key = (raw ?? '').trim().replace(/^bearer\s+/i, '');
  return KEY_FORMAT.test(key) ? key : null;
}

export function readKey(): string | null {
  storage('localStorage')?.removeItem(STORAGE_KEY);
  const stored = memory ?? storage('sessionStorage')?.getItem(STORAGE_KEY) ?? null;
  const key = sanitizeReadKey(stored);
  if (stored !== null && !key) forget();
  return key;
}

function forget() {
  memory = null;
  storage('sessionStorage')?.removeItem(STORAGE_KEY);
  storage('localStorage')?.removeItem(STORAGE_KEY);
}

/** Stores a key for this tab only; returns false (and stores nothing) when the key is malformed. */
export function saveReadKey(raw: string): boolean {
  forget();
  const key = sanitizeReadKey(raw);
  if (key) {
    const target = storage('sessionStorage');
    if (target) target.setItem(STORAGE_KEY, key);
    else memory = key;
  }
  emit();
  return key !== null;
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
  const clean = sanitizeReadKey(key);
  if (!clean) return 'That is not an EdgeWatch key. Paste the full key (ew_read_...) without spaces.';
  const res = await fetchImpl(`${apiUrl}/v1/projects`, { headers: { authorization: `Bearer ${clean}` } }).catch(() => null);
  if (!res) return `Could not reach the EdgeWatch API at ${apiUrl}.`;
  if (res.status === 401) return 'That key was not accepted. Use an active read key (ew_read_...).';
  if (!res.ok) return `The API answered HTTP ${res.status}. Try again.`;
  return null;
}
