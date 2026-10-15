#!/usr/bin/env node
/**
 * Smoke test for the Solution History's import row model
 * (src/tools/shared/solution-imports.js) — the part that decides what counts as
 * one operation, and the only part with no UI to eyeball.
 *
 * Loads the real module against a stubbed extension environment and checks the
 * cases the naive version gets wrong: an upgrade written to both importjobs and
 * solution history showing up twice, a promote step being mislabelled "Import",
 * a failure recorded only in the history row, and two imports of the same
 * solution cross-matching each other.
 * Run: node scripts/import-monitor-test.mjs
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

const { operationLabel, importJobRow, historyRow, mergeRows } = await import(
    pathToFileURL(join(ROOT, 'extension/src/tools/shared/solution-imports.js')));

const iso = (minutesAgo) => new Date(Date.UTC(2026, 7, 5, 12, 0, 0) - minutesAgo * 60_000).toISOString();

// ── Operation naming ──────────────────────────────────────────────────────
// The raw operation/suboperation pair is ambiguous alone: an upgrade arrives as
// Import+Upgrade, while the promote that finishes a two-step upgrade arrives as
// Uninstall+Upgrade. Both must read differently in the table.
assert.equal(operationLabel({ msdyn_operation: 0, msdyn_suboperation: 2 }), 'Upgrade');
assert.equal(operationLabel({ msdyn_operation: 1, msdyn_suboperation: 2 }), 'Apply upgrade');
assert.equal(operationLabel({ msdyn_operation: 0, msdyn_suboperation: 5 }), 'Inline upgrade');
assert.equal(operationLabel({ msdyn_operation: 1, msdyn_suboperation: 0 }), 'Uninstall');
assert.equal(operationLabel({ msdyn_operation: 1, msdyn_suboperation: 4 }), 'Delete');
assert.equal(operationLabel({ msdyn_operation: 0, msdyn_suboperation: 1 }), 'Import');

// ── History verdicts ──────────────────────────────────────────────────────
// Shaped like rows the virtual provider actually returns: errorcode "0" and an
// empty exception message on success, no msdyn_result and no msdyn_totaltime at
// all. The verdict must come from the error code and message alone.
const baseHistory = {
    msdyn_solutionhistoryid: 'h1',
    msdyn_name: 'Contoso_Core',
    msdyn_operation: 1,
    msdyn_suboperation: 2,
    msdyn_status: 1,
    msdyn_errorcode: '0',
    msdyn_exceptionmessage: '',
    msdyn_exceptionstack: '',
    msdyn_starttime: iso(10),
    msdyn_endtime: iso(7),
};

assert.equal(historyRow(baseHistory).status, 'success');
assert.equal(historyRow({ ...baseHistory, msdyn_errorcode: '80097376' }).status, 'failure');
// A message with no code still means failure.
assert.equal(historyRow({ ...baseHistory, msdyn_exceptionmessage: 'Workflow uninstall: FAILURE' }).status, 'failure');
// A zero code is not an error, in either notation.
assert.equal(historyRow({ ...baseHistory, msdyn_errorcode: '0x0' }).status, 'success');
// msdyn_result must not be consulted: the provider never populates it, and its
// documented default (False = Failure) would brand every success a failure.
assert.equal(historyRow({ ...baseHistory, msdyn_result: false }).status, 'success');
// No end time means still running, whatever the status column says.
assert.equal(historyRow({ ...baseHistory, msdyn_endtime: null, msdyn_status: 0 }).status, 'running');

// msdyn_totaltime is in seconds; the panel formats milliseconds.
assert.equal(historyRow({ ...baseHistory, msdyn_totaltime: 95 }).durationMs, 95_000);
// Falls back to the timestamps when totaltime is absent — which is always, here.
assert.equal(historyRow(baseHistory).durationMs, 3 * 60_000);

// ── Merging the two sources ───────────────────────────────────────────────
const upgradeJob = {
    importjobid: 'j1',
    solutionname: 'Contoso_Core',
    startedon: iso(30),
    createdon: iso(31),
    completedon: iso(25),
    result: { status: 'success', errorCode: '', errorText: '' },
};
const upgradeHistory = {
    msdyn_solutionhistoryid: 'h2',
    msdyn_name: 'Contoso_Core',
    msdyn_operation: 0,          // ran as an import…
    msdyn_suboperation: 2,       // …but it was an upgrade
    msdyn_starttime: iso(30),
    msdyn_endtime: iso(25),
    msdyn_result: false,
    msdyn_errorcode: '-2147188685',
    msdyn_exceptionmessage: 'Solution dependencies could not be resolved',
};

{
    const rows = mergeRows([importJobRow(upgradeJob)], [historyRow(upgradeHistory)]);
    assert.equal(rows.length, 1, 'an upgrade in both tables is one operation, not two');
    const [row] = rows;
    assert.equal(row.job.importjobid, 'j1', 'the importjob side is kept, so the component log stays reachable');
    assert.equal(row.operation, 'Upgrade', 'the history side supplies the real operation name');
    assert.equal(row.history.msdyn_solutionhistoryid, 'h2');
    assert.equal(row.errorCode, '-2147188685');
    assert.equal(row.status, 'failure', 'a clean import log does not override a rolled-back upgrade');
}

{
    // The promote half has no importjob at all — it must survive on its own.
    const promote = { ...baseHistory, msdyn_solutionhistoryid: 'h3', msdyn_result: false };
    const rows = mergeRows([importJobRow(upgradeJob)], [historyRow(upgradeHistory), historyRow(promote)]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.operation), ['Apply upgrade', 'Upgrade'], 'newest first');
    assert.equal(rows[0].job, null);
}

{
    // Same solution, but the history row is hours away from the job: no match,
    // so neither record is silently swallowed by the other.
    const stale = { ...upgradeHistory, msdyn_starttime: iso(300), msdyn_endtime: iso(295) };
    const rows = mergeRows([importJobRow(upgradeJob)], [historyRow(stale)]);
    assert.equal(rows.length, 2, 'a distant history row is a different operation');
}

{
    // Two runs of the same solution close enough that both jobs sit inside the
    // match window of both history rows: pairing must go by nearest start time,
    // not by whichever job is scanned first.
    const second = { ...upgradeJob, importjobid: 'j2', startedon: iso(28), createdon: iso(28), completedon: iso(26) };
    const firstHistory = { ...upgradeHistory, msdyn_solutionhistoryid: 'hA', msdyn_starttime: iso(30), msdyn_endtime: iso(25) };
    const secondHistory = { ...upgradeHistory, msdyn_solutionhistoryid: 'hB', msdyn_starttime: iso(28), msdyn_endtime: iso(26) };

    const rows = mergeRows(
        [importJobRow(upgradeJob), importJobRow(second)],
        [historyRow(secondHistory), historyRow(firstHistory)]);
    assert.equal(rows.length, 2, 'two runs stay two rows');
    const byJob = Object.fromEntries(rows.map((r) => [r.job.importjobid, r.history.msdyn_solutionhistoryid]));
    assert.deepEqual(byJob, { j1: 'hA', j2: 'hB' }, 'each job paired with its own run');
}

{
    // A different solution never matches, however close in time.
    const other = { ...upgradeHistory, msdyn_solutionhistoryid: 'h4', msdyn_name: 'HR_Base' };
    const rows = mergeRows([importJobRow(upgradeJob)], [historyRow(other)]);
    assert.equal(rows.length, 2);
}

{
    // Running rows: an importjob mid-flight has no parsed result yet.
    const running = { importjobid: 'j9', solutionname: 'Contoso_Core', createdon: iso(2), startedon: iso(2), progress: 42 };
    assert.equal(importJobRow(running).status, 'running');
    assert.equal(importJobRow(running).durationMs, null);
}

// ── Rows copied from a live environment ───────────────────────────────────
// Trimmed verbatim from a UAT org, including the fields the provider omits, so
// a schema-driven rewrite cannot quietly reintroduce assumptions it breaks.
{
    // An uninstall that was still running when the query was made.
    const ongoing = historyRow({
        msdyn_solutionhistoryid: 'e497d2aa-ab45-45ff-b969-97086f655060',
        msdyn_name: 'SmartWorkflows',
        msdyn_operation: 1,
        msdyn_suboperation: 0,
        msdyn_status: 0,
        msdyn_errorcode: '0',
        msdyn_exceptionmessage: '',
        msdyn_exceptionstack: '',
        msdyn_starttime: '2026-08-05T10:40:11Z',
        msdyn_endtime: null,
    });
    assert.equal(ongoing.status, 'running');
    assert.equal(ongoing.operation, 'Uninstall');
    assert.equal(ongoing.errorCode, '');

    // The promote step of an upgrade, failed — the case this feature exists for.
    const failedPromote = historyRow({
        msdyn_solutionhistoryid: '706e6799-e62a-43d9-8a95-04f5396168cc',
        msdyn_name: 'SmartWorkflows',
        msdyn_operation: 1,
        msdyn_suboperation: 2,
        msdyn_status: 1,
        msdyn_errorcode: '80097376',
        msdyn_exceptionmessage: 'Workflow uninstall: FAILURE, workflow id 2288e30d-74d5-ed11-a7c7-00224861a581',
        msdyn_exceptionstack: '   at Microsoft.Crm.ObjectModel.WorkflowUninstallHandler...',
        msdyn_starttime: '2026-08-05T10:08:23Z',
        msdyn_endtime: '2026-08-05T10:30:46Z',
    });
    assert.equal(failedPromote.status, 'failure');
    assert.equal(failedPromote.operation, 'Apply upgrade');
    assert.equal(failedPromote.errorCode, '80097376');
    assert.equal(failedPromote.durationMs, (22 * 60 + 23) * 1000);

    // A completed delete, clean.
    const deleted = historyRow({
        msdyn_solutionhistoryid: 'bd0c9aa0-a941-40ca-9b66-10a42450b5fe',
        msdyn_name: 'QuickDeploy_20260724141437',
        msdyn_operation: 1,
        msdyn_suboperation: 4,
        msdyn_status: 1,
        msdyn_errorcode: '0',
        msdyn_exceptionmessage: '',
        msdyn_starttime: '2026-08-05T10:39:55Z',
        msdyn_endtime: '2026-08-05T10:40:00Z',
    });
    assert.equal(deleted.status, 'success');
    assert.equal(deleted.operation, 'Delete');
}

console.log('import monitor test passed: operation labelling, history verdicts, live-row shapes and import/history merging all OK');
