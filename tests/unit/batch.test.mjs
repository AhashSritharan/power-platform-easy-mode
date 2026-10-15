/**
 * core/batch.js — reading a $batch response. Both responses below are a live
 * org's, verbatim except for ids, hosts and the stack trace (shortened).
 * Run: node --test tests/unit/batch.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
globalThis.chrome = { runtime: { id: 'test' } };
globalThis.location = { href: 'https://contoso.crm4.dynamics.com/main.aspx', origin: 'https://contoso.crm4.dynamics.com' };
const { parseBatchResponse } = await import(pathToFileURL(join(ROOT, 'extension/src/core/batch.js')));

const G = '00000000-0000-4000-8000-000000000001';

const SUCCEEDED = `--batchresponse_${G}\r\nContent-Type: multipart/mixed; boundary=changesetresponse_${G}\r\n\r\n`
    + `--changesetresponse_${G}\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\nContent-ID: 1\r\n\r\n`
    + `HTTP/1.1 204 No Content\r\nOData-Version: 4.0\r\nLocation: https://contoso.crm4.dynamics.com/api/data/v9.2/contacts(${G})\r\nOData-EntityId: https://contoso.crm4.dynamics.com/api/data/v9.2/contacts(${G})\r\nX-Content-Type-Options: nosniff\r\n\r\n\r\n`
    + `--changesetresponse_${G}\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\nContent-ID: 2\r\n\r\n`
    + 'HTTP/1.1 204 No Content\r\nOData-Version: 4.0\r\nX-Content-Type-Options: nosniff\r\n\r\n\r\n'
    + `--changesetresponse_${G}--\r\n--batchresponse_${G}--\r\n`;

const FAILED = `--batchresponse_${G}\r\nContent-Type: multipart/mixed; boundary=changesetresponse_${G}\r\n\r\n`
    + `--changesetresponse_${G}\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\nContent-ID: 1\r\n\r\n`
    + `HTTP/1.1 400 Bad Request\r\nREQ_ID: ${G}\r\nContent-Type: application/json; odata.metadata=minimal\r\nOData-Version: 4.0\r\n\r\n`
    + '{"error":{"code":"0x80048d19","message":"Error identified in Payload provided by the user for Entity :\'contacts\'  ---->  InnerException : Microsoft.Crm.CrmException: Invalid property \'nosuchcolumn_xyz\' was found in entity \'Microsoft.Dynamics.CRM.contact\'.\\r\\n   at Microsoft.AspNet.OData.Formatter.Deserialization.DeserializationHelpers.ApplyProperty(…)"}}\r\n'
    + `--changesetresponse_${G}--\r\n--batchresponse_${G}--\r\n`;

test('a change set that succeeded: one result per operation, with the created record', () => {
    const results = parseBatchResponse(SUCCEEDED);
    assert.equal(results.length, 2);
    assert.deepEqual(results.map((r) => r.ok), [true, true]);
    assert.equal(results[0].entityId, `https://contoso.crm4.dynamics.com/api/data/v9.2/contacts(${G})`);
    assert.equal(results[1].entityId, null);
});

test('a change set that failed: Dataverse\'s message, not "Bad Request"', () => {
    const [result] = parseBatchResponse(FAILED);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error, /^Error identified in Payload provided by the user for Entity :'contacts'.*Invalid property 'nosuchcolumn_xyz'/);
});
