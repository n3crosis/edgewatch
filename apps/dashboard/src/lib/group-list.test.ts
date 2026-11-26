import { expect, it } from 'vitest';
import { groupListLink, groupListState, updateGroupList } from './group-list';

it('round trips list filters and scope through a detail link and back', () => {
  const params = new URLSearchParams('project=shop&environment=all&range=custom:1:2&q=select+%25&sort=p95_ms&offset=200');
  const detail = new URL(groupListLink('/queries/hash', params), 'https://test');
  const back = new URL(groupListLink('/queries', detail.searchParams), 'https://test');
  expect(back.searchParams.toString()).toBe(params.toString());
  expect(groupListState(back.searchParams)).toMatchObject({ q: 'select %', sort: 'p95_ms', offset: 200 });
  expect(groupListState(new URLSearchParams('handled=unhandled'))).toMatchObject({ handled: 'unhandled' });
});

it('resets pagination for filter edits without losing scope', () => {
  const before = new URLSearchParams('project=shop&range=7d&environment=staging&offset=100');
  const patches: Record<string, string>[] = [{ q: 'failure' }, { sort: 'calls' }, { handled: 'handled' }];
  for (const patch of patches) {
    const next = updateGroupList(before, patch);
    expect(next.has('offset')).toBe(false);
    for (const key of ['project', 'range', 'environment']) expect(next.get(key)).toBe(before.get(key));
  }
  expect(updateGroupList(before, { offset: '200' }).get('offset')).toBe('200');
  expect(before.get('offset')).toBe('100');
});

it('normalizes invalid URL controls to supported defaults', () => {
  for (const offset of ['-1', 'NaN', '1.5', '9007199254740992']) {
    expect(groupListState(new URLSearchParams(`sort=__proto__&handled=unknown&offset=${offset}`))).toEqual({ q: '', sort: 'total_ms', handled: 'all', offset: 0 });
  }
});
