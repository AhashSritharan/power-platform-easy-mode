// The flow tools in the real Power Automate designer, on a fixture flow the
// test user owns: "ppt-e2e designer fixture" — created once if it is missing,
// then only read. A variable, and two Compose steps that reference it and
// each other.
import { test, expect } from './fixtures.js';
import { environmentId, gotoDynamics, runCommand } from '../support/helpers.js';

const FIXTURE = 'ppt-e2e designer fixture';
const DEFAULT_SOLUTION = 'fd140aaf-4df4-11dd-bd17-0019b9312238';
const clientdata = JSON.stringify({
    properties: {
        connectionReferences: {},
        definition: {
            $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
            contentVersion: '1.0.0.0',
            parameters: { $connections: { defaultValue: {}, type: 'Object' }, $authentication: { defaultValue: {}, type: 'SecureObject' } },
            triggers: { manual: { type: 'Request', kind: 'Button', inputs: { schema: { type: 'object', properties: {}, required: [] } } } },
            actions: {
                Initialize_total: { type: 'InitializeVariable', runAfter: {}, inputs: { variables: [{ name: 'Total', type: 'integer', value: 1 }] } },
                Compose_total: { type: 'Compose', runAfter: { Initialize_total: ['Succeeded'] }, inputs: "@variables('Total')" },
                Compose_report: { type: 'Compose', runAfter: { Compose_total: ['Succeeded'] }, inputs: "Total: @{outputs('Compose_total')}" },
            },
        },
    },
    schemaVersion: '1.0.0.0',
});

/** The fixture flow's id, creating the flow the first time. */
async function fixtureFlow(page) {
    return page.evaluate(async ({ name, clientdata }) => {
        const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
        const found = await (await fetch(`/api/data/v9.2/workflows?$filter=name eq '${name}' and category eq 5 and type eq 1&$select=workflowid`, { headers })).json();
        if (found.value?.[0]) return found.value[0].workflowid;
        const created = await fetch('/api/data/v9.2/workflows', {
            method: 'POST', headers: { ...headers, Prefer: 'return=representation' },
            body: JSON.stringify({ name, category: 5, type: 1, primaryentity: 'none', clientdata }),
        });
        return (await created.json()).workflowid;
    }, { name: FIXTURE, clientdata });
}

async function openDesigner(page) {
    // Visiting the org first is also what teaches the toolbox its URL for this environment.
    await gotoDynamics(page);
    const flowId = await fixtureFlow(page);
    const envId = await environmentId(page);
    if (process.env.CI) console.log(`::add-mask::${envId}`);
    await page.goto(`https://make.powerautomate.com/environments/${envId}/solutions/${DEFAULT_SOLUTION}/flows/${flowId}`);
    await expect(page.locator('.react-flow__node[data-id="Compose_total"]')).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('.ppt-launcher')).toBeVisible();
}

test.describe('Flow designer', () => {
    test('Find All References opens on the step selected on the canvas', async ({ page }) => {
        await openDesigner(page);
        await page.locator('.react-flow__node[data-id="Compose_total"] [data-testid^="card-"]').click();
        await expect(page.locator('[data-automation-id="flow-node-details-panel"]')).toBeVisible();
        await page.keyboard.press('Shift+F12');
        const panel = page.locator('.fr-wrap');
        await expect(panel.locator('.fr-head .n')).toHaveText('▸ Compose_total', { timeout: 60_000 });
        await expect(panel.locator('.fr-tab').first()).toHaveText('Referenced by (2)');
        await expect(panel.locator('.fr-scroll')).toContainText('Compose_report');
    });

    test('Expression Validator reads the flow and finds nothing wrong', async ({ page }) => {
        await openDesigner(page);
        await runCommand(page, 'Validate Flow Expressions');
        await expect(page.locator('.ppt-dialog', { hasText: 'Expression Validation Results' })).toContainText('No issues found!', { timeout: 60_000 });
    });

    test('the schema builder 🧬 button docks in the expression picker and opens', async ({ page, serviceWorker }) => {
        // The button is opt-in; switch it on as the palette setting would.
        await serviceWorker.evaluate(() => chrome.storage.local.set({ 'vals/flow-schema-builder/showChip': true }));
        await openDesigner(page);
        await page.locator('.react-flow__node[data-id="Compose_report"] [data-testid^="card-"]').click();
        const panel = page.locator('[data-automation-id="flow-node-details-panel"]');
        await panel.locator('[contenteditable="true"], [role="textbox"]').first().click();
        await page.locator('[data-automation-id="flow-token-picker-entrypoint-button-expression"]').click();
        const header = page.locator('[data-automation-id="flow-token-picker-header"]');
        await expect(header).toBeVisible();
        await expect(header.locator('ppt-ui')).toHaveCount(1);
        await header.getByText('🧬').click();
        await expect(page.getByText('🧬 Query to build a schema for')).toBeVisible();
    });
});
