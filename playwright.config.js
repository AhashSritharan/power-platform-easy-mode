// End-to-end tests: the unpacked extension in a real browser, against a real
// developer environment. See tests/e2e/env.js for the configuration and
// README → "End-to-end tests" for running them.
import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests/e2e',
    // Each worker is one browser with the extension loaded once, shared by its
    // tests. The tests only read from the org, so they can run side by side.
    fullyParallel: true,
    workers: process.env.CI ? 2 : 4,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    timeout: 3 * 60_000,
    expect: { timeout: 15_000 },
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'on-failure' }]],
    use: { trace: 'retain-on-failure' },
    projects: [
        // A trace records every value typed — here the password and TOTP secret.
        { name: 'setup', testMatch: /auth\.setup\.js/, use: { trace: 'off', screenshot: 'off', video: 'off' } },
        { name: 'e2e', testMatch: /\.spec\.js/, dependencies: ['setup'] },
    ],
});
