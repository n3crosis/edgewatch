import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// workerd reports a rejection from DecompressionStream's internals on truncated or corrupt gzip even when the read
// error is handled (reproduced with a bare pipeThrough). The ingest tests assert the 400 those bodies get.
const WORKERD_GZIP_REJECTIONS = ['Called close() on a decompression stream with incomplete data', 'Decompression failed.'];

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { TOKEN_SIGNING_SECRET: 'test-secret' } },
    }),
  ],
  test: {
    onUnhandledError: (error) => !WORKERD_GZIP_REJECTIONS.includes(error.message ?? ''),
  },
});
