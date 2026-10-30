// Orphaned content scripts.
//
// When the extension is reloaded, updated or disabled, the copies already
// injected into open tabs keep running — but their bridge to the extension is
// gone. Every chrome.* call from then on throws "Extension context
// invalidated". Nothing in that tab can be repaired; only a page reload brings
// the toolbox back. So instead of spraying unhandled rejections into the page
// (and into the extension's error list), chrome.* access is funnelled through
// here: it fails soft and tells the user once.

const listeners = new Set();
let announced = false;

export const RELOAD_HINT =
    'Power Platform Easy Mode was reloaded or updated — reload the page to keep using it.';

/** False once this content script has been orphaned by an extension reload. */
export function isExtensionAlive() {
    // chrome.runtime.id is undefined in an invalidated context; touching
    // chrome at all can throw there, hence the try.
    try {
        return Boolean(chrome.runtime?.id);
    } catch {
        return false;
    }
}

export function isContextInvalidatedError(error) {
    return /Extension context invalidated|Extension context was invalidated/i.test(error?.message ?? '');
}

/** Run cb once when this tab's extension context dies. Returns unsubscribe. */
export function onExtensionInvalidated(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

/** Records the death of this context; notifies listeners exactly once. */
export function noteInvalidated() {
    if (announced) return;
    announced = true;
    console.warn(`[Power Platform Easy Mode] ${RELOAD_HINT}`);
    for (const cb of listeners) {
        try { cb(); } catch { /* a broken listener must not mask the shutdown */ }
    }
}

/**
 * Calls fn, but yields `fallback` instead of throwing when the extension
 * context is gone. Real errors from fn still propagate.
 */
export async function callExtension(fn, fallback) {
    if (!isExtensionAlive()) {
        noteInvalidated();
        return fallback;
    }
    try {
        return await fn();
    } catch (e) {
        if (!isContextInvalidatedError(e)) throw e;
        noteInvalidated();
        return fallback;
    }
}
