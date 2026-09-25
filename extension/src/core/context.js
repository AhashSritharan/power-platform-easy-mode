// Page-context helpers: what kind of page is this, and does a tool's match
// list apply here?

export function getSite() {
    const host = location.hostname.toLowerCase();
    if (host.endsWith('.dynamics.com')) return 'dynamics';
    if (host === 'make.powerautomate.com' || host.endsWith('.make.powerautomate.com')) return 'powerautomate-maker';
    if (host === 'make.powerapps.com' || host.endsWith('.make.powerapps.com')) return 'powerapps-maker';
    if (host.endsWith('.powerapps.com')) return 'powerapps-player';
    if (host.endsWith('.atlassian.net')) return 'jira';
    return null;
}

/** Chrome-style match pattern → RegExp (scheme://host/path with * wildcards). */
function patternToRegex(pattern) {
    const [, scheme, host, path] = pattern.match(/^(\*|https?):\/\/([^/]+)(\/.*)$/) ?? [];
    if (!host) return /$^/;
    const schemeRe = scheme === '*' ? 'https?' : scheme;
    const hostRe = host === '*'
        ? '[^/]+'
        : host.replace(/[.]/g, '\\.').replace(/^\*\\\./, '([^/]+\\.)?');
    const pathRe = path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`);
}

export function urlMatches(patterns, url = location.href) {
    return patterns.some((pattern) => patternToRegex(pattern).test(url));
}

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * An environment id as it appears in a URL path.
 *
 * Not every environment id is a bare GUID: a tenant's default environment is
 * "Default-<tenant guid>", which a GUID-only pattern skips entirely — so the
 * indicator would not recognise the page and a switch would not rewrite it.
 */
export const ENV_ID = new RegExp(`(?:Default-)?${GUID.source}`, 'i');

/**
 * An environment id as a URL should carry it.
 *
 * Ids are stored lowercased, which is fine for a GUID but not for the one form
 * that is not one: the portal writes "Default-<tenant guid>" and Run Opener
 * found that play URLs mind the casing, so restore it on the way out.
 */
export const envIdForUrl = (envId) => String(envId ?? '').replace(/^default-/i, 'Default-');

/** Environment id from a maker-portal or canvas-player URL, or null. */
export function envIdFromUrl(url = location.href) {
    const match = new URL(url).pathname.match(
        new RegExp(`/(?:environments|e)/(${ENV_ID.source})`, 'i'),
    );
    return match ? match[1].toLowerCase() : null;
}
