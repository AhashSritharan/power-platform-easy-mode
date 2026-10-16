// Environment discovery for setup.
//
// The maker portal lists every environment the user can make things in when it
// loads — GET https://<tenant>.tenant.api.powerplatform.com/powerapps/environments?…
// with the portal's own token. Setup opens the portal with ?ppt-discover=1, the
// page agent hands that response over (src/agent/page-agent.js), and this
// module turns it into environments for the shared registry (environments.js),
// so every environment picker knows them without the user visiting each org.

import { ENV_TYPES, updateEnvironment, envIndicatorStore, cleanEnvId } from './environments.js';

/** The marker that tells the page agent to capture the portal's environment list. */
export const DISCOVERY_PARAM = 'ppt-discover';
/** The part of the portal's environment-list URL the page agent waits for. */
export const DISCOVERY_PATTERN = '/powerapps/environments?';

// Stage words, at the end of a name, and the label each one suggests.
const STAGE_TYPES = [
    [/^(dev|development)$/i, 'DEV'],
    [/^(test|tests|testing|tst|qa)$/i, 'TEST'],
    [/^uat$/i, 'UAT'],
    [/^(stag|stage|staging|preprod|pre-prod)$/i, 'STAGING'],
    [/^(prod|production|live)$/i, 'PROD'],
];
// "ContosoSalesPROD": a stage glued on, recognisable only by its capitals.
const GLUED_STAGE = /(?<=[a-z0-9])(DEV|TEST|TST|QA|UAT|STAGING|PROD)$/;
const SKU_TYPES = { Production: 'PROD', Developer: 'DEV', Trial: 'DEV' };

/**
 * The label an environment most likely has: the stage its name ends in, else
 * what its SKU implies. A sandbox or the default environment could be anything,
 * so those get no suggestion and the user picks.
 */
export function suggestEnvType({ name, sku } = {}) {
    const trimmed = String(name ?? '').trim();
    const lastWord = trimmed.split(/[\s._/|()-]+/).filter(Boolean).pop() ?? '';
    for (const [pattern, type] of STAGE_TYPES) if (pattern.test(lastWord)) return type;
    const glued = trimmed.match(GLUED_STAGE)?.[1];
    if (glued) return STAGE_TYPES.find(([pattern]) => pattern.test(glued))[1];
    return SKU_TYPES[sku] ?? null;
}

/**
 * The portal's response as [{ envId, name, host, sku, suggestedType }].
 * Environments without a Dataverse org are left out: no tool can talk to them.
 */
export function parseDiscoveredEnvironments(response) {
    const list = Array.isArray(response?.value) ? response.value : [];
    const environments = [];
    for (const env of list) {
        const properties = env?.properties ?? {};
        let host = null;
        try { host = new URL(properties.linkedEnvironmentMetadata?.instanceUrl).hostname.toLowerCase(); } catch { /* no org */ }
        const envId = cleanEnvId(env?.name);
        if (!host || !envId) continue;
        const name = String(properties.displayName ?? properties.linkedEnvironmentMetadata?.friendlyName ?? '').trim();
        const sku = properties.environmentSku ?? '';
        environments.push({ envId, name, host, sku, suggestedType: suggestEnvType({ name, sku }) });
    }
    return environments;
}

/**
 * Save the environments the user confirmed: each with its chosen label (or
 * none) and its org host, so pickers can reach it. A name the user typed
 * before is kept; environments not in the list are left alone.
 */
export async function saveDiscoveredEnvironments(environments, store = envIndicatorStore()) {
    for (const env of environments) {
        const type = ENV_TYPES[env.type] ? env.type : null;
        await updateEnvironment(env.envId, { type, name: env.name, nameSource: 'org' }, store);
    }
    const hostCache = await store.get('envIndicator_hostCache', {});
    for (const env of environments) hostCache[env.host.toLowerCase()] = cleanEnvId(env.envId);
    await store.set('envIndicator_hostCache', hostCache);
}
