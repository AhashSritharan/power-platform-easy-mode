// Find All References on a stub Power Automate designer. The canvas markup is
// the live designer's (2026-10-15), trimmed: react-flow nodes whose data-id is
// the action name, a card per node, and — once a card is clicked — a details
// panel whose id names the selected action. The live designer marks nothing
// else as selected: no .selected class, no aria-selected on the node.
import { test, expect } from './fixtures.js';
import { guid } from './fake-dataverse.js';

const FLOW = guid(1501);

const definition = {
    $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
    contentVersion: '1.0.0.0',
    triggers: { manual: { type: 'Request', kind: 'Button', inputs: { schema: { type: 'object', properties: {} } } } },
    actions: {
        Initialize_total: { type: 'InitializeVariable', runAfter: {}, inputs: { variables: [{ name: 'Total', type: 'integer', value: 1 }] } },
        Compose_total: { type: 'Compose', runAfter: { Initialize_total: ['Succeeded'] }, inputs: "@variables('Total')" },
        Compose_report: { type: 'Compose', runAfter: { Compose_total: ['Succeeded'] }, inputs: "Total: @{outputs('Compose_total')}" },
    },
};

const node = (id, title) => `<div class="react-flow__node react-flow__node-OPERATION_NODE selectable" data-id="${id}" data-testid="rf__node-${id}" aria-roledescription="node">`
    + `<div class="nopan" tabindex="0" role="group" aria-label="${title}"><div role="group" id="msla-node-${id}" data-testid="card-${title}">`
    + `<input id="${id}-title" data-automation-id="flow-card-title" value="${title}" readonly></div></div></div>`;

const designer = `<!doctype html><html><head><meta charset="utf-8"><title>Edit your flow | Power Automate</title></head><body>
<div class="react-flow"><div class="react-flow__nodes">
  ${node('Manually_trigger_a_flow', 'Manually trigger a flow')}${node('Initialize_total', 'Initialize total')}
  ${node('Compose_total', 'Compose total')}${node('Compose_report', 'Compose report')}
</div></div>
<div id="panel"></div>
<script>
  // Selecting a card opens its details panel, as the designer does.
  for (const card of document.querySelectorAll('[data-testid^="card-"]')) {
    card.addEventListener('click', () => {
      const id = card.closest('.react-flow__node').dataset.id;
      document.getElementById('panel').innerHTML = '<div id="flow-node-details-panel-' + id + '" data-automation-id="flow-node-details-panel">Parameters</div>';
    });
  }
</script></body></html>`;

async function onDesigner(page, org, serviceWorker, portal) {
    org.table('workflows', [{ workflowid: FLOW, name: 'Totals', category: 5, clientdata: JSON.stringify({ properties: { definition } }) }]);
    await serviceWorker.evaluate(({ host, envId }) => chrome.storage.local.set({
        'vals/environment-indicator/envIndicator_hostCache': { [host]: envId },
    }), { host: org.host, envId: org.environmentId });
    portal.page(designer);
    await page.goto(`https://make.powerautomate.com/environments/${org.environmentId}/solutions/fd140aaf-4df4-11dd-bd17-0019b9312238/flows/${FLOW}`);
    await expect(page.locator('.ppt-launcher')).toBeVisible();
}

test.describe('Find All References', () => {
    test('Shift+F12 opens on the step selected in the designer', async ({ page, org, serviceWorker, portal }) => {
        await onDesigner(page, org, serviceWorker, portal);
        await page.locator('[data-testid="card-Compose total"]').click();
        await page.keyboard.press('Shift+F12');
        const panel = page.locator('.fr-wrap');
        await expect(panel.locator('.fr-head .n')).toHaveText('▸ Compose_total');
        // Compose_report runs after it and reads its outputs: two references.
        await expect(panel.locator('.fr-tab').first()).toHaveText('Referenced by (2)');
        await expect(panel.locator('.fr-scroll .fr-from')).toHaveCount(1);
        await expect(panel.locator('.fr-scroll')).toContainText('Compose_report');
        await expect(panel.locator('.fr-scroll .fr-ref')).toHaveCount(2);
        await panel.locator('.fr-tab', { hasText: 'References (' }).click();
        await expect(panel.locator('.fr-scroll')).toContainText('Total');
    });

    test('⌖ Canvas selects the step on the canvas', async ({ page, org, serviceWorker, portal }) => {
        await onDesigner(page, org, serviceWorker, portal);
        await page.locator('[data-testid="card-Compose report"]').click();
        await page.keyboard.press('Shift+F12');
        const panel = page.locator('.fr-wrap');
        await expect(panel.locator('.fr-head .n')).toHaveText('▸ Compose_report');
        await panel.locator('.fr-tab', { hasText: 'References (' }).click();
        await panel.locator('.fr-scroll .fr-from', { hasText: 'Compose_total' }).first().click();
        await expect(panel.locator('.fr-head .n')).toHaveText('▸ Compose_total');
        await panel.getByRole('button', { name: '⌖ Canvas' }).click();
        await expect(page.locator('[data-automation-id="flow-node-details-panel"]')).toHaveId('flow-node-details-panel-Compose_total');
    });
});
