import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

// Tests of the full app: the built client, served by the real server from a temporary data folder.
const port = Number(process.env.E2E_PORT ?? 5120);
const root = path.resolve(import.meta.dirname, '..');

export default defineConfig({
  testDir: './tests',
  outputDir: '../test-results',
  // One server and one database, so the tests run one after the other.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node scripts/e2e-server.ts',
    cwd: root,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { E2E_PORT: String(port) },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
});
