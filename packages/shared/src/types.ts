import type { NightwatchRecord } from './records';

export type Scope = 'ingest' | 'read';

/** Value stored in KV under apikey:<sha256(raw key)>. */
export interface ApiKeyRecord {
  project_id: string;
  name: string;
  scopes: Scope[];
  disabled?: boolean;
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

export type ExecutionSource = 'request' | 'command' | 'job' | 'schedule';
