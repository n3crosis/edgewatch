import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ base: '' }));
vi.mock('./config', () => ({ get API_URL() { return settings.base; }, USING_MOCK: false }));
vi.mock('./project', () => ({ activeProjectId: () => 'shop / production', useProject: vi.fn() }));

import { api } from './api';
import { clearReadKey, readKey, saveReadKey, UnauthorizedError } from './auth';
import { setActiveEnvironment } from './environment-scope';

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  settings.base = '';
  fetchMock.mockReset().mockResolvedValue(new Response('{"data":[],"next_offset":null}'));
  vi.stubGlobal('location', { origin: 'https://dashboard.example.test' });
  vi.stubGlobal('fetch', fetchMock);
  saveReadKey('ew_read_fixture', false);
  setActiveEnvironment('staging');
});
afterEach(() => {
  clearReadKey();
  setActiveEnvironment(undefined);
  vi.unstubAllGlobals();
});

it('fetches same-origin Docker API data with project, filters and authorization intact', async () => {
  expect(await api.requests('custom:1:2', 'orders', 50, 'all')).toEqual({ data: [], next_offset: null });
  const [input, init] = fetchMock.mock.calls[0];
  const url = new URL(String(input));
  expect(url.origin).toBe('https://dashboard.example.test');
  expect(decodeURIComponent(url.pathname)).toBe('/v1/projects/shop / production/requests');
  expect(Object.fromEntries(url.searchParams)).toEqual({ range: 'custom:1:2', q: 'orders', offset: '50', user: 'all', environment: 'staging' });
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ew_read_fixture');
});

it('keeps an explicitly configured remote API origin and path prefix', async () => {
  settings.base = 'https://api.example.test/edgewatch';
  await api.permissions();
  const url = new URL(String(fetchMock.mock.calls[0][0]));
  expect(url.origin).toBe('https://api.example.test');
  expect(url.pathname).toBe('/edgewatch/v1/projects/shop%20%2F%20production/permissions');
  expect(url.search).toBe('');
});

it('sends same-origin mutations through the authenticated client', async () => {
  await api.updateIssue('group', 'resolved', 'open', 3, 'fixed');
  const [input, init] = fetchMock.mock.calls[0];
  expect(new URL(String(input)).origin).toBe('https://dashboard.example.test');
  expect(init?.method).toBe('PUT');
  expect(JSON.parse(String(init?.body))).toMatchObject({ status: 'resolved', expected_revision: 3, reason: 'fixed' });
  expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
});

it('reports the actual same-origin endpoint on network failure', async () => {
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  await expect(api.permissions()).rejects.toThrow('Could not reach the EdgeWatch API at https://dashboard.example.test.');
});

it('preserves sign-out behavior for a rejected same-origin key', async () => {
  fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
  await expect(api.permissions()).rejects.toBeInstanceOf(UnauthorizedError);
  expect(readKey()).toBeNull();
});
