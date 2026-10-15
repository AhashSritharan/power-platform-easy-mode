// Turned-Off Highlighter on a stub maker-portal solution view. The grid
// markup is a live portal's DetailsRow (trimmed); the labels are in German,
// as a German browser gets them.
import { test, expect } from './fixtures.js';
import { guid } from './fake-dataverse.js';

const row = (index, uniqueName, status) => `<div role="row" data-item-index="${index}" data-automationid="DetailsRow">`
    + '<div data-automationid="DetailsRowFields" role="presentation">'
    + `<div role="gridcell" data-automationid="DetailsRowCell" data-automation-key="displayName"><a href="#" role="link">${uniqueName}</a></div>`
    + `<div role="gridcell" data-automationid="DetailsRowCell" data-automation-key="uniqueName"><div title="${uniqueName}">${uniqueName}</div></div>`
    + `<div role="gridcell" data-automationid="DetailsRowCell" data-automation-key="status"><div title="${status}" aria-live="polite">${status}</div></div>`
    + '</div></div>';

const solutionView = (rows) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Lösungen | Power Apps</title></head><body>
<div role="grid"><div role="rowgroup">${rows.join('')}</div></div></body></html>`;

test.describe('Turned-Off Highlighter', () => {
    test('tints the rows that are off, whatever language the portal speaks', async ({ page, portal }) => {
        portal.page(solutionView([
            row(0, 'BusinessProcessFlowTest', 'Ein'),
            row(1, 'cr1_sharedcommondataserviceforapps', 'Aus'),
            row(2, 'account', ''),
        ]));
        await page.goto(`https://make.powerapps.com/environments/${guid(1)}/solutions/${guid(2)}`);
        const off = page.locator('[data-automationid="DetailsRow"].ppt-off-row');
        await expect(off).toHaveCount(1);
        await expect(off).toContainText('cr1_sharedcommondataserviceforapps');
    });

    test('follows the grid as it changes', async ({ page, portal }) => {
        portal.page(solutionView([row(0, 'Notify approver', 'On')]));
        await page.goto(`https://make.powerapps.com/environments/${guid(1)}/solutions/${guid(2)}`);
        await expect(page.locator('.ppt-off-row')).toHaveCount(0);
        // The portal re-renders the cell when a flow is turned off.
        await page.locator('[data-automation-key="status"] div').evaluate((cell) => { cell.textContent = 'Off'; });
        await expect(page.locator('.ppt-off-row')).toHaveCount(1);
    });
});
