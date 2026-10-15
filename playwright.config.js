// Browser tests: the unpacked extension in Playwright's Chromium.
//
//   mock  against a fake Dynamics served by tests/e2e/mock/fake-dataverse.js —
//         no tenant, no secrets; safe for every push and pull request
//   live    against the developer environment in playwright.env.json /
//           ENV_VAR_JSON (see tests/e2e/support/env.js), after `setup` signs in
//   deploy  real deployments from it to TARGET_URL, cleaned up afterwards
//
// See README → "Tests".
import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests/e2e',
    // Each worker is one browser with the extension loaded once, shared by its
    // tests. Live tests only read from the org and mock tests each get their
    // own fake org, so they can run side by side.
    fullyParallel: true,
    workers: process.env.CI ? 2 : 4,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    timeout: 3 * 60_000,
    expect: { timeout: 15_000 },
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'on-failure' }]],
    use: { trace: 'retain-on-failure' },
    projects: [
        { name: 'mock', testMatch: /mock\/.*\.spec\.js/, timeout: 60_000 },
        // A trace records every value typed — here the password and TOTP secret.
        { name: 'setup', testMatch: /live\/auth\.setup\.js/, use: { trace: 'off', screenshot: 'off', video: 'off' } },
        { name: 'live', testMatch: /live\/.*\.spec\.js/, dependencies: ['setup'] },
        // Writes to the developer environment and TARGET_URL: deploys, checks and cleans up.
        { name: 'deploy', testMatch: /deploy\/.*\.spec\.js/, dependencies: ['setup'], timeout: 10 * 60_000 },
    ],
});
