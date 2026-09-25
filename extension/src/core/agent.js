// Isolated-world client for the page agent (src/agent/page-agent.js).
//
// interceptNetwork(patterns) starts an on-demand fetch/XHR interception
// session in the page's MAIN world and returns a handle:
//   latest()                 — most recently captured JSON (or null)
//   clear()                  — forget the last capture
//   waitForCapture(timeout)  — poll until a capture arrives
//   stop()                   — restore the page's fetch/XHR and detach
//
// openRecordForm(entity, id) asks the page agent to call Xrm.Navigation.openForm
// and resolves { ok, error } — callers fall back to a URL when it is not ok.

const TO_PAGE = '__ppt-agent-to-page';
const TO_CONTENT = '__ppt-agent-to-content';

let nextId = 1;

export function interceptNetwork(patterns) {
    const id = nextId++;
    let latest = null;

    const listener = (event) => {
        if (event.source !== window || event.data?.__ppt_agent !== TO_CONTENT) return;
        if (event.data.type === 'intercept-capture' && event.data.id === id) {
            latest = event.data.json;
        }
    };
    window.addEventListener('message', listener);
    window.postMessage({ __ppt_agent: TO_PAGE, type: 'intercept-start', id, patterns }, window.location.origin);

    return {
        latest: () => latest,
        clear: () => { latest = null; },
        async waitForCapture(timeout = 5000, interval = 100) {
            const start = Date.now();
            while (Date.now() - start < timeout) {
                if (latest) return latest;
                await new Promise((resolve) => setTimeout(resolve, interval));
            }
            return null;
        },
        stop() {
            window.removeEventListener('message', listener);
            window.postMessage({ __ppt_agent: TO_PAGE, type: 'intercept-stop', id }, window.location.origin);
        },
    };
}

/**
 * Open a record via Xrm.Navigation.openForm in the page's MAIN world.
 * Resolves { ok: true } or { ok: false, error } — including on timeout, so a
 * page without the agent (or without Xrm) never leaves the caller hanging.
 */
export function openRecordForm(entityName, entityId, { newWindow = true, timeout = 4000 } = {}) {
    return new Promise((resolve) => {
        const id = nextId++;
        let timer = null;

        const finish = (result) => {
            clearTimeout(timer);
            window.removeEventListener('message', listener);
            resolve(result);
        };

        function listener(event) {
            if (event.source !== window || event.data?.__ppt_agent !== TO_CONTENT) return;
            if (event.data.type === 'open-form-result' && event.data.id === id) {
                finish({ ok: !!event.data.ok, error: event.data.error });
            }
        }

        window.addEventListener('message', listener);
        timer = setTimeout(() => finish({ ok: false, error: 'Page agent did not respond' }), timeout);
        window.postMessage(
            { __ppt_agent: TO_PAGE, type: 'open-form', id, entityName, entityId, newWindow },
            window.location.origin);
    });
}
