// Add Existing Components against a fake org: the components of a type, what
// the target solution already holds, and the AddSolutionComponent change set.
// The query builder is unit-tested in tests/unit/add-existing.test.mjs.
import { test, expect, gotoOrg } from './fixtures.js';
import { guid } from './fake-dataverse.js';
import { runCommand } from '../support/helpers.js';

const DEFAULT_SOLUTION = 'fd140aaf-4df4-11dd-bd17-0019b9312238';
const CORE = guid(901);

// msdyn_solutioncomponentsummaries rows as a live org returns them (trimmed).
const webResource = (n, name, { customizable = true } = {}) => ({
    msdyn_objectid: guid(910 + n), msdyn_solutionid: DEFAULT_SOLUTION, msdyn_componenttype: 61, msdyn_componenttypename: 'Web Resource',
    msdyn_name: name, msdyn_displayname: name.split('/').pop(), msdyn_iscustomizable: customizable, msdyn_ismanaged: false,
    msdyn_modifiedon: '2026-10-01T08:00:00.000Z', msdyn_owner: 'Jane Admin',
});

function componentsOrg(org, rows) {
    org.table('solutions', [
        { solutionid: CORE, uniquename: 'Core', friendlyname: 'Core Solution', version: '1.0.0.0', ismanaged: false, isvisible: true },
        { solutionid: DEFAULT_SOLUTION, uniquename: 'Default', friendlyname: 'Default Solution', version: '1.0', ismanaged: false, isvisible: true },
    ]);
    org.table('solutioncomponentdefinitions', []);
    org.table('msdyn_solutioncomponentsummaries', rows);
    org.table('solutioncomponents', [{ solutioncomponentid: guid(950), _solutionid_value: CORE, componenttype: 61, objectid: guid(911) }]);
    org.on('POST', '/AddSolutionComponent', (req) => ({ id: guid(960), '@odata.context': `${org.origin}/api/data/v9.2/$metadata#Microsoft.Dynamics.CRM.AddSolutionComponentResponse`, req: undefined }));
}

async function openPanel(page, org) {
    await gotoOrg(page, org);
    await runCommand(page, 'Add Existing Components (filterable)');
    const panel = page.locator('.grid-panel').last();
    await expect(panel.locator('.grid-status')).toContainText('loaded');
    return panel;
}

test.describe('Add Existing Components', () => {
    test('adds the selected components to the solution in one change set', async ({ page, org }) => {
        componentsOrg(org, [
            webResource(1, 'cr1_/scripts/form.js'),
            webResource(2, 'cr1_/scripts/ribbon.js'),
            webResource(3, 'cr1_/styles/site.css'),
            webResource(4, 'msdyn_/locked.js', { customizable: false }),
        ]);
        const panel = await openPanel(page, org);
        await expect(panel.locator('tbody tr')).toHaveCount(3); // only what can be customized, as the portal does
        await panel.locator('select').first().selectOption(CORE);
        const already = panel.locator('tbody tr', { hasText: 'form.js' });
        await expect(already).toContainText('in solution');
        await expect(already.locator('input[type=checkbox]')).toBeDisabled();

        await panel.locator('tbody tr', { hasText: 'ribbon.js' }).click();
        await panel.locator('tbody tr', { hasText: 'site.css' }).click();
        await panel.getByRole('button', { name: 'Add 2 to solution' }).click();
        await expect(page.locator('.ppt-toast')).toHaveText('✅ Added 2 components to Core Solution.');

        const adds = org.calls('POST', '/AddSolutionComponent');
        expect(adds.every((c) => c.batch), 'sent inside a $batch').toBe(true);
        expect(adds.map((c) => c.body)).toEqual([
            { ComponentId: guid(912), ComponentType: 61, SolutionUniqueName: 'Core', AddRequiredComponents: false, DoNotIncludeSubcomponents: false },
            { ComponentId: guid(913), ComponentType: 61, SolutionUniqueName: 'Core', AddRequiredComponents: false, DoNotIncludeSubcomponents: false },
        ]);
        await expect(panel.locator('tbody tr', { hasText: 'site.css' })).toContainText('in solution');
    });

    test('pages through every component of the type', async ({ page, org }) => {
        componentsOrg(org, Array.from({ length: 130 }, (_, i) => webResource(100 + i, `cr1_/scripts/file${String(i).padStart(3, '0')}.js`)));
        const panel = await openPanel(page, org);
        await expect(panel.locator('tbody tr')).toHaveCount(100);
        await expect(panel.locator('.grid-status')).toContainText('100 loaded — more available');
        await panel.getByRole('button', { name: '⬇ Load 100 more' }).click();
        await expect(panel.locator('tbody tr')).toHaveCount(130);
    });

    test('says why an add was refused, and keeps the selection', async ({ page, org, problems }) => {
        componentsOrg(org, [webResource(2, 'cr1_/scripts/ribbon.js')]);
        org.on('POST', '/AddSolutionComponent', () => ({ status: 400, json: { error: { code: '0x8004f016', message: 'Cannot add a managed component to an unmanaged solution.' } } }));
        const panel = await openPanel(page, org);
        await panel.locator('select').first().selectOption(CORE);
        await panel.locator('tbody tr', { hasText: 'ribbon.js' }).click();
        await panel.getByRole('button', { name: 'Add 1 to solution' }).click();
        await expect(page.locator('.ppt-toast')).toHaveText('⚠️ Could not add: Cannot add a managed component to an unmanaged solution.');
        await expect(panel.getByRole('button', { name: 'Add 1 to solution' })).toBeEnabled();
        problems.failedRequests.length = 0; // the refused batch is the scenario
    });
});
