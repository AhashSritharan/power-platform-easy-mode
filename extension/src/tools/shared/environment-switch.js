// The same page in another environment, for the Environment Indicator's switch.
//
// Ids in a URL are only the same across environments when a solution import
// carried them over, so each one is checked in the target: kept when the
// target has it, else matched by the component's name (unique or logical
// name), else the link stops at the deepest part the target does have — the
// solution, the table's list, the app's home page. A switch never lands on
// "That page can't be found" or "Record Is Unavailable", which is what an id
// the target lacks opens.
//
// `get(host, path)` reads https://<host>/api/data/v9.2/<path> and resolves its
// JSON, or null when there is no such row. Anything it throws counts as not
// found: a fallback page is better than a broken one.

import { ENV_ID } from '../../core/context.js';

const GUID = /^\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?$/i;

// How each kind of component is found in the target: by `id`, else by `name`.
// Metadata is read by key — EntityDefinitions(LogicalName='account') — rather
// than filtered.
const SOLUTIONS = { set: 'solutions', id: 'solutionid', name: 'uniquename' };
const ENTITIES = { set: 'EntityDefinitions', id: 'MetadataId', name: 'LogicalName', metadata: true };
const WORKFLOWS = { set: 'workflows', id: 'workflowid', name: 'name' };
const APP_MODULES = { set: 'appmodules', id: 'appmoduleid', name: 'uniquename' };

// The URL segment in front of an id says what the id is. Ids after any other
// segment (a flow's run, say) are not looked for: the link stops before them.
const SEGMENTS = {
    solutions: SOLUTIONS,
    entities: ENTITIES,
    optionsets: { set: 'GlobalOptionSetDefinitions', id: 'MetadataId', name: 'Name', metadata: true },
    webresources: { set: 'webresourceset', id: 'webresourceid', name: 'name' },
    canvasapps: { set: 'canvasapps', id: 'canvasappid', name: 'name' },
    workflows: WORKFLOWS,
    cloudflows: WORKFLOWS,
    flows: WORKFLOWS,
    sitemaps: { set: 'sitemaps', id: 'sitemapid', name: 'sitemapuniqueid' },
    connectionreferences: { set: 'connectionreferences', id: 'connectionreferenceid', name: 'connectionreferencelogicalname' },
    'environment variables': { set: 'environmentvariabledefinitions', id: 'environmentvariabledefinitionid', name: 'schemaname' },
};
// The model-driven app designer: /e/{env}/s/{solution}/app/edit/{app}.
const DESIGNER_SEGMENTS = { s: SOLUTIONS, edit: APP_MODULES };

// Where a maker-portal link goes when its first component is missing.
const LISTS = { solutions: 'solutions', entities: 'tables', flows: 'flows' };

const literal = (value) => encodeURIComponent(String(value).replace(/'/g, "''"));

/**
 * The URL `href` becomes in the environment `targetEnvId` (as a URL writes
 * it). `sourceHost` / `targetHost` are the two environments' Dataverse hosts;
 * without the target's, nothing can be checked and only the environment
 * changes.
 */
export async function switchUrl(href, { targetEnvId, sourceHost, targetHost, get }) {
    const url = new URL(href);
    const host = url.hostname.toLowerCase();
    const read = async (on, path) => {
        if (!on) return null;
        try { return await get(on, path); } catch { return null; }
    };
    const find = (component, id) => findComponent(component, id, { read, sourceHost, targetHost });

    if (host === 'make.powerapps.com' || host === 'make.powerautomate.com') {
        const portal = url.pathname.match(new RegExp(`^/environments/${ENV_ID.source}(/.*)?$`, 'i'));
        if (portal) {
            const base = `${url.origin}/environments/${targetEnvId}`;
            const rest = (portal[1] ?? '').split('/').filter(Boolean);
            if (!targetHost || !rest.some((s) => GUID.test(s))) return base + (portal[1] ?? '') + url.search + url.hash;
            const walked = await walk(rest, SEGMENTS, find);
            if (walked.complete) return `${base}/${walked.segments.join('/')}${url.search}${url.hash}`;
            if (walked.segments.length) return `${base}/${walked.segments.join('/')}`;
            return `${base}/${LISTS[rest[0]] ?? 'home'}`;
        }
        const designer = url.pathname.match(new RegExp(`^/e/${ENV_ID.source}(/.*)?$`, 'i'));
        if (designer) {
            const rest = (designer[1] ?? '').split('/').filter(Boolean);
            if (!targetHost || rest[0] !== 's') return `${url.origin}/e/${targetEnvId}${designer[1] ?? ''}${url.search}${url.hash}`;
            const walked = await walk(rest, DESIGNER_SEGMENTS, find);
            if (walked.complete) return `${url.origin}/e/${targetEnvId}/${walked.segments.join('/')}${url.search}${url.hash}`;
            // The designer has no page of its own for a missing app: the solution it was in.
            const solution = walked.segments[1];
            return `${url.origin}/environments/${targetEnvId}/solutions${solution ? `/${solution}` : ''}`;
        }
    }

    // Canvas player (apps.powerapps.com/play/e/{env}/a/{app}).
    if (host.endsWith('.powerapps.com')) {
        const path = url.pathname.replace(new RegExp(`/e/${ENV_ID.source}`, 'i'), `/e/${targetEnvId}`);
        if (path !== url.pathname) return url.origin + path + url.search + url.hash;
    }

    if (host.endsWith('.dynamics.com') && targetHost) return appUrl(url, targetHost, { read, find });

    return `https://make.powerapps.com/environments/${targetEnvId}`;
}

/**
 * The component `id` (of the source) as the target knows it: the same id when
 * an import kept it, else whatever the target calls the component of that name.
 */
async function findComponent(component, id, { read, sourceHost, targetHost }) {
    const byId = (host, field) => read(host, `${component.set}(${id})?$select=${field}`);
    if (await byId(targetHost, component.id)) return id;
    const name = (await byId(sourceHost, component.name))?.[component.name];
    if (!name) return null;
    if (component.metadata) {
        return (await read(targetHost, `${component.set}(${component.name}='${literal(name)}')?$select=${component.id}`))?.[component.id] ?? null;
    }
    const found = await read(targetHost, `${component.set}?$filter=${component.name} eq '${literal(name)}'&$select=${component.id}&$top=1`);
    return found?.value?.[0]?.[component.id] ?? null;
}

/**
 * Translate every "{kind}/{id}" pair of a path. Stops at the first id the
 * target has no match for, returning the path up to the last one it did find.
 */
async function walk(segments, kinds, find) {
    const out = [];
    let lastId = 0;
    for (let i = 0; i < segments.length; i++) {
        const next = segments[i + 1]?.match(GUID)?.[1];
        if (!next) {
            out.push(segments[i]);
            continue;
        }
        const component = kinds[decodeURIComponent(segments[i]).toLowerCase()];
        const found = component ? await find(component, next.toLowerCase()) : null;
        if (!found) return { segments: out.slice(0, lastId), complete: false };
        out.push(segments[i], found);
        lastId = out.length;
        i++;
    }
    return { segments: out, complete: true };
}

/** A model-driven app page (main.aspx) on the target's host. */
async function appUrl(url, targetHost, { read, find }) {
    const target = new URL(url.href);
    target.hostname = targetHost;
    if (!/^\/main\.aspx$/i.test(target.pathname)) return target.href;
    const params = target.searchParams;

    const appId = params.get('appid')?.match(GUID)?.[1];
    if (appId) {
        const found = await find(APP_MODULES, appId.toLowerCase());
        if (found) params.set('appid', found);
        else params.delete('appid');
    }
    const home = () => {
        const page = new URL('/main.aspx', target.origin);
        if (params.get('appid')) page.searchParams.set('appid', params.get('appid'));
        return page.href.replace(/\?$/, '');
    };

    const etn = params.get('etn');
    if (etn) {
        const entity = await read(targetHost, `EntityDefinitions(LogicalName='${literal(etn)}')?$select=EntitySetName,PrimaryIdAttribute`);
        if (!entity) return home();
        const id = params.get('id')?.match(GUID)?.[1];
        if (params.get('pagetype') === 'entityrecord' && id
            && !await read(targetHost, `${entity.EntitySetName}(${id})?$select=${entity.PrimaryIdAttribute}`)) {
            // The record is not there: its table's list is.
            for (const key of ['id', 'formid', 'extraqs']) params.delete(key);
            params.set('pagetype', 'entitylist');
        }
    }
    const webResource = params.get('pagetype') === 'webresource' ? params.get('webresourceName') : null;
    if (webResource) {
        const found = await read(targetHost, `webresourceset?$filter=name eq '${literal(webResource)}'&$select=webresourceid&$top=1`);
        if (!found?.value?.length) return home();
    }
    return target.href;
}
