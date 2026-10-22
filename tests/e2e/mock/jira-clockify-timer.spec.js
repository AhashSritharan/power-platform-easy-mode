// Jira Clockify Timer settings on a stand-in Jira page: the API key and
// workspace, chosen from the key's workspaces as in setup.
import { test, expect } from './fixtures.js';
import { pageCommands } from '../support/helpers.js';
import { fakeClockify } from './fake-clockify.js';

const JIRA = 'https://contoso.atlassian.net';
const saved = (serviceWorker, key) => serviceWorker.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);

async function gotoJira(page, serviceWorker, extensionContext) {
    await extensionContext.route(`${JIRA}/**`, (route) => (route.request().resourceType() === 'document'
        ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>Jira</title></head><body><div id="jira-frontend"></div></body></html>' })
        : route.fulfill({ status: 404, body: '' })));
    await page.goto(`${JIRA}/jira/your-work`);
    const toolIds = async () => (await pageCommands(serviceWorker, page).catch(() => [])).map((c) => c.toolId);
    await expect.poll(toolIds).toContain('jira-clockify-timer');
}

/** Opens the palette as the keyboard shortcut does — Jira has no launcher — and runs `title`. */
async function runCommand(page, serviceWorker, title) {
    await serviceWorker.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url });
        await chrome.tabs.sendMessage(tab.id, { type: 'open-palette' });
    }, page.url());
    const palette = page.locator('.ppt-dialog').filter({ has: page.locator('.ppt-palette-list') });
    await palette.locator('.ppt-palette-item').filter({ has: page.locator('.title').getByText(title, { exact: true }) }).click();
}

test.describe('Jira Clockify Timer settings', () => {
    // Takes `org` so the fixture's storage reset has already run.
    test.beforeEach(async ({ serviceWorker, org }) => { // eslint-disable-line no-unused-vars
        await serviceWorker.evaluate(() => chrome.storage.local.set({ enabledTools: { 'jira-clockify-timer': true } }));
    });

    test('lists the workspaces of the key to choose from', async ({ page, serviceWorker, extensionContext }) => {
        const keys = await fakeClockify(extensionContext);
        await gotoJira(page, serviceWorker, extensionContext);
        await runCommand(page, serviceWorker, 'Clockify timer settings');
        await page.locator('.ppt-dialog').getByRole('button', { name: /API key and workspace/ }).click();

        const dialog = page.locator('.ppt-dialog', { hasText: 'Clockify Settings' });
        await expect(dialog.getByLabel('Workspace')).toBeDisabled();
        await dialog.getByLabel('API key').fill('key-1');
        await dialog.getByRole('button', { name: 'Connect' }).click();
        await expect(dialog).toContainText('✅ Connected as Pat Doe');
        await expect(dialog.getByLabel('Workspace')).toHaveValue('ws-2'); // the one Clockify has active
        await dialog.getByLabel('Workspace').selectOption({ label: 'Contoso' });
        await dialog.getByRole('button', { name: 'Save' }).click();

        await expect.poll(() => saved(serviceWorker, 'vals/clockify/workspace_id')).toBe('ws-1');
        expect(await saved(serviceWorker, 'vals/clockify/api_key')).toBe('key-1');
        expect(await saved(serviceWorker, 'vals/clockify/user_id')).toBe('user-1');
        expect(keys.every((key) => key === 'key-1')).toBe(true);
    });
});
