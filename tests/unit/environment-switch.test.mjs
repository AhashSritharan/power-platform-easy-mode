/**
 * Switching environment from the badge keeps you on the same page: the URL
 * the switch goes to (src/tools/shared/environment-switch.js), worked out
 * against two fake orgs. Every id in the URL is checked in the target, and
 * anything the target lacks falls back to the nearest page that exists there —
 * never to a "That page can't be found" or "Record Is Unavailable".
 *
 * The URL shapes are the ones the live portals and apps use (copied from a
 * real environment); what the orgs answer is shaped like a live org's reply.
 * Run: node --test tests/unit/environment-switch.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FakeOrg, guid } from '../e2e/mock/fake-dataverse.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { switchUrl } = await import(pathToFileURL(join(ROOT, 'extension/src/tools/shared/environment-switch.js')));

// A tenant's default environment carries "Default-" in its id: the source is one.
const SOURCE_ENV = `Default-${guid(11)}`;
const TARGET_ENV = guid(12);
const ACCOUNT = guid(70), INVOICE = guid(71), REGION = guid(72), TARGET_REGION = guid(82);
const SALES = guid(400), ONLY_HERE_SOLUTION = guid(401), TARGET_SALES = guid(500);
const SYNC = guid(600), NOTIFY = guid(601), ONLY_HERE_FLOW = guid(602), TARGET_NOTIFY = guid(700);
const APP = guid(100), ONLY_HERE_APP = guid(101), TARGET_APP = guid(200);
const SHARED_RECORD = guid(300), ONLY_HERE_RECORD = guid(301);
const MAIN_FORM = guid(1100), ONLY_HERE_FORM = guid(1101), ACTIVE_VIEW = guid(1200), ONLY_HERE_VIEW = guid(1201);

function orgs() {
    const source = new FakeOrg('contoso.crm4.dynamics.com');
    const target = new FakeOrg('fabrikam.crm4.dynamics.com');
    // A standard table has the same MetadataId everywhere; a custom one made
    // separately in each environment does not.
    source.entity({ logicalName: 'account', metadataId: ACCOUNT, rows: [{ accountid: SHARED_RECORD }, { accountid: ONLY_HERE_RECORD }] });
    target.entity({ logicalName: 'account', metadataId: ACCOUNT, rows: [{ accountid: SHARED_RECORD }] });
    source.entity({ logicalName: 'contoso_invoice', entitySetName: 'contoso_invoices', metadataId: INVOICE });
    source.entity({ logicalName: 'contoso_region', entitySetName: 'contoso_regions', metadataId: REGION });
    target.entity({ logicalName: 'contoso_region', entitySetName: 'contoso_regions', metadataId: TARGET_REGION });
    source.table('solutions', [
        { solutionid: SALES, uniquename: 'ContosoSales' },
        { solutionid: ONLY_HERE_SOLUTION, uniquename: 'OnlyHere' },
    ]);
    target.table('solutions', [{ solutionid: TARGET_SALES, uniquename: 'ContosoSales' }]);
    // A solution import keeps a flow's id; a flow rebuilt by hand gets a new one.
    source.table('workflows', [
        { workflowid: SYNC, name: 'Sync accounts' },
        { workflowid: NOTIFY, name: 'Notify approver' },
        { workflowid: ONLY_HERE_FLOW, name: 'Only here' },
    ]);
    target.table('workflows', [
        { workflowid: SYNC, name: 'Sync accounts' },
        { workflowid: TARGET_NOTIFY, name: 'Notify approver' },
    ]);
    source.table('appmodules', [
        { appmoduleid: APP, uniquename: 'contoso_Sales' },
        { appmoduleid: ONLY_HERE_APP, uniquename: 'contoso_OnlyHere' },
    ]);
    target.table('appmodules', [{ appmoduleid: TARGET_APP, uniquename: 'contoso_Sales' }]);
    // A solution import keeps a form's or view's id; one made in a single environment has none there.
    source.table('systemforms', [{ formid: MAIN_FORM, name: 'Account' }, { formid: ONLY_HERE_FORM, name: 'Information' }]);
    target.table('systemforms', [{ formid: MAIN_FORM, name: 'Account' }, { formid: guid(1102), name: 'Information' }]);
    source.table('savedqueries', [{ savedqueryid: ACTIVE_VIEW, name: 'Active Accounts' }, { savedqueryid: ONLY_HERE_VIEW, name: 'Key accounts' }]);
    target.table('savedqueries', [{ savedqueryid: ACTIVE_VIEW, name: 'Active Accounts' }]);
    source.table('webresourceset', [{ webresourceid: guid(800), name: 'contoso_/map.html' }]);
    target.table('webresourceset', [{ webresourceid: guid(900), name: 'contoso_/shared.html' }]);
    return { source, target };
}

/** Reads through a fake org as the extension's relay would: JSON, or null for 404. */
function reader(...list) {
    return async (host, path) => {
        const org = list.find((o) => o.host === host);
        if (!org) throw new Error(`no org at ${host}`);
        let fulfilled;
        await org.handle({
            request: () => ({ url: () => `${org.origin}/api/data/v9.2/${path}`, method: () => 'GET', postData: () => null, headers: () => ({}) }),
            fulfill: (response) => { fulfilled = response; },
        });
        if (fulfilled.status === 404) return null;
        if (fulfilled.status !== 200) throw new Error(`HTTP ${fulfilled.status} for ${path}`);
        return JSON.parse(fulfilled.body);
    };
}

async function switched(href, { known = true } = {}) {
    const { source, target } = orgs();
    const url = await switchUrl(href, {
        targetEnvId: TARGET_ENV,
        sourceHost: source.host,
        targetHost: known ? target.host : null,
        get: reader(source, target),
    });
    assert.deepEqual([...source.unhandled, ...target.unhandled], [], 'requests the fake orgs had no answer for');
    return url;
}

const POWERAPPS = `https://make.powerapps.com/environments/${SOURCE_ENV}`;
const POWERAUTOMATE = `https://make.powerautomate.com/environments/${SOURCE_ENV}`;
const TO_POWERAPPS = `https://make.powerapps.com/environments/${TARGET_ENV}`;
const TO_POWERAUTOMATE = `https://make.powerautomate.com/environments/${TARGET_ENV}`;
const SOURCE_APP = 'https://contoso.crm4.dynamics.com/main.aspx';
const TARGET_APP_PAGE = 'https://fabrikam.crm4.dynamics.com/main.aspx';

// ── Model-driven apps ────────────────────────────────────────────────────

test('a record the target has opens there, in the same app found by its unique name', async () => {
    assert.equal(
        await switched(`${SOURCE_APP}?appid=${APP}&pagetype=entityrecord&etn=account&id=${SHARED_RECORD}`),
        `${TARGET_APP_PAGE}?appid=${TARGET_APP}&pagetype=entityrecord&etn=account&id=${SHARED_RECORD}`);
});

test('a record the target lacks opens its table\'s list instead of "Record Is Unavailable"', async () => {
    assert.equal(
        await switched(`${SOURCE_APP}?appid=${APP}&pagetype=entityrecord&etn=account&id=${ONLY_HERE_RECORD}&formid=${guid(5)}`),
        `${TARGET_APP_PAGE}?appid=${TARGET_APP}&pagetype=entitylist&etn=account`);
    // The id as the app sometimes writes it, braces and capitals included.
    assert.equal(
        await switched(`${SOURCE_APP}?pagetype=entityrecord&etn=account&id=%7B${ONLY_HERE_RECORD.toUpperCase()}%7D`),
        `${TARGET_APP_PAGE}?pagetype=entitylist&etn=account`);
});

test('a new-record form and a list carry over as they are', async () => {
    const view = '00000000-0000-0000-00aa-000010001002';
    assert.equal(
        await switched(`${SOURCE_APP}?appid=${APP}&pagetype=entitylist&etn=account&viewid=${view}&viewType=1039`),
        `${TARGET_APP_PAGE}?appid=${TARGET_APP}&pagetype=entitylist&etn=account&viewid=${view}&viewType=1039`);
    assert.equal(
        await switched(`${SOURCE_APP}?appid=${APP}&pagetype=entityrecord&etn=account`),
        `${TARGET_APP_PAGE}?appid=${TARGET_APP}&pagetype=entityrecord&etn=account`);
});

test('a table the target lacks opens the app\'s home page instead of "Unknown Entity Name"', async () => {
    assert.equal(
        await switched(`${SOURCE_APP}?appid=${APP}&pagetype=entitylist&etn=contoso_invoice`),
        `${TARGET_APP_PAGE}?appid=${TARGET_APP}`);
    assert.equal(
        await switched(`${SOURCE_APP}?pagetype=entityrecord&etn=contoso_invoice&id=${guid(9)}`),
        TARGET_APP_PAGE);
});

test('an app the target lacks is left out rather than opened by an id it does not know', async () => {
    assert.equal(
        await switched(`${SOURCE_APP}?appid=${ONLY_HERE_APP}&pagetype=entitylist&etn=account`),
        `${TARGET_APP_PAGE}?pagetype=entitylist&etn=account`);
});

test('a web resource page opens only when the target has the web resource', async () => {
    assert.equal(
        await switched(`${SOURCE_APP}?appid=${APP}&pagetype=webresource&webresourceName=contoso_%2Fshared.html`),
        `${TARGET_APP_PAGE}?appid=${TARGET_APP}&pagetype=webresource&webresourceName=contoso_%2Fshared.html`);
    assert.equal(
        await switched(`${SOURCE_APP}?appid=${APP}&pagetype=webresource&webresourceName=contoso_%2Fmap.html`),
        `${TARGET_APP_PAGE}?appid=${TARGET_APP}`);
});

test('other pages of the app keep their path and query on the target host', async () => {
    assert.equal(
        await switched('https://contoso.crm4.dynamics.com/main.aspx?forceUCI=1&pagetype=apps'),
        'https://fabrikam.crm4.dynamics.com/main.aspx?forceUCI=1&pagetype=apps');
});

// ── make.powerapps.com ───────────────────────────────────────────────────

test('a solution is found by its unique name, a table by its id, and sub-pages come along', async () => {
    assert.equal(await switched(`${POWERAPPS}/solutions/${SALES}`), `${TO_POWERAPPS}/solutions/${TARGET_SALES}`);
    assert.equal(
        await switched(`${POWERAPPS}/solutions/${SALES}/entities/${ACCOUNT}/fields`),
        `${TO_POWERAPPS}/solutions/${TARGET_SALES}/entities/${ACCOUNT}/fields`);
});

test('a table created separately in each environment is found by its logical name', async () => {
    assert.equal(
        await switched(`${POWERAPPS}/solutions/${SALES}/entities/${REGION}/views`),
        `${TO_POWERAPPS}/solutions/${TARGET_SALES}/entities/${TARGET_REGION}/views`);
});

test('a component the target lacks stops the link at the solution, not at "That page can\'t be found"', async () => {
    assert.equal(
        await switched(`${POWERAPPS}/solutions/${SALES}/entities/${INVOICE}/forms`),
        `${TO_POWERAPPS}/solutions/${TARGET_SALES}`);
    assert.equal(
        await switched(`${POWERAPPS}/solutions/${SALES}/objects/cloudflows/${ONLY_HERE_FLOW}/view`),
        `${TO_POWERAPPS}/solutions/${TARGET_SALES}`);
});

test('a solution\'s cloud flow is found by its id, or by its name', async () => {
    assert.equal(
        await switched(`${POWERAPPS}/solutions/${SALES}/objects/cloudflows/${SYNC}/view`),
        `${TO_POWERAPPS}/solutions/${TARGET_SALES}/objects/cloudflows/${SYNC}/view`);
    assert.equal(
        await switched(`${POWERAPPS}/solutions/${SALES}/objects/cloudflows/${NOTIFY}/view`),
        `${TO_POWERAPPS}/solutions/${TARGET_SALES}/objects/cloudflows/${TARGET_NOTIFY}/view`);
});

test('a solution the target lacks opens the solution list', async () => {
    assert.equal(await switched(`${POWERAPPS}/solutions/${ONLY_HERE_SOLUTION}/entities/${ACCOUNT}`), `${TO_POWERAPPS}/solutions`);
});

test('a table outside a solution is resolved too, and a missing one opens the table list', async () => {
    assert.equal(await switched(`${POWERAPPS}/entities/${REGION}`), `${TO_POWERAPPS}/entities/${TARGET_REGION}`);
    assert.equal(await switched(`${POWERAPPS}/entities/${INVOICE}`), `${TO_POWERAPPS}/tables`);
});

test('pages without ids keep their path, query and hash', async () => {
    assert.equal(await switched(`${POWERAPPS}/tables?filter=custom#top`), `${TO_POWERAPPS}/tables?filter=custom#top`);
    // The portal itself lowercases "Default-" once it has loaded.
    assert.equal(await switched(`https://make.powerapps.com/environments/${SOURCE_ENV.toLowerCase()}/home`), `${TO_POWERAPPS}/home`);
});

test('the model-driven app designer opens the same app in the same solution', async () => {
    const designer = (env, solution, app) => `https://make.powerapps.com/e/${env}/s/${solution}/app/edit/${app}`;
    assert.equal(await switched(designer(SOURCE_ENV, SALES, APP)), designer(TARGET_ENV, TARGET_SALES, TARGET_APP));
    assert.equal(await switched(designer(SOURCE_ENV, SALES, ONLY_HERE_APP)), `${TO_POWERAPPS}/solutions/${TARGET_SALES}`);
    assert.equal(await switched(designer(SOURCE_ENV, ONLY_HERE_SOLUTION, APP)), `${TO_POWERAPPS}/solutions`);
});

// The URL shapes clicking a form or a view in a solution opens (live, 2026-10-29).
test('the form designer opens the same form, found by its id, in the same solution', async () => {
    const form = (env, solution, id) => `https://make.powerapps.com/e/${env}/s/${solution}/entity/account/form/edit/${id}?source=powerappsportal`;
    assert.equal(await switched(form(SOURCE_ENV, SALES, MAIN_FORM)), form(TARGET_ENV, TARGET_SALES, MAIN_FORM));
    // Form names repeat across tables, so a form the target lacks is never matched by name.
    assert.equal(await switched(form(SOURCE_ENV, SALES, ONLY_HERE_FORM)), `${TO_POWERAPPS}/solutions/${TARGET_SALES}`);
});

test('the view designer opens the same view, found by its id, in the same solution', async () => {
    const view = (env, solution, id) => `https://make.powerapps.com/e/${env}/s/${solution}/entity/account/view/${id}`;
    assert.equal(await switched(view(SOURCE_ENV, SALES, ACTIVE_VIEW)), view(TARGET_ENV, TARGET_SALES, ACTIVE_VIEW));
    assert.equal(await switched(view(SOURCE_ENV, SALES, ONLY_HERE_VIEW)), `${TO_POWERAPPS}/solutions/${TARGET_SALES}`);
});

// ── make.powerautomate.com ───────────────────────────────────────────────

test('a flow is found by its id, or by its name; a missing one opens the flow list', async () => {
    assert.equal(await switched(`${POWERAUTOMATE}/flows/${SYNC}/details`), `${TO_POWERAUTOMATE}/flows/${SYNC}/details`);
    assert.equal(await switched(`${POWERAUTOMATE}/flows/${NOTIFY}/details`), `${TO_POWERAUTOMATE}/flows/${TARGET_NOTIFY}/details`);
    assert.equal(await switched(`${POWERAUTOMATE}/flows/${ONLY_HERE_FLOW}/details`), `${TO_POWERAUTOMATE}/flows`);
});

test('a flow run never exists in another environment: the switch opens the flow\'s details and its runs', async () => {
    assert.equal(await switched(`${POWERAUTOMATE}/flows/${SYNC}/runs/${guid(42)}`), `${TO_POWERAUTOMATE}/flows/${SYNC}/details`);
    // A live run's name is no GUID.
    const RUN = '08584083461464206970916428111CU15';
    assert.equal(await switched(`${POWERAUTOMATE}/flows/${SYNC}/runs/${RUN}`), `${TO_POWERAUTOMATE}/flows/${SYNC}/details`);
    assert.equal(
        await switched(`${POWERAUTOMATE}/solutions/${SALES}/flows/${NOTIFY}/runs/${RUN}`),
        `${TO_POWERAUTOMATE}/solutions/${TARGET_SALES}/flows/${TARGET_NOTIFY}/details`);
});

test('solution flows in Power Automate resolve the solution as well', async () => {
    assert.equal(
        await switched(`${POWERAUTOMATE}/solutions/${SALES}/flows/${NOTIFY}/details`),
        `${TO_POWERAUTOMATE}/solutions/${TARGET_SALES}/flows/${TARGET_NOTIFY}/details`);
});

// ── Without the target's address ─────────────────────────────────────────

test('without the target\'s Dataverse address nothing can be checked: only the environment changes', async () => {
    assert.equal(
        await switched(`${POWERAPPS}/solutions/${SALES}/entities/${INVOICE}`, { known: false }),
        `${TO_POWERAPPS}/solutions/${SALES}/entities/${INVOICE}`);
    assert.equal(await switched(`${SOURCE_APP}?pagetype=entitylist&etn=account`, { known: false }), TO_POWERAPPS);
});

test('the canvas player swaps the environment in its path', async () => {
    assert.equal(
        await switched(`https://apps.powerapps.com/play/e/${SOURCE_ENV}/a/${guid(77)}?tenantId=${guid(78)}`),
        `https://apps.powerapps.com/play/e/${TARGET_ENV}/a/${guid(77)}?tenantId=${guid(78)}`);
});
