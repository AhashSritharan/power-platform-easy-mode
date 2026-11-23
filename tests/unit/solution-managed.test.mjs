#!/usr/bin/env node
/**
 * The Solution Deployer's managed mode (src/tools/solution-deployer.js):
 * which components an uninstall would delete, when the target already holds
 * the solution the other way round, and the async-job watcher reused for
 * UninstallSolutionAsync.
 * Run: node --test tests/unit/solution-managed.test.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

globalThis.chrome = { runtime: { id: 'test' }, storage: { local: {}, onChanged: { addListener() {} } } };
globalThis.document = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
globalThis.window = { addEventListener() {} };

const { hotfixOnlyComponents, deployModeConflict, pollExportProgress } = await import(
    pathToFileURL(join(ROOT, 'extension/src/tools/solution-deployer.js')));

const HOTFIX = 'aaaaaaaa-0000-0000-0000-000000000001';
const RELEASE = 'aaaaaaaa-0000-0000-0000-000000000002';
const DEFAULT = 'fd140aaf-4df4-11dd-bd17-0019b9312238';
const OTHER_UNMANAGED = 'aaaaaaaa-0000-0000-0000-000000000003';

// solutioncomponents rows as a live org returns them with
// $expand=solutionid($select=uniquename,ismanaged).
const row = (objectid, solutionid, uniquename, ismanaged) => ({ objectid, componenttype: 29, solutionid: { solutionid, uniquename, ismanaged } });

test('a component that a managed release also holds falls back to it, so it is not hotfix-only', () => {
    const components = [{ objectid: 'f1', componenttype: 29, name: 'Lead | Score new lead' }];
    const memberships = [
        row('f1', HOTFIX, 'QuickDeploy_1', true),
        row('f1', RELEASE, 'ContosoSalesAutomation', true),
        row('f1', DEFAULT, 'Default', false),
    ];
    assert.deepEqual(hotfixOnlyComponents(components, memberships, HOTFIX), []);
});

test('a component only the hotfix (plus Default or unmanaged solutions) holds is deleted by the uninstall', () => {
    const components = [
        { objectid: 'f1', componenttype: 29, name: 'Lead | Score new lead' },
        { objectid: 'f2', componenttype: 29, name: 'Lead | New hotfix flow' },
        { objectid: 't1', componenttype: 1, name: 'Delivery note' },
    ];
    const memberships = [
        row('f1', HOTFIX, 'QuickDeploy_1', true), row('f1', RELEASE, 'ContosoSalesAutomation', true),
        row('f2', HOTFIX, 'QuickDeploy_1', true), row('f2', DEFAULT, 'Default', false),
        row('t1', HOTFIX, 'QuickDeploy_1', true), row('t1', OTHER_UNMANAGED, 'Work', false),
    ];
    assert.deepEqual(hotfixOnlyComponents(components, memberships, HOTFIX).map((c) => c.name),
        ['Lead | New hotfix flow', 'Delivery note']);
});

test('ids compare without braces or case', () => {
    const components = [{ objectid: '{ABC}', componenttype: 29, name: 'x' }];
    const memberships = [row('abc', RELEASE.toUpperCase(), 'R', true)];
    assert.deepEqual(hotfixOnlyComponents(components, memberships, HOTFIX), []);
});

test('no conflict when the target lacks the solution or holds it the same way', () => {
    assert.equal(deployModeConflict(null, 'Core', true), null);
    assert.equal(deployModeConflict({ ismanaged: true }, 'Core', true), null);
    assert.equal(deployModeConflict({ ismanaged: false }, 'Core', false), null);
});

test('a managed deploy over an unmanaged copy on the target says to clean that up first', () => {
    const message = deployModeConflict({ ismanaged: false }, 'Core', true);
    assert.match(message, /"Core" is on the target as an unmanaged solution/);
    assert.match(message, /Cleanup/);
});

test('an unmanaged deploy over a managed copy on the target says to deploy it managed', () => {
    const message = deployModeConflict({ ismanaged: true }, 'Core', false);
    assert.match(message, /"Core" is installed managed on the target/);
    assert.match(message, /Deploy as managed/);
});

test('the async-job watcher names the job it waits for', async () => {
    await assert.rejects(pollExportProgress({
        what: 'uninstall',
        pollMs: 1,
        readAsyncOperation: async () => ({ statecode: 3, statuscode: 31, message: 'Cannot uninstall: dependencies\nstack' }),
    }), { message: 'The uninstall job failed: Cannot uninstall: dependencies' });
});
