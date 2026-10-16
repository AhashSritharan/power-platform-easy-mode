// The setup wizard on the welcome page: tools on/off, the environments the
// user can access (found through the maker portal, which the extension opens
// in a background tab with ?ppt-discover=1), and the Clockify settings both
// Clockify tools share.
//
// The stub portal makes the request the real one makes on load (2026-10-16);
// the response is that request's shape with placeholder values. Clockify's
// /user and /workspaces answers follow Clockify's API reference — there is no
// Clockify account to copy them from.
import { test, expect } from './fixtures.js';
import { guid } from './fake-dataverse.js';

const ENV_API = 'https://contoso.tenant.api.powerplatform.com/powerapps/environments';
const DEFAULT_ENV = `Default-${guid(1801)}`;
const DEV_ENV = guid(1802);
const PROD_ENV = guid(1803);

const portalEnv = (id, displayName, sku, instanceUrl) => ({
    id: `/providers/Microsoft.PowerApps/environments/${id}`,
    name: id,
    type: 'Microsoft.PowerApps/environments',
    location: 'europe',
    properties: {
        displayName,
        environmentSku: sku,
        isDefault: sku === 'Default',
        ...(instanceUrl ? { linkedEnvironmentMetadata: { friendlyName: displayName, instanceUrl, instanceState: 'Ready' } } : {}),
    },
});
const ENVIRONMENTS = {
    value: [
        portalEnv(DEFAULT_ENV, 'Contoso (default)', 'Default', 'https://contoso-default.crm4.dynamics.com/'),
        portalEnv(DEV_ENV, 'Contoso Sales DEV', 'Developer', 'https://contoso-sales-dev.crm4.dynamics.com/'),
        portalEnv(PROD_ENV, 'Contoso Sales', 'Production', 'https://contoso-sales.crm4.dynamics.com/'),
        portalEnv(guid(1804), 'Contoso Teams', 'Sandbox', null),
    ],
};

// The portal asks for its environment list a moment after it loads.
const portalHome = `<!doctype html><html><head><title>Power Apps | Home</title></head><body>
<script>
  setTimeout(() => fetch(${JSON.stringify(`${ENV_API}?%24expand=properties.permissions&api-version=1&%24top=200`)}), 300);
</script></body></html>`;

const stored = (serviceWorker, key) => serviceWorker.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);

test.describe('Setup', () => {
    test.beforeEach(async ({ serviceWorker, org }) => { // eslint-disable-line no-unused-vars
        // `org` has reset the extension's storage: a first install.
    });

    test('finds the environments you can access, suggests their labels, and saves them for every tool', async ({ page, extensionId, extensionContext, serviceWorker, portal }) => {
        portal.page(portalHome);
        await extensionContext.route((url) => url.href.startsWith(`${ENV_API}?`), (route) => route.fulfill({
            json: ENVIRONMENTS,
            headers: { 'Access-Control-Allow-Origin': 'https://make.powerapps.com' },
        }));
        await page.goto(`chrome-extension://${extensionId}/welcome/welcome.html`);
        await page.getByRole('button', { name: 'Next' }).click();

        const portalTab = extensionContext.waitForEvent('page');
        await page.getByRole('button', { name: 'Find my environments' }).click();
        // Playwright cannot route the first navigation of a tab the extension
        // opens, so that one reaches the real portal. Loading the same URL again
        // in the same tab — the one the extension waits for — gets the stub.
        await (await portalTab).goto('https://make.powerapps.com/?ppt-discover=1');
        const rows = page.locator('.env-row');
        await expect(rows).toHaveCount(3);
        const row = (name) => rows.filter({ has: page.locator('.env-name', { hasText: new RegExp(`^${name.replace(/[()]/g, '\\$&')}$`) }) });
        await expect(row('Contoso Sales DEV')).toContainText('contoso-sales-dev.crm4.dynamics.com');
        await expect(row('Contoso Sales DEV').locator('select')).toHaveValue('DEV');
        await expect(row('Contoso Sales').locator('select')).toHaveValue('PROD');
        await expect(row('Contoso (default)').locator('select')).toHaveValue('');
        await row('Contoso (default)').locator('select').selectOption('TEST');
        await expect.poll(() => extensionContext.pages().filter((p) => p.url().includes('ppt-discover')).length, { message: 'the portal tab is closed again' }).toBe(0);

        await page.getByRole('button', { name: 'Next' }).click();
        await expect(page.getByRole('heading', { name: /all set/i })).toBeVisible();

        const mappings = await stored(serviceWorker, 'vals/environment-indicator/envIndicator_mappings');
        expect(mappings).toEqual({
            [DEFAULT_ENV.toLowerCase()]: { type: 'TEST', name: 'Contoso (default)', nameSource: 'org' },
            [DEV_ENV]: { type: 'DEV', name: 'Contoso Sales DEV', nameSource: 'org' },
            [PROD_ENV]: { type: 'PROD', name: 'Contoso Sales', nameSource: 'org' },
        });
        expect(await stored(serviceWorker, 'vals/environment-indicator/envIndicator_hostCache')).toEqual({
            'contoso-default.crm4.dynamics.com': DEFAULT_ENV.toLowerCase(),
            'contoso-sales-dev.crm4.dynamics.com': DEV_ENV,
            'contoso-sales.crm4.dynamics.com': PROD_ENV,
        });
    });

    test('turns tools on and off, and asks for Clockify once, for both Clockify tools', async ({ page, extensionId, extensionContext, serviceWorker }) => {
        const keys = [];
        await extensionContext.route('https://api.clockify.me/api/v1/**', (route) => {
            keys.push(route.request().headers()['x-api-key']);
            const path = new URL(route.request().url()).pathname;
            if (path === '/api/v1/user') return route.fulfill({ json: { id: 'user-1', name: 'Pat Doe', email: 'pat@contoso.com', activeWorkspace: 'ws-2', defaultWorkspace: 'ws-1' } });
            if (path === '/api/v1/workspaces') return route.fulfill({ json: [{ id: 'ws-1', name: 'Contoso' }, { id: 'ws-2', name: 'Fabrikam' }] });
            return route.fulfill({ status: 404, json: { message: 'Not found', code: 404 } });
        });
        await page.goto(`chrome-extension://${extensionId}/welcome/welcome.html`);

        const tool = (name) => page.locator('.tool').filter({ has: page.locator('.name', { hasText: name }) });
        await expect(tool('Clockify → Dynamics 365 Sync').locator('input')).not.toBeChecked();
        for (const name of ['Clockify → Dynamics 365 Sync', 'Jira Clockify Timer', 'Record Browser']) {
            await tool(name).locator('.switch').click(); // the styled switch over the hidden checkbox
        }
        await expect(tool('Record Browser').locator('input')).not.toBeChecked();
        await page.getByRole('button', { name: 'Next' }).click();
        await page.getByRole('button', { name: 'Skip' }).click();

        await expect(page.getByRole('heading', { name: 'Clockify' })).toBeVisible();
        await page.getByLabel('Clockify API key').fill('key-1');
        await page.getByRole('button', { name: 'Connect' }).click();
        await expect(page.locator('#clockify-status')).toHaveText('✅ Connected as Pat Doe');
        await expect(page.getByLabel('Workspace')).toHaveValue('ws-2'); // the one Clockify has active
        await page.getByLabel('Workspace').selectOption({ label: 'Contoso' });
        await page.getByLabel('Duration rounding').selectOption('15');
        await page.getByLabel(/Round up once/).fill('5');
        await page.getByRole('button', { name: 'Next' }).click();
        await expect(page.getByRole('heading', { name: /all set/i })).toBeVisible();

        expect(keys.every((key) => key === 'key-1')).toBe(true);
        expect(await stored(serviceWorker, 'enabledTools')).toMatchObject({
            'clockify-sync': true, 'jira-clockify-timer': true, 'record-browser': false, 'solution-deployer': true,
        });
        expect(await stored(serviceWorker, 'vals/clockify/api_key')).toBe('key-1');
        expect(await stored(serviceWorker, 'vals/clockify/workspace_id')).toBe('ws-1');
        expect(await stored(serviceWorker, 'vals/clockify/user_id')).toBe('user-1');
        expect(await stored(serviceWorker, 'vals/clockify-sync/clockify_rounding')).toEqual({ block: 15, roundUpFrom: 5 });
    });

    test('skips Clockify when no Clockify tool is on', async ({ page, extensionId }) => {
        await page.goto(`chrome-extension://${extensionId}/welcome/welcome.html`);
        await page.getByRole('button', { name: 'Next' }).click();
        await page.getByRole('button', { name: 'Skip' }).click();
        await expect(page.getByRole('heading', { name: /all set/i })).toBeVisible();
    });

    test('can be run again from Settings, showing what was chosen', async ({ page, extensionId, serviceWorker }) => {
        await serviceWorker.evaluate(() => chrome.storage.local.set({ enabledTools: { 'record-browser': false } }));
        await page.goto(`chrome-extension://${extensionId}/options/options.html`);
        await page.getByRole('link', { name: 'Run setup again' }).click();
        await expect(page).toHaveURL(/welcome\/welcome\.html/);
        const recordBrowser = page.locator('.tool').filter({ has: page.locator('.name', { hasText: 'Record Browser' }) });
        await expect(recordBrowser.locator('input[type=checkbox]')).not.toBeChecked();
    });
});
