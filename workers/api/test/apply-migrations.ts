import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { isolateEachTest } from './storage';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TRACES: R2Bucket;
      TEST_MIGRATIONS: D1Migration[];
      API_KEYS: KVNamespace;
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
isolateEachTest();
