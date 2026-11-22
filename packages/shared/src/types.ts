import type { NightwatchRecord } from './records';

/** `browser` keys are public (shipped in JS bundles) and may only POST /api/browser. */
export type Scope = 'ingest' | 'read' | 'browser';

/** Value stored in KV under apikey:<sha256(raw key)>. */
export interface ApiKeyRecord {
  project_id: string;
  name: string;
  scopes: Scope[];
  disabled?: boolean;
  /** For browser keys: exact origins allowed to send (e.g. https://shop.example.com). Empty/missing allows any origin. */
  allowed_origins?: string[];
}

/** Message placed on the ingest queue: one trace's worth of records from one ingest request. */
export interface IngestMessage {
  project_id: string;
  server: string;
  received_at: number;
  trace_id: string | null;
  /** Inline records, or a pointer to an R2 object holding them when the batch is too large for a queue message. */
  records?: NightwatchRecord[];
  r2_key?: string;
}

export type ExecutionSource = 'request' | 'command' | 'job' | 'schedule' | 'browser';
