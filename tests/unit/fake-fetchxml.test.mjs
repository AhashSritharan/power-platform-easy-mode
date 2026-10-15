/**
 * The mock tests' FetchXML evaluator (tests/e2e/mock/fake-fetchxml.js), fed
 * with FetchXML written by the Record Browser's own builder — so what it
 * answers is what the tool really asks.
 * Run: node --test tests/unit/fake-fetchxml.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runFetchXml, parseXml } from '../e2e/mock/fake-fetchxml.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
globalThis.chrome = { runtime: { id: 'test' }, storage: { local: {}, onChanged: { addListener() {} } } };
globalThis.document = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
globalThis.window = { addEventListener() {} };
globalThis.location = { href: 'https://contoso.crm4.dynamics.com/main.aspx', origin: 'https://contoso.crm4.dynamics.com', search: '' };
const { buildFetchXml, parsePagingCookie } = await import(pathToFileURL(join(ROOT, 'extension/src/tools/record-browser.js')));

const FV = '@OData.Community.Display.V1.FormattedValue';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const contact = (n, fullname, extra = {}) => ({ '@odata.etag': `W/"${n}"`, contactid: id(n), fullname, preferredcontactmethodcode: 1, [`preferredcontactmethodcode${FV}`]: 'Any', ...extra });
const ROWS = [
    contact(1, 'Maria Campbell', { donotemail: false }),
    contact(2, 'John Glynn', { _parentcustomerid_value: id(9), [`_parentcustomerid_value${FV}`]: 'Fabrikam', '_parentcustomerid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'account', donotemail: true }),
    contact(3, 'Anne 50% Off', { preferredcontactmethodcode: 2, [`preferredcontactmethodcode${FV}`]: 'Email', emailaddress1: null }),
];
const entity = { name: 'contact', primaryId: 'contactid', primaryName: 'fullname' };
const cols = {
    fullname: { name: 'fullname', kind: 'text', label: 'Full Name' },
    preferredcontactmethodcode: { name: 'preferredcontactmethodcode', kind: 'choice', label: 'Preferred' },
    parentcustomerid: { name: 'parentcustomerid', kind: 'lookup', nameAttr: 'parentcustomeridname', label: 'Company' },
    donotemail: { name: 'donotemail', kind: 'bool', label: 'Do not email' },
    emailaddress1: { name: 'emailaddress1', kind: 'text', label: 'Email' },
};
const columns = Object.values(cols);
const fetch = (options) => runFetchXml(buildFetchXml({ entity, columns, ...options }), ROWS, { primaryId: 'contactid' });
const names = (response) => response.value.map((r) => r.fullname);

test('the shape a live org answers in', () => {
    const response = fetch({ count: 2, page: 1 });
    assert.equal(response['@odata.count'], 3);
    assert.equal(response['@Microsoft.Dynamics.CRM.totalrecordcount'], 3);
    assert.equal(response['@Microsoft.Dynamics.CRM.morerecords'], true);
    assert.equal(parsePagingCookie(response['@Microsoft.Dynamics.CRM.fetchxmlpagingcookie']), '<cookie page="1"></cookie>', 'the tool can read the cookie back');
    const john = fetch({}).value.find((r) => r.fullname === 'John Glynn');
    assert.equal(john['_parentcustomerid_value'], id(9), 'lookups come as _x_value');
    assert.equal(john[`_parentcustomerid_value${FV}`], 'Fabrikam');
    assert.equal('emailaddress1' in fetch({}).value.find((r) => r.fullname.startsWith('Anne')), false, 'nulls are left out');
    assert.equal(fetch({ count: 2, page: 2 })['@Microsoft.Dynamics.CRM.morerecords'], false);
});

test('search, conditions and sort as the Record Browser writes them', () => {
    assert.deepEqual(names(fetch({ search: 'glyn' })), ['John Glynn']);
    assert.deepEqual(names(fetch({ search: '50%' })), ['Anne 50% Off'], 'a % in the search is a literal');
    assert.deepEqual(names(fetch({ conditions: [{ column: 'parentcustomerid', op: 'contains', value: 'fabri' }] })), ['John Glynn'], 'a lookup filters on its name');
    assert.deepEqual(names(fetch({ conditions: [{ column: 'preferredcontactmethodcode', op: 'in', value: ['2'] }] })), ['Anne 50% Off']);
    assert.deepEqual(names(fetch({ conditions: [{ column: 'donotemail', op: 'true' }] })), ['John Glynn']);
    assert.deepEqual(names(fetch({ conditions: [{ column: 'parentcustomerid', op: 'nodata' }] })).sort(), ['Anne 50% Off', 'Maria Campbell']);
    assert.deepEqual(names(fetch({ sort: [{ column: 'fullname', dir: 'desc' }] })), ['Maria Campbell', 'John Glynn', 'Anne 50% Off']);
});

test('what it does not know, it refuses', () => {
    assert.throws(() => runFetchXml('<fetch><entity name="contact"><link-entity name="account" from="accountid" to="parentcustomerid" /></entity></fetch>', ROWS), /link-entity/);
    assert.throws(() => runFetchXml('<fetch><entity name="contact"><filter><condition attribute="x" operator="above" value="1" /></filter></entity></fetch>', ROWS), /no operator "above"/);
    assert.equal(parseXml('<a b="&amp;&quot;"><c>&lt;x&gt;</c></a>').attrs.b, '&"');
});
