// The README's screenshots: the real extension on the real Dynamics 365 and
// maker-portal pages of the developer environment (playwright.env.json), with
// Microsoft's sample data and the demo content in demo-data.js.
//
// Every name that identifies the tenant, an org or the test user is swapped
// for a placeholder right before each capture, and a capture is refused if
// one is still on the page (redact.js). Look at every image before committing
// it all the same.
//
//   npm run screenshots      → docs/screenshots/*.png
import { join } from 'node:path';
import { test, expect } from '../live/fixtures.js';
import { env, ROOT } from '../support/env.js';
import { gotoDynamics, openPalette, runCommand, settle } from '../support/helpers.js';
import { signIn } from '../support/sign-in.js';
import { ensureAccountWithContacts, ensureAuditTrail, ensureDemoData } from './demo-data.js';
import { Redactor } from './redact.js';

const OUT = join(ROOT, 'docs', 'screenshots');
const path = (name) => join(OUT, `${name}.png`);
const PLACEHOLDER_ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DEV_HOST = 'contoso-dev.crm4.dynamics.com';
const PROD_HOST = 'contoso.crm4.dynamics.com';

// One browser, in order: the first test learns what to redact, setup labels
// the environments the later ones show.
test.describe.configure({ mode: 'serial' });

const redact = new Redactor();
let demo;
let envId;

const json = (page, url) => page.evaluate(async (u) => (await fetch(u, { headers: { Accept: 'application/json' } })).json(), url);
const organization = (page) => json(page, "/api/data/v9.2/RetrieveCurrentOrganization(AccessType=Microsoft.Dynamics.CRM.EndpointAccessType'Default')").then((r) => r.Detail);

async function learnOrg(page, { name, host }, n) {
    const org = await organization(page);
    redact.add(org.FriendlyName, name).add(org.UniqueName, host.split('.')[0]).add(org.UrlName, host.split('.')[0])
        .add(org.EnvironmentId, PLACEHOLDER_ID(n)).add(org.OrganizationId, PLACEHOLDER_ID(n + 10)).add(org.TenantId, PLACEHOLDER_ID(99));
    return org;
}

/** Opens a maker-portal page, signing in again when the portal asks, and waits for the toolbox. */
async function gotoPortal(page, url) {
    await page.goto(url);
    const launcher = page.locator('.ppt-launcher');
    const portal = new URL(url).host;
    await page.waitForURL((u) => u.host === portal || u.host === 'login.microsoftonline.com', { timeout: 120_000 });
    // The portal may bounce through login.microsoftonline.com a moment after it loads.
    await page.waitForTimeout(3000);
    if (new URL(page.url()).host !== portal) await signIn(page, (u) => new URL(u).host === portal);
    await expect(launcher).toBeVisible({ timeout: 120_000 });
}

/** Toasts left over from loading say nothing about the tool. */
const closeToasts = (page) => page.locator('.ppt-toast').evaluateAll((els) => els.forEach((e) => e.remove())).catch(() => {});

test.describe('README screenshots', () => {
    test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1280, height: 800 }); });

    test('demo data, and what to redact', async ({ page }) => {
        test.setTimeout(10 * 60_000);
        redact.addHost(new URL(env.crmUrl).host, DEV_HOST);
        if (env.targetUrl) redact.addHost(new URL(env.targetUrl).host, PROD_HOST);
        if (env.userName) {
            redact.add(env.userName, 'jane.admin@contoso.com').add(env.userName.split('@')[0], 'jane.admin').add(env.userName.split('@')[1], 'contoso.com');
        }

        await gotoDynamics(page);
        envId = (await learnOrg(page, { name: 'Contoso Sales DEV', host: DEV_HOST }, 1)).EnvironmentId;
        const { UserId } = await json(page, '/api/data/v9.2/WhoAmI');
        const me = await json(page, `/api/data/v9.2/systemusers(${UserId})?$select=fullname,firstname,lastname,internalemailaddress,domainname`);
        redact.add(me.fullname, 'Jane Admin').add(me.internalemailaddress, 'jane.admin@contoso.com').add(me.domainname, 'jane.admin@contoso.com')
            .add(me.firstname, 'Jane').add(me.lastname, 'Admin')
            .addExact(`${me.firstname?.[0] ?? ''}${me.lastname?.[0] ?? ''}`.toUpperCase(), 'JA');
        // The model-driven app the tests open is the tenant's own; its name goes too.
        const app = new URL(page.url()).searchParams.get('appid');
        if (app) {
            const { name, uniquename } = await json(page, `/api/data/v9.2/appmodules(${app})?$select=name,uniquename`);
            redact.add(name, 'Sales').add(uniquename, 'contoso_sales');
        }
        demo = await ensureDemoData(page);
        demo.account = await ensureAccountWithContacts(page);

        if (env.targetUrl) {
            await page.goto(env.targetUrl);
            await page.waitForURL((url) => url.origin === env.targetUrl, { timeout: 120_000 });
            await learnOrg(page, { name: 'Contoso Sales', host: PROD_HOST }, 2);
        }
    });

    test('setup', async ({ page, extensionId, extensionContext }) => {
        // The portal signs in with its own redirects; once done here, the background tab discovery opens is signed in too.
        await gotoPortal(page, `https://make.powerapps.com/environments/${envId}/home`);
        await page.goto(`chrome-extension://${extensionId}/welcome/welcome.html`);
        await expect(page.locator('.tool').filter({ has: page.locator('.name', { hasText: 'Record Browser' }) })).toBeVisible();
        await page.setViewportSize({ width: 1280, height: 1000 });
        await redact.shot(page, page, { path: path('setup-tools') });

        await page.getByRole('button', { name: 'Next' }).click();
        await page.getByRole('button', { name: 'Find my environments' }).click();
        await expect(page.locator('#env-status')).toContainText('found', { timeout: 120_000 });
        await expect.poll(() => extensionContext.pages().filter((p) => p.url().includes('ppt-discover')).length).toBe(0);

        // Every environment found gets a placeholder name and host; this one
        // and the target get the labels the rest of the screenshots use.
        const rows = page.locator('.env-row');
        const others = ['Contoso Sales TEST', 'Contoso Marketing', 'Contoso Sandbox', 'Contoso Training', 'Contoso Archive'];
        for (let i = 0; i < await rows.count(); i++) {
            const row = rows.nth(i);
            const name = (await row.locator('.env-name').textContent()).trim();
            const host = (await row.locator('.env-host').textContent()).trim().split(/\s/)[0];
            if (host === new URL(env.crmUrl).host) await row.locator('select').selectOption('DEV');
            else if (env.targetUrl && host === new URL(env.targetUrl).host) await row.locator('select').selectOption('PROD');
            else if (/default/i.test(name)) redact.add(name, 'Contoso (default)').addHost(host, 'contoso-default.crm4.dynamics.com');
            else {
                const other = others.shift() ?? 'Contoso';
                redact.add(name, other).addHost(host, `${other.toLowerCase().replace(/\W+/g, '-')}.crm4.dynamics.com`);
                if (other === 'Contoso Sales TEST') await row.locator('select').selectOption('TEST');
            }
        }
        await redact.shot(page, page, { path: path('setup-environments'), fullPage: true });
        await page.getByRole('button', { name: 'Next' }).click();
        await expect(page.getByRole('heading', { name: /all set/i })).toBeVisible();
    });

    test('command palette and environment indicator', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 960 });
        await gotoDynamics(page, 'pagetype=entitylist&etn=contact');
        await page.waitForTimeout(3000); // the view's grid
        const badge = page.locator('body > div.ppt[data-env-type]');
        await expect(badge).toBeVisible();
        await redact.shot(page, page, { path: path('environment-badge'), clip: { x: 0, y: 0, width: 760, height: 140 } });

        await openPalette(page);
        await redact.shot(page, page, { path: path('palette') });
        await page.keyboard.press('Escape');

        await badge.click();
        const dialog = page.locator('.ppt-dialog', { hasText: 'Environment Indicator' });
        await expect(dialog.locator('.env-row').first()).toBeVisible();
        await redact.shot(page, dialog, { path: path('environment-indicator') });
    });

    test('record browser', async ({ page }) => {
        await gotoDynamics(page, 'pagetype=entitylist&etn=contact');
        await runCommand(page, 'Browse Records');
        const panel = page.locator('.rb-panel');
        await expect(panel.locator('.grid-status')).toContainText('records', { timeout: 60_000 });
        await settle(panel);
        await panel.getByLabel('Hide empty').check();
        await redact.shot(page, panel, { path: path('record-browser') });
    });

    test('record editor and audit history', async ({ page }) => {
        await gotoDynamics(page);
        const contact = await ensureAuditTrail(page, 'Maria Campbell (sample)');
        await gotoDynamics(page, `pagetype=entityrecord&etn=contact&id=${contact}`);

        await runCommand(page, 'Edit Record Values');
        const editor = page.locator('.fe-modal');
        await expect(editor.locator('.fe-record')).toContainText('Maria Campbell', { timeout: 60_000 });
        const row = (name) => editor.locator('.fe-tr').filter({ has: page.locator('.fe-logical', { hasText: new RegExp(`^${name}$`) }) });
        await row('jobtitle').locator('.fe-val.editable').click();
        await row('jobtitle').locator('.fe-edit input').fill('VP of Purchasing');
        await row('jobtitle').locator('.fe-edit input').press('Tab');
        await expect(editor.locator('.fe-pending')).toHaveText('1 pending change');
        await redact.shot(page, editor, { path: path('record-editor') });
        await editor.getByRole('button', { name: 'Close', exact: true }).click();
        await page.locator('.ppt-dialog').getByRole('button', { name: 'Discard' }).click();

        await runCommand(page, 'Open Audit History');
        const audit = page.locator('.audit-panel');
        await expect(audit.locator('tbody tr').first()).toBeVisible({ timeout: 60_000 });
        await redact.shot(page, audit, { path: path('audit-history') });
    });

    test('deep clone', async ({ page }) => {
        await gotoDynamics(page);
        await gotoDynamics(page, `pagetype=entityrecord&etn=account&id=${demo.account}`);
        await runCommand(page, 'Clone Record');
        const dialog = page.locator('.dc-modal');
        await dialog.locator('.dc-seg-item', { hasText: 'Deep Clone' }).click();
        const contacts = dialog.locator('.dc-rel', { hasText: 'contact_customer_accounts' });
        await expect(contacts.locator('.count')).toContainText('record', { timeout: 60_000 });
        await contacts.locator('input[type=checkbox]').check();
        await expect(dialog.getByText('Loading related records')).toHaveCount(0, { timeout: 60_000 });
        await redact.shot(page, dialog, { path: path('deep-clone') });
    });

    test('solution deployer and dependency check', async ({ page }) => {
        test.skip(!env.targetUrl, 'needs TARGET_URL');
        test.setTimeout(10 * 60_000);
        const open = async () => {
            await gotoDynamics(page);
            await runCommand(page, 'Open Solution Deployer');
            return page.locator('.sd-panel');
        };
        // The deployer reopens on the solution it had; pick one only when it has none.
        const pick = async (panel) => {
            const select = panel.getByRole('button', { name: /Select a solution/ });
            await expect(select.or(panel.getByText('Selected:')).first()).toBeVisible({ timeout: 60_000 });
            if (!await select.isVisible()) return;
            await select.click();
            await page.locator('.sd-modal .sd-item', { hasText: 'Contoso Sales' }).click();
        };
        const target = async (panel) => {
            const input = panel.getByPlaceholder('https://yourorg.crm.dynamics.com');
            await input.fill(env.targetUrl);
            await input.press('Tab');
        };

        let panel = await open();
        await pick(panel);
        await expect(panel.getByText('Selected:')).toBeVisible();
        await panel.getByRole('button', { name: 'Next: Choose Target →' }).click();
        await target(panel);
        await redact.shot(page, panel, { path: path('solution-deployer') });

        panel = await open();
        await panel.getByRole('button', { name: /Check Deps/ }).click();
        await pick(panel);
        await target(panel);
        await panel.locator('.sd-footer').getByRole('button', { name: /Check Dependencies/ }).click();
        await expect(panel.getByText(/missing dependenc(y|ies) found|No missing dependencies/)).toBeVisible({ timeout: 5 * 60_000 });
        await redact.shot(page, panel, { path: path('dependency-check') });
    });

    test('solution history', async ({ page }) => {
        await gotoDynamics(page);
        await runCommand(page, 'Open Solution History');
        const panel = page.locator('.sh-panel');
        await expect(panel.locator('.sim-table tbody tr').first()).toBeVisible({ timeout: 60_000 });
        await settle(panel);
        await redact.shot(page, panel, { path: path('solution-history') });
    });

    test('cloud flow manager and flow run monitor', async ({ page }) => {
        await gotoDynamics(page);
        await runCommand(page, 'Open Cloud Flow Manager');
        const flows = page.locator('.cfm-panel');
        await flows.locator('[data-f=solution]').selectOption(demo.solutionId);
        await flows.locator('[data-act=load]').click();
        await expect(flows.locator('tbody tr')).toHaveCount(6, { timeout: 60_000 });
        await closeToasts(page);
        await redact.shot(page, flows, { path: path('cloud-flow-manager') });

        await gotoDynamics(page);
        await runCommand(page, 'Open Flow Run Monitor');
        const runs = page.locator('.frm-panel');
        await expect(runs.locator('.frm-loading')).toHaveCount(0, { timeout: 60_000 });
        await expect(runs.locator('.frm-table tbody tr[data-runid]').first()).toBeVisible({ timeout: 60_000 });
        await redact.shot(page, runs, { path: path('flow-run-monitor') });
    });

    test('maker portal: turned-off highlighter and add existing', async ({ page }) => {
        await gotoPortal(page, `https://make.powerapps.com/environments/${envId}/solutions/${demo.solutionId}`);
        await expect(page.locator('.ppt-off-row').first()).toBeVisible({ timeout: 120_000 });
        await page.waitForTimeout(2000);
        await redact.shot(page, page, { path: path('turned-off-highlighter') });

        await runCommand(page, 'Add Existing Components (filterable)');
        const panel = page.locator('.grid-panel').last();
        await expect(panel.locator('.grid-status')).toContainText('loaded', { timeout: 120_000 });
        await panel.locator('tbody tr').nth(1).click();
        await panel.locator('tbody tr').nth(3).click();
        await redact.shot(page, panel, { path: path('add-existing') });
    });

    test('flow designer: find all references and expression validator', async ({ page }) => {
        await gotoPortal(page, `https://make.powerautomate.com/environments/${envId}/solutions/${demo.solutionId}/flows/${demo.flows['Invoice summary']}`);
        await expect(page.locator('.react-flow__node[data-id="Compose_total"]')).toBeVisible({ timeout: 120_000 });
        await expect(page.locator('.ppt-launcher')).toBeVisible();
        // The portal's cookie banner and the Copilot pane would cover the canvas; both are optional.
        await page.getByRole('button', { name: 'Reject' }).click({ timeout: 10_000 }).catch(() => {});
        await page.getByRole('button', { name: 'Close', exact: true }).click({ timeout: 10_000 }).catch(() => {});
        await page.locator('.react-flow__node[data-id="Compose_total"] [data-testid^="card-"]').click();
        await expect(page.locator('[data-automation-id="flow-node-details-panel"]')).toBeVisible();
        await page.keyboard.press('Shift+F12');
        const refs = page.locator('.fr-wrap');
        await expect(refs.locator('.fr-head .n')).toHaveText('▸ Compose_total', { timeout: 60_000 });
        await closeToasts(page);
        await redact.shot(page, page, { path: path('find-all-references') });
        await page.keyboard.press('Escape');

        await runCommand(page, 'Validate Flow Expressions');
        const results = page.locator('.ppt-dialog', { hasText: 'Expression Validation Results' });
        await expect(results.locator('h2')).toContainText('issue', { timeout: 60_000 });
        await redact.shot(page, results, { path: path('expression-validator') });
    });
});
