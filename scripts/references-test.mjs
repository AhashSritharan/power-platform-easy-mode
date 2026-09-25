#!/usr/bin/env node
/**
 * Smoke test for the reference index (src/tools/flow-references.js) — the part
 * that decides what "references" means, and the only part with no UI to eyeball.
 *
 * Loads the real module against a stubbed extension environment and checks the
 * cases a naive substring search gets wrong: underscored names in expressions,
 * colliding prefixes (Compose vs Compose_2), runAfter edges nobody reads from,
 * variable writes hidden in inputs.name, and references that point at steps
 * which no longer exist.
 * Run: node scripts/references-test.mjs
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

const { buildIndex, findTextMentions } = await import(
    pathToFileURL(join(ROOT, 'extension/src/tools/flow-references.js')));

// A flow shaped like the ones this is meant for: spaces in names, a colliding
// prefix, a scope, a switch, a loop, and one reference left dangling.
const definition = {
    triggers: {
        'When a row is added': { type: 'OpenApiConnectionWebhook', inputs: {} },
    },
    actions: {
        'Initialize counter': {
            type: 'InitializeVariable',
            inputs: { variables: [{ name: 'counter', type: 'integer', value: 0 }] },
            runAfter: {},
        },
        'List rows': {
            type: 'OpenApiConnection',
            inputs: { parameters: { $filter: "accountid eq '@{triggerOutputs()?['body/accountid']}'" } },
            runAfter: { 'Initialize counter': ['Succeeded'] },
        },
        Compose: {
            type: 'Compose',
            inputs: "@first(body('List_rows')?['value'])",
            runAfter: { 'List rows': ['Succeeded'] },
        },
        Compose_2: {
            type: 'Compose',
            inputs: "@outputs('Compose')?['name']",
            runAfter: { Compose: ['Succeeded'] },
        },
        'Handle each': {
            type: 'Foreach',
            foreach: "@body('List_rows')?['value']",
            runAfter: { Compose_2: ['Succeeded'] },
            actions: {
                'Bump counter': {
                    type: 'IncrementVariable',
                    inputs: { name: 'counter', value: 1 },
                    runAfter: {},
                },
                'Send mail': {
                    type: 'OpenApiConnection',
                    inputs: {
                        parameters: {
                            'emailMessage/Subject': "Row @{items('Handle_each')?['name']} — Compose said @{outputs('Compose')}",
                            'emailMessage/Body': "Total @{variables('counter')}. Step 'Compose' produced this. See Deleted_step for details.",
                        },
                    },
                    runAfter: { 'Bump counter': ['Succeeded'] },
                },
            },
        },
        'Check result': {
            type: 'If',
            expression: { greater: ["@variables('counter')", 0] },
            runAfter: { 'Handle each': ['Succeeded', 'Failed'] },
            actions: {
                'Set counter': { type: 'SetVariable', inputs: { name: 'counter', value: 0 }, runAfter: {} },
            },
            else: {
                actions: {
                    'Broken reference': {
                        type: 'Compose',
                        inputs: "@outputs('Deleted_step')",
                        runAfter: {},
                    },
                },
            },
        },
    },
};

const index = buildIndex(definition);
const symbol = (kind, name) => {
    const found = index.symbols.find((s) => s.kind === kind && s.name === name);
    assert.ok(found, `no ${kind} symbol named ${name}`);
    return found;
};
const incoming = (kind, name) => index.incoming.get(symbol(kind, name)) ?? [];
const labels = (references) => references.map((r) => `${r.from.name}:${r.label}`).sort();

// ── Symbols ───────────────────────────────────────────────────────────────
assert.equal(index.symbols.filter((s) => s.kind === 'trigger').length, 1);
assert.equal(index.symbols.filter((s) => s.kind === 'action').length, 10, 'nested actions must be flattened');
assert.equal(symbol('variable', 'counter').declaredIn.name, 'Initialize counter');
assert.equal(symbol('action', 'Send mail').path, 'Handle each / Send mail', 'container chain');
assert.equal(symbol('action', 'Broken reference').path, 'Check result / Broken reference', 'else branch');

// ── Underscores: body('List_rows') is a reference to "List rows" ───────────
assert.deepEqual(labels(incoming('action', 'List rows')), [
    'Compose:body()',
    'Compose:runAfter',
    'Handle each:body()',
], 'underscored expression names must resolve back to the spaced name');

// ── Colliding prefixes: "Compose" must not swallow Compose_2 ───────────────
assert.deepEqual(labels(incoming('action', 'Compose')), [
    'Compose_2:outputs()',
    'Compose_2:runAfter',
    'Send mail:outputs()',
], 'a reference to Compose_2 is not a reference to Compose');
assert.deepEqual(labels(incoming('action', 'Compose_2')), ['Handle each:runAfter']);

// ── runAfter is an edge even with no data flowing ──────────────────────────
const bump = incoming('action', 'Bump counter');
assert.deepEqual(labels(bump), ['Send mail:runAfter']);
assert.match(bump[0].text, /Succeeded/);

// ── Loops: items('Handle_each') references the loop ────────────────────────
assert.ok(labels(incoming('action', 'Handle each')).includes('Send mail:items()'));

// ── Variables: reads and writes, both directions ───────────────────────────
assert.deepEqual(labels(incoming('variable', 'counter')), [
    'Bump counter:increments',
    'Check result:variables()',
    'Initialize counter:declares',
    'Send mail:variables()',
    'Set counter:sets',
], 'writes hide in inputs.name where no expression scan would see them');

// ── The trigger is a symbol too ────────────────────────────────────────────
assert.deepEqual(labels(incoming('trigger', 'When a row is added')), ['List rows:triggerOutputs()'],
    'an argument-less triggerOutputs() still resolves to the trigger');

// ── Dangling references are kept, unresolved ───────────────────────────────
const dangling = index.edges.filter((edge) => !edge.to);
assert.deepEqual(dangling.map((edge) => edge.toName), ['Deleted_step']);
assert.equal(dangling[0].from.name, 'Broken reference');

// ── Outgoing: what a step reads ────────────────────────────────────────────
const sendMail = index.edges.filter((edge) => edge.from === symbol('action', 'Send mail'));
assert.deepEqual(sendMail.map((edge) => edge.label).sort(),
    ['items()', 'outputs()', 'runAfter', 'variables()']);

// ── Loose text: the name in a string, minus everything already parsed ──────
const composeMentions = findTextMentions(index, symbol('action', 'Compose'));
// The two prose mentions in the mail, and neither the outputs('Compose') calls
// beside them nor the `type: "Compose"` of every other Compose in the flow.
assert.deepEqual(composeMentions.map((mention) => mention.where).sort(),
    ['inputs.parameters.emailMessage/Body', 'inputs.parameters.emailMessage/Subject']);
assert.ok(composeMentions.every((mention) => mention.from.name === 'Send mail'));
assert.ok(composeMentions.every((mention) =>
    mention.text.slice(mention.start, mention.start + mention.length) === 'Compose'));
// ...and Compose_2's name never appears loose, so nothing must be invented for it.
assert.equal(findTextMentions(index, symbol('action', 'Compose_2')).length, 0);
// "Deleted_step" is not a symbol at all, but "Handle each" is — and the only
// mentions of it are inside items('Handle_each'), which is already parsed.
assert.equal(findTextMentions(index, symbol('action', 'Handle each')).length, 0);

// ── An empty definition must not throw ─────────────────────────────────────
assert.deepEqual(buildIndex({}).symbols, []);
assert.deepEqual(buildIndex({ actions: {}, triggers: {} }).edges, []);

console.log('✔ references: symbols, underscores, prefixes, runAfter, variables, dangling refs, loose text');
