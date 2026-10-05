import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte({ configFile: './web/svelte.config.js' })],
  resolve: { conditions: ['browser'] },
  test: {
    environment: 'node',
    include: ['shared/**/*.test.ts', 'server/**/*.test.ts', 'web/src/**/*.test.ts'],
    testTimeout: 15000,
  },
});
