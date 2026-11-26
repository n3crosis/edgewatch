import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig(async () => ({
  test: {
    testTimeout: 30000,
    setupFiles: ['./test/apply-migrations.ts'],
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations('../migrations') } },
      },
    },
  },
}));
