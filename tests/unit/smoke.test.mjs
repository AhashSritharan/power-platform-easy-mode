#!/usr/bin/env node
/**
 * Smoke test for the page agent (src/agent/page-agent.js) — the MAIN-world
 * script that gives native tools on-demand fetch/XHR interception.
 *
 * Loads the real file in a simulated window and verifies: a session patches
 * fetch, only matching URLs are captured, and stopping restores the originals.
 * Run: node --test tests/unit/smoke.test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Simulated window ─────────────────────────────────────────────────────
const messageListeners = [];
const window = {
    location: { origin: 'https://test.crm.dynamics.com' },
    addEventListener: (type, fn) => { if (type === 'message') messageListeners.push(fn); },
    postMessage: (data) => {
        queueMicrotask(() => {
            for (const fn of [...messageListeners]) fn({ source: window, data });
        });
    },
};

class FakeXHR {
    open() {}
    send() {}
    addEventListener() {}
}
const pageFetch = async (url) => ({
    clone: () => ({ json: async () => ({ from: url }) }),
});
window.fetch = pageFetch;
window.XMLHttpRequest = FakeXHR;

// ── Load the real agent ──────────────────────────────────────────────────
const agentCode = readFileSync(join(ROOT, 'extension', 'src', 'agent', 'page-agent.js'), 'utf8');
new Function('window', agentCode)(window);

const captures = [];
messageListeners.push((event) => {
    if (event.data?.__ppt_agent === '__ppt-agent-to-content' && event.data.type === 'intercept-capture') {
        captures.push(event.data);
    }
});

// Start a session, make matching + non-matching page fetches
window.postMessage({ __ppt_agent: '__ppt-agent-to-page', type: 'intercept-start', id: 7, patterns: ['/contents/ActionInputs'] });
await sleep(20);
assert.notEqual(window.fetch, pageFetch, 'fetch should be patched during a session');
await window.fetch('https://x/api/contents/ActionInputs?x=1');
await window.fetch('https://x/api/unrelated');
await sleep(20);
assert.equal(captures.length, 1, 'only matching URLs are captured');
assert.equal(captures[0].id, 7);
assert.deepEqual(captures[0].json, { from: 'https://x/api/contents/ActionInputs?x=1' });

// Stop restores the originals
window.postMessage({ __ppt_agent: '__ppt-agent-to-page', type: 'intercept-stop', id: 7 });
await sleep(20);
assert.equal(window.fetch, pageFetch, 'fetch should be restored after the session');
await window.fetch('https://x/api/contents/ActionInputs?x=2');
await sleep(20);
assert.equal(captures.length, 1, 'no captures after the session stops');

console.log('smoke test passed: page agent intercept start/capture/stop all OK');
process.exit(0);
