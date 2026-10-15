// Page-level steps shared by the specs: getting to the right Dynamics page,
// the palette, and waiting for a tool's panel to finish loading.
import { expect } from '@playwright/test';
import { TOOLS, isToolEnabled } from '../../../extension/src/registry.js';
import { env } from './env.js';

// Tools that work silently on the page and register no command.
const NO_COMMANDS = new Set(['off-status-highlighter']);

const globToRegExp = (glob) => new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

/** The tools that should be active on `url` with default settings. */
export function expectedTools(url) {
    return TOOLS.filter((tool) => isToolEnabled(tool.id) && !NO_COMMANDS.has(tool.id)
        && tool.matches.some((m) => globToRegExp(m).test(url)));
}

/** The commands the content script on `page` serves to the popup. */
export async function pageCommands(serviceWorker, page) {
    await page.bringToFront();
    return serviceWorker.evaluate(async (url) => {
        const all = await chrome.tabs.query({});
        const tab = all.find((t) => t.url === url) ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
        return (await chrome.tabs.sendMessage(tab.id, { type: 'get-page-state' })).commands;
    }, page.url());
}

// ── Dynamics 365 ──────────────────────────────────────────────────────────
let appIdQuery = null;

/** Opens main.aspx with `query` and waits until the toolbox is up. */
export async function gotoDynamics(page, query = '') {
    if (appIdQuery === null) appIdQuery = await resolveAppQuery(page);
    await page.goto(`${env.crmUrl}/main.aspx?${[appIdQuery, query].filter(Boolean).join('&')}`);
    await expect(page.locator('.ppt-launcher'), 'the toolbox launcher on main.aspx').toBeVisible({ timeout: 90_000 });
}

// main.aspx without an app id opens the org's default app — where there is
// one. Otherwise pick an app, and say so: APP_ID makes the choice explicit.
async function resolveAppQuery(page) {
    if (env.appId) return `appid=${env.appId}`;
    await page.goto(`${env.crmUrl}/main.aspx?pagetype=entitylist&etn=${env.table}`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    if (page.url().includes('/main.aspx')) return '';
    const apps = await page.evaluate(async () => {
        const res = await fetch('/api/data/v9.2/appmodules?$select=appmoduleid,name,uniquename&$orderby=name');
        return (await res.json()).value ?? [];
    });
    const app = apps.find((a) => !a.uniquename.startsWith('msdyn_')) ?? apps[0];
    if (!app) throw new Error('The org has no model-driven app to open — set APP_ID in playwright.env.json.');
    console.log(`  No default app — using "${app.name}". Set APP_ID in playwright.env.json to pick another.`);
    return `appid=${app.appmoduleid}`;
}

let recordCache = null;

/** The first record of the configured table: { table, id }. */
export async function firstRecord(page) {
    recordCache ??= await page.evaluate(async (table) => {
        const json = async (path) => {
            const res = await fetch(`/api/data/v9.2/${path}`, { headers: { Accept: 'application/json' } });
            if (!res.ok) throw new Error(`${res.status} ${path}`);
            return res.json();
        };
        const meta = await json(`EntityDefinitions(LogicalName='${table}')?$select=EntitySetName,PrimaryIdAttribute`);
        const rows = await json(`${meta.EntitySetName}?$select=${meta.PrimaryIdAttribute}&$top=1`);
        return { table, id: rows.value[0]?.[meta.PrimaryIdAttribute] ?? null };
    }, env.table);
    if (!recordCache.id) throw new Error(`Table ${env.table} has no records — set TABLE in playwright.env.json to one that has.`);
    return recordCache;
}

/** The org's environment id, for the maker-portal URLs. */
export function environmentId(page) {
    return page.evaluate(async () => {
        const res = await fetch("/api/data/v9.2/RetrieveCurrentOrganization(AccessType=Microsoft.Dynamics.CRM.EndpointAccessType'Default')");
        return (await res.json()).Detail.EnvironmentId;
    });
}

// ── Palette ───────────────────────────────────────────────────────────────
export async function openPalette(page) {
    await page.locator('.ppt-launcher .icon').click();
    const palette = page.locator('.ppt-dialog').filter({ has: page.locator('.ppt-palette-list') });
    await expect(palette).toBeVisible();
    return palette;
}

/** Every command title in the open palette, cards and rows alike. */
export async function paletteTitles(palette) {
    const cards = await palette.locator('.ppt-palette-card').evaluateAll((els) => els.map((e) => e.title.split('\n')[0]));
    const rows = await palette.locator('.ppt-palette-item .title').allTextContents();
    return [...cards, ...rows];
}

/** Runs a command from the palette by its exact title. */
export async function runCommand(page, title) {
    const palette = await openPalette(page);
    const cards = palette.locator('.ppt-palette-card');
    const index = await cards.evaluateAll((els, t) => els.findIndex((e) => e.title.split('\n')[0] === t), title);
    expect(index, `palette command "${title}"`).toBeGreaterThanOrEqual(0);
    await cards.nth(index).click();
    await expect(palette).toBeHidden();
}

// ── Panels ────────────────────────────────────────────────────────────────
// Error states the tools render, across tools.
const ERROR_SELECTOR = '.sd-err-box, .dc-error, .fe-msg.error, .frm-error-msg, .rt-error';
const ERROR_TEXT = /\b(Failed to|Error loading|Could not load)\b/;

/** Waits until nothing in `panel` is spinning any more. */
export async function settle(panel, timeout = 60_000) {
    await expect(panel.locator('[class*="spinner"]').filter({ visible: true }), 'panel still loading').toHaveCount(0, { timeout });
}

export async function expectNoErrorShown(panel) {
    await expect(panel.locator(ERROR_SELECTOR).filter({ visible: true }), 'error shown in the panel').toHaveCount(0);
    expect(await panel.innerText()).not.toMatch(ERROR_TEXT);
}

/** settle + expectNoErrorShown */
export async function expectLoaded(panel, timeout) {
    await expect(panel).toBeVisible();
    await settle(panel, timeout);
    await expectNoErrorShown(panel);
}
