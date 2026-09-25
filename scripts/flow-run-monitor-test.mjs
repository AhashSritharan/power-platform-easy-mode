#!/usr/bin/env node
/**
 * Smoke test for the Flow Run Monitor's failure-issue model
 * (src/tools/flow-run-monitor.js) — the part that decides what counts as one
 * problem, and the only part of the Errors view with no UI to eyeball.
 *
 * Loads the real module against a stubbed extension environment and checks the
 * cases the naive "group by error message" version gets wrong: the same error
 * text failing to merge because it embeds a record id; a flow1→flow2→flow3
 * cascade counted as three problems when only flow3 is worth opening; an
 * ancestor that caught the error and reported success dropping out of the
 * chain entirely; and two different callers of the same broken flow being
 * lumped together.
 * Run: node scripts/flow-run-monitor-test.mjs
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

const {
    toOccurrence, applyCause, errorKeyOf, groupKeyOf, callerKeyOf, callerLabelOf,
    buildCascades, collectAncestors, propagateOriginCause, openDimensions,
    buildIssues, issueBreakdown, issueRunCount, sparkBins, fetchPagedRuns, distinctPaths,
} = await import(pathToFileURL(join(ROOT, 'extension/src/tools/flow-run-monitor.js')));

const BASE = Date.UTC(2026, 8, 1, 12, 0, 0);
const iso = (minutesAgo) => new Date(BASE - minutesAgo * 60_000).toISOString();

// Shaped like rows the flowruns elastic table actually returns: the flow name
// only ever arrives as a formatted-value annotation on the lookup, and a child
// run points at its parent by run NAME, not by id.
const run = ({ id, flow, flowName, minutesAgo, status = 'Failed', code = 'ActionFailed', message, parent }) => ({
    flowrunid: `id-${id}`,
    name: id,
    status,
    starttime: iso(minutesAgo),
    duration: 1200,
    errorcode: code,
    errormessage: message,
    parentrunid: parent,
    _workflow_value: flow,
    '_workflow_value@OData.Community.Display.V1.FormattedValue': flowName,
});

const occ = (spec, cause = null) => toOccurrence(run(spec), cause);
const DEPENDENT = 'An action failed. No dependent actions succeeded.';

// ── Fingerprinting ────────────────────────────────────────────────────────
// Ids, numbers and urls are noise: the same bug against three records is one
// issue, not three.
const a = occ({ id: '1', flow: 'f1', flowName: 'Sync Orders', minutesAgo: 30, message: 'Record 41 was not found' });
const b = occ({ id: '2', flow: 'f1', flowName: 'Sync Orders', minutesAgo: 20, message: 'Record 8127 was not found' });
assert.equal(errorKeyOf(a), errorKeyOf(b), 'record ids must not split one issue');

const c = occ({ id: '3', flow: 'f1', flowName: 'Sync Orders', minutesAgo: 10, message: 'Rate limit exceeded' });
assert.notEqual(errorKeyOf(a), errorKeyOf(c));

// errormessage is often serialized JSON — the message, not the envelope, is
// what gets fingerprinted.
const wrapped = occ({ id: '4', flow: 'f1', flowName: 'Sync Orders', minutesAgo: 5, message: '{"code":"NotFound","message":"Record 99 was not found"}' });
assert.equal(errorKeyOf(wrapped), errorKeyOf(a), 'JSON envelopes must be unwrapped before fingerprinting');

// A cause drilled out of a child run afterwards renames the issue.
const drilled = occ({ id: '5', flow: 'f2', flowName: 'Order Parent', minutesAgo: 40, message: DEPENDENT });
applyCause(drilled, { message: 'Rate limit exceeded', sourceFlow: 'Order Child' });
assert.equal(drilled.message, 'Rate limit exceeded');
assert.equal(errorKeyOf(drilled), errorKeyOf(c), 'a resolved cause groups with the same error seen directly');

// ── Cascades ──────────────────────────────────────────────────────────────
// flow1 → flow2 → flow3, error in flow3. Three failed rows, one problem.
const cascadeRuns = [
    occ({ id: 'r3', flow: 'f3', flowName: 'Inventory Sync', minutesAgo: 20, code: 'BadRequest', message: 'Quantity must be positive', parent: 'r2' }),
    occ({ id: 'r2', flow: 'f2', flowName: 'Order Router', minutesAgo: 21, message: DEPENDENT, parent: 'r1' }),
    occ({ id: 'r1', flow: 'f1', flowName: 'Order Intake', minutesAgo: 22, message: DEPENDENT }),
];
const [cascade, ...rest] = buildCascades(cascadeRuns);
assert.equal(rest.length, 0, 'a three-deep cascade is one incident, not three');
assert.equal(cascade.origin.flowLabel, 'Inventory Sync', 'filed under the flow the error actually happened in');
assert.equal(cascade.entry.flowLabel, 'Order Intake', 'and remembers what triggered it');
assert.deepEqual(cascade.chain.map((o) => o.flowLabel), ['Order Intake', 'Order Router', 'Inventory Sync']);
assert.equal(cascade.message, 'Quantity must be positive', 'the real message wins over "an action failed"');
assert.equal(cascade.failedRuns.length, 3, 'all three runs are still accounted for');

// Switching collapsing off must give the raw rows back.
assert.equal(buildCascades(cascadeRuns, { collapse: false }).length, 3);

// Ancestors inherit the origin's message so the uncollapsed view still reads.
propagateOriginCause([cascade]);
assert.equal(cascadeRuns[1].message, 'Quantity must be positive');
assert.equal(cascadeRuns[1].sourceFlow, 'Inventory Sync');

// A parent with two failed children broke twice, and both chains name it.
const forked = buildCascades([
    occ({ id: 'p', flow: 'fp', flowName: 'Nightly Batch', minutesAgo: 30, message: DEPENDENT }),
    occ({ id: 'k1', flow: 'fa', flowName: 'Invoice Push', minutesAgo: 29, message: 'Timeout', parent: 'p' }),
    occ({ id: 'k2', flow: 'fb', flowName: 'Ledger Sync', minutesAgo: 28, message: 'Forbidden', parent: 'p' }),
]);
assert.equal(forked.length, 2, 'two distinct leaf failures are two incidents');
assert.deepEqual(forked.map((i) => i.origin.flowLabel).sort(), ['Invoice Push', 'Ledger Sync']);
assert.ok(forked.every((i) => i.entry.flowLabel === 'Nightly Batch'));

// A parentrunid pointing outside the fetched rows must not crash or loop.
const orphan = buildCascades([occ({ id: 'o1', flow: 'f9', flowName: 'Orphan', minutesAgo: 5, message: 'Boom', parent: 'not-in-set' })]);
assert.equal(orphan.length, 1);
assert.equal(orphan[0].chain.length, 1);

// ── Ancestors that caught the error ───────────────────────────────────────
// A parent with a configure-run-after / try-catch ends Succeeded, so a
// failed-runs query never returns it and the chain looks like it starts at the
// child. collectAncestors climbs past it whatever the status.
const upstream = {
    caught: run({ id: 'c1', flow: 'fc', flowName: 'Claims Intake', minutesAgo: 31, status: 'Succeeded', code: '', message: '', parent: 'c0' }),
    top: run({ id: 'c0', flow: 'ft', flowName: 'Weekly Scheduler', minutesAgo: 32, status: 'Succeeded', code: '', message: '' }),
};
// The lookup is batched: names in, Map of run name -> run out.
let requests = 0;
let looked = 0;
const fetchRuns = async (names) => {
    requests++;
    looked += names.length;
    const out = new Map();
    for (const name of names) {
        const hit = upstream[name === 'c1' ? 'caught' : name === 'c0' ? 'top' : '_'];
        if (hit) out.set(name, hit);
    }
    return out;
};

const child = occ({ id: 'c2', flow: 'fd', flowName: 'Claims Validator', minutesAgo: 30, code: 'BadRequest', message: 'Policy number missing', parent: 'c1' });
const pool = [child];
const found = await collectAncestors(buildCascades(pool), fetchRuns);
assert.deepEqual(found.map((o) => o.flowLabel), ['Claims Intake', 'Weekly Scheduler']);
assert.ok(found.every((o) => o.caught), 'succeeded ancestors are context, not failures');
assert.equal(found[0].message, '', 'a run that reports success has no error to group on');

pool.push(...found);
const [traced] = buildCascades(pool);
assert.deepEqual(traced.chain.map((o) => o.flowLabel), ['Weekly Scheduler', 'Claims Intake', 'Claims Validator']);
assert.equal(traced.origin.flowLabel, 'Claims Validator', 'still filed where the error happened');
assert.equal(traced.handledBy.flowLabel, 'Claims Intake', 'the innermost ancestor that swallowed it');
assert.equal(traced.failedRuns.length, 1, 'the caught ancestors are not failures');
assert.equal(traced.message, 'Policy number missing');

// Caught ancestors must never become failure cards of their own.
assert.equal(buildCascades(pool, { collapse: false }).length, 1);

// Shared ancestors are asked for once, and each hop is a single batched
// request rather than one per run — the difference between 8 requests and 146
// when a few hundred cascades all need climbing.
requests = 0;
looked = 0;
await collectAncestors(buildCascades([
    occ({ id: 'x1', flow: 'fx', flowName: 'A', minutesAgo: 9, message: 'Boom', parent: 'c1' }),
    occ({ id: 'x2', flow: 'fy', flowName: 'B', minutesAgo: 8, message: 'Boom', parent: 'c1' }),
]), fetchRuns);
assert.equal(looked, 2, 'the shared parent is asked for once, then its own parent');
assert.equal(requests, 2, 'one request per hop, not one per run');

// A wide fan-out is one request per hop too, and every caller is resolved —
// the old per-run version capped out at 60 and left the rest caller-less.
const wide = buildCascades(Array.from({ length: 146 }, (_, n) =>
    occ({ id: `w${n}`, flow: 'fw', flowName: 'Middle', minutesAgo: 20, message: 'Boom', parent: 'c1' })));
requests = 0;
assert.equal((await collectAncestors(wide, fetchRuns)).length, 2, 'both ancestors found for all 146');
assert.equal(requests, 2, '146 cascades still cost one request per hop');

assert.equal((await collectAncestors(buildCascades([child]), fetchRuns, { maxHops: 1 })).length, 1, 'maxHops bounds the climb');
assert.equal((await collectAncestors(buildCascades([child]), async () => { throw new Error('gone'); })).length, 0, 'a failed lookup ends the climb quietly');

// ── An unresolved caller is not a direct trigger ──────────────────────────
// A run whose parent could not be retrieved has an UNKNOWN caller. Reporting
// it as "Triggered directly" is a wrong answer, and hides exactly the case
// where the ancestor climb fell short.
const [stranded] = buildCascades([occ({ id: 's1', flow: 'fs1', flowName: 'Stranded', minutesAgo: 4, message: 'Boom', parent: 'never-fetched' })]);
assert.equal(stranded.complete, false, 'the chain still points at a parent');
assert.equal(callerLabelOf(stranded), 'Caller not loaded');
assert.notEqual(callerKeyOf(stranded), '', 'and it must not group with genuinely direct triggers');

const [direct] = buildCascades([occ({ id: 's2', flow: 'fs2', flowName: 'Direct', minutesAgo: 4, message: 'Boom' })]);
assert.equal(direct.complete, true);
assert.equal(callerLabelOf(direct), 'Triggered directly');
assert.equal(callerKeyOf(direct), '');
assert.notEqual(callerKeyOf(stranded), callerKeyOf(direct), 'unknown and none are different answers');

// Once the ancestor is in the pool the chain completes.
assert.equal(buildCascades(pool)[0].complete, true);

// ── Pivots ────────────────────────────────────────────────────────────────
// Two callers of the same broken flow, plus an unrelated flow.
const incidents = buildCascades([
    occ({ id: 'm1', flow: 'fp1', flowName: 'Portal Submit', minutesAgo: 50, message: DEPENDENT }),
    occ({ id: 'm2', flow: 'fs', flowName: 'Shared Validator', minutesAgo: 50, code: 'BadRequest', message: 'Policy number missing', parent: 'm1' }),
    occ({ id: 'm3', flow: 'fp1', flowName: 'Portal Submit', minutesAgo: 40, message: DEPENDENT }),
    occ({ id: 'm4', flow: 'fs', flowName: 'Shared Validator', minutesAgo: 40, code: 'BadRequest', message: 'Policy number missing', parent: 'm3' }),
    occ({ id: 'm5', flow: 'fp2', flowName: 'Batch Import', minutesAgo: 30, message: DEPENDENT }),
    occ({ id: 'm6', flow: 'fs', flowName: 'Shared Validator', minutesAgo: 30, code: 'BadRequest', message: 'Policy number missing', parent: 'm5' }),
    occ({ id: 'm7', flow: 'fz', flowName: 'Notify Sales', minutesAgo: 10, code: 'TooManyRequests', message: 'Rate limit exceeded' }),
]);
assert.equal(incidents.length, 4, 'three cascades and one standalone failure');

// By flow × error: one card for the broken flow, all three callers folded in.
const byFlowError = buildIssues(incidents, 'flow-error');
assert.equal(byFlowError.length, 2);
assert.equal(byFlowError[0].sample.flowLabel, 'Shared Validator');
assert.equal(byFlowError[0].incidents.length, 3);
assert.equal(issueRunCount(byFlowError[0]), 6, 'six failed runs behind three incidents');

// Expanding it answers "who is calling this and how often".
assert.deepEqual(
    issueBreakdown(byFlowError[0], 'caller').map((r) => [r.label, r.count]),
    [['Portal Submit', 2], ['Batch Import', 1]]);

// By caller: the two callers become separate cards.
const byCaller = buildIssues(incidents, 'caller');
assert.equal(byCaller.length, 3);
assert.deepEqual(
    byCaller.map((i) => [callerLabelOf(i.sample), i.sample.flowLabel, i.incidents.length]),
    [
        ['Portal Submit', 'Shared Validator', 2],
        ['Triggered directly', 'Notify Sales', 1],
        ['Batch Import', 'Shared Validator', 1],
    ]);

// A directly triggered failure has no caller to group on.
assert.equal(callerKeyOf(incidents.find((i) => i.flowLabel === 'Notify Sales')), '');

// By error and by flow still collapse across callers.
assert.equal(buildIssues(incidents, 'error').length, 2);
assert.equal(buildIssues(incidents, 'flow').length, 2);

// The same flow name under two workflow ids must not merge.
assert.notEqual(
    groupKeyOf(buildCascades([occ({ id: 'y1', flow: 'f1', flowName: 'Dup', minutesAgo: 1, message: 'boom' })])[0], 'flow'),
    groupKeyOf(buildCascades([occ({ id: 'y2', flow: 'f9', flowName: 'Dup', minutesAgo: 1, message: 'boom' })])[0], 'flow'));

// Each pivot offers exactly the breakdowns it hasn't already fixed.
assert.deepEqual(openDimensions('flow-error'), ['caller']);
assert.deepEqual(openDimensions('error'), ['flow', 'caller']);
assert.deepEqual(openDimensions('flow'), ['error', 'caller']);
assert.deepEqual(openDimensions('caller'), []);

// ── Distinct routes ───────────────────────────────────────────────────────
// Grouping by caller alone collapses "A -> B -> C" and "A -> C" into one row
// and loses B — the flow that actually made the call. Two incidents share a
// route only when every hop matches.
const routed = buildCascades([
    // Portal Submit reaches the validator through a middle flow...
    occ({ id: 'q1', flow: 'fq', flowName: 'Portal Submit', minutesAgo: 60, message: DEPENDENT }),
    occ({ id: 'q2', flow: 'fmid', flowName: 'Button Init', minutesAgo: 60, message: DEPENDENT, parent: 'q1' }),
    occ({ id: 'q3', flow: 'fs', flowName: 'Shared Validator', minutesAgo: 60, code: 'BadRequest', message: 'Policy number missing', parent: 'q2' }),
    // ...and also calls it directly.
    occ({ id: 'q4', flow: 'fq', flowName: 'Portal Submit', minutesAgo: 55, message: DEPENDENT }),
    occ({ id: 'q5', flow: 'fs', flowName: 'Shared Validator', minutesAgo: 55, code: 'BadRequest', message: 'Policy number missing', parent: 'q4' }),
    // A second incident on the long route, to give it the higher count.
    occ({ id: 'q6', flow: 'fq', flowName: 'Portal Submit', minutesAgo: 50, message: DEPENDENT }),
    occ({ id: 'q7', flow: 'fmid', flowName: 'Button Init', minutesAgo: 50, message: DEPENDENT, parent: 'q6' }),
    occ({ id: 'q8', flow: 'fs', flowName: 'Shared Validator', minutesAgo: 50, code: 'BadRequest', message: 'Policy number missing', parent: 'q7' }),
]);
const routedIssue = buildIssues(routed, 'flow-error')[0];
assert.equal(routedIssue.incidents.length, 3);

// By caller these are indistinguishable — one row, middle flow gone.
assert.deepEqual(issueBreakdown(routedIssue, 'caller').map((r) => [r.label, r.count]), [['Portal Submit', 3]]);

// By route they are two, and the middle flow survives.
const routes = distinctPaths(routedIssue.incidents);
assert.deepEqual(
    routes.map((r) => [r.incident.chain.map((o) => o.flowLabel).join(' > '), r.count]),
    [
        ['Portal Submit > Button Init > Shared Validator', 2],
        ['Portal Submit > Shared Validator', 1],
    ]);

// A single-route issue collapses to one row, and an incomplete chain is never
// merged with a complete one that happens to share its visible hops.
assert.equal(distinctPaths([routed[0]]).length, 1);
const cut = buildCascades([occ({ id: 'z1', flow: 'fs', flowName: 'Shared Validator', minutesAgo: 5, code: 'BadRequest', message: 'Policy number missing', parent: 'gone' })]);
const bare = buildCascades([occ({ id: 'z2', flow: 'fs', flowName: 'Shared Validator', minutesAgo: 5, code: 'BadRequest', message: 'Policy number missing' })]);
assert.equal(distinctPaths([...cut, ...bare]).length, 2, 'unknown caller is not the same route as no caller');

// ── Sorting ───────────────────────────────────────────────────────────────
// Default is blast radius; the other two are "is this still happening" and
// "when did this start". Ties fall back to most recent.
assert.equal(buildIssues(incidents, 'flow-error', 'count')[0].incidents.length, 3);
assert.equal(buildIssues(incidents, 'flow-error', 'recent')[0].sample.flowLabel, 'Notify Sales');
assert.equal(buildIssues(incidents, 'flow-error', 'first')[0].sample.flowLabel, 'Shared Validator');

// An incident is timestamped where the error happened, and first/last span the
// whole group rather than the row it was created from.
const validator = buildIssues(incidents, 'flow-error', 'count')[0];
assert.equal(new Date(validator.first).toISOString(), iso(50));
assert.equal(new Date(validator.last).toISOString(), iso(30));

// ── Sparklines ────────────────────────────────────────────────────────────
// Every card shares one window so the shapes can be compared.
// Six buckets over the last hour: the three incidents at 50, 40 and 30
// minutes ago land one each in the second, third and fourth ten-minute slots.
const bins = sparkBins(validator.incidents, BASE - 60 * 60_000, BASE, 6);
assert.deepEqual(bins, [0, 1, 1, 1, 0, 0]);
assert.equal(bins.reduce((x, y) => x + y, 0), validator.incidents.length);

// Degenerate windows must not divide by zero or write past the ends.
assert.deepEqual(sparkBins(validator.incidents, BASE, BASE, 3), [3, 0, 0]);
assert.deepEqual(sparkBins([{ stamp: 0 }], BASE - 60_000, BASE, 3), [0, 0, 0], 'runs with no start time are skipped');

// ── Paging ────────────────────────────────────────────────────────────────
// $top is a page size, not a budget: the loader follows @odata.nextLink until
// the budget is met or the server runs out. Truncating mid-chain separates a
// child from its parent, so `truncated` has to be reported, not swallowed.
const page = (rows, next) => ({ value: rows, ...(next ? { '@odata.nextLink': next } : {}) });
const pages = {
    '/p1': page([1, 2], '/p2'),
    '/p2': page([3, 4], '/p3'),
    '/p3': page([5, 6]),
};
const asked = [];
const pagedGet = async (url) => { asked.push(url); return pages[url]; };

const all = await fetchPagedRuns(pagedGet, '/p1', 100);
assert.deepEqual(all.runs, [1, 2, 3, 4, 5, 6], 'every page is followed');
assert.equal(all.truncated, false, 'the server ran out of pages, so nothing was cut');
assert.deepEqual(asked, ['/p1', '/p2', '/p3']);

// The budget stops the walk and says so, without over-fetching.
asked.length = 0;
const capped = await fetchPagedRuns(pagedGet, '/p1', 3);
assert.deepEqual(capped.runs, [1, 2, 3], 'trimmed to the budget');
assert.equal(capped.truncated, true, 'and the caller is told there is more');
assert.deepEqual(asked, ['/p1', '/p2'], 'stops as soon as the budget is met');

// A budget landing exactly on a page boundary is still truncated while the
// server is offering another page.
assert.equal((await fetchPagedRuns(pagedGet, '/p1', 4)).truncated, true);
assert.equal((await fetchPagedRuns(pagedGet, '/p1', 6)).truncated, false);

// Single page, empty page, and progress reporting.
assert.deepEqual((await fetchPagedRuns(pagedGet, '/p3', 100)).runs, [5, 6]);
assert.deepEqual((await fetchPagedRuns(async () => ({}), '/empty', 100)).runs, [], 'a response with no value array is not a crash');
const progress = [];
await fetchPagedRuns(pagedGet, '/p1', 100, (n) => progress.push(n));
assert.deepEqual(progress, [2, 4, 6], 'progress reports the running total per page');

// ── $top must never appear on a flowruns query ────────────────────────────
// $top is a hard total in the Web API and SUPPRESSES @odata.nextLink, so a
// query that carries it silently stops at one page — for flowruns, an elastic
// table, that is 500 rows — and the paging loop above can never get past it.
// This cost a long debugging session: the Errors view looked like it had every
// failure in range and was quietly missing everything older than the newest
// 500. Page size belongs in Prefer: odata.maxpagesize instead.
const { readFileSync } = await import('node:fs');
for (const file of ['extension/src/tools/flow-run-monitor.js', 'extension/src/tools/shared/run-tree.js']) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    const offenders = [...src.matchAll(/\/flowruns\?[^`'"]*/g)].filter((m) => m[0].includes('$top'));
    assert.deepEqual(offenders.map((m) => m[0]), [], `${file}: $top on a flowruns query defeats nextLink paging`);
}

console.log('✓ flow-run-monitor issue model: fingerprinting, cascades, caught ancestors, caller pivot, paging, $top guard');
