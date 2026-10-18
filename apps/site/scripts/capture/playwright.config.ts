import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  outputDir: './test-results',
  timeout: 180_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: 2,
  },
});
