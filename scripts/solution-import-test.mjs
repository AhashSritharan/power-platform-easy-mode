#!/usr/bin/env node
/**
 * Smoke test for the Solution Deployer's import watcher
 * (src/tools/solution-deployer.js) — the state machine that decides when an
 * import is done, failed, or hung, and the only part of a deploy that cannot
 * be eyeballed without a second environment.
 *
 * It reads two sources that each go silent in a different failure: the
 * importjob row, which does not exist until a worker picks the job up and can
 * be left frozen with `completedon` never written, and the async operation,
 * which always has a status. The cases below are the ones that have actually
 * bitten: an import that never starts, one that fails without finishing its
 * job row, and a verdict that has to be read out of the import log instead.
 * Run: node scripts/solution-import-test.mjs
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

const { pollImportProgress } = await import(
    pathToFileURL(join(ROOT, 'extension/src/tools/solution-deployer.js')));

// The guards run on a clock the fake target advances by STEP on every poll,
// so the limits below count polls — 12, 40 and 12 — and not wall time.
// Timers are coarse on some systems (about 15.6 ms on Windows), and measured
// in wall time a 5 ms poll ran three times over its limits there.
const STEP = 10;
const FAST = { pollMs: 5, limits: { silence: 120, queue: 400, stall: 120 } };

const httpError = (status) => Object.assign(new Error(`Target API ${status}`), { status });
const networkError = () => new Error('Network error reaching target environment.');

const QUEUED = { statecode: 0, statuscode: 0 };  // waiting for a worker
const RUNNING = { statecode: 0, statuscode: 20 };
const SUCCEEDED = { statecode: 3, statuscode: 30 };

/**
 * A target whose importjob row and async operation are whatever `rows` and
 * `ops` say on each successive read; the last entry repeats forever.
 */
function fakeTarget({ rows = [httpError(404)], ops = [RUNNING], failure = null } = {}) {
    const calls = { job: 0, op: 0 };
    const next = (list, n) => list[Math.min(n, list.length - 1)];
    let clock = 0;
    return {
        calls,
        now: () => clock,
        // Every poll reads the job row first, so this is where time passes.
        readJob() {
            clock += STEP;
            const row = next(rows, calls.job++);
            return row instanceof Error ? Promise.reject(row) : Promise.resolve(row);
        },
        readAsyncOperation() {
            const op = next(ops, calls.op++);
            return op instanceof Error ? Promise.reject(op) : Promise.resolve(op);
        },
        readFailure: async () => failure,
    };
}

// A watcher that never settles is the bug this whole module exists to prevent,
// so waiting one out is a test failure rather than a hung suite.
const deadline = (ms) => new Promise((_, fail) => {
    setTimeout(() => fail(new Error('TEST TIMEOUT: the watcher never settled')), ms).unref();
});
const watch = (target, extra = {}) => Promise.race([
    pollImportProgress({ asyncOperationId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', ...target, ...FAST, ...extra }),
    deadline(2000),
]);
const rejection = (promise) => promise.then(() => null, (e) => e.message);

// ── The happy path ────────────────────────────────────────────────────────
// The job row finishes the wait: it is what the user is watching, and it
// outlives the async operation record the platform may clean up.
{
    const seen = [];
    const target = fakeTarget({
        rows: [{ progress: 0 }, { progress: 60 }, { progress: 100, completedon: '2026-08-10T13:00:00Z' }],
    });
    await watch(target, { onProgress: (p) => seen.push(p) });
    assert.deepEqual(seen, [0, 60, 100], 'every distinct percentage reaches the progress bar');
}

// The async operation is equally conclusive when the row never completes —
// the case that used to leave the panel spinning forever.
{
    const target = fakeTarget({ rows: [{ progress: 40 }], ops: [RUNNING, RUNNING, SUCCEEDED] });
    await watch(target);
}

// ── Queued, not stuck ─────────────────────────────────────────────────────
// No job row exists until a worker picks the job up. Being deferred is what
// the async action is for, so waiting must not be mistaken for failure — and
// the user should be told which of the two they are looking at.
{
    const logged = [];
    const queued = Array(30).fill(QUEUED);
    const target = fakeTarget({ rows: [httpError(404)], ops: [...queued, SUCCEEDED] });
    await watch(target, { log: (level, text) => logged.push(text) });
    assert.ok(
        logged.some((text) => /queued on target/.test(text)),
        'the wait for a worker is named, not left as silent dead air',
    );
    assert.ok(target.calls.op > 30, 'a queued job is polled past the stall limit without being failed');
}

// ── Failure ───────────────────────────────────────────────────────────────
// Only the first line of the platform's message: the rest is a stack trace.
{
    const target = fakeTarget({
        ops: [{ statecode: 3, statuscode: 31, friendlymessage: 'Import failed.\n   at Microsoft.Crm…' }],
    });
    const message = await rejection(watch(target));
    assert.equal(message, 'The import job on the target failed: Import failed.');
}

// The import log outranks it whenever the job managed to write one, because
// that is the message naming the component that actually broke.
{
    const target = fakeTarget({
        ops: [{ statecode: 3, statuscode: 31, friendlymessage: 'Import failed.' }],
        failure: 'Missing dependency: account.new_field',
    });
    assert.equal(await rejection(watch(target)), 'Missing dependency: account.new_field');
}

// A job row that completed is not proof of success — the log has the verdict.
{
    const target = fakeTarget({
        rows: [{ progress: 100, completedon: '2026-08-10T13:00:00Z' }],
        failure: 'Solution import failed on target.',
    });
    assert.equal(await rejection(watch(target)), 'Solution import failed on target.');
}

// A cancelled job reads as cancelled, not as a generic failure.
{
    const target = fakeTarget({ ops: [{ statecode: 3, statuscode: 32 }] });
    assert.match(await rejection(watch(target)), /was canceled/);
}

// ── Waits that would otherwise never end ──────────────────────────────────
// An unreachable target: no status means the round trip never completed.
{
    const target = fakeTarget({ rows: [networkError()], ops: [networkError()] });
    assert.equal(
        await rejection(watch(target)),
        'Lost contact with the target environment while importing.',
    );
}

// A job frozen mid-import with a status that never changes again.
{
    const target = fakeTarget({ rows: [{ progress: 20 }], ops: [RUNNING] });
    assert.match(await rejection(watch(target)), /stopped reporting progress at 20%/);
}

// The same guard, before any progress exists, reads differently — there is no
// percentage to quote and the user needs to look at the target instead.
{
    const target = fakeTarget({ rows: [httpError(404)], ops: [RUNNING] });
    assert.match(await rejection(watch(target)), /has not started on the target/);
}

// A job nobody ever picks up does eventually give up, on its own limit and
// with its own wording — being queued is not the same as being stuck.
{
    const target = fakeTarget({ rows: [httpError(404)], ops: [QUEUED] });
    assert.match(await rejection(watch(target)), /still queued on the target/);
}

// ── Blips ─────────────────────────────────────────────────────────────────
// A single unreadable poll is not a verdict: the run must survive it.
{
    const target = fakeTarget({
        rows: [{ progress: 10 }, networkError(), { progress: 100, completedon: '2026-08-10T13:00:00Z' }],
        ops: [RUNNING, networkError(), RUNNING],
    });
    await watch(target);
}

// A 404 is an answer, so a job row that does not exist yet must not be
// mistaken for a target that has gone quiet.
{
    const target = fakeTarget({ rows: [httpError(404)], ops: [...Array(30).fill(QUEUED), SUCCEEDED] });
    await watch(target);
}

// Even with both records gone — an async operation the platform has already
// cleaned up, and a job row that never appeared — the target is answering.
// The wait has to end by naming the missing import, not by blaming the
// connection, so the 404s must keep the silence guard from firing.
{
    const target = fakeTarget({ rows: [httpError(404)], ops: [httpError(404)] });
    assert.match(await rejection(watch(target)), /has not started on the target/);
}

console.log('solution-import-test: all cases pass');
