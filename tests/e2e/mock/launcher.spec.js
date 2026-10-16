// The floating launcher: shown where the toolbox has tools to open, left off
// Jira, where the only tool puts its own timer button on the page.
import { test, expect, gotoOrg } from './fixtures.js';
import { pageCommands } from '../support/helpers.js';

const JIRA = 'https://contoso.atlassian.net';

test.describe('Floating launcher', () => {
    test('is shown on Dynamics 365', async ({ page, org }) => {
        await gotoOrg(page, org); // waits for .ppt-launcher
    });

    test('is not shown on Jira, where the palette still works', async ({ page, org, serviceWorker, extensionContext }) => { // eslint-disable-line no-unused-vars
        await serviceWorker.evaluate(() => chrome.storage.local.set({ enabledTools: { 'jira-clockify-timer': true } }));
        await extensionContext.route(`${JIRA}/**`, (route) => (route.request().resourceType() === 'document'
            ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>Jira</title></head><body><div id="jira-frontend"></div></body></html>' })
            : route.fulfill({ status: 404, body: '' })));
        await page.goto(`${JIRA}/jira/your-work`);

        // The toolbox is up — its commands are served — but no launcher.
        // (Asking before the content script listens throws; that just means "not yet".)
        const toolIds = async () => (await pageCommands(serviceWorker, page).catch(() => [])).map((c) => c.toolId);
        await expect.poll(toolIds).toContain('jira-clockify-timer');
        await expect(page.locator('.ppt-launcher')).toHaveCount(0);
    });
});
