// The tools on make.powerapps.com and make.powerautomate.com, for the same
// environment. There they reach Dataverse through the service worker's
// cross-origin proxy rather than the page's own origin — the path most likely
// to break with a change to the background script or the host allowlist.
import { test, expect } from './fixtures.js';
import { environmentId, expectLoaded, expectedTools, gotoDynamics, pageCommands, runCommand } from '../support/helpers.js';

let envId;

test.describe('Maker portals', () => {
    test.beforeEach(async ({ page }) => {
        if (envId) return;
        await gotoDynamics(page);
        envId = await environmentId(page);
        // A default environment's id carries the tenant id; keep it out of public CI logs.
        if (process.env.CI) console.log(`::add-mask::${envId}`);
    });

    for (const [portal, path] of [
        ['make.powerapps.com', 'solutions'],
        ['make.powerautomate.com', 'manage/flows'],
    ]) {
        test(`${portal}: every tool starts and registers its commands`, async ({ page, serviceWorker }) => {
            await page.goto(`https://${portal}/environments/${envId}/${path}`);
            // The portals sign in with their own redirects first.
            await expect(page.locator('.ppt-launcher'), 'the toolbox launcher').toBeVisible({ timeout: 120_000 });
            const commands = await pageCommands(serviceWorker, page);
            const registered = new Set(commands.map((c) => c.toolId));
            const missing = expectedTools(page.url()).filter((t) => !registered.has(t.id)).map((t) => t.name);
            expect(missing, `tools without a command on ${portal}`).toEqual([]);
        });
    }

    test('make.powerapps.com: "Manage Relationship" is in a relationship\'s Advanced menu', async ({ page }) => {
        await gotoDynamics(page);
        const account = await page.evaluate(async () =>
            (await (await fetch("/api/data/v9.2/EntityDefinitions(LogicalName='account')?$select=MetadataId", { headers: { Accept: 'application/json' } })).json()).MetadataId);
        const DEFAULT_SOLUTION = 'fd140aaf-4df4-11dd-bd17-0019b9312238';
        await page.goto(`https://make.powerapps.com/environments/${envId}/solutions/${DEFAULT_SOLUTION}/entities/${account}/relationships`);
        await expect(page.locator('.ppt-launcher')).toBeVisible({ timeout: 120_000 });
        const row = page.locator('[data-automationid="DetailsRow"]').first();
        await row.locator('[data-automationid="DetailsRowCheck"]').click();
        await row.locator('[data-automation-key="contextualMenu"] button').first().click();
        await page.locator('[data-test-key="Advanced"]').first().click();
        // Labels follow the browser's language; the test keys do not.
        await expect(page.locator('[data-test-key="ShowDependencies"]')).toBeVisible();
        await expect(page.locator('#ppt-manage-rel-item [data-test-key="ManageRelationship"]')).toBeVisible();
    });

    test('make.powerapps.com: Solution History loads through the proxy', async ({ page }) => {
        await page.goto(`https://make.powerapps.com/environments/${envId}/solutions`);
        await expect(page.locator('.ppt-launcher')).toBeVisible({ timeout: 120_000 });
        await runCommand(page, 'Open Solution History');
        await expectLoaded(page.locator('.sh-panel'), 120_000);
    });
});
