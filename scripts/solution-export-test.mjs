#!/usr/bin/env node
/**
 * Smoke test for the Solution Deployer's export watcher
 * (src/tools/solution-deployer.js) — the wait between ExportSolutionAsync
 * handing back a job id and DownloadSolutionExportData having something to
 * hand back.
 *
 * The interesting cases are the ones where the async operation stops being a
 * reliable narrator: a record cleaned up right after succeeding looks exactly
 * like one that never existed, and an org that answers nothing at all has to be
 * told apart from a job that is simply still queued.
 * Run: node scripts/solution-export-test.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The module pulls in the UI kit and the storage layer at import time. Neither
// runs anything on load, but both name globals that do not exist in node.
globalThis.chrome = { runtime: { id: 'test' }, storage: { local: {}, onChanged: { addListener() {} } } };
globalThis.document = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
globalThis.window = { addEventListener() {} };

const { pollExportProgress } = await import(
    pathToFileURL(join(ROOT, 'extension/src/tools/solution-deployer.js')));

// Real time, wound down: the guards are proportions of the poll interval, so
// the whole suite runs in well under a second.
const FAST = { pollMs: 5, limits: { silence: 120, total: 400 } };

const httpError = (status) => Object.assign(new Error(`Dataverse ${status}`), { status });
const networkError = () => new Error('Network error reaching the environment.');

const QUEUED = { statecode: 0, statuscode: 0 };
const RUNNING = { statecode: 0, statuscode: 20 };
const SUCCEEDED = { statecode: 3, statuscode: 30 };

/** A reader that answers whatever `ops` says on each successive call; the last entry repeats. */
function fakeReader(ops) {
    const calls = { count: 0 };
    return {
        calls,
        read() {
            const op = ops[Math.min(calls.count++, ops.length - 1)];
            return op instanceof Error ? Promise.reject(op) : Promise.resolve(op);
        },
    };
}

const deadline = (ms) => new Promise((_, fail) => {
    setTimeout(() => fail(new Error('TEST TIMEOUT: the export watcher never settled')), ms).unref();
});
const watch = (reader, extra = {}) => Promise.race([
    pollExportProgress({ readAsyncOperation: reader.read, ...FAST, ...extra }),
    deadline(2000),
]);
const rejection = (promise) => promise.then(() => null, (e) => e.message);

let passed = 0;
const ok = (label) => { passed++; console.log(`  ✓ ${label}`); };

// ── The happy path ────────────────────────────────────────────────────────
{
    const logs = [];
    const reader = fakeReader([QUEUED, QUEUED, RUNNING, SUCCEEDED]);
    await watch(reader, { log: (level, message) => logs.push(message) });
    ok('resolves once the async operation succeeds');

    const queuedLogs = logs.filter((m) => m.includes('queued'));
    assert.equal(queuedLogs.length, 1, 'the queued notice should be logged once, not on every poll');
    ok('logs the queued notice exactly once');
}

// ── A job that fails ──────────────────────────────────────────────────────
{
    const reader = fakeReader([RUNNING, {
        statecode: 3, statuscode: 31,
        friendlymessage: 'Solution not found.\nInner detail nobody needs.',
    }]);
    const message = await rejection(watch(reader));
    assert.match(message, /failed/, 'the verdict should say the job failed');
    assert.match(message, /Solution not found\./);
    assert.ok(!message.includes('Inner detail'), 'only the first line of the message belongs in the error');
    ok('rejects with the first line of the failure message');
}

{
    const reader = fakeReader([{ statecode: 3, statuscode: 32 }]);
    const message = await rejection(watch(reader));
    assert.match(message, /was canceled/);
    ok('reports a canceled job as canceled');
}

{
    const reader = fakeReader([{ statecode: 3, statuscode: 99 }]);
    const message = await rejection(watch(reader));
    assert.match(message, /status 99/, 'an unmapped status should still be reported, not swallowed');
    ok('reports an unmapped terminal status verbatim');
}

// ── A record that is gone ─────────────────────────────────────────────────
// Cleanup after success and "never existed" are the same 404. Resolving hands
// the verdict to the download, which either produces a file or explains itself;
// rejecting here would fail exports that had in fact completed.
{
    const reader = fakeReader([RUNNING, httpError(404)]);
    await watch(reader);
    ok('resolves when the async operation record has vanished');
}

// ── An org that stops answering ───────────────────────────────────────────
{
    const reader = fakeReader([networkError()]);
    const message = await rejection(watch(reader));
    assert.match(message, /Lost contact/);
    ok('gives up when the environment answers nothing at all');
}

// A non-404 HTTP error still proves the org is reachable, so the silence guard
// must not fire — the total limit is what ends this one.
{
    const reader = fakeReader([httpError(503)]);
    const message = await rejection(watch(reader));
    assert.match(message, /has not finished/, 'a reachable-but-unhappy org should hit the total limit, not silence');
    ok('treats an HTTP error as contact, and times out on the total limit');
}

// ── A job that never finishes ─────────────────────────────────────────────
{
    const reader = fakeReader([RUNNING]);
    const message = await rejection(watch(reader));
    assert.match(message, /has not finished/);
    assert.match(message, /system jobs/, 'the error should say where to look');
    ok('gives up on a job that runs forever');
}

// ── Solution History export rows ───────────────────────────────────────────────────
// Reading the wrong creator lookup is invisible in review and obvious only in
// front of real data, where every impersonated export is credited to "SYSTEM".
{
    const { exportRow, downloadName } = await import(
        pathToFileURL(join(ROOT, 'extension/src/tools/shared/solution-exports.js')));

    const impersonated = exportRow({
        exportsolutionuploadid: '3e4e5ad6-0a84-4f53-9531-7e624e32a917',
        solutionuniquename: 'SmartWorkflows',
        solutionfilename: 'SmartWorkflows_4aa1c138.zip',
        createdon: '2026-08-14T01:06:49Z',
        '_createdby_value@OData.Community.Display.V1.FormattedValue': 'SYSTEM',
        '_createdonbehalfby_value@OData.Community.Display.V1.FormattedValue': 'Nightly Export Job',
    });
    assert.equal(impersonated.createdBy, 'Nightly Export Job', 'the delegate names the real actor, not SYSTEM');
    ok('credits an impersonated export to the delegate, not SYSTEM');

    const direct = exportRow({
        exportsolutionuploadid: 'a', solutionuniquename: 'Contoso', createdon: '2026-08-14T01:06:49Z',
        '_createdby_value@OData.Community.Display.V1.FormattedValue': 'Ada Lovelace',
    });
    assert.equal(direct.createdBy, 'Ada Lovelace', 'without a delegate, createdby is the actor');
    ok('falls back to createdby when there is no delegate');

    assert.equal(downloadName(impersonated), 'SmartWorkflows_4aa1c138.zip',
        'the stored filename already carries a unique suffix and should be kept');
    assert.equal(downloadName(direct), 'Contoso_20260814T010649Z.zip',
        'without a stored filename, the name is built from the solution and its timestamp');
    ok('names the saved file from the stored filename, or the timestamp when there is none');
}

console.log(`\n${passed} checks passed.`);
