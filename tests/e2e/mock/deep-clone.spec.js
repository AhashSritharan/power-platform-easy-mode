// Deep Clone against a fake org, in this environment: "Open as New" (a form
// pre-filled from the record) and "Deep Clone" (the record and its children
// written in one deep insert). The cross-environment planner is covered by
// tests/unit/clone-graph.test.mjs.
import { test, expect, gotoOrg } from './fixtures.js';
import { guid } from './fake-dataverse.js';
import { runCommand } from '../support/helpers.js';

const ACCOUNT = guid(301);
const JANE = guid(302);
const JOHN = guid(303);

function accountWithContacts(org) {
    // Columns a clone must leave behind, as a live org returns them on every row.
    const system = (n) => ({
        '@odata.etag': `W/"${n}"`, createdon: '2026-09-01T08:00:00Z', modifiedon: '2026-09-02T08:00:00Z', versionnumber: n,
        _ownerid_value: org.userId, '_ownerid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'systemuser',
        '_ownerid_value@OData.Community.Display.V1.FormattedValue': 'Jane Admin',
    });
    org.entity({
        logicalName: 'account', primaryName: 'name', displayName: 'Account',
        attributes: [
            { name: 'name', type: 'String', label: 'Account Name' },
            { name: 'revenue', type: 'Money', label: 'Annual Revenue' },
            { name: 'primarycontactid', type: 'Lookup', label: 'Primary Contact', targets: { contact: 'primarycontactid' } },
        ],
        oneToMany: [{ schemaName: 'contact_customer_accounts', navigation: 'contact_customer_accounts', entity: 'contact', attribute: 'parentcustomerid' }],
        rows: [{
            ...system(1), accountid: ACCOUNT, name: 'Contoso', revenue: 5000,
            '_primarycontactid_value': JANE,
            '_primarycontactid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'contact',
            '_primarycontactid_value@OData.Community.Display.V1.FormattedValue': 'Jane Doe',
        }],
    });
    const contact = (id, firstname, lastname, n) => ({
        ...system(n), contactid: id, firstname, lastname, fullname: `${firstname} ${lastname}`,
        _parentcustomerid_value: ACCOUNT,
        '_parentcustomerid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'account',
        '_parentcustomerid_value@OData.Community.Display.V1.FormattedValue': 'Contoso',
    });
    org.entity({
        logicalName: 'contact', primaryName: 'fullname', displayName: 'Contact',
        attributes: [
            { name: 'firstname', type: 'String' }, { name: 'lastname', type: 'String' },
            { name: 'fullname', type: 'String', updatable: false },
            { name: 'parentcustomerid', type: 'Customer', targets: { account: 'parentcustomerid_account' } },
        ],
        rows: [contact(JANE, 'Jane', 'Doe', 2), contact(JOHN, 'John', 'Roe', 3)],
    });
    org.entity({ logicalName: 'systemuser', primaryName: 'fullname', rows: [] });
}

async function openClone(page, org) {
    await gotoOrg(page, org, `pagetype=entityrecord&etn=account&id=${ACCOUNT}`);
    await runCommand(page, 'Clone Record');
    const dialog = page.locator('.dc-modal');
    await expect(dialog.locator('.dc-seg')).toBeVisible();
    return dialog;
}

test.describe('Deep Clone', () => {
    test('"Open as New" opens a new form pre-filled with the record\'s own values', async ({ page, org, extensionContext }) => {
        accountWithContacts(org);
        const dialog = await openClone(page, org);
        const [form] = await Promise.all([
            extensionContext.waitForEvent('page'),
            dialog.getByRole('button', { name: '📝 Open New Form' }).click(),
        ]);
        const url = new URL(form.url());
        expect(url.searchParams.get('pagetype')).toBe('entityrecord');
        expect(url.searchParams.get('etn')).toBe('account');
        expect(url.searchParams.get('id')).toBeNull();
        const values = Object.fromEntries(new URLSearchParams(url.searchParams.get('extraqs')));
        expect(values).toEqual({
            name: 'Contoso', revenue: '5000',
            primarycontactid: JANE, primarycontactidname: 'Jane Doe', primarycontactidtype: 'contact',
        });
        await form.close();
    });

    test('"Deep Clone" writes the record and its selected children in one deep insert', async ({ page, org }) => {
        accountWithContacts(org);
        const dialog = await openClone(page, org);
        await dialog.locator('.dc-seg-item', { hasText: '📋 Deep Clone' }).click();
        const contacts = dialog.locator('.dc-rel', { hasText: 'contact_customer_accounts' });
        await expect(contacts.locator('.count')).toHaveText('2 records');
        await contacts.locator('input[type=checkbox]').check();

        await dialog.getByRole('button', { name: '👁 Preview' }).click();
        await expect(dialog).toContainText('Jane');
        await dialog.getByRole('button', { name: '📋 Deep Clone & Save' }).click();
        await expect(dialog).toContainText('Clone Successful!');

        const [insert] = org.calls('POST', '/accounts');
        expect(insert.headers.prefer).toBe('return=representation');
        expect(insert.body).toEqual({
            name: 'Contoso',
            revenue: 5000,
            'primarycontactid@odata.bind': `/contacts(${JANE})`,
            contact_customer_accounts: [
                { firstname: 'Jane', lastname: 'Doe', 'ownerid@odata.bind': `/systemusers(${org.userId})` },
                { firstname: 'John', lastname: 'Roe', 'ownerid@odata.bind': `/systemusers(${org.userId})` },
            ],
        });
        expect(org.calls('POST', '/contacts'), 'children ride along, never posted separately').toHaveLength(0);
    });

    // SharePoint documents are a virtual table: counting them answers 400 —
    // "Connection to the server failed" on an org without SharePoint, as a live
    // org does — and a deep insert could not create them anyway.
    test('"Deep Clone" leaves out the SharePoint documents relationship', async ({ page, org }) => {
        accountWithContacts(org);
        org.entities.account.oneToMany.push({ schemaName: 'Account_SharepointDocument', navigation: 'Account_SharepointDocument', entity: 'sharepointdocument', attribute: 'regardingobjectid' });
        org.on('GET', `/accounts(${ACCOUNT})/Account_SharepointDocument`, () => ({
            status: 400, json: { error: { code: '0x800608b5', message: 'Connection to the server failed. Please contact your administrator.' } },
        }));
        const dialog = await openClone(page, org);
        await dialog.locator('.dc-seg-item', { hasText: '📋 Deep Clone' }).click();
        await expect(dialog.locator('.dc-rel', { hasText: 'contact_customer_accounts' }).locator('.count')).toHaveText('2 records');
        await expect(dialog.locator('.dc-loading, .dc-spinner').filter({ visible: true })).toHaveCount(0);
        expect(org.calls('GET', `/accounts(${ACCOUNT})/Account_SharepointDocument`)).toHaveLength(0);
    });

    test('shows Dataverse\'s message when the clone is refused', async ({ page, org, problems }) => {
        accountWithContacts(org);
        org.on('POST', '/accounts', () => ({ status: 400, json: { error: { code: '0x80040237', message: 'A record with matching key values already exists.' } } }));
        const dialog = await openClone(page, org);
        await dialog.locator('.dc-seg-item', { hasText: '📋 Deep Clone' }).click();
        await expect(dialog.locator('.dc-rel .count')).toHaveText('2 records');
        await dialog.getByRole('button', { name: '👁 Preview' }).click();
        await dialog.getByRole('button', { name: '📋 Deep Clone & Save' }).click();
        await expect(dialog.locator('.dc-error')).toHaveText('A record with matching key values already exists.');
        problems.failedRequests.length = 0;
        problems.consoleErrors.length = 0; // the tool logs the failure on purpose
    });
});
