import { afterEach, expect, it } from 'vitest';
import { scopedPath } from '../components/ScopedLink';
import { groupListLink } from './group-list';
import { userActivityLinks } from './user-activity';
import * as mock from './mock';
import { setActiveEnvironment } from './environment-scope';

afterEach(() => setActiveEnvironment(undefined));

it('preserves opaque user identity and investigation scope on all pivots and detail Back links', () => {
  for (const user of ['all', 'a/b &?', '7']) {
    const links = userActivityLinks(user);
    expect(links.map((link) => link.label)).toEqual(['Requests', 'Jobs', 'Exceptions', 'Logs']);
    for (const link of links) {
      const url = new URL(scopedPath(link.to, 'shop', 'custom:1:2', 'staging'), 'https://test');
      expect(Object.fromEntries(url.searchParams)).toEqual({ user, project: 'shop', range: 'custom:1:2', environment: 'staging' });
      expect(new URL(groupListLink('/exceptions', url.searchParams), 'https://test').searchParams.get('user')).toBe(user);
    }
  }
});

it('filters demo event summaries, occurrences, exceptions and logs by exact captured user', () => {
  mock.setMockProject(mock.MOCK_PROJECTS[0].id);
  const user = mock.traces({ range: '7d' }, null).data.find((row) => row.user)?.user ?? undefined;
  expect(user).toBeTruthy();
  for (const path of ['/jobs', '/users']) {
    for (const group of mock.events(path, '7d', { user }).data) {
      expect(mock.eventRows(path, group.key, '7d', user)?.every((row) => row.user === user)).toBe(true);
    }
    expect(mock.events(path, '7d', { user: 'not-captured' }).data).toEqual([]);
  }
  for (const group of mock.exceptions('7d', user)) {
    expect(group.users).toBe(1);
    expect(mock.exception(group.group, '7d', user)?.occurrences.every((row) => row.user === user)).toBe(true);
  }
  for (const row of mock.logEntries('7d', 'all', '', null, user).data) {
    expect(row.user).toBe(user);
    expect(mock.logEntry(String(row.id), '7d', 'not-captured')).toBeNull();
  }
  expect(mock.exceptions('7d', 'not-captured')).toEqual([]);
});

it('filters demo overview and traces by type:authenticated and type:guest', () => {
  mock.setMockProject(mock.MOCK_PROJECTS[0].id);
  const total = mock.overview('24h').requests;
  const authOverview = mock.overview('24h', 'type:authenticated');
  const guestOverview = mock.overview('24h', 'type:guest');
  expect(authOverview.requests).toBeGreaterThan(0);
  expect(guestOverview.requests).toBeGreaterThan(0);
  expect(authOverview.requests + guestOverview.requests).toBe(total);
  expect(mock.traces({ range: '24h', user: 'type:authenticated' }, null, 200).data.every((row) => Boolean(row.user))).toBe(true);
  expect(mock.traces({ range: '24h', user: 'type:guest' }, null, 200).data.every((row) => !row.user)).toBe(true);
});
