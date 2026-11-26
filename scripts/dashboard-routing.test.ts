import { expect, it } from 'bun:test';
import worker from '../apps/dashboard/public/_worker.js';

it('forwards API and account requests intact to the service binding', async () => {
  const calls: Request[] = [];
  const env = { API: { fetch: async (request: Request) => { calls.push(request); return new Response('ok', { headers: { 'set-cookie': 'edgewatch_session=opaque; HttpOnly; Secure; SameSite=Lax; Path=/' } }); } }, ASSETS: { fetch: async () => new Response('assets') } };
  for (const path of ['/auth/login', '/auth/session', '/v1/projects', '/v1', '/auth']) {
    const request = new Request(`https://dashboard.test${path}`, { method: 'POST', headers: { origin: 'https://dashboard.test', cookie: 'edgewatch_session=old' }, body: '{}' });
    const response = await worker.fetch(request, env);
    expect(calls.at(-1)).toBe(request);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  }
});
it('serves dashboard routes as assets and fails closed for missing API bindings', async () => {
  const env = { ASSETS: { fetch: async () => new Response('assets') } };
  expect(await (await worker.fetch(new Request('https://dashboard.test/requests'), env)).text()).toBe('assets');
  expect(await (await worker.fetch(new Request('https://dashboard.test/authorize'), env)).text()).toBe('assets');
  const failed = await worker.fetch(new Request('https://dashboard.test/auth/session'), env);
  expect(failed.status).toBe(503);
  expect(failed.headers.get('cache-control')).toBe('no-store');
});
