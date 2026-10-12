import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

config({ path: new URL('./.env', import.meta.url).pathname, quiet: true });

// Os testes usam um banco próprio (saude_financeira_test), nunca o de desenvolvimento.
if (process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_OWNER) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  process.env.DATABASE_URL_OWNER = process.env.DATABASE_URL_TEST_OWNER;
}

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
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      DATABASE_URL_OWNER: process.env.DATABASE_URL_OWNER ?? '',
    },
  },
});
