import type { ExceptionGroup } from './types';

export function exceptionHandling(group: Pick<ExceptionGroup, 'handled' | 'handled_count' | 'unhandled_count'>) {
  if ((group.handled_count ?? 0) > 0 && (group.unhandled_count ?? 0) > 0) return 'mixed';
  return group.handled ? 'handled' : 'unhandled';
}
