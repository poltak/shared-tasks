// Starts the real server for the Playwright tests: a new data folder, the seed data, and the built client.
import { spawn, spawnSync } from 'node:child_process';
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const port = process.env.E2E_PORT ?? '5120';
const dataDir = path.join(root, '.tmp', `e2e-${port}`);
// E2E_WEB_DIR lets two test runs use two builds at the same time.
const webDir = path.resolve(root, process.env.E2E_WEB_DIR ?? path.join('web', 'dist'));

if (!existsSync(path.join(webDir, 'index.html'))) {
  console.error(`${webDir} is missing. Run "pnpm build" first.`);
  process.exit(1);
}

rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const env = {
  ...process.env,
  PORT: port,
  HOST: '127.0.0.1',
  DATA_DIR: dataDir,
  WEB_DIR: webDir,
  // Lets a test put the database back to the seed data. Never set this on the real server.
  ST_TEST_RESET: '1',
  // The seed makes two accounts. One more place lets a test make an account.
  MAX_USERS: '3',
};

const seed = spawnSync(process.execPath, ['server/cli.ts', 'seed'], { cwd: root, env, stdio: 'inherit' });
if (seed.status !== 0) process.exit(seed.status ?? 1);

const server = spawn(process.execPath, ['server/main.ts'], { cwd: root, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.kill(signal));
}
server.on('exit', (code) => process.exit(code ?? 0));
