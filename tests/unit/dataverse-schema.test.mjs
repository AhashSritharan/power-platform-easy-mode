/**
 * The Parse JSON Schema Builder's schema logic
 * (extension/src/tools/shared/dataverse-schema.js), against metadata shaped
 * like a live org's. What it must get right is what a live org returns:
 * lookups as _<name>_value with their annotations, null columns left out
 * entirely (so nothing may be "required"), and "@"-names escaped for pasting.
 * Run: node --test tests/unit/dataverse-schema.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const {
    parseExpand, parseSelect, MetadataCatalog, buildRecordSchema, wrapAsListBody, escapeLeadingAt, labelFor, expressionFor,
} = await import(pathToFileURL(join(ROOT, 'extension/src/tools/shared/dataverse-schema.js')));

const label = (text) => ({ LocalizedLabels: [{ Label: text, LanguageCode: 1033 }], UserLocalizedLabel: { Label: text, LanguageCode: 1033 } });
const attr = (LogicalName, AttributeType, text, AttributeOf = null) => ({ LogicalName, SchemaName: LogicalName, AttributeType, AttributeOf, DisplayName: label(text) });

const METADATA = {
    tables: [
        { LogicalName: 'account', EntitySetName: 'accounts', DisplayName: label('Account'), DisplayCollectionName: label('Accounts'), PrimaryIdAttribute: 'accountid', PrimaryNameAttribute: 'name' },
        { LogicalName: 'contact', EntitySetName: 'contacts', DisplayName: label('Contact'), DisplayCollectionName: label('Contacts'), PrimaryIdAttribute: 'contactid', PrimaryNameAttribute: 'fullname' },
    ],
    account: {
        Attributes: [
            attr('accountid', 'Uniqueidentifier', 'Account'), attr('name', 'String', 'Account Name'),
            attr('revenue', 'Money', 'Annual Revenue'), attr('revenue_base', 'Money', 'Annual Revenue (Base)', 'revenue'),
            attr('primarycontactid', 'Lookup', 'Primary Contact'), attr('primarycontactidname', 'String', '', 'primarycontactid'),
            attr('ownerid', 'Owner', 'Owner'), attr('statecode', 'State', 'Status'),
        ],
        OneToManyRelationships: [{ SchemaName: 'contact_customer_accounts', ReferencedEntityNavigationPropertyName: 'contact_customer_accounts', ReferencingEntity: 'contact' }],
        ManyToOneRelationships: [{ SchemaName: 'account_primary_contact', ReferencingEntityNavigationPropertyName: 'primarycontactid', ReferencedEntity: 'contact', ReferencingAttribute: 'primarycontactid' }],
        ManyToManyRelationships: [],
    },
    contact: {
        Attributes: [attr('contactid', 'Uniqueidentifier', 'Contact'), attr('fullname', 'String', 'Full Name'), attr('emailaddress1', 'String', 'Email')],
        OneToManyRelationships: [], ManyToOneRelationships: [], ManyToManyRelationships: [],
    },
};

/** A Dataverse client answering the catalog's metadata reads; counts them. */
function fakeDataverse() {
    const calls = [];
    return {
        calls,
        async get(path) {
            calls.push(path);
            if (path.startsWith('/EntityDefinitions?')) return { value: METADATA.tables };
            const m = path.match(/^\/EntityDefinitions\(LogicalName='(\w+)'\)\/(\w+)\?/);
            return { value: METADATA[m[1]][m[2]] };
        },
    };
}

test('$expand and $select parse the way List rows writes them', () => {
    assert.deepEqual(parseExpand("contact_customer_accounts($select=fullname,emailaddress1;$expand=parentcustomerid_account($select=name)),primarycontactid"), [
        { name: 'contact_customer_accounts', select: ['fullname', 'emailaddress1'], expand: [{ name: 'parentcustomerid_account', select: ['name'], expand: [] }] },
        { name: 'primarycontactid', select: null, expand: [] },
    ]);
    assert.deepEqual(parseSelect(' name , _ownerid_value '), ['name', '_ownerid_value']);
    assert.equal(parseSelect(''), null, 'blank means every column');
    assert.deepEqual(parseExpand(''), []);
});

test('a record schema as a live org returns the record: lookups, annotations, expansions, nothing required', async () => {
    const catalog = new MetadataCatalog(fakeDataverse());
    const { schema, table, warnings, fields } = await buildRecordSchema(catalog, {
        table: 'accounts', select: 'name,_primarycontactid_value,revenue,nosuchcolumn',
        expand: 'contact_customer_accounts($select=fullname),primarycontactid($select=emailaddress1),nosuchnav',
    });
    assert.equal(table.LogicalName, 'account');
    const p = schema.properties;
    assert.deepEqual(p.name, { type: ['string', 'null'] });
    assert.deepEqual(p.revenue, { type: ['number', 'null'] });
    assert.deepEqual(p['revenue@OData.Community.Display.V1.FormattedValue'], { type: ['string', 'null'] });
    // A lookup only ever comes back as _<name>_value, with three annotations.
    assert.equal('primarycontactid' in p, true, 'the expanded record, under its navigation property');
    assert.deepEqual(p._primarycontactid_value, { type: ['string', 'null'] });
    for (const suffix of ['@OData.Community.Display.V1.FormattedValue', '@Microsoft.Dynamics.CRM.lookuplogicalname', '@Microsoft.Dynamics.CRM.associatednavigationproperty']) {
        assert.ok(`_primarycontactid_value${suffix}` in p, suffix);
    }
    assert.equal(p.contact_customer_accounts.type, 'array');
    assert.deepEqual(Object.keys(p.contact_customer_accounts.items.properties), ['@odata.etag', 'fullname']);
    assert.deepEqual(Object.keys(p.primarycontactid.properties), ['@odata.etag', 'emailaddress1']);
    assert.deepEqual(p.nosuchnav, {}, 'an unknown expand accepts anything');
    assert.equal(JSON.stringify(schema).includes('"required"'), false, 'Dataverse leaves null columns out entirely');
    assert.deepEqual(warnings, [
        'Column "nosuchcolumn" was not found on account — left out of the schema.',
        'No relationship named "nosuchnav" on account — that property accepts anything in the schema.',
    ]);

    const byLabel = Object.fromEntries(fields.map((row) => [labelFor(row), row]));
    assert.equal(expressionFor(byLabel['Primary Contact (display value)'], "body('Parse_JSON')"),
        "body('Parse_JSON')?['_primarycontactid_value@OData.Community.Display.V1.FormattedValue']");
    assert.equal(expressionFor(byLabel['Primary Contact → Email'], "body('Parse_JSON')"), "body('Parse_JSON')?['primarycontactid']?['emailaddress1']");
    // Inside a collection the field is only reachable from a loop over it.
    assert.equal(expressionFor(byLabel['Full Name'], "body('Parse_JSON')"), "item()?['fullname']");
    assert.equal(byLabel['Full Name'].arrayLabel, 'Contacts');
});

test('every column when nothing is selected, and metadata is read once per table', async () => {
    const dv = fakeDataverse();
    const catalog = new MetadataCatalog(dv);
    const { schema } = await buildRecordSchema(catalog, { table: 'account' });
    assert.deepEqual(Object.keys(schema.properties).filter((k) => !k.includes('@')).sort(),
        ['_ownerid_value', '_primarycontactid_value', 'accountid', 'name', 'revenue', 'statecode'], 'companion columns (AttributeOf) are left out');
    await buildRecordSchema(catalog, { table: 'accounts', expand: 'primarycontactid' });
    assert.equal(dv.calls.filter((c) => c.startsWith("/EntityDefinitions(LogicalName='account')/Attributes")).length, 1);
    await assert.rejects(() => buildRecordSchema(catalog, { table: 'nosuchtable' }), /No table matches "nosuchtable"/);
});

test('ready to paste: the body wrapper, and leading "@" escaped as "@@"', () => {
    const record = { type: 'object', properties: { '@odata.etag': { type: ['string', 'null'] }, '_x_value@OData.Community.Display.V1.FormattedValue': { type: ['string', 'null'] } } };
    const pasted = escapeLeadingAt(wrapAsListBody(record));
    assert.deepEqual(Object.keys(pasted.properties), ['@@odata.context', 'value']);
    assert.deepEqual(Object.keys(pasted.properties.value.items.properties), ['@@odata.etag', '_x_value@OData.Community.Display.V1.FormattedValue']);
});
