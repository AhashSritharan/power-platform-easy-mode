#!/usr/bin/env node
/**
 * Smoke test for the Jira Clockify Timer's status router
 * (src/tools/jira-clockify-timer.js) — the part that walks an issue from
 * wherever it is to the status a timer start should put it in.
 *
 * Jira only ever lists the transitions out of an issue's *current* status, so
 * a workflow like Backlog → Ready → In Progress cannot be planned up front:
 * the router walks it, asks about a step it has not seen before, and remembers
 * the answer. Every hop is a real transition on a real ticket, so the cases
 * that matter are the ones where it must NOT wander: stopping when the user
 * declines, never exceeding the hop cap even in a workflow that loops, and
 * asking nothing once a route is known.
 * Run: node scripts/jira-status-route-test.mjs
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
globalThis.location = { hostname: 'example.atlassian.net', href: '', pathname: '' };

const { walkToStatus, routeKeyOf, MAX_HOPS } = await import(
    pathToFileURL(join(ROOT, 'extension/src/tools/jira-clockify-timer.js')).href);

// ── A fake Jira ─────────────────────────────────────────────────────────────
// Statuses carry the shape the real API returns; a workflow is a map of
// status id → the status ids reachable from it in one step.
const STATUS = {
    1: { id: '1', name: 'Backlog', statusCategory: { colorName: 'blue-gray' } },
    2: { id: '2', name: 'Ready', statusCategory: { colorName: 'blue-gray' } },
    3: { id: '3', name: 'In Progress', statusCategory: { colorName: 'yellow' } },
    4: { id: '4', name: 'Done', statusCategory: { colorName: 'green' } },
};

function fakeJira({ at, workflow, decline = false }) {
    const calls = { transitions: [], asked: [] };
    let current = STATUS[at];

    return {
        calls,
        get at() { return current; },
        api: {
            getStatus: async () => current,
            getTransitions: async () => (workflow[current.id] ?? []).map((to) => ({
                // Transition ids are deliberately unlike status ids: the router
                // must POST the transition id, never the status it leads to.
                id: `t${current.id}-${to}`,
                name: `Move to ${STATUS[to].name}`,
                to: STATUS[to],
            })),
            transition: async (_key, t) => {
                calls.transitions.push(t.id);
                current = t.to;
            },
            chooseHop: async ({ at: from, transitions }) => {
                calls.asked.push(from.name);
                return decline ? null : transitions[0];
            },
        },
    };
}

const LINEAR = { 1: ['2'], 2: ['3'], 3: ['4'], 4: [] }; // Backlog → Ready → In Progress → Done
const inProgress = STATUS[3];

// ── Already there ───────────────────────────────────────────────────────────
{
    const jira = fakeJira({ at: '3', workflow: LINEAR });
    const walk = await walkToStatus({ key: 'ABC-1', target: inProgress, ...jira.api });

    assert.equal(walk.outcome, 'already');
    assert.deepEqual(jira.calls.transitions, [], 'an issue already at the target must not be transitioned');
    assert.deepEqual(jira.calls.asked, []);
}

// ── One step away: no question, nothing to remember ─────────────────────────
{
    const jira = fakeJira({ at: '2', workflow: LINEAR });
    const walk = await walkToStatus({ key: 'ABC-1', target: inProgress, ...jira.api });

    assert.equal(walk.outcome, 'moved');
    assert.equal(walk.at.name, 'In Progress');
    assert.deepEqual(jira.calls.transitions, ['t2-3']);
    assert.deepEqual(jira.calls.asked, [], 'a direct transition must never prompt');
    assert.equal(walk.route, null, 'nothing to remember when the target was one step away');
    assert.deepEqual(walk.walked, []);
}

// ── Backlog → Ready → In Progress: asked once, and handed back for saving ───
{
    const jira = fakeJira({ at: '1', workflow: LINEAR });
    const walk = await walkToStatus({ key: 'ABC-1', target: inProgress, ...jira.api });

    assert.equal(walk.outcome, 'moved');
    assert.equal(jira.at.name, 'In Progress');
    assert.deepEqual(jira.calls.transitions, ['t1-2', 't2-3'], 'both hops, in order');
    assert.deepEqual(jira.calls.asked, ['Backlog'], 'only the unknown step is asked about');
    assert.deepEqual(walk.walked.map((s) => s.name), ['Ready']);
    assert.deepEqual(walk.route, { key: routeKeyOf('ABC-1', '1', '3'), hops: ['2'] });
    assert.equal(walk.route.key, 'ABC/1>3', 'routes are keyed per project, not per issue');
}

// ── The same walk with the route already known: silent ──────────────────────
{
    const jira = fakeJira({ at: '1', workflow: LINEAR });
    const routes = { [routeKeyOf('ABC-1', '1', '3')]: ['2'] };
    const walk = await walkToStatus({ key: 'ABC-9', target: inProgress, routes, ...jira.api });

    assert.equal(walk.outcome, 'moved');
    assert.deepEqual(jira.calls.transitions, ['t1-2', 't2-3']);
    assert.deepEqual(jira.calls.asked, [], 'a remembered route must not ask again');
}

// ── A stale route (the workflow changed under it) falls back to asking ──────
{
    const jira = fakeJira({ at: '1', workflow: LINEAR });
    const routes = { [routeKeyOf('ABC-1', '1', '3')]: ['4'] }; // Done is not reachable from Backlog
    const walk = await walkToStatus({ key: 'ABC-1', target: inProgress, routes, ...jira.api });

    assert.equal(walk.outcome, 'moved');
    assert.deepEqual(jira.calls.asked, ['Backlog'], 'an unavailable remembered hop must be re-asked, not forced');
}

// ── Declining leaves the issue exactly where it was ─────────────────────────
{
    const jira = fakeJira({ at: '1', workflow: LINEAR, decline: true });
    const walk = await walkToStatus({ key: 'ABC-1', target: inProgress, ...jira.api });

    assert.equal(walk.outcome, 'stopped');
    assert.equal(walk.at.name, 'Backlog');
    assert.deepEqual(jira.calls.transitions, [], 'declining the first hop must not move the issue at all');
}

// ── Declining a later hop reports where the issue actually ended up ─────────
{
    const jira = fakeJira({ at: '1', workflow: { 1: ['2'], 2: ['4'], 4: [] } });
    let asked = 0;
    const walk = await walkToStatus({
        key: 'ABC-1',
        target: inProgress,
        ...jira.api,
        chooseHop: async ({ transitions }) => (++asked === 1 ? transitions[0] : null),
    });

    assert.equal(walk.outcome, 'stopped');
    assert.equal(walk.at.name, 'Ready', 'the issue is left at the hop it did take, and says so');
    assert.deepEqual(walk.walked.map((s) => s.name), ['Ready']);
}

// ── A workflow that never reaches the target stops at the hop cap ───────────
{
    // Ready leads back to Backlog, so a greedy walk would loop forever.
    const jira = fakeJira({ at: '1', workflow: { 1: ['2'], 2: ['1'] } });
    const walk = await walkToStatus({ key: 'ABC-1', target: inProgress, ...jira.api });

    assert.equal(walk.outcome, 'exhausted');
    assert.equal(jira.calls.transitions.length, MAX_HOPS, `the walk must stop after ${MAX_HOPS} transitions`);
    assert.ok(walk.at, 'an exhausted walk still reports where the issue was left');
}

// ── A target stored with an id from another project still matches by name ───
{
    const jira = fakeJira({ at: '2', workflow: LINEAR });
    const renamed = { id: '999', name: 'in progress' };
    const walk = await walkToStatus({ key: 'ABC-1', target: renamed, ...jira.api });

    assert.equal(walk.outcome, 'moved');
    assert.deepEqual(jira.calls.transitions, ['t2-3'], 'a target stored with a stale id still matches by name');
}

console.log('jira-status-route: all assertions passed');
