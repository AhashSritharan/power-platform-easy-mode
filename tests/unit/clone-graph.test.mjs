/**
 * Deep Clone's planner (extension/src/tools/shared/clone-graph.js): which
 * records a clone writes, in which order, and when one deep insert can carry
 * it — against in-memory source and target orgs.
 * Run: node --test tests/unit/clone-graph.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { buildClonePlan, isSimpleTree, ACTIONS } = await import(pathToFileURL(join(ROOT, 'extension/src/tools/shared/clone-graph.js')));

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const METADATA = {
    account: { EntitySetName: 'accounts', PrimaryIdAttribute: 'accountid', PrimaryNameAttribute: 'name' },
    contact: { EntitySetName: 'contacts', PrimaryIdAttribute: 'contactid', PrimaryNameAttribute: 'fullname' },
    cr1_language: { EntitySetName: 'cr1_languages', PrimaryIdAttribute: 'cr1_languageid', PrimaryNameAttribute: 'cr1_name' },
    systemuser: { EntitySetName: 'systemusers', PrimaryIdAttribute: 'systemuserid', PrimaryNameAttribute: 'fullname' },
};
// account 1:N contact (contact.parentcustomerid), the only relationship selected in most tests.
const CONTACTS = {
    ReferencedEntity: 'account', ReferencingEntity: 'contact', ReferencingAttribute: 'parentcustomerid',
    ReferencedEntityNavigationPropertyName: 'contact_customer_accounts',
};

/** An org as a Dataverse client: tables of rows, children found by lookup attribute. */
function fakeOrg(tables = {}, { missingTables = [] } = {}) {
    const calls = [];
    const setOf = Object.fromEntries(Object.entries(METADATA).map(([entity, m]) => [m.EntitySetName, { entity, ...m }]));
    return {
        calls,
        metadata: (entity) => (missingTables.includes(entity) ? null : METADATA[entity]),
        async get(path) {
            calls.push(path);
            const m = path.match(/^\/(\w+)\(([^)]+)\)(?:\/(\w+))?/);
            const set = setOf[m[1]];
            const rows = tables[set.entity] ?? [];
            const row = rows.find((r) => r[set.PrimaryIdAttribute] === m[2]);
            if (!m[3]) {
                if (!row) throw Object.assign(new Error('Not found'), { status: 404 });
                return row;
            }
            // A 1:N navigation: the contacts whose parentcustomerid is this account.
            assert.equal(m[3], CONTACTS.ReferencedEntityNavigationPropertyName);
            return { value: (tables.contact ?? []).filter((c) => c._parentcustomerid_value === m[2]) };
        },
    };
}

/** Lookups as the tool reports them, from the _x_value columns the rows carry. */
const LOOKUP_COLUMNS = {
    contact: [{ attrName: 'parentcustomerid', bindKey: 'parentcustomerid_account@odata.bind', targetEntity: 'account' },
        { attrName: 'cr1_languageid', bindKey: 'cr1_LanguageId@odata.bind', targetEntity: 'cr1_language' },
        { attrName: 'ownerid', bindKey: 'ownerid@odata.bind', targetEntity: 'systemuser' }],
    account: [{ attrName: 'primarycontactid', bindKey: 'primarycontactid@odata.bind', targetEntity: 'contact' },
        { attrName: 'cr1_languageid', bindKey: 'cr1_LanguageId@odata.bind', targetEntity: 'cr1_language' }],
    cr1_language: [],
};

function plan({ source, target, rootId = id(1), selected = [CONTACTS], options = {} }) {
    const rootRecord = source.tables.account.find((a) => a.accountid === rootId);
    return buildClonePlan({
        source: source.org,
        target: target.org,
        root: { entity: 'account', id: rootId, record: rootRecord, metadata: METADATA.account },
        metadataFor: async (entity, client) => client.metadata(entity),
        lookupsOf: async (record, entity) => LOOKUP_COLUMNS[entity]
            .filter((l) => record[`_${l.attrName}_value`])
            .map((l) => ({ ...l, id: record[`_${l.attrName}_value`], label: l.attrName })),
        isIdentity: (entity) => entity === 'systemuser',
        parentBindKey: async (child, attribute) => (attribute === 'parentcustomerid' ? 'parentcustomerid_account@odata.bind' : `${attribute}@odata.bind`),
        selected: new Map(selected.map((rel, i) => [`rel${i}`, { rel }])),
        options,
    });
}

const org = (tables, opts) => ({ tables, org: fakeOrg(tables, opts) });
const account = (n, extra = {}) => ({ accountid: id(n), name: `Account ${n}`, ...extra });
const contact = (n, parent, extra = {}) => ({ contactid: id(n), fullname: `Contact ${n}`, _parentcustomerid_value: parent ? id(parent) : null, ...extra });
const summary = (p) => p.order.map((n) => `${n.action} ${n.entity} ${n.sourceId.slice(-3)}`);

test('a record with its children into an empty target: one deep insert, parent first', async () => {
    const source = org({ account: [account(1)], contact: [contact(11, 1), contact(12, 1), contact(13, 99)] });
    const target = org({});
    const p = await plan({ source, target });
    assert.deepEqual(summary(p), ['create account 001', 'create contact 011', 'create contact 012']);
    assert.deepEqual(p.stats, { create: 3, update: 0, skip: 0, delete: 0, deferred: 0 });
    const child = p.order[1];
    assert.equal(child.targetId, id(11), 'ids are preserved by default');
    assert.deepEqual(child.binds.get('parentcustomerid_account@odata.bind'), { path: `/accounts(${id(1)})`, nodeKey: p.root.key });
    assert.equal(isSimpleTree(p), true);
});

test('an existing root is updated; existing children are skipped unless asked to update', async () => {
    const source = org({ account: [account(1)], contact: [contact(11, 1), contact(12, 1)] });
    const target = org({ account: [account(1)], contact: [contact(11, 1)] });
    const p = await plan({ source, target });
    assert.equal(p.root.action, ACTIONS.UPDATE);
    assert.deepEqual(summary(p), ['update account 001', 'create contact 012']);
    assert.equal(p.stats.skip, 1);
    assert.equal(isSimpleTree(p), false, 'an update cannot ride a deep insert');

    const withUpdates = await plan({ source, target, options: { updateExistingRelated: true } });
    assert.deepEqual(summary(withUpdates).sort(), ['create contact 012', 'update account 001', 'update contact 011']);
});

test('a parent the target lacks is created once, however many records point at it', async () => {
    const source = org({
        account: [account(1)],
        contact: [contact(11, 1, { _cr1_languageid_value: id(50) }), contact(12, 1, { _cr1_languageid_value: id(50) })],
        cr1_language: [{ cr1_languageid: id(50), cr1_name: 'German' }],
    });
    const p = await plan({ source, target: org({}) });
    const languages = p.nodes.filter((n) => n.entity === 'cr1_language');
    assert.equal(languages.length, 1, 'deduplicated by source identity');
    assert.equal(languages[0].kind, 'parent');
    const order = summary(p);
    for (const c of ['create contact 011', 'create contact 012']) {
        assert.ok(order.indexOf('create cr1_language 050') < order.indexOf(c), `${c} after the language it references`);
    }
    assert.equal(isSimpleTree(p), false, 'a record referenced twice cannot be nested twice');
});

test('a parent the target has is referenced, never re-created; nothing is backfilled when that is off', async () => {
    const source = org({ account: [account(1)], contact: [contact(11, 1, { _cr1_languageid_value: id(50) })], cr1_language: [{ cr1_languageid: id(50) }] });
    const present = await plan({ source, target: org({ cr1_language: [{ cr1_languageid: id(50) }] }) });
    assert.equal(present.nodes.some((n) => n.entity === 'cr1_language'), false);
    assert.deepEqual(present.order[1].binds.get('cr1_LanguageId@odata.bind'), { path: `/cr1_languages(${id(50)})`, nodeKey: null });

    const noBackfill = await plan({ source, target: org({}), options: { backfillParents: false } });
    assert.equal(noBackfill.nodes.some((n) => n.entity === 'cr1_language'), false);
    assert.equal(noBackfill.order[1].binds.has('cr1_LanguageId@odata.bind'), false, 'the reference is left empty');
});

test('a cycle is cut: the back-reference becomes a deferred bind', async () => {
    // The account's primary contact is one of its own children.
    const source = org({ account: [account(1, { _primarycontactid_value: id(11) })], contact: [contact(11, 1)] });
    const p = await plan({ source, target: org({}) });
    assert.equal(p.stats.create, 2);
    assert.equal(p.stats.deferred, 1);
    const deferredOn = p.nodes.find((n) => n.deferred.length);
    assert.ok(deferredOn, 'one node carries the cut edge');
    assert.equal(isSimpleTree(p), false);
});

test('fresh ids when ids are not preserved — and every reference follows them', async () => {
    const source = org({ account: [account(1)], contact: [contact(11, 1)] });
    const p = await plan({ source, target: org({}), options: { preserveIds: false } });
    assert.notEqual(p.root.targetId, id(1));
    assert.deepEqual(p.order[1].binds.get('parentcustomerid_account@odata.bind').path, `/accounts(${p.root.targetId})`);
});

test('users and teams are left to identity mapping; a table the target lacks is reported', async () => {
    const source = org({ account: [account(1)], contact: [contact(11, 1, { _ownerid_value: id(70) })] });
    const p = await plan({ source, target: org({}) });
    assert.equal(p.order[1].binds.has('ownerid@odata.bind'), false);
    assert.equal(p.nodes.some((n) => n.entity === 'systemuser'), false);

    const noContacts = await plan({ source, target: org({}, { missingTables: ['contact'] }) });
    assert.deepEqual(summary(noContacts), ['create account 001']);
    assert.match(noContacts.warnings.join('\n'), /Table "contact" does not exist in the target — those records were skipped/);
});

test('removed children are listed for deletion only when asked', async () => {
    const source = org({ account: [account(1)], contact: [contact(11, 1)] });
    const target = org({ account: [account(1)], contact: [contact(11, 1), contact(14, 1)] });
    const keep = await plan({ source, target });
    assert.deepEqual(keep.deletes, []);
    const prune = await plan({ source, target, options: { deleteOrphans: true } });
    assert.deepEqual(prune.deletes.map((d) => [d.entity, d.id, d.label]), [['contact', id(14), 'Contact 14']]);
});

test('the graph stops at the node cap and says so', async () => {
    const source = org({ account: [account(1)], contact: Array.from({ length: 10 }, (_, i) => contact(100 + i, 1)) });
    const p = await plan({ source, target: org({}), options: { nodeCap: 4 } });
    assert.equal(p.nodes.length, 4);
    assert.equal(p.capped, true);
    assert.match(p.warnings.join('\n'), /cut off at 4 records/);
});

test('existence in the target is asked once per record', async () => {
    const source = org({
        account: [account(1)],
        contact: [contact(11, 1, { _cr1_languageid_value: id(50) }), contact(12, 1, { _cr1_languageid_value: id(50) })],
    });
    const target = org({ cr1_language: [{ cr1_languageid: id(50) }] });
    await plan({ source, target });
    assert.equal(target.org.calls.filter((c) => c.startsWith(`/cr1_languages(${id(50)})`)).length, 1);
});
