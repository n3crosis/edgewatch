import { applyD1Migrations, env } from 'cloudflare:test';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    TRACES: R2Bucket;
    TEST_MIGRATIONS: D1Migration[];
    API_KEYS: KVNamespace;
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
