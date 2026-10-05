import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const apiPort = process.env.API_PORT ?? '5107';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [svelte()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    cssCodeSplit: false,
    reportCompressedSize: true,
  },
});
