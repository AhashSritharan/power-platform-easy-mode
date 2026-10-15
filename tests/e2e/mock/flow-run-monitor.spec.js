// Flow Run Monitor against a fake org: recent runs, the status filter, and the
// Errors view. The issue model behind that view (cascades, caught ancestors)
// is unit-tested in tests/unit/flow-run-monitor.test.mjs.
import { test, expect, gotoOrg } from './fixtures.js';
import { guid } from './fake-dataverse.js';
import { runCommand } from '../support/helpers.js';

const FV = '@OData.Community.Display.V1.FormattedValue';
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const run = (n, flow, flowName, status, h, { code = '', message = '', parent = null, duration = 4200 } = {}) => ({
    flowrunid: guid(1100 + n), name: `08584${String(n).padStart(15, '0')}CU00`, status, [`status${FV}`]: status,
    starttime: hoursAgo(h), endtime: hoursAgo(h - 0.01), duration, triggertype: 'Automated', modernflowtype: 0,
    errorcode: code, errormessage: message ? JSON.stringify({ error: { code, message } }) : '',
    _workflow_value: flow, [`_workflow_value${FV}`]: flowName, workflowid: flow, parentrunid: parent,
    _ownerid_value: guid(1199), [`_ownerid_value${FV}`]: 'Jane Admin',
});
const SYNC = guid(1001);
const NOTIFY = guid(1002);

function runsOrg(org) {
    org.table('flowruns', [
        run(1, SYNC, 'Sync accounts', 'Succeeded', 1),
        run(2, NOTIFY, 'Notify approver', 'Failed', 2, { code: 'InvalidTemplate', message: 'Unable to process template language expressions in action \'Send_an_email\'.' }),
        run(3, SYNC, 'Sync accounts', 'Succeeded', 30),
        run(4, SYNC, 'Sync accounts', 'Failed', 24 * 10, { code: 'Old', message: 'Ten days ago — outside the default 7 days' }),
    ]);
    org.table('workflows', [{ workflowid: SYNC, name: 'Sync accounts', category: 5 }, { workflowid: NOTIFY, name: 'Notify approver', category: 5 }]);
}

async function openMonitor(page, org) {
    await gotoOrg(page, org);
    await runCommand(page, 'Open Flow Run Monitor');
    const panel = page.locator('.frm-panel');
    await expect(panel.locator('.frm-loading')).toHaveCount(0);
    return panel;
}

test.describe('Flow Run Monitor', () => {
    test('lists the last 7 days of runs, newest first, with their errors', async ({ page, org }) => {
        runsOrg(org);
        const panel = await openMonitor(page, org);
        const rows = panel.locator('.frm-table tbody tr[data-runid]');
        await expect(rows).toHaveCount(3);
        await expect(rows.nth(0)).toContainText('Sync accounts');
        await expect(rows.nth(1)).toContainText('Notify approver');
        await expect(rows.nth(1)).toContainText('InvalidTemplate');
        await expect(rows.nth(1)).toContainText('Unable to process template language expressions');
        await expect(panel.locator('.frm-table')).not.toContainText('outside the default 7 days');
        expect(org.calls('GET', '/flowruns')[0].query.get('$filter')).toMatch(/^starttime ge \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z and starttime le /);
    });

    test('filters by status on the server', async ({ page, org }) => {
        runsOrg(org);
        const panel = await openMonitor(page, org);
        await panel.locator('.frm-chip[data-status=Failed]').click();
        await expect(panel.locator('.frm-table tbody tr[data-runid]')).toHaveCount(1);
        await expect(panel.locator('.frm-table tbody')).toContainText('Notify approver');
        expect(org.calls('GET', '/flowruns').at(-1).query.get('$filter')).toContain("status eq 'Failed'");
    });

    test('the Errors view lists the failure under the flow that broke', async ({ page, org }) => {
        runsOrg(org);
        const panel = await openMonitor(page, org);
        await panel.locator('.frm-tab[data-view=errors]').click();
        await expect(panel.locator('.frm-loading')).toHaveCount(0);
        await expect(panel).toContainText('Notify approver');
        await expect(panel).toContainText('InvalidTemplate');
    });

    test('a run opens its details', async ({ page, org }) => {
        runsOrg(org);
        const panel = await openMonitor(page, org);
        await panel.locator('.frm-table tbody tr', { hasText: 'Notify approver' }).click();
        await expect(page.getByText('Unable to process template language expressions in action \'Send_an_email\'.').last()).toBeVisible();
    });
});
