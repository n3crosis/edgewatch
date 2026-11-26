import type { Client } from '@libsql/client';
import { type LibsqlClient, libsqlDatabase } from './libsql';
import type { SqlDatabase } from './storage';

export interface LibsqlConnection {
  db: SqlDatabase;
  close(): Promise<void>;
}

export const isLibsqlUrl = (url: string) => /^(libsql|https?):\/\//i.test(url);

/**
 * A `@libsql/client` over HTTP (`libsql://`, `https://`, `http://`), which runs on Workers, Bun and Node. Loaded on first
 * use so Workers that don't use libSQL never evaluate it. Integers come back as BigInt and the adapter turns them into
 * numbers, rounding past 2^53 like D1 instead of throwing.
 */
export function openLibsqlClient(url: string, authToken?: string): Promise<Client> {
  const client = import('@libsql/client/web').then(({ createClient }) => createClient({ url, authToken: authToken || undefined, intMode: 'bigint' }));
  client.catch(() => {});
  return client;
}

/** Opens libSQL / Turso as a `SqlDatabase`. Call `close()` when the request or batch is done. */
export function connectLibsql(url: string, authToken?: string): LibsqlConnection {
  const client = openLibsqlClient(url, authToken);
  const adapter: LibsqlClient = {
    execute: async (stmt) => (await client).execute(stmt),
    batch: async (stmts, mode) => (await client).batch(stmts, mode),
  };
  return { db: libsqlDatabase(adapter), close: async () => (await client).close() };
}
