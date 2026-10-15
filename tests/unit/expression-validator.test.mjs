/**
 * Expression Validator (extension/src/tools/flow-expression-validator.js):
 * which references in a flow definition point at nothing — once each.
 * Run: node --test tests/unit/expression-validator.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
globalThis.chrome = { runtime: { id: 'test' }, storage: { local: {}, onChanged: { addListener() {} } } };
globalThis.document = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}) };
globalThis.window = { addEventListener() {} };
globalThis.location = { href: 'https://make.powerautomate.com/', origin: 'https://make.powerautomate.com', search: '', pathname: '/' };
const { validateExpressions } = await import(pathToFileURL(join(ROOT, 'extension/src/tools/flow-expression-validator.js')));

const flow = (actions, extra = {}) => ({
    triggers: { manual: { type: 'Request', kind: 'Button', inputs: { schema: {} } } },
    actions,
    ...extra,
});
const issues = (definition) => validateExpressions(definition).issues.map((i) => `${i.functionName}('${i.referencedName}') in ${i.actionName}`);

test('a broken reference is reported once', () => {
    assert.deepEqual(issues(flow({
        Get_items: { type: 'OpenApiConnection', runAfter: {}, inputs: {} },
        Compose: { type: 'Compose', runAfter: {}, inputs: "@body('Get_item')?['value']" },
    })), ["body('Get_item') in Compose"]);
});

test('each broken reference in one string is reported once', () => {
    assert.deepEqual(issues(flow({
        Get_items: { type: 'OpenApiConnection', runAfter: {}, inputs: {} },
        Compose: { type: 'Compose', runAfter: {}, inputs: "Count: @{length(body('Get_item'))}, first: @{first(outputs('Lookup'))}" },
    })), ["body('Get_item') in Compose", "outputs('Lookup') in Compose"]);
});

test('valid references, triggers, variables and parameters pass', () => {
    assert.deepEqual(issues(flow({
        Init: { type: 'InitializeVariable', runAfter: {}, inputs: { variables: [{ name: 'Total', type: 'integer', value: 0 }] } },
        Get_items: { type: 'OpenApiConnection', runAfter: {}, inputs: {} },
        Compose: {
            type: 'Compose', runAfter: {},
            inputs: { a: "@body('Get_items')", b: "@variables('Total')", c: "@triggerBody()?['text']", d: "@parameters('Env')" },
        },
    }, { parameters: { Env: { type: 'String' } } })), []);
});

test('references inside scopes, conditions and switches are checked, and spelling is suggested', () => {
    const result = validateExpressions(flow({
        Get_items: { type: 'OpenApiConnection', runAfter: {}, inputs: {} },
        Scope: {
            type: 'Scope', runAfter: {},
            actions: {
                Check: {
                    type: 'If', runAfter: {},
                    expression: { and: [{ equals: ["@variables('Totl')", 1] }] },
                    actions: { Inner: { type: 'Compose', runAfter: {}, inputs: "@outputs('Get_itms')" } },
                    else: { actions: {} },
                },
            },
        },
        Init: { type: 'InitializeVariable', runAfter: {}, inputs: { variables: [{ name: 'Total', type: 'integer' }] } },
    }));
    assert.deepEqual(result.issues.map((i) => `${i.referencedName} in ${i.actionName}`).sort(), ['Get_itms in Inner', 'Totl in Check']);
    assert.deepEqual(result.issues.find((i) => i.referencedName === 'Get_itms').suggestion, [{ name: 'Get_items', reason: 'similar spelling' }]);
});
