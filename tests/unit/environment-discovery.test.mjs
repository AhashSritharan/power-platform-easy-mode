/**
 * Environment discovery (extension/src/tools/shared/environment-discovery.js):
 * the maker portal's own environment list, as captured during setup, turned
 * into environments for the shared registry — with a suggested DEV/TEST/PROD
 * label the user can change before saving.
 *
 * The response shape is the portal's
 * GET https://<tenant>.tenant.api.powerplatform.com/powerapps/environments?…
 * (2026-10-16), trimmed to the fields that matter, with placeholder values.
 * Run: node --test tests/unit/environment-discovery.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
globalThis.chrome = { runtime: { id: 'test' }, storage: { local: {}, onChanged: { addListener() {} } } };
globalThis.document = { addEventListener() {}, querySelector: () => null };
globalThis.window = { addEventListener() {} };
globalThis.location = { href: 'chrome-extension://test/welcome/welcome.html', origin: 'chrome-extension://test' };

const { parseDiscoveredEnvironments, suggestEnvType, saveDiscoveredEnvironments } =
    await import(pathToFileURL(join(ROOT, 'extension/src/tools/shared/environment-discovery.js')));
const { loadEnvironments } = await import(pathToFileURL(join(ROOT, 'extension/src/tools/shared/environments.js')));

const guid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

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

function fakeStore(initial = {}) {
    const data = { ...initial };
    return {
        data,
        async get(key, fallback) { return key in data ? data[key] : fallback; },
        async set(key, value) { data[key] = value; },
        async remove(key) { delete data[key]; },
        watch() { return () => {}; },
    };
}

test('the portal list becomes environments with an id, name, host and SKU', () => {
    const environments = parseDiscoveredEnvironments({
        value: [
            portalEnv(`Default-${guid(1)}`, 'Contoso (default)', 'Default', 'https://contoso-default.crm4.dynamics.com/'),
            portalEnv(guid(2).toUpperCase(), 'Contoso Sales DEV', 'Developer', 'https://contoso-sales-dev.crm4.dynamics.com/'),
            portalEnv(guid(3), 'Contoso Teams', 'Sandbox', null), // no Dataverse: nothing a tool can talk to
        ],
    });
    assert.deepEqual(environments, [
        { envId: `default-${guid(1)}`, name: 'Contoso (default)', host: 'contoso-default.crm4.dynamics.com', sku: 'Default', suggestedType: null },
        { envId: guid(2), name: 'Contoso Sales DEV', host: 'contoso-sales-dev.crm4.dynamics.com', sku: 'Developer', suggestedType: 'DEV' },
    ]);
    assert.deepEqual(parseDiscoveredEnvironments({}), [], 'an empty or odd response is no environments');
    assert.deepEqual(parseDiscoveredEnvironments(null), []);
});

test('the stage in the name suggests the label, the SKU only when the name says nothing', () => {
    assert.equal(suggestEnvType({ name: 'Contoso Sales DEV', sku: 'Sandbox' }), 'DEV');
    assert.equal(suggestEnvType({ name: 'Contoso Sales Test', sku: 'Sandbox' }), 'TEST');
    assert.equal(suggestEnvType({ name: 'Contoso Sales UAT', sku: 'Sandbox' }), 'UAT');
    assert.equal(suggestEnvType({ name: 'Contoso Sales Staging', sku: 'Sandbox' }), 'STAGING');
    assert.equal(suggestEnvType({ name: 'Contoso Sales Production', sku: 'Sandbox' }), 'PROD');
    assert.equal(suggestEnvType({ name: 'ContosoSalesPROD', sku: 'Sandbox' }), 'PROD');
    assert.equal(suggestEnvType({ name: 'Contoso Sales', sku: 'Production' }), 'PROD');
    assert.equal(suggestEnvType({ name: 'Contoso Sales', sku: 'Developer' }), 'DEV');
    assert.equal(suggestEnvType({ name: 'Contoso Sales', sku: 'Trial' }), 'DEV');
    assert.equal(suggestEnvType({ name: 'Contoso Sales', sku: 'Sandbox' }), null, 'a sandbox could be anything');
    assert.equal(suggestEnvType({ name: 'Contoso (default)', sku: 'Default' }), null);
    assert.equal(suggestEnvType({ name: 'Development', sku: 'Sandbox' }), 'DEV', 'a bare stage name is a stage too');
});

test('saving puts every environment in the registry the pickers read, labelled or not', async () => {
    const store = fakeStore();
    await saveDiscoveredEnvironments([
        { envId: guid(2), name: 'Contoso Sales DEV', host: 'contoso-sales-dev.crm4.dynamics.com', type: 'DEV' },
        { envId: guid(3), name: 'Contoso Sales Test', host: 'contoso-sales-test.crm4.dynamics.com', type: null },
    ], store);

    const environments = await loadEnvironments({ store });
    assert.deepEqual(environments.map(({ envId, type, name, host }) => ({ envId, type, name, host })), [
        { envId: guid(2), type: 'DEV', name: 'Contoso Sales DEV', host: 'contoso-sales-dev.crm4.dynamics.com' },
        { envId: guid(3), type: null, name: 'Contoso Sales Test', host: 'contoso-sales-test.crm4.dynamics.com' },
    ]);
    assert.equal(store.data.envIndicator_mappings[guid(2)].nameSource, 'org');
});

test('saving keeps what the user set before: a typed name, and other environments', async () => {
    const store = fakeStore({
        envIndicator_mappings: {
            [guid(2)]: { type: 'TEST', name: 'Sales sandbox', nameSource: 'user' },
            [guid(9)]: 'PROD',
        },
        envIndicator_hostCache: { 'contoso-legacy.crm4.dynamics.com': guid(9) },
    });
    await saveDiscoveredEnvironments([
        { envId: guid(2), name: 'Contoso Sales DEV', host: 'contoso-sales-dev.crm4.dynamics.com', type: 'DEV' },
    ], store);

    assert.deepEqual(store.data.envIndicator_mappings[guid(2)], { type: 'DEV', name: 'Sales sandbox', nameSource: 'user' });
    assert.equal(store.data.envIndicator_mappings[guid(9)], 'PROD', 'an environment the portal did not list is left alone');
    assert.deepEqual(store.data.envIndicator_hostCache, {
        'contoso-legacy.crm4.dynamics.com': guid(9),
        'contoso-sales-dev.crm4.dynamics.com': guid(2),
    });
});
