/**
 * The mock browser tests' fake Dataverse (tests/e2e/mock/fake-dataverse.js):
 * if its OData reading is wrong, a tool test can pass against data no real org
 * would return.
 * Run: node --test tests/unit/fake-dataverse.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeOrg, guid, parseFilter, query } from '../e2e/mock/fake-dataverse.js';

const rows = [
    { solutionid: guid(1), uniquename: 'Core', ismanaged: false, isvisible: true, version: '1.0', _publisherid_value: guid(9) },
    { solutionid: guid(2), uniquename: "O'Brien", ismanaged: true, isvisible: true, version: '2.0' },
    { solutionid: guid(3), uniquename: 'Hidden', ismanaged: false, isvisible: false, version: '3.0' },
];
const where = (filter) => rows.filter(parseFilter(filter)).map((r) => r.uniquename);

test('$filter comparisons and logic', () => {
    assert.deepEqual(where('ismanaged eq false and isvisible eq true'), ['Core']);
    assert.deepEqual(where('ismanaged eq true or isvisible eq false'), ["O'Brien", 'Hidden']);
    assert.deepEqual(where("uniquename eq 'O''Brien'"), ["O'Brien"], 'doubled quotes');
    assert.deepEqual(where(`solutionid eq ${guid(3).toUpperCase()}`), ['Hidden'], 'guids compare case-insensitively');
    assert.deepEqual(where(`_publisherid_value eq '${guid(9)}'`), ['Core'], 'quoted guids too');
    assert.deepEqual(where('not (ismanaged eq true)'), ['Core', 'Hidden']);
    assert.deepEqual(where("(contains(uniquename,'or') or startswith(uniquename,'Hid')) and version ne '1.0'"), ['Hidden']);
    assert.deepEqual(where('version ge \'2.0\''), ["O'Brien", 'Hidden']);
});

test('$filter date-times and property paths', () => {
    const audits = [
        { auditid: guid(1), createdon: '2026-10-01T09:00:00Z', meta: { Value: true } },
        { auditid: guid(2), createdon: '2026-10-09T09:00:00Z', meta: { Value: false } },
    ];
    assert.deepEqual(audits.filter(parseFilter('createdon ge 2026-10-08T00:00:00Z and createdon le 2026-10-15T23:59:59Z')).map((a) => a.auditid), [guid(2)]);
    assert.deepEqual(audits.filter(parseFilter('meta/Value eq true')).map((a) => a.auditid), [guid(1)]);
});

test('$filter refuses what it does not understand', () => {
    assert.throws(() => parseFilter('uniquename like \'x\''), /unknown operator/);
    assert.throws(() => parseFilter('(ismanaged eq true'), /expected close/);
});

test('$select keeps the annotations of the columns it selects', () => {
    const row = { auditid: guid(1), _userid_value: guid(2), '_userid_value@OData.Community.Display.V1.FormattedValue': 'Jane', other: 1, 'other@x': 2 };
    assert.deepEqual(query([row], new URLSearchParams('$select=_userid_value')), [
        { _userid_value: guid(2), '_userid_value@OData.Community.Display.V1.FormattedValue': 'Jane', auditid: guid(1) },
    ]);
});

test('$select keeps keys, $orderby and $top apply', () => {
    const out = query(rows, new URLSearchParams('$select=uniquename&$orderby=version desc&$top=2'));
    assert.deepEqual(out, [
        { uniquename: 'Hidden', solutionid: guid(3) },
        { uniquename: "O'Brien", solutionid: guid(2) },
    ]);
});

/** Sends a request through org.handle as Playwright would, returning { status, body, headers }. */
async function send(org, method, path, body, headers = {}) {
    let fulfilled;
    await org.handle({
        request: () => ({
            url: () => (path.startsWith('http') ? path : `${org.origin}/api/data/v9.2${path}`),
            method: () => method,
            postData: () => (body == null ? null : typeof body === 'string' ? body : JSON.stringify(body)),
            headers: () => headers,
        }),
        fulfill: (response) => { fulfilled = response; },
    });
    return fulfilled;
}

/** A $batch body exactly as core/batch.js writes one. */
async function batchBody(org, build) {
    globalThis.chrome ??= { runtime: { id: 'test' } };
    globalThis.location ??= { href: `${org.origin}/main.aspx`, origin: org.origin };
    const { ChangeSet } = await import('../../extension/src/core/batch.js');
    const set = new ChangeSet();
    build(set);
    const CRLF = '\r\n';
    return [`--batch_x`, 'Content-Type: multipart/mixed; boundary=changeset_y', '', set.render(`${org.origin}/api/data/v9.2`, 'changeset_y')].join(CRLF)
        + `${CRLF}--batch_x--${CRLF}`;
}

test('$batch: operations run in order, $N references resolve, ids are kept', async () => {
    const org = new FakeOrg('contoso.crm4.dynamics.com');
    org.table('accounts', []);
    org.table('contacts', []);
    const body = await batchBody(org, (set) => {
        const account = set.create('accounts', { accountid: guid(5), name: 'Fabrikam' });
        set.create('contacts', { lastname: 'Doe', 'parentcustomerid_account@odata.bind': account });
        set.update('accounts', account, { name: 'Fabrikam Ltd' });
    });
    const response = await send(org, 'POST', '/$batch', body);
    assert.equal(response.status, 200);
    assert.match(response.contentType, /^multipart\/mixed; boundary=batchresponse_/);
    assert.equal((response.body.match(/HTTP\/1\.1 204 No Content/g) ?? []).length, 3);
    assert.match(response.body, new RegExp(`OData-EntityId: ${org.origin}/api/data/v9.2/accounts\\(${guid(5)}\\)`));
    assert.deepEqual(org.tables.accounts, [{ accountid: guid(5), name: 'Fabrikam Ltd' }], 'the update reached the record $1 created');
    assert.deepEqual(org.calls('PATCH', `/accounts(${guid(5)})`).map((c) => c.body), [{ name: 'Fabrikam Ltd' }]);
});

test('$batch: one failure rolls everything back and answers 400 with that part', async () => {
    const org = new FakeOrg('contoso.crm4.dynamics.com');
    org.table('accounts', []);
    org.on('POST', '/contacts', () => ({ status: 400, json: { error: { code: '0x80048d19', message: "Invalid property 'nosuchcolumn' was found." } } }));
    const body = await batchBody(org, (set) => {
        set.create('accounts', { name: 'Fabrikam' });
        set.create('contacts', { nosuchcolumn: 1 });
    });
    const response = await send(org, 'POST', '/$batch', body);
    assert.equal(response.status, 400);
    assert.match(response.body, /Content-ID: 2\r\n\r\nHTTP\/1\.1 400 Bad Request/);
    assert.equal((response.body.match(/^HTTP\/1\.1/gm) ?? []).length, 1, 'only the failing part');
    assert.deepEqual(org.tables.accounts, [], 'rolled back');
});

test('entity reads, writes and the unhandled list', async () => {
    const org = new FakeOrg('contoso.crm4.dynamics.com');
    org.table('solutions', structuredClone(rows));
    const run = async (method, path, body) => {
        let fulfilled;
        const route = {
            request: () => ({
                url: () => `${org.origin}/api/data/v9.2${path}`,
                method: () => method,
                postData: () => (body ? JSON.stringify(body) : null),
                headers: () => ({}),
            }),
            fulfill: (response) => { fulfilled = response; },
        };
        await org.handle(route);
        return { status: fulfilled.status, json: fulfilled.body ? JSON.parse(fulfilled.body) : null };
    };

    assert.equal((await run('GET', `/solutions(${guid(1)})?$select=version`)).json.version, '1.0');
    assert.equal((await run('GET', `/solutions(${guid(7)})`)).status, 404);
    assert.equal((await run('DELETE', `/solutions(${guid(2)})`)).status, 204);
    assert.equal(org.tables.solutions.length, 2);
    assert.equal((await run('POST', '/Nonexistent', { a: 1 })).status, 501);
    assert.deepEqual(org.unhandled, ['POST /Nonexistent']);

    org.on('POST', '/ExportSolutionAsync', (req) => ({ got: req.body.SolutionName }));
    assert.equal((await run('POST', '/ExportSolutionAsync', { SolutionName: 'Core' })).json.got, 'Core');
    assert.equal(org.calls('POST', '/ExportSolutionAsync').length, 1);
    assert.equal(org.calls('GET', /^\/solutions\(/).length, 2);
});

// A table's metadata is also read by its MetadataId, and a missing id answers
// as a live org does: 404 with 0x80060888, not the row error 0x80040217.
test('entity metadata by MetadataId', async () => {
    const org = new FakeOrg('contoso.crm4.dynamics.com');
    org.entity({ logicalName: 'account', metadataId: guid(70) });
    const byId = await send(org, 'GET', `/EntityDefinitions(${guid(70)})?$select=LogicalName`);
    assert.equal(byId.status, 200);
    assert.equal(JSON.parse(byId.body).LogicalName, 'account');
    const byName = await send(org, 'GET', "/EntityDefinitions(LogicalName='account')?$select=MetadataId");
    assert.equal(JSON.parse(byName.body).MetadataId, guid(70));
    const missing = await send(org, 'GET', `/EntityDefinitions(${guid(71)})?$select=MetadataId`);
    assert.equal(missing.status, 404);
    assert.equal(JSON.parse(missing.body).error.code, '0x80060888');
    assert.deepEqual(org.unhandled, []);
});
