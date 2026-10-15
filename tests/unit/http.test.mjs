/**
 * core/http.js — what a failed request tells the user.
 * Run: node --test tests/unit/http.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
globalThis.chrome = { runtime: { id: 'test' } };
globalThis.location = { href: 'https://contoso.crm4.dynamics.com/main.aspx', origin: 'https://contoso.crm4.dynamics.com' };
const { HttpError, errorMessage } = await import(pathToFileURL(join(ROOT, 'extension/src/core/http.js')));

test('errorMessage gives Dataverse\'s own reason, not "HTTP 400"', () => {
    // As a live org answers a flow that cannot be turned on.
    const body = JSON.stringify({ error: { code: '0x80060467', message: 'A connector was imported, however the related connection references need connections created and then any dependent flows can be started.' } });
    assert.equal(errorMessage(new HttpError(400, '', body)),
        'A connector was imported, however the related connection references need connections created and then any dependent flows can be started.');
});

test('errorMessage falls back to the error\'s own text', () => {
    assert.equal(errorMessage(new HttpError(500, 'Internal Server Error', '')), 'HTTP 500 Internal Server Error');
    assert.equal(errorMessage(new HttpError(502, '', '<html>Bad gateway</html>')), 'HTTP 502');
    assert.equal(errorMessage(new HttpError(400, '', JSON.stringify({ error: { message: '' } }))), 'HTTP 400');
    assert.equal(errorMessage(new Error('Network error')), 'Network error');
});
