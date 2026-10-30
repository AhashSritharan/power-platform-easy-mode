// The Dataverse org the current page is about.
//
// On a Dynamics page that is the page's own origin. On the maker portals
// (make.powerapps.com, make.powerautomate.com) the environment id is in the
// URL but the org host is not, and every request is relayed through the
// service worker with the user's own Dynamics session cookies, which carries
// it past CORS. Two things can be missing there, and both are filled in here:
//
//   • The org URL. Known from an earlier visit (the Environment Indicator's
//     host cache, or a URL given before); otherwise read off the page itself —
//     the portal calls its org's Web API, so the host is in the page's own
//     resource timings, next to the hosts of other environments it lists.
//     Each candidate is asked for its environment id and the one matching the
//     URL wins. Only when that fails is the user asked to type it.
//   • A session. The portals authenticate with bearer tokens, so a user can be
//     signed in there without ever having opened Dynamics, and the relay gets
//     401. With the user's go-ahead the org is opened once in a background tab
//     (see warmSession in background.js) so SSO can set the cookie.
//
// Resolved per open rather than once at init: the maker portals are single-page
// apps, and switching environment there never reloads the content script.

import { Dataverse } from '../../core/dataverse.js';
import { envIdFromUrl, getSite } from '../../core/context.js';
import { HttpError, request } from '../../core/http.js';
import { callExtension } from '../../core/lifecycle.js';
import * as ui from '../../core/ui.js';
import { knownOrgUrl, rememberOrgUrl, resolveOrgUrl } from './flow-source.js';

const UNAUTHORIZED = 'unauthorized';

/**
 * { dv, origin, host } for the org this page belongs to, or null when there is
 * none (no environment in the URL, or the user declined a prompt).
 * `purpose` finishes the prompts' sentences: "… so <purpose>".
 */
export async function resolveCurrentOrg({ purpose } = {}) {
    if (getSite() === 'dynamics') {
        return { dv: new Dataverse(), origin: location.origin, host: location.host };
    }
    const envId = envIdFromUrl();
    if (!envId) {
        ui.toast('Open an environment first — this tool works on the environment in the URL.');
        return null;
    }

    const orgUrl = await knownOrgUrl(envId)
        ?? await detectOrgUrl(envId, purpose)
        ?? await resolveOrgUrl(envId, { purpose });
    if (!orgUrl) return null;
    const { origin, host } = new URL(orgUrl);

    if (await probeEnvId(origin) === UNAUTHORIZED) {
        if (!await askToSignIn([host], purpose) || !await signIn(origin)) return null;
        if (await probeEnvId(origin) === UNAUTHORIZED) {
            ui.toast(`⚠️ Still not signed in to ${host} — open it once in Dynamics 365, then try again.`, 6000);
            return null;
        }
    }
    return { dv: new Dataverse(origin), origin, host };
}

/**
 * The environment id an org reports, UNAUTHORIZED without a session there,
 * or null when it cannot be reached at all.
 */
async function probeEnvId(origin) {
    try {
        const response = await request({
            url: `${origin}/api/data/v9.2/RetrieveCurrentOrganization(AccessType='Default')`,
            headers: { 'Accept': 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' },
            credentials: true,
        });
        return String(response.json()?.Detail?.EnvironmentId ?? '').toLowerCase() || null;
    } catch (e) {
        if (e instanceof HttpError && (e.status === 401 || e.status === 403)) return UNAUTHORIZED;
        return null;
    }
}

/** Org hosts the page has talked to — an org's Web API host ("<org>.api.crm4…") counts as the org ("<org>.crm4…"). */
export function candidateHosts(urls) {
    const hosts = new Set();
    for (const url of urls) {
        let host;
        try { host = new URL(url).hostname.toLowerCase(); } catch { continue; }
        const match = host.match(/^([a-z0-9-]+)\.(?:api\.)?(crm\d*\.dynamics\.com)$/);
        if (match) hosts.add(`${match[1]}.${match[2]}`);
    }
    return [...hosts];
}

// The portal reaches its org a second or so after the page loads, so a tool
// opened straight away may find no host yet; give the page that long.
const FIRST_HOST_WAIT_MS = 4000;

function waitForCandidateHosts(timeout) {
    return new Promise((resolve) => {
        let observer = null;
        const timer = setTimeout(() => { observer?.disconnect(); resolve([]); }, timeout);
        try {
            observer = new PerformanceObserver((list) => {
                const hosts = candidateHosts(list.getEntries().map((entry) => entry.name));
                if (!hosts.length) return;
                clearTimeout(timer);
                observer.disconnect();
                resolve(hosts);
            });
            observer.observe({ type: 'resource' });
        } catch {
            clearTimeout(timer);
            resolve([]);
        }
    });
}

async function detectOrgUrl(envId, purpose) {
    const seenHosts = () => candidateHosts(performance.getEntriesByType('resource').map((entry) => entry.name));
    let hosts = seenHosts();
    // Once the first host shows up, take everything the page has reached by then.
    if (!hosts.length && (await waitForCandidateHosts(FIRST_HOST_WAIT_MS)).length) hosts = seenHosts();
    if (!hosts.length) return null;

    const match = async (candidates) => {
        const results = await Promise.all(candidates.map(async (host) => [host, await probeEnvId(`https://${host}`)]));
        const found = results.find(([, id]) => id === envId)?.[0];
        if (found) await rememberOrgUrl(envId, `https://${found}`);
        return { found, locked: results.filter(([, id]) => id === UNAUTHORIZED).map(([host]) => host) };
    };

    let { found, locked } = await match(hosts);
    if (found) return `https://${found}`;
    if (!locked.length || !await askToSignIn(locked, purpose)) return null;

    // One sign-in usually covers a whole region (*.crm4.dynamics.com shares
    // its cookie), so sign in one host at a time and re-check them all.
    for (const host of locked) {
        if (!await signIn(`https://${host}`)) continue;
        ({ found, locked } = await match(locked));
        if (found) return `https://${found}`;
        if (!locked.length) break;
    }
    return null;
}

async function signIn(origin) {
    ui.toast(`🔐 Signing in to ${new URL(origin).host}…`, 30000);
    const result = await callExtension(() => chrome.runtime.sendMessage({ type: 'warm-session', origin }), null);
    ui.toast(result?.ok ? '✅ Signed in' : `⚠️ Could not sign in to ${new URL(origin).host} automatically — open it once in Dynamics 365.`, result?.ok ? 2000 : 6000);
    return !!result?.ok;
}

function askToSignIn(hosts, purpose) {
    return new Promise((resolve) => {
        let answer = false;
        ui.panel({
            title: '🔐 Sign in to Dynamics 365',
            width: 460,
            render: (body) => body.append(
                ui.el('div', {
                    className: 'ppt-note',
                    textContent: `This browser has no Dynamics 365 session for this environment yet, which Easy Mode needs so ${purpose ?? 'it can read it'}. `
                        + 'Signing in opens it briefly in a background tab and closes it again.',
                }),
                ui.el('div', { className: 'ppt-note', style: 'margin-top:8px', textContent: hosts.join(', ') }),
            ),
            buttons: [
                { label: 'Cancel', onClick: (close) => close() },
                { label: 'Sign in', primary: true, onClick: (close) => { answer = true; close(); } },
            ],
            onClose: () => resolve(answer),
        });
    });
}
