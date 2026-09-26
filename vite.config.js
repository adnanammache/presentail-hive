import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5173,
    // '^/api/' rather than '/api': the prefix alone also catches the page's own /api.js module.
    proxy: { '^/api/': { target: 'http://localhost:3001', changeOrigin: true } },
  },
});
