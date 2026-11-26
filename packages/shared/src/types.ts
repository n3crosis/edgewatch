import type { NightwatchRecord } from './records';

/** `browser` keys are public (shipped in JS bundles) and may only POST /api/browser. */
export type Scope = 'ingest' | 'read' | 'browser' | 'admin';

/** Value stored in KV under apikey:<sha256(raw key)>. */
export interface ApiKeyRecord {
  /** Default project for data sent with this key when the client sends no project tag (e.g. the official Nightwatch agent). */
  project_id: string;
  name: string;
  scopes: Scope[];
  /** Revoked (`keys revoke`, or the old key after `keys rotate --grace 0`). */
  disabled?: boolean;
  /** Unix seconds. Set by scripts/keys.ts; older keys have none. */
  created_at?: number;
  /** Unix seconds after which the key no longer authenticates (`keys create --expires`, `keys rotate`). */
  expires_at?: number;
  revoked_at?: number;
  /** For browser keys: exact origins allowed to send (e.g. https://shop.example.com). Empty/missing allows any origin. */
  allowed_origins?: string[];
}

/** Message placed on the ingest queue: one trace's worth of records from one ingest request. */
export interface IngestMessage {
  /** Stable across delivery retries and dead-letter replay. */
  message_id?: string;
  project_id: string;
  server: string;
  received_at: number;
  trace_id: string | null;
  /** Inline records, or a pointer to an R2 object holding them when the batch is too large for a queue message. */
  records?: NightwatchRecord[];
  r2_key?: string;
}

export type ExecutionSource = 'request' | 'command' | 'job' | 'schedule' | 'browser';
