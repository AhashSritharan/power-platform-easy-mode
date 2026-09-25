// Page agent (MAIN world).
//
// Gives native tools narrowly-scoped, on-demand access to page context that
// the isolated world cannot reach. Two capabilities:
//   • temporarily intercepting the page's fetch/XHR responses whose URL matches
//     given substrings (used by Run Opener to capture action inputs/outputs the
//     flow portal loads when "Show raw inputs/outputs" is clicked);
//   • calling Xrm.Navigation.openForm (used by Field Editor to open the record
//     behind a lookup value).
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

    function installInterceptor(id, patterns) {
        const matches = (url) => patterns.some((pattern) => url.includes(pattern));
        const capture = (url, json) => post({ type: 'intercept-capture', id, url, json });

        const originalFetch = window.fetch;
        const originalOpen = window.XMLHttpRequest.prototype.open;
        const originalSend = window.XMLHttpRequest.prototype.send;

        window.fetch = async function (...args) {
            const response = await originalFetch.apply(this, args);
            const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? String(args[0] ?? ''));
            if (matches(url)) {
                try { capture(url, await response.clone().json()); }
                catch { /* non-JSON response */ }
            }
            return response;
        };

        window.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            this.__pptUrl = String(url);
            return originalOpen.apply(this, [method, url, ...rest]);
        };

        window.XMLHttpRequest.prototype.send = function (...args) {
            if (this.__pptUrl && matches(this.__pptUrl)) {
                const trackedUrl = this.__pptUrl;
                this.addEventListener('load', function () {
                    try { capture(trackedUrl, JSON.parse(this.responseText)); }
                    catch { /* non-JSON response */ }
                });
            }
            return originalSend.apply(this, args);
        };

        return function cleanup() {
            window.fetch = originalFetch;
            window.XMLHttpRequest.prototype.open = originalOpen;
            window.XMLHttpRequest.prototype.send = originalSend;
        };
    }
})();
