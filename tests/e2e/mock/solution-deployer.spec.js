// Solution Deployer against fake orgs: deploy, dependency check and cleanup —
// the flows that write to a target environment and so cannot run live.
import { test, expect, gotoOrg } from './fixtures.js';
import { dependencyRows, guid } from './fake-dataverse.js';
import { runCommand } from '../support/helpers.js';

const SOLUTION = {
    solutionid: guid(11), uniquename: 'Core', friendlyname: 'Core Solution', version: '1.0.0.0',
    ismanaged: false, isvisible: true, modifiedon: '2026-10-01T08:00:00Z',
};
const EXPORTED_FILE = 'UEsDBBQAAAAIAFRFakeSolutionZip==';
// The import log's shape as a live org writes it to importjobs.data (trimmed:
// the real one also lists every component with a result of its own).
const importLog = ({ result, errorcode = '0', errortext = '' }) => `<importexportxml start="639276000000000000" stop="639276000100000000" progress="100" processed="true" errorcode="${errorcode}" succeeded="${result === 'success' ? 'success' : 'failure'}" status="${result === 'success' ? 'Succeeded' : 'Failed'}">`
    + '<solutionManifests><solutionManifest languagecode="1033" id="Core" LocalizedName="Core Solution" processed="true">'
    + '<UniqueName>Core</UniqueName><Version>1.0.0.0</Version><Managed>0</Managed><results />'
    + `<result result="${result}" errorcode="${errorcode}" errortext="${errortext}" datetime="10:00:00.00" datetimeticks="639276000100000000" />`
    + '</solutionManifest></solutionManifests></importexportxml>';
const SUCCESS_LOG = importLog({ result: 'success' });
const failureLog = (text) => importLog({ result: 'failure', errorcode: '0x8004f01f', errortext: text });

/** A source org that exports Core, and a target that imports whatever it is sent. */
function deployableOrgs(org, targetOrg, { importLog = SUCCESS_LOG } = {}) {
    org.table('solutions', [{ ...SOLUTION }]);
    org.on('POST', '/ExportSolutionAsync', () => ({ AsyncOperationId: guid(21), ExportJobId: guid(22) }));
    org.table('asyncoperations', [{ asyncoperationid: guid(21), statecode: 3, statuscode: 30 }]);
    org.on('POST', '/DownloadSolutionExportData', (req) => (req.body.ExportJobId === guid(22) ? { ExportSolutionFile: EXPORTED_FILE } : undefined));

    targetOrg.table('solutions', [{ ...SOLUTION, solutionid: guid(12) }]);
    targetOrg.table('msdyn_solutioncomponentsummaries', []);
    targetOrg.on('POST', '/ImportSolutionAsync', () => ({ AsyncOperationId: guid(31) }));
    targetOrg.on('GET', /^\/importjobs\(/, () => ({ progress: 100, completedon: '2026-10-15T10:00:00Z', data: importLog }));
    targetOrg.on('POST', '/PublishAllXml', () => ({ status: 204 }));
}

async function openDeployer(page, org) {
    await gotoOrg(page, org);
    await runCommand(page, 'Open Solution Deployer');
    const panel = page.locator('.sd-panel');
    await expect(panel).toBeVisible();
    return panel;
}

async function pickSolution(page, panel) {
    await panel.getByRole('button', { name: '📦 Select a solution…' }).click();
    await page.locator('.sd-modal .sd-item', { hasText: 'Core Solution' }).click();
    await expect(panel.getByText('Selected:')).toBeVisible();
}

async function setTarget(panel, targetOrg) {
    const input = panel.getByPlaceholder('https://yourorg.crm.dynamics.com');
    await input.fill(targetOrg.origin);
    await input.press('Tab'); // the panel reads it on "change"
}

async function deploy(page, panel, targetOrg) {
    await pickSolution(page, panel);
    await panel.getByRole('button', { name: 'Next: Choose Target →' }).click();
    await setTarget(panel, targetOrg);
    await panel.locator('.sd-footer').getByRole('button', { name: '🚀 Deploy Now' }).click();
    const confirm = page.locator('.sd-modal', { hasText: 'Confirm Deployment' });
    await expect(confirm).toContainText(targetOrg.host);
    await confirm.getByRole('button', { name: '🚀 Deploy Now' }).click();
}

// RetrieveMissingComponents' SOAP answer, as a live org sends it (the empty
// one verbatim; components follow the SDK's ComponentDetail fields).
const componentDetail = (tag, c) => `<b:${tag}><b:DisplayName>${c.name}</b:DisplayName><b:Id>${c.id}</b:Id>`
    + `<b:ParentDisplayName i:nil="true"/><b:ParentId>00000000-0000-0000-0000-000000000000</b:ParentId><b:ParentSchemaName i:nil="true"/>`
    + `<b:SchemaName>${c.schema ?? c.name}</b:SchemaName><b:Solution>${c.solution ?? 'Active'}</b:Solution><b:Type>${c.type}</b:Type></b:${tag}>`;
const missingComponentsResponse = (missing = []) => '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>'
    + '<ExecuteResponse xmlns="http://schemas.microsoft.com/xrm/2011/Contracts/Services"><ExecuteResult i:type="b:RetrieveMissingComponentsResponse" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns:b="http://schemas.microsoft.com/crm/2011/Contracts">'
    + '<a:ResponseName>RetrieveMissingComponents</a:ResponseName><a:Results xmlns:c="http://schemas.datacontract.org/2004/07/System.Collections.Generic">'
    + '<a:KeyValuePairOfstringanyType><c:key>MissingComponents</c:key>'
    + (missing.length
        ? `<c:value i:type="b:ArrayOfMissingComponent">${missing.map((m) => `<b:MissingComponent>${componentDetail('DependentComponent', m.dependent)}${componentDetail('RequiredComponent', m.required)}</b:MissingComponent>`).join('')}</c:value>`
        : '<c:value i:type="b:ArrayOfMissingComponent"/>')
    + '</a:KeyValuePairOfstringanyType></a:Results></ExecuteResult></ExecuteResponse></s:Body></s:Envelope>';

const CANVAS_APP = guid(61);
const FLOW = guid(62);

/** Source org for a dependency check of Core; the target answers RetrieveMissingComponents. */
function checkableOrgs(org, targetOrg, { missing = [], components = [], requires = {} } = {}) {
    deployableOrgs(org, targetOrg);
    org.table('solutioncomponents', components.map((c, i) => ({ solutioncomponentid: guid(70 + i), _solutionid_value: SOLUTION.solutionid, ...c })));
    org.table('workflows', [{ workflowid: FLOW, name: 'Notify approver', category: 5 }]);
    org.table('canvasapps', [{ canvasappid: CANVAS_APP, name: 'cr123_approvals', displayname: 'Approvals' }]);
    org.on('GET', '/RetrieveRequiredComponents*', dependencyRows('required', requires));
    org.on('GET', '/RetrieveMissingDependenciesWithMetadata*', () => ({ value: [] }));
    targetOrg.on('POST', '/XRMServices/2011/Organization.svc/web', (req) => (
        /RetrieveMissingComponentsRequest/.test(req.body) ? { contentType: 'text/xml', body: missingComponentsResponse(missing) } : undefined));
    org.on('POST', '/AddSolutionComponent', (req) => ({ id: guid(80) }));
}

async function runCheck(page, panel, targetOrg) {
    await panel.getByRole('button', { name: '🔍 Check Deps' }).click();
    await panel.getByRole('button', { name: '📦 Select a solution…' }).click();
    await page.locator('.sd-modal .sd-item', { hasText: 'Core Solution' }).click();
    await setTarget(panel, targetOrg);
    await panel.locator('.sd-footer').getByRole('button', { name: '🔍 Check Dependencies' }).click();
}

test.describe('Solution Deployer — dependency check', () => {
    test('reports nothing missing, and offers to deploy', async ({ page, org, targetOrg }) => {
        checkableOrgs(org, targetOrg);
        const panel = await openDeployer(page, org);
        await runCheck(page, panel, targetOrg);
        await expect(panel).toContainText('No missing dependencies!', { timeout: 20_000 });
        await expect(panel.locator('.sd-footer').getByRole('button', { name: '🚀 Deploy Now' })).toBeVisible();
        // The target is asked about the solution exactly as it was exported.
        const [soap] = targetOrg.calls('POST', '/XRMServices/2011/Organization.svc/web');
        expect(soap.body).toContain(EXPORTED_FILE);
    });

    test('lists what the target is missing, and adds it to the solution', async ({ page, org, targetOrg }) => {
        const table = { id: guid(91), name: 'cr123_invoice', type: 1 };
        checkableOrgs(org, targetOrg, {
            missing: [{ required: table, dependent: { id: guid(92), name: 'cr123_invoice_form', type: 60 } }],
        });
        const panel = await openDeployer(page, org);
        await runCheck(page, panel, targetOrg);
        await expect(panel).toContainText('1 missing dependency found', { timeout: 20_000 });
        const row = panel.locator('.sd-table tbody tr', { hasText: 'cr123_invoice' }).first();
        await expect(row).toContainText('Entity');
        await row.getByRole('button', { name: '➕ Add' }).click();
        await expect(row.getByRole('button', { name: '✅' })).toBeVisible();
        expect(org.calls('POST', '/AddSolutionComponent')[0].body).toEqual({
            ComponentId: table.id, ComponentType: 1, SolutionUniqueName: 'Core', AddRequiredComponents: false,
        });
    });

    test('flags a flow a canvas app calls when the solution leaves it out', async ({ page, org, targetOrg }) => {
        checkableOrgs(org, targetOrg, {
            components: [{ objectid: CANVAS_APP, componenttype: 300 }],
            requires: { [`300:${CANVAS_APP}`]: [{ type: 29, id: FLOW }, { type: 61, id: guid(63) }] },
        });
        const panel = await openDeployer(page, org);
        await runCheck(page, panel, targetOrg);
        const row = panel.locator('.sd-table tbody tr', { hasText: 'Notify approver' });
        await expect(row).toContainText('Not in solution (used by canvas app)', { timeout: 20_000 });
        await expect(row).toContainText('Approvals');
        await expect(panel.locator('.sd-table tbody tr'), 'only the flow, not the app\'s other dependencies').toHaveCount(1);
        await row.getByRole('button', { name: '➕ Add' }).click();
        await expect(row.getByRole('button', { name: '✅' })).toBeVisible();
        expect(org.calls('POST', '/AddSolutionComponent')[0].body).toEqual({
            ComponentId: FLOW, ComponentType: 29, SolutionUniqueName: 'Core', AddRequiredComponents: false,
        });
    });

    test('does not flag a canvas app\'s flow that is in the solution', async ({ page, org, targetOrg }) => {
        checkableOrgs(org, targetOrg, {
            components: [{ objectid: CANVAS_APP, componenttype: 300 }, { objectid: FLOW, componenttype: 29 }],
            requires: { [`300:${CANVAS_APP}`]: [{ type: 29, id: FLOW }] },
        });
        const panel = await openDeployer(page, org);
        await runCheck(page, panel, targetOrg);
        await expect(panel).toContainText('No missing dependencies!', { timeout: 20_000 });
    });
});

test.describe('Solution Deployer — cleanup', () => {
    async function cleanup(page, panel, targetOrg, { removeLayers }) {
        await panel.getByRole('button', { name: '🧹 Cleanup' }).click();
        await setTarget(panel, targetOrg);
        const name = panel.getByPlaceholder('e.g. QuickDeploy_20260512');
        await name.fill('Core');
        await name.press('Tab');
        if (removeLayers) await panel.getByText('Also remove active customizations (unmanaged layers)').click();
        await panel.locator('.sd-footer').getByRole('button', { name: '🧹 Run Cleanup' }).click();
        await page.locator('.sd-modal').getByRole('button', { name: '🧹 Run Cleanup' }).click();
    }

    test('deletes the solution on the target and keeps its customizations', async ({ page, org, targetOrg }) => {
        org.table('solutions', [{ ...SOLUTION }]);
        targetOrg.table('solutions', [{ ...SOLUTION, solutionid: guid(12) }]);
        const panel = await openDeployer(page, org);
        await cleanup(page, panel, targetOrg, { removeLayers: false });
        await expect(panel).toContainText('✅ Cleanup completed! Solution deleted, customizations kept.');
        expect(targetOrg.tables.solutions).toEqual([]);
        expect(targetOrg.calls('POST', '/RemoveActiveCustomization')).toHaveLength(0);
    });

    test('says kept unmanaged layers stay on top of later managed imports', async ({ page, org, targetOrg }) => {
        // A managed import with "overwrite unmanaged customizations" copies its values into
        // the unmanaged layer but does not remove it, so the texts must not promise that.
        org.table('solutions', [{ ...SOLUTION }]);
        targetOrg.table('solutions', [{ ...SOLUTION, solutionid: guid(12) }]);
        const panel = await openDeployer(page, org);
        await panel.getByRole('button', { name: '🧹 Cleanup' }).click();
        await expect(panel).toContainText('keep their unmanaged layer on top');
        await expect(panel).toContainText('Deploy the managed release with the same changes first');
        await expect(panel).not.toContainText('get overwritten by the next managed import');
        await setTarget(panel, targetOrg);
        const name = panel.getByPlaceholder('e.g. QuickDeploy_20260512');
        await name.fill('Core');
        await name.press('Tab');
        await panel.locator('.sd-footer').getByRole('button', { name: '🧹 Run Cleanup' }).click();
        const modal = page.locator('.sd-modal');
        await expect(modal).toContainText('keep their unmanaged layer on top until it is removed');
        await expect(modal).not.toContainText('the next managed import overwrites them');
        await modal.getByRole('button', { name: '🧹 Run Cleanup' }).click();
        await expect(panel).toContainText('the unmanaged layers stay on top, even after a managed import, until they are removed');
    });

    test('removes each component\'s unmanaged layer first when asked to', async ({ page, org, targetOrg }) => {
        org.table('solutions', [{ ...SOLUTION }]);
        targetOrg.table('solutions', [{ ...SOLUTION, solutionid: guid(12) }]);
        targetOrg.table('solutioncomponents', [
            { solutioncomponentid: guid(71), _solutionid_value: guid(12), componenttype: 61, objectid: guid(72) },
            { solutioncomponentid: guid(73), _solutionid_value: guid(12), componenttype: 29, objectid: guid(74) },
            { solutioncomponentid: guid(75), _solutionid_value: guid(12), componenttype: 9999, objectid: guid(76) },
        ]);
        targetOrg.on('POST', '/RemoveActiveCustomization', () => ({ status: 204 }));
        const panel = await openDeployer(page, org);
        await cleanup(page, panel, targetOrg, { removeLayers: true });
        await expect(panel).toContainText('Results: 2 removed, 1 skipped, 0 errors.');
        await expect(panel).toContainText('✅ Cleanup completed! Unmanaged layers removed and solution deleted.');
        expect(targetOrg.calls('POST', '/RemoveActiveCustomization').map((c) => c.body)).toEqual([
            { LogicalName: 'webresource', Id: guid(72) },
            { LogicalName: 'workflow', Id: guid(74) },
        ]);
    });
});

test.describe('Solution Deployer — new solution', () => {
    // Publishers as a live org lists them: Microsoft's ahead of the org's own,
    // whose unique name is "DefaultPublisher" + the organization's name.
    function publishers(org) {
        org.table('organizations', [{ organizationid: guid(2), name: 'org1a2b3c4d' }]);
        org.table('publishers', [
            { publisherid: guid(1301), uniquename: 'adxstudio', friendlyname: 'Adxstudio', customizationprefix: 'adx' },
            { publisherid: guid(1302), uniquename: 'DefaultPublisherorg9z8y7x6w', friendlyname: 'Default Publisher for org9z8y7x6w', customizationprefix: 'new' },
            { publisherid: guid(1303), uniquename: 'DefaultPublisherorg1a2b3c4d', friendlyname: 'Default Publisher for org1a2b3c4d', customizationprefix: 'new' },
            { publisherid: guid(1304), uniquename: 'contoso', friendlyname: 'Contoso', customizationprefix: 'con' },
        ]);
        org.table('solutions', []);
    }

    test('creates the solution under this org\'s default publisher', async ({ page, org, extensionContext }) => {
        publishers(org);
        const panel = await openDeployer(page, org);
        await panel.getByRole('button', { name: '📦 New Solution' }).click();
        const [maker] = await Promise.all([
            extensionContext.waitForEvent('page'),
            panel.getByRole('button', { name: '📦 Create Solution & Open in Power Apps' }).click(),
        ]);
        expect(maker.url()).toContain(`/environments/${org.environmentId}/solutions/`);
        await maker.close();
        const [created] = org.calls('POST', '/solutions');
        expect(created.body).toMatchObject({ version: '1.0.0.0', 'publisherid@odata.bind': `/publishers(${guid(1303)})` });
        expect(created.body.uniquename).toMatch(/^QuickDeploy_\d{14}$/);
    });

    test('uses the publisher picked instead', async ({ page, org, extensionContext }) => {
        publishers(org);
        const panel = await openDeployer(page, org);
        await panel.getByRole('button', { name: '📦 New Solution' }).click();
        await panel.locator('select').selectOption({ label: 'Contoso (con)' });
        const [maker] = await Promise.all([
            extensionContext.waitForEvent('page'),
            panel.getByRole('button', { name: '📦 Create Solution & Open in Power Apps' }).click(),
        ]);
        await maker.close();
        expect(org.calls('POST', '/solutions')[0].body['publisherid@odata.bind']).toBe(`/publishers(${guid(1304)})`);
    });
});

test.describe('Solution Deployer', () => {
    test('deploys a solution: exports it, imports it on the target and publishes', async ({ page, org, targetOrg }) => {
        deployableOrgs(org, targetOrg);
        const panel = await openDeployer(page, org);
        await deploy(page, panel, targetOrg);

        await expect(panel).toContainText('✅ Deployment completed successfully!', { timeout: 20_000 });
        await expect(panel).toContainText('No cloud flows in this solution.');

        expect(org.calls('POST', '/ExportSolutionAsync')[0].body).toEqual({ SolutionName: 'Core', Managed: false });
        const [importCall] = targetOrg.calls('POST', '/ImportSolutionAsync');
        expect(importCall.body).toMatchObject({
            CustomizationFile: EXPORTED_FILE, OverwriteUnmanagedCustomizations: true, PublishWorkflows: true,
        });
        // The job it watches is the one it created.
        const polled = targetOrg.calls('GET', /^\/importjobs\(/).map((r) => r.path.match(/\(([^)]+)\)/)[1]);
        expect(new Set(polled)).toEqual(new Set([importCall.body.ImportJobId]));
        expect(targetOrg.calls('POST', '/PublishAllXml')).toHaveLength(1);
    });

    test('shows the import log\'s own error when the target rejects the solution', async ({ page, org, targetOrg }) => {
        const error = 'The dependent component Workflow (Id=' + guid(41) + ') does not exist. Failure trying to associate it with CanvasApp (Id='
            + guid(42) + ') as a dependency. Missing dependency lookup type = PrimaryKeyLookup.';
        deployableOrgs(org, targetOrg, { importLog: failureLog(error) });
        const panel = await openDeployer(page, org);
        await deploy(page, panel, targetOrg);

        await expect(panel).toContainText(`❌ Deployment failed: ${error}`, { timeout: 20_000 });
        expect(targetOrg.calls('POST', '/PublishAllXml'), 'nothing is published after a failed import').toHaveLength(0);
    });

    test('imports as the chosen user: every target call carries MSCRMCallerID', async ({ page, org, targetOrg }) => {
        deployableOrgs(org, targetOrg);
        const user = { systemuserid: guid(51), fullname: 'Pipeline App User', internalemailaddress: 'pipeline@contoso.com', isdisabled: false };
        targetOrg.table('systemusers', [user]);
        const panel = await openDeployer(page, org);
        await pickSolution(page, panel);
        await panel.getByRole('button', { name: 'Next: Choose Target →' }).click();
        await setTarget(panel, targetOrg);
        await panel.getByPlaceholder('Search users on target by name or email…').fill('Pipeline');
        await panel.locator('.sd-dropdown .sd-item', { hasText: 'Pipeline App User' }).click();
        await expect(panel.getByText('Importing as:')).toBeVisible();

        await panel.locator('.sd-footer').getByRole('button', { name: '🚀 Deploy Now' }).click();
        await page.locator('.sd-modal').getByRole('button', { name: '🚀 Deploy Now' }).click();
        await expect(panel).toContainText('✅ Deployment completed successfully!', { timeout: 20_000 });

        for (const call of [...targetOrg.calls('POST', '/ImportSolutionAsync'), ...targetOrg.calls('GET', /^\/importjobs\(/), ...targetOrg.calls('POST', '/PublishAllXml')]) {
            expect(call.headers.mscrmcallerid, `${call.method} ${call.path}`).toBe(guid(51));
        }
    });
});
