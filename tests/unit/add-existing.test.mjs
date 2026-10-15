#!/usr/bin/env node
/**
 * Smoke test for Add Existing Components (src/tools/solution-add-existing.js)
 * — the query it sends to msdyn_solutioncomponentsummaries.
 *
 * That virtual table has sharp edges measured against live orgs: booleans are
 * strings, empty is '' as often as null, and a query without a stable final
 * sort key can page into overlapping rows. These are the rules checked here.
 * Run: node --test tests/unit/add-existing.test.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The module pulls in the UI kit and the storage layer at import time. Neither
// runs anything on load, but both name globals that do not exist in node.
globalThis.chrome = { runtime: { id: 'test' }, storage: { local: {}, onChanged: { addListener() {} } } };
globalThis.document = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
globalThis.window = { addEventListener() {} };
globalThis.location = { href: 'https://contoso.crm4.dynamics.com/main.aspx', origin: 'https://contoso.crm4.dynamics.com' };

const {
    conditionClause, describeCondition, buildQuery, applySort, CORE_TYPES, COLUMNS, OPERATORS, needsValue,
    parsePortalQuery, typeForPortalClause, conjuncts,
} = await import(pathToFileURL(join(ROOT, 'extension/src/tools/solution-add-existing.js')));

const type = (key) => CORE_TYPES.find((t) => t.key === key);
const decoded = (path) => decodeURIComponent(path);

// ── conditions ────────────────────────────────────────────────────────────
assert.equal(conditionClause({ column: 'msdyn_name', op: 'startswith', value: 'cr123_' }), "startswith(msdyn_name,'cr123_')");
assert.equal(conditionClause({ column: 'msdyn_name', op: 'notcontains', value: 'msdyn' }), "not contains(msdyn_name,'msdyn')");
// Quotes are doubled, never left to break out of the literal.
assert.equal(conditionClause({ column: 'msdyn_name', op: 'eq', value: "O'Brien" }), "msdyn_name eq 'O''Brien'");
// Booleans are Edm.String on this table: an unquoted false is a 400.
assert.equal(conditionClause({ column: 'msdyn_ismanaged', op: 'false' }), "msdyn_ismanaged eq 'false'");
// Empty comes back as '' — "no data" must catch both.
assert.equal(conditionClause({ column: 'msdyn_description', op: 'nodata' }), "msdyn_description eq null or msdyn_description eq ''");
assert.equal(conditionClause({ column: 'msdyn_description', op: 'hasdata' }), "msdyn_description ne null and msdyn_description ne ''");
// Dates are ISO strings: "on or before" a day means before the next one starts.
assert.equal(conditionClause({ column: 'msdyn_modifiedon', op: 'onorbefore', value: '2026-02-28' }), "msdyn_modifiedon lt '2026-03-01'");
assert.equal(conditionClause({ column: 'msdyn_modifiedon', op: 'onorafter', value: '2026-01-01' }), "msdyn_modifiedon ge '2026-01-01'");
assert.equal(
    conditionClause({ column: 'msdyn_modifiedon', op: 'lastdays', value: '7' }, new Date('2026-09-25T12:00:00Z')),
    "msdyn_modifiedon ge '2026-09-18'");
// Incomplete conditions produce nothing rather than a broken clause.
assert.equal(conditionClause({ column: 'msdyn_name', op: 'contains', value: '  ' }), null);
assert.equal(conditionClause({ column: 'msdyn_modifiedon', op: 'lastdays', value: 'abc' }), null);
assert.equal(needsValue('hasdata'), false);
assert.equal(needsValue('contains'), true);

// Every operator the menus offer produces a clause.
for (const [kind, ops] of Object.entries(OPERATORS)) {
    const column = Object.keys(COLUMNS).find((c) => COLUMNS[c].kind === kind);
    for (const [op] of ops) {
        const value = kind === 'date' ? (op === 'lastdays' ? '30' : '2026-01-01') : 'x';
        assert.ok(conditionClause({ column, op, value }), `${kind}/${op} builds a clause`);
    }
}

assert.equal(describeCondition({ column: 'msdyn_name', op: 'startswith', value: 'cr123_' }), 'Name begins with "cr123_"');
assert.equal(describeCondition({ column: 'msdyn_ismanaged', op: 'false' }), 'Managed: No');

// ── query ─────────────────────────────────────────────────────────────────
const query = decoded(buildQuery({
    type: type('61'),
    conditions: [{ column: 'msdyn_iscustomizable', op: 'true' }, { column: 'msdyn_name', op: 'contains', value: '' }],
    search: 'nc_pro',
    sort: [{ column: 'msdyn_ismanaged', dir: 'desc' }],
    columns: ['msdyn_displayname', 'msdyn_typename'],
}));
assert.match(query, /^\/msdyn_solutioncomponentsummaries\?\$select=/);
assert.ok(query.includes('(msdyn_solutionid eq fd140aaf-4df4-11dd-bd17-0019b9312238)'));
assert.ok(query.includes('(msdyn_componenttype eq 61)'));
assert.ok(query.includes("(msdyn_iscustomizable eq 'true')"));
assert.ok(query.includes("(contains(msdyn_displayname,'nc_pro') or contains(msdyn_name,'nc_pro'))"), 'search ORs name columns inside its own group');
assert.ok(!query.includes("contains(msdyn_name,'')"), 'empty conditions are dropped');
// The id AddSolutionComponent needs is always selected, whatever the columns.
assert.match(query, /\$select=[^&]*msdyn_objectid/);
// The name ends every sort, so pages cannot overlap on ties.
assert.ok(query.endsWith('$orderby=msdyn_ismanaged desc,msdyn_name asc'));
// $top would suppress nextLink paging; it must never be part of the query.
assert.ok(!query.includes('$top'));

// Process subtypes carry their category as a fixed clause.
assert.ok(decoded(buildQuery({ type: type('29-5') })).includes("(msdyn_workflowcategory eq '5')"));
assert.ok(!decoded(buildQuery({ type: type('29') })).includes('msdyn_workflowcategory eq'));
// Sorting by name already is the tiebreak — not repeated.
assert.ok(decoded(buildQuery({ type: type('1'), sort: [{ column: 'msdyn_name', dir: 'desc' }] })).endsWith('$orderby=msdyn_name desc'));
// Characters that would end the query string are encoded.
assert.ok(!buildQuery({ type: type('61'), search: 'a&b#c' }).includes('a&b'));

// ── sorting ───────────────────────────────────────────────────────────────
const one = applySort([], 'msdyn_name', 'asc', false);
assert.deepEqual(one, [{ column: 'msdyn_name', dir: 'asc' }]);
const two = applySort(one, 'msdyn_modifiedon', 'desc', true);
assert.deepEqual(two, [{ column: 'msdyn_name', dir: 'asc' }, { column: 'msdyn_modifiedon', dir: 'desc' }]);
// Shift-sorting a key already in the list flips it in place.
assert.deepEqual(applySort(two, 'msdyn_name', 'desc', true), [{ column: 'msdyn_name', dir: 'desc' }, { column: 'msdyn_modifiedon', dir: 'desc' }]);
// A plain click replaces the whole sort.
assert.deepEqual(applySort(two, 'msdyn_typename', 'asc', false), [{ column: 'msdyn_typename', dir: 'asc' }]);

// ── portal hand-off ───────────────────────────────────────────────────────
// Real list queries, as the maker portal's Add-existing panels sent them.
const ORG = 'https://contoso.crm4.dynamics.com';
const portal = (filter) => `${ORG}/api/data/v9.0/msdyn_solutioncomponentsummaries?%24filter=${encodeURIComponent(filter)}`
    + '&%24orderby=msdyn_displayname%20asc&api-version=9.1';

const webResources = parsePortalQuery(portal("((msdyn_componenttype eq 61)) and (msdyn_iscustomizable eq 'true')"));
assert.deepEqual(webResources, { orgUrl: ORG, componentType: 61, typeClause: 'msdyn_componenttype eq 61', customizableOnly: true, search: '' });
assert.equal(typeForPortalClause(webResources.typeClause, CORE_TYPES).key, '61');

const flows = parsePortalQuery(portal("((msdyn_componenttype eq 29 and msdyn_workflowcategory eq '5')) and (msdyn_iscustomizable eq 'true')"));
assert.equal(typeForPortalClause(flows.typeClause, CORE_TYPES).key, '29-5');

// "Processes" is a selection none of the listed types reproduces — kept as sent.
const processes = parsePortalQuery(portal("((msdyn_componenttype eq 29 and msdyn_workflowcategory ne '5' and msdyn_workflowcategory ne '6' and msdyn_workflowcategory ne '2')) and (msdyn_iscustomizable eq 'true')"));
assert.equal(processes.typeClause, "msdyn_componenttype eq 29 and msdyn_workflowcategory ne '5' and msdyn_workflowcategory ne '6' and msdyn_workflowcategory ne '2'");
assert.equal(typeForPortalClause(processes.typeClause, CORE_TYPES), null);
assert.ok(decoded(buildQuery({ type: { componentType: 29, fixedFilter: processes.typeClause } }))
    .includes("(msdyn_componenttype eq 29 and msdyn_workflowcategory ne '5' and msdyn_workflowcategory ne '6' and msdyn_workflowcategory ne '2')"));

// Connection references: an org-specific code, and no customizable test.
const connRefs = parsePortalQuery(portal('((msdyn_componenttype eq 10137))'));
assert.equal(connRefs.customizableOnly, false);
assert.equal(typeForPortalClause(connRefs.typeClause, CORE_TYPES), null);
assert.equal(typeForPortalClause(connRefs.typeClause, [{ key: 't10137', componentType: 10137 }]).key, 't10137');

// A search typed into the portal panel comes along, quotes and all.
const searched = parsePortalQuery(portal("(msdyn_solutionid eq fd140aaf-4df4-11dd-bd17-0019b9312238) and ((msdyn_componenttype eq 61)) and (msdyn_iscustomizable eq 'true') and (contains(msdyn_name, 'o''pro') or contains(msdyn_displayname, 'o''pro') or contains(msdyn_componenttypename, 'o''pro'))"));
assert.equal(searched.search, "o'pro");
assert.equal(searched.componentType, 61);

// The panel's "already in this solution" query is not a candidate…
assert.equal(parsePortalQuery(portal("(msdyn_solutionid eq 11111111-2222-4333-8444-555555555555) and ((msdyn_componenttype eq 61)) and (msdyn_iscustomizable eq 'true')")), null);
// …nor is the solution page's own object list, nor other tables.
assert.equal(parsePortalQuery(portal("(msdyn_solutionid eq 11111111-2222-4333-8444-555555555555 and (msdyn_componentlogicalname eq 'msdyn_aimodel' or msdyn_componenttype eq 80))")), null);
assert.equal(parsePortalQuery(`${ORG}/api/data/v9.0/solutions?%24filter=ismanaged%20eq%20false`), null);
assert.equal(parsePortalQuery('not a url'), null);

// Parens inside a quoted value do not confuse the split.
assert.deepEqual(conjuncts("((msdyn_componenttype eq 61)) and (contains(msdyn_name, 'a) and (b'))"),
    ['msdyn_componenttype eq 61', "contains(msdyn_name, 'a) and (b')"]);

// ── catalogue ─────────────────────────────────────────────────────────────
assert.equal(new Set(CORE_TYPES.map((t) => t.key)).size, CORE_TYPES.length, 'type keys are unique');
for (const t of CORE_TYPES) for (const c of t.columns ?? []) assert.ok(COLUMNS[c], `${t.label} column ${c} is known`);

console.log('add-existing: all checks passed');
