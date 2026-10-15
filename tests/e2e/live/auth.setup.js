// Signs in to the developer environment once and saves the session to
// playwright/.auth/user.json (gitignored) for the tests to reuse.
//
// A saved session that still opens the org is kept as it is. Otherwise:
//   • with USER_NAME / USER_PASSWORD / TOTP — signs in unattended (CI);
//   • without them, locally — opens a browser window and waits for you to sign
//     in by hand (or for single sign-on to do it).
import { test as setup, chromium } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TOTP } from 'otpauth';
import { AUTH_FILE, env, hasCredentials, requireCrmUrl } from '../support/env.js';

const MANUAL_SIGN_IN_TIMEOUT = 5 * 60_000;

const onOrg = (url, origin = env.crmUrl) => new URL(url).origin === origin;

/**
 * The deploy tests' target org, signed in through the same session: single
 * sign-on answers it from the login cookies, and its own cookies are then
 * saved alongside the main org's.
 */
async function signInToTarget(page) {
    if (!env.targetUrl) return true;
    await page.goto(env.targetUrl);
    await page.waitForURL((url) => onOrg(url.href, env.targetUrl), { timeout: 60_000 });
    return page.evaluate(async () => (await fetch('/api/data/v9.2/WhoAmI')).ok);
}

setup('authenticate', async () => {
    setup.setTimeout(MANUAL_SIGN_IN_TIMEOUT + 60_000);
    const crmUrl = requireCrmUrl();
    mkdirSync(dirname(AUTH_FILE), { recursive: true });

    if (existsSync(AUTH_FILE) && await sessionStillWorks(crmUrl)) return;

    if (!hasCredentials && process.env.CI) {
        throw new Error('The saved session is missing or expired, and USER_NAME / USER_PASSWORD / TOTP are not set.');
    }

    await withBrowser({ headless: hasCredentials && !!process.env.CI }, async (context, page) => {
        await page.goto(crmUrl);
        if (hasCredentials) await signIn(page);
        else {
            console.log(`\n  Sign in to ${crmUrl} in the browser window — waiting up to 5 minutes…\n`);
        }
        await page.waitForURL((url) => onOrg(url.href), { timeout: hasCredentials ? 120_000 : MANUAL_SIGN_IN_TIMEOUT });
        if (!await signInToTarget(page)) throw new Error(`Signed in, but ${env.targetUrl} (TARGET_URL) does not answer — is the test user a member of it?`);
        await context.storageState({ path: AUTH_FILE });
    });
});

// A throwaway profile rather than browser.newContext(): Edge closes the
// incognito-style window of a new context the moment it reaches the org.
async function withBrowser({ headless, storageState }, run) {
    const profileDir = mkdtempSync(join(tmpdir(), 'ppt-e2e-auth-'));
    // Sandboxed locally (Edge warns without it); CI's container runs as root,
    // where Chromium cannot sandbox.
    const context = await chromium.launchPersistentContext(profileDir, { channel: env.browser, headless, chromiumSandbox: !process.env.CI });
    try {
        if (storageState) await context.addCookies(JSON.parse(readFileSync(storageState, 'utf8')).cookies);
        return await run(context, context.pages()[0] ?? await context.newPage());
    } finally {
        await context.close();
        rmSync(profileDir, { recursive: true, force: true });
    }
}

async function sessionStillWorks(crmUrl) {
    try {
        return await withBrowser({ headless: true, storageState: AUTH_FILE }, async (context, page) => {
            await page.goto(crmUrl);
            // An expired session is sent to login.microsoftonline.com.
            await page.waitForURL((url) => onOrg(url.href), { timeout: 20_000 });
            // The org's own API must answer too — cookies for the login page
            // alone can bounce back to the org once and then fail.
            const ok = await page.evaluate(async () => (await fetch('/api/data/v9.2/WhoAmI')).ok)
                && await signInToTarget(page);
            if (ok) await context.storageState({ path: AUTH_FILE });
            return ok;
        });
    } catch {
        return false;
    }
}

// Microsoft's sign-in pages, step by step: whichever screen is showing gets
// answered until the browser is back on the org.
async function signIn(page) {
    const totp = new TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: env.totp });
    const deadline = Date.now() + 120_000;
    const visible = (selector) => page.locator(selector).first().isVisible().catch(() => false);
    let codeSent = false;

    while (Date.now() < deadline) {
        if (onOrg(page.url())) return;
        if (await visible('#otherTile')) {
            // "Pick an account": Edge offers the account connected to Windows —
            // never that one, always the test user.
            await page.click('#otherTile');
        } else if (await visible('input[type=email][name=loginfmt]')) {
            await page.fill('input[type=email][name=loginfmt]', env.userName);
            await page.click('input[type=submit]');
        } else if (await visible('input[type=password][name=passwd]')) {
            await page.fill('input[type=password][name=passwd]', env.password);
            await page.click('input[type=submit]');
        } else if (await visible('input[name=otc]')) {
            if (!codeSent) {
                await page.fill('input[name=otc]', totp.generate());
                await page.click('input[type=submit]');
                codeSent = true;
            }
        } else if (await visible('[data-value=PhoneAppOTP]')) {
            // "Verify your identity": pick the authenticator code.
            await page.click('[data-value=PhoneAppOTP]');
        } else if (await visible('#KmsiCheckboxField, #idBtn_Back')) {
            // "Stay signed in?" — No.
            await page.click('#idBtn_Back');
        }
        await page.waitForTimeout(750);
    }
    throw new Error(`Sign-in did not reach ${env.crmUrl} — stuck on ${page.url()}`);
}
