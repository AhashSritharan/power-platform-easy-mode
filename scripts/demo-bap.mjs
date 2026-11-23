#!/usr/bin/env node
// Scratch (not committed): calls the Power Platform admin API (BAP) with the
// token the admin center gets for the saved test session.
//   node scripts/demo-bap.mjs GET 'locations?api-version=2020-08-01'
//   node scripts/demo-bap.mjs POST 'environments?api-version=2020-08-01' '{...}'
import { chromium } from '@playwright/test';
import { AUTH_FILE } from '../tests/e2e/support/env.js';

const [method = 'GET', path = 'environments?api-version=2020-08-01', body] = process.argv.slice(2);
const browser = await chromium.launch({ headless: !process.env.HEADED });
const context = await browser.newContext({ storageState: AUTH_FILE });
const page = await context.newPage();
const token = new Promise((resolve) => page.on('request', (r) => {
    const auth = r.headers().authorization;
    if (auth && r.url().includes('api.bap.microsoft.com')) resolve(auth);
}));
await page.goto('https://admin.powerplatform.microsoft.com/manage/environments');
let timer;
const auth = await Promise.race([token, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('no BAP token: ' + page.url())), 90_000); })])
    .finally(() => clearTimeout(timer)); // a pending timer would keep node alive for the full 90 s
const res = await fetch(`https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/${path}`, {
    method,
    headers: { authorization: auth, 'content-type': 'application/json' },
    body,
});
console.log(res.status, res.headers.get('location') ?? '');
const text = await res.text();
console.log(text.slice(0, 6000));
await context.storageState({ path: AUTH_FILE });
await browser.close();
