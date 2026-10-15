// Cloud Flow Manager (native).
// Lists the cloud flows of a solution and turns them on/off individually or
// in bulk. Detects "provided by run-only user" connections that break child
// flows and fixes them (one-off or via remembered quick-fix mappings), and
// visualizes flow dependency trees (parents/children/canvas apps) with a
// diagram or list view, CSV export, zoom and pan. For managed solutions,
// dependency lookups can run against the unmanaged DEV environment through
// the allowlisted background proxy.
//
// The Solution Deployer hands off here after a deployment by writing
// open_request into this tool's storage namespace; the tab on the matching
// origin claims it and opens the panel with that solution pre-selected.
//
// On the maker portals the org is the environment in the URL (see
// shared/current-org.js), and a solution page pre-selects its solution.

import { request } from '../core/http.js';
import { callExtension } from '../core/lifecycle.js';
import * as ui from '../core/ui.js';
import * as commands from '../core/commands.js';
import { loadEnvironments, resolveOrgName } from './shared/environments.js';
import { resolveCurrentOrg } from './shared/current-org.js';

const STATUS_LABELS = { 0: 'Off', 1: 'On' };
const STATUS_COLORS = { 0: '#616161', 1: '#107C10' };
const STATUS_ICONS = { 0: '⚫', 1: '🟢' };
const ISSUE_COLOR = '#D83B01';
const FLOW_FALLBACK_ICON = 'https://content.powerapps.com/resource/makerx/static/pauto/images/designeroperations/button.c0d4736c.png';
const DEFAULT_CONNECTOR_ICON = 'https://defaulticons.powerapps.com/defaulticons/api-dedicated.png';
const CANVAS_APP_ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#742774" d="M0 0h32v32h-32z"/><rect fill="#fff" x="17.29" y="20.01" width="3.11" height="3.11" rx=".62" transform="translate(-9.73 19.64) rotate(-45)"/><rect fill="#fff" x="20.04" y="17.26" width="3.11" height="3.11" rx=".62" transform="translate(-6.98 20.78) rotate(-45)"/><path fill="#fff" d="M17.86 18.37l-.43-.43-3.65-3.64a.62.62 0 0 0-.88 0l-3.64 3.65-.43.43a.62.62 0 0 0 0 .88l.43.43 3.64 3.64a.62.62 0 0 0 .88 0l3.64-3.64.43-.43a.62.62 0 0 0 .01-.89zm-5 2.2l-1-1-.34-.34a.62.62 0 0 1 0-.88l1.32-1.32a.62.62 0 0 1 .88 0l1.32 1.32a.62.62 0 0 1 0 .88l-.34.34-1 1a.62.62 0 0 1-.8.01z"/><rect fill="#fff" x="17.29" y="14.51" width="3.11" height="3.11" rx=".62" transform="translate(-5.84 18.03) rotate(-45)"/><path fill="#fff" d="M23.67 21.53h-.4v-.8h.4a1.53 1.53 0 0 0 1.53-1.53v-8.13a1.53 1.53 0 0 0-1.53-1.53h-15.07a1.53 1.53 0 0 0-1.53 1.53v8.13a1.53 1.53 0 0 0 1.53 1.53h.4v.8h-.4a2.33 2.33 0 0 1-2.33-2.33v-8.13a2.33 2.33 0 0 1 2.33-2.32h15.07a2.33 2.33 0 0 1 2.33 2.32v8.13a2.33 2.33 0 0 1-2.33 2.33"/></svg>')}`;

// CDN release paths tried in order when resolving connector icons
const CONNECTOR_ICON_CDN = 'https://conn-afd-prod-endpoint-bmc9bqahasf3grgk.b01.azurefd.net';
const CONNECTOR_ICON_PATTERNS = [
    '/releases/v1.0.1800/1.0.1800.4610/{connector}/icon.png',
    '/releases/v1.0.1797/1.0.1797.4609/{connector}/icon.png',
    '/releases/v1.0.1793/1.0.1793.4565/{connector}/icon.png',
    '/releases/v1.0.1788/1.0.1788.4544/{connector}/icon.png',
    '/releases/v1.0.1783/1.0.1783.4453/{connector}/icon.png',
    '/releases/v1.0.1777/1.0.1777.4410/{connector}/icon.png',
    '/v1.0.1774/1.0.1774.4397/{connector}/icon.png',
    '/v1.0.1771/1.0.1771.4364/{connector}/icon.png',
    '/u/shgogna/version-mismatches-special-train/1.0.1670.3520/{connector}/icon.png',
];

const STYLE = `
    .cfm-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.3); z-index: 2147483000; animation: ppt-fade 0.15s ease; }
    .cfm-panel {
        position: fixed; top: 0; right: 0; bottom: 0;
        width: 80vw; min-width: 600px; max-width: 1800px;
        background: var(--bg); display: flex; flex-direction: column;
        box-shadow: -4px 0 24px rgba(0,0,0,0.18); animation: cfm-slide 0.25s ease;
    }
    .cfm-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 24px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .cfm-header h2 { margin: 0; font-size: 18px; font-weight: 600; }
    .cfm-bar { padding: 12px 24px; border-bottom: 1px solid var(--border); background: var(--bg2); flex-shrink: 0; }
    .cfm-chip { padding: 5px 12px; font-size: 12px; font-weight: 600; border: 1px solid var(--border); border-radius: 16px; background: var(--bg); color: var(--text); cursor: pointer; font-family: inherit; }
    .cfm-chip:hover, .cfm-chip.active { border-color: var(--accent); color: var(--accent); }
    .cfm-btn-success { background: #107C10; color: #fff; border: none; padding: 6px 14px; border-radius: 4px; font-size: 13px; font-weight: 600; font-family: inherit; cursor: pointer; }
    .cfm-btn-success:hover { background: #0E6A0E; }
    .cfm-btn-danger { background: #D13438; color: #fff; border: none; padding: 6px 14px; border-radius: 4px; font-size: 13px; font-weight: 600; font-family: inherit; cursor: pointer; }
    .cfm-btn-danger:hover { background: #B10E11; }
    .cfm-btn-success:disabled, .cfm-btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }
    .cfm-outline { background: transparent; border: 1px solid; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600; font-family: inherit; }
    .cfm-outline.primary { color: var(--accent); border-color: var(--accent); }
    .cfm-outline.success { color: #107C10; border-color: #107C10; }
    .cfm-outline.danger { color: #D13438; border-color: #D13438; }
    .cfm-outline.warning { color: ${ISSUE_COLOR}; border-color: ${ISSUE_COLOR}; }
    .cfm-outline:hover { background: var(--bg2); }
    .cfm-outline:disabled { opacity: 0.5; cursor: not-allowed; }
    .cfm-table { width: 100%; border-collapse: collapse; font-size: 14px; }
    .cfm-table th {
        text-align: left; padding: 10px 12px; font-weight: 600; color: var(--muted); font-size: 11px;
        text-transform: uppercase; letter-spacing: 0.3px; border-bottom: 2px solid var(--border);
        background: var(--bg2); white-space: nowrap; position: sticky; top: 0; z-index: 1;
    }
    .cfm-table td { padding: 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    .cfm-table tr:hover td { background: var(--bg2); }
    .cfm-badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; white-space: nowrap; }
    .cfm-warn-note {
        display: inline-flex; align-items: center; gap: 4px; margin-top: 4px; font-size: 11px;
        color: ${ISSUE_COLOR}; background: rgba(245,208,108,0.25); padding: 2px 6px; border-radius: 4px;
    }
    .cfm-spinner { width: 32px; height: 32px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: cfm-spin 0.7s linear infinite; }
    .cfm-spinner-sm { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: cfm-spin 0.7s linear infinite; vertical-align: middle; }
    .cfm-center { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px; color: var(--muted); text-align: center; }
    .cfm-icons { display: flex; align-items: center; gap: 3px; }
    .cfm-icons img, .cfm-icons .ph { width: 20px; height: 20px; border-radius: 4px; object-fit: contain; background: var(--bg2); border: 1px solid var(--border); display: inline-block; }
    .cfm-icons .more { display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 4px; background: var(--border); color: var(--muted); font-size: 10px; font-weight: 600; }
    .cfm-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 2147483050; display: flex; align-items: center; justify-content: center; animation: ppt-fade 0.15s ease; }
    .cfm-dialog {
        background: var(--bg); border-radius: 8px; box-shadow: var(--shadow);
        min-width: 400px; max-width: 90vw; max-height: 85vh;
        display: flex; flex-direction: column; animation: ppt-pop 0.15s ease;
    }
    .cfm-dialog.fullscreen { width: 100vw !important; height: 100vh !important; max-width: 100vw; max-height: 100vh; border-radius: 0; }
    .cfm-select { font: inherit; padding: 8px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); width: 100%; box-sizing: border-box; }
    /* Dependency diagram */
    .fd-drag { flex: 1; overflow: auto; padding: 24px; background: var(--bg2); cursor: grab; user-select: none; }
    .fd-drag.dragging { cursor: grabbing; }
    .fd-zoom { transform-origin: top center; display: flex; flex-direction: column; align-items: center; min-width: max-content; }
    .fd-diagram { display: flex; flex-direction: column; align-items: center; padding: 20px; min-width: max-content; }
    .fd-section { display: flex; flex-direction: column; align-items: center; gap: 10px; }
    .fd-section-label { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 4px; }
    .fd-count { background: var(--border); color: var(--muted); padding: 1px 7px; border-radius: 10px; font-size: 11px; }
    .fd-scopes-row { display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap; justify-content: center; }
    .fd-card {
        display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: var(--bg);
        border: 1px solid var(--border); border-radius: 6px; width: 300px; box-sizing: border-box;
        cursor: pointer; position: relative;
    }
    .fd-card:hover { border-color: var(--accent); }
    .fd-card.selected { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(15,108,189,0.25); }
    .fd-card .name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fd-card .label { font-size: 11px; color: var(--muted); }
    .fd-card .tag { position: absolute; top: 4px; right: 6px; font-size: 9px; font-weight: 700; color: ${ISSUE_COLOR}; text-transform: uppercase; }
    .fd-icon-stack { display: flex; flex-direction: column; gap: 2px; flex-shrink: 0; }
    .fd-icon-stack img, .fd-icon-stack .ph { width: 22px; height: 22px; border-radius: 4px; object-fit: contain; display: block; }
    .fd-scope-wrapper { display: flex; flex-direction: column; align-items: center; }
    .fd-scope-header { position: relative; z-index: 1; background: var(--bg2); padding: 0 10px; }
    .fd-scope-body { background: var(--bg2); border: 2px solid var(--muted); border-radius: 4px; padding: 26px 16px 16px; margin-top: -18px; }
    .fd-scope-children { display: flex; flex-direction: column; align-items: center; gap: 10px; }
    .fd-connector { display: flex; justify-content: center; padding: 6px 0; color: var(--muted); }
    .fd-empty { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; padding: 10px 16px; border: 1px dashed var(--border); border-radius: 6px; }
    .fd-zoom-btn { background: var(--bg2); border: none; cursor: pointer; padding: 4px 8px; border-radius: 3px; color: var(--text); font-size: 14px; font-weight: 600; min-width: 26px; font-family: inherit; }
    .fd-zoom-btn:hover { background: var(--border); }
    .fd-list { padding: 20px 24px; width: 100%; box-sizing: border-box; }
    .fd-list-columns { display: flex; gap: 16px; }
    .fd-list-column { flex: 1; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
    .fd-list-column-header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: var(--bg2); font-size: 12px; font-weight: 600; border-bottom: 1px solid var(--border); }
    .fd-list-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .fd-list-table td { padding: 8px 10px; border-bottom: 1px solid var(--border); }
    .fd-info { margin-top: 14px; font-size: 12px; color: var(--muted); text-align: center; }
    @keyframes cfm-slide { from { transform: translateX(100%); } }
    @keyframes cfm-spin { to { transform: rotate(360deg); } }
`;

let dv;
let org; // { origin, host } of the org dv reads — set when the panel opens
let store;

const escapeHtml = (text) => {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
};
const truncateText = (text, max) => (!text ? '' : text.length <= max ? text : text.substring(0, max - 3) + '…');
const odataQuote = (s) => encodeURIComponent(String(s).replace(/'/g, "''"));

function formatDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatConnectorName(name) {
    if (!name) return 'Unknown';
    return name.replace(/^shared_/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ')
        .split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ── Per-environment persisted settings ────────────────────────────────────
const envKey = () => `env/${org.host}`;
async function getEnvData() { return store.get(envKey(), {}); }
async function setEnvData(patch) {
    const merged = { ...(await getEnvData()), ...patch };
    await store.set(envKey(), merged);
    return merged;
}

// ── Environments labelled in the Environment Indicator ─────────────────────
// Managed-solution dependency lookups need the unmanaged (DEV) org. Rather than
// keep a separate DEV URL here, we reuse the environments the user has already
// labelled in the Environment Indicator (DEV/TEST/…) whose Dynamics host it has
// cached. The DEV org of the same project — the family this environment
// belongs to — is the one holding this solution unmanaged, so it comes first.
const ENV_BADGES = {
    DEV: { icon: '🔧', color: '#0F6CBD', bg: '#EBF3FC', border: '#B3D4FC' },
    TEST: { icon: '🧪', color: '#835C00', bg: '#FFF4CE', border: '#F5D06C' },
    UAT: { icon: '🔍', color: '#8764B8', bg: '#F3EFFC', border: '#C8B6E2' },
    STAGING: { icon: '🚧', color: '#D83B01', bg: '#FED9CC', border: '#F7A68B' },
    PROD: { icon: '🔴', color: '#D13438', bg: '#FDE7E9', border: '#F1BBBC' },
};

async function labelledEnvironments() {
    const environments = await loadEnvironments({
        currentEnvId: await fetchEnvironmentId(),
        hostOnly: true,
    });
    // Matched by id normally; by host for the case where this page never
    // resolved its own environment id.
    const here = environments.find((env) => env.isCurrent)
        ?? environments.find((env) => env.host === org.host.toLowerCase());
    return environments
        .filter((env) => env !== here)
        .map((env) => ({ ...env, sameGroup: !!here?.group && env.group === here.group }))
        .sort((a, b) => (b.sameGroup - a.sameGroup) || ((b.type === 'DEV') - (a.type === 'DEV')));
}

// ── Environment / API helpers ─────────────────────────────────────────────
let environmentIdCache = null;
async function fetchEnvironmentId() {
    if (!environmentIdCache) {
        try { environmentIdCache = (await dv.retrieveCurrentOrganization())?.EnvironmentId ?? null; }
        catch (e) { console.warn('[Cloud Flow Manager] could not get environment id:', e); }
    }
    return environmentIdCache;
}

let whoAmICache = null;
async function getCurrentUserId() {
    return (whoAmICache ??= (await dv.get('/WhoAmI()')).UserId.replace(/[{}]/g, '').toLowerCase());
}

// GETs against the current org or (for DEV lookups) another org via the proxy
async function apiGet(url) {
    const target = url.startsWith('http') ? url : org.origin + url;
    const response = await request({
        url: target,
        headers: { 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'Accept': 'application/json' },
        credentials: true,
    });
    return response.json();
}

// ── Connector icons ───────────────────────────────────────────────────────
const validatedIconCache = new Map();
const pendingValidations = new Map();

function testImageUrl(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img.naturalWidth >= 16 && img.naturalHeight >= 16);
        img.onerror = () => resolve(false);
        setTimeout(() => resolve(false), 5000);
        img.src = url;
    });
}

async function findWorkingIconUrl(connectorApiName) {
    const name = connectorApiName.replace(/^shared_/, '').toLowerCase();
    if (validatedIconCache.has(name)) return validatedIconCache.get(name);
    if (pendingValidations.has(name)) return pendingValidations.get(name);

    const promise = (async () => {
        for (const pattern of CONNECTOR_ICON_PATTERNS) {
            const url = CONNECTOR_ICON_CDN + pattern.replace('{connector}', name);
            if (await testImageUrl(url)) {
                validatedIconCache.set(name, url);
                pendingValidations.delete(name);
                return url;
            }
        }
        validatedIconCache.set(name, null);
        pendingValidations.delete(name);
        return null;
    })();
    pendingValidations.set(name, promise);
    return promise;
}

// Root-scoped async icon fill (elements live in the shadow root)
async function loadConnectorIcon(root, elementId, apiName, displayName) {
    const workingUrl = await findWorkingIconUrl(apiName);
    const element = root.querySelector(`[data-icon-id="${elementId}"]`);
    if (!element) return;
    const img = ui.el('img', { src: workingUrl || DEFAULT_CONNECTOR_ICON, alt: displayName, title: displayName });
    element.replaceWith(img);
}

let iconSeq = 0;
function connectorIconHtml(root, connector) {
    const name = connector.apiName.replace(/^shared_/, '').toLowerCase();
    if (validatedIconCache.has(name)) {
        const cached = validatedIconCache.get(name) || DEFAULT_CONNECTOR_ICON;
        return `<img src="${escapeHtml(cached)}" alt="${escapeHtml(connector.displayName)}" title="${escapeHtml(connector.displayName)}">`;
    }
    const id = `ci-${iconSeq++}`;
    setTimeout(() => loadConnectorIcon(root, id, connector.apiName, connector.displayName), 0);
    return `<span class="ph" data-icon-id="${id}" title="${escapeHtml(connector.displayName)}"></span>`;
}

// ── Data access ───────────────────────────────────────────────────────────
let solutionsCache = null;
async function fetchSolutions() {
    if (!solutionsCache) {
        const data = await dv.get('/solutions?$select=solutionid,friendlyname,uniquename,version,ismanaged&$filter=isvisible eq true&$orderby=friendlyname asc');
        solutionsCache = data.value ?? [];
    }
    return solutionsCache;
}

async function fetchCloudFlows(solutionId) {
    const filter = encodeURIComponent(`(msdyn_solutionid eq ${solutionId}) and ((msdyn_componenttype eq 29 and msdyn_workflowcategory eq '5'))`);
    const data = await apiGet(`/api/data/v9.0/msdyn_solutioncomponentsummaries?$filter=${filter}&$orderby=msdyn_displayname asc&api-version=9.1`);
    return data.value ?? [];
}

function analyzeConnectionReferences(workflow) {
    const result = { hasIssue: false, connections: [], workflowId: workflow.workflowid };
    if (!workflow.clientdata) return result;
    try {
        const clientData = JSON.parse(workflow.clientdata);
        for (const [refName, refData] of Object.entries(clientData.properties?.connectionReferences ?? {})) {
            const connectorApiName = refData.api?.name || refData.connectionName || refName;
            const runtimeSource = (refData.runtimeSource ?? '').toLowerCase();
            const connection = {
                name: refName,
                connectorName: formatConnectorName(connectorApiName),
                connectorApiName,
                connectionId: refData.connection?.id || refData.connectionId || '',
            };
            if (runtimeSource === 'invoker') {
                result.hasIssue = true;
                connection.runtimeSource = 'Provided by run-only user';
            } else {
                connection.runtimeSource = runtimeSource === 'embedded' ? 'Embedded (OK)' : (runtimeSource || 'Unknown');
                connection.isOk = runtimeSource === 'embedded';
            }
            result.connections.push(connection);
        }
    } catch (e) {
        console.error('[Cloud Flow Manager] error parsing clientdata:', workflow.workflowid, e);
    }
    return result;
}

async function fetchWorkflowConnectionDetails(workflowIds) {
    const issues = new Map();
    for (let i = 0; i < workflowIds.length; i += 10) {
        const batch = workflowIds.slice(i, i + 10);
        const filter = batch.map((id) => `workflowid eq ${id}`).join(' or ');
        try {
            const data = await apiGet(`/api/data/v9.0/workflows?$select=workflowid,name,clientdata&$filter=${encodeURIComponent(filter)}`);
            for (const workflow of data.value ?? []) issues.set(workflow.workflowid, analyzeConnectionReferences(workflow));
        } catch (e) {
            console.error('[Cloud Flow Manager] error fetching workflow details:', e);
        }
    }
    return issues;
}

async function toggleFlowState(workflowId, turnOn) {
    await dv.update('workflows', workflowId, {
        statecode: turnOn ? 1 : 0,
        statuscode: turnOn ? 2 : 1,
    });
    return true;
}

async function toggleMultipleFlows(flowUpdates) {
    const responses = await Promise.all(flowUpdates.map((u) =>
        toggleFlowState(u.workflowId, u.turnOn)
            .then(() => ({ workflowId: u.workflowId, success: true }))
            .catch((e) => ({ workflowId: u.workflowId, success: false, error: e.message }))));
    return {
        succeeded: responses.filter((r) => r.success).map((r) => r.workflowId),
        failed: responses.filter((r) => !r.success).map((r) => ({ workflowId: r.workflowId, error: r.error })),
    };
}

async function fetchAvailableConnections(connectorApiName) {
    try {
        const userId = await getCurrentUserId();
        const data = await apiGet(`/api/data/v9.0/connectionreferences?$select=connectionreferenceid,connectionreferencedisplayname,connectorid,connectionid,statecode&$filter=statecode eq 0 and _ownerid_value eq '${userId}'&$orderby=connectionreferencedisplayname asc`);
        const apiNameLower = connectorApiName.toLowerCase();
        return (data.value ?? [])
            .filter((cr) => {
                const connectorId = (cr.connectorid ?? '').toLowerCase();
                return (connectorId.includes(apiNameLower) || connectorId.includes(apiNameLower.replace('shared_', '')))
                    && cr.connectionid?.trim();
            })
            .map((cr) => ({
                id: cr.connectionreferenceid,
                displayName: cr.connectionreferencedisplayname || 'Unnamed Connection',
                connectionId: cr.connectionid,
            }));
    } catch (e) {
        console.error('[Cloud Flow Manager] error fetching connections:', e);
        return [];
    }
}

async function updateWorkflowConnections(workflowId, connectionUpdates) {
    const workflow = await apiGet(`/api/data/v9.0/workflows(${workflowId})?$select=workflowid,clientdata`);
    if (!workflow?.clientdata) throw new Error('Could not fetch workflow data');
    const clientData = JSON.parse(workflow.clientdata);
    const refs = clientData.properties?.connectionReferences ?? {};
    for (const update of connectionUpdates) {
        const ref = refs[update.refName];
        if (!ref) continue;
        ref.runtimeSource = 'embedded';
        if (update.connectionId) {
            if (ref.connection) ref.connection.id = update.connectionId;
            else ref.connectionId = update.connectionId;
        }
    }
    await dv.update('workflows', workflowId, { clientdata: JSON.stringify(clientData) });
}

// ── Flow dependency analysis (RetrieveDependent/RequiredComponents) ───────
async function fetchFlowDependencies(state, targetWorkflowId, maxDepth = 5, apiBaseUrlOverride = null) {
    const apiBase = apiBaseUrlOverride || org.origin;
    const depGet = (path) => apiGet(apiBase + path);

    const result = { parents: [], children: [], canvasApps: [], targetFlowName: '', targetConnectors: [] };
    const targetFlow = state.flows.find((f) => f.msdyn_objectid === targetWorkflowId);
    result.targetFlowName = targetFlow?.msdyn_displayname || targetFlow?.msdyn_name || 'Unknown Flow';

    const flowMap = new Map(state.flows.filter((f) => f.msdyn_objectid).map((f) => [f.msdyn_objectid.toLowerCase(), f]));

    const getConnectorIcons = (wfId) => {
        const connInfo = state.connectionIssues.get(wfId);
        if (!connInfo?.connections) return [];
        const seen = new Set();
        const icons = [];
        for (const c of connInfo.connections) {
            if (c.connectorApiName && !seen.has(c.connectorApiName)) {
                seen.add(c.connectorApiName);
                icons.push({ apiName: c.connectorApiName, displayName: c.connectorName });
            }
        }
        return icons.slice(0, 4);
    };
    result.targetConnectors = getConnectorIcons(targetWorkflowId);

    const workflowIdsToFetch = new Set();
    const canvasAppIds = new Set();
    const parentCache = new Map();
    const childCache = new Map();

    async function fetchParentIds(workflowId, depth) {
        const key = workflowId.toLowerCase();
        if (!parentCache.has(key)) {
            parentCache.set(key, (async () => {
                const data = await depGet(`/api/data/v9.0/RetrieveDependentComponents(ObjectId=${workflowId},ComponentType=29)`);
                const ids = [];
                for (const dep of data.value ?? []) {
                    if (dep.dependentcomponenttype === 29) ids.push((dep.dependentcomponentobjectid ?? '').toLowerCase());
                    else if (dep.dependentcomponenttype === 300 && depth === 1) {
                        const appId = (dep.dependentcomponentobjectid ?? '').toLowerCase();
                        if (appId) canvasAppIds.add(appId);
                    }
                }
                return ids;
            })());
        }
        return parentCache.get(key);
    }

    async function fetchChildIds(workflowId) {
        const key = workflowId.toLowerCase();
        if (!childCache.has(key)) {
            childCache.set(key, (async () => {
                const data = await depGet(`/api/data/v9.0/RetrieveRequiredComponents(ObjectId=${workflowId},ComponentType=29)`);
                return (data.value ?? [])
                    .filter((dep) => dep.requiredcomponenttype === 29)
                    .map((dep) => (dep.requiredcomponentobjectid ?? '').toLowerCase());
            })());
        }
        return childCache.get(key);
    }

    async function walk(workflowId, depth, branchPath, fetchIds, key) {
        if (depth > maxDepth) return [];
        const currentPath = new Set(branchPath);
        currentPath.add(workflowId.toLowerCase());
        try {
            const ids = (await fetchIds(workflowId, depth)).filter((id) => id && !currentPath.has(id));
            return Promise.all(ids.map(async (id) => {
                const flow = flowMap.get(id);
                if (!flow) workflowIdsToFetch.add(id);
                const node = {
                    workflowId: id,
                    name: flow?.msdyn_displayname || flow?.msdyn_name || null,
                    inSolution: !!flow,
                    connectors: getConnectorIcons(id),
                    [key]: [],
                };
                node[key] = await walk(id, depth + 1, currentPath, fetchIds, key);
                return node;
            }));
        } catch (e) {
            console.warn(`[Cloud Flow Manager] dependency walk failed at depth ${depth}:`, e);
            return [];
        }
    }

    const initialPath = new Set([targetWorkflowId.toLowerCase()]);
    [result.parents, result.children] = await Promise.all([
        walk(targetWorkflowId, 1, initialPath, fetchParentIds, 'parents'),
        walk(targetWorkflowId, 1, initialPath, fetchChildIds, 'children'),
    ]);

    const getMaxDepth = (node, key) => (node[key]?.length ? 1 + Math.max(...node[key].map((c) => getMaxDepth(c, key))) : 0);
    const sortByDepth = (nodes, key) => {
        for (const node of nodes) if (node[key]?.length) sortByDepth(node[key], key);
        nodes.sort((a, b) => getMaxDepth(a, key) - getMaxDepth(b, key));
    };
    sortByDepth(result.children, 'children');
    sortByDepth(result.parents, 'parents');

    // Resolve canvas app names
    if (canvasAppIds.size) {
        try {
            const ids = [...canvasAppIds];
            for (let i = 0; i < ids.length; i += 10) {
                const filter = ids.slice(i, i + 10).map((id) => `canvasappid eq ${id}`).join(' or ');
                const data = await depGet(`/api/data/v9.0/canvasapps?$select=canvasappid,name,displayname&$filter=${encodeURIComponent(filter)}`);
                for (const app of data.value ?? []) {
                    result.canvasApps.push({ canvasAppId: app.canvasappid.toLowerCase(), name: app.displayname || app.name || 'Unknown Canvas App', inSolution: false });
                }
            }
        } catch (e) {
            console.warn('[Cloud Flow Manager] canvas app name lookup failed:', e);
            for (const appId of canvasAppIds) {
                if (!result.canvasApps.some((a) => a.canvasAppId === appId)) {
                    result.canvasApps.push({ canvasAppId: appId, name: 'Canvas App', inSolution: false });
                }
            }
        }
    }

    // Resolve names for out-of-solution flows
    if (workflowIdsToFetch.size) {
        const nameMap = new Map();
        try {
            const ids = [...workflowIdsToFetch];
            for (let i = 0; i < ids.length; i += 10) {
                const filter = ids.slice(i, i + 10).map((id) => `workflowid eq ${id}`).join(' or ');
                const data = await depGet(`/api/data/v9.0/workflows?$select=workflowid,name&$filter=${encodeURIComponent(filter)}`);
                for (const wf of data.value ?? []) nameMap.set(wf.workflowid.toLowerCase(), wf.name);
            }
        } catch (e) {
            console.warn('[Cloud Flow Manager] workflow name lookup failed:', e);
        }
        const applyNames = (nodes) => {
            for (const node of nodes) {
                node.name = node.name ?? nameMap.get(node.workflowId) ?? node.workflowId;
                if (node.parents) applyNames(node.parents);
                if (node.children) applyNames(node.children);
            }
        };
        applyNames(result.parents);
        applyNames(result.children);
    }
    return result;
}

// ── Dialog helpers ────────────────────────────────────────────────────────
function cfmOverlay() {
    const overlay = ui.mount(ui.el('div', { className: 'ppt cfm-overlay' }));
    const dialog = ui.el('div', { className: 'cfm-dialog' });
    overlay.appendChild(dialog);
    let releaseEscape = () => {};
    function close() { overlay.remove(); releaseEscape(); }
    releaseEscape = ui.onEscape(close);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    dialog.addEventListener('mousedown', (e) => e.stopPropagation());
    return { overlay, dialog, close };
}

const RESULT_ICONS = { success: ['✓', '#107C10'], error: ['✕', '#D13438'], warning: ['⚠', '#835C00'], info: ['ℹ', '#0F6CBD'] };

function showResultDialog(title, message, type = 'info', details = null) {
    const { dialog, close } = cfmOverlay();
    const [icon, color] = RESULT_ICONS[type] ?? RESULT_ICONS.info;
    const body = ui.el('div', { style: 'padding:24px;overflow-y:auto;flex:1' }, [
        ui.el('div', { style: 'display:flex;align-items:flex-start;gap:16px' }, [
            ui.el('div', { style: `width:48px;height:48px;border-radius:50%;background:${color}20;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:24px;color:${color}`, textContent: icon }),
            ui.el('div', { style: 'flex:1' }, [
                ui.el('h3', { style: 'margin:0 0 8px;font-size:18px;font-weight:600', textContent: title }),
                ui.el('p', { style: 'margin:0;font-size:14px;color:var(--muted);line-height:1.5;white-space:pre-wrap', textContent: message }),
            ]),
        ]),
    ]);
    if (details?.length) {
        const table = ui.el('table', { className: 'cfm-table', style: 'font-size:13px;margin-top:16px' });
        table.innerHTML = '<thead><tr><th>Flow</th><th style="width:100px">Result</th></tr></thead>';
        const tbody = ui.el('tbody');
        for (const d of details) {
            tbody.appendChild(ui.el('tr', {}, [
                ui.el('td', { textContent: d.name }),
                ui.el('td', {}, [ui.el('span', { style: `color:${d.success ? '#107C10' : '#D13438'};font-weight:500`, textContent: d.success ? '✓ Success' : '✕ Failed' })]),
            ]));
        }
        table.appendChild(tbody);
        body.appendChild(ui.el('div', { style: 'max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:4px;margin-top:12px' }, [table]));
    }
    dialog.append(body, ui.el('div', { style: 'padding:16px 24px;border-top:1px solid var(--border);display:flex;justify-content:flex-end' }, [
        ui.el('button', { className: 'ppt-btn primary', textContent: 'OK', style: 'min-width:100px', onclick: close }),
    ]));
}

// ── Panel ─────────────────────────────────────────────────────────────────
let panelOpen = false;

async function openCloudFlowManager(preselectSolutionUniqueName = null, { onDismiss = null } = {}) {
    if (panelOpen) return;
    panelOpen = true; // claimed while the org is resolved

    const resolved = await resolveCurrentOrg({ purpose: 'its cloud flows can be listed and managed' });
    if (!resolved) { panelOpen = false; return; }
    // A maker-portal tab can move to another environment without reloading,
    // and everything cached below belongs to one org.
    if (resolved.origin !== org?.origin) {
        environmentIdCache = whoAmICache = solutionsCache = null;
    }
    ({ dv } = resolved);
    org = { origin: resolved.origin, host: resolved.host };

    const state = {
        solutionId: null, solutionName: null, solutionIsManaged: false,
        flows: [], selectedFlows: new Set(),
        filter: 'all', searchText: '',
        connectionIssues: new Map(),
        devEnvironmentUrl: null,
    };

    const backdrop = ui.mount(ui.el('div', { className: 'ppt cfm-backdrop' }));
    let releaseEscape = () => {};
    const dispose = () => {
        panelOpen = false;
        backdrop.remove();
        releaseEscape();
        onDismiss?.();
    };
    releaseEscape = ui.onEscape(dispose);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) dispose(); });

    const panel = ui.el('div', { className: 'cfm-panel' });
    panel.innerHTML = `
        <div class="cfm-header">
            <div style="display:flex;align-items:center;gap:10px">
                <span style="font-size:20px">⚡</span>
                <h2>Cloud Flow Manager</h2>
                <span class="ppt-note" style="margin:0;padding:2px 8px;font-size:11px;font-weight:600;color:var(--accent)">Solution</span>
            </div>
            <button class="ppt-icon-btn" data-act="close" title="Close (Esc)">✕</button>
        </div>
        <div class="cfm-bar">
            <div style="display:flex;align-items:flex-end;gap:12px">
                <div style="flex:1;max-width:500px">
                    <span class="ppt-label">Select Solution</span>
                    <select class="cfm-select" data-f="solution"><option value="">Loading solutions…</option></select>
                </div>
                <button class="ppt-btn primary" data-act="load" disabled>🔍 Load Flows</button>
            </div>
        </div>
        <div class="cfm-bar" data-part="toolbar" style="display:none">
            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
                <input class="ppt-input" data-f="search" type="text" placeholder="Search flows…" style="flex:1;min-width:200px">
                <div style="display:flex;gap:4px">
                    <button class="cfm-chip active" data-filter="all">All</button>
                    <button class="cfm-chip" data-filter="on">🟢 On</button>
                    <button class="cfm-chip" data-filter="off">⚫ Off</button>
                    <button class="cfm-chip" data-filter="connection-issues" title="Flows with connections set to 'Provided by run-only user' — cannot be used as child flows">⚠️ Child Flow Issues</button>
                </div>
                <div style="display:flex;gap:8px;margin-left:auto">
                    <button class="ppt-btn" data-act="select-all">☐ Select All</button>
                    <button class="cfm-btn-success" data-act="bulk-on" disabled>Turn On Selected</button>
                    <button class="cfm-btn-danger" data-act="bulk-off" disabled>Turn Off Selected</button>
                </div>
            </div>
            <div style="margin-top:8px">
                <span data-part="count" style="font-size:13px;color:var(--muted)"></span>
                <span data-part="selected-count" style="font-size:13px;color:var(--accent);margin-left:12px"></span>
            </div>
        </div>
        <div style="flex:1;overflow-y:auto">
            <div data-part="list" style="padding:8px 24px 16px">
                <div class="cfm-center"><span style="font-size:48px;margin-bottom:16px">⚡</span>Select a solution and click "Load Flows" to view cloud flows.</div>
            </div>
        </div>`;
    backdrop.appendChild(panel);

    const $ = (sel) => panel.querySelector(sel);
    const list = $('[data-part=list]');
    const countEl = $('[data-part=count]');
    const selectedCountEl = $('[data-part=selected-count]');
    const solutionSelect = $('[data-f=solution]');
    const loadBtn = $('[data-act=load]');
    $('[data-act=close]').addEventListener('click', dispose);

    const getFlowStatus = (flow) => {
        if (flow.msdyn_status !== undefined) return flow.msdyn_status === 0 ? 0 : 1;
        const statusName = (flow.msdyn_statusname ?? '').toLowerCase();
        return /aktiv|active|on/.test(statusName) ? 1 : 0;
    };

    function getFilteredFlows() {
        return state.flows.filter((flow) => {
            const status = getFlowStatus(flow);
            if (state.filter === 'on' && status !== 1) return false;
            if (state.filter === 'off' && status !== 0) return false;
            if (state.filter === 'connection-issues' && !state.connectionIssues.get(flow.msdyn_objectid)?.hasIssue) return false;
            if (state.searchText) {
                const name = (flow.msdyn_displayname || flow.msdyn_name || '').toLowerCase();
                const owner = (flow.msdyn_owner ?? '').toLowerCase();
                if (!name.includes(state.searchText) && !owner.includes(state.searchText)) return false;
            }
            return true;
        });
    }

    function updateBulkButtons() {
        const hasSelection = state.selectedFlows.size > 0;
        $('[data-act=bulk-on]').disabled = !hasSelection;
        $('[data-act=bulk-off]').disabled = !hasSelection;
        const filtered = getFilteredFlows();
        const allSelected = filtered.length > 0 && filtered.every((f) => state.selectedFlows.has(f.msdyn_objectid));
        $('[data-act=select-all]').textContent = allSelected ? '☑ Deselect All' : '☐ Select All';
        selectedCountEl.textContent = state.selectedFlows.size > 0 ? `${state.selectedFlows.size} selected` : '';
    }

    function renderConnectorIconsCell(workflowId) {
        const connInfo = state.connectionIssues.get(workflowId);
        if (!connInfo?.connections?.length) return '';
        const seen = new Set();
        const unique = [];
        for (const c of connInfo.connections) {
            if (c.connectorApiName && !seen.has(c.connectorApiName)) {
                seen.add(c.connectorApiName);
                unique.push({ apiName: c.connectorApiName, displayName: c.connectorName });
            }
        }
        if (!unique.length) return '';
        const shown = unique.slice(0, 5);
        let html = shown.map((c) => connectorIconHtml(panel, c)).join('');
        if (unique.length > 5) html += `<span class="more" title="${unique.length - 5} more connector(s)">+${unique.length - 5}</span>`;
        return `<div class="cfm-icons">${html}</div>`;
    }

    async function getSavedConnectionMappings() {
        return (await getEnvData()).connectionMappings ?? {};
    }

    async function renderFlowList() {
        const filtered = getFilteredFlows();
        const onCount = state.flows.filter((f) => getFlowStatus(f) === 1).length;
        const issueCount = [...state.connectionIssues.values()].filter((ci) => ci.hasIssue).length;
        countEl.innerHTML = `${state.flows.length} flows (${onCount} on, ${state.flows.length - onCount} off)`
            + (issueCount ? ` — <span style="color:${ISSUE_COLOR}">⚠️ ${issueCount} with connection issues</span>` : '')
            + ` — Showing ${filtered.length}`;
        updateBulkButtons();

        if (!filtered.length) {
            list.innerHTML = '<div class="cfm-center"><span style="font-size:36px;margin-bottom:12px">📭</span>No flows found matching your criteria.</div>';
            return;
        }

        const savedMappings = await getSavedConnectionMappings();
        list.innerHTML = `
            <table class="cfm-table">
                <thead><tr>
                    <th style="width:40px"></th><th style="width:60px">Status</th><th style="width:40px">Connectors</th>
                    <th>Flow Name</th><th style="width:180px">Owner</th><th style="width:150px">Modified</th><th style="width:260px">Action</th>
                </tr></thead>
                <tbody>
                ${filtered.map((flow) => {
                    const workflowId = flow.msdyn_objectid;
                    const name = flow.msdyn_displayname || flow.msdyn_name || 'Unnamed Flow';
                    const status = getFlowStatus(flow);
                    const isOn = status === 1;
                    const color = STATUS_COLORS[status];
                    const connInfo = state.connectionIssues.get(workflowId);
                    let warning = '';
                    let connBtns = '';
                    if (connInfo?.hasIssue) {
                        const problems = connInfo.connections.filter((c) => c.runtimeSource === 'Provided by run-only user');
                        const allMapped = problems.every((c) => savedMappings[c.connectorApiName]);
                        warning = `<div class="cfm-warn-note">⚠️ ${problems.length} connection(s) set to "Provided by run-only user" — cannot be used as child flow</div>`;
                        connBtns = allMapped
                            ? `<button class="cfm-outline success" data-row-act="quickfix" data-id="${workflowId}" title="Apply saved connection mappings">⚡ Quick Fix</button>
                               <button class="cfm-outline warning" data-row-act="conn" data-id="${workflowId}" title="View details">⚙️</button>`
                            : `<button class="cfm-outline warning" data-row-act="conn" data-id="${workflowId}" title="View connection issues and how to fix them">🔧 Fix</button>`;
                    }
                    return `<tr>
                        <td style="text-align:center"><input type="checkbox" data-row-check="${workflowId}" ${state.selectedFlows.has(workflowId) ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--accent)"></td>
                        <td><span class="cfm-badge" style="background:${color}15;color:${color};border:1px solid ${color}30">${STATUS_ICONS[status]} ${STATUS_LABELS[status]}</span></td>
                        <td>${renderConnectorIconsCell(workflowId)}</td>
                        <td><span style="font-weight:500">${escapeHtml(name)}</span>
                            ${flow.msdyn_description ? `<div style="font-size:12px;color:var(--muted);margin-top:2px">${escapeHtml(truncateText(flow.msdyn_description, 100))}</div>` : ''}
                            ${warning}</td>
                        <td style="color:var(--muted);font-size:13px">${escapeHtml(flow.msdyn_owner ?? '')}</td>
                        <td style="color:var(--muted);font-size:13px">${formatDateTime(flow.msdyn_modifiedon)}</td>
                        <td><div style="display:flex;gap:6px;flex-wrap:wrap">
                            ${connBtns}
                            <button class="cfm-outline primary" data-row-act="open" data-id="${workflowId}" title="Open in Power Automate">🔗 Open</button>
                            <button class="cfm-outline ${isOn ? 'danger' : 'success'}" data-row-act="toggle" data-id="${workflowId}">${isOn ? 'Turn Off' : 'Turn On'}</button>
                            <button class="cfm-outline primary" data-row-act="deps" data-id="${workflowId}" title="View flow dependencies">🔀 Deps</button>
                        </div></td>
                    </tr>`;
                }).join('')}
                </tbody>
            </table>`;

        for (const checkbox of list.querySelectorAll('[data-row-check]')) {
            checkbox.addEventListener('change', () => {
                const id = checkbox.dataset.rowCheck;
                if (checkbox.checked) state.selectedFlows.add(id);
                else state.selectedFlows.delete(id);
                updateBulkButtons();
            });
        }
        for (const btn of list.querySelectorAll('[data-row-act]')) {
            const flow = state.flows.find((f) => f.msdyn_objectid === btn.dataset.id);
            if (!flow) continue;
            const actions = {
                toggle: () => toggleSingleFlow(flow, btn),
                open: () => openFlowInPowerAutomate(flow, btn),
                conn: () => showConnectionIssueDialog(flow),
                quickfix: () => quickFixConnections(flow, btn),
                deps: () => showDependencyDialog(flow),
            };
            btn.addEventListener('click', actions[btn.dataset.rowAct]);
        }
    }

    function showListLoading(message) {
        list.innerHTML = `<div class="cfm-center"><div class="cfm-spinner"></div><p style="margin:16px 0 0">${escapeHtml(message)}</p></div>`;
    }

    // ── Solution loading ─────────────────────────────────────────────────
    async function loadSolutions() {
        try {
            const solutions = await fetchSolutions();
            solutionSelect.replaceChildren(
                ui.el('option', { value: '', textContent: '-- Select a solution --' }),
                ...solutions.map((s) => ui.el('option', {
                    value: s.solutionid,
                    textContent: (s.friendlyname || s.uniquename) + (s.ismanaged ? ' (Managed)' : ''),
                })));
            const saved = (await getEnvData()).solutionId;
            if (saved && solutions.some((s) => s.solutionid === saved)) {
                solutionSelect.value = saved;
                loadBtn.disabled = false;
                return true;
            }
            loadBtn.disabled = true;
            return false;
        } catch (e) {
            solutionSelect.replaceChildren(ui.el('option', { value: '', textContent: 'Failed to load solutions' }));
            ui.toast(`Failed to load solutions: ${e.message}`, 5000);
            return false;
        }
    }

    async function loadFlows() {
        const solutionId = solutionSelect.value;
        if (!solutionId) return;
        state.solutionId = solutionId;
        state.solutionName = solutionSelect.options[solutionSelect.selectedIndex].text;
        state.solutionIsManaged = solutionsCache?.find((s) => s.solutionid === solutionId)?.ismanaged ?? false;
        state.devEnvironmentUrl = null;
        await setEnvData({ solutionId });

        showListLoading(`Loading cloud flows from "${state.solutionName}"…`);
        try {
            state.flows = await fetchCloudFlows(solutionId);
            state.selectedFlows = new Set();
            state.connectionIssues = new Map();
            $('[data-part=toolbar]').style.display = 'block';
            await renderFlowList();

            if (state.flows.length) {
                countEl.innerHTML += ` <span style="color:#835C00"><span class="cfm-spinner-sm" style="margin-right:4px"></span>Checking connections…</span>`;
                const workflowIds = state.flows.map((f) => f.msdyn_objectid).filter(Boolean);
                state.connectionIssues = await fetchWorkflowConnectionDetails(workflowIds);
                await renderFlowList();
                const issueCount = [...state.connectionIssues.values()].filter((ci) => ci.hasIssue).length;
                if (issueCount) ui.toast(`⚠️ ${issueCount} flow(s) have connection issues that prevent use as child flows`, 4500);
            }
        } catch (e) {
            list.innerHTML = '';
            list.appendChild(ui.el('div', { className: 'cfm-center' }, [
                ui.el('span', { style: 'font-size:48px;margin-bottom:16px', textContent: '❌' }),
                ui.el('p', { style: 'margin:0;color:#D13438;max-width:500px', textContent: `Failed to load flows: ${e.message}` }),
                ui.el('button', { className: 'ppt-btn', textContent: 'Try Again', style: 'margin-top:16px', onclick: loadFlows }),
            ]));
        }
    }

    // ── Row actions ──────────────────────────────────────────────────────
    async function openFlowInPowerAutomate(flow, btn) {
        if (btn) { btn.disabled = true; btn.innerHTML = '<span class="cfm-spinner-sm"></span>'; }
        try {
            const environmentId = await fetchEnvironmentId();
            if (!environmentId) {
                showResultDialog('Cannot Open Flow', 'Could not determine environment ID. Please open the flow manually from Power Automate.', 'error');
                return;
            }
            window.open(`https://make.powerautomate.com/environments/${environmentId}/solutions/${state.solutionId}/flows/${flow.msdyn_objectid}/details`, '_blank');
        } catch (e) {
            showResultDialog('Cannot Open Flow', `Error: ${e.message}`, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '🔗 Open'; }
        }
    }

    async function toggleSingleFlow(flow, btn) {
        const turnOn = getFlowStatus(flow) !== 1;
        const flowName = flow.msdyn_displayname || flow.msdyn_name || 'Flow';
        if (btn) { btn.disabled = true; btn.innerHTML = '<span class="cfm-spinner-sm"></span>'; }
        try {
            await toggleFlowState(flow.msdyn_objectid, turnOn);
            flow.msdyn_status = turnOn ? 1 : 0;
            await renderFlowList();
            showResultDialog(turnOn ? 'Flow Turned On' : 'Flow Turned Off', `"${flowName}" has been ${turnOn ? 'turned on' : 'turned off'} successfully.`, 'success');
        } catch (e) {
            showResultDialog('Failed to Toggle Flow', `Could not ${turnOn ? 'turn on' : 'turn off'} "${flowName}".\n\nError: ${e.message}`, 'error');
            if (btn) { btn.disabled = false; btn.textContent = turnOn ? 'Turn On' : 'Turn Off'; }
        }
    }

    async function bulkToggle(turnOn) {
        if (!state.selectedFlows.size) return;
        const action = turnOn ? 'turn on' : 'turn off';
        const confirmed = await ui.confirmDialog(
            `Are you sure you want to ${action} ${state.selectedFlows.size} flow(s)?`,
            { title: `${turnOn ? 'Turn On' : 'Turn Off'} Flows`, okLabel: turnOn ? 'Turn On' : 'Turn Off' });
        if (!confirmed) return;

        showListLoading(`${turnOn ? 'Turning on' : 'Turning off'} ${state.selectedFlows.size} flows…`);
        const flowUpdates = [...state.selectedFlows].map((workflowId) => ({ workflowId, turnOn }));
        const results = await toggleMultipleFlows(flowUpdates);
        const succeededSet = new Set(results.succeeded);
        for (const flow of state.flows) if (succeededSet.has(flow.msdyn_objectid)) flow.msdyn_status = turnOn ? 1 : 0;

        const details = flowUpdates.map((u) => {
            const flow = state.flows.find((f) => f.msdyn_objectid === u.workflowId);
            return { name: flow?.msdyn_displayname || flow?.msdyn_name || u.workflowId, success: succeededSet.has(u.workflowId) };
        });
        state.selectedFlows = new Set();
        await renderFlowList();

        if (!results.failed.length) {
            showResultDialog(`Flows ${turnOn ? 'Turned On' : 'Turned Off'}`, `Successfully ${turnOn ? 'turned on' : 'turned off'} ${results.succeeded.length} flow(s).`, 'success', details);
        } else if (!results.succeeded.length) {
            showResultDialog('Operation Failed', `Failed to ${action} all ${results.failed.length} flow(s). Check individual flow permissions and try again.`, 'error', details);
        } else {
            showResultDialog('Partial Success', `${results.succeeded.length} flow(s) ${turnOn ? 'turned on' : 'turned off'} successfully. ${results.failed.length} failed.`, 'warning', details);
        }
    }

    // ── Connection fix dialogs ───────────────────────────────────────────
    async function showConnectionIssueDialog(flow) {
        const workflowId = flow.msdyn_objectid;
        const flowName = flow.msdyn_displayname || flow.msdyn_name || 'Unnamed Flow';
        const connInfo = state.connectionIssues.get(workflowId);
        if (!connInfo) { ui.toast('No connection information available'); return; }

        const { dialog, close } = cfmOverlay();
        dialog.style.width = '700px';
        dialog.innerHTML = `
            <div style="padding:24px;overflow-y:auto;flex:1">
                <div style="display:flex;align-items:flex-start;gap:16px;margin-bottom:20px">
                    <div style="width:48px;height:48px;border-radius:50%;background:rgba(245,208,108,0.3);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:24px">🔧</div>
                    <div style="flex:1">
                        <h3 style="margin:0 0 4px;font-size:18px;font-weight:600">Fix Connection Issues</h3>
                        <p style="margin:0;font-size:14px;color:var(--muted)">${escapeHtml(flowName)}</p>
                    </div>
                </div>
                <div class="cfm-center" style="padding:40px"><div class="cfm-spinner"></div><p style="margin:16px 0 0">Loading available connections…</p></div>
            </div>`;

        const problems = connInfo.connections.filter((c) => c.runtimeSource === 'Provided by run-only user');
        const okConnections = connInfo.connections.filter((c) => c.runtimeSource !== 'Provided by run-only user');

        const availableMap = new Map();
        for (const connectorApiName of new Set(problems.map((c) => c.connectorApiName))) {
            availableMap.set(connectorApiName, await fetchAvailableConnections(connectorApiName));
        }
        const savedMappings = await getSavedConnectionMappings();

        let autoFixable = 0;
        const rowsHtml = problems.map((c, index) => {
            const available = availableMap.get(c.connectorApiName) ?? [];
            const savedId = savedMappings[c.connectorApiName]?.connectionId;
            const savedValid = savedId && available.some((a) => (a.connectionId || a.id) === savedId);
            if (savedValid) autoFixable++;
            const selectHtml = available.length
                ? `<select class="cfm-select" data-conn-select="${index}">
                        <option value="">-- Select a connection --</option>
                        ${available.map((a) => {
                            const id = a.connectionId || a.id;
                            return `<option value="${escapeHtml(id)}" ${id === savedId ? 'selected' : ''}>${escapeHtml(a.displayName)}</option>`;
                        }).join('')}
                   </select>${savedValid ? '<span style="color:#107C10;margin-left:8px;font-size:12px" title="Saved mapping">💾</span>' : ''}`
                : '<span style="color:var(--muted);font-style:italic;font-size:12px">No connections found. Create one in Power Automate first.</span>';
            return `<tr>
                <td style="padding:12px;border-bottom:1px solid var(--border);vertical-align:top">
                    <span style="font-weight:500">${escapeHtml(c.connectorName)}</span>
                    <div style="font-size:11px;color:var(--muted);margin-top:2px">${escapeHtml(c.name)}</div>
                </td>
                <td style="padding:12px;border-bottom:1px solid var(--border)">${selectHtml}</td>
            </tr>`;
        }).join('');

        const hasAnyOptions = [...availableMap.values()].some((conns) => conns.length);
        const canQuickFix = problems.length > 0 && autoFixable === problems.length;

        dialog.innerHTML = `
            <div style="padding:24px;overflow-y:auto;flex:1">
                <div style="display:flex;align-items:flex-start;gap:16px;margin-bottom:20px">
                    <div style="width:48px;height:48px;border-radius:50%;background:rgba(245,208,108,0.3);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:24px">🔧</div>
                    <div style="flex:1">
                        <h3 style="margin:0 0 4px;font-size:18px;font-weight:600">Fix Connection Issues</h3>
                        <p style="margin:0;font-size:14px;color:var(--muted)">${escapeHtml(flowName)}</p>
                    </div>
                </div>
                <div class="ppt-note" style="margin-bottom:20px"><strong>Select a connection</strong> for each connector below. This changes the connection from "Provided by run-only user" to embedded, allowing the flow to be used as a child flow.</div>
                ${problems.length ? `
                    <h4 style="margin:0 0 8px;font-size:13px;font-weight:600;color:${ISSUE_COLOR};text-transform:uppercase;letter-spacing:0.5px">⚠ Connections to Fix (${problems.length})</h4>
                    <div style="border:1px solid var(--border);border-radius:4px;overflow:hidden;margin-bottom:16px">
                        <table style="width:100%;border-collapse:collapse;font-size:13px">
                            <thead><tr style="background:var(--bg2)">
                                <th style="text-align:left;padding:10px 12px;border-bottom:1px solid var(--border);width:40%">Connector</th>
                                <th style="text-align:left;padding:10px 12px;border-bottom:1px solid var(--border)">Select Connection</th>
                            </tr></thead>
                            <tbody>${rowsHtml}</tbody>
                        </table>
                    </div>` : ''}
                ${okConnections.length ? `
                    <h4 style="margin:0 0 8px;font-size:13px;font-weight:600;color:#107C10;text-transform:uppercase;letter-spacing:0.5px">✓ OK Connections (${okConnections.length})</h4>
                    <div style="border:1px solid var(--border);border-radius:4px;overflow:hidden;margin-bottom:16px">
                        <table style="width:100%;border-collapse:collapse;font-size:13px"><tbody>
                            ${okConnections.map((c) => `<tr>
                                <td style="padding:8px 12px;border-bottom:1px solid var(--border);font-weight:500">${escapeHtml(c.connectorName)}</td>
                                <td style="padding:8px 12px;border-bottom:1px solid var(--border);color:#107C10">✓ ${escapeHtml(c.runtimeSource)}</td>
                            </tr>`).join('')}
                        </tbody></table>
                    </div>` : ''}
                <div data-part="fix-status" style="display:none;margin-bottom:16px"></div>
                ${canQuickFix ? '<div class="ppt-note" style="color:#107C10">💾 <strong>Saved mappings found!</strong> All connections have been pre-selected from your previous fixes.</div>' : ''}
            </div>
            <div style="padding:16px 24px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
                <button class="ppt-btn" data-act="open-pa" title="Open flow in Power Automate for manual fixing">🔗 Open in Power Automate</button>
                <div style="display:flex;gap:12px">
                    <button class="ppt-btn" data-act="cancel" style="min-width:80px">Cancel</button>
                    <button class="cfm-btn-success" data-act="fix" style="min-width:140px" ${!hasAnyOptions ? 'disabled' : ''}>${canQuickFix ? '⚡ Quick Fix All' : '✓ Fix Connections'}</button>
                </div>
            </div>`;

        dialog.querySelector('[data-act=cancel]').addEventListener('click', close);
        dialog.querySelector('[data-act=open-pa]').addEventListener('click', async () => { close(); await openFlowInPowerAutomate(flow, null); });
        dialog.querySelector('[data-act=fix]').addEventListener('click', async () => {
            const fixBtn = dialog.querySelector('[data-act=fix]');
            const statusEl = dialog.querySelector('[data-part=fix-status]');
            const updates = [];
            problems.forEach((c, index) => {
                const select = dialog.querySelector(`[data-conn-select="${index}"]`);
                if (select?.value) {
                    updates.push({
                        refName: c.name,
                        connectionId: select.value,
                        connectorApiName: c.connectorApiName,
                        displayName: select.options[select.selectedIndex]?.text ?? '',
                    });
                }
            });
            if (!updates.length) {
                statusEl.style.display = 'block';
                statusEl.innerHTML = '<div class="ppt-note" style="color:#D13438">⚠️ Please select at least one connection to fix.</div>';
                return;
            }
            fixBtn.disabled = true;
            fixBtn.innerHTML = '<span class="cfm-spinner-sm"></span> Fixing…';
            statusEl.style.display = 'block';
            statusEl.innerHTML = '<div class="ppt-note">Updating flow connections…</div>';
            try {
                await updateWorkflowConnections(workflowId, updates);
                const mappings = await getSavedConnectionMappings();
                for (const u of updates) mappings[u.connectorApiName] = { connectionId: u.connectionId, displayName: u.displayName };
                await setEnvData({ connectionMappings: mappings });
                applyLocalConnectionFix(connInfo, updates);
                statusEl.innerHTML = `<div class="ppt-note" style="color:#107C10">✓ Successfully fixed ${updates.length} connection(s)!</div>`;
                fixBtn.innerHTML = '✓ Fixed!';
                setTimeout(async () => {
                    close();
                    await renderFlowList();
                    ui.toast(`Fixed ${updates.length} connection(s) in "${flowName}"`);
                }, 1200);
            } catch (e) {
                statusEl.innerHTML = `<div class="ppt-note" style="color:#D13438">❌ Failed to update connections: ${escapeHtml(e.message)}<br><span style="font-size:12px">You may need to fix this manually in Power Automate.</span></div>`;
                fixBtn.disabled = false;
                fixBtn.innerHTML = '✓ Fix Connections';
            }
        });
    }

    function applyLocalConnectionFix(connInfo, updates) {
        for (const update of updates) {
            const conn = connInfo.connections.find((c) => c.name === update.refName);
            if (conn) {
                conn.runtimeSource = 'Embedded (OK)';
                conn.connectionId = update.connectionId;
                conn.isOk = true;
            }
        }
        connInfo.hasIssue = connInfo.connections.some((c) => c.runtimeSource === 'Provided by run-only user');
    }

    async function quickFixConnections(flow, btn) {
        const workflowId = flow.msdyn_objectid;
        const flowName = flow.msdyn_displayname || flow.msdyn_name || 'Unnamed Flow';
        const connInfo = state.connectionIssues.get(workflowId);
        if (!connInfo) { ui.toast('No connection information available'); return; }

        const savedMappings = await getSavedConnectionMappings();
        const updates = connInfo.connections
            .filter((c) => c.runtimeSource === 'Provided by run-only user' && savedMappings[c.connectorApiName]?.connectionId)
            .map((c) => ({
                refName: c.name,
                connectionId: savedMappings[c.connectorApiName].connectionId,
                connectorApiName: c.connectorApiName,
                displayName: savedMappings[c.connectorApiName].displayName ?? '',
            }));
        if (!updates.length) { ui.toast('No saved connection mappings found'); return; }

        const originalHtml = btn?.innerHTML;
        if (btn) { btn.disabled = true; btn.innerHTML = '<span class="cfm-spinner-sm"></span>'; }
        try {
            await updateWorkflowConnections(workflowId, updates);
            applyLocalConnectionFix(connInfo, updates);
            ui.toast(`⚡ Quick fixed ${updates.length} connection(s) in "${flowName}"`);
            await renderFlowList();
        } catch (e) {
            ui.toast(`Failed to fix connections: ${e.message}`, 5000);
            if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
        }
    }

    // ── Dependency dialog ────────────────────────────────────────────────
    async function showDependencyDialog(flow) {
        const workflowId = flow.msdyn_objectid;
        const flowName = flow.msdyn_displayname || flow.msdyn_name || 'Unnamed Flow';

        const { dialog, close } = cfmOverlay();
        dialog.style.width = '900px';
        dialog.style.height = '80vh';

        const headerHtml = (subtitle) => `
            <div style="padding:16px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
                <div style="display:flex;align-items:center;gap:12px">
                    <span style="font-size:24px">🔀</span>
                    <div>
                        <h3 style="margin:0;font-size:18px;font-weight:600">Flow Dependencies</h3>
                        <p style="margin:2px 0 0;font-size:13px;color:var(--muted)">${escapeHtml(subtitle)}</p>
                    </div>
                </div>
                <div data-part="toolbar" style="display:flex;align-items:center;gap:6px"></div>
            </div>`;

        dialog.innerHTML = headerHtml(flowName) + '<div class="cfm-center" style="flex:1"><div class="cfm-spinner"></div><p style="margin:16px 0 0">Analyzing flow dependencies…</p></div>';
        dialog.querySelector('[data-part=toolbar]').appendChild(
            ui.el('button', { className: 'ppt-icon-btn', textContent: '✕', title: 'Close', onclick: close }));

        // Managed solutions: dependency data lives in the unmanaged DEV org.
        // The DEV org is sourced from environments the user labelled in the
        // Environment Indicator, so there's no separate URL to maintain here.
        if (state.solutionIsManaged && state.devEnvironmentUrl == null) {
            const envs = await labelledEnvironments();
            const devEnvs = envs.filter((e) => e.type === 'DEV');
            // The DEV org of this environment's own project is the one that
            // holds this solution unmanaged, so it wins outright even when
            // other projects have a DEV environment too.
            const sameGroupDevs = devEnvs.filter((e) => e.sameGroup);
            const pick = sameGroupDevs.length === 1 ? sameGroupDevs
                : sameGroupDevs.length ? [] : devEnvs;

            // Exactly one candidate DEV environment with a known host → use it
            // silently; no need to make the user choose.
            if (pick.length === 1) {
                state.devEnvironmentUrl = `https://${pick[0].host}`;
            } else {
                renderEnvPicker(envs);
                return;
            }
        }
        await loadDependencies();

        function renderEnvPicker(envs) {
            dialog.innerHTML = headerHtml('Dependencies cannot be retrieved from managed solutions');
            dialog.querySelector('[data-part=toolbar]').appendChild(
                ui.el('button', { className: 'ppt-icon-btn', textContent: '✕', title: 'Close', onclick: close }));

            const useEnv = (env) => { state.devEnvironmentUrl = `https://${env.host}`; loadDependencies(); };

            const envRow = (env) => {
                const badge = ENV_BADGES[env.type];
                // Show the host until the friendly name resolves; then promote the
                // name to the top line and drop the host to a muted subline. The
                // registry usually knows the name already — the fetch is only for
                // environments labelled before it started recording them.
                const nameEl = ui.el('div', { style: 'font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap', textContent: env.name || env.host });
                const hostEl = ui.el('div', { style: 'font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap', textContent: env.name ? env.host : '' });
                if (!env.name) {
                    resolveOrgName(env.host).then((name) => {
                        if (name) { nameEl.textContent = name; hostEl.textContent = env.host; }
                    });
                }
                return ui.el('button', {
                    className: 'cfm-outline',
                    style: 'display:flex;align-items:center;gap:12px;width:100%;text-align:left;padding:10px 12px;margin-bottom:8px',
                    onclick: () => useEnv(env),
                }, [
                    ui.el('span', {
                        textContent: badge ? `${badge.icon} ${env.type}` : env.type,
                        style: badge
                            ? `color:${badge.color};background:${badge.bg};border:1px solid ${badge.border};padding:2px 10px;border-radius:3px;font-weight:700;font-size:11px;flex-shrink:0`
                            : 'flex-shrink:0',
                    }),
                    ui.el('div', { style: 'flex:1;min-width:0' }, [nameEl, hostEl]),
                    ...(env.sameGroup ? [ui.el('span', {
                        style: 'color:var(--muted);font-size:11px;flex-shrink:0',
                        textContent: 'same project',
                    })] : []),
                    ui.el('span', { style: 'color:var(--accent);font-weight:600;font-size:12px;flex-shrink:0', textContent: 'Use →' }),
                ]);
            };

            const body = ui.el('div', { style: 'padding:24px;flex:1;overflow-y:auto' }, [
                ui.el('div', { className: 'ppt-note', style: 'color:#835C00;margin-bottom:16px' }, [
                    ui.el('strong', { textContent: '⚠️ Managed Solution: ' }),
                    'Flow dependency lookups require access to the unmanaged (DEV) version of this solution.',
                ]),
            ]);

            if (envs.length) {
                body.append(
                    ui.el('span', { className: 'ppt-label', textContent: 'Read dependencies from' }),
                    ...envs.map(envRow),
                    ui.el('p', { style: 'margin:8px 0 0;font-size:12px;color:var(--muted)', textContent: 'These are the environments you’ve labelled in the Environment Indicator. Label your DEV environment there to add it here.' }),
                );
            } else {
                body.append(ui.el('div', { className: 'ppt-note', style: 'color:var(--muted)' },
                    ['No labelled environments with a known URL were found. Open your DEV environment and label it 🔧 DEV in the Environment Indicator, then reopen this dialog.']));
            }

            dialog.append(
                body,
                ui.el('div', { style: 'padding:16px 24px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;flex-shrink:0' }, [
                    ui.el('button', {
                        className: 'ppt-btn', textContent: 'Skip (Use Current)',
                        onclick: () => { state.devEnvironmentUrl = ''; loadDependencies(); },
                    }),
                ]),
            );
        }

        async function loadDependencies() {
            dialog.innerHTML = headerHtml(`Analyzing dependencies for "${flowName}"…`)
                + '<div class="cfm-center" style="flex:1"><div class="cfm-spinner"></div><p style="margin:16px 0 0">Fetching flow dependencies…</p></div>';
            dialog.querySelector('[data-part=toolbar]').appendChild(
                ui.el('button', { className: 'ppt-icon-btn', textContent: '✕', title: 'Close', onclick: close }));

            let deps;
            try {
                deps = await fetchFlowDependencies(state, workflowId, 5, state.devEnvironmentUrl || null);
            } catch (e) {
                dialog.innerHTML = headerHtml('Error analyzing dependencies');
                dialog.querySelector('[data-part=toolbar]').appendChild(
                    ui.el('button', { className: 'ppt-icon-btn', textContent: '✕', title: 'Close', onclick: close }));
                dialog.append(ui.el('div', { style: 'padding:24px;color:var(--muted)', textContent: e.message }));
                return;
            }

            let showNested = false;
            let viewMode = 'diagram';
            let zoom = 1;

            dialog.innerHTML = headerHtml(`Dependency diagram for "${flowName}"`);
            const toolbar = dialog.querySelector('[data-part=toolbar]');
            const zoomLabel = ui.el('span', { style: 'font-size:11px;font-weight:600;color:var(--muted);min-width:38px;text-align:center', textContent: '100%' });
            const nestedCheckbox = ui.el('input', { type: 'checkbox', style: 'accent-color:var(--accent)' });
            const diagramBtn = ui.el('button', { className: 'fd-zoom-btn', textContent: '📊', title: 'Diagram view', style: 'background:var(--border)' });
            const listViewBtn = ui.el('button', { className: 'fd-zoom-btn', textContent: '📋', title: 'List view' });
            toolbar.append(
                diagramBtn, listViewBtn,
                ui.el('label', { style: 'display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--muted);cursor:pointer', title: 'Show nested dependencies' }, [nestedCheckbox, 'Nested']),
                ui.el('button', { className: 'fd-zoom-btn', textContent: '📥', title: 'Export CSV', onclick: () => exportDependencies(deps, flowName) }),
                ui.el('button', { className: 'fd-zoom-btn', textContent: '−', title: 'Zoom out', onclick: () => setZoom(zoom - 0.25) }),
                zoomLabel,
                ui.el('button', { className: 'fd-zoom-btn', textContent: '+', title: 'Zoom in', onclick: () => setZoom(zoom + 0.25) }),
                ui.el('button', { className: 'fd-zoom-btn', textContent: '⟲', title: 'Reset zoom', style: 'font-size:12px', onclick: () => { setZoom(1); setTimeout(centerOnTarget, 50); } }),
                ui.el('button', { className: 'ppt-icon-btn', textContent: '⛶', title: 'Toggle fullscreen', onclick: () => dialog.classList.toggle('fullscreen') }),
                ui.el('button', { className: 'ppt-icon-btn', textContent: '✕', title: 'Close', onclick: close }),
            );

            const dragEl = ui.el('div', { className: 'fd-drag' });
            const zoomEl = ui.el('div', { className: 'fd-zoom' });
            dragEl.appendChild(zoomEl);
            const selectedName = ui.el('span', { style: 'font-size:13px;font-weight:600;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' });
            const openFlowBtn = ui.el('button', { className: 'cfm-outline primary', textContent: '🔗 Open Flow' });
            const selectedActions = ui.el('div', { style: 'display:none;align-items:center;gap:12px' }, [selectedName, openFlowBtn]);
            const footer = ui.el('div', { style: 'padding:12px 24px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-shrink:0' }, [
                ui.el('span', { style: 'font-size:12px;color:var(--muted)', textContent: `⬆️ ${deps.parents.length + deps.canvasApps.length} parent(s)   ⬇️ ${deps.children.length} child(ren)${state.devEnvironmentUrl ? '   🔗 DEV' : ''}` }),
                selectedActions,
                ui.el('button', { className: 'ppt-btn primary', textContent: 'Close', style: 'min-width:80px', onclick: close }),
            ]);
            dialog.append(dragEl, footer);

            let selectedFlowId = null;
            let selectedInSolution = false;

            function handleCardClick(e) {
                e.stopPropagation();
                zoomEl.querySelectorAll('.fd-card').forEach((c) => c.classList.remove('selected'));
                this.classList.add('selected');
                selectedFlowId = this.dataset.workflowId;
                selectedInSolution = this.dataset.inSolution === 'true';
                selectedName.textContent = this.dataset.flowName;
                selectedName.title = this.dataset.flowName;
                selectedActions.style.display = 'flex';
            }

            openFlowBtn.addEventListener('click', async () => {
                if (!selectedFlowId) return;
                openFlowBtn.disabled = true;
                try {
                    const environmentId = await fetchEnvironmentId();
                    if (!environmentId) { ui.toast('Could not determine environment ID'); return; }
                    const url = selectedInSolution && state.solutionId
                        ? `https://make.powerautomate.com/environments/${environmentId}/solutions/${state.solutionId}/flows/${selectedFlowId}/details`
                        : `https://make.powerautomate.com/environments/${environmentId}/flows/${selectedFlowId}/details`;
                    window.open(url, '_blank');
                } finally {
                    openFlowBtn.disabled = false;
                }
            });

            function setZoom(next) {
                zoom = Math.max(0.25, Math.min(2, next));
                zoomEl.style.transform = `scale(${zoom})`;
                zoomLabel.textContent = Math.round(zoom * 100) + '%';
            }
            function centerOnTarget() {
                const target = zoomEl.querySelector('.fd-card-target');
                if (!target) return;
                const rect = dragEl.getBoundingClientRect();
                dragEl.scrollLeft = (target.offsetLeft + target.offsetWidth / 2) * zoom - rect.width / 2;
                dragEl.scrollTop = (target.offsetTop + target.offsetHeight / 2) * zoom - rect.height / 2;
            }

            const renderIcon = (connectors) => connectors?.length
                ? `<div class="fd-icon-stack">${connectors.map((c) => connectorIconHtml(dialog, c)).join('')}</div>`
                : `<div class="fd-icon-stack"><img src="${FLOW_FALLBACK_ICON}" alt="Flow"></div>`;

            const renderCard = (node, label, extraClass = '') => `
                <div class="fd-card fd-action-clickable ${extraClass}" data-workflow-id="${escapeHtml(node.workflowId)}" data-flow-name="${escapeHtml(node.name)}" data-in-solution="${node.inSolution ? 'true' : 'false'}">
                    ${renderIcon(node.connectors)}
                    <div style="flex:1;min-width:0">
                        <div class="name" title="${escapeHtml(node.name)}">${escapeHtml(truncateText(node.name, 36))}</div>
                        <div class="label">${label}</div>
                    </div>
                    ${!node.inSolution ? '<span class="tag">External</span>' : ''}
                </div>`;

            function renderScope(node, key, depth = 0) {
                const label = depth === 0 ? (key === 'parents' ? 'Parent Flow' : 'Child Flow') : `${key === 'parents' ? 'Ancestor' : 'Descendant'} (Level ${depth + 1})`;
                const nested = showNested && node[key]?.length;
                if (!nested) return renderCard(node, label);
                return `<div class="fd-scope-wrapper">
                    <div class="fd-scope-header">${renderCard(node, label)}</div>
                    <div class="fd-scope-body"><div class="fd-scope-children">
                        ${node[key].map((child) => renderScope(child, key, depth + 1)).join('')}
                    </div></div>
                </div>`;
            }

            function buildDiagramHtml() {
                const hasCallers = deps.parents.length || deps.canvasApps.length;
                const canvasCards = deps.canvasApps.map((app) => `
                    <div class="fd-card">
                        <div class="fd-icon-stack"><img src="${CANVAS_APP_ICON}" alt="Canvas App"></div>
                        <div style="flex:1;min-width:0">
                            <div class="name" title="${escapeHtml(app.name)}">${escapeHtml(truncateText(app.name, 36))}</div>
                            <div class="label">Canvas App</div>
                        </div>
                    </div>`).join('');
                return `<div class="fd-diagram">
                    <div class="fd-section">
                        <div class="fd-section-label"><span>Used By</span><span class="fd-count">${deps.canvasApps.length + deps.parents.length}</span></div>
                        ${hasCallers
                            ? `<div class="fd-scopes-row">${canvasCards}${deps.parents.map((p) => renderScope(p, 'parents')).join('')}</div>`
                            : '<div class="fd-empty">○ No apps or flows call this flow</div>'}
                    </div>
                    ${hasCallers ? '<div class="fd-connector">▼</div>' : ''}
                    <div class="fd-target-section">${renderCard({ workflowId, name: deps.targetFlowName, inSolution: true, connectors: deps.targetConnectors }, 'Selected Flow', 'fd-card-target')}</div>
                    ${deps.children.length ? '<div class="fd-connector">▼</div>' : ''}
                    <div class="fd-section">
                        <div class="fd-section-label"><span>Uses</span><span class="fd-count">${deps.children.length}</span></div>
                        ${deps.children.length
                            ? `<div class="fd-scopes-row">${deps.children.map((c) => renderScope(c, 'children')).join('')}</div>`
                            : '<div class="fd-empty">○ This flow doesn’t call any child flows</div>'}
                    </div>
                    <div class="fd-info">ℹ Shows up to 5 levels deep. Nested scopes indicate deeper dependencies.</div>
                </div>`;
            }

            function flattenNodes(nodes, key, type, level = 1) {
                let result = [];
                for (const node of nodes) {
                    result.push({ id: node.workflowId || node.canvasAppId, name: node.name, type, level, inSolution: node.inSolution, isCanvasApp: !!node.canvasAppId });
                    if (showNested && node[key]?.length) result = result.concat(flattenNodes(node[key], key, type, level + 1));
                }
                return result;
            }

            function buildListHtml() {
                const usedBy = [
                    ...deps.canvasApps.map((app) => ({ id: app.canvasAppId, name: app.name, type: 'Canvas App', level: 1, inSolution: false, isCanvasApp: true })),
                    ...flattenNodes(deps.parents, 'parents', 'Flow'),
                ];
                const uses = flattenNodes(deps.children, 'children', 'Flow');
                const renderItem = (item) => `<tr>
                    <td style="width:24px">${item.isCanvasApp ? '🖼️' : '⚡'}</td>
                    <td><span title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
                        ${item.level > 1 ? `<span style="color:var(--muted);font-size:11px"> (Level ${item.level})</span>` : ''}
                        ${!item.inSolution && !item.isCanvasApp ? `<span style="color:${ISSUE_COLOR};font-size:10px;font-weight:700;text-transform:uppercase"> External</span>` : ''}</td>
                    <td style="width:90px;color:var(--muted)">${escapeHtml(item.type)}</td>
                </tr>`;
                const column = (title, items, emptyText) => `
                    <div class="fd-list-column">
                        <div class="fd-list-column-header"><span>${title}</span><span class="fd-count">${items.length}</span></div>
                        <div style="max-height:50vh;overflow-y:auto"><table class="fd-list-table"><tbody>
                            ${items.map(renderItem).join('') || `<tr><td colspan="3" style="text-align:center;color:var(--muted);padding:16px">${emptyText}</td></tr>`}
                        </tbody></table></div>
                    </div>`;
                return `<div class="fd-list">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;font-weight:600">⚡ ${escapeHtml(deps.targetFlowName)}</div>
                    <div class="fd-list-columns">
                        ${column('Used By', usedBy, 'No apps or flows depend on this flow')}
                        ${column('Uses', uses, 'This flow doesn’t call any child flows')}
                    </div>
                    <div class="fd-info">ℹ ${showNested ? 'Showing all nested dependencies.' : 'Showing direct dependencies only. Enable "Nested" to see all levels.'}</div>
                </div>`;
            }

            function rerender() {
                zoomEl.innerHTML = viewMode === 'diagram' ? buildDiagramHtml() : buildListHtml();
                for (const card of zoomEl.querySelectorAll('.fd-action-clickable')) card.addEventListener('click', handleCardClick);
                if (viewMode === 'diagram') setTimeout(centerOnTarget, 50);
            }

            nestedCheckbox.addEventListener('change', () => { showNested = nestedCheckbox.checked; rerender(); });
            diagramBtn.addEventListener('click', () => {
                viewMode = 'diagram';
                diagramBtn.style.background = 'var(--border)';
                listViewBtn.style.background = '';
                setZoom(1);
                rerender();
            });
            listViewBtn.addEventListener('click', () => {
                viewMode = 'list';
                listViewBtn.style.background = 'var(--border)';
                diagramBtn.style.background = '';
                setZoom(1);
                rerender();
            });

            // Drag-to-pan + Ctrl+wheel zoom
            let drag = null;
            dragEl.addEventListener('mousedown', (e) => {
                if (e.target.closest('button, a, .fd-card')) return;
                drag = { x: e.pageX, y: e.pageY, left: dragEl.scrollLeft, top: dragEl.scrollTop };
                dragEl.classList.add('dragging');
            });
            const endDrag = () => { drag = null; dragEl.classList.remove('dragging'); };
            dragEl.addEventListener('mouseup', endDrag);
            dragEl.addEventListener('mouseleave', endDrag);
            dragEl.addEventListener('mousemove', (e) => {
                if (!drag) return;
                e.preventDefault();
                dragEl.scrollLeft = drag.left - (e.pageX - drag.x) * 1.5;
                dragEl.scrollTop = drag.top - (e.pageY - drag.y) * 1.5;
            });
            dragEl.addEventListener('wheel', (e) => {
                if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(zoom + (e.deltaY > 0 ? -0.25 : 0.25)); }
            }, { passive: false });
            dragEl.addEventListener('click', (e) => {
                if (e.target === dragEl || e.target === zoomEl) {
                    zoomEl.querySelectorAll('.fd-card').forEach((c) => c.classList.remove('selected'));
                    selectedActions.style.display = 'none';
                    selectedFlowId = null;
                }
            });

            rerender();
        }
    }

    function exportDependencies(deps, flowName) {
        const flatten = (nodes, key, type, level = 1) => nodes.flatMap((node) => [
            { name: node.name, type, level, inSolution: node.inSolution ? 'Yes' : 'No', id: node.workflowId || node.canvasAppId },
            ...(node[key]?.length ? flatten(node[key], key, type, level + 1) : []),
        ]);
        const usedBy = [
            ...deps.canvasApps.map((app) => ({ name: app.name, type: 'Canvas App', level: 1, inSolution: 'N/A', id: app.canvasAppId })),
            ...flatten(deps.parents, 'parents', 'Flow'),
        ];
        const uses = flatten(deps.children, 'children', 'Flow');
        const lines = ['Direction;Name;Type;Level;In Solution;ID'];
        const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
        for (const item of usedBy) lines.push(`${cell('Used By')};${cell(item.name)};${cell(item.type)};${item.level};${cell(item.inSolution)};${cell(item.id)}`);
        for (const item of uses) lines.push(`${cell('Uses')};${cell(item.name)};${cell(item.type)};${item.level};${cell(item.inSolution)};${cell(item.id)}`);
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' }));
        link.download = `${flowName.replace(/[^a-z0-9]/gi, '_')}_dependencies.csv`;
        link.click();
        URL.revokeObjectURL(link.href);
        ui.toast(`Exported ${usedBy.length + uses.length} dependencies to CSV`);
    }

    // ── Wiring ───────────────────────────────────────────────────────────
    solutionSelect.addEventListener('change', () => { loadBtn.disabled = !solutionSelect.value; });
    loadBtn.addEventListener('click', loadFlows);
    $('[data-f=search]').addEventListener('input', (e) => { state.searchText = e.target.value.toLowerCase(); renderFlowList(); });
    for (const chip of panel.querySelectorAll('.cfm-chip')) {
        chip.addEventListener('click', () => {
            panel.querySelectorAll('.cfm-chip').forEach((c) => c.classList.remove('active'));
            chip.classList.add('active');
            state.filter = chip.dataset.filter;
            renderFlowList();
        });
    }
    $('[data-act=select-all]').addEventListener('click', () => {
        const filtered = getFilteredFlows();
        const allSelected = filtered.every((f) => state.selectedFlows.has(f.msdyn_objectid));
        for (const f of filtered) {
            if (allSelected) state.selectedFlows.delete(f.msdyn_objectid);
            else state.selectedFlows.add(f.msdyn_objectid);
        }
        renderFlowList();
    });
    $('[data-act=bulk-on]').addEventListener('click', () => bulkToggle(true));
    $('[data-act=bulk-off]').addEventListener('click', () => bulkToggle(false));

    // Initial load — optionally pre-select a solution handed off by the deployer,
    // or the one the maker-portal page is showing.
    const restored = await loadSolutions();
    const urlSolutionId = location.pathname.match(/\/solutions\/([0-9a-f-]{36})/i)?.[1]?.toLowerCase();
    const preselect = preselectSolutionUniqueName
        ? (s) => s.uniquename?.toLowerCase() === preselectSolutionUniqueName.toLowerCase()
        : urlSolutionId && ((s) => s.solutionid === urlSolutionId);
    if (preselect && solutionsCache) {
        const match = solutionsCache.find(preselect);
        if (match) {
            solutionSelect.value = match.solutionid;
            loadBtn.disabled = false;
            await setEnvData({ solutionId: match.solutionid });
            loadFlows();
        } else if (preselectSolutionUniqueName) {
            ui.toast(`Solution "${preselectSolutionUniqueName}" not found in this environment`, 4500);
        } else if (restored) {
            loadFlows();
        }
    } else if (restored) {
        loadFlows();
    }
}

// ── Solution Deployer handoff (open_request in this tool's namespace) ─────
// The request survives being claimed: opening an environment at /main.aspx
// lands on the app shell, which then redirects into the default app, and that
// navigation takes the freshly opened panel with it. So the request is only
// dropped once the panel has actually been dismissed by the user — the next
// document in that tab re-opens it — with a TTL so a request nobody ever
// answered cannot haunt the tab forever.
const OPEN_REQUEST_TTL_MS = 5 * 60 * 1000;
let ownTabId;

async function claimOpenRequest(req) {
    if (!req?.targetOrigin || req.targetOrigin !== location.origin) return;
    if (Date.now() - (req.ts ?? 0) > OPEN_REQUEST_TTL_MS) { await store.remove('open_request'); return; }
    if (req.tabId != null) {
        ownTabId ??= (await callExtension(() => chrome.runtime.sendMessage({ type: 'whoami' }), null))?.tabId ?? null;
        if (ownTabId !== req.tabId) return;
    }
    if (panelOpen) { await store.remove('open_request'); return; } // already where it wanted us
    openCloudFlowManager(req.solution ?? null, {
        onDismiss: () => store.remove('open_request').catch(() => { /* nothing left to clean up */ }),
    });
}

export default {
    async init({ store: toolStore }) {
        store = toolStore;
        ui.addStyle('cfm', STYLE);
        commands.register({ toolId: 'cloud-flow-manager', title: 'Open Cloud Flow Manager', icon: '⚡', svg: 'flow', run: () => openCloudFlowManager() });
        store.watch('open_request', (req) => claimOpenRequest(req));
        claimOpenRequest(await store.get('open_request', null));
    },
};
