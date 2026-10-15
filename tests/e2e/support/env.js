// Where the end-to-end tests run, and as whom.
//
// Read from the ENV_VAR_JSON environment variable (a GitHub Actions secret) or,
// locally, from playwright.env.json in the repo root. Both hold the same JSON —
// see playwright.env.example.json. The real values name a tenant, an org and a
// user, so playwright.env.json is gitignored and never committed.
//
//   CRM_URL        the developer environment, e.g. https://contoso.crm4.dynamics.com
//   USER_NAME      } a test user with an authenticator-app MFA method. All three
//   USER_PASSWORD  } are needed for unattended sign-in (CI); leave them out
//   TOTP           } locally to sign in by hand in the browser window instead.
//   TARGET_URL     a second environment the deploy tests deploy to (optional;
//                  without it they are skipped)
//   TABLE          table for the record tools (default: account)
//   APP_ID         model-driven app to open (default: the org's default app)
//   BROWSER        chromium (default) | msedge | chrome. Playwright's own Chromium
//                  starts signed out; Edge signs in with the Windows account.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const AUTH_FILE = join(ROOT, 'playwright', '.auth', 'user.json');
const ENV_FILE = join(ROOT, 'playwright.env.json');

function read() {
    if (process.env.ENV_VAR_JSON) return JSON.parse(process.env.ENV_VAR_JSON);
    if (existsSync(ENV_FILE)) return JSON.parse(readFileSync(ENV_FILE, 'utf8'));
    return {};
}

const raw = read();

export const env = {
    crmUrl: raw.CRM_URL ? new URL(raw.CRM_URL).origin : '',
    targetUrl: raw.TARGET_URL ? new URL(raw.TARGET_URL).origin : '',
    userName: raw.USER_NAME ?? '',
    password: raw.USER_PASSWORD ?? '',
    totp: raw.TOTP ?? '',
    table: raw.TABLE || 'account',
    appId: raw.APP_ID || '',
    browser: raw.BROWSER || 'chromium',
};

export const hasCredentials = !!(env.userName && env.password && env.totp);

export function requireCrmUrl() {
    if (!env.crmUrl) {
        throw new Error('No CRM_URL configured. Copy playwright.env.example.json to playwright.env.json '
            + 'and fill in your developer environment (or set the ENV_VAR_JSON secret in CI).');
    }
    return env.crmUrl;
}
