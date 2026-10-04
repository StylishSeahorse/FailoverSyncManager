/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API sets SameSite=Strict cookies; proxying keeps everything same-origin in development.
    proxy: { '/api': 'http://127.0.0.1:3000', '/healthz': 'http://127.0.0.1:3000' },
  },
  build: { outDir: 'dist', sourcemap: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
  },
});
