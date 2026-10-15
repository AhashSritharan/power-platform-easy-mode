// The mock tests' browser: the shared extension browser with every
// *.dynamics.com request — the page's own and the service worker's relayed
// ones — answered by fake orgs (fake-dataverse.js) instead of the network.
//
//   org        the org the page is on (contoso.crm4.dynamics.com)
//   targetOrg  a second org, for cross-environment tools (fabrikam.crm4.dynamics.com)
//
// Each test starts with fresh orgs and empty extension storage, and fails on
// any request a fake org had no answer for.
import { test as base, expect } from '../support/extension.js';
import { FakeOrg } from './fake-dataverse.js';

const DYNAMICS = /^https:\/\/[^/]+\.dynamics\.com\//;

export const test = base.extend({
    fakeOrgs: async ({ extensionContext, serviceWorker }, use) => {
        // Settings and remembered choices from the previous test must not leak in.
        await serviceWorker.evaluate(() => chrome.storage.local.clear());
        const orgs = new Map();
        const strays = [];
        const handler = (route) => {
            const host = new URL(route.request().url()).host;
            const org = orgs.get(host);
            if (org) return org.handle(route);
            strays.push(`${route.request().method()} ${route.request().url()}`);
            return route.fulfill({ status: 404, body: 'No fake org for this host' });
        };
        await extensionContext.route(DYNAMICS, handler);
        await use(orgs);
        await extensionContext.unroute(DYNAMICS, handler);
        expect(strays, 'requests to hosts with no fake org').toEqual([]);
        for (const org of orgs.values()) expect(org.unhandled, `requests ${org.host} had no answer for`).toEqual([]);
    },

    org: async ({ fakeOrgs }, use) => {
        const org = new FakeOrg('contoso.crm4.dynamics.com');
        fakeOrgs.set(org.host, org);
        await use(org);
    },

    /**
     * The maker portals as stub pages: portal.page(html) is what every page
     * on make.powerapps.com / make.powerautomate.com serves in this test —
     * the parts of the real portal a tool reads, copied from its DOM. The
     * portals' own API calls are not answered (404).
     */
    portal: async ({ extensionContext }, use) => {
        let html = '<!doctype html><html><head><title>Power Apps</title></head><body></body></html>';
        const PORTALS = /^https:\/\/make\.(powerapps|powerautomate)\.com\//;
        const handler = (route) => (route.request().resourceType() === 'document'
            ? route.fulfill({ contentType: 'text/html', body: html })
            : route.fulfill({ status: 404, body: '' }));
        await extensionContext.route(PORTALS, handler);
        await use({ page: (markup) => { html = markup; } });
        await extensionContext.unroute(PORTALS, handler);
    },

    targetOrg: async ({ fakeOrgs }, use) => {
        const org = new FakeOrg('fabrikam.crm4.dynamics.com');
        fakeOrgs.set(org.host, org);
        await use(org);
    },
});

/** Opens the fake org's main.aspx with `query` and waits until the toolbox is up. */
export async function gotoOrg(page, org, query = '') {
    await page.goto(`${org.origin}/main.aspx${query ? `?${query}` : ''}`);
    await expect(page.locator('.ppt-launcher')).toBeVisible();
}

export { expect };
