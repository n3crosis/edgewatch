import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { isolateEachTest } from '../../api/test/storage';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TRACES: R2Bucket;
      API_KEYS: KVNamespace;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
isolateEachTest();
