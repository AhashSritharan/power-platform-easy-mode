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

    test('rounds to the chosen block from the chosen minute, and remembers it', async ({ page, org, serviceWorker }) => {
        await gotoOrg(page, org);
        await runCommand(page, 'Clockify Sync settings');
        const dialog = page.locator('.ppt-dialog', { hasText: 'Clockify Sync Settings' });
        await dialog.locator('select').selectOption('10');
        await dialog.locator('input[type="number"]').fill('4');
        await expect(dialog).toContainText('14 min → 20 min, 13 min → 10 min');
        await dialog.getByRole('button', { name: 'Save' }).click();

        expect(await saved(serviceWorker, ROUNDING_KEY)).toEqual({ block: 10, roundUpFrom: 4 });

        await runCommand(page, 'Clockify Sync settings');
        const reopened = page.locator('.ppt-dialog', { hasText: 'Clockify Sync Settings' });
        await expect(reopened.locator('select')).toHaveValue('10');
        await expect(reopened.locator('input[type="number"]')).toHaveValue('4');
    });
});
