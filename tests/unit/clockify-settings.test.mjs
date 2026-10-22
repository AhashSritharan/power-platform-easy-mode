/**
 * Shared Clockify settings (extension/src/tools/shared/clockify-settings.js):
 * the API key, workspace and user id are entered once — in setup or in either
 * Clockify tool — and used by both. Values the tools saved on their own before
 * are still found.
 * Run: node --test tests/unit/clockify-settings.test.mjs
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

const { loadClockifySettings, saveClockifySettings, preferredWorkspace } =
    await import(pathToFileURL(join(ROOT, 'extension/src/tools/shared/clockify-settings.js')));

/** Namespaced in-memory stores, keyed like chrome.storage: { 'ns/key': value }. */
function fakeStores(initial = {}) {
    const data = { ...initial };
    const storeFor = (ns) => ({
        async get(key, fallback) { return `${ns}/${key}` in data ? data[`${ns}/${key}`] : fallback; },
        async set(key, value) { data[`${ns}/${key}`] = value; },
    });
    return { data, storeFor };
}

test('nothing saved anywhere: empty settings', async () => {
    const { storeFor } = fakeStores();
    assert.deepEqual(await loadClockifySettings({ storeFor }), { apiKey: '', workspaceId: '', userId: '' });
});

test('settings saved once are what both tools read', async () => {
    const { storeFor, data } = fakeStores();
    await saveClockifySettings({ apiKey: 'key-1', workspaceId: 'ws-1' }, { storeFor });
    await saveClockifySettings({ userId: 'user-1' }, { storeFor });
    assert.deepEqual(await loadClockifySettings({ storeFor }), { apiKey: 'key-1', workspaceId: 'ws-1', userId: 'user-1' });
    assert.deepEqual(data, { 'clockify/api_key': 'key-1', 'clockify/workspace_id': 'ws-1', 'clockify/user_id': 'user-1' });
});

test('what either tool saved on its own before is still found', async () => {
    const { storeFor } = fakeStores({
        'jira-clockify-timer/clockify_api_key': 'timer-key',
        'jira-clockify-timer/clockify_workspace_id': 'timer-ws',
        'clockify-sync/clockify_workspace_id': 'sync-ws',
        'clockify-sync/clockify_user_id': 'sync-user',
    });
    assert.deepEqual(await loadClockifySettings({ storeFor }), { apiKey: 'timer-key', workspaceId: 'sync-ws', userId: 'sync-user' });
});

test('a shared value wins over an old per-tool one, which only fills what was never saved', async () => {
    const { storeFor } = fakeStores({
        'clockify/api_key': 'shared-key',
        'clockify-sync/clockify_api_key': 'old-key',
        'clockify-sync/clockify_workspace_id': 'old-ws',
    });
    assert.deepEqual(await loadClockifySettings({ storeFor }), { apiKey: 'shared-key', workspaceId: 'old-ws', userId: '' });
});

test('once saved, the shared settings stand on their own: a cleared value stays cleared', async () => {
    const { storeFor } = fakeStores({
        'clockify-sync/clockify_api_key': 'old-key',
        'clockify-sync/clockify_workspace_id': 'old-ws',
    });
    await saveClockifySettings({ workspaceId: '' }, { storeFor });
    assert.deepEqual(await loadClockifySettings({ storeFor }), { apiKey: 'old-key', workspaceId: '', userId: '' });
});

test('changing the key forgets the user id it belonged to', async () => {
    const { storeFor } = fakeStores({ 'clockify/api_key': 'key-1', 'clockify/user_id': 'user-1' });
    await saveClockifySettings({ apiKey: 'key-2' }, { storeFor });
    assert.equal((await loadClockifySettings({ storeFor })).userId, '');
    await saveClockifySettings({ apiKey: 'key-2', userId: 'user-2' }, { storeFor });
    await saveClockifySettings({ apiKey: 'key-2' }, { storeFor });
    assert.equal((await loadClockifySettings({ storeFor })).userId, 'user-2', 'the same key keeps it');
});

test('the workspace offered first: the saved one, else the active one in Clockify, else its default, else the first', () => {
    const workspaces = [{ id: 'ws-1' }, { id: 'ws-2' }, { id: 'ws-3' }];
    const user = { activeWorkspace: 'ws-2', defaultWorkspace: 'ws-3' };
    assert.equal(preferredWorkspace(workspaces, user, 'ws-3'), 'ws-3');
    assert.equal(preferredWorkspace(workspaces, user, 'gone'), 'ws-2', 'a saved workspace no longer there is passed over');
    assert.equal(preferredWorkspace(workspaces, { defaultWorkspace: 'ws-3' }, ''), 'ws-3');
    assert.equal(preferredWorkspace(workspaces, {}, ''), 'ws-1');
    assert.equal(preferredWorkspace([], user, 'ws-1'), '');
});
