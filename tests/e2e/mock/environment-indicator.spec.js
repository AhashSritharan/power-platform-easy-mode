// Environment Indicator against a fake org: labelling the environment, and the
// badge it then docks next to the Dynamics 365 button.
import { test, expect, gotoOrg } from './fixtures.js';
import { guid } from './fake-dataverse.js';
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

    // Switching keeps you in the same app and table; a record the other
    // environment does not have opens the table's list there, never the app's
    // "Record Is Unavailable". The URL rules themselves are unit tested
    // (tests/unit/environment-switch.test.mjs).
    test('switching from a record the other environment lacks opens its list there, in the same app', async ({ page, org, targetOrg, serviceWorker }) => {
        await serviceWorker.evaluate(({ here, there }) => chrome.storage.local.set({
            'vals/environment-indicator/envIndicator_mappings': {
                [here.id]: { type: 'DEV', name: 'Contoso DEV', nameSource: 'org' },
                [there.id]: { type: 'PROD', name: 'Contoso PROD', nameSource: 'org' },
            },
            'vals/environment-indicator/envIndicator_hostCache': { [here.host]: here.id, [there.host]: there.id },
        }), {
            here: { id: org.environmentId, host: org.host },
            there: { id: targetOrg.environmentId, host: targetOrg.host },
        });
        org.table('appmodules', [{ appmoduleid: guid(100), uniquename: 'contoso_Sales' }]);
        targetOrg.table('appmodules', [{ appmoduleid: guid(200), uniquename: 'contoso_Sales' }]);
        org.entity({ logicalName: 'account', rows: [{ accountid: guid(300) }] });
        targetOrg.entity({ logicalName: 'account', rows: [] });

        await gotoOrg(page, org, `appid=${guid(100)}&pagetype=entityrecord&etn=account&id=${guid(300)}`);
        await badge(page).click();
        const dialog = page.locator('.ppt-dialog', { hasText: '🏷️ Environment Indicator' });
        await dialog.locator('.env-row').filter({ hasText: 'Contoso PROD' }).getByRole('button', { name: 'Switch' }).click();

        await expect(page).toHaveURL(`${targetOrg.origin}/main.aspx?appid=${guid(200)}&pagetype=entitylist&etn=account`);
        expect(targetOrg.calls('GET', `/accounts(${guid(300)})`), 'the record was looked for first').toHaveLength(1);
    });

    // The maker portal has its environment in the URL, and switching there
    // moves the portal; opening an environment's Dynamics app happens next to it.
    test("on the maker portal, opens an environment's Dynamics app in a new tab", async ({ page, org, targetOrg, serviceWorker, portal, extensionContext }) => {
        const UNSEEN = guid(1903);
        await serviceWorker.evaluate(({ here, there, unseen }) => chrome.storage.local.set({
            'vals/environment-indicator/envIndicator_mappings': {
                [here.id]: { type: 'DEV', name: 'Contoso DEV', nameSource: 'org' },
                [there.id]: { type: 'PROD', name: 'Contoso PROD', nameSource: 'org' },
                [unseen]: { type: 'TEST', name: 'Contoso TEST', nameSource: 'org' },
            },
            'vals/environment-indicator/envIndicator_hostCache': { [here.host]: here.id, [there.host]: there.id },
        }), {
            here: { id: org.environmentId, host: org.host },
            there: { id: targetOrg.environmentId, host: targetOrg.host },
            unseen: UNSEEN,
        });
        // The header the badge docks to, as on the live portal.
        portal.page('<!doctype html><html><head><title>Power Apps</title></head><body><div id="ppuxOfficeHeaderBranding_container" style="height:48px;width:200px">Power Apps</div></body></html>');
        const portalUrl = `https://make.powerapps.com/environments/${org.environmentId}/solutions`;
        await page.goto(portalUrl);
        await badge(page).click();
        const dialog = page.locator('.ppt-dialog', { hasText: '🏷️ Environment Indicator' });
        const row = (name) => dialog.locator('.env-row').filter({ has: page.locator('.env-name', { hasText: name }) });
        await expect(row('Contoso TEST').getByRole('button', { name: 'Open' }), 'no Dynamics address known').toHaveCount(0);

        // Playwright cannot route the first page of a tab the extension opens,
        // so record what the service worker is asked to open and give the tab
        // a blank page instead of letting it reach the network.
        await serviceWorker.evaluate(() => {
            globalThis.__opened = [];
            globalThis.__createTab = chrome.tabs.create;
            chrome.tabs.create = (props) => {
                globalThis.__opened.push(props.url);
                return globalThis.__createTab.call(chrome.tabs, { ...props, url: 'about:blank' });
            };
        });
        try {
            for (const name of ['Contoso PROD', 'Contoso DEV']) {
                const opened = extensionContext.waitForEvent('page');
                await row(name).getByRole('button', { name: 'Open' }).click();
                await (await opened).close();
            }
            expect(await serviceWorker.evaluate(() => globalThis.__opened)).toEqual([`${targetOrg.origin}/`, `${org.origin}/`]);
        } finally {
            await serviceWorker.evaluate(() => { chrome.tabs.create = globalThis.__createTab; });
        }
        await expect(page, 'the portal tab stays where it was').toHaveURL(portalUrl);
    });
});
