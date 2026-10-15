// The tools on Dynamics 365 (main.aspx), against the developer environment.
// Read-only: every test opens a tool and checks it loads its data — nothing is
// saved, cloned, deployed or switched.
import { test, expect } from './fixtures.js';
import { env } from '../support/env.js';
import {
    expectLoaded, expectedTools, firstRecord, gotoDynamics, openPalette, pageCommands, paletteTitles, runCommand, settle,
} from '../support/helpers.js';

test.describe('Dynamics 365', () => {
    test('every tool for main.aspx starts and registers its commands', async ({ page, serviceWorker }) => {
        await gotoDynamics(page);
        const commands = await pageCommands(serviceWorker, page);
        const registered = new Set(commands.map((c) => c.toolId));
        const missing = expectedTools(page.url()).filter((t) => !registered.has(t.id)).map((t) => t.name);
        expect(missing, 'tools without a command on main.aspx').toEqual([]);
    });

    test('the launcher opens the palette with every command', async ({ page, serviceWorker }) => {
        await gotoDynamics(page);
        const commands = await pageCommands(serviceWorker, page);
        const palette = await openPalette(page);
        expect((await paletteTitles(palette)).sort()).toEqual(commands.map((c) => c.caption).sort());
        // Search narrows the list.
        await palette.locator('input.ppt-input').fill('solution deployer');
        await expect(palette.locator('.ppt-palette-card')).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect(palette).toBeHidden();
    });

    test('Environment Indicator: configure dialog opens', async ({ page }) => {
        await gotoDynamics(page);
        await runCommand(page, 'Configure Environment Indicator');
        const dialog = page.locator('.ppt-dialog').last();
        await expectLoaded(dialog);
        await expect(dialog.locator('select').first()).toBeVisible();
    });

    test('Audit History opens and loads', async ({ page }) => {
        await gotoDynamics(page);
        await runCommand(page, 'Open Audit History');
        await expectLoaded(page.locator('.audit-panel'));
    });

    test('Record Browser lists the records of the table', async ({ page }) => {
        await gotoDynamics(page, `pagetype=entitylist&etn=${env.table}`);
        await runCommand(page, 'Browse Records');
        const panel = page.locator('.rb-panel');
        await expectLoaded(panel);
        await expect(panel.locator('tbody tr').first()).toBeVisible();
    });

    test('Record Editor loads the values of a record', async ({ page }) => {
        await gotoDynamics(page);
        const record = await firstRecord(page);
        await gotoDynamics(page, `pagetype=entityrecord&etn=${record.table}&id=${record.id}`);
        await runCommand(page, 'Edit Record Values');
        const count = page.locator('.fe-count');
        await expect(count).not.toBeEmpty({ timeout: 60_000 });
        await expectLoaded(page.locator('.fe-modal'));
    });

    test('Deep Clone loads a record and its options', async ({ page }) => {
        await gotoDynamics(page);
        const record = await firstRecord(page);
        await gotoDynamics(page, `pagetype=entityrecord&etn=${record.table}&id=${record.id}`);
        await runCommand(page, 'Clone Record');
        await expectLoaded(page.locator('.dc-backdrop'));
    });

    test('Solution Deployer lists solutions and opens every mode', async ({ page }) => {
        await gotoDynamics(page);
        await runCommand(page, 'Open Solution Deployer');
        const panel = page.locator('.sd-panel');
        await expectLoaded(panel);

        await panel.getByRole('button', { name: '📋 Existing Solution' }).click();
        await panel.getByRole('button', { name: '📦 Select a solution…' }).click();
        const picker = page.locator('.sd-modal');
        await expect(picker.locator('.sd-item').first()).toBeVisible({ timeout: 30_000 });
        await page.keyboard.press('Escape');

        await panel.getByRole('button', { name: '🔍 Check Deps' }).click();
        await expect(panel.getByText('Dependency Check.')).toBeVisible();
        await panel.getByRole('button', { name: '🧹 Cleanup' }).click();
        await expect(panel.getByText('Cleanup Mode.')).toBeVisible();
        await expectLoaded(panel);
    });

    test('Solution History loads imports and exports', async ({ page }) => {
        await gotoDynamics(page);
        await runCommand(page, 'Open Solution History');
        const panel = page.locator('.sh-panel');
        const tabs = panel.locator('.sh-tab');
        await expect(tabs).toHaveCount(2);
        for (const i of [0, 1]) {
            await tabs.nth(i).click();
            await expectLoaded(panel, 90_000);
        }
    });

    test('Add Existing Components lists components', async ({ page }) => {
        await gotoDynamics(page);
        await runCommand(page, 'Add Existing Components (filterable)');
        const panel = page.locator('.grid-panel').last();
        await expectLoaded(panel, 90_000);
        await expect(panel.locator('tbody tr').first()).toBeVisible();
    });

    test('Cloud Flow Manager lists solutions and loads their flows', async ({ page }) => {
        await gotoDynamics(page);
        await runCommand(page, 'Open Cloud Flow Manager');
        const panel = page.locator('.cfm-panel');
        const select = panel.locator('[data-f=solution]');
        await expect(select.locator('option[value]:not([value=""])').first()).toBeAttached({ timeout: 30_000 });
        const first = await select.locator('option[value]:not([value=""])').first().getAttribute('value');
        await select.selectOption(first);
        await panel.locator('[data-act=load]').click();
        await expectLoaded(panel);
    });

    test('Flow Run Monitor loads runs', async ({ page }) => {
        await gotoDynamics(page);
        await runCommand(page, 'Open Flow Run Monitor');
        const panel = page.locator('.frm-panel');
        await expectLoaded(panel, 90_000);
        for (const view of ['stats', 'errors', 'table']) {
            await panel.locator(`.frm-tab[data-view=${view}]`).click();
            await settle(panel);
        }
        await expectLoaded(panel);
    });
});
