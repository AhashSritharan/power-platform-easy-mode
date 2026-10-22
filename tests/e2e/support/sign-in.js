// Microsoft's sign-in pages, answered for the test user (USER_NAME /
// USER_PASSWORD / TOTP): whichever screen is showing gets answered until
// `done(url)` says the browser is where it was going.
import { TOTP } from 'otpauth';
import { env } from './env.js';

export async function signIn(page, done) {
    const totp = new TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: env.totp });
    const deadline = Date.now() + 120_000;
    const visible = (selector) => page.locator(selector).first().isVisible().catch(() => false);
    let codeSent = false;

    while (Date.now() < deadline) {
        if (done(page.url())) return;
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
    throw new Error(`Sign-in did not finish — stuck on ${new URL(page.url()).host}`);
}
