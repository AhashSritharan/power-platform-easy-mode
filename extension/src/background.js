// Service worker for Power Platform Toolbox.
//
// Responsibilities:
//   1. Proxy cross-origin requests via fetch, restricted to a fixed allowlist
//      of first-party hosts (tools call this through src/core/http.js).
//   2. Open/close helper tabs on behalf of tools, incl. a background tab that
//      signs in to a Dynamics org so the proxy has a session to send.
//   3. Relay the command-palette keyboard shortcut to the active tab.
//   4. Show the welcome page — and with it setup — on first install.
//   5. For setup: open the maker portal in a tab of its own to pick up the
//      environments the user can access, then close it again.
//
// There is deliberately NO analytics, telemetry, or remote code here. The only
// network requests are the ones tools make to the sites they integrate with.

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
    }
});

// ── Command palette keyboard shortcut ────────────────────────────────────

chrome.commands?.onCommand.addListener(async (command) => {
    if (command !== 'open-palette') return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'open-palette' }).catch(() => { /* unsupported page */ });
});

// ── Cross-origin request proxy ───────────────────────────────────────────
//
// Only these hosts can be reached — the same first-party services the tools
// integrate with. Anything else is rejected before a request is made.
const ALLOWED_HOSTS = [
    /(^|\.)dynamics\.com$/,      // Dataverse / Dynamics 365 orgs (incl. cross-environment)
    /(^|\.)powerapps\.com$/,     // Power Apps maker & player portals
    /(^|\.)powerautomate\.com$/, // Power Automate maker portal
    /(^|\.)atlassian\.net$/,     // Jira Cloud
    /^api\.clockify\.me$/,       // Clockify REST API
];

function isAllowedUrl(rawUrl) {
    let url;
    try { url = new URL(rawUrl); } catch { return false; }
    return url.protocol === 'https:' && ALLOWED_HOSTS.some((re) => re.test(url.hostname));
}

// Chrome may suspend an idle service worker; a pending fetch alone does not
// always reset the idle timer, so ping a trivial API while requests are live.
let inflight = 0;
let keepAliveTimer = null;

function trackFetch(promise) {
    if (++inflight === 1) {
        keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
    }
    return promise.finally(() => {
        if (--inflight === 0) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
    });
}

async function proxyFetch(request) {
    if (!isAllowedUrl(request.url)) {
        return { ok: false, error: `Blocked request to non-allowlisted URL: ${request.url}` };
    }

    const controller = new AbortController();
    const timeout = request.timeout > 0
        ? setTimeout(() => controller.abort('timeout'), request.timeout)
        : null;

    try {
        const response = await trackFetch(fetch(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.data ?? undefined,
            credentials: request.withCredentials ? 'include' : 'omit',
            signal: controller.signal,
        }));
        const responseText = await response.text();
        const headerLines = [];
        response.headers.forEach((value, name) => headerLines.push(`${name}: ${value}`));
        return {
            ok: true,
            response: {
                status: response.status,
                statusText: response.statusText,
                responseText,
                response: responseText,
                responseHeaders: headerLines.join('\r\n'),
                finalUrl: response.url,
            },
        };
    } catch (e) {
        const timedOut = controller.signal.aborted && controller.signal.reason === 'timeout';
        return { ok: false, timedOut, error: e?.message ?? 'Network error' };
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

// ── Dynamics session warm-up ─────────────────────────────────────────────
//
// The maker portals sign in to Dataverse with bearer tokens, so a browser can
// be signed in to make.powerapps.com without any Dynamics session cookie —
// and the proxy above, which relies on those cookies, then gets 401. Loading
// the org's app shell once lets SSO set the cookie. It is opened in a
// background tab and closed again once it lands back on the org after the
// sign-in redirects.
const WARM_TIMEOUT_MS = 30_000;

async function warmSession(origin) {
    if (!isAllowedUrl(origin) || !/\.dynamics\.com$/i.test(new URL(origin).hostname)) return { ok: false, error: 'blocked' };
    const host = new URL(origin).hostname;
    const tab = await chrome.tabs.create({ url: `${origin}/main.aspx`, active: false });
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, WARM_TIMEOUT_MS);
            const cleanup = () => {
                clearTimeout(timer);
                chrome.tabs.onUpdated.removeListener(onUpdated);
                chrome.tabs.onRemoved.removeListener(onRemoved);
            };
            function onUpdated(tabId, change, updated) {
                if (tabId !== tab.id || change.status !== 'complete') return;
                let landed = '';
                try { landed = new URL(updated.url ?? '').hostname; } catch { /* not readable yet */ }
                if (landed === host) { cleanup(); resolve(); }
            }
            function onRemoved(tabId) {
                if (tabId === tab.id) { cleanup(); reject(new Error('closed')); }
            }
            chrome.tabs.onUpdated.addListener(onUpdated);
            chrome.tabs.onRemoved.addListener(onRemoved);
        });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    } finally {
        chrome.tabs.remove(tab.id).catch(() => { /* already closed */ });
    }
}

// ── Environment discovery (setup) ────────────────────────────────────────
//
// The maker portal lists the user's environments with its own token, which the
// extension never holds. Setup asks for that list: the portal is opened in a
// background tab with ?ppt-discover=1, its page agent hands the list to the
// content script (src/core/agent.js), and that sends it here. When nothing
// arrives for a while the portal is probably asking the user to sign in, so
// the tab comes to the front; once the list is in, it closes and the setup tab
// is shown again.
const DISCOVERY_URL = 'https://make.powerapps.com/?ppt-discover=1';
const DISCOVERY_FOREGROUND_MS = 15_000;
const DISCOVERY_TIMEOUT_MS = 5 * 60_000;
const discoveries = new Map(); // portal tab id -> (response) => void

async function discoverEnvironments(openerTabId) {
    const tab = await chrome.tabs.create({ url: DISCOVERY_URL, active: false });
    let foreground = false;
    return trackFetch(new Promise((resolve) => {
        const finish = (result) => {
            clearTimeout(foregroundTimer);
            clearTimeout(timeoutTimer);
            chrome.tabs.onRemoved.removeListener(onRemoved);
            discoveries.delete(tab.id);
            resolve(result);
        };
        function onRemoved(tabId) {
            if (tabId === tab.id) finish({ ok: false, error: 'The maker portal tab was closed before it listed your environments.' });
        }
        const foregroundTimer = setTimeout(() => {
            foreground = true;
            chrome.tabs.update(tab.id, { active: true }).catch(() => { /* closed */ });
        }, DISCOVERY_FOREGROUND_MS);
        const timeoutTimer = setTimeout(() => {
            finish({ ok: false, error: 'The maker portal did not list your environments in time.' });
            chrome.tabs.remove(tab.id).catch(() => { /* closed */ });
        }, DISCOVERY_TIMEOUT_MS);
        chrome.tabs.onRemoved.addListener(onRemoved);
        discoveries.set(tab.id, (response) => {
            finish({ ok: true, response });
            chrome.tabs.remove(tab.id).catch(() => { /* closed */ });
            if (foreground && openerTabId != null) chrome.tabs.update(openerTabId, { active: true }).catch(() => { /* closed */ });
        });
    }));
}

// ── Messages from content scripts ────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
        case 'xhr':
            proxyFetch(msg.request).then(sendResponse);
            return true; // async response

        case 'open-tab':
            if (!isAllowedUrl(msg.url)) { sendResponse({ error: 'blocked' }); return false; }
            chrome.tabs.create({ url: msg.url, active: msg.active, index: sender.tab ? sender.tab.index + 1 : undefined })
                .then((tab) => sendResponse({ tabId: tab.id }));
            return true;

        case 'warm-session':
            warmSession(msg.origin).then(sendResponse);
            return true;

        case 'discover-environments':
            discoverEnvironments(sender.tab?.id).then(sendResponse);
            return true;

        // Only the portal tab discovery opened may answer it.
        case 'environments-discovered':
            discoveries.get(sender.tab?.id)?.(msg.response);
            sendResponse({ ok: true });
            return false;

        case 'close-tab':
            chrome.tabs.remove(msg.tabId).catch(() => { /* already closed */ });
            sendResponse({ ok: true });
            return false;

        // A content script cannot see its own tab id, but the sender can.
        case 'whoami':
            sendResponse({ tabId: sender.tab?.id ?? null });
            return false;
    }
    return false;
});
