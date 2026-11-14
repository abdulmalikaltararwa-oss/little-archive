import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

// The interface is a static bundle. In development, /api is forwarded to a real Little Archive server on
// loopback (LA_UI_API), so cookies and the server's same-origin check behave exactly as they do in production.
export default defineConfig({
  // Relative asset addresses: the same build is served from a server's root, from /share, from a sub-path
  // behind a reverse proxy, from GitHub Pages (the demo) and from inside the phone app.
  base: './',
  plugins: [react(), tailwindcss()],
  // Several dev servers can run from one checkout (one per port) without sharing a dependency cache.
  cacheDir: process.env.LA_UI_CACHE || 'node_modules/.vite',
  resolve: {
    alias: {
      '@': path.resolve(here, 'src'),
      // The tested buildless modules are imported, not rewritten. See src/types/web-modules.d.ts.
      '@web': path.resolve(here, '../web'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.LA_UI_PORT) || 5183,
    strictPort: true,
    fs: { allow: [path.resolve(here, '..')] },
    proxy: { '/api': { target: process.env.LA_UI_API || 'http://127.0.0.1:8862', changeOrigin: false } },
  },
  preview: { host: '127.0.0.1', port: Number(process.env.LA_UI_PORT) || 5184, strictPort: true },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 400,
    rollupOptions: {
      input: { index: path.resolve(here, 'index.html'), demo: path.resolve(here, 'demo.html') },
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Styles are not needed to test behaviour; the one exception is the token file, which a test reads as text.
    css: { include: [/tokens\.css/] },
  },
});
