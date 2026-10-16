// Page agent (MAIN world).
//
// Gives native tools narrowly-scoped, on-demand access to page context that
// the isolated world cannot reach. Three capabilities:
//   • temporarily intercepting the page's fetch/XHR responses whose URL matches
//     given substrings (used by Run Page Actions to capture action inputs/outputs the
//     flow portal loads when "Show raw inputs/outputs" is clicked);
//   • calling Xrm.Navigation.openForm (used by Record Editor to open the record
//     behind a lookup value);
//   • handing over the maker portal's environment list once, on the portal tab
//     setup opens with ?ppt-discover=1 (see environment-discovery.js).
//
// Nothing is intercepted unless a tool starts a session, and everything is
// restored when the session stops. Data goes only to this extension's
// isolated world via postMessage; nothing leaves the page.
(() => {
    'use strict';
    if (window.__pptAgentLoaded) return;
    window.__pptAgentLoaded = true;

    const TO_PAGE = '__ppt-agent-to-page';
    const TO_CONTENT = '__ppt-agent-to-content';

    const post = (msg) => window.postMessage({ __ppt_agent: TO_CONTENT, ...msg }, window.location.origin);

    let session = null; // { id, cleanup }

    window.addEventListener('message', (event) => {
        if (event.source !== window || event.data?.__ppt_agent !== TO_PAGE) return;
        const msg = event.data;

        if (msg.type === 'intercept-start') {
            session?.cleanup();
            session = { id: msg.id, cleanup: installInterceptor(msg.id, msg.patterns ?? []) };
        } else if (msg.type === 'intercept-stop' && session?.id === msg.id) {
            session.cleanup();
            session = null;
        } else if (msg.type === 'open-form') {
            openForm(msg);
        } else if (msg.type === 'discover-get' && discovered) {
            post({ type: 'discover-result', json: discovered });
        }
    });

    // UCI puts Xrm on the top window; a form hosted in an iframe sees it there.
    const getXrm = () => {
        try { return window.Xrm ?? window.top?.Xrm ?? null; } catch { return window.Xrm ?? null; }
    };

    async function openForm({ id, entityName, entityId, newWindow }) {
        try {
            const navigation = getXrm()?.Navigation;
            if (!navigation?.openForm) throw new Error('Xrm.Navigation is not available on this page');
            await navigation.openForm({ entityName, entityId, openInNewWindow: !!newWindow });
            post({ type: 'open-form-result', id, ok: true });
        } catch (e) {
            post({ type: 'open-form-result', id, ok: false, error: e?.message ?? String(e) });
        }
    }

    function installInterceptor(id, patterns, capture = (url, json) => post({ type: 'intercept-capture', id, url, json })) {
        const matches = (url) => patterns.some((pattern) => url.includes(pattern));

        const originalFetch = window.fetch;
        const originalOpen = window.XMLHttpRequest.prototype.open;
        const originalSend = window.XMLHttpRequest.prototype.send;

        const patchedFetch = async function (...args) {
            const response = await originalFetch.apply(this, args);
            const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? String(args[0] ?? ''));
            if (matches(url)) {
                try { capture(url, await response.clone().json()); }
                catch { /* non-JSON response */ }
            }
            return response;
        };
        window.fetch = patchedFetch;

        const patchedOpen = function (method, url, ...rest) {
            this.__pptUrl = String(url);
            return originalOpen.apply(this, [method, url, ...rest]);
        };
        window.XMLHttpRequest.prototype.open = patchedOpen;

        const patchedSend = function (...args) {
            if (this.__pptUrl && matches(this.__pptUrl)) {
                const trackedUrl = this.__pptUrl;
                this.addEventListener('load', function () {
                    try { capture(trackedUrl, JSON.parse(this.responseText)); }
                    catch { /* non-JSON response */ }
                });
            }
            return originalSend.apply(this, args);
        };
        window.XMLHttpRequest.prototype.send = patchedSend;

        // Only undo our own patch: another session may have wrapped it since.
        return function cleanup() {
            if (window.fetch === patchedFetch) window.fetch = originalFetch;
            const proto = window.XMLHttpRequest.prototype;
            if (proto.open === patchedOpen) proto.open = originalOpen;
            if (proto.send === patchedSend) proto.send = originalSend;
        };
    }

    // ── Environment discovery ─────────────────────────────────────────────
    // Setup opens make.powerapps.com/?ppt-discover=1 in a tab of its own. The
    // portal loads its environment list with its own token; the first such
    // response is kept for the content script, then fetch/XHR are put back.
    // The param and URL part are DISCOVERY_PARAM and DISCOVERY_PATTERN in
    // src/tools/shared/environment-discovery.js — this script cannot import.
    let discovered = null;
    if (window.location.hostname === 'make.powerapps.com' && new URLSearchParams(window.location.search).has('ppt-discover')) {
        const stop = installInterceptor('discover', ['/powerapps/environments?'], (url, json) => {
            if (discovered || !Array.isArray(json?.value)) return;
            discovered = json;
            stop();
            post({ type: 'discover-result', json });
        });
    }
})();
