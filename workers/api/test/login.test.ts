import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import app, { type Env } from '../src/index';

const origin = 'https://dashboard.test';
const password = 'a long account password';
const makeRequest = (bindings: Env) => (path: string, body?: unknown, cookie = '', source = origin) =>
  app.fetch(new Request(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: source, cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), bindings);

it('protects token-gated setup, auto-signs in on setup, authenticates cookies, authorizes roles and revokes logout', async () => {
  const bindings = { ...env, OWNER_SETUP_TOKEN: 'test-owner-bootstrap' } as unknown as Env;
  const request = makeRequest(bindings);

  const initial = await (await request('/auth/session')).json() as { user: unknown; setup_required: boolean; setup_token_required: boolean };
  expect(initial).toEqual({ user: null, setup_required: true, setup_token_required: true, setup_available: true });

  expect((await request('/auth/setup', { token: 'wrong' })).status).toBe(403);
  const setupRes = await request('/auth/setup', { token: 'test-owner-bootstrap', email: 'owner@example.com', name: 'Owner', password });
  expect(setupRes.status).toBe(201);
  const setupCookie = setupRes.headers.get('set-cookie')!;
  expect(setupCookie).toContain('HttpOnly');
  expect((await request('/v1/permissions', undefined, setupCookie)).status).toBe(200);

  const afterSetup = await (await request('/auth/session', undefined, setupCookie)).json() as { user: { email: string }; setup_required: boolean };
  expect(afterSetup.setup_required).toBe(false);
  expect(afterSetup.user.email).toBe('owner@example.com');

  expect((await request('/auth/setup', { token: 'test-owner-bootstrap', email: 'other@example.com', name: 'Other', password })).status).toBe(409);
  expect((await request('/auth/login', { email: 'owner@example.com', password }, '', 'https://evil.test')).status).toBe(403);
  expect((await request('/auth/login', { email: 'owner@example.com', password: 'wrong' })).status).toBe(401);
  const response = await request('/auth/login', { email: 'owner@example.com', password });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie')!;
  expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure'); expect(cookie).toContain('SameSite=Lax');
  expect((await request('/v1/permissions', undefined, cookie)).status).toBe(200);
  expect(await (await request('/v1/permissions', undefined, cookie)).json()).toEqual({ can_manage: true });
  const inviteResponse = await request('/auth/invitations', { email: 'viewer@example.com', role: 'viewer' }, cookie);
  expect(inviteResponse.status).toBe(201);
  const { token } = await inviteResponse.json() as { token: string };
  const acceptRes = await request('/auth/accept-invitation', { token, name: 'Viewer', password });
  expect(acceptRes.status).toBe(201);
  expect(acceptRes.headers.get('set-cookie')).toContain('HttpOnly');
  expect((await request('/auth/accept-invitation', { token, name: 'Viewer', password })).status).toBe(410);
  const viewerResponse = await request('/auth/login', { email: 'viewer@example.com', password });
  const viewer = viewerResponse.headers.get('set-cookie')!;
  expect(await (await request('/v1/permissions', undefined, viewer)).json()).toEqual({ can_manage: false });
  expect((await request('/auth/invitations', { email: 'extra@example.com', role: 'admin' }, viewer)).status).toBe(403);
  expect((await request('/auth/manage/accounts', undefined, viewer)).status).toBe(403);
  const directory = await request('/auth/manage/accounts', undefined, cookie);
  expect(directory.status).toBe(200);
  const members = await directory.json() as { users: { id: string; email: string }[] };
  expect(JSON.stringify(members)).not.toContain('password_hash');
  expect(JSON.stringify(members)).not.toContain('token_hash');
  const viewerId = members.users.find((member) => member.email === 'viewer@example.com')!.id;
  expect((await request('/auth/manage/disable', { id: viewerId }, viewer)).status).toBe(403);
  expect((await request('/auth/manage/disable', { id: 'owner' }, cookie)).status).toBe(422);
  expect((await request('/auth/manage/disable', { id: viewerId }, cookie)).status).toBe(200);
  expect((await request('/v1/permissions', undefined, viewer)).status).toBe(401);
  const revoke = await request('/auth/invitations', { email: 'revoke@example.com', role: 'viewer' }, cookie);
  const revoked = await revoke.json() as { token: string };
  expect((await request('/auth/manage/revoke-invitation', { email: 'revoke@example.com' }, cookie)).status).toBe(200);
  expect((await request('/auth/accept-invitation', { token: revoked.token, name: 'Revoked', password })).status).toBe(410);
  expect((await request('/auth/logout', {}, cookie)).status).toBe(200);
  expect((await request('/v1/permissions', undefined, cookie)).status).toBe(401);
});

it('fails closed: refuses the public owner claim when neither OWNER_SETUP_TOKEN nor OWNER_EMAIL + OWNER_PASSWORD is set', async () => {
  const request = makeRequest({ ...env } as unknown as Env);
  const initial = await (await request('/auth/session')).json();
  expect(initial).toEqual({ user: null, setup_required: true, setup_token_required: false, setup_available: false });
  for (const body of [{ email: 'attacker@example.com', password }, { token: 'guess', email: 'attacker@example.com', password }]) {
    const res = await request('/auth/setup', body);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'setup_disabled', error: expect.stringMatching(/OWNER_SETUP_TOKEN.*OWNER_EMAIL and OWNER_PASSWORD/) });
  }
  expect((await (await request('/auth/session')).json() as { setup_required: boolean }).setup_required).toBe(true);
});

it('requires OWNER_SETUP_TOKEN on the claim when it is set', async () => {
  const request = makeRequest({ ...env, OWNER_SETUP_TOKEN: 'claim-token' } as unknown as Env);
  expect((await request('/auth/setup', { email: 'owner@example.com', password })).status).toBe(403);
  expect((await request('/auth/setup', { token: 'claim-tokenx', email: 'owner@example.com', password })).status).toBe(403);
  const res = await request('/auth/setup', { token: 'claim-token', email: 'alex.smith@example.com', password });
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({ user: { email: 'alex.smith@example.com', name: 'Alex Smith', role: 'owner' } });
  expect((await request('/auth/setup', { token: 'claim-token', email: 'attacker@example.com', password })).status).toBe(409);
});

it('refuses the public claim when only OWNER_EMAIL + OWNER_PASSWORD are set but invalid', async () => {
  const request = makeRequest({ ...env, OWNER_EMAIL: 'admin@example.com', OWNER_PASSWORD: 'short' } as unknown as Env);
  const res = await request('/auth/setup', { email: 'attacker@example.com', password });
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ code: 'setup_disabled', error: expect.stringContaining('OWNER_PASSWORD') });
});

it('auto-bootstraps the owner from OWNER_EMAIL and OWNER_PASSWORD on first request', async () => {
  const bindings = { ...env, OWNER_EMAIL: 'admin@example.com', OWNER_PASSWORD: password } as unknown as Env;
  const request = makeRequest(bindings);

  const session = await (await request('/auth/session')).json() as { user: unknown; setup_required: boolean };
  expect(session.setup_required).toBe(false);

  const loginRes = await request('/auth/login', { email: 'admin@example.com', password });
  expect(loginRes.status).toBe(200);
  expect(await loginRes.json()).toMatchObject({ user: { email: 'admin@example.com', name: 'Admin', role: 'owner' } });
  expect((await request('/auth/setup', { email: 'other@example.com', password })).status).toBe(409);
});

it('throttles repeated failed login attempts and bounds request bodies', async () => {
  const bindings = { ...env, OWNER_SETUP_TOKEN: 'test-owner-bootstrap' } as unknown as Env;
  const request = makeRequest(bindings);
  for (let i = 0; i < 10; i++) expect((await request('/auth/login', { email: 'unknown@example.com', password })).status).toBe(401);
  const blocked = await request('/auth/login', { email: 'unknown@example.com', password });
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get('retry-after')).toBe('900');
  expect((await request('/auth/login', { email: 'unknown@example.com', password: 'x'.repeat(9000) })).status).toBe(413);
});
