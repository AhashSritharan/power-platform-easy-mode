// Service worker for Power Platform Toolbox.
//
// Responsibilities:
//   1. Proxy cross-origin requests via fetch, restricted to a fixed allowlist
//      of first-party hosts (tools call this through src/core/http.js).
//   2. Open/close helper tabs on behalf of tools.
//   3. Relay the command-palette keyboard shortcut to the active tab.
//   4. Show the welcome page on first install.
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
