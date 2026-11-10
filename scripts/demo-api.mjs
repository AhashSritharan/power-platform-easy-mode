#!/usr/bin/env node
// Scratch (not committed): Dataverse Web API calls against any org with the
// saved test session. A script file with a list of calls keeps one browser:
//   node scripts/demo-api.mjs <org-url> <calls.json>
// calls.json: [{ "method": "POST", "path": "accounts", "body": {...}, "headers": {...} }, ...]
// Prints each status and response (truncated).
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { AUTH_FILE } from '../tests/e2e/support/env.js';

const [orgUrl, callsFile] = process.argv.slice(2);
const calls = JSON.parse(readFileSync(callsFile, 'utf8'));
const browser = await chromium.launch();
const context = await browser.newContext({ storageState: AUTH_FILE });
const page = await context.newPage();
await page.goto(`${orgUrl}/api/data/v9.2/WhoAmI`);
await page.waitForURL((u) => u.origin === new URL(orgUrl).origin, { timeout: 90_000 });
const results = [];
for (const call of calls) {
    const out = await page.evaluate(async ({ method = 'GET', path, body, headers = {} }) => {
        const res = await fetch(`/api/data/v9.2/${path}`, {
            method,
            headers: { 'content-type': 'application/json', accept: 'application/json', 'OData-Version': '4.0', Prefer: 'return=representation', ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, text: await res.text() };
    }, call);
    console.log(call.method ?? 'GET', call.path, '→', out.status, out.text.slice(0, Number(process.env.MAX ?? 600)));
    results.push(out);
    if (out.status >= 400 && !call.optional) break;
}
await context.storageState({ path: AUTH_FILE });
await browser.close();
