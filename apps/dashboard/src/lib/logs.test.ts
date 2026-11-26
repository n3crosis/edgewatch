import { afterEach, expect, it } from 'vitest';
import { setActiveEnvironment } from './environment-scope';
import * as mock from './mock';

afterEach(() => { setActiveEnvironment(undefined); mock.setMockProject(mock.MOCK_PROJECTS[0].id); });

it('paginates all demo logs without severity caps or duplicate entries', () => {
  const ids = new Set<string>();
  let cursor: string | null = null;
  let total = 0;
  do {
    const page = mock.logEntries('7d', 'all', '', cursor);
    for (const row of page.data) {
      expect(ids.has(String(row.id))).toBe(false);
      ids.add(String(row.id));
      expect(mock.logEntry(String(row.id), '7d')).toMatchObject(row);
    }
    total += page.data.length;
    cursor = page.next_cursor;
  } while (cursor);
  expect(total).toBeGreaterThan(50);
  expect(total).toBe(mock.events('/logs', '7d').summary?.logs);
});

it('preserves demo entry identity across filters and environment changes', () => {
  const entry = mock.logEntries('7d', 'all', '', null).data[0];
  setActiveEnvironment(String(entry.environment));
  expect(mock.logEntry(String(entry.id), '7d')).toMatchObject(entry);
  expect(mock.logEntries('7d', String(entry.level), String(entry.message), null).data).toContainEqual(entry);
  setActiveEnvironment('not-captured');
  expect(mock.logEntry(String(entry.id), '7d')).toBeNull();
  expect(mock.logEntries('7d', 'all', '', null).data).toEqual([]);
});

it('does not resolve a demo event ID in another project', () => {
  mock.setMockProject(mock.MOCK_PROJECTS[0].id);
  const entry = mock.logEntries('7d', 'all', '', null).data[0];
  mock.setMockProject(mock.MOCK_PROJECTS[1].id);
  expect(mock.logEntry(String(entry.id), '7d')).toBeNull();
});
