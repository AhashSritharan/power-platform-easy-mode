// Record Browser against a fake org: it opens on the page's view (a live org's
// default contact view, copied verbatim), searches and sorts with FetchXML,
// pages through the rest, and hands a row to the Record Editor. The FetchXML
// itself is unit-tested in tests/unit/record-browser.test.mjs.
import { test, expect, gotoOrg } from './fixtures.js';
import { guid } from './fake-dataverse.js';
import { runCommand } from '../support/helpers.js';

const FV = '@OData.Community.Display.V1.FormattedValue';
// "My Active Contacts", fetchxml and layoutxml exactly as a live org has them.
const MY_ACTIVE_CONTACTS = {
    savedqueryid: guid(401), name: 'My Active Contacts', returnedtypecode: 'contact', querytype: 0, isdefault: true,
    fetchxml: '<fetch version="1.0" output-format="xml-platform" mapping="logical" savedqueryid="00000000-0000-0000-00aa-000010001003"><entity name="contact"><attribute name="fullname" /><order attribute="fullname" descending="false" /><attribute name="parentcustomerid" /><filter type="and"><condition attribute="ownerid" operator="eq-userid" /><condition attribute="statecode" operator="eq" value="0" /></filter><attribute name="telephone1" /><attribute name="emailaddress1" /><attribute name="contactid" /></entity></fetch>',
    layoutxml: '<grid name="resultset" object="2" jump="fullname" select="1" icon="1" preview="1"><row name="result" id="contactid"><cell name="fullname" width="300" /><cell name="emailaddress1" width="150" /><cell name="parentcustomerid" width="150" /><cell name="telephone1" width="125" /></row></grid>',
};

function contactsOrg(org, rows) {
    org.table('savedqueries', [MY_ACTIVE_CONTACTS]);
    org.entity({
        logicalName: 'account', primaryName: 'name', displayName: 'Account',
        attributes: [{ name: 'name', type: 'String', label: 'Account Name' }], rows: [],
    });
    org.entity({
        logicalName: 'systemuser', primaryName: 'fullname', displayName: 'User',
        attributes: [{ name: 'fullname', type: 'String', label: 'Full Name' }],
        rows: [{ systemuserid: org.userId, fullname: 'Me' }, { systemuserid: guid(999), fullname: 'Someone Else' }],
    });
    org.entity({
        logicalName: 'contact', primaryName: 'fullname', displayName: 'Contact',
        attributes: [
            { name: 'contactid', type: 'Uniqueidentifier', label: 'Contact', updatable: false },
            { name: 'fullname', type: 'String', label: 'Full Name', updatable: false },
            { name: 'firstname', type: 'String', label: 'First Name' },
            { name: 'emailaddress1', type: 'String', label: 'Email' },
            { name: 'telephone1', type: 'String', label: 'Business Phone' },
            { name: 'parentcustomerid', type: 'Customer', label: 'Company Name', targets: { account: 'parentcustomerid_account' } },
            { name: 'parentcustomeridname', type: 'String', attributeOf: 'parentcustomerid', updatable: false },
            { name: 'ownerid', type: 'Owner', label: 'Owner', targets: { systemuser: 'ownerid' } },
            { name: 'statecode', type: 'State', label: 'Status', options: [[0, 'Active'], [1, 'Inactive']] },
        ],
        rows,
    });
}

const contact = (org, n, fullname, { mine = true, active = true, company = null, email = null } = {}) => ({
    '@odata.etag': `W/"${n}"`, contactid: guid(n), fullname, firstname: fullname.split(' ')[0],
    emailaddress1: email, telephone1: `+41 44 000 ${String(n).padStart(4, '0')}`,
    _ownerid_value: mine ? org.userId : guid(999), [`_ownerid_value${FV}`]: mine ? 'Me' : 'Someone Else',
    '_ownerid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'systemuser',
    statecode: active ? 0 : 1, [`statecode${FV}`]: active ? 'Active' : 'Inactive',
    ...(company ? {
        _parentcustomerid_value: guid(500), [`_parentcustomerid_value${FV}`]: company,
        '_parentcustomerid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'account',
    } : {}),
});

async function openOnView(page, org) {
    await gotoOrg(page, org, `pagetype=entitylist&etn=contact&viewid=${MY_ACTIVE_CONTACTS.savedqueryid}&viewtype=1039`);
    await runCommand(page, 'Browse Records');
    const panel = page.locator('.rb-panel');
    await expect(panel.locator('.grid-status')).toContainText('records');
    return panel;
}

const names = (panel) => panel.locator('tbody tr td:nth-child(2)').allTextContents();

test.describe('Record Browser', () => {
    test('opens on the view the page shows: its filter, its columns first', async ({ page, org }) => {
        contactsOrg(org, [
            contact(org, 1, 'Maria Campbell', { email: 'maria@contoso.com' }),
            contact(org, 2, 'John Glynn', { company: 'Fabrikam' }),
            contact(org, 3, 'Ann Other', { mine: false }),
            contact(org, 4, 'Ian Active-Not', { active: false }),
        ]);
        const panel = await openOnView(page, org);
        await expect(panel.locator('.grid-chip')).toContainText('View: My Active Contacts');
        await expect.poll(() => names(panel)).toEqual(['John Glynn', 'Maria Campbell']);
        const headers = await panel.locator('thead th').allTextContents();
        expect(headers.slice(1, 5).map((h) => h.replace('⌄', '').trim())).toEqual(['Full Name', 'Email', 'Company Name', 'Business Phone']);
        await expect(panel.locator('tbody tr', { hasText: 'John Glynn' })).toContainText('Fabrikam');
        await expect(panel.locator('.grid-status')).toContainText('2 of 2 records');
    });

    test('removing the view\'s filter shows every record', async ({ page, org }) => {
        contactsOrg(org, [contact(org, 1, 'Maria Campbell'), contact(org, 3, 'Ann Other', { mine: false }), contact(org, 4, 'Ian Active-Not', { active: false })]);
        const panel = await openOnView(page, org);
        await expect.poll(() => names(panel)).toEqual(['Maria Campbell']);
        await panel.locator('.grid-chip', { hasText: 'View:' }).getByRole('button').click();
        await expect(panel.locator('tbody tr')).toHaveCount(3);
    });

    test('searches every column, and sorts from the column menu', async ({ page, org }) => {
        contactsOrg(org, [
            contact(org, 1, 'Maria Campbell', { email: 'maria@contoso.com' }),
            contact(org, 2, 'John Glynn', { company: 'Fabrikam' }),
            contact(org, 5, 'Zoe Fabrikam-Fan'),
        ]);
        const panel = await openOnView(page, org);
        await panel.getByPlaceholder('🔍 Search all columns…').fill('fabrikam');
        await expect(panel.locator('tbody tr')).toHaveCount(2); // a company name and a full name
        expect((await names(panel)).sort()).toEqual(['John Glynn', 'Zoe Fabrikam-Fan']);

        await panel.locator('thead .grid-th-btn', { hasText: 'Full Name' }).click();
        await page.locator('.grid-menu-item', { hasText: 'Sort Z to A' }).click();
        await expect.poll(() => names(panel)).toEqual(['Zoe Fabrikam-Fan', 'John Glynn']);
        const last = org.calls('GET', '/contacts').at(-1).query.get('fetchXml');
        expect(last).toContain('<order attribute="fullname" descending="true" />');
    });

    test('loads the next page with the paging cookie', async ({ page, org }) => {
        contactsOrg(org, Array.from({ length: 130 }, (_, i) => contact(org, 1000 + i, `Contact ${String(i).padStart(3, '0')}`)));
        const panel = await openOnView(page, org);
        await expect(panel.locator('tbody tr')).toHaveCount(100);
        await expect(panel.locator('.grid-status')).toContainText('100 of 130 records');
        await panel.getByRole('button', { name: '⬇ Load 100 more' }).click();
        await expect(panel.locator('tbody tr')).toHaveCount(130);
        const second = org.calls('GET', '/contacts').at(-1).query.get('fetchXml');
        expect(second).toContain('page="2"');
        expect(second).toContain('paging-cookie=');
    });

    test('a row opens in the Record Editor', async ({ page, org }) => {
        contactsOrg(org, [contact(org, 1, 'Maria Campbell')]);
        const panel = await openOnView(page, org);
        await panel.locator('tbody tr', { hasText: 'Maria Campbell' }).click();
        await expect(page.locator('.fe-modal .fe-record')).toHaveText('Maria Campbell');
    });
});
