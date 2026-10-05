// Starts the API server and the Vite dev server together. When one stops, the other stops too.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const apiPort = process.env.API_PORT ?? '5107';
const vitePort = process.env.VITE_PORT ?? '5173';
const dataDir = process.env.DATA_DIR ?? path.join(root, '.tmp/dev');
mkdirSync(dataDir, { recursive: true });

const run = ({ args, env }: { args: string[]; env: Record<string, string> }) =>
  spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });

const children = [
  run({
    // Without this option, each restart of the server clears the terminal and removes the Vite output.
    args: ['--watch', '--watch-preserve-output', 'server/main.ts'],
    env: { PORT: apiPort, DATA_DIR: dataDir },
  }),
  run({
    // Vite runs directly in Node.js, not through pnpm, so a signal goes to Vite itself.
    args: ['node_modules/vite/bin/vite.js', '--config', 'web/vite.config.ts', '--port', vitePort, '--strictPort'],
    // The Vite config reads API_PORT to know where to send /api.
    env: { API_PORT: apiPort },
  }),
];

let stopByUser = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    stopByUser = true;
    for (const child of children) child.kill(signal);
  });
}

for (const child of children) {
  child.on('exit', (code) => {
    // The first exit gives the result. A stop that the user asked for is not an error.
    process.exitCode ??= stopByUser ? 0 : (code ?? 1);
    for (const other of children) if (other !== child) other.kill();
  });
}
