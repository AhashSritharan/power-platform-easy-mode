// Audit History against a fake org: field-level old and new values for the
// record on screen, the filters it sends, and what it says when the user may
// not read audits. changedata is a live org's (captured 2026-10-15): every value
// a string — choices "1"/"2" with oldName/newName, booleans "False"/"True",
// lookups "account,<id>".
import { test, expect, gotoOrg } from './fixtures.js';
import { guid } from './fake-dataverse.js';
import { runCommand } from '../support/helpers.js';

const FV = '@OData.Community.Display.V1.FormattedValue';
const CONTACT = guid(601);
const ACCOUNT = guid(602);
const ADMIN = guid(603);

function auditedOrg(org) {
    org.entity({ logicalName: 'account', primaryName: 'name', displayName: 'Account', attributes: [{ name: 'name', type: 'String' }], rows: [{ accountid: ACCOUNT, name: 'Fabrikam Ltd' }] });
    org.entity({
        logicalName: 'contact', primaryName: 'fullname', displayName: 'Contact',
        attributes: [
            { name: 'firstname', type: 'String', label: 'First Name' },
            { name: 'preferredcontactmethodcode', type: 'Picklist', label: 'Preferred Method of Contact', options: [[1, 'Any'], [2, 'Email', '#0078d4']] },
            { name: 'parentcustomerid', type: 'Customer', label: 'Company Name', targets: { account: 'parentcustomerid_account' } },
            { name: 'donotemail', type: 'Boolean', label: 'Do not allow Emails' },
        ],
        rows: [{ contactid: CONTACT, fullname: 'Jane Doe' }],
    });
    org.entity({ logicalName: 'systemuser', primaryName: 'fullname', displayName: 'User', attributes: [], rows: [{ systemuserid: org.userId, fullname: 'Jane Admin' }, { systemuserid: ADMIN, fullname: 'Integration User' }] });
    const audit = (n, createdon, operation, changes, { by = org.userId, calledBy = by } = {}) => ({
        auditid: guid(700 + n), createdon, operation, [`operation${FV}`]: { 1: 'Create', 2: 'Update', 3: 'Delete' }[operation],
        action: operation, objecttypecode: 'contact',
        _objectid_value: CONTACT, [`_objectid_value${FV}`]: 'Jane Doe', '_objectid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'contact',
        _userid_value: by, [`_userid_value${FV}`]: by === org.userId ? 'Jane Admin' : 'Integration User',
        _callinguserid_value: calledBy, [`_callinguserid_value${FV}`]: calledBy === org.userId ? 'Jane Admin' : 'Integration User',
        changedata: JSON.stringify({ changedAttributes: changes }),
    });
    org.table('audits', [
        audit(1, '2026-10-14T09:30:00Z', 2, [
            { logicalName: 'firstname', oldValue: 'Janet', newValue: 'Jane' },
            { logicalName: 'parentcustomerid', oldValue: null, newValue: `account,${ACCOUNT}` },
            { logicalName: 'donotemail', oldValue: 'False', newValue: 'True' },
            { logicalName: 'preferredcontactmethodcode', oldValue: '1', newValue: '2', oldName: 'Any', newName: 'Email' },
        ], { by: ADMIN, calledBy: org.userId }),
        audit(2, '2026-10-01T08:00:00Z', 1, []),
    ]);
}

async function openAudit(page, org) {
    await gotoOrg(page, org, `pagetype=entityrecord&etn=contact&id=${CONTACT}`);
    await runCommand(page, 'Open Audit History');
    const panel = page.locator('.audit-panel');
    await expect(panel.locator('tbody tr').first()).toBeVisible();
    return panel;
}

test.describe('Audit History', () => {
    test('shows each change of the record on screen, field by field', async ({ page, org }) => {
        auditedOrg(org);
        const panel = await openAudit(page, org);
        await expect(panel).toContainText('Showing 1–2 of 2 audit entries');
        const firstName = panel.locator('tbody tr', { hasText: 'First Name' });
        await expect(firstName.locator('.audit-old')).toHaveText('Janet');
        await expect(firstName.locator('.audit-new')).toHaveText('Jane');
        await expect(panel.locator('tbody tr', { hasText: 'Preferred Method of Contact' }).locator('.audit-new')).toHaveText('Email');
        const email = panel.locator('tbody tr', { hasText: 'Do not allow Emails' });
        await expect(email.locator('.audit-old')).toHaveText('No');
        await expect(email.locator('.audit-new')).toHaveText('Yes');
        // A lookup's new value is the record's name, linked to it.
        const company = panel.locator('tbody tr', { hasText: 'Company Name' }).locator('.audit-new a');
        await expect(company).toHaveText('Fabrikam Ltd');
        await expect(company).toHaveAttribute('href', new RegExp(`etn=account&id=${ACCOUNT}`));
        // Made by one user on behalf of another.
        await expect(panel.locator('tbody tr').first()).toContainText('Integration User (by Jane Admin)');
        await expect(panel.locator('tbody')).toContainText('No field changes');
        // Only this record's audits were asked for.
        expect(org.calls('GET', '/audits')[0].query.get('$filter')).toBe(`_objectid_value eq ${CONTACT} and objecttypecode eq 'contact'`);
    });

    test('filters by operation and date range', async ({ page, org }) => {
        auditedOrg(org);
        const panel = await openAudit(page, org);
        await panel.locator('[data-f=operation]').selectOption('2');
        await panel.locator('[data-f=start]').fill('2026-10-10');
        await panel.locator('[data-f=end]').fill('2026-10-15');
        await panel.locator('[data-act=search]').click();
        await expect(panel).toContainText('Showing 1–1 of 1 audit entries');
        const filter = org.calls('GET', '/audits').at(-1).query.get('$filter');
        expect(filter).toContain('operation eq 2');
        expect(filter).toContain('createdon ge 2026-10-10T00:00:00Z');
        expect(filter).toContain('createdon le 2026-10-15T23:59:59Z');
    });

    test('explains a missing privilege instead of failing', async ({ page, org, problems }) => {
        auditedOrg(org);
        org.on('GET', '/audits', () => ({ status: 403, json: { error: { code: '0x80040220', message: 'Principal user is missing prvReadAuditPartitions privilege.' } } }));
        await gotoOrg(page, org, `pagetype=entityrecord&etn=contact&id=${CONTACT}`);
        await runCommand(page, 'Open Audit History');
        await expect(page.locator('.audit-panel')).toContainText('You don’t have permission to view audit history');
        problems.failedRequests.length = 0; // the 403 is the scenario; the tool itself logs nothing
    });
});
