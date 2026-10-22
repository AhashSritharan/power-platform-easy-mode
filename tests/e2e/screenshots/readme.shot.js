// The README's screenshots: each tool against the mock tests' fake orgs, so
// every name in them is a placeholder and they can be taken again whenever the
// UI changes. `npm run screenshots` writes them to docs/screenshots/.
//
// Images are not read by the sensitive-data scan — which is why they come
// from here and never from a real environment.
import { test as mock, expect, gotoOrg } from '../mock/fixtures.js';
import { FakeOrg, guid, dependencyRows } from '../mock/fake-dataverse.js';
import { runCommand, openPalette } from '../support/helpers.js';
import { ROOT } from '../support/env.js';
import { join } from 'node:path';

const OUT = join(ROOT, 'docs', 'screenshots');
const FV = '@OData.Community.Display.V1.FormattedValue';
const LOOKUP = '@Microsoft.Dynamics.CRM.lookuplogicalname';
const MAPPINGS = 'vals/environment-indicator/envIndicator_mappings';
const HOSTS = 'vals/environment-indicator/envIndicator_hostCache';

// Orgs named the way a real tenant's are, so the environment lists read as one project.
const test = mock.extend({
    org: async ({ fakeOrgs }, use) => {
        const org = new FakeOrg('contoso-dev.crm4.dynamics.com', { name: 'Contoso Sales DEV' });
        fakeOrgs.set(org.host, org);
        await use(org);
    },
    targetOrg: async ({ fakeOrgs }, use) => {
        const org = new FakeOrg('contoso.crm4.dynamics.com', { name: 'Contoso Sales', environmentId: guid(1904) });
        fakeOrgs.set(org.host, org);
        await use(org);
    },
});

const shot = (locator, name) => locator.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled' });
// A toast left over from loading has nothing to say about the tool.
const dismissToasts = (page) => page.locator('.ppt-toast').evaluateAll((els) => els.forEach((e) => e.remove()));
const pageShot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled' });

// The stub main.aspx says "Fake Dynamics 365"; behind a palette or badge it
// should look like a page someone works in.
async function dressStub(page, title) {
    await page.evaluate((t) => {
        document.title = t;
        const top = document.getElementById('topBar');
        top.style.background = '#0f1b2d';
        document.querySelector('[data-id="dynamics-button"]').style.cssText = 'background:none;border:0;color:#fff;font:600 15px Segoe UI, sans-serif';
        const main = document.getElementById('mainContent');
        main.style.cssText = 'padding:24px 32px;font:14px Segoe UI, sans-serif;color:#242424;background:#faf9f8;height:calc(100vh - 48px);box-sizing:border-box';
        main.innerHTML = `<div style="font-size:20px;font-weight:600;margin-bottom:16px">${t}</div>`
            + '<div style="background:#fff;border:1px solid #e1dfdd;border-radius:4px">'
            + ['Maria Campbell', 'John Glynn', 'Nancy Anderson', 'Rene Valdes', 'Patrick Sands', 'Susan Burk', 'Paul Cannon']
                .map((n, i) => `<div style="padding:12px 16px;border-top:${i ? '1px solid #edebe9' : '0'}">${n}</div>`).join('')
            + '</div>';
    }, title);
}

async function labelEnvironments(serviceWorker, org, targetOrg) {
    await serviceWorker.evaluate(({ mappings, hosts, M, H }) => chrome.storage.local.set({ [M]: mappings, [H]: hosts }), {
        M: MAPPINGS, H: HOSTS,
        mappings: {
            [org.environmentId]: { type: 'DEV', name: 'Contoso Sales DEV', nameSource: 'org' },
            [targetOrg.environmentId]: { type: 'PROD', name: 'Contoso Sales', nameSource: 'org' },
            [guid(1903)]: { type: 'TEST', name: 'Contoso Sales TEST', nameSource: 'org' },
        },
        hosts: { [org.host]: org.environmentId, [targetOrg.host]: targetOrg.environmentId },
    });
}

test.describe('README screenshots', () => {
    test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1280, height: 800 }); });

    test('command palette', async ({ page, org, targetOrg, serviceWorker }) => {
        await labelEnvironments(serviceWorker, org, targetOrg);
        await gotoOrg(page, org);
        await page.setViewportSize({ width: 1280, height: 960 });
        await dressStub(page, 'Active Contacts');
        await openPalette(page);
        await pageShot(page, 'palette');
    });

    test('setup', async ({ page, org, targetOrg, extensionId, serviceWorker }) => {
        await page.goto(`chrome-extension://${extensionId}/welcome/welcome.html`);
        await expect(page.getByRole('heading', { name: 'Choose your tools' })).toBeVisible();
        await expect(page.locator('.tool').filter({ has: page.locator('.name', { hasText: 'Record Browser' }) })).toBeVisible();
        await page.setViewportSize({ width: 1280, height: 1000 });
        await pageShot(page, 'setup-tools');

        await labelEnvironments(serviceWorker, org, targetOrg);
        await page.goto(`chrome-extension://${extensionId}/welcome/welcome.html#environments`);
        await expect(page.locator('.env-row').first()).toBeVisible();
        await page.screenshot({ path: join(OUT, 'setup-environments.png'), clip: { x: 0, y: 0, width: 1280, height: 680 }, animations: 'disabled' });
    });

    test('environment indicator', async ({ page, org, targetOrg, serviceWorker }) => {
        await labelEnvironments(serviceWorker, org, targetOrg);
        await gotoOrg(page, org);
        await dressStub(page, 'Active Contacts');
        const badge = page.locator('body > div.ppt[data-env-type]');
        await expect(badge).toHaveText('🔧 DEV');
        await page.screenshot({ path: join(OUT, 'environment-badge.png'), clip: { x: 0, y: 0, width: 640, height: 120 }, animations: 'disabled' });
        await badge.click();
        const dialog = page.locator('.ppt-dialog', { hasText: '🏷️ Environment Indicator' });
        await expect(dialog.locator('.env-row').first()).toBeVisible();
        await shot(dialog, 'environment-indicator');
    });

    test('record browser and editor', async ({ page, org }) => {
        const VIEW = {
            savedqueryid: guid(401), name: 'Active Contacts', returnedtypecode: 'contact', querytype: 0, isdefault: true,
            fetchxml: '<fetch version="1.0" mapping="logical"><entity name="contact"><attribute name="fullname" /><order attribute="fullname" descending="false" /><attribute name="parentcustomerid" /><filter type="and"><condition attribute="statecode" operator="eq" value="0" /></filter><attribute name="telephone1" /><attribute name="emailaddress1" /><attribute name="contactid" /></entity></fetch>',
            layoutxml: '<grid name="resultset" object="2" jump="fullname" select="1" icon="1" preview="1"><row name="result" id="contactid"><cell name="fullname" width="300" /><cell name="emailaddress1" width="150" /><cell name="parentcustomerid" width="150" /><cell name="telephone1" width="125" /></row></grid>',
        };
        org.table('savedqueries', [VIEW]);
        org.entity({ logicalName: 'account', primaryName: 'name', displayName: 'Account', attributes: [{ name: 'name', type: 'String', label: 'Account Name' }], rows: [] });
        org.entity({ logicalName: 'systemuser', primaryName: 'fullname', displayName: 'User', attributes: [{ name: 'fullname', type: 'String', label: 'Full Name' }], rows: [{ systemuserid: org.userId, fullname: 'Jane Admin' }] });
        const people = [
            ['Maria Campbell', 'Contoso', 2], ['John Glynn', 'Fabrikam', 1], ['Nancy Anderson', 'Adventure Works', 3],
            ['Rene Valdes', 'Contoso', 1], ['Patrick Sands', 'Litware', 2], ['Susan Burk', 'Fabrikam', 3],
            ['Paul Cannon', 'Northwind Traders', 1], ['Sidney Higa', 'Contoso', 2], ['Scott Konersmann', 'Adventure Works', 2],
            ['Robert Lyon', 'Litware', 1], ['Yvonne McKay', 'Fabrikam', 3], ['Thomas Andersen', 'Northwind Traders', 2],
        ];
        const METHODS = { 1: 'Any', 2: 'Email', 3: 'Phone' };
        org.entity({
            logicalName: 'contact', primaryName: 'fullname', displayName: 'Contact',
            attributes: [
                { name: 'contactid', type: 'Uniqueidentifier', label: 'Contact', updatable: false },
                { name: 'fullname', type: 'String', label: 'Full Name', updatable: false },
                { name: 'firstname', type: 'String', label: 'First Name' },
                { name: 'lastname', type: 'String', label: 'Last Name' },
                { name: 'jobtitle', type: 'String', label: 'Job Title' },
                { name: 'emailaddress1', type: 'String', label: 'Email' },
                { name: 'telephone1', type: 'String', label: 'Business Phone' },
                { name: 'donotemail', type: 'Boolean', label: 'Do not allow Emails', options: ['Allow', 'Do Not Allow'] },
                { name: 'preferredcontactmethodcode', type: 'Picklist', label: 'Preferred Method of Contact', options: [[1, 'Any'], [2, 'Email'], [3, 'Phone']] },
                { name: 'parentcustomerid', type: 'Customer', label: 'Company Name', targets: { account: 'parentcustomerid_account' } },
                { name: 'parentcustomeridname', type: 'String', attributeOf: 'parentcustomerid', updatable: false },
                { name: 'ownerid', type: 'Owner', label: 'Owner', targets: { systemuser: 'ownerid' } },
                { name: 'statecode', type: 'State', label: 'Status', options: [[0, 'Active'], [1, 'Inactive']] },
            ],
            rows: people.map(([fullname, company, method], i) => {
                const [firstname, lastname] = fullname.split(' ');
                return {
                    '@odata.etag': `W/"${i + 1}"`, contactid: guid(100 + i), fullname, firstname, lastname,
                    jobtitle: ['Purchasing Manager', 'Owner', 'Sales Lead', 'IT Director'][i % 4],
                    emailaddress1: `${firstname.toLowerCase()}@${company.toLowerCase().replace(/ /g, '')}.example`,
                    telephone1: `+41 44 000 ${String(1200 + i * 37).padStart(4, '0')}`,
                    donotemail: false, [`donotemail${FV}`]: 'Allow',
                    preferredcontactmethodcode: method, [`preferredcontactmethodcode${FV}`]: METHODS[method],
                    _parentcustomerid_value: guid(500 + i), [`_parentcustomerid_value${FV}`]: company, [`_parentcustomerid_value${LOOKUP}`]: 'account',
                    '_parentcustomerid_value@Microsoft.Dynamics.CRM.associatednavigationproperty': 'parentcustomerid_account',
                    _ownerid_value: org.userId, [`_ownerid_value${FV}`]: 'Jane Admin', [`_ownerid_value${LOOKUP}`]: 'systemuser',
                    statecode: 0, [`statecode${FV}`]: 'Active',
                };
            }),
        });

        await gotoOrg(page, org, `pagetype=entitylist&etn=contact&viewid=${VIEW.savedqueryid}&viewtype=1039`);
        await runCommand(page, 'Browse Records');
        const browser = page.locator('.rb-panel');
        await expect(browser.locator('.grid-status')).toContainText('12 of 12 records');
        await shot(browser, 'record-browser');

        await gotoOrg(page, org, `pagetype=entityrecord&etn=contact&id=${guid(100)}`);
        await runCommand(page, 'Edit Record Values');
        const editor = page.locator('.fe-modal');
        await expect(editor.locator('.fe-record')).toHaveText('Maria Campbell');
        const row = (name) => editor.locator('.fe-tr').filter({ has: page.locator('.fe-logical', { hasText: new RegExp(`^${name}$`) }) });
        await row('jobtitle').locator('.fe-val.editable').click();
        await row('jobtitle').locator('.fe-edit input').fill('Head of Purchasing');
        await row('jobtitle').locator('.fe-edit input').press('Tab');
        await expect(editor.locator('.fe-pending')).toHaveText('1 pending change');
        await shot(editor, 'record-editor');
    });

    test('deep clone', async ({ page, org }) => {
        const ACCOUNT = guid(301);
        const system = (n) => ({
            '@odata.etag': `W/"${n}"`, createdon: '2026-09-01T08:00:00Z', modifiedon: '2026-09-02T08:00:00Z', versionnumber: n,
            _ownerid_value: org.userId, [`_ownerid_value${LOOKUP}`]: 'systemuser', [`_ownerid_value${FV}`]: 'Jane Admin',
        });
        org.entity({
            logicalName: 'account', primaryName: 'name', displayName: 'Account',
            attributes: [{ name: 'name', type: 'String', label: 'Account Name' }, { name: 'revenue', type: 'Money', label: 'Annual Revenue' }],
            oneToMany: [{ schemaName: 'contact_customer_accounts', navigation: 'contact_customer_accounts', entity: 'contact', attribute: 'parentcustomerid' }],
            rows: [{ ...system(1), accountid: ACCOUNT, name: 'Contoso', revenue: 5000000 }],
        });
        const contact = (n, firstname, lastname) => ({
            ...system(n), contactid: guid(310 + n), firstname, lastname, fullname: `${firstname} ${lastname}`,
            _parentcustomerid_value: ACCOUNT, [`_parentcustomerid_value${LOOKUP}`]: 'account', [`_parentcustomerid_value${FV}`]: 'Contoso',
        });
        org.entity({
            logicalName: 'contact', primaryName: 'fullname', displayName: 'Contact',
            attributes: [{ name: 'firstname', type: 'String' }, { name: 'lastname', type: 'String' }, { name: 'fullname', type: 'String', updatable: false },
                { name: 'parentcustomerid', type: 'Customer', targets: { account: 'parentcustomerid_account' } }],
            rows: [contact(2, 'Maria', 'Campbell'), contact(3, 'Rene', 'Valdes'), contact(4, 'Sidney', 'Higa')],
        });
        org.entity({ logicalName: 'systemuser', primaryName: 'fullname', rows: [] });

        await gotoOrg(page, org, `pagetype=entityrecord&etn=account&id=${ACCOUNT}`);
        await runCommand(page, 'Clone Record');
        const dialog = page.locator('.dc-modal');
        await dialog.locator('.dc-seg-item', { hasText: '📋 Deep Clone' }).click();
        const contacts = dialog.locator('.dc-rel', { hasText: 'contact_customer_accounts' });
        await expect(contacts.locator('.count')).toHaveText('3 records');
        await contacts.locator('input[type=checkbox]').check();
        await shot(dialog, 'deep-clone');
    });

    test('audit history', async ({ page, org }) => {
        const CONTACT = guid(601);
        const ADMIN = guid(603);
        org.entity({ logicalName: 'account', primaryName: 'name', displayName: 'Account', attributes: [{ name: 'name', type: 'String' }], rows: [{ accountid: guid(602), name: 'Fabrikam' }] });
        org.entity({
            logicalName: 'contact', primaryName: 'fullname', displayName: 'Contact',
            attributes: [
                { name: 'firstname', type: 'String', label: 'First Name' },
                { name: 'jobtitle', type: 'String', label: 'Job Title' },
                { name: 'preferredcontactmethodcode', type: 'Picklist', label: 'Preferred Method of Contact', options: [[1, 'Any'], [2, 'Email', '#0078d4']] },
                { name: 'parentcustomerid', type: 'Customer', label: 'Company Name', targets: { account: 'parentcustomerid_account' } },
                { name: 'donotemail', type: 'Boolean', label: 'Do not allow Emails' },
            ],
            rows: [{ contactid: CONTACT, fullname: 'Maria Campbell' }],
        });
        org.entity({ logicalName: 'systemuser', primaryName: 'fullname', displayName: 'User', attributes: [], rows: [{ systemuserid: org.userId, fullname: 'Jane Admin' }, { systemuserid: ADMIN, fullname: 'Integration User' }] });
        const audit = (n, createdon, operation, changes, by = org.userId) => ({
            auditid: guid(700 + n), createdon, operation, [`operation${FV}`]: { 1: 'Create', 2: 'Update' }[operation], action: operation, objecttypecode: 'contact',
            _objectid_value: CONTACT, [`_objectid_value${FV}`]: 'Maria Campbell', [`_objectid_value${LOOKUP}`]: 'contact',
            _userid_value: by, [`_userid_value${FV}`]: by === org.userId ? 'Jane Admin' : 'Integration User',
            _callinguserid_value: org.userId, [`_callinguserid_value${FV}`]: 'Jane Admin',
            changedata: JSON.stringify({ changedAttributes: changes }),
        });
        org.table('audits', [
            audit(1, '2026-10-14T09:30:00Z', 2, [
                { logicalName: 'jobtitle', oldValue: 'Buyer', newValue: 'Purchasing Manager' },
                { logicalName: 'parentcustomerid', oldValue: null, newValue: `account,${guid(602)}` },
                { logicalName: 'donotemail', oldValue: 'False', newValue: 'True' },
                { logicalName: 'preferredcontactmethodcode', oldValue: '1', newValue: '2', oldName: 'Any', newName: 'Email' },
            ], ADMIN),
            audit(2, '2026-10-03T14:12:00Z', 2, [{ logicalName: 'firstname', oldValue: 'Marie', newValue: 'Maria' }]),
            audit(3, '2026-10-01T08:00:00Z', 1, []),
        ]);
        await gotoOrg(page, org, `pagetype=entityrecord&etn=contact&id=${CONTACT}`);
        await runCommand(page, 'Open Audit History');
        const panel = page.locator('.audit-panel');
        await expect(panel).toContainText('Showing 1–3 of 3 audit entries');
        await shot(panel, 'audit-history');
    });

    // A source org whose Core solution exports, and a target missing two of its dependencies.
    async function deployerOrgs(org, targetOrg, serviceWorker) {
        await labelEnvironments(serviceWorker, org, targetOrg);
        const SOLUTION = { solutionid: guid(11), uniquename: 'Core', friendlyname: 'Core Solution', version: '1.4.2.0', ismanaged: false, isvisible: true, modifiedon: '2026-10-01T08:00:00Z' };
        org.table('solutions', [SOLUTION, { ...SOLUTION, solutionid: guid(13), uniquename: 'Reporting', friendlyname: 'Reporting', version: '2.0.0.0' }]);
        org.on('POST', '/ExportSolutionAsync', () => ({ AsyncOperationId: guid(21), ExportJobId: guid(22) }));
        org.table('asyncoperations', [{ asyncoperationid: guid(21), statecode: 3, statuscode: 30 }]);
        org.on('POST', '/DownloadSolutionExportData', () => ({ ExportSolutionFile: 'UEsDBBQAAAAIAFRFakeSolutionZip==' }));
        org.table('solutioncomponents', []);
        org.on('GET', '/RetrieveRequiredComponents*', dependencyRows('required', {}));
        org.on('GET', '/RetrieveMissingDependenciesWithMetadata*', () => ({ value: [] }));
        targetOrg.table('solutions', [{ ...SOLUTION, solutionid: guid(12) }]);
        targetOrg.table('msdyn_solutioncomponentsummaries', []);
        const detail = (tag, c) => `<b:${tag}><b:DisplayName>${c.name}</b:DisplayName><b:Id>${c.id}</b:Id><b:ParentDisplayName i:nil="true"/><b:ParentId>00000000-0000-0000-0000-000000000000</b:ParentId><b:ParentSchemaName i:nil="true"/><b:SchemaName>${c.name}</b:SchemaName><b:Solution>Active</b:Solution><b:Type>${c.type}</b:Type></b:${tag}>`;
        const missing = [
            { required: { id: guid(91), name: 'cr123_invoice', type: 1 }, dependent: { id: guid(92), name: 'Invoice main form', type: 60 } },
            { required: { id: guid(93), name: 'cr123_region', type: 9 }, dependent: { id: guid(94), name: 'cr123_account_region', type: 2 } },
        ];
        targetOrg.on('POST', '/XRMServices/2011/Organization.svc/web', () => ({
            contentType: 'text/xml',
            body: '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><ExecuteResponse xmlns="http://schemas.microsoft.com/xrm/2011/Contracts/Services"><ExecuteResult i:type="b:RetrieveMissingComponentsResponse" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns:b="http://schemas.microsoft.com/crm/2011/Contracts">'
                + '<a:ResponseName>RetrieveMissingComponents</a:ResponseName><a:Results xmlns:c="http://schemas.datacontract.org/2004/07/System.Collections.Generic"><a:KeyValuePairOfstringanyType><c:key>MissingComponents</c:key>'
                + `<c:value i:type="b:ArrayOfMissingComponent">${missing.map((m) => `<b:MissingComponent>${detail('DependentComponent', m.dependent)}${detail('RequiredComponent', m.required)}</b:MissingComponent>`).join('')}</c:value>`
                + '</a:KeyValuePairOfstringanyType></a:Results></ExecuteResult></ExecuteResponse></s:Body></s:Envelope>',
        }));
    }

    async function openDeployer(page, org) {
        await gotoOrg(page, org);
        await runCommand(page, 'Open Solution Deployer');
        return page.locator('.sd-panel');
    }

    test('solution deployer', async ({ page, org, targetOrg, serviceWorker }) => {
        await deployerOrgs(org, targetOrg, serviceWorker);
        const panel = await openDeployer(page, org);
        await panel.getByRole('button', { name: '📦 Select a solution…' }).click();
        await page.locator('.sd-modal .sd-item', { hasText: 'Core Solution' }).click();
        await expect(panel.getByText('Selected:')).toBeVisible();
        await panel.getByRole('button', { name: 'Next: Choose Target →' }).click();
        const to = panel.getByPlaceholder('https://yourorg.crm.dynamics.com');
        await to.fill(targetOrg.origin);
        await to.press('Tab');
        await shot(panel, 'solution-deployer');
    });

    test('dependency check', async ({ page, org, targetOrg, serviceWorker }) => {
        await deployerOrgs(org, targetOrg, serviceWorker);
        const panel = await openDeployer(page, org);
        await panel.getByRole('button', { name: '🔍 Check Deps' }).click();
        await panel.getByRole('button', { name: '📦 Select a solution…' }).click();
        await page.locator('.sd-modal .sd-item', { hasText: 'Core Solution' }).click();
        const target = panel.getByPlaceholder('https://yourorg.crm.dynamics.com');
        await target.fill(targetOrg.origin);
        await target.press('Tab');
        await panel.locator('.sd-footer').getByRole('button', { name: '🔍 Check Dependencies' }).click();
        await expect(panel).toContainText('2 missing dependencies found', { timeout: 20_000 });
        await shot(panel, 'dependency-check');
    });

    test('solution history', async ({ page, org }) => {
        const log = (ok, code = '0', text = '') => `<importexportxml progress="100" processed="true" errorcode="${code}" succeeded="${ok ? 'success' : 'failure'}" status="${ok ? 'Succeeded' : 'Failed'}"><solutionManifests><solutionManifest languagecode="1033" id="Core" processed="true"><UniqueName>Core</UniqueName><results /><result result="${ok ? 'success' : 'failure'}" errorcode="${code}" errortext="${text}" datetime="10:00:00.00" /></solutionManifest></solutionManifests></importexportxml>`;
        const job = (n, solutionname, d, minutes, ok = true) => {
            const day = String(d).padStart(2, '0');
            return {
            importjobid: guid(800 + n), solutionname, name: 'Customizations', progress: 100,
            createdon: `2026-10-${day}T09:00:00Z`, startedon: `2026-10-${day}T09:00:01Z`, completedon: `2026-10-${day}T09:${String(minutes).padStart(2, '0')}:00Z`, modifiedon: `2026-10-${day}T09:${String(minutes).padStart(2, '0')}:00Z`,
            data: ok ? log(true) : log(false, '0x8004f01f', `The dependent component Workflow (Id=${guid(803)}) does not exist.`),
            };
        };
        org.table('importjobs', [job(1, 'Core', 15, 4), job(2, 'Reporting', 14, 2, false), job(3, 'Core', 12, 3), job(4, 'Integrations', 9, 7), job(5, 'Core', 7, 3)]);
        org.table('msdyn_solutionhistories', []);
        org.table('exportsolutionuploads', []);
        await gotoOrg(page, org);
        await runCommand(page, 'Open Solution History');
        const panel = page.locator('.sh-panel');
        await expect(panel.locator('.sim-table tbody tr')).toHaveCount(5);
        await shot(panel, 'solution-history');
    });

    test('add existing components', async ({ page, org }) => {
        const DEFAULT = 'fd140aaf-4df4-11dd-bd17-0019b9312238';
        const CORE = guid(901);
        org.table('solutions', [
            { solutionid: CORE, uniquename: 'Core', friendlyname: 'Core Solution', version: '1.0.0.0', ismanaged: false, isvisible: true },
            { solutionid: DEFAULT, uniquename: 'Default', friendlyname: 'Default Solution', version: '1.0', ismanaged: false, isvisible: true },
        ]);
        org.table('solutioncomponentdefinitions', []);
        org.table('msdyn_solutioncomponentsummaries', ['scripts/account_form.js', 'scripts/contact_form.js', 'scripts/ribbon.js', 'scripts/invoice.js', 'styles/site.css', 'images/logo.svg', 'html/help.html', 'scripts/common.js']
            .map((name, i) => ({
                msdyn_objectid: guid(910 + i), msdyn_solutionid: DEFAULT, msdyn_componenttype: 61, msdyn_componenttypename: 'Web Resource',
                msdyn_name: `cr123_/${name}`, msdyn_displayname: name.split('/').pop(), msdyn_iscustomizable: true, msdyn_ismanaged: false,
                msdyn_modifiedon: `2026-10-${String(1 + i * 2).padStart(2, '0')}T08:00:00.000Z`, msdyn_owner: 'Jane Admin',
            })));
        org.table('solutioncomponents', [{ solutioncomponentid: guid(950), _solutionid_value: CORE, componenttype: 61, objectid: guid(910) }]);
        await gotoOrg(page, org);
        await runCommand(page, 'Add Existing Components (filterable)');
        const panel = page.locator('.grid-panel').last();
        await expect(panel.locator('.grid-status')).toContainText('loaded');
        await panel.locator('select').first().selectOption(CORE);
        await expect(panel.locator('tbody tr', { hasText: 'account_form.js' })).toContainText('in solution');
        await panel.locator('tbody tr', { hasText: 'ribbon.js' }).click();
        await panel.locator('tbody tr', { hasText: 'invoice.js' }).click();
        await shot(panel, 'add-existing');
    });

    test('cloud flow manager', async ({ page, org }) => {
        const SOLUTION_ID = guid(201);
        org.table('solutions', [{ solutionid: SOLUTION_ID, uniquename: 'Core', friendlyname: 'Core Solution', version: '1.0.0.0', ismanaged: false, isvisible: true }]);
        const flows = [['Sync accounts', true, 'embedded'], ['Notify approver', false, 'invoker'], ['Archive invoices', false, 'embedded'],
            ['Send weekly report', true, 'embedded'], ['Create follow-up tasks', true, 'embedded'], ['Import price list', false, 'embedded']];
        org.table('msdyn_solutioncomponentsummaries', flows.map(([name, on], i) => ({
            msdyn_objectid: guid(210 + i), msdyn_solutionid: SOLUTION_ID, msdyn_name: name, msdyn_displayname: name, msdyn_description: '',
            msdyn_componenttype: 29, msdyn_componenttypename: 'Process', msdyn_componentlogicalname: 'workflow',
            msdyn_workflowcategory: 5, msdyn_workflowcategoryname: 'Modern Flow', msdyn_typename: 'Definition',
            msdyn_status: on ? 1 : 0, msdyn_statusname: on ? 'Activated' : 'Draft', msdyn_standardstatus: 0,
            msdyn_ismanaged: false, msdyn_ismanagedname: 'Unmanaged', msdyn_owner: 'Jane Admin',
            msdyn_modifiedon: '2026-10-01T08:00:00.000Z', msdyn_primaryidattribute: 'workflowid', msdyn_total: flows.length,
        })));
        org.table('workflows', flows.map(([name, on, runtimeSource], i) => ({
            workflowid: guid(210 + i), name, statecode: on ? 1 : 0, statuscode: on ? 2 : 1,
            clientdata: JSON.stringify({ properties: { connectionReferences: { shared_commondataserviceforapps: { api: { name: 'shared_commondataserviceforapps' }, runtimeSource } } } }),
        })));
        await gotoOrg(page, org);
        await runCommand(page, 'Open Cloud Flow Manager');
        const panel = page.locator('.cfm-panel');
        await panel.locator('[data-f=solution]').selectOption(SOLUTION_ID);
        await panel.locator('[data-act=load]').click();
        await expect(panel.locator('tbody tr')).toHaveCount(flows.length);
        await dismissToasts(page);
        await shot(panel, 'cloud-flow-manager');
    });

    test('flow run monitor', async ({ page, org }) => {
        const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
        const FLOWS = { sync: [guid(1001), 'Sync accounts'], notify: [guid(1002), 'Notify approver'], report: [guid(1003), 'Send weekly report'] };
        const run = (n, [flow, flowName], status, h, code = '', message = '') => ({
            flowrunid: guid(1100 + n), name: `08584${String(n).padStart(15, '0')}CU00`, status, [`status${FV}`]: status,
            starttime: hoursAgo(h), endtime: hoursAgo(h - 0.01), duration: 2000 + n * 700, triggertype: 'Automated', modernflowtype: 0,
            errorcode: code, errormessage: message ? JSON.stringify({ error: { code, message } }) : '',
            _workflow_value: flow, [`_workflow_value${FV}`]: flowName, workflowid: flow, parentrunid: null,
            _ownerid_value: guid(1199), [`_ownerid_value${FV}`]: 'Jane Admin',
        });
        const BAD = 'Unable to process template language expressions in action \'Send_an_email\'.';
        org.table('flowruns', [
            run(1, FLOWS.sync, 'Succeeded', 1), run(2, FLOWS.notify, 'Failed', 2, 'InvalidTemplate', BAD), run(3, FLOWS.sync, 'Succeeded', 5),
            run(4, FLOWS.report, 'Succeeded', 9), run(5, FLOWS.notify, 'Failed', 20, 'InvalidTemplate', BAD), run(6, FLOWS.sync, 'Succeeded', 26),
            run(7, FLOWS.notify, 'Succeeded', 30), run(8, FLOWS.sync, 'Failed', 50, 'ConnectionAuthorizationFailed', 'The caller with object id does not have permission for connection.'),
            run(9, FLOWS.report, 'Succeeded', 80), run(10, FLOWS.sync, 'Succeeded', 100),
        ]);
        org.table('workflows', Object.values(FLOWS).map(([workflowid, name]) => ({ workflowid, name, category: 5 })));
        await gotoOrg(page, org);
        await runCommand(page, 'Open Flow Run Monitor');
        const panel = page.locator('.frm-panel');
        await expect(panel.locator('.frm-loading')).toHaveCount(0);
        await expect(panel.locator('.frm-table tbody tr[data-runid]')).toHaveCount(10);
        await shot(panel, 'flow-run-monitor');
    });

    test('find all references and expression validator', async ({ page, org, serviceWorker, portal }) => {
        const FLOW = guid(1501);
        const definition = {
            $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
            contentVersion: '1.0.0.0',
            triggers: { manual: { type: 'Request', kind: 'Button', inputs: { schema: { type: 'object', properties: {} } } } },
            actions: {
                Initialize_total: { type: 'InitializeVariable', runAfter: {}, inputs: { variables: [{ name: 'Total', type: 'integer', value: 0 }] } },
                List_invoices: { type: 'OpenApiConnection', runAfter: { Initialize_total: ['Succeeded'] }, inputs: {} },
                Compose_total: { type: 'Compose', runAfter: { List_invoices: ['Succeeded'] }, inputs: "@length(body('List_invoices')?['value'])" },
                Compose_report: { type: 'Compose', runAfter: { Compose_total: ['Succeeded'] }, inputs: "Invoices: @{outputs('Compose_total')}, total @{variables('Total')}" },
                Send_summary: { type: 'Compose', runAfter: { Compose_report: ['Succeeded'] }, inputs: "@{outputs('Compose_reports')}" },
            },
        };
        org.table('workflows', [{ workflowid: FLOW, name: 'Invoice summary', category: 5, clientdata: JSON.stringify({ properties: { connectionReferences: {}, definition } }) }]);
        await serviceWorker.evaluate(({ host, envId, H }) => chrome.storage.local.set({ [H]: { [host]: envId } }), { host: org.host, envId: org.environmentId, H: HOSTS });
        const node = (id, title) => `<div class="react-flow__node react-flow__node-OPERATION_NODE selectable" data-id="${id}" data-testid="rf__node-${id}" aria-roledescription="node" style="margin:0 auto 28px;width:360px">`
            + `<div class="nopan" tabindex="0" role="group" aria-label="${title}"><div role="group" id="msla-node-${id}" data-testid="card-${title}" style="border:1px solid #c8c6c4;border-radius:6px;padding:12px 16px;background:#fff;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.1)">`
            + `<input id="${id}-title" data-automation-id="flow-card-title" value="${title}" readonly style="border:0;font:600 14px Segoe UI, sans-serif;width:100%;background:none"></div></div></div>`;
        portal.page(`<!doctype html><html><head><meta charset="utf-8"><title>Edit your flow | Power Automate</title></head><body style="margin:0;background:#f3f2f1;font-family:Segoe UI, sans-serif">
<div style="height:48px;background:#0f6cbd;color:#fff;display:flex;align-items:center;padding:0 16px;font-weight:600">Power Automate</div>
<div class="react-flow" style="padding:40px 0"><div class="react-flow__nodes">
${node('manual', 'Manually trigger a flow')}${node('Initialize_total', 'Initialize total')}${node('List_invoices', 'List invoices')}${node('Compose_total', 'Compose total')}${node('Compose_report', 'Compose report')}${node('Send_summary', 'Send summary')}
</div></div><div id="panel"></div>
<script>for (const card of document.querySelectorAll('[data-testid^="card-"]')) card.addEventListener('click', () => {
  document.getElementById('panel').innerHTML = '<div id="flow-node-details-panel-' + card.closest('.react-flow__node').dataset.id + '" data-automation-id="flow-node-details-panel"></div>';
});</script></body></html>`);
        await page.goto(`https://make.powerautomate.com/environments/${org.environmentId}/solutions/fd140aaf-4df4-11dd-bd17-0019b9312238/flows/${FLOW}`);
        await expect(page.locator('.ppt-launcher')).toBeVisible();

        await page.locator('[data-testid="card-Compose total"]').click();
        await page.keyboard.press('Shift+F12');
        const refs = page.locator('.fr-wrap');
        await expect(refs.locator('.fr-head .n')).toHaveText('▸ Compose_total');
        await dismissToasts(page);
        await page.screenshot({ path: join(OUT, 'find-all-references.png'), clip: { x: 0, y: 0, width: 1280, height: 540 }, animations: 'disabled' });
        await page.keyboard.press('Escape');

        await runCommand(page, 'Validate Flow Expressions');
        const results = page.locator('.ppt-dialog', { hasText: 'Expression Validation Results' });
        await expect(results.locator('h2')).toContainText('1 issue');
        await shot(results, 'expression-validator');
    });

    test('turned-off highlighter', async ({ page, portal }) => {
        const row = (i, name, type, status) => `<div role="row" data-item-index="${i}" data-automationid="DetailsRow" style="border-bottom:1px solid #edebe9">`
            + '<div data-automationid="DetailsRowFields" role="presentation" style="display:flex;padding:10px 16px;font:14px Segoe UI, sans-serif">'
            + `<div role="gridcell" data-automationid="DetailsRowCell" data-automation-key="displayName" style="width:320px"><a href="#" role="link" style="color:#0f6cbd;text-decoration:none">${name}</a></div>`
            + `<div role="gridcell" data-automationid="DetailsRowCell" data-automation-key="type" style="width:200px">${type}</div>`
            + `<div role="gridcell" data-automationid="DetailsRowCell" data-automation-key="status" style="width:120px"><div title="${status}">${status}</div></div>`
            + '</div></div>';
        portal.page(`<!doctype html><html><head><meta charset="utf-8"><title>Solutions | Power Apps</title></head><body style="margin:0;background:#fff">
<div style="height:48px;background:#742774;color:#fff;display:flex;align-items:center;padding:0 16px;font:600 15px Segoe UI, sans-serif">Power Apps</div>
<div style="padding:16px 16px 8px;font:600 20px Segoe UI, sans-serif">Core Solution</div>
<div role="grid"><div role="rowgroup">${[
        row(0, 'Sync accounts', 'Cloud flow', 'On'), row(1, 'Notify approver', 'Cloud flow', 'Off'), row(2, 'Archive invoices', 'Cloud flow', 'Off'),
        row(3, 'Send weekly report', 'Cloud flow', 'On'), row(4, 'Invoice', 'Table', ''), row(5, 'Region check', 'Business rule', 'Off'),
    ].join('')}</div></div></body></html>`);
        await page.goto(`https://make.powerapps.com/environments/${guid(1)}/solutions/${guid(2)}`);
        await expect(page.locator('.ppt-off-row')).toHaveCount(3);
        await page.screenshot({ path: join(OUT, 'turned-off-highlighter.png'), clip: { x: 0, y: 0, width: 760, height: 380 }, animations: 'disabled' });
    });
});
