// Clockify → Dynamics 365 Sync settings against a fake org: choosing how
// durations are rounded. The import itself writes msdyn_timeentry, which the
// developer environment does not have; its rounding is pinned down in
// tests/unit/clockify-sync.test.mjs.
import { test, expect, gotoOrg } from './fixtures.js';
import { runCommand } from '../support/helpers.js';
import { fakeClockify } from './fake-clockify.js';

const ROUNDING_KEY = 'vals/clockify-sync/clockify_rounding';
const saved = (serviceWorker, key) => serviceWorker.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);

test.describe('Clockify Sync settings', () => {
    // Takes `org` so the fixture's storage reset has already run.
    test.beforeEach(async ({ serviceWorker, org }) => { // eslint-disable-line no-unused-vars
        // The tool ships switched off.
        await serviceWorker.evaluate(() => chrome.storage.local.set({ enabledTools: { 'clockify-sync': true } }));
    });

    test('imports durations unrounded until a rounding is chosen', async ({ page, org }) => {
        await gotoOrg(page, org);
        await runCommand(page, 'Clockify Sync settings');
        const dialog = page.locator('.ppt-dialog', { hasText: 'Clockify Sync Settings' });
        await expect(dialog.getByLabel('Duration rounding')).toHaveValue('0');
        await expect(dialog.getByLabel(/Round up once/)).toBeHidden();
        await expect(dialog).toContainText('imported to the minute');
    });

    test('uses the Clockify settings shared with setup and the Jira timer, and saves them there', async ({ page, org, serviceWorker, extensionContext }) => {
        await fakeClockify(extensionContext);
        await serviceWorker.evaluate(() => chrome.storage.local.set({
            'vals/clockify/api_key': 'shared-key',
            'vals/clockify/workspace_id': 'ws-1',
        }));
        await gotoOrg(page, org);
        await runCommand(page, 'Clockify Sync settings');
        const dialog = page.locator('.ppt-dialog', { hasText: 'Clockify Sync Settings' });
        await expect(dialog.locator('input[type="password"]')).toHaveValue('shared-key');
        // A saved key connects by itself, and the saved workspace stays chosen.
        await expect(dialog).toContainText('✅ Connected as Pat Doe');
        await expect(dialog.getByLabel('Workspace')).toHaveValue('ws-1');

        await dialog.getByLabel('Workspace').selectOption({ label: 'Fabrikam' });
        await dialog.getByRole('button', { name: 'Save' }).click();
        await expect.poll(() => saved(serviceWorker, 'vals/clockify/workspace_id')).toBe('ws-2');
        expect(await saved(serviceWorker, 'vals/clockify/user_id')).toBe('user-1');
        expect(await saved(serviceWorker, 'vals/clockify-sync/clockify_workspace_id')).toBeUndefined();
    });

    test('lists the workspaces of a newly entered key to choose from', async ({ page, org, serviceWorker, extensionContext }) => {
        const keys = await fakeClockify(extensionContext);
        await gotoOrg(page, org);
        await runCommand(page, 'Clockify Sync settings');
        const dialog = page.locator('.ppt-dialog', { hasText: 'Clockify Sync Settings' });
        await expect(dialog.getByLabel('Workspace')).toBeDisabled();
        await dialog.getByLabel('Clockify API key').fill('key-1');
        await dialog.getByRole('button', { name: 'Connect' }).click();
        await expect(dialog).toContainText('✅ Connected as Pat Doe');
        await expect(dialog.getByLabel('Workspace')).toHaveValue('ws-2'); // the one Clockify has active
        await dialog.getByRole('button', { name: 'Save' }).click();
        await expect.poll(() => saved(serviceWorker, 'vals/clockify/workspace_id')).toBe('ws-2');
        expect(await saved(serviceWorker, 'vals/clockify/api_key')).toBe('key-1');
        expect(keys.every((key) => key === 'key-1')).toBe(true);
    });

    test('says why a key is turned down', async ({ page, org, extensionContext }) => {
        await fakeClockify(extensionContext);
        await gotoOrg(page, org);
        await runCommand(page, 'Clockify Sync settings');
        const dialog = page.locator('.ppt-dialog', { hasText: 'Clockify Sync Settings' });
        await dialog.getByLabel('Clockify API key').fill('wrong-key');
        await dialog.getByRole('button', { name: 'Connect' }).click();
        await expect(dialog).toContainText('❌ Clockify did not accept that API key.');
        await expect(dialog.getByLabel('Workspace')).toBeDisabled();
    });

    test('rounds to the chosen block from the chosen minute, and remembers it', async ({ page, org, serviceWorker }) => {
        await gotoOrg(page, org);
        await runCommand(page, 'Clockify Sync settings');
        const dialog = page.locator('.ppt-dialog', { hasText: 'Clockify Sync Settings' });
        await dialog.getByLabel('Duration rounding').selectOption('10');
        await dialog.getByLabel(/Round up once/).fill('4');
        await expect(dialog).toContainText('14 min → 20 min, 13 min → 10 min');
        await dialog.getByRole('button', { name: 'Save' }).click();

        // Save is async: wait for it to land rather than read once.
        await expect.poll(() => saved(serviceWorker, ROUNDING_KEY)).toEqual({ block: 10, roundUpFrom: 4 });

        await runCommand(page, 'Clockify Sync settings');
        const reopened = page.locator('.ppt-dialog', { hasText: 'Clockify Sync Settings' });
        await expect(reopened.getByLabel('Duration rounding')).toHaveValue('10');
        await expect(reopened.getByLabel(/Round up once/)).toHaveValue('4');
    });
});
