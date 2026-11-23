#!/usr/bin/env node
/**
 * What removing a component's unmanaged (Active) layer would lose
 * (src/tools/solution-deployer.js): its own changes compared with the managed
 * layer beneath. The layer shapes are msdyn_componentlayers rows as a live org
 * returns them: msdyn_changes / msdyn_componentjson are JSON entities whose
 * Attributes are [{ Key, Value }].
 * Run: node --test tests/unit/layer-loss.test.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

globalThis.chrome = { runtime: { id: 'test' }, storage: { local: {}, onChanged: { addListener() {} } } };
globalThis.document = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
globalThis.window = { addEventListener() {} };

const { layerAttributes, unmanagedLayerLoss } = await import(
    pathToFileURL(join(ROOT, 'extension/src/tools/solution-deployer.js')));

const entity = (attributes) => JSON.stringify({
    LogicalName: 'workflow', Id: 'f1',
    Attributes: Object.entries(attributes).map(([Key, Value]) => ({ Key, Value })),
});
const label = (text, id) => JSON.stringify({ LabelTypeCode: 19, LocalizedLabels: { 1033: { LocalizedLabelId: id, LocalizedLabel: text, ComponentState: 'Publish' } } });

const MANAGED = entity({
    name: 'Lead | Score new lead',
    'name - LocalizedLabel': label('Lead | Score new lead', 'aaa'),
    statecode: { Value: 1 },
    clientdata: '{"properties":{"definition":{"actions":{}}},"schemaVersion":"1.0.0.0"}',
    workflowidunique: 'b3559442-0000-0000-0000-000000000001',
    modifiedon: '2026-11-09T06:21:38Z',
});

test('reads a layer\'s attributes into a map', () => {
    assert.deepEqual(layerAttributes(entity({ name: 'x', statecode: { Value: 1 } })), { name: 'x', statecode: { Value: 1 } });
    assert.deepEqual(layerAttributes(''), {});
    assert.deepEqual(layerAttributes(null), {});
});

test('an unmanaged edit the managed layer does not have would revert', () => {
    const active = entity({ workflowidunique: 'new-every-save', name: 'Lead | Score new lead (TEST edit)' });
    assert.deepEqual(unmanagedLayerLoss(active, MANAGED), {
        revert: [{ attribute: 'name', now: 'Lead | Score new lead (TEST edit)', below: 'Lead | Score new lead' }],
        unknown: [],
    });
});

test('nothing is lost when the managed layer already holds the same values', () => {
    // A managed release with the same change, imported without "overwrite unmanaged customizations".
    const active = entity({
        name: 'Lead | Score new lead',
        statecode: { Value: 1 },
        modifiedon: '2026-11-23T17:00:00Z', // bookkeeping: always differs
    });
    assert.deepEqual(unmanagedLayerLoss(active, MANAGED), { revert: [], unknown: [] });
});

test('only the bookkeeping left (after an import that overwrote the layer): nothing is lost', () => {
    assert.deepEqual(unmanagedLayerLoss(entity({ workflowidunique: 'x' }), MANAGED), { revert: [], unknown: [] });
});

test('labels compare by their text, not their ids', () => {
    const active = entity({ 'name - LocalizedLabel': label('Lead | Score new lead', 'bbb') });
    assert.deepEqual(unmanagedLayerLoss(active, MANAGED), { revert: [], unknown: [] });
    const renamed = entity({ 'name - LocalizedLabel': label('Renamed', 'bbb') });
    assert.deepEqual(unmanagedLayerLoss(renamed, MANAGED).revert.map((r) => r.attribute), ['name - LocalizedLabel']);
});

test('JSON held in a string compares by content, not formatting', () => {
    const active = entity({ clientdata: '{ "schemaVersion": "1.0.0.0", "properties": { "definition": { "actions": {} } } }' });
    assert.deepEqual(unmanagedLayerLoss(active, MANAGED), { revert: [], unknown: [] });
    const edited = entity({ clientdata: '{"properties":{"definition":{"actions":{"Compose":{}}}},"schemaVersion":"1.0.0.0"}' });
    assert.deepEqual(unmanagedLayerLoss(edited, MANAGED).revert.map((r) => r.attribute), ['clientdata']);
});

test('an attribute the layer JSON never carries cannot be compared, so it is not called safe', () => {
    // A flow's description is in the Active layer's changes but in no layer's componentjson.
    const active = entity({ workflowidunique: 'x', description: 'Edited directly in TEST' });
    assert.deepEqual(unmanagedLayerLoss(active, MANAGED), { revert: [], unknown: ['description'] });
});
