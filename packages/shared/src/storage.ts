/**
 * Storage interfaces the Workers depend on. Each is the subset of a Cloudflare binding EdgeWatch uses, so the bindings
 * (D1, R2, KV, Queues) satisfy them directly with no wrapper. Other backends (Postgres through Hyperdrive, S3, a SQL key
 * table, synchronous processing) implement the same shapes; see docs/architecture.md ("Storage interfaces").
 */

export interface SqlResult<T = Record<string, unknown>> {
  results: T[];
  meta: { changes?: number };
}

/** A prepared statement with positional `?` / `?N` parameters (SQLite style; other dialects translate). */
export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = unknown>(column: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  run<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
}

/** Event store. Default: D1. `batch` runs its statements in order, atomically. */
export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]>;
}

export interface BlobObject {
  readonly body: ReadableStream;
  readonly size: number;
  json<T>(): Promise<T>;
  text(): Promise<string>;
}

export interface BlobPutOptions {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

/** Trace JSON, large ingest batches and dead letters. Default: R2. */
export interface BlobStore {
  get(key: string): Promise<BlobObject | null>;
  put(key: string, value: string, options?: BlobPutOptions): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
}

/** API key records and project blocks (JSON values). Default: KV. */
export interface KeyStore {
  get<T>(key: string, options: { type: 'json'; cacheTtl?: number }): Promise<T | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Hand-off from ingest to the consumer. Default: Queues. */
export interface IngestQueue<T> {
  sendBatch(messages: Iterable<{ body: T }>): Promise<unknown>;
}
