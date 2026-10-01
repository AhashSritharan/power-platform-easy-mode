#!/usr/bin/env node
/**
 * Smoke test for the shared environment registry
 * (src/tools/shared/environments.js) — the part every environment picker now
 * agrees on, and the only part with no UI to eyeball.
 *
 * Loads the real module against a stubbed extension environment and checks:
 * legacy string records still read, names turn into the right family, the
 * family you are in sorts first with ungrouped last, stages run DEV→PROD, and
 * a user-typed name survives a later auto-detected one.
 * Run: node scripts/environments-test.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The module pulls in the storage layer and the HTTP relay at import time.
// Neither runs anything on load, but both name globals node does not have.
globalThis.chrome = { runtime: { id: 'test' }, storage: { local: {}, onChanged: { addListener() {} } } };
globalThis.document = { addEventListener() {}, querySelector: () => null };
globalThis.window = { addEventListener() {} };
globalThis.location = { href: 'https://contoso.crm4.dynamics.com/', origin: 'https://contoso.crm4.dynamics.com' };

const {
    deriveGroup, normalizeRecord, recordGroup, groupEnvironments, loadEnvironments,
    updateEnvironment, removeEnvironment, groupOfHost, backfillNames, hostFamily, sameFamily, similarity,
} = await import(pathToFileURL(join(ROOT, 'extension/src/tools/shared/environments.js')));

// An in-memory stand-in for the tool's chrome.storage namespace.
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

// ── deriveGroup ───────────────────────────────────────────────────────────
assert.equal(deriveGroup('Smart Workflows DEV'), 'Smart Workflows');
assert.equal(deriveGroup('Antrag Naturgefahren TEST'), 'Antrag Naturgefahren');
assert.equal(deriveGroup('Smart Workflows - PROD'), 'Smart Workflows');
assert.equal(deriveGroup('Smart Workflows_uat'), 'Smart Workflows');
assert.equal(deriveGroup('  Contoso Production  '), 'Contoso');
// A bare stage word is the whole name, so it stays: stripping it leaves nothing.
assert.equal(deriveGroup('DEV'), 'DEV');
assert.equal(deriveGroup(''), '');
assert.equal(deriveGroup(null), '');
// "Devices" must not lose its tail to the `dev` stage word.
assert.equal(deriveGroup('Contoso Devices'), 'Contoso Devices');
// A stage glued on in capitals is still a stage; in lower case it is a word.
assert.equal(deriveGroup('SmartWorkflowsDEV'), 'SmartWorkflows');
assert.equal(deriveGroup('Smartdev'), 'Smartdev');

// ── host families ─────────────────────────────────────────────────────────
// Stage words and numbers drop out wherever they sit, glued on or separated.
const stem = (host) => hostFamily(host)?.stem;
assert.equal(stem('contoso-workflows-dev.crm17.dynamics.com'), 'contosoworkflows');
assert.equal(stem('contoso-workflowstest.crm17.dynamics.com'), 'contosoworkflows');
assert.equal(stem('contoso-workflows.crm17.dynamics.com'), 'contosoworkflows');
assert.equal(stem('contoso-dev-workflows-01.crm17.dynamics.com'), 'contosoworkflows');
assert.equal(stem('contoso-workflows-pre-prod.crm17.dynamics.com'), 'contosoworkflows');
assert.equal(stem('fabrikam-applikationprod.crm17.dynamics.com'), 'fabrikamapplikation');
assert.equal(stem('fabrikam-applikation-dev.crm17.dynamics.com'), 'fabrikamapplikation');
// Nothing meaningful left, so the slug stands for itself.
assert.equal(stem('qa.crm17.dynamics.com'), 'qa'); // sensitive-scan: allow
assert.equal(stem('dev-01.crm17.dynamics.com'), 'dev01'); // sensitive-scan: allow
assert.equal(hostFamily(null), null);

// Alike is enough: a typo or a small variation stays in the family…
const alike = (a, b) => sameFamily(hostFamily(a), hostFamily(b));
assert.equal(alike('contoso-workflows-dev.crm17.dynamics.com', 'contoso-workflow-test.crm17.dynamics.com'), true);
assert.equal(alike('fabrikam-applikation-dev.crm17.dynamics.com', 'fabrikam-application.crm17.dynamics.com'), true);
// …but different apps, another region, or short stems do not mix.
assert.equal(alike('contoso-workflows-dev.crm17.dynamics.com', 'fabrikam-applikation-dev.crm17.dynamics.com'), false);
assert.equal(alike('contoso-workflows-dev.crm4.dynamics.com', 'contoso-workflows.crm17.dynamics.com'), false);
assert.equal(alike('abcd-dev.crm17.dynamics.com', 'abce.crm17.dynamics.com'), false); // sensitive-scan: allow
assert.equal(similarity('kitten', 'kitten'), 1);
assert.equal(similarity('kitten', 'sitting'), 1 - 3 / 7);

// Names that disagree still land in one family, labelled without a stage.
const drifted = await loadEnvironments({ store: fakeStore({
    envIndicator_mappings: {
        'a1000000-0000-0000-0000-000000000001': { type: 'DEV', name: 'contoso-workflows-dev' },
        'a2000000-0000-0000-0000-000000000002': { type: 'TEST', name: 'ContosoWorkflows Test' },
        'a3000000-0000-0000-0000-000000000003': { type: 'PROD', name: 'Contoso Workflows' },
        'b1000000-0000-0000-0000-000000000001': { type: 'DEV', name: 'DEV' },
        'b2000000-0000-0000-0000-000000000002': { type: 'TEST', name: 'Fabrikam Test' },
        'b3000000-0000-0000-0000-000000000003': { type: 'PROD', name: 'Fabrikam Applikation', group: 'Fabrikam' },
    },
    envIndicator_hostCache: {
        'contoso-workflows-dev.crm17.dynamics.com': 'a1000000-0000-0000-0000-000000000001',
        'contoso-workflowstest.crm17.dynamics.com': 'a2000000-0000-0000-0000-000000000002',
        'contoso-workflow.crm17.dynamics.com': 'a3000000-0000-0000-0000-000000000003',
        'fabrikam-applikation-dev.crm17.dynamics.com': 'b1000000-0000-0000-0000-000000000001',
        'fabrikam-applikationtest.crm17.dynamics.com': 'b2000000-0000-0000-0000-000000000002',
        'fabrikam-applikationprod.crm17.dynamics.com': 'b3000000-0000-0000-0000-000000000003',
    },
}) });
const groupOf = (prefix) => drifted.find((e) => e.envId.startsWith(prefix)).group;
assert.deepEqual(['a1', 'a2', 'a3'].map(groupOf), ['Contoso Workflows', 'Contoso Workflows', 'Contoso Workflows']);
// A bare "DEV" never names the family; an explicit group still wins for its own row.
assert.equal(groupOf('b1'), 'Fabrikam');
assert.equal(groupOf('b2'), 'Fabrikam');
assert.equal(groupOf('b3'), 'Fabrikam');

// ── records ───────────────────────────────────────────────────────────────
assert.deepEqual(normalizeRecord('DEV'), { type: 'DEV', name: '', group: '', nameSource: '' });
assert.equal(recordGroup(normalizeRecord({ type: 'DEV', name: 'Smart Workflows DEV' })), 'Smart Workflows');
// An explicit group outranks the one the name implies.
assert.equal(recordGroup(normalizeRecord({ type: 'DEV', name: 'Smart Workflows DEV', group: 'Legacy' })), 'Legacy');
// …and an edit form must be able to tell the two apart, so both travel.
const loadedSplit = await loadEnvironments({ store: fakeStore({
    envIndicator_mappings: { 'f0000000-0000-0000-0000-00000000000f': { type: 'DEV', name: 'Contoso DEV', group: 'Legacy' } },
}) });
assert.equal(loadedSplit[0].group, 'Legacy');
assert.equal(loadedSplit[0].explicitGroup, 'Legacy');
assert.equal(loadedSplit[0].derivedGroup, 'Contoso');
// With nothing typed, the edit form shows an empty box over a derived default.
const loadedDerived = await loadEnvironments({ store: fakeStore({
    envIndicator_mappings: { 'f0000000-0000-0000-0000-00000000000f': { type: 'DEV', name: 'Contoso DEV' } },
}) });
assert.equal(loadedDerived[0].group, 'Contoso');
assert.equal(loadedDerived[0].explicitGroup, '');

// ── loading ───────────────────────────────────────────────────────────────
const store = fakeStore({
    envIndicator_mappings: {
        // A legacy string record, mixed in with the new shape and an upper-case id.
        'AAAAAAAA-0000-0000-0000-000000000001': 'PROD',
        'bbbbbbbb-0000-0000-0000-000000000002': { type: 'DEV', name: 'Smart Workflows DEV' },
        'cccccccc-0000-0000-0000-000000000003': { type: 'TEST', name: 'Antrag Naturgefahren TEST' },
        'dddddddd-0000-0000-0000-000000000004': { type: 'DEV', name: 'Antrag Naturgefahren DEV' },
        'eeeeeeee-0000-0000-0000-000000000005': { type: 'TEST', name: 'Smart Workflows TEST' },
    },
    envIndicator_order: ['cccccccc-0000-0000-0000-000000000003'],
    envIndicator_hostCache: {
        'contoso-prod.crm17.dynamics.com': 'aaaaaaaa-0000-0000-0000-000000000001',
        'contoso-dev.crm17.dynamics.com': 'bbbbbbbb-0000-0000-0000-000000000002',
        'fabrikam-test.crm17.dynamics.com': 'cccccccc-0000-0000-0000-000000000003',
    },
});

const envs = await loadEnvironments({ currentEnvId: '{BBBBBBBB-0000-0000-0000-000000000002}', store });
assert.equal(envs.length, 5);
// The explicitly ordered id leads; the rest follow in mapping order.
assert.equal(envs[0].envId, 'cccccccc-0000-0000-0000-000000000003');
// Case and braces in the current id do not stop it matching.
assert.equal(envs.find((e) => e.isCurrent).envId, 'bbbbbbbb-0000-0000-0000-000000000002');
// A legacy string record still carries its type, and the host cache is joined in.
const prod = envs.find((e) => e.envId === 'aaaaaaaa-0000-0000-0000-000000000001');
assert.equal(prod.type, 'PROD');
assert.equal(prod.url, 'https://contoso-prod.crm17.dynamics.com');
// An unnamed environment takes its group from a sibling host (contoso-dev).
assert.equal(prod.group, 'Smart Workflows');
assert.equal(envs.find((e) => e.envId === 'eeeeeeee-0000-0000-0000-000000000005').host, null);

// hostOnly drops what a cross-environment API call could not use.
const withHosts = await loadEnvironments({ store, hostOnly: true });
assert.deepEqual(withHosts.map((e) => e.host).sort(), [
    'contoso-dev.crm17.dynamics.com',
    'contoso-prod.crm17.dynamics.com',
    'fabrikam-test.crm17.dynamics.com',
]);

// ── grouping ──────────────────────────────────────────────────────────────
const groups = groupEnvironments(envs, { currentGroup: 'Smart Workflows' });
assert.deepEqual(groups.map((g) => g.label), ['Smart Workflows', 'Antrag Naturgefahren']);
assert.equal(groups[0].isCurrent, true);
// Inside a family, stages run DEV → TEST → … → PROD regardless of saved order.
assert.deepEqual(groups[0].envs.map((e) => e.type), ['DEV', 'TEST', 'PROD']);
assert.deepEqual(groups[1].envs.map((e) => e.type), ['DEV', 'TEST']);
// Matching the current group ignores case.
assert.equal(groupEnvironments(envs, { currentGroup: 'smart workflows' })[0].label, 'Smart Workflows');
// With no current group, saved order decides and ungrouped still sinks.
assert.deepEqual(
    groupEnvironments(envs, {}).map((g) => g.label),
    ['Antrag Naturgefahren', 'Smart Workflows']);
assert.equal(groupOfHost(envs, 'contoso-dev.crm17.dynamics.com'), 'Smart Workflows');

// ── writing ───────────────────────────────────────────────────────────────
// A legacy string record is rewritten as an object under a normalized id.
assert.equal(await updateEnvironment('AAAAAAAA-0000-0000-0000-000000000001', { name: 'Smart Workflows PROD', nameSource: 'org' }, store), true);
const written = store.data.envIndicator_mappings['aaaaaaaa-0000-0000-0000-000000000001'];
assert.deepEqual(written, { type: 'PROD', name: 'Smart Workflows PROD', nameSource: 'org' });
assert.equal('AAAAAAAA-0000-0000-0000-000000000001' in store.data.envIndicator_mappings, false);
// Re-writing the same values is a no-op, so callers can skip the redraw.
assert.equal(await updateEnvironment('aaaaaaaa-0000-0000-0000-000000000001', { name: 'Smart Workflows PROD', nameSource: 'org' }, store), false);

// A name the user typed is never overwritten by one detected later.
await updateEnvironment('bbbbbbbb-0000-0000-0000-000000000002', { name: 'SW Development', nameSource: 'user' }, store);
await updateEnvironment('bbbbbbbb-0000-0000-0000-000000000002', { name: 'Smart Workflows DEV', nameSource: 'org' }, store);
assert.equal(store.data.envIndicator_mappings['bbbbbbbb-0000-0000-0000-000000000002'].name, 'SW Development');
// …but an explicit group change still lands.
await updateEnvironment('bbbbbbbb-0000-0000-0000-000000000002', { group: 'Smart Workflows' }, store);
assert.equal(store.data.envIndicator_mappings['bbbbbbbb-0000-0000-0000-000000000002'].group, 'Smart Workflows');

// Removing takes the record and its slot in the display order with it.
await removeEnvironment('CCCCCCCC-0000-0000-0000-000000000003', store);
assert.equal('cccccccc-0000-0000-0000-000000000003' in store.data.envIndicator_mappings, false);
assert.deepEqual(store.data.envIndicator_order, []);

// ── name backfill ─────────────────────────────────────────────────────────
// Only RetrieveCurrentOrganization's FriendlyName counts as a resolved name.
// Anything else — missing, or left by the build that stored the org's slug —
// is fetched again; a name the user typed is never touched.
const backfillStore = fakeStore({
    envIndicator_mappings: {
        '11111111-0000-0000-0000-000000000001': { type: 'DEV' },
        '22222222-0000-0000-0000-000000000002': { type: 'TEST', name: 'smartworkflows-uat', nameSource: 'auto' },
        '33333333-0000-0000-0000-000000000003': { type: 'PROD', name: 'Smart Workflows PROD', nameSource: 'org' },
        '44444444-0000-0000-0000-000000000004': { type: 'UAT', name: 'My Own Label', nameSource: 'user' },
    },
    envIndicator_hostCache: {
        'a.crm17.dynamics.com': '11111111-0000-0000-0000-000000000001',
        'b.crm17.dynamics.com': '22222222-0000-0000-0000-000000000002',
        'c.crm17.dynamics.com': '33333333-0000-0000-0000-000000000003',
        'd.crm17.dynamics.com': '44444444-0000-0000-0000-000000000004',
    },
});
const toBackfill = await loadEnvironments({ store: backfillStore });
const fetched = [];
// resolveOrgName reaches the network, so the pass runs against a stub of it.
await backfillNames(toBackfill, {
    store: backfillStore,
    resolve: async (host) => { fetched.push(host); return `Resolved ${host[0].toUpperCase()}`; },
});
assert.deepEqual(fetched.sort(), ['a.crm17.dynamics.com', 'b.crm17.dynamics.com']);
const after = backfillStore.data.envIndicator_mappings;
assert.equal(after['11111111-0000-0000-0000-000000000001'].name, 'Resolved A');
assert.equal(after['22222222-0000-0000-0000-000000000002'].name, 'Resolved B');
assert.equal(after['33333333-0000-0000-0000-000000000003'].name, 'Smart Workflows PROD');
assert.equal(after['44444444-0000-0000-0000-000000000004'].name, 'My Own Label');

console.log('✓ environments: grouping, legacy records, ordering, name precedence and backfill');
