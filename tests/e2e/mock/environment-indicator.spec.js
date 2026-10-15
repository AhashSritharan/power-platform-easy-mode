// Environment Indicator against a fake org: labelling the environment, and the
// badge it then docks next to the Dynamics 365 button.
import { test, expect, gotoOrg } from './fixtures.js';
import { runCommand } from '../support/helpers.js';

const badge = (page) => page.locator('body > div.ppt[data-env-type]');
const mappings = (serviceWorker) => serviceWorker.evaluate(async () =>
    (await chrome.storage.local.get('vals/environment-indicator/envIndicator_mappings'))['vals/environment-indicator/envIndicator_mappings'] ?? {});

test.describe('Environment Indicator', () => {
    test('labels an environment, and shows the badge next to the Dynamics 365 button', async ({ page, org, serviceWorker }) => {
        await gotoOrg(page, org);
        await expect(badge(page)).toHaveCount(0);

        await runCommand(page, 'Configure Environment Indicator');
        const dialog = page.locator('.ppt-dialog', { hasText: '🏷️ Environment Indicator' });
        await expect(dialog).toContainText(`ID: ${org.environmentId}`);
        await dialog.locator('select').first().selectOption('DEV');
        await dialog.getByRole('button', { name: 'Save' }).click();

        await expect(badge(page)).toHaveText('🔧 DEV');
        await expect(badge(page)).toBeVisible();
        const button = await page.locator('[data-id="dynamics-button"]').boundingBox();
        const docked = await badge(page).boundingBox();
        expect(docked.x, 'right of the Dynamics 365 button').toBeGreaterThan(button.x + button.width);
        expect((await mappings(serviceWorker))[org.environmentId]).toMatchObject({ type: 'DEV' });
    });

    test('shows a saved label as soon as the page loads', async ({ page, org, serviceWorker }) => {
        await serviceWorker.evaluate((envId) => chrome.storage.local.set({
            'vals/environment-indicator/envIndicator_mappings': { [envId]: { type: 'PROD', name: 'Contoso Production' } },
        }), org.environmentId);
        await gotoOrg(page, org);
        await expect(badge(page)).toHaveText('🔴 PROD');
    });

    test('removing the label removes the badge', async ({ page, org, serviceWorker }) => {
        await serviceWorker.evaluate((envId) => chrome.storage.local.set({
            'vals/environment-indicator/envIndicator_mappings': { [envId]: { type: 'TEST' } },
        }), org.environmentId);
        await gotoOrg(page, org);
        await expect(badge(page)).toBeVisible();
        await badge(page).click(); // the badge opens the same dialog
        const dialog = page.locator('.ppt-dialog', { hasText: '🏷️ Environment Indicator' });
        await dialog.locator('select').first().selectOption('');
        await dialog.getByRole('button', { name: 'Save' }).click();
        await expect(badge(page)).toHaveCount(0);
        expect(await mappings(serviceWorker)).not.toHaveProperty(org.environmentId);
    });
});
