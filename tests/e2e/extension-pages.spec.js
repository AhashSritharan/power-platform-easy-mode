// The extension's own pages: the options page and the toolbar popup.
import { test, expect } from './fixtures.js';
import { TOOLS } from '../../extension/src/registry.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './env.js';

const manifest = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8'));

test.describe('Extension pages', () => {
    test('options page lists every tool with a switch', async ({ page, extensionId }) => {
        await page.goto(`chrome-extension://${extensionId}/options/options.html`);
        const rows = page.locator('#tool-list .tool');
        await expect(rows).toHaveCount(TOOLS.length);
        for (const tool of TOOLS) {
            const row = rows.filter({ has: page.locator('.name', { hasText: tool.name }) });
            await expect(row.locator('input[type=checkbox]')).toHaveJSProperty('checked', tool.defaultEnabled !== false);
        }
        await expect(page.locator('#launcher-toggle')).toBeChecked();
    });

    test('popup renders with the manifest version', async ({ page, extensionId }) => {
        await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
        await expect(page.locator('#version')).toHaveText(`v${manifest.version}`);
        await expect(page.locator('#loading')).toBeHidden({ timeout: 10_000 });
    });
});
