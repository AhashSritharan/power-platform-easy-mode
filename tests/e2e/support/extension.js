// The browser the tests run in: a fresh profile with the extension loaded
// unpacked, shared by every test of a worker (live/fixtures.js adds the saved
// session's cookies on top). Each test gets its own tab, and fails if the extension logged an
// error or one of its own Dataverse requests came back 4xx/5xx while it ran.
//
// The extension is loaded from a copy in which the toolbox UI's shadow roots
// are created open instead of closed — the only way for Playwright to see
// inside them. Nothing else differs from what ships.
import { test as base, expect, chromium } from '@playwright/test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, env } from './env.js';
import { TOOLS } from '../../../extension/src/registry.js';

function prepareExtension() {
    const dir = mkdtempSync(join(tmpdir(), 'ppt-e2e-extension-'));
    cpSync(join(ROOT, 'extension'), dir, { recursive: true });
    const uiFile = join(dir, 'src', 'core', 'ui.js');
    const source = readFileSync(uiFile, 'utf8');
    const CLOSED = "attachShadow({ mode: 'closed' })";
    if (!source.includes(CLOSED)) throw new Error(`core/ui.js no longer contains ${CLOSED} — update tests/e2e/support/extension.js`);
    writeFileSync(uiFile, source.replaceAll(CLOSED, "attachShadow({ mode: 'open' })"));
    return dir;
}

// Console errors that are the extension's: logged from its own files, or
// carrying one of the "[Tool Name]" prefixes its modules log with.
const PREFIXES = ['Power Platform Toolbox', 'Clockify Timer', ...TOOLS.map((t) => t.name)];
const isExtensionError = (msg) => msg.type() === 'error'
    && (msg.location().url.startsWith('chrome-extension://') || PREFIXES.some((p) => msg.text().startsWith(`[${p}]`)));

export const test = base.extend({
    extensionContext: [async ({ headless }, use) => {
        const extensionDir = prepareExtension();
        const profileDir = mkdtempSync(join(tmpdir(), 'ppt-e2e-profile-'));
        const context = await chromium.launchPersistentContext(profileDir, {
            channel: env.browser,
            // Headless unless run with --headed. Extensions need the new
            // headless mode, which only Playwright's own Chromium has.
            headless: env.browser === 'chromium' && headless,
            viewport: { width: 1600, height: 1000 },
            // Off by default in Playwright; Edge shows a warning bar without it.
            // CI's container runs as root, where Chromium cannot sandbox.
            chromiumSandbox: !process.env.CI,
            args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
        });
        await use(context);
        await context.close();
        rmSync(extensionDir, { recursive: true, force: true });
        rmSync(profileDir, { recursive: true, force: true });
    }, { scope: 'worker' }],

    serviceWorker: [async ({ extensionContext }, use) => {
        const worker = extensionContext.serviceWorkers()[0]
            ?? await extensionContext.waitForEvent('serviceworker', { timeout: 15_000 });
        await use(worker);
    }, { scope: 'worker' }],

    extensionId: [async ({ serviceWorker }, use) => {
        await use(new URL(serviceWorker.url()).host);
    }, { scope: 'worker' }],

    // Problems the extension caused in the current tab. Tests that expect one
    // can empty the arrays before the fixture checks them.
    problems: async ({}, use) => {
        await use({ consoleErrors: [], failedRequests: [] });
    },

    page: async ({ extensionContext, problems }, use, testInfo) => {
        const page = await extensionContext.newPage();
        // Every navigation of the tab, timed — a failure report says whether the
        // host page reloaded under the test.
        const started = Date.now();
        const navigations = [];
        page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame()) navigations.push(`+${Date.now() - started}ms ${new URL(frame.url()).pathname}${new URL(frame.url()).search.slice(0, 120)}`);
        });
        page.on('console', (msg) => { if (isExtensionError(msg)) problems.consoleErrors.push(msg.text()); });
        page.on('pageerror', (error) => {
            if (/chrome-extension:\/\//.test(error.stack ?? '')) problems.consoleErrors.push(error.message);
        });

        // Requests whose initiator stack runs through the extension's files.
        const cdp = await extensionContext.newCDPSession(page);
        const fromExtension = new Map();
        cdp.on('Network.requestWillBeSent', ({ requestId, request, initiator }) => {
            const frames = [];
            for (let stack = initiator?.stack; stack; stack = stack.parent) frames.push(...stack.callFrames);
            if (frames.some((f) => f.url.startsWith('chrome-extension://'))) fromExtension.set(requestId, `${request.method} ${request.url}`);
        });
        cdp.on('Network.responseReceived', ({ requestId, response }) => {
            const request = fromExtension.get(requestId);
            if (request && response.status >= 400) problems.failedRequests.push(`${response.status} ${request}`);
        });
        await cdp.send('Network.enable');

        await use(page);

        if (testInfo.status !== testInfo.expectedStatus) {
            await testInfo.attach('screenshot', { body: await page.screenshot().catch(() => Buffer.alloc(0)), contentType: 'image/png' });
            await testInfo.attach('navigations', { body: navigations.join('\n'), contentType: 'text/plain' });
        }
        await page.close();
        expect(problems.consoleErrors, 'errors the extension logged').toEqual([]);
        expect(problems.failedRequests, 'extension requests that failed').toEqual([]);
    },
});

export { expect };
