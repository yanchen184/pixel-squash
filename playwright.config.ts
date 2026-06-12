import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config. Boots the real Vite dev server and drives the game in a foreground
 * Chromium so requestAnimationFrame actually runs (a hidden tab freezes RAF and
 * the deterministic sim never ticks). headless:false is required for the game
 * loop to advance — Phaser pauses on a non-visible page.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5180',
    headless: false,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5180',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
