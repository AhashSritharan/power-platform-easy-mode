#!/usr/bin/env node
/**
 * Sends one Dataverse Web API request to the developer environment as the test
 * user and prints the response — to see what the real API returns before
 * writing code or mock data for it (CLAUDE.md → "Real behaviour, not
 * documentation").
 *
 *   node scripts/live-request.mjs GET 'solutions?$select=uniquename&$top=3'
 *   node scripts/live-request.mjs POST ExportSolutionAsync '{"SolutionName":"Core","Managed":false}'
 *   node scripts/live-request.mjs SOAP <file-with-envelope.xml>
 *
 * Paths are relative to /api/data/v9.2 (a leading "/" is optional; a full
 * "/api/data/v9.0/…" path picks another version). Leave the leading "/" off
 * in Git Bash: it rewrites arguments that start with one into Windows paths.
 *
 * Uses the session the live tests save (playwright/.auth/user.json — run
 * `npm run test:e2e` once to create it) and the org in playwright.env.json.
 * The output is real tenant data: copy shapes into mocks, never the values.
 */
import { chromium } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { AUTH_FILE, env, requireCrmUrl } from '../tests/e2e/support/env.js';

const [method = 'GET', rawPath, body] = process.argv.slice(2);
if (/^[A-Za-z]:[\/]/.test(rawPath ?? '') && method.toUpperCase() !== 'SOAP') {
    console.error(`"${rawPath}" is a Windows path — Git Bash rewrote the leading "/". Pass the path without it.`);
    process.exit(2);
}
const path = method.toUpperCase() === 'SOAP' || !rawPath || rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
if (!path) {
    console.error('usage: node scripts/live-request.mjs <GET|POST|PATCH|DELETE|SOAP> <path> [json-body | envelope-file]');
    process.exit(2);
}
const crmUrl = requireCrmUrl();
if (!existsSync(AUTH_FILE)) {
    console.error('No saved session — run `npm run test:e2e` once to sign in.');
    process.exit(2);
}

const browser = await chromium.launch({ channel: env.browser });
try {
    const context = await browser.newContext({ storageState: AUTH_FILE });
    const page = await context.newPage();
    await page.goto(`${crmUrl}/api/data/v9.2/`);
    const soap = method.toUpperCase() === 'SOAP';
    const result = await page.evaluate(async ({ method, path, body, soap, annotations }) => {
        const response = await fetch(soap ? '/XRMServices/2011/Organization.svc/web' : (path.startsWith('/api/') ? path : `/api/data/v9.2${path}`), {
            method: soap ? 'POST' : method,
            headers: soap
                ? { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'http://schemas.microsoft.com/xrm/2011/Contracts/Services/IOrganizationService/Execute' }
                : { Accept: 'application/json', 'Content-Type': 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', ...(annotations ? { Prefer: 'odata.include-annotations="*"' } : {}) },
            body: body ?? undefined,
        });
        return { status: response.status, text: await response.text() };
    }, { method: method.toUpperCase(), path, body: method.toUpperCase() === 'SOAP' ? readFileSync(path, 'utf8') : body, soap, annotations: !!process.env.ANNOTATIONS });
    console.log(`HTTP ${result.status}`);
    try { console.log(JSON.stringify(JSON.parse(result.text), null, 2)); } catch { console.log(result.text); }
    process.exitCode = result.status >= 400 ? 1 : 0;
} finally {
    await browser.close();
}
