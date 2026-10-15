// The live tests' browser: the shared extension browser, signed in with the
// session auth.setup.js saved.
import { readFileSync } from 'node:fs';
import { test as base, expect } from '../support/extension.js';
import { AUTH_FILE } from '../support/env.js';

export const test = base.extend({
    extensionContext: [async ({ extensionContext }, use) => {
        const { cookies } = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
        await extensionContext.addCookies(cookies);
        await use(extensionContext);
    }, { scope: 'worker' }],
});

export { expect };
