// Record Editor against a fake org: what it shows for each column type, and
// the PATCH it saves. Metadata and record shapes are copied from a live org's
// contact (see fake-dataverse.js → entity()).
import { test, expect, gotoOrg } from './fixtures.js';
import { guid } from './fake-dataverse.js';
import { runCommand } from '../support/helpers.js';

const CONTACT = guid(101);
const ACCOUNT = guid(102);

function contactOrg(org, record = {}) {
    org.entity({
        logicalName: 'account', primaryName: 'name', displayName: 'Account',
        attributes: [{ name: 'name', type: 'String', label: 'Account Name' }],
        rows: [{ accountid: ACCOUNT, name: 'Fabrikam Ltd' }],
    });
    return org.entity({
        logicalName: 'contact', primaryName: 'fullname', displayName: 'Contact',
        attributes: [
            { name: 'contactid', type: 'Uniqueidentifier', label: 'Contact', updatable: false },
            { name: 'firstname', type: 'String', label: 'First Name' },
            { name: 'fullname', type: 'String', label: 'Full Name', updatable: false },
            { name: 'donotemail', type: 'Boolean', label: 'Do not allow Emails', options: ['Allow', 'Do Not Allow'] },
            { name: 'preferredcontactmethodcode', type: 'Picklist', label: 'Preferred Method of Contact', options: [[1, 'Any'], [2, 'Email'], [3, 'Phone']] },
            { name: 'parentcustomerid', type: 'Customer', label: 'Company Name', targets: { account: 'parentcustomerid_account' } },
            { name: 'parentcustomeridname', type: 'String', attributeOf: 'parentcustomerid', updatable: false },
        ],
        rows: [{
            '@odata.etag': 'W/"1001"',
            contactid: CONTACT,
            fullname: 'Jane Doe',
            firstname: 'Jane',
            donotemail: false,
            'donotemail@OData.Community.Display.V1.FormattedValue': 'Allow',
            preferredcontactmethodcode: 1,
            'preferredcontactmethodcode@OData.Community.Display.V1.FormattedValue': 'Any',
            _parentcustomerid_value: ACCOUNT,
            '_parentcustomerid_value@OData.Community.Display.V1.FormattedValue': 'Fabrikam Ltd',
            '_parentcustomerid_value@Microsoft.Dynamics.CRM.associatednavigationproperty': 'parentcustomerid_account',
            '_parentcustomerid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'account',
            ...record,
        }],
    });
}

async function openEditor(page, org) {
    await gotoOrg(page, org, `pagetype=entityrecord&etn=contact&id=${CONTACT}`);
    await runCommand(page, 'Edit Record Values');
    const editor = page.locator('.fe-modal');
    await expect(editor.locator('.fe-record')).toHaveText('Jane Doe');
    return editor;
}

const row = (editor, logicalName) => editor.locator('.fe-tr').filter({ has: editor.page().locator('.fe-logical', { hasText: new RegExp(`^${logicalName}$`) }) });

test.describe('Record Editor', () => {
    test('shows every readable column with its formatted value', async ({ page, org }) => {
        contactOrg(org);
        const editor = await openEditor(page, org);
        await expect(row(editor, 'firstname')).toContainText('Jane');
        await expect(row(editor, 'preferredcontactmethodcode')).toContainText('Any');
        await expect(row(editor, 'preferredcontactmethodcode').locator('.fe-raw')).toHaveText('1');
        await expect(row(editor, 'parentcustomerid')).toContainText('Fabrikam Ltd');
        await expect(row(editor, 'fullname').locator('.fe-type')).toContainText('🔒');
        // A lookup's companion name column is not a column of its own.
        await expect(row(editor, 'parentcustomeridname')).toHaveCount(0);
    });

    test('saves a text edit and a choice change in one PATCH', async ({ page, org }) => {
        contactOrg(org);
        const editor = await openEditor(page, org);

        await row(editor, 'firstname').locator('.fe-val.editable').click();
        const text = row(editor, 'firstname').locator('.fe-edit input');
        await text.fill('Janet');
        await text.press('Tab');

        await row(editor, 'preferredcontactmethodcode').locator('.fe-val.editable').click();
        await row(editor, 'preferredcontactmethodcode').locator('.fe-edit').getByText('Email', { exact: true }).click();

        await expect(editor.locator('.fe-pending')).toHaveText('2 pending changes');
        await editor.getByRole('button', { name: 'Save Changes' }).click();
        await expect(editor.locator('.fe-msg.success')).toContainText('Saved 2 changes');

        const [patch] = org.calls('PATCH', `/contacts(${CONTACT})`);
        expect(patch.body).toEqual({ firstname: 'Janet', preferredcontactmethodcode: 2 });
    });

    test('clears a lookup through its navigation property', async ({ page, org }) => {
        contactOrg(org);
        const editor = await openEditor(page, org);
        await row(editor, 'parentcustomerid').locator('.fe-val.editable').click();
        await row(editor, 'parentcustomerid').getByRole('button', { name: 'Set Null' }).click();
        await editor.getByRole('button', { name: 'Save Changes' }).click();
        await expect(editor.locator('.fe-msg.success')).toBeVisible();
        expect(org.calls('PATCH', `/contacts(${CONTACT})`)[0].body).toEqual({ parentcustomerid_account: null });
    });

    test('shows Dataverse\'s own message when the save is refused', async ({ page, org, problems }) => {
        contactOrg(org);
        org.on('PATCH', `/contacts(${CONTACT})`, () => ({
            status: 400, json: { error: { code: '0x80040265', message: 'First Name cannot be "Janet" on a Tuesday.' } },
        }));
        const editor = await openEditor(page, org);
        await row(editor, 'firstname').locator('.fe-val.editable').click();
        await row(editor, 'firstname').locator('.fe-edit input').fill('Janet');
        await row(editor, 'firstname').locator('.fe-edit input').press('Tab');
        await editor.getByRole('button', { name: 'Save Changes' }).click();
        await expect(editor.locator('.fe-msg.error')).toHaveText('First Name cannot be "Janet" on a Tuesday.');
        // The edit is kept to try again.
        await expect(editor.locator('.fe-pending')).toHaveText('1 pending change');
        problems.failedRequests.length = 0; // the 400 is the point of this test
    });

    test('asks before discarding pending changes', async ({ page, org }) => {
        contactOrg(org);
        const editor = await openEditor(page, org);
        await row(editor, 'firstname').locator('.fe-val.editable').click();
        await row(editor, 'firstname').locator('.fe-edit input').fill('Janet');
        await row(editor, 'firstname').locator('.fe-edit input').press('Tab');
        await editor.getByRole('button', { name: 'Close', exact: true }).click();
        const confirm = page.locator('.ppt-dialog', { hasText: 'Discard 1 pending change?' });
        await confirm.getByRole('button', { name: 'Cancel' }).click();
        await expect(editor).toBeVisible();
        await editor.getByRole('button', { name: 'Close', exact: true }).click();
        await page.locator('.ppt-dialog').getByRole('button', { name: 'Discard' }).click();
        await expect(editor).toBeHidden();
        expect(org.calls('PATCH', `/contacts(${CONTACT})`)).toHaveLength(0);
    });
});
