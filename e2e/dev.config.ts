import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

// Tests of single parts on the demo pages under web/dev/, served by the Vite dev server.
// Set DEV_PORT to run more than one of these at the same time.
const port = Number(process.env.DEV_PORT ?? 5199);
const root = path.resolve(import.meta.dirname, '..');

export default defineConfig({
  testDir: './dev',
  outputDir: '../test-results/dev',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // Vite is started with node directly. Through pnpm, the Vite process stays alive after the tests.
    command: `node node_modules/vite/bin/vite.js --config web/vite.config.ts --port ${port} --strictPort --host 127.0.0.1`,
    cwd: root,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
});
