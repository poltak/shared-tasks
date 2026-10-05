import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  // The tests run in Node.js. Without the client output and the browser condition, runes are
  // plain variables there and effects never run.
  plugins: [svelte({ configFile: './web/svelte.config.js', dynamicCompileOptions: () => ({ generate: 'client' }) })],
  resolve: { conditions: ['browser'] },
  ssr: { resolve: { conditions: ['browser'] } },
  test: {
    environment: 'node',
    include: ['shared/**/*.test.ts', 'server/**/*.test.ts', 'web/src/**/*.test.ts'],
    testTimeout: 15000,
  },
});
