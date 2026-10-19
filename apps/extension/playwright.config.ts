import { defineConfig } from '@playwright/test';

// E2E tests load the built extension from dist/ into Chromium via a persistent context.
// See tests/e2e/fixtures.ts for the harness. Run `npm run build` first.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
