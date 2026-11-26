import type { ApiKeyRecord, Scope } from './types';

/** A key authenticates when it exists, is not disabled (revoked), has not expired and has the scope. */
export function usableKey(record: ApiKeyRecord | null | undefined, scope: Scope, now = Date.now() / 1000): record is ApiKeyRecord {
  return !!record && !record.disabled && (record.expires_at === undefined || record.expires_at > now) && record.scopes.includes(scope);
}
