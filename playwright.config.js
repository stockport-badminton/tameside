// E2E coverage for the email-scorecard wizard's client-side behavior (step
// navigation, live score validation, OCR-photo reuse) — the parts the
// node:test/supertest integration suite can't reach since it never executes
// browser JS. Scoped to just this wizard, not the whole site.
const { defineConfig } = require('@playwright/test');

const PORT = process.env.PLAYWRIGHT_PORT || '8199';

module.exports = defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node server.js',
    url: `http://localhost:${PORT}/email-scorecard`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      PORT: PORT,
      DEV_MODE: 'true',
      NODE_ENV: 'development',
    },
  },
});
