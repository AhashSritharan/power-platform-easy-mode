// Cloud Flow Manager against a fake org: listing a solution's flows, turning
// them on and off one at a time and in bulk, and flagging flows that cannot
// run as child flows. Row shapes copied from a live org's
// msdyn_solutioncomponentsummaries.
import { test, expect, gotoOrg } from './fixtures.js';
import { guid } from './fake-dataverse.js';
import { runCommand } from '../support/helpers.js';

const SOLUTION_ID = guid(201);
const flowRow = (id, name, on, extra = {}) => ({
    msdyn_objectid: id, msdyn_solutionid: SOLUTION_ID, msdyn_name: name, msdyn_displayname: name, msdyn_description: '',
    msdyn_componenttype: 29, msdyn_componenttypename: 'Process', msdyn_componentlogicalname: 'workflow',
    msdyn_workflowcategory: 5, msdyn_workflowcategoryname: 'Modern Flow', msdyn_typename: 'Definition',
    msdyn_status: on ? 1 : 0, msdyn_statusname: on ? 'Activated' : 'Draft', msdyn_standardstatus: 0,
    msdyn_ismanaged: false, msdyn_ismanagedname: 'Unmanaged', msdyn_owner: 'Jane Doe',
    msdyn_modifiedon: '2026-10-01T08:00:00.000Z', msdyn_primaryidattribute: 'workflowid', msdyn_total: 3,
    ...extra,
});
const clientData = (runtimeSource) => JSON.stringify({
    properties: { connectionReferences: { shared_commondataserviceforapps: { api: { name: 'shared_commondataserviceforapps' }, runtimeSource } } },
});

const SYNC = guid(211);
const NOTIFY = guid(212);
const ARCHIVE = guid(213);

function flowOrg(org) {
    org.table('solutions', [
        { solutionid: SOLUTION_ID, uniquename: 'Core', friendlyname: 'Core Solution', version: '1.0.0.0', ismanaged: false, isvisible: true },
        { solutionid: guid(202), uniquename: 'Other', friendlyname: 'Other Solution', version: '1.0.0.0', ismanaged: false, isvisible: true },
    ]);
    org.table('msdyn_solutioncomponentsummaries', [
        flowRow(SYNC, 'Sync accounts', true),
        flowRow(NOTIFY, 'Notify approver', false),
        flowRow(ARCHIVE, 'Archive invoices', false),
        flowRow(guid(214), 'Flow in another solution', true, { msdyn_solutionid: guid(202) }),
    ]);
    org.table('workflows', [
        { workflowid: SYNC, name: 'Sync accounts', clientdata: clientData('embedded'), statecode: 1, statuscode: 2 },
        { workflowid: NOTIFY, name: 'Notify approver', clientdata: clientData('invoker'), statecode: 0, statuscode: 1 },
        { workflowid: ARCHIVE, name: 'Archive invoices', clientdata: clientData('embedded'), statecode: 0, statuscode: 1 },
    ]);
}

async function openSolution(page, org) {
    await gotoOrg(page, org);
    await runCommand(page, 'Open Cloud Flow Manager');
    const panel = page.locator('.cfm-panel');
    await panel.locator('[data-f=solution]').selectOption(SOLUTION_ID);
    await panel.locator('[data-act=load]').click();
    await expect(panel.locator('tbody tr')).toHaveCount(3);
    return panel;
}

const flow = (panel, name) => panel.locator('tbody tr', { hasText: name });

test.describe('Cloud Flow Manager', () => {
    test('lists the solution\'s cloud flows with their state', async ({ page, org }) => {
        flowOrg(org);
        const panel = await openSolution(page, org);
        await expect(flow(panel, 'Sync accounts')).toContainText('On');
        await expect(flow(panel, 'Notify approver').getByRole('button', { name: 'Turn On' })).toBeVisible();
        await expect(panel.locator('tbody')).not.toContainText('Flow in another solution');
    });

    test('turns a flow off', async ({ page, org }) => {
        flowOrg(org);
        const panel = await openSolution(page, org);
        await flow(panel, 'Sync accounts').getByRole('button', { name: 'Turn Off' }).click();
        await expect(page.getByText('"Sync accounts" has been turned off successfully.')).toBeVisible();
        expect(org.calls('PATCH', `/workflows(${SYNC})`).map((c) => c.body)).toEqual([{ statecode: 0, statuscode: 1 }]);
        await expect(flow(panel, 'Sync accounts').getByRole('button', { name: 'Turn On' })).toBeVisible();
    });

    test('turns the selected flows on in bulk, after asking', async ({ page, org }) => {
        flowOrg(org);
        const panel = await openSolution(page, org);
        await flow(panel, 'Notify approver').locator('[data-row-check]').check();
        await flow(panel, 'Archive invoices').locator('[data-row-check]').check();
        await panel.locator('[data-act=bulk-on]').click();
        const confirm = page.locator('.ppt-dialog', { hasText: 'turn on 2 flow(s)?' });
        await confirm.getByRole('button', { name: 'Turn On' }).click();
        await expect.poll(() => org.calls('PATCH', /^\/workflows\(/).length).toBe(2);
        for (const id of [NOTIFY, ARCHIVE]) {
            expect(org.calls('PATCH', `/workflows(${id})`)[0].body).toEqual({ statecode: 1, statuscode: 2 });
        }
        expect(org.calls('PATCH', `/workflows(${SYNC})`)).toHaveLength(0);
    });

    test('says why a flow could not be turned on', async ({ page, org, problems }) => {
        flowOrg(org);
        // A live org's answer for a flow whose connection references have no connections.
        const message = 'A connector was imported, however the related connection references need connections created and then any dependent flows can be started.';
        org.on('PATCH', `/workflows(${NOTIFY})`, () => ({ status: 400, json: { error: { code: '0x80060467', message } } }));
        const panel = await openSolution(page, org);
        await flow(panel, 'Notify approver').getByRole('button', { name: 'Turn On' }).click();
        await expect(page.getByText('Could not turn on "Notify approver".')).toBeVisible();
        await expect(page.getByText(message, { exact: false })).toBeVisible();
        await expect(flow(panel, 'Notify approver').getByRole('button', { name: 'Turn On' })).toBeEnabled();
        problems.failedRequests.length = 0; // the 400 is the point of this test
    });

    test('flags flows whose connections are "Provided by run-only user"', async ({ page, org }) => {
        flowOrg(org);
        const panel = await openSolution(page, org);
        await expect(flow(panel, 'Notify approver')).toContainText('connection(s) set to "Provided by run-only user"');
        await expect(flow(panel, 'Sync accounts')).not.toContainText('run-only user');
        await panel.locator('[data-filter=connection-issues]').click();
        await expect(panel.locator('tbody tr')).toHaveCount(1);
        await expect(panel.locator('tbody tr')).toContainText('Notify approver');
    });

    test('filters by state and by name', async ({ page, org }) => {
        flowOrg(org);
        const panel = await openSolution(page, org);
        await panel.locator('[data-filter=off]').click();
        await expect(panel.locator('tbody tr')).toHaveCount(2);
        await panel.locator('[data-filter=all]').click();
        await panel.locator('[data-f=search]').fill('archive');
        await expect(panel.locator('tbody tr')).toHaveCount(1);
        await expect(panel.locator('tbody tr')).toContainText('Archive invoices');
    });
});
