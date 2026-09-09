import { defineConfig, devices } from '@playwright/test';

/**
 * The end-to-end gate.
 *
 * NOT part of `pnpm test`. The rest of the suite is mock-driven and runs
 * without a database; this needs a real PostgreSQL, a migrated schema and the
 * dev seed, so it lives behind `pnpm test:e2e` for the same reason
 * `packages/core/tests/integration/` is not automated. Mixing them would make
 * the fast suite fail on a laptop with nothing running.
 *
 * The run it drives is SIMULATED — the bundled fixture replayed through the
 * real runner, socket, writer and reducer. That is deliberate: every part of
 * the machinery this is meant to protect is exercised, and none of it depends
 * on two throwaway databases existing on whoever's machine runs it.
 */
export default defineConfig({
  testDir: './tests/e2e',
  // These assert live, ordered behaviour against one shared org and one
  // concurrency slot, so they must not race each other.
  workers: 1,
  fullyParallel: false,
  // A mid-run reload with a real WebSocket reconnect is not a 5s test.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // A green run recorded by a retry is not green. CI gets one retry for
  // genuine flake; a local run gets none, so a break is seen immediately.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: process.env.MOVY_E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Reuse a dev server the developer already has open; start one in CI.
  webServer: {
    command: 'pnpm nuxt dev',
    url: process.env.MOVY_E2E_BASE_URL ?? 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
