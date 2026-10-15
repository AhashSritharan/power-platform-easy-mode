#!/usr/bin/env node
/**
 * Test for the Record Browser (src/tools/record-browser.js) — the FetchXML it
 * sends and how it reads column metadata.
 *
 * Values typed into a filter end up inside XML and, for "contains", inside a
 * SQL like pattern: both have to be escaped or a quote, & or % changes the
 * query. Paging must end on the primary key so pages cannot overlap, and a
 * view's filter has to be kept while its columns are not.
 * Run: node scripts/record-browser-test.mjs
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
globalThis.location = { href: 'https://contoso.crm4.dynamics.com/main.aspx', origin: 'https://contoso.crm4.dynamics.com', search: '' };

const {
    toColumn, columnsFromMetadata, valueKey, operatorsFor, searchFilterXml, matchRanges, needsValue, conditionXml, describeCondition, buildFetchXml,
    parsePagingCookie, layoutColumns, xmlEscape,
} = await import(pathToFileURL(join(ROOT, 'extension/src/tools/record-browser.js')));

const attr = (LogicalName, AttributeType, extra = {}) => ({
    LogicalName, AttributeType, IsValidForRead: true, AttributeOf: null,
    DisplayName: { UserLocalizedLabel: { Label: LogicalName.toUpperCase() } }, ...extra,
});

// ── metadata → columns ────────────────────────────────────────────────────
const names = new Set(['name', 'primarycontactid', 'primarycontactidname', 'parentaccountid', 'ownerid', 'owneridname']);
const text = toColumn(attr('name', 'String'), names);
assert.equal(text.kind, 'text');
assert.equal(text.sortable, true);
assert.equal(toColumn(attr('description', 'Memo')).sortable, false, 'long text cannot be ordered');
const lookup = toColumn(attr('primarycontactid', 'Lookup'), names);
assert.equal(lookup.kind, 'lookup');
assert.equal(lookup.nameAttr, 'primarycontactidname');
assert.equal(lookup.isUser, false);
assert.equal(toColumn(attr('parentaccountid', 'Lookup'), names).nameAttr, null, 'no name column, no name filter');
assert.equal(toColumn(attr('ownerid', 'Owner'), names).isUser, true);
assert.equal(valueKey(lookup), '_primarycontactid_value');
assert.equal(valueKey(text), 'name');
// Virtual columns are told apart by their type name.
const file = toColumn(attr('cr1_doc', 'Virtual', { AttributeTypeName: { Value: 'FileType' } }));
const image = toColumn(attr('entityimage', 'Virtual', { AttributeTypeName: { Value: 'ImageType' } }));
const choices = toColumn(attr('cr1_tags', 'Virtual', { AttributeTypeName: { Value: 'MultiSelectPicklistType' } }));
assert.equal(file.kind, 'file');
assert.equal(image.kind, 'image');
assert.equal(choices.kind, 'choices');
for (const col of [file, image]) {
    assert.equal(col.sortable, false);
    assert.equal(col.filterable, false);
}
// As a live org reports it: the image names its id column as AttributeOf.
// The image stays, its id column and companions go.
const imageMeta = [
    attr('entityimage', 'Virtual', { AttributeTypeName: { Value: 'ImageType' }, AttributeOf: 'entityimageid' }),
    attr('entityimage_url', 'String', { AttributeOf: 'entityimageid' }),
    attr('entityimage_timestamp', 'BigInt', { AttributeOf: 'entityimageid' }),
    attr('entityimageid', 'Uniqueidentifier'),
    attr('name', 'String'),
];
assert.deepEqual(columnsFromMetadata(imageMeta).map((c) => c.name), ['entityimage', 'name']);
assert.equal(toColumn(attr('other', 'Virtual', { AttributeTypeName: { Value: 'VirtualType' } })), null);
assert.equal(toColumn(attr('entityimage_url', 'String', { AttributeOf: 'entityimage' })), null, 'companions are not columns');
assert.equal(toColumn(attr('secret', 'String', { IsValidForRead: false })), null);
assert.equal(toColumn(attr('rules', 'CalendarRules')), null);

// ── conditions ────────────────────────────────────────────────────────────
// Values are XML-escaped, and like wildcards in them match themselves.
assert.equal(conditionXml(text, { op: 'contains', value: '50% & "more"' }),
    '<condition attribute="name" operator="like" value="%50[%] &amp; &quot;more&quot;%" />');
assert.equal(conditionXml(text, { op: 'startswith', value: 'a_b' }), '<condition attribute="name" operator="like" value="a[_]b%" />');
assert.equal(conditionXml(text, { op: 'eq', value: "O'Brien" }), '<condition attribute="name" operator="eq" value="O&apos;Brien" />');
assert.equal(conditionXml(text, { op: 'hasdata' }), '<condition attribute="name" operator="not-null" />');
// A lookup filters on its name column, or by id.
assert.equal(conditionXml(lookup, { op: 'contains', value: 'Ann' }), '<condition attribute="primarycontactidname" operator="like" value="%Ann%" />');
assert.equal(conditionXml(lookup, { op: 'id', value: '{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}' }),
    '<condition attribute="primarycontactid" operator="eq" value="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" />');
assert.equal(conditionXml(lookup, { op: 'id', value: 'not a guid' }), null);
const owner = toColumn(attr('ownerid', 'Owner'), names);
assert.equal(conditionXml(owner, { op: 'me' }), '<condition attribute="ownerid" operator="eq-userid" />');
assert.ok(!operatorsFor(lookup).some(([op]) => op === 'me'), '"is me" only on user lookups');
// Choices take a list of option values.
const status = toColumn(attr('statuscode', 'Status'));
assert.equal(conditionXml(status, { op: 'in', value: ['1', '2'] }),
    '<condition attribute="statuscode" operator="in"><value>1</value><value>2</value></condition>');
assert.equal(conditionXml(status, { op: 'in', value: [] }), null, 'an empty pick is incomplete');
assert.equal(conditionXml(choices, { op: 'containvalues', value: ['7'] }),
    '<condition attribute="cr1_tags" operator="contain-values"><value>7</value></condition>');
// Booleans are 1 / 0; dates use the FetchXML date operators.
const flag = toColumn(attr('donotemail', 'Boolean'));
assert.equal(conditionXml(flag, { op: 'false' }), '<condition attribute="donotemail" operator="eq" value="0" />');
const created = toColumn(attr('createdon', 'DateTime'));
assert.equal(conditionXml(created, { op: 'onorafter', value: '2026-01-01' }), '<condition attribute="createdon" operator="on-or-after" value="2026-01-01" />');
assert.equal(conditionXml(created, { op: 'lastdays', value: '7' }), '<condition attribute="createdon" operator="last-x-days" value="7" />');
assert.equal(conditionXml(created, { op: 'lastdays', value: 'abc' }), null);
// Incomplete conditions produce nothing rather than a broken clause.
assert.equal(conditionXml(text, { op: 'contains', value: '   ' }), null);
assert.equal(needsValue('hasdata'), false);
assert.equal(needsValue('in'), true);

// Every operator every kind offers builds a condition.
const kinds = [text, toColumn(attr('revenue', 'Money')), created, flag, toColumn(attr('accountid', 'Uniqueidentifier')),
    status, choices, lookup, owner];
for (const col of kinds) {
    for (const [op] of operatorsFor(col)) {
        const value = ['in', 'notin', 'containvalues', 'notcontainvalues'].includes(op) ? ['1']
            : op === 'id' || col.kind === 'guid' ? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
                : col.kind === 'date' ? (op === 'lastdays' ? '30' : '2026-01-01') : col.kind === 'number' ? '5' : 'x';
        assert.ok(conditionXml(col, { op, value }), `${col.kind}/${op} builds a condition`);
    }
}
assert.deepEqual(operatorsFor(file), []);
// A GUID column refuses what is not one, rather than sending a FormatException.
const guid = toColumn(attr('accountid', 'Uniqueidentifier'));
assert.equal(conditionXml(guid, { op: 'eq', value: 'abc' }), null);
assert.equal(conditionXml(guid, { op: 'ne', value: '{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}' }),
    '<condition attribute="accountid" operator="ne" value="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" />');
assert.ok(conditionXml(guid, { op: 'hasdata' }));

assert.equal(describeCondition(text, { op: 'startswith', value: 'Con' }), 'NAME begins with "Con"');
assert.equal(describeCondition(status, { op: 'in', value: ['1'], labels: ['Active'] }), 'STATUSCODE equals "Active"');
assert.equal(describeCondition(flag, { op: 'true' }), 'DONOTEMAIL: Yes');

// ── the query ─────────────────────────────────────────────────────────────
const entity = { name: 'account', primaryId: 'accountid', primaryName: 'name' };
const fetch1 = buildFetchXml({ entity, columns: [text, lookup, file], conditions: [{ column: 'name', op: 'contains', value: 'a' }] });
assert.match(fetch1, /^<fetch version="1.0" mapping="logical" count="100" page="1" returntotalrecordcount="true"><entity name="account">/);
assert.match(fetch1, /<attribute name="accountid" \/>/, 'the key is always fetched');
assert.match(fetch1, /<attribute name="cr1_doc_name" \/>/, 'a file column brings its file name');
assert.match(fetch1, /<attribute name="primarycontactid" \/>/, 'a lookup is fetched by its logical name');
// Without a chosen sort the key alone orders the rows; with one it comes last.
assert.match(fetch1, /<order attribute="accountid" descending="false" \/><filter/);
const sorted = buildFetchXml({ entity, columns: [text], sort: [{ column: 'name', dir: 'desc' }, { column: 'createdon', dir: 'asc' }] });
assert.match(sorted, /<order attribute="name" descending="true" \/><order attribute="createdon" descending="false" \/><order attribute="accountid" descending="false" \/>/);
// Unknown columns and incomplete conditions are left out rather than breaking it.
const lenient = buildFetchXml({ entity, columns: [text], conditions: [{ column: 'gone', op: 'eq', value: 'x' }, { column: 'name', op: 'eq', value: '' }] });
assert.ok(!lenient.includes('<filter'), 'no filter element without a condition');
// Search is on the primary name.
assert.match(buildFetchXml({ entity, columns: [text], search: ' Contoso ' }), /<condition attribute="name" operator="like" value="%Contoso%" \/>/);
// A view contributes its filter, its filtering links and its sort — never its columns.
const view = {
    filters: '<filter type="and"><condition attribute="statecode" operator="eq" value="0" /></filter>',
    links: '<link-entity name="contact" from="contactid" to="primarycontactid"><filter><condition attribute="lastname" operator="not-null" /></filter></link-entity>',
    orders: [{ column: 'name', dir: 'asc' }],
    distinct: true,
};
const fromView = buildFetchXml({ entity, columns: [text], view, conditions: [{ column: 'name', op: 'hasdata' }] });
assert.match(fromView, /distinct="true"/);
assert.match(fromView, /<filter type="and"><filter type="and"><condition attribute="statecode" operator="eq" value="0" \/><\/filter><condition attribute="name" operator="not-null" \/><\/filter><link-entity/);
assert.match(fromView, /<order attribute="name" descending="false" \/><order attribute="accountid"/);
assert.ok(!/<order attribute="name"/.test(buildFetchXml({ entity, columns: [text], view, sort: [{ column: 'createdon', dir: 'asc' }] })),
    'a chosen sort replaces the view\'s');
// The paging cookie is escaped into its attribute.
const paged = buildFetchXml({ entity, columns: [text], page: 3, pagingCookie: '<cookie page="2"><accountid last="{1}" /></cookie>' });
assert.match(paged, /page="3"/);
assert.match(paged, /paging-cookie="&lt;cookie page=&quot;2&quot;&gt;&lt;accountid last=&quot;\{1\}&quot; \/&gt;&lt;\/cookie&gt;"/);

// ── search over every column ──────────────────────────────────────────────
const money = toColumn(attr('revenue', 'Money'));
const count = toColumn(attr('numberofemployees', 'Integer'));
const options = new Map([['statuscode', [{ value: 1, label: 'Active' }, { value: 2, label: 'Inactive' }]], ['cr1_tags', [{ value: 7, label: 'Red' }]]]);
const searchCols = [text, lookup, toColumn(attr('parentaccountid', 'Lookup'), names), status, choices, money, count,
    toColumn(attr('accountid', 'Uniqueidentifier')), created, flag, file, image];
const words = searchFilterXml(searchCols, 'act', options);
assert.match(words, /^<filter type="or">/);
assert.match(words, /<condition attribute="name" operator="like" value="%act%" \/>/, 'text contains');
assert.match(words, /<condition attribute="primarycontactidname" operator="like" value="%act%" \/>/, 'a lookup by its name');
assert.match(words, /<condition attribute="statuscode" operator="in"><value>1<\/value><value>2<\/value><\/condition>/, 'choices by label');
assert.ok(!/cr1_tags|revenue|numberofemployees|accountid"|createdon|donotemail|entityimage|cr1_doc/.test(words),
    'no number, GUID, date, yes/no, file or image condition for plain words, and no choice without a matching label');
const numeric = searchFilterXml(searchCols, '12.5', options);
assert.match(numeric, /<condition attribute="revenue" operator="eq" value="12.5" \/>/);
assert.ok(!numeric.includes('numberofemployees'), 'a whole-number column is not asked for 12.5');
assert.match(searchFilterXml(searchCols, '42', options), /<condition attribute="numberofemployees" operator="eq" value="42" \/>/);
const byId = searchFilterXml(searchCols, '{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}', options);
assert.match(byId, /<condition attribute="accountid" operator="eq" value="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" \/>/);
assert.match(byId, /<condition attribute="primarycontactid" operator="eq" value="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" \/>/);
assert.match(searchFilterXml(searchCols, 'red', options), /<condition attribute="cr1_tags" operator="contain-values"><value>7<\/value><\/condition>/);
assert.equal(searchFilterXml(searchCols, '  ', options), null);
// File-sized text columns stay out of the search; they still show in the grid.
const [content, desc] = columnsFromMetadata([attr('content', 'String'), attr('description', 'Memo')],
    new Map([['content', 1073741823], ['description', 2000]]));
assert.equal(content.blob, true);
assert.equal(desc.blob, undefined);
assert.equal(searchFilterXml([content, desc], 'x'), '<filter type="or"><condition attribute="description" operator="like" value="%x%" /></filter>');
assert.equal(searchFilterXml([created, flag], 'x'), null, 'nothing searchable, nothing to match');
// In the query: the OR group, or — when nothing can match — no record at all.
assert.match(buildFetchXml({ entity, columns: [text], search: 'act', searchColumns: searchCols, searchOptions: options }), /<filter type="and"><filter type="or">/);
assert.match(buildFetchXml({ entity, columns: [text], search: 'x', searchColumns: [created] }), /<condition attribute="accountid" operator="null" \/>/);

// Highlighting: every occurrence, case-insensitive.
assert.deepEqual(matchRanges('Contoso Coffee Co', 'co'), [[0, 2], [8, 10], [15, 17]]);
assert.deepEqual(matchRanges('aaaa', 'aa'), [[0, 2], [2, 4]], 'occurrences do not overlap');
assert.deepEqual(matchRanges('Contoso', ''), []);

// ── paging cookie and layout ──────────────────────────────────────────────
const inner = '<cookie page="1"><accountid last="{A}" first="{B}" /></cookie>';
const annotation = `<cookie pagenumber="2" pagingcookie="${encodeURIComponent(encodeURIComponent(inner))}" istracking="False" />`;
assert.equal(parsePagingCookie(annotation), inner);
assert.equal(parsePagingCookie(undefined), null);
assert.deepEqual(
    layoutColumns('<grid><row name="result" id="accountid"><cell name="name" width="300" /><cell name="a_1.emailaddress1" width="100" /><cell name="telephone1" width="100" /></row></grid>'),
    ['name', 'telephone1'], 'link-entity cells are left out');
assert.equal(xmlEscape('<&>'), '&lt;&amp;&gt;');

console.log('record-browser: all checks passed');
