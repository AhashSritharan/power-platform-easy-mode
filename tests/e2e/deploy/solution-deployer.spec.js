// The Solution Deployer for real: a throwaway solution holding one web
// resource is created in the developer environment, deployed to TARGET_URL
// through the tool's UI, checked for missing dependencies, and cleaned up on
// the target — then everything it left behind is deleted in both orgs.
//
// Writes to two environments, which is why it lives apart from the read-only
// live tests. Skipped without TARGET_URL.
import { test, expect } from '../live/fixtures.js';
import { env } from '../support/env.js';
import { gotoDynamics, runCommand } from '../support/helpers.js';
import { queueStall } from '../support/async-queue.js';

test.skip(!env.targetUrl, 'TARGET_URL is not configured');
test.describe.configure({ mode: 'serial' });

const unique = `pptE2E${Date.now().toString(36)}`;
const CONTENT = Buffer.from(`// Power Platform Toolbox deploy test ${unique}\n`).toString('base64');
const solution = { uniquename: unique, friendlyname: `PPT E2E ${unique}` };
let webResourceName;

/** Runs `fn(api)` in a tab on `origin`, where api(method, path, body) calls its Web API. */
async function onOrg(context, origin, fn) {
    const page = await context.newPage();
    try {
        await page.goto(`${origin}/api/data/v9.2/`);
        const api = (method, path, body, headers = {}) => page.evaluate(async ({ method, path, body, headers }) => {
            const response = await fetch(`/api/data/v9.2${path}`, {
                method,
                headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'OData-Version': '4.0', 'OData-MaxVersion': '4.0', ...headers },
                body: body ? JSON.stringify(body) : undefined,
            });
            const text = await response.text();
            return { status: response.status, json: text ? JSON.parse(text) : null };
        }, { method, path, body, headers });
        return await fn(api);
    } finally {
        await page.close();
    }
}

const first = async (api, path) => (await api('GET', path)).json?.value?.[0] ?? null;

// Set when the deploy is skipped for a stalled queue: the tests after it need
// the solution on the target.
let queueStalled = null;
const QUEUE_LIMIT_MS = 5 * 60_000;

/** This run's export (source) or import (target) job that sat queued past the limit, if any. */
async function stalledDeployJob(context, since) {
    // A minute's margin for the runner's clock against the server's.
    const after = new Date(since - 60_000).toISOString();
    for (const [origin, name, where] of [[env.crmUrl, 'ExportSolution', 'source'], [env.targetUrl, 'ImportSolution', 'target']]) {
        const jobs = await onOrg(context, origin, async (api) => (await api('GET',
            `/asyncoperations?$select=name,createdon,startedon&$filter=name eq '${name}' and createdon ge ${after}`)).json?.value ?? []);
        const stall = queueStall(jobs, { limitMs: QUEUE_LIMIT_MS });
        if (stall) return `the ${where} environment left its ${name} job queued for ${Math.round(stall.waitMs / 60_000)} min`;
    }
    return null;
}

function skipForQueue(reason) {
    // Shown on the run's summary, so a skipped deploy is not mistaken for a pass.
    if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Deploy tests skipped::Dataverse's async queue stalled: ${reason}.`);
    test.skip(true, `Dataverse's async queue stalled: ${reason}`);
}

test.beforeAll(async ({ extensionContext }) => {
    await onOrg(extensionContext, env.crmUrl, async (api) => {
        // The org's default publisher is "DefaultPublisher" + its organization name.
        const orgName = (await first(api, '/organizations?$select=name')).name;
        const publisher = await first(api, `/publishers?$filter=uniquename eq 'DefaultPublisher${orgName}'&$select=publisherid,customizationprefix`);
        webResourceName = `${publisher.customizationprefix}_/pptE2E/${unique}.js`;
        const created = await api('POST', '/solutions', { ...solution, version: '1.0.0.0', 'publisherid@odata.bind': `/publishers(${publisher.publisherid})` });
        expect(created.status, 'create the solution').toBe(204);
        // Created inside the solution, through the header the platform offers for it.
        const resource = await api('POST', '/webresourceset', { name: webResourceName, displayname: unique, webresourcetype: 3, content: CONTENT },
            { 'MSCRM.SolutionUniqueName': unique });
        expect(resource.status, 'create the web resource').toBe(204);
    });
});

test.afterAll(async ({ extensionContext }) => {
    for (const origin of [env.targetUrl, env.crmUrl]) {
        await onOrg(extensionContext, origin, async (api) => {
            const sol = await first(api, `/solutions?$filter=uniquename eq '${unique}'&$select=solutionid`);
            if (sol) await api('DELETE', `/solutions(${sol.solutionid})`);
            const resource = await first(api, `/webresourceset?$filter=name eq '${webResourceName}'&$select=webresourceid`);
            if (resource) await api('DELETE', `/webresourceset(${resource.webresourceid})`);
        });
    }
});

async function openDeployer(page) {
    await gotoDynamics(page);
    await runCommand(page, 'Open Solution Deployer');
    const panel = page.locator('.sd-panel');
    await expect(panel).toBeVisible();
    return panel;
}

async function pickSolution(page, panel) {
    await panel.getByRole('button', { name: '📦 Select a solution…' }).click();
    const picker = page.locator('.sd-modal');
    await picker.getByPlaceholder('Filter solutions…').fill(unique);
    await picker.locator('.sd-item', { hasText: solution.friendlyname }).click();
}

async function setTarget(panel) {
    const input = panel.getByPlaceholder('https://yourorg.crm.dynamics.com');
    await input.fill(env.targetUrl);
    await input.press('Tab');
}

test('deploys a solution to the target environment', async ({ page, extensionContext }) => {
    test.setTimeout(10 * 60_000);
    const panel = await openDeployer(page);
    await pickSolution(page, panel);
    await panel.getByRole('button', { name: 'Next: Choose Target →' }).click();
    await setTarget(panel);
    await panel.locator('.sd-footer').getByRole('button', { name: '🚀 Deploy Now' }).click();
    const deployedAt = Date.now();
    await page.locator('.sd-modal', { hasText: 'Confirm Deployment' }).getByRole('button', { name: /Deploy/ }).click();

    try {
        await expect(panel).toContainText('✅ Deployment completed successfully!', { timeout: 8 * 60_000 });
    } catch (error) {
        // Only a queue that never ran the job excuses it; anything else is the tool's.
        queueStalled = await stalledDeployJob(extensionContext, deployedAt);
        if (queueStalled) skipForQueue(queueStalled);
        throw error;
    }
    await expect(panel).toContainText('No cloud flows in this solution.', { timeout: 60_000 });

    await onOrg(extensionContext, env.targetUrl, async (api) => {
        expect(await first(api, `/solutions?$filter=uniquename eq '${unique}'&$select=solutionid`), 'the solution on the target').not.toBeNull();
        const resource = await first(api, `/webresourceset?$filter=name eq '${webResourceName}'&$select=content`);
        expect(resource?.content, 'the web resource, byte for byte').toBe(CONTENT);
    });
});

test('finds no missing dependencies for it on the target', async ({ page }) => {
    if (queueStalled) skipForQueue(queueStalled);
    test.setTimeout(5 * 60_000);
    const panel = await openDeployer(page);
    await panel.getByRole('button', { name: '🔍 Check Deps' }).click();
    // The deploy remembered the solution; pick it again in case it did not.
    if (!await panel.getByText(solution.friendlyname).isVisible()) await pickSolution(page, panel);
    await setTarget(panel);
    await panel.locator('.sd-footer').getByRole('button', { name: '🔍 Check Dependencies' }).click();
    await expect(panel).toContainText('No missing dependencies!', { timeout: 4 * 60_000 });
});

test('cleans the solution up on the target, keeping its components', async ({ page, extensionContext }) => {
    if (queueStalled) skipForQueue(queueStalled);
    test.setTimeout(5 * 60_000);
    const panel = await openDeployer(page);
    await panel.getByRole('button', { name: '🧹 Cleanup' }).click();
    await setTarget(panel);
    const name = panel.getByPlaceholder('e.g. QuickDeploy_20260512');
    await name.fill(unique);
    await name.press('Tab');
    await panel.locator('.sd-footer').getByRole('button', { name: '🧹 Run Cleanup' }).click();
    await page.locator('.sd-modal').getByRole('button', { name: /Run Cleanup|Clean up/ }).click();
    await expect(panel).toContainText('✅ Cleanup completed! Solution deleted, customizations kept.', { timeout: 3 * 60_000 });

    await onOrg(extensionContext, env.targetUrl, async (api) => {
        expect(await first(api, `/solutions?$filter=uniquename eq '${unique}'&$select=solutionid`), 'the solution is gone').toBeNull();
        expect(await first(api, `/webresourceset?$filter=name eq '${webResourceName}'&$select=webresourceid`), 'its web resource stays').not.toBeNull();
    });
});
