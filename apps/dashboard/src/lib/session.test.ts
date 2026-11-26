import { afterEach, expect, it, vi } from 'vitest';
import { accountRequest, fetchApi, refreshSession, sessionStatus, sessionUser, setSessionUser, signOut } from './auth';
const user = { id: 'owner', name: 'Owner', email: 'owner@example.com', role: 'owner' as const };
afterEach(() => { setSessionUser(null); vi.unstubAllGlobals(); });

it('restores a cookie session and never persists a password or token', async () => {
  const storage = { getItem: vi.fn(), removeItem: vi.fn(), setItem: vi.fn() };
  vi.stubGlobal('localStorage', storage); vi.stubGlobal('sessionStorage', storage);
  const fetcher = vi.fn(async () => Response.json({ user, setup_required: false, setup_token_required: false })); vi.stubGlobal('fetch', fetcher);
  await refreshSession();
  expect(sessionUser()).toEqual(user);
  expect(sessionStatus()).toEqual({ setupRequired: false, setupTokenRequired: false });
  expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/auth/session'), { credentials: 'include', method: 'GET' });
  expect(storage.setItem).not.toHaveBeenCalled();
});

it('tracks first-run setup flags from /auth/session and clears setupRequired once signed in', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ user: null, setup_required: true, setup_token_required: false })));
  await refreshSession();
  expect(sessionUser()).toBeNull();
  expect(sessionStatus()).toEqual({ setupRequired: true, setupTokenRequired: false });
  setSessionUser(user);
  expect(sessionStatus().setupRequired).toBe(false);
});
it('clears local identity only after logout succeeds', async () => {
  setSessionUser(user);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Unavailable' }, { status: 503 })));
  await expect(signOut()).rejects.toThrow('Unavailable');
  expect(sessionUser()).toEqual(user);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));
  await signOut(); expect(sessionUser()).toBeNull();
});
it('expires the session on API rejection and surfaces login errors', async () => {
  setSessionUser(user);
  const denied = vi.fn(async () => Response.json({ error: 'Email or password is incorrect.' }, { status: 401 }));
  await expect(accountRequest('login', { email: user.email, password: 'wrong' }, denied)).rejects.toThrow('Email or password');
  await expect(fetchApi('/v1/projects', {}, denied)).rejects.toThrow('session has expired');
  expect(sessionUser()).toBeNull();
});
