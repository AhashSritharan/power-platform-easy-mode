// HTTP helper for tool modules (isolated world).
//
// Same-origin requests go straight through fetch (the user's existing session
// cookies apply). Cross-origin requests are relayed to the service worker,
// which enforces a fixed first-party host allowlist — tools cannot reach
// arbitrary hosts even by accident.

import { RELOAD_HINT, isContextInvalidatedError, isExtensionAlive, noteInvalidated } from './lifecycle.js';

export class HttpError extends Error {
    constructor(status, statusText, body) {
        super(`HTTP ${status}${statusText ? ` ${statusText}` : ''}`);
        this.status = status;
        this.body = body;
    }
}

/**
 * What to tell the user about a failed request: Dataverse's own message from
 * an HttpError's body ({ error: { message } }) — the reason, where "HTTP 400"
 * alone says nothing — or the error's own text.
 */
export function errorMessage(e) {
    try { return JSON.parse(e.body)?.error?.message || e.message; } catch { return e.message; }
}

/**
 * request({ url, method, headers, body, credentials }) → { status, statusText, text, json() }
 * Throws HttpError for non-2xx responses and Error for network failures.
 */
export async function request({ url, method = 'GET', headers = {}, body = null, credentials = false }) {
    const target = new URL(url, location.href);

    let status, statusText, text;
    if (target.origin === location.origin) {
        const response = await fetch(target.href, {
            method,
            headers,
            body: body ?? undefined,
            credentials: credentials ? 'include' : 'same-origin',
        });
        ({ status, statusText } = response);
        text = await response.text();
    } else {
        // The relay needs a live service worker; without it the request cannot
        // happen at all, so this one surfaces as an error the caller can show.
        if (!isExtensionAlive()) {
            noteInvalidated();
            throw new Error(RELOAD_HINT);
        }
        let result;
        try {
            result = await chrome.runtime.sendMessage({
                type: 'xhr',
                request: { method, url: target.href, headers, data: body, withCredentials: credentials },
            });
        } catch (e) {
            if (!isContextInvalidatedError(e)) throw e;
            noteInvalidated();
            throw new Error(RELOAD_HINT);
        }
        if (!result?.ok) throw new Error(result?.error ?? 'Network error');
        ({ status, statusText, responseText: text } = result.response);
    }

    if (status < 200 || status >= 300) throw new HttpError(status, statusText, text);
    return { status, statusText, text, json: () => (text ? JSON.parse(text) : null) };
}
