// Expression Validator on a stub make.powerautomate.com editor page: the org
// is the one the Environment Indicator learned on an earlier Dynamics visit,
// and the definition is read from the fake org's workflows table through the
// service worker — the portal-to-Dataverse path every flow tool takes.
import { test, expect } from './fixtures.js';
import { guid } from './fake-dataverse.js';
import { runCommand } from '../support/helpers.js';

const FLOW = guid(1201);
const editorUrl = (org) => `https://make.powerautomate.com/environments/${org.environmentId}/flows/${FLOW}/edit`;

// A clientdata definition as the designer saves it (trimmed to what matters).
const clientdata = (actions) => JSON.stringify({
    properties: {
        connectionReferences: {},
        definition: {
            $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
            contentVersion: '1.0.0.0',
            triggers: { manual: { type: 'Request', kind: 'Button', inputs: { schema: { type: 'object', properties: {} } } } },
            actions,
        },
    },
    schemaVersion: '1.0.0.0',
});

async function onEditor(page, org, serviceWorker, portal, actions) {
    org.table('workflows', [{ workflowid: FLOW, name: 'Notify approver', category: 5, clientdata: clientdata(actions) }]);
    // What visiting the org in Dynamics leaves behind: its host, keyed to the environment id.
    await serviceWorker.evaluate(({ host, envId }) => chrome.storage.local.set({
        'vals/environment-indicator/envIndicator_hostCache': { [host]: envId },
    }), { host: org.host, envId: org.environmentId });
    portal.page('<!doctype html><html><head><meta charset="utf-8"><title>Edit your flow | Power Automate</title></head><body><div id="root"></div></body></html>');
    await page.goto(editorUrl(org));
    await expect(page.locator('.ppt-launcher')).toBeVisible();
}

test.describe('Expression Validator', () => {
    test('reports an expression that references a step that does not exist', async ({ page, org, serviceWorker, portal }) => {
        await onEditor(page, org, serviceWorker, portal, {
            Get_items: { type: 'OpenApiConnection', runAfter: {}, inputs: {} },
            Compose: { type: 'Compose', runAfter: { Get_items: ['Succeeded'] }, inputs: "@body('Get_item')?['value']" },
        });
        await runCommand(page, 'Validate Flow Expressions');
        const results = page.locator('.ppt-dialog', { hasText: 'Expression Validation Results' });
        await expect(results.locator('h2')).toContainText('1 issue');
        await expect(results.locator('.fev-issue')).toContainText("body('Get_item')");
        await expect(results.locator('.fev-issue')).toContainText('Compose');
        await expect(results.locator('.fev-suggestion')).toContainText('Get_items');
        // Read cross-origin, through the service worker, from the org the indicator knew.
        expect(org.calls('GET', `/workflows(${FLOW})`)).toHaveLength(1);
    });

    test('says so when every reference resolves', async ({ page, org, serviceWorker, portal }) => {
        await onEditor(page, org, serviceWorker, portal, {
            Get_items: { type: 'OpenApiConnection', runAfter: {}, inputs: {} },
            Compose: { type: 'Compose', runAfter: { Get_items: ['Succeeded'] }, inputs: "@body('Get_items')?['value']" },
        });
        await runCommand(page, 'Validate Flow Expressions');
        await expect(page.locator('.ppt-dialog', { hasText: 'Expression Validation Results' })).toContainText('No issues found!');
    });
});
