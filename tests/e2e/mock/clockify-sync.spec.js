// Clockify → Dynamics 365 Sync settings against a fake org: choosing how
// durations are rounded. The import itself writes msdyn_timeentry, which the
// developer environment does not have; its rounding is pinned down in
// tests/unit/clockify-sync.test.mjs.
import { test, expect, gotoOrg } from './fixtures.js';
import { runCommand } from '../support/helpers.js';

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
        await expect(dialog.locator('select')).toHaveValue('0');
        await expect(dialog.locator('input[type="number"]')).toBeHidden();
        await expect(dialog).toContainText('imported to the minute');
    });

    test('uses the Clockify settings shared with setup and the Jira timer, and saves them there', async ({ page, org, serviceWorker }) => {
        await serviceWorker.evaluate(() => chrome.storage.local.set({
            'vals/clockify/api_key': 'shared-key',
            'vals/clockify/workspace_id': 'shared-workspace',
        }));
        await gotoOrg(page, org);
        await runCommand(page, 'Clockify Sync settings');
        const dialog = page.locator('.ppt-dialog', { hasText: 'Clockify Sync Settings' });
        await expect(dialog.locator('input[type="password"]')).toHaveValue('shared-key');
        await expect(dialog.getByPlaceholder('From the workspace URL')).toHaveValue('shared-workspace');

        await dialog.getByPlaceholder('From the workspace URL').fill('other-workspace');
        await dialog.getByRole('button', { name: 'Save' }).click();
        await expect.poll(() => saved(serviceWorker, 'vals/clockify/workspace_id')).toBe('other-workspace');
        expect(await saved(serviceWorker, 'vals/clockify-sync/clockify_workspace_id')).toBeUndefined();
    });

    test('rounds to the chosen block from the chosen minute, and remembers it', async ({ page, org, serviceWorker }) => {
        await gotoOrg(page, org);
        await runCommand(page, 'Clockify Sync settings');
        const dialog = page.locator('.ppt-dialog', { hasText: 'Clockify Sync Settings' });
        await dialog.locator('select').selectOption('10');
        await dialog.locator('input[type="number"]').fill('4');
        await expect(dialog).toContainText('14 min → 20 min, 13 min → 10 min');
        await dialog.getByRole('button', { name: 'Save' }).click();

        // Save is async: wait for it to land rather than read once.
        await expect.poll(() => saved(serviceWorker, ROUNDING_KEY)).toEqual({ block: 10, roundUpFrom: 4 });

        await runCommand(page, 'Clockify Sync settings');
        const reopened = page.locator('.ppt-dialog', { hasText: 'Clockify Sync Settings' });
        await expect(reopened.locator('select')).toHaveValue('10');
        await expect(reopened.locator('input[type="number"]')).toHaveValue('4');
    });
});
