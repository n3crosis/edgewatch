import { expect, it } from 'vitest';
import { exceptionHandling } from './exception-handling';

it('distinguishes mixed groups and supports responses without occurrence counts', () => {
  expect(exceptionHandling({ handled: false, handled_count: 1, unhandled_count: 2 })).toBe('mixed');
  expect(exceptionHandling({ handled: true, handled_count: 3, unhandled_count: 0 })).toBe('handled');
  expect(exceptionHandling({ handled: false, handled_count: 0, unhandled_count: 3 })).toBe('unhandled');
  expect(exceptionHandling({ handled: false })).toBe('unhandled');
  expect(exceptionHandling({ handled: true })).toBe('handled');
});
