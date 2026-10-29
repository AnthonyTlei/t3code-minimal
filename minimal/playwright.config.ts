import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  outputDir: '../output/playwright/results',
  reporter: [['list'], ['json', { outputFile: 'output/playwright/results.json' }]],
  use: {
    viewport: { width: 1440, height: 1000 },
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'off',
    launchOptions: { args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--disable-domain-reliability'] },
  },
});
