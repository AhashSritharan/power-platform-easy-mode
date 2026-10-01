// Shared environment registry.
//
// The Environment Indicator is the single place where environments are
// labelled; every other tool that offers a "pick an environment" list reads
// what it saved. This module owns that storage shape so the tools agree on it.
//
// Storage (namespace `environment-indicator`):
//   envIndicator_mappings   { envId: 'DEV' | { type, name, group, nameSource } }
//                           nameSource: 'user' typed it, 'org' read it from
//                           RetrieveCurrentOrganization. Anything else is from
//                           a build that read the wrong column and is refetched.
//   envIndicator_order      [envId, …]        explicit display order
//   envIndicator_hostCache  { hostname: envId }
//
// Records started out as a bare type string and that form is still read, so no
// migration step is needed: a record is rewritten as an object the first time a
// name or group is attached to it.
//
// Environments come in families — "Smart Workflows DEV/TEST/PROD" alongside
// "Antrag Naturgefahren DEV/TEST/PROD" — and switching or deploying almost
// always stays inside one family. `groupEnvironments` is what every picker uses
// to put the family you are in first.

import { createStore } from '../../core/storage.js';
import { request } from '../../core/http.js';

export const ENV_TYPES = {
    DEV: { label: 'DEV', color: '#0F6CBD', bg: '#EBF3FC', border: '#B3D4FC', icon: '🔧' },
    TEST: { label: 'TEST', color: '#835C00', bg: '#FFF4CE', border: '#F5D06C', icon: '🧪' },
    UAT: { label: 'UAT', color: '#8764B8', bg: '#F3EFFC', border: '#C8B6E2', icon: '🔍' },
    STAGING: { label: 'STAGING', color: '#D83B01', bg: '#FED9CC', border: '#F7A68B', icon: '🚧' },
    PROD: { label: 'PROD', color: '#D13438', bg: '#FDE7E9', border: '#F1BBBC', icon: '🔴' },
};

const UNKNOWN_TYPE = { label: '?', color: '#616161', bg: '#F5F5F5', border: '#D1D1D1', icon: '🌐' };

/** Badge colours for a type, falling back to a neutral chip for unknown ones. */
export const envTypeConfig = (type) =>
    ENV_TYPES[type] ?? (type ? { ...UNKNOWN_TYPE, label: type } : UNKNOWN_TYPE);

/** Rank used to order environments inside a group: DEV → TEST → … → PROD. */
const TYPE_RANK = Object.fromEntries(Object.keys(ENV_TYPES).map((type, i) => [type, i]));

export const UNGROUPED = '';

export const envIndicatorStore = () => createStore('environment-indicator');

export const cleanEnvId = (envId) => String(envId ?? '').replace(/[{}]/g, '').toLowerCase();

// Stage words that turn "Smart Workflows DEV" into the family "Smart Workflows".
// Matched only at the end and only with something in front, so an environment
// genuinely called "Development" keeps its own name as its group.
const STAGE_WORDS = 'dev|development|test|tests|testing|tst|qa|uat|stag|stage|staging|preprod|pre-prod|prod|production|live|sandbox';
const STAGE_SUFFIX = new RegExp(`[\\s._/|-]+(${STAGE_WORDS})$`, 'i');
// "SmartWorkflowsDEV": a stage glued on, recognisable only by its capitals.
const GLUED_STAGE_SUFFIX = /(?<=[a-z0-9])(DEV|TEST|TST|QA|UAT|STAGING|PROD)$/;
const BARE_STAGE = new RegExp(`^(${STAGE_WORDS})$`, 'i');

/** "Smart Workflows DEV" → "Smart Workflows"; a bare stage name stays as it is. */
export function deriveGroup(name) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) return UNGROUPED;
    const stripped = trimmed.replace(STAGE_SUFFIX, '').replace(GLUED_STAGE_SUFFIX, '').trim();
    return stripped || trimmed;
}

// ── Families by host ──────────────────────────────────────────────────────
// Names are typed by people and drift ("Smart Workflows DEV", "SmartWorkflows
// Test", "Smart Workflows"), so names alone split one family into several.
// Hosts are steadier: siblings live in the same region and their org slugs
// differ mostly by stage words and numbers — contoso-workflows-dev /
// contoso-workflowstest / contoso-dev-workflows-01, all on .crm17.dynamics.com.
// Stage and number tokens are dropped wherever they sit, a stage glued onto the
// end is stripped too, and what is left is compared loosely so a typo or a
// small variation still lands in the family. That will now and then merge two
// apps that only look alike; one rename pulls them apart, which is less work
// than gathering a family that detection scattered.
const HOST_STAGE_WORDS = 'development|production|preprod|staging|testing|sandbox|tests|test|prod|stage|stag|live|uat|tst|dev|qa';
const HOST_STAGE_TOKEN = new RegExp(`^(${HOST_STAGE_WORDS}|\\d+)$`);
const HOST_GLUED_STAGE = new RegExp(`(${HOST_STAGE_WORDS})\\d*$`);
// Stems shorter than this are compared exactly; at this length and above, a
// similarity of FAMILY_SIMILARITY or more (1 = identical) is one family.
const FUZZY_MIN_LENGTH = 5;
const FAMILY_SIMILARITY = 0.8;

/** "contoso-dev-workflows-01.crm17.dynamics.com" → { region: "crm17.dynamics.com", stem: "contosoworkflows", base: "contoso-workflows" } */
export function hostFamily(host) {
    const [slug, ...region] = String(host ?? '').toLowerCase().split('.');
    if (!slug || !region.length) return null;
    const tokens = slug.replace(/pre[-_]prod/g, 'preprod').split(/[-_]+/).filter(Boolean);
    let base = tokens.filter((token) => !HOST_STAGE_TOKEN.test(token)).join('-');
    const unglued = base.replace(HOST_GLUED_STAGE, '').replace(/[-_]+$/, '');
    if (unglued.length >= 3) base = unglued;
    // Nothing meaningful left ("dev", "qa-01"): the slug is its own stem.
    if (base.length < 3) base = slug;
    return { region: region.join('.'), stem: base.replace(/[^a-z0-9]/g, ''), base };
}

/** 1 for identical strings, falling towards 0 as edits are needed (Levenshtein). */
export function similarity(a, b) {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;
    let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        for (let j = 1; j <= b.length; j++) {
            row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        previous = row;
    }
    return 1 - previous[b.length] / Math.max(a.length, b.length);
}

/** Whether two host families are close enough to be one: same region, alike stems. */
export function sameFamily(a, b) {
    if (!a || !b || a.region !== b.region) return false;
    if (a.stem === b.stem) return true;
    if (Math.min(a.stem.length, b.stem.length) < FUZZY_MIN_LENGTH) return false;
    return similarity(a.stem, b.stem) >= FAMILY_SIMILARITY;
}

/**
 * The label a host family shows: the group most of its names imply (shortest on
 * a tie, which is usually the one without a stage left in it), or the shared
 * slug when none of them is named yet. A bare "DEV" says nothing about the
 * family, so it never wins.
 */
function familyLabel(members) {
    // "smartworkflows", "SmartWorkflows" and "Smart Workflows" are one label;
    // the spelling shown is the most readable one — spaces and capitals over a slug.
    const readability = (label) => (/\s/.test(label) ? 2 : 0) + (/[A-Z]/.test(label) ? 1 : 0);
    const counts = new Map();
    for (const { env } of members) {
        const label = deriveGroup(env.name);
        if (!label || BARE_STAGE.test(label)) continue;
        const key = label.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        const entry = counts.get(key) ?? { label, count: 0 };
        entry.count++;
        if (readability(label) > readability(entry.label)) entry.label = label;
        counts.set(key, entry);
    }
    const [best] = [...counts.values()].sort((a, b) => b.count - a.count || a.label.length - b.label.length);
    return best?.label ?? members.map((m) => m.base).sort((a, b) => a.length - b.length)[0];
}

/**
 * Give environments that share a host family one derived group, so siblings
 * whose names disagree still land together. An explicit group still wins.
 * Mutates the passed environment objects in place.
 */
export function applyHostFamilies(environments) {
    const hosts = environments
        .map((env) => ({ env, family: hostFamily(env.host) }))
        .filter((entry) => entry.family);

    // Likeness is not transitive, so families are the connected pieces of the
    // "alike" relation: a ~ b and b ~ c put all three together. Lists are a
    // handful of environments, so comparing every pair is fine.
    const parent = hosts.map((_, i) => i);
    const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
    for (let i = 0; i < hosts.length; i++) {
        for (let j = i + 1; j < hosts.length; j++) {
            if (sameFamily(hosts[i].family, hosts[j].family)) parent[root(j)] = root(i);
        }
    }

    const families = new Map();
    hosts.forEach(({ env, family }, i) => {
        const key = root(i);
        if (!families.has(key)) families.set(key, []);
        families.get(key).push({ env, base: family.base });
    });
    for (const members of families.values()) {
        if (members.length < 2) continue;
        const label = familyLabel(members);
        for (const { env } of members) {
            env.derivedGroup = label;
            if (!env.explicitGroup) env.group = label;
        }
    }
    return environments;
}

/** Read a stored mapping value (legacy string or record object) as a record. */
export function normalizeRecord(raw) {
    if (typeof raw === 'string') return { type: raw, name: '', group: '', nameSource: '' };
    return {
        type: raw?.type ?? null,
        name: String(raw?.name ?? '').trim(),
        group: String(raw?.group ?? '').trim(),
        nameSource: raw?.nameSource ?? '',
    };
}

/** The record's group: an explicit one wins, otherwise it follows the name. */
export const recordGroup = (record) => record.group || deriveGroup(record.name);

/** Strip empty fields so records stay as small as the legacy strings were. */
function packRecord(record) {
    const packed = { type: record.type };
    if (record.name) packed.name = record.name;
    if (record.group) packed.group = record.group;
    if (record.nameSource) packed.nameSource = record.nameSource;
    return packed;
}

/**
 * Patch one environment's record in place. `patch` may carry type/name/group/
 * nameSource; an auto-detected name never overwrites one the user typed.
 * Returns true when something actually changed, so callers can skip a redraw.
 */
export async function updateEnvironment(envId, patch, store = envIndicatorStore()) {
    const id = cleanEnvId(envId);
    if (!id) return false;
    const mappings = await store.get('envIndicator_mappings', {});
    const key = Object.keys(mappings).find((k) => cleanEnvId(k) === id);
    const before = normalizeRecord(key === undefined ? undefined : mappings[key]);
    const next = { ...before, ...patch };
    // A name the user typed outranks anything detected from the org later.
    if (patch.name !== undefined && patch.nameSource !== 'user' && before.nameSource === 'user') {
        next.name = before.name;
        next.nameSource = 'user';
    }
    if (next.type === before.type && next.name === before.name
        && next.group === before.group && next.nameSource === before.nameSource
        && key === id) return false;
    if (key !== undefined) delete mappings[key];
    mappings[id] = packRecord(next);
    await store.set('envIndicator_mappings', mappings);
    return true;
}

/** Forget an environment: its record and its slot in the display order. */
export async function removeEnvironment(envId, store = envIndicatorStore()) {
    const id = cleanEnvId(envId);
    const mappings = await store.get('envIndicator_mappings', {});
    const order = await store.get('envIndicator_order', []);
    for (const key of Object.keys(mappings)) if (cleanEnvId(key) === id) delete mappings[key];
    await store.set('envIndicator_mappings', mappings);
    await store.set('envIndicator_order', (Array.isArray(order) ? order : []).filter((x) => cleanEnvId(x) !== id));
}

/**
 * Every labelled environment as { envId, type, name, group, explicitGroup,
 * derivedGroup, host, url, isCurrent }, in the saved display order with
 * unordered ids appended. `group` is what to display; `explicitGroup` is only
 * what the user typed, which is what an edit form must show so it does not
 * present a derived value as if it had been entered.
 * `hostOnly` drops environments whose Dynamics host has never been seen —
 * cross-environment API callers cannot do anything with those.
 */
export async function loadEnvironments({ currentEnvId = null, hostOnly = false, store = envIndicatorStore() } = {}) {
    const [mappings, rawOrder, hostCache] = await Promise.all([
        store.get('envIndicator_mappings', {}),
        store.get('envIndicator_order', []),
        store.get('envIndicator_hostCache', {}),
    ]);

    const hostByEnvId = {};
    for (const [host, envId] of Object.entries(hostCache)) hostByEnvId[cleanEnvId(envId)] = host.toLowerCase();

    const recordByEnvId = new Map();
    for (const [key, value] of Object.entries(mappings)) recordByEnvId.set(cleanEnvId(key), normalizeRecord(value));

    const order = (Array.isArray(rawOrder) ? rawOrder : []).map(cleanEnvId);
    const ids = [...order.filter((id) => recordByEnvId.has(id)),
        ...[...recordByEnvId.keys()].filter((id) => !order.includes(id))];

    const current = cleanEnvId(currentEnvId);
    const seen = new Set();
    const environments = [];
    for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const record = recordByEnvId.get(id);
        const host = hostByEnvId[id] ?? null;
        if (hostOnly && !host) continue;
        environments.push({
            envId: id,
            type: record.type,
            name: record.name,
            group: recordGroup(record),
            nameSource: record.nameSource,
            explicitGroup: record.group,
            derivedGroup: deriveGroup(record.name),
            host,
            url: host ? `https://${host}` : null,
            isCurrent: !!current && id === current,
        });
    }
    return applyHostFamilies(environments);
}

/**
 * Bucket environments into families for display: the group the user is in
 * comes first, the rest keep their saved order, and ungrouped environments
 * fall to the bottom. Inside a group, stages run DEV → TEST → … → PROD.
 *
 * Returns [{ group, label, isCurrent, envs }].
 */
export function groupEnvironments(environments, { currentGroup = null } = {}) {
    const current = String(currentGroup ?? '').trim().toLowerCase();
    const buckets = new Map();
    for (const env of environments) {
        const key = (env.group || UNGROUPED).toLowerCase();
        if (!buckets.has(key)) {
            buckets.set(key, { group: env.group || UNGROUPED, label: env.group || 'Ungrouped', isCurrent: false, envs: [] });
        }
        buckets.get(key).envs.push(env);
    }

    // Map preserves insertion order and Array#sort is stable, so groups not
    // pulled to the front keep the order their first member was saved in.
    const groups = [...buckets.entries()].map(([key, bucket]) => ({
        ...bucket,
        isCurrent: !!current && key === current,
        envs: bucket.envs.slice().sort((a, b) => (TYPE_RANK[a.type] ?? 99) - (TYPE_RANK[b.type] ?? 99)),
    }));

    const rank = (group) => (group.isCurrent ? 0 : group.group === UNGROUPED ? 2 : 1);
    return groups.sort((a, b) => rank(a) - rank(b));
}

/** The group an environment id belongs to, for `groupEnvironments`. */
export function groupOfEnvId(environments, envId) {
    const id = cleanEnvId(envId);
    return environments.find((e) => e.envId === id)?.group ?? null;
}

/** The group a hostname belongs to, for pickers keyed by URL rather than id. */
export function groupOfHost(environments, host) {
    const name = String(host ?? '').toLowerCase();
    return environments.find((e) => e.host === name)?.group ?? null;
}

// ── Friendly names ────────────────────────────────────────────────────────
// The indicator only knows an environment's id and host until someone asks the
// org for its name. Reads are cross-origin (relayed, with the user's session)
// and each host is fetched at most once per page.
//
// It has to be RetrieveCurrentOrganization's FriendlyName — the name the maker
// portal shows, "Smart Workflows DEV". The organization row's `name` column is
// the provisioning slug ("contoso-workflows-dev", or worse "orgbdab49fe"), which
// is no use as a label and derives nonsense families.
const orgNameCache = new Map();

export function resolveOrgName(host) {
    if (!host) return Promise.resolve(null);
    const key = host.toLowerCase();
    if (!orgNameCache.has(key)) {
        orgNameCache.set(key, (async () => {
            try {
                const response = await request({
                    url: `https://${key}/api/data/v9.2/RetrieveCurrentOrganization(AccessType='Default')`,
                    headers: { 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'Accept': 'application/json' },
                    credentials: true,
                });
                const detail = response.json()?.Detail;
                return detail?.FriendlyName || detail?.UniqueName || null;
            } catch (e) {
                console.warn('[Environments] could not resolve org name for', key, e);
                return null;
            }
        })());
    }
    return orgNameCache.get(key);
}

/** Names worth (re)fetching: missing, or left by a build that read the org's
 *  slug instead of its friendly name. A name the user typed is never touched. */
const needsName = (env) => !!env.host && env.nameSource !== 'user'
    && (!env.name || env.nameSource !== 'org');

/**
 * Fill in names for environments that have a host but no usable name yet,
 * saving each as it arrives and calling `onUpdate(env)` so a list can redraw
 * one row without waiting for the slowest host. Best effort: unreachable orgs
 * are simply skipped. Mutates the passed environment objects in place.
 */
export async function backfillNames(environments, { store = envIndicatorStore(), onUpdate, resolve = resolveOrgName } = {}) {
    await Promise.all(environments
        .filter(needsName)
        .map(async (env) => {
            const name = await resolve(env.host);
            if (!name) return;
            await updateEnvironment(env.envId, { name, nameSource: 'org' }, store);
            env.name = name;
            env.nameSource = 'org';
            env.derivedGroup = deriveGroup(name);
            if (!env.explicitGroup) env.group = env.derivedGroup;
            // A new name can change what its whole family is called.
            applyHostFamilies(environments);
            onUpdate?.(env);
        }));
}
