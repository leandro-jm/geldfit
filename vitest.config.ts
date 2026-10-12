import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

config({ path: new URL('./.env', import.meta.url).pathname, quiet: true });

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/api/test/**/*.test.ts',
      'apps/worker/test/**/*.test.ts',
      'db/tests/**/*.test.ts',
    ],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
