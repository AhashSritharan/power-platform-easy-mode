// Solution History against a fake org: completed imports with their verdict
// and import log, and past exports with their zip. importjobs.data, the
// FormattedResults workbook and exportsolutionuploads rows follow a live
// org's responses, trimmed.
import { test, expect, gotoOrg } from './fixtures.js';
import { guid } from './fake-dataverse.js';
import { runCommand } from '../support/helpers.js';

const OK_JOB = guid(801);
const FAILED_JOB = guid(802);
const DEPENDENCY_ERROR = `The dependent component Workflow (Id=${guid(803)}) does not exist. Failure trying to associate it with CanvasApp (Id=${guid(804)}) as a dependency. Missing dependency lookup type = PrimaryKeyLookup.`;

const importLog = (succeeded, errorcode = '0', errortext = '') => `<importexportxml start="639276000000000000" stop="639276000100000000" progress="100" processed="true" errorcode="${errorcode}" succeeded="${succeeded}" status="${succeeded === 'success' ? 'Succeeded' : 'Failed'}">`
    + `<solutionManifests><solutionManifest languagecode="1033" id="Core" processed="true"><UniqueName>Core</UniqueName><results /><result result="${succeeded}" errorcode="${errorcode}" errortext="${errortext}" datetime="10:00:00.00" /></solutionManifest></solutionManifests></importexportxml>`;

// RetrieveFormattedImportJobResults: an Excel-XML workbook, Solution sheet then
// Components (header row, blank row, then one row per component).
const cell = (v) => `<Cell><Data ss:Type="String">${v}</Data></Cell>`;
const row = (...values) => `<Row>${values.map(cell).join('')}</Row>`;
const workbook = (components) => '<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'
    + `<Worksheet ss:Name="Solution" ss:Id="Solution"><Table>${row('Solution')}${row('Name', 'Core')}${row('Version', '1.0.0.0')}</Table></Worksheet>`
    + `<Worksheet ss:Name="Components" ss:Id="Components"><Table>${row('Date/Time', 'ItemType', 'Id', 'Name', 'Localized Name', 'Original Name', 'Description', 'Status', 'ErrorCode', 'ErrorText')}${row('', '', '', '', '', '', '', '', '', '')}`
    + components.map((c) => row(...c)).join('') + '</Table></Worksheet></Workbook>';

function historyOrg(org) {
    org.table('importjobs', [
        { importjobid: OK_JOB, solutionname: 'Core', name: 'Customizations', progress: 100, createdon: '2026-10-14T09:00:00Z', startedon: '2026-10-14T09:00:01Z', completedon: '2026-10-14T09:01:00Z', modifiedon: '2026-10-14T09:01:00Z', data: importLog('success') },
        { importjobid: FAILED_JOB, solutionname: 'QuickDeploy_20260916', name: 'Customizations', progress: 100, createdon: '2026-10-15T10:00:00Z', startedon: '2026-10-15T10:00:01Z', completedon: '2026-10-15T10:00:05Z', modifiedon: '2026-10-15T10:00:05Z', data: importLog('failure', '0x8004f01f', DEPENDENCY_ERROR) },
    ]);
    org.table('msdyn_solutionhistories', []);
    org.on('GET', /^\/RetrieveFormattedImportJobResults\(ImportJobId=/, (req) => (req.path.includes(FAILED_JOB) ? {
        FormattedResults: workbook([
            ['10:00:01.75', 'Transform Package', '', 'RemoveParentContact', 'Transform Package', '', 'Transform Package', 'Processed', '', ''],
            ['10:00:03.83', 'Solution', '', 'QuickDeploy_20260916', 'Quick Deploy', '', '', 'Failure', '0x8004f01f', DEPENDENCY_ERROR],
            ['', '', '', '', '', '', '', 'Unprocessed', '', ''],
        ]),
    } : undefined));
    org.table('exportsolutionuploads', [{
        '@odata.etag': 'W/"11827121"', exportsolutionuploadid: guid(811), solutionuniquename: 'Core', solutionfilename: `Core_${guid(811)}.zip`,
        createdon: '2026-10-15T16:23:38Z', 'createdon@OData.Community.Display.V1.FormattedValue': '10/15/2026 6:23 PM',
        _createdby_value: guid(812), '_createdby_value@OData.Community.Display.V1.FormattedValue': 'SYSTEM',
        _createdonbehalfby_value: org.userId, '_createdonbehalfby_value@OData.Community.Display.V1.FormattedValue': 'Jane Admin',
    }]);
    org.on('POST', '/DownloadSolutionExportData', (req) => (req.body.ExportJobId === guid(811) ? { ExportSolutionFile: Buffer.from('PK\u0003\u0004fake zip').toString('base64') } : undefined));
}

async function openHistory(page, org) {
    await gotoOrg(page, org);
    await runCommand(page, 'Open Solution History');
    const panel = page.locator('.sh-panel');
    await expect(panel).toBeVisible();
    return panel;
}

test.describe('Solution History', () => {
    test('lists completed imports with the import log\'s own verdict', async ({ page, org }) => {
        historyOrg(org);
        const panel = await openHistory(page, org);
        const failed = panel.locator('.sim-table tbody tr', { hasText: 'QuickDeploy_20260916' });
        await expect(failed.locator('.sim-badge')).toHaveText('✕ Failed');
        await expect(failed).toContainText('0x8004f01f');
        await expect(failed.locator('.sim-badge')).toHaveAttribute('title', DEPENDENCY_ERROR);
        await expect(panel.locator('.sim-table tbody tr', { hasText: 'Core' }).locator('.sim-badge')).toHaveText('✓ Success');
    });

    test('opens the import log on its errors', async ({ page, org }) => {
        historyOrg(org);
        const panel = await openHistory(page, org);
        await panel.locator('.sim-table tbody tr', { hasText: 'QuickDeploy_20260916' }).getByRole('button', { name: '📋 View' }).click();
        const log = page.locator('.sim-header').locator('..');
        await expect(page.locator('.sim-header h2')).toContainText('QuickDeploy_20260916');
        await expect(log).toContainText(DEPENDENCY_ERROR);
        await expect(log).not.toContainText('RemoveParentContact'); // opens filtered to the errors
    });

    test('lists past exports and downloads the original zip', async ({ page, org }) => {
        historyOrg(org);
        const panel = await openHistory(page, org);
        await panel.locator('.sh-tab', { hasText: 'Exports' }).click();
        const exported = panel.locator('.seh-table tbody tr', { hasText: 'Core' });
        await expect(exported).toContainText('Jane Admin');
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            exported.getByRole('button', { name: '⬇ Download' }).click(),
        ]);
        expect(download.suggestedFilename()).toMatch(/^Core.*\.zip$/);
        const bytes = Buffer.concat(await (async () => { const chunks = []; for await (const c of await download.createReadStream()) chunks.push(c); return chunks; })());
        expect(bytes.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004');
    });
});
