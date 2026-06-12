/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5180,
  },
  test: {
    // Unit tests live in tests/; e2e/ is Playwright-only and must not be
    // collected by vitest (it owns its own runner via `npm run e2e`).
    include: ['tests/**/*.test.ts'],
  },
});
