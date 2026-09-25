// Deep Clone (native).
// Clones the current Dataverse record: either opens a prefilled "new record"
// form (review before saving), creates the record immediately in this org, or
// copies it into another environment — optionally keeping the original GUID —
// deep-inserting selected 1:N child records. Notes with files ride along;
// files over 4MB are uploaded afterwards via the annotation block-upload API.
//
// Cross-environment writes go through the same Dataverse client pointed at the
// target org: requests are relayed by the service worker with the user's own
// cookies, so the user must already be signed in to the target environment.

import { Dataverse } from '../core/dataverse.js';
import { request } from '../core/http.js';
import { createStore } from '../core/storage.js';
import * as ui from '../core/ui.js';
import * as commands from '../core/commands.js';
import { ACTIONS, buildClonePlan, isSimpleTree } from './shared/clone-graph.js';
import { ENV_TYPES, groupEnvironments, loadEnvironments } from './shared/environments.js';

const API = '/api/data/v9.2';
const ANNOTATIONS = { Prefer: 'odata.include-annotations="*"' };
const MAX_ANNOTATION_FILE_SIZE = 4 * 1024 * 1024; // larger files use block upload
const UPLOAD_BLOCK_SIZE = 4 * 1024 * 1024;

const SYSTEM_FIELDS = [
    'createdon', 'createdby', 'modifiedon', 'modifiedby',
    'ownerid', 'owninguser', 'owningteam', 'owningbusinessunit',
    'versionnumber', 'timezoneruleversionnumber',
    'utcconversiontimezonecode', 'overriddencreatedon', 'importsequencenumber',
    'organizationid', 'transactioncurrencyid', 'exchangerate',
    '_createdby_value', '_modifiedby_value', '_ownerid_value',
    '_owninguser_value', '_owningteam_value', '_owningbusinessunit_value',
    '_organizationid_value', '_transactioncurrencyid_value',
    'address1_addressid', 'address2_addressid', 'address3_addressid',
    'activityid', 'activitypartyid',
];

const READONLY_FIELDS = [
    'fullname', 'yominame', 'address1_composite', 'address2_composite',
    'entityimage_url', 'entityimage_timestamp', 'paymenttermscode',
    'createdonbehalfby', 'modifiedonbehalfby', 'processid', 'stageid',
    'traversedpath', 'slainvokedid', 'onholdtime', 'lastonholdtime',
    'adx_identity_username', 'adx_identity_securitystamp',
    'adx_identity_passwordhash', 'adx_identity_accessfailedcount',
    'adx_identity_lockoutenddate', 'adx_identity_lastsuccessfullogin',
    'adx_profilemodifiedon', 'adx_createdbyipaddress', 'adx_modifiedbyipaddress',
    'adx_createdbyusername', 'adx_modifiedbyusername',
    'yomifullname', 'yomifirstname', 'yomilastname', 'yomimiddlename',
];

const SYSTEM_LOOKUPS = [
    'createdby', 'modifiedby', 'ownerid', 'owninguser', 'owningteam',
    'owningbusinessunit', 'organizationid', 'createdonbehalfby', 'modifiedonbehalfby',
];

// Lookups whose @odata.bind needs the attrName_targetentity form
const POLYMORPHIC_LOOKUPS = ['parentcustomerid', 'customerid', 'regardingobjectid', 'originatingleadid', 'ownerid'];

const STYLE = `
    .dc-backdrop {
        position: fixed; inset: 0; background: rgba(0,0,0,0.3);
        z-index: 2147483000; display: flex; align-items: center; justify-content: center;
        animation: ppt-fade 0.15s ease;
    }
    .dc-modal {
        width: 620px; max-width: 92vw; max-height: 85vh;
        background: var(--bg); border-radius: 8px; box-shadow: var(--shadow);
        display: flex; flex-direction: column; animation: ppt-pop 0.15s ease;
    }
    .dc-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 24px; border-bottom: 1px solid var(--border); flex-shrink: 0;
    }
    .dc-header h2 { margin: 0; font-size: 17px; font-weight: 600; }
    .dc-tag { background: var(--bg2); color: var(--accent); padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; margin-left: 10px; }
    .dc-body { flex: 1; overflow-y: auto; padding: 18px 24px; }
    .dc-footer {
        display: flex; justify-content: flex-end; gap: 10px; padding: 14px 24px;
        border-top: 1px solid var(--border); background: var(--bg2); flex-shrink: 0;
    }
    /* The kit leaves disabled buttons looking enabled; a filled primary button
       especially needs to show that it is not clickable yet. */
    .dc-footer .ppt-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    /* Mode picker: a segmented control rather than three stacked cards — only
       the selected mode's description is worth the vertical space. */
    .dc-seg {
        display: flex; gap: 4px; padding: 3px; margin-bottom: 8px;
        background: var(--bg2); border: 1px solid var(--border); border-radius: 7px;
    }
    .dc-seg-item {
        flex: 1; padding: 8px 6px; border-radius: 5px; cursor: pointer;
        font-size: 13px; font-weight: 600; color: var(--muted);
        text-align: center; white-space: nowrap; user-select: none;
    }
    .dc-seg-item:hover { color: var(--text); }
    .dc-seg-item.active { background: var(--bg); color: var(--accent); box-shadow: 0 1px 3px rgba(0,0,0,0.14); }
    .dc-seg-item.disabled { opacity: 0.4; cursor: not-allowed; }
    .dc-seg-item input { display: none; }
    .dc-mode-desc { font-size: 13px; color: var(--muted); line-height: 1.45; margin-bottom: 14px; }
    .dc-source { display: flex; align-items: baseline; gap: 10px; margin-bottom: 14px; min-width: 0; }
    .dc-source .lbl { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; flex-shrink: 0; }
    .dc-source .name { font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* Hover hints. The explanations only need reading once, so they live here
       rather than costing space on every visit — but not in a title attribute:
       that tooltip is slow to appear and styled by the OS instead of by us.
       The ::after resolves against the positioned ROW, not the chip, so it
       spans the row and can never overflow the scroll box sideways. */
    .dc-opts, .dc-seg { position: relative; }
    [data-tip]::after {
        content: attr(data-tip);
        position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 5;
        padding: 9px 12px; border-radius: 6px;
        background: var(--bg); color: var(--muted);
        border: 1px solid var(--border); box-shadow: var(--shadow);
        font-size: 12px; font-weight: 400; line-height: 1.5; text-align: left;
        white-space: normal; pointer-events: none;
        opacity: 0; visibility: hidden; transition: opacity 0.12s ease 0.05s;
    }
    [data-tip]:hover::after, [data-tip]:focus-within::after { opacity: 1; visibility: visible; }
    /* Options as chips: compact, and self-explaining on hover. */
    .dc-opts { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
    .dc-opt {
        display: inline-flex; align-items: center; gap: 7px; padding: 6px 12px;
        border: 1px solid var(--border); border-radius: 15px;
        font-size: 13px; cursor: pointer; user-select: none;
    }
    .dc-opt:hover { border-color: var(--accent); }
    .dc-opt.on { border-color: var(--accent); color: var(--accent); background: var(--bg2); }
    .dc-opt input { width: 15px; height: 15px; margin: 0; accent-color: var(--accent); }
    .dc-opt .info { color: var(--muted); font-size: 12px; }
    /* What the preview is a preview OF: mode, target and options, restated
       read-only so the decision is visible at the moment of confirming. */
    .dc-ctx-wrap { padding-bottom: 12px; margin-bottom: 14px; border-bottom: 1px solid var(--border); }
    .dc-ctx { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; min-width: 0; }
    .dc-ctx .mode { font-weight: 600; }
    .dc-ctx .arrow { color: var(--muted); }
    .dc-ctx .host { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .dc-opt.static { cursor: default; }
    .dc-opt.static:hover { border-color: var(--border); }
    .dc-opt.static.on:hover { border-color: var(--accent); }
    .dc-opt.static.off { color: var(--muted); opacity: 0.75; }
    /* Preview tree: the record and its children as they would be written. */
    .dc-tree { display: flex; flex-direction: column; gap: 10px; }
    .dc-node { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .dc-node.root { border-color: var(--accent); }
    .dc-node-head {
        display: flex; align-items: center; gap: 8px; padding: 9px 12px;
        background: var(--bg2); border-bottom: 1px solid var(--border);
    }
    .dc-node-head .t { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dc-node-head .sub { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dc-badge {
        margin-left: auto; flex-shrink: 0; padding: 2px 9px; border-radius: 10px;
        font-size: 11px; font-weight: 700; background: var(--bg);
        border: 1px solid var(--border); color: var(--muted);
    }
    .dc-badge.new { color: #107C10; border-color: #A7E3A5; }
    .dc-badge.update { color: #835C00; border-color: #F5D06C; }
    .dc-badge.del { color: #A4262C; border-color: #F1BBBC; }
    .dc-badge.skip { color: var(--muted); }
    /* Plan summary: the counts that decide whether this is safe to run. */
    .dc-sum { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
    .dc-sum .c {
        display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px;
        border: 1px solid var(--border); border-radius: 15px; font-size: 12px; font-weight: 600;
    }
    .dc-sum .c.new { color: #107C10; border-color: #A7E3A5; }
    .dc-sum .c.update { color: #835C00; border-color: #F5D06C; }
    .dc-sum .c.del { color: #A4262C; border-color: #F1BBBC; background: #FDE7E9; }
    .dc-sum .c.skip { color: var(--muted); }
    /* Deletions get their own block: never something to notice in passing. */
    .dc-del-box { border: 1px solid #F1BBBC; background: #FDE7E9; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
    .dc-del-box .hd { font-size: 13px; font-weight: 700; color: #A4262C; margin-bottom: 6px; }
    .dc-del-box .it { font-size: 12px; color: #A4262C; padding: 2px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    @media (prefers-color-scheme: dark) {
        .dc-sum .c.del { background: #3a1416; color: #F1707B; border-color: #6b2a2e; }
        .dc-del-box { background: #3a1416; border-color: #6b2a2e; }
        .dc-del-box .hd, .dc-del-box .it { color: #F1707B; }
    }
    .dc-node-fields { padding: 6px 12px 9px; }
    .dc-f { display: flex; gap: 10px; padding: 3px 0; font-size: 13px; align-items: baseline; }
    .dc-f .fk { flex: 0 0 38%; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dc-f .fv { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dc-f .fv.empty { color: var(--muted); font-style: italic; }
    .dc-f.changed .fv { white-space: normal; }
    .dc-f.changed .was { color: var(--muted); text-decoration: line-through; }
    .dc-f.changed .now { font-weight: 600; }
    .dc-f .ins { background: #DFF6DD; color: #0B6A0B; border-radius: 3px; padding: 0 2px; font-weight: 600; }
    .dc-f .del { background: #FDE7E9; color: #A4262C; border-radius: 3px; padding: 0 2px; text-decoration: line-through; }
    .dc-f.same { opacity: 0.65; }
    @media (prefers-color-scheme: dark) {
        .dc-f .ins { background: #10380f; color: #92DC8E; }
        .dc-f .del { background: #3a1416; color: #F1707B; }
    }
    .dc-more { background: none; border: none; padding: 3px 0; font: inherit; font-size: 12px; color: var(--accent); cursor: pointer; }
    .dc-branch { margin-left: 16px; padding-left: 16px; border-left: 2px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
    .dc-branch-title { font-size: 12px; font-weight: 600; color: var(--muted); }
    .dc-rel-list { max-height: 200px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; }
    .dc-rel {
        display: flex; align-items: center; gap: 12px; padding: 10px 14px;
        border-bottom: 1px solid var(--border); cursor: pointer;
    }
    .dc-rel:last-child { border-bottom: none; }
    .dc-rel:hover { background: var(--bg2); }
    .dc-rel input { width: 16px; height: 16px; accent-color: var(--accent); flex-shrink: 0; }
    .dc-rel .t { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dc-rel .d { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dc-rel .count { font-size: 13px; color: var(--accent); white-space: nowrap; flex-shrink: 0; }
    .dc-center { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 28px; color: var(--muted); text-align: center; }
    .dc-spinner {
        width: 28px; height: 28px; border: 3px solid var(--border);
        border-top-color: var(--accent); border-radius: 50%;
        animation: dc-spin 0.7s linear infinite;
    }
    .dc-error { background: #FDE7E9; border: 1px solid #F1BBBC; color: #D13438; padding: 12px 16px; border-radius: 6px; font-size: 13px; word-break: break-word; text-align: left; }
    .dc-warn { background: #FFF4CE; border: 1px solid #F5D06C; color: #835C00; padding: 12px 16px; border-radius: 6px; font-size: 12px; text-align: left; }
    .dc-env-btn {
        display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
        font: inherit; font-size: 13px; padding: 8px 12px; margin-bottom: 4px;
        border: 1px solid var(--border); border-radius: 5px;
        background: var(--bg); color: var(--text); cursor: pointer; min-width: 0;
    }
    .dc-env-btn:hover { border-color: var(--accent); }
    .dc-env-btn .host { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dc-env-btn .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dc-env-row { display: flex; align-items: center; gap: 6px; }
    .dc-env-group { border: 1px solid var(--border); border-radius: 6px; margin-bottom: 6px; overflow: hidden; }
    .dc-env-group-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px; background: var(--bg2); border: 0; font: inherit; font-size: 12px; font-weight: 600; color: var(--text); text-align: left; cursor: pointer; }
    .dc-env-group-head:hover { color: var(--accent); }
    .dc-env-group-head .caret { font-size: 9px; color: var(--muted); width: 10px; flex-shrink: 0; }
    .dc-env-group-head .count { font-weight: 400; font-size: 11px; color: var(--muted); }
    .dc-env-group-head .here { margin-left: auto; font-weight: 600; font-size: 11px; color: var(--accent); }
    .dc-env-group-body { padding: 6px 6px 2px; display: flex; flex-direction: column; gap: 6px; }
    .dc-env-row .dc-env-btn { flex: 1; }
    .dc-target {
        display: flex; align-items: center; gap: 10px; padding: 10px 14px;
        border: 1px solid var(--accent); border-radius: 6px; margin-bottom: 12px;
    }
    .dc-target .host { flex: 1; min-width: 0; font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dc-report {
        display: grid; grid-template-columns: max-content minmax(0, 1fr);
        font-size: 13px; line-height: 1.45; margin-bottom: 12px;
        border: 1px solid var(--border); border-radius: 6px; overflow: hidden;
    }
    .dc-report .k {
        padding: 7px 10px; background: var(--bg2); color: var(--muted);
        font-weight: 600; white-space: nowrap; border-bottom: 1px solid var(--border);
    }
    .dc-report .v {
        display: flex; gap: 7px; align-items: baseline; min-width: 0;
        padding: 7px 10px; border-bottom: 1px solid var(--border);
    }
    .dc-report > :nth-last-child(-n+2) { border-bottom: none; }
    .dc-report .st { flex-shrink: 0; }
    .dc-table-icon { width: 16px; height: 16px; object-fit: contain; vertical-align: text-bottom; }
    .dc-avatar {
        width: 18px; height: 18px; border-radius: 50%; object-fit: cover;
        vertical-align: text-bottom; background: var(--bg2);
    }
    .dc-avatar.team { border-radius: 4px; }
    /* "Write as another user" — impersonation picker. */
    .dc-imp { position: relative; margin-bottom: 12px; }
    .dc-imp-on {
        display: flex; align-items: center; gap: 8px; padding: 8px 12px;
        border: 1px solid var(--accent); border-radius: 6px; background: var(--bg2); font-size: 13px;
    }
    .dc-imp-on .who { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dc-imp-results {
        position: absolute; left: 0; right: 0; top: calc(100% + 2px); z-index: 6;
        max-height: 220px; overflow-y: auto; background: var(--bg);
        border: 1px solid var(--border); border-radius: 6px; box-shadow: var(--shadow);
    }
    .dc-imp-item { padding: 8px 12px; font-size: 13px; cursor: pointer; }
    .dc-imp-item:hover { background: var(--bg2); }
    .dc-imp-item .mail { color: var(--muted); font-size: 11px; margin-left: 6px; }
    .dc-imp-item.muted, .dc-imp-item.err { cursor: default; color: var(--muted); }
    .dc-imp-item.muted:hover, .dc-imp-item.err:hover { background: none; }
    .dc-imp-item.err { color: #D13438; }
    .dc-report .val { min-width: 0; word-break: break-word; }
    .dc-report .sub { display: block; color: var(--muted); font-size: 12px; }
    .dc-report .warn { color: #835C00; }
    @media (prefers-color-scheme: dark) {
        .dc-report .warn { color: #F5D06C; }
        /* Table icons are web resources drawn for a light canvas — most are
           dark line art that all but vanishes here. A light tile keeps every
           icon legible without recoloring it (filters wreck colored ones). */
        .dc-table-icon { background: rgba(255,255,255,0.92); border-radius: 3px; padding: 1px; }
    }
    @media (prefers-color-scheme: dark) {
        .dc-error { background: #3a1416; border-color: #6b2a2e; color: #F1707B; }
        .dc-warn { background: #3d3010; border-color: #6b5518; color: #F5D06C; }
    }
    @keyframes dc-spin { to { transform: rotate(360deg); } }
`;

function envTypeBadge(type) {
    const config = ENV_TYPES[type] ?? { color: '#616161', bg: '#F5F5F5', border: '#D1D1D1', icon: '🌐', label: type };
    return ui.el('span', {
        style: `background:${config.bg};color:${config.color};border:1px solid ${config.border};padding:2px 8px;border-radius:3px;font-size:11px;font-weight:700;flex-shrink:0`,
        textContent: `${config.icon} ${config.label ?? type}`,
    });
}

let dv;
let store;
const metadataCache = {};
const attributeCache = {};
const relationshipCache = {};
const navPropertyCache = {};
let currentUserId = null;

const cleanGuid = (guid) => (guid ? guid.replace(/[{}]/g, '').toLowerCase() : '');

// ── Metadata ──────────────────────────────────────────────────────────────
// Caches are keyed by org, so a target environment never inherits the source
// org's schema (a table can differ between environments).
const cacheKey = (entityName, client) => `${client.base}|${entityName}`;

async function fetchEntityMetadata(entityName, client = dv) {
    const key = cacheKey(entityName, client);
    if (!(key in metadataCache)) {
        try {
            metadataCache[key] = await client.get(
                `/EntityDefinitions(LogicalName='${entityName}')?$select=LogicalName,DisplayName,PrimaryIdAttribute,PrimaryNameAttribute,EntitySetName,IconVectorName,IconSmallName`);
        } catch (e) {
            // A missing table in the source org is business as usual (lookup
            // targets we cannot resolve); against a target org the caller needs
            // to tell "table absent" from "not signed in", so let it through.
            if (client !== dv) throw e;
            console.warn('[Deep Clone] no metadata for', entityName, e);
            metadataCache[key] = null;
        }
    }
    return metadataCache[key];
}

// Which columns the org will actually accept on create / update. Used to drop
// columns that don't exist (or aren't writable) in the target environment.
async function fetchWritableAttributes(entityName, client) {
    const key = cacheKey(entityName, client);
    if (!attributeCache[key]) {
        const data = await client.get(
            `/EntityDefinitions(LogicalName='${entityName}')/Attributes?$select=LogicalName,IsValidForCreate,IsValidForUpdate`);
        const create = new Set();
        const update = new Set();
        for (const attribute of data.value ?? []) {
            if (attribute.IsValidForCreate) create.add(attribute.LogicalName);
            if (attribute.IsValidForUpdate) update.add(attribute.LogicalName);
        }
        attributeCache[key] = { create, update };
    }
    return attributeCache[key];
}

/**
 * The single-valued navigation property behind each lookup column.
 *
 * @odata.bind names the NAVIGATION property, not the attribute. Those differ
 * more often than not: the attribute's logical name is lower-cased
 * ("nc_prozesstype") while the navigation property keeps the relationship's
 * schema casing ("nc_ProzessType"), and OData property names are
 * case-sensitive. A polymorphic lookup has one navigation property per target
 * ("customerid_account", "customerid_contact"). Guessing either produces
 * "An undeclared property ... which only has property annotations", so the
 * names come from metadata.
 */
async function fetchLookupNavProperties(entityName, client = dv) {
    const key = cacheKey(entityName, client);
    if (!navPropertyCache[key]) {
        const map = new Map();
        try {
            const data = await client.get(`/EntityDefinitions(LogicalName='${entityName}')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencedEntity,ReferencingEntityNavigationPropertyName`);
            const perAttribute = new Map();
            for (const rel of data.value ?? []) {
                const nav = rel.ReferencingEntityNavigationPropertyName;
                if (!nav) continue;
                map.set(`${rel.ReferencingAttribute}|${rel.ReferencedEntity}`, nav);
                perAttribute.set(rel.ReferencingAttribute, (perAttribute.get(rel.ReferencingAttribute) ?? 0) + 1);
                if (!map.has(rel.ReferencingAttribute)) map.set(rel.ReferencingAttribute, nav);
            }
            // An attribute with several targets is polymorphic: only the
            // target-qualified key is meaningful, so drop the bare fallback.
            for (const [attribute, count] of perAttribute) if (count > 1) map.delete(attribute);
        } catch (e) {
            console.warn('[Deep Clone] could not read lookup navigation properties for', entityName, e);
        }
        navPropertyCache[key] = map;
    }
    return navPropertyCache[key];
}

/** The @odata.bind key for a lookup, from metadata where it is available. */
function bindKeyFor(navProps, attrName, targetEntity) {
    const nav = navProps?.get(`${attrName}|${targetEntity}`)
        ?? navProps?.get(attrName)
        // Metadata unavailable: fall back to the old guess so a failed read
        // degrades rather than dropping the reference outright.
        ?? (POLYMORPHIC_LOOKUPS.includes(attrName) ? `${attrName}_${targetEntity}` : attrName);
    return `${nav}@odata.bind`;
}

/**
 * The table's own icon, resolved from its web resource the way the audit
 * viewer does it. Always the current org's copy — same-origin, so it loads
 * with the page session — and the tick stands in when there is no icon (or it
 * fails to load).
 */
function tableIcon(metadata, fallback = '✅') {
    const iconName = metadata?.IconSmallName || metadata?.IconVectorName;
    if (!iconName) return fallback;
    const img = ui.el('img', {
        className: 'dc-table-icon',
        src: `${location.origin}/WebResources/${iconName}`,
        alt: '',
    });
    img.addEventListener('error', () => img.replaceWith(fallback));
    return img;
}

function entitySetNameSync(entityName) {
    const cached = metadataCache[cacheKey(entityName, dv)];
    if (cached?.EntitySetName) return cached.EntitySetName;
    if (entityName.endsWith('y')) return entityName.slice(0, -1) + 'ies';
    if (/(?:s|x|ch)$/.test(entityName)) return entityName + 'es';
    return entityName + 's';
}

async function getCurrentUserId() {
    return (currentUserId ??= cleanGuid((await dv.get('/WhoAmI()')).UserId));
}

// 1:N relationships that make sense to clone. The exclusion list mirrors what
// deep insert can actually handle (no activity-party activities, no
// system/tracking relationships, no customeraddress duplicates, …).
async function fetchCloneableRelationships(entityName) {
    if (relationshipCache[entityName]) return relationshipCache[entityName];
    try {
        const data = await dv.get(`/EntityDefinitions(LogicalName='${entityName}')/OneToManyRelationships?$select=SchemaName,ReferencedEntity,ReferencingEntity,ReferencingAttribute,ReferencedEntityNavigationPropertyName`);
        const excludedEntities = ['activitypointer', 'activityparty', 'adx_externalidentity', 'customeraddress'];
        const excludedSchemaParts = [
            '_AsyncOperations', '_BulkDeleteFailures', '_DuplicateMatchingRecord', '_DuplicateBaseRecord',
            '_MailboxTrackingFolders', '_PrincipalObjectAttributeAccesses', '_ProcessSession', '_SyncErrors',
            '_connections', '_actioncard', '_Feedback',
            // activity-party activities cannot ride a deep insert
            '_Emails', '_Faxes', '_Letters', '_PhoneCalls', '_Appointments',
            '_RecurringAppointmentMasters', '_SocialActivities', '_ServiceAppointments',
            // business documents typically shouldn't be cloned
            '_Quotes', '_Orders', '_Invoices',
        ];
        // Self-referential relationships (a config holding its own
        // translations, a record and its child records) are kept. They used to
        // be excluded because a deep insert has no way to notice it has
        // already emitted a record and can recurse without end; the planner
        // dedupes by source identity and caps the depth, so the shape is safe
        // now — and it is often exactly the thing worth cloning.
        const relationships = (data.value ?? []).filter((r) =>
            !/^(lk_|user_|team_|owner_|business_unit_)/.test(r.SchemaName)
            && !excludedEntities.includes(r.ReferencingEntity)
            && !excludedSchemaParts.some((part) => r.SchemaName.includes(part)));
        return (relationshipCache[entityName] = relationships);
    } catch (e) {
        console.warn('[Deep Clone] could not fetch relationships:', e);
        return [];
    }
}

// ── Clone payload construction ────────────────────────────────────────────
function isLookupValueKey(key) {
    return key.startsWith('_') && key.endsWith('_value');
}

/**
 * @param {object} [options]
 * @param {Set<string>} [options.allowed]  columns the destination org accepts; others are skipped
 * @param {boolean}     [options.keepId]   keep the record's own GUID instead of letting the server assign one
 * @param {string[]}    [options.dropped]  out-param: columns skipped because the destination lacks them
 * @param {object[]}    [options.lookups]  out-param: the lookup references written as @odata.bind
 * @param {boolean}     [options.childLookups] keep a child's own lookups instead of dropping them
 */
function cleanRecordForClone(record, primaryIdAttr, isChild, options = {}) {
    const { allowed = null, keepId = false, dropped = null, lookups = null, childLookups = false, navProps = null } = options;
    const cleaned = {};

    for (const [key, value] of Object.entries(record)) {
        if (key.includes('@')) continue;
        const lower = key.toLowerCase();
        if (SYSTEM_FIELDS.includes(lower) || READONLY_FIELDS.includes(lower)) continue;
        if (key === primaryIdAttr) {
            if (keepId && value) cleaned[key] = cleanGuid(value);
            continue;
        }
        if (value === null || value === undefined) continue;
        if (typeof value === 'object') continue; // navigation props handled separately
        if (isLookupValueKey(key)) continue;     // converted to @odata.bind below
        if (allowed && !allowed.has(key)) { dropped?.push(key); continue; }
        cleaned[key] = value;
    }

    for (const [key, value] of Object.entries(record)) {
        if (!isLookupValueKey(key) || !value) continue;
        const targetEntity = record[`${key}@Microsoft.Dynamics.CRM.lookuplogicalname`];
        if (!targetEntity) continue;
        const attrName = key.slice(1, -6);
        if (SYSTEM_LOOKUPS.includes(attrName)) continue;
        // The parent link always comes from the write itself (deep-insert
        // nesting, or an explicit bind in the plan), never from the copied
        // column. A child's OTHER lookups are worth keeping — a translation
        // row without its language reference is not a usable clone — but only
        // where the reference is known to resolve, which is why the caller
        // opts in rather than this being unconditional.
        if (isChild && !childLookups) continue;
        if (allowed && !allowed.has(attrName)) { dropped?.push(attrName); continue; }

        const targetSet = entitySetNameSync(targetEntity);
        const bindKey = bindKeyFor(navProps, attrName, targetEntity);
        cleaned[bindKey] = `/${targetSet}(${cleanGuid(value)})`;
        lookups?.push({
            attrName,
            bindKey,
            targetEntity,
            targetSet,
            id: cleanGuid(value),
            label: record[`${key}@OData.Community.Display.V1.FormattedValue`] ?? cleanGuid(value),
        });
    }

    return cleaned;
}

/**
 * The record's own N:1 references, in the shape the clone planner consumes.
 * System lookups (owner, created-by, …) are left out: they are either handled
 * by identity mapping or set by the platform.
 */
function collectLookups(record, navProps) {
    const lookups = [];
    for (const [key, value] of Object.entries(record)) {
        if (!isLookupValueKey(key) || !value) continue;
        const targetEntity = record[`${key}@Microsoft.Dynamics.CRM.lookuplogicalname`];
        if (!targetEntity) continue;
        const attrName = key.slice(1, -6);
        if (SYSTEM_LOOKUPS.includes(attrName)) continue;
        lookups.push({
            attrName,
            bindKey: bindKeyFor(navProps, attrName, targetEntity),
            targetEntity,
            id: cleanGuid(value),
            label: record[`${key}@OData.Community.Display.V1.FormattedValue`] ?? cleanGuid(value),
        });
    }
    return lookups;
}

// Make entitySetNameSync accurate: prefetch metadata for every lookup target.
async function prefetchLookupTargets(record) {
    const targets = new Set();
    for (const [key, value] of Object.entries(record)) {
        if (isLookupValueKey(key) && value) {
            const target = record[`${key}@Microsoft.Dynamics.CRM.lookuplogicalname`];
            if (target) targets.add(target);
        }
    }
    await Promise.all([...targets].map((t) => fetchEntityMetadata(t)));
}

/**
 * @param {object} [options]
 * @param {Dataverse} [options.client]       destination org (defaults to the current one)
 * @param {boolean}   [options.preserveIds]  keep the source GUIDs on the parent and its children
 * @param {boolean}   [options.setOwner]     assign notes to the current user (source-org user ids only)
 * @param {boolean}   [options.forUpdate]    filter the parent against the update-valid columns instead
 * @param {Set<string>} [options.dropBindKeys] lookup binds to leave out (target is missing the record)
 * @param {Map<string,string>} [options.rebind] lookup binds repointed at the target's own records
 * @param {string}    [options.ownerBind]    owner to assign, e.g. "/systemusers(<target id>)"
 * @param {string}    [options.overriddenCreatedOn] source createdon to stamp on the new record
 */
/**
 * Columns the target accepts on update but refuses on create — statecode and
 * statuscode above all: Dataverse assigns a new record the default state, and
 * the real one has to be set in a second pass. Lookups are left out; those go
 * through the bind/rebind path instead.
 */
function updateOnlyColumns(sourceRecord, entityMetadata, attrs) {
    const updateOnly = new Set([...attrs.update].filter((attr) => !attrs.create.has(attr)));
    if (!updateOnly.size) return null;
    const columns = cleanRecordForClone(sourceRecord, entityMetadata.PrimaryIdAttribute, false, { allowed: updateOnly });
    for (const key of Object.keys(columns)) if (key.includes('@')) delete columns[key];
    return Object.keys(columns).length ? columns : null;
}

async function buildClonePayload(sourceRecord, entityMetadata, selectedRelationships, options = {}) {
    const {
        client = dv, preserveIds = false, setOwner = true, forUpdate = false,
        dropBindKeys = null, rebind = null, ownerBind = null, overriddenCreatedOn = null,
    } = options;
    const crossOrg = client !== dv;

    await prefetchLookupTargets(sourceRecord);
    const attrs = crossOrg ? await fetchWritableAttributes(entityMetadata.LogicalName, client) : null;
    const allowed = attrs && (forUpdate ? attrs.update : attrs.create);
    const navProps = await fetchLookupNavProperties(entityMetadata.LogicalName, client);
    const payload = cleanRecordForClone(sourceRecord, entityMetadata.PrimaryIdAttribute, false,
        { allowed, keepId: preserveIds, navProps });
    if (dropBindKeys) for (const key of dropBindKeys) delete payload[key];
    if (rebind) for (const [key, value] of rebind) payload[key] = value;
    const deferred = attrs && !forUpdate ? updateOnlyColumns(sourceRecord, entityMetadata, attrs) : null;
    // ownerid is excluded from the generic lookup handling (SYSTEM_LOOKUPS),
    // so an identity-mapped owner is added back explicitly.
    if (ownerBind) payload['ownerid@odata.bind'] = ownerBind;
    // The migration column: createdon itself is never writable, but the target
    // accepts overriddencreatedon on create and dates the record from it.
    if (overriddenCreatedOn) payload.overriddencreatedon = overriddenCreatedOn;

    const largeAnnotations = [];

    for (const rel of selectedRelationships) {
        const navProp = rel.ReferencedEntityNavigationPropertyName;
        const children = sourceRecord[navProp];
        if (!Array.isArray(children) || !children.length) continue;

        const childMetadata = await fetchEntityMetadata(rel.ReferencingEntity);
        const childAllowed = crossOrg
            ? (await fetchWritableAttributes(rel.ReferencingEntity, client)).create
            : null;
        const isAnnotation = rel.ReferencingEntity === 'annotation';
        const userId = setOwner ? await getCurrentUserId() : null;
        const cleanedChildren = [];

        for (const child of children) {
            // Same-org clones can keep a child's lookups as they stand: every
            // reference resolves by definition. Across environments they may
            // not, so the legacy path still drops them — the plan-based path
            // vets each one instead.
            const cleaned = cleanRecordForClone(child, childMetadata?.PrimaryIdAttribute, true, {
                allowed: childAllowed,
                keepId: preserveIds,
                childLookups: !crossOrg,
                navProps: await fetchLookupNavProperties(rel.ReferencingEntity, client),
            });
            delete cleaned[rel.ReferencingAttribute];
            // Polymorphic lookups bind as "attr_targetentity@odata.bind", so
            // the parent link has to be matched by prefix, not by exact key.
            for (const key of Object.keys(cleaned)) {
                if (key === `${rel.ReferencingAttribute}@odata.bind`
                    || key.startsWith(`${rel.ReferencingAttribute}_`) && key.endsWith('@odata.bind')) {
                    delete cleaned[key];
                }
            }

            if (isAnnotation) {
                // Files over the deep-insert limit go through the block-upload API afterwards
                if (cleaned.documentbody && cleaned.documentbody.length > MAX_ANNOTATION_FILE_SIZE) {
                    largeAnnotations.push({
                        subject: cleaned.subject ?? '',
                        notetext: cleaned.notetext ?? '',
                        filename: cleaned.filename,
                        mimetype: cleaned.mimetype,
                        documentbody: cleaned.documentbody,
                    });
                    continue;
                }
                delete cleaned.objectid;
                delete cleaned['objectid@odata.bind'];
                delete cleaned.objecttypecode;
            }

            if (userId) cleaned['ownerid@odata.bind'] = `/systemusers(${userId})`;
            cleanedChildren.push(cleaned);
        }

        if (cleanedChildren.length) payload[navProp] = cleanedChildren;
    }

    return { payload, largeAnnotations, deferred };
}

// ── Graph clone (deduplicated, ordered, one change set) ───────────────────
// The plan already decided what each record is and in which order it goes;
// this turns one node into the body of its own request.
async function buildNodePayload(node, client, { ownerBind, overriddenCreatedOn }) {
    const attrs = await fetchWritableAttributes(node.entity, client);
    const forUpdate = node.action === ACTIONS.UPDATE;
    const dropped = [];
    const payload = cleanRecordForClone(node.record, node.metadata.PrimaryIdAttribute, false, {
        allowed: forUpdate ? attrs.update : attrs.create,
        dropped,
    });

    // The id is always the planner's, never the source record's and never the
    // server's: every reference in the change set was resolved against it
    // before anything was written. With ids preserved that IS the source GUID;
    // without, it is a fresh one assigned client-side. Letting Dataverse pick
    // instead would leave every bind pointing at a record that never existed.
    // On an update it travels in the URL, so the body leaves it alone.
    if (!forUpdate) payload[node.metadata.PrimaryIdAttribute] = node.targetId;

    // Every reference on this record was vetted by the planner — bound to a
    // record the target already has, repointed at a node created earlier in
    // the change set, or deliberately left out. So the binds derived from the
    // raw column values are discarded in favour of the planned ones.
    for (const key of Object.keys(payload)) if (key.includes('@odata.bind')) delete payload[key];
    for (const [bindKey, value] of node.binds) payload[bindKey] = value.path;

    if (node.kind === 'root' && ownerBind) payload['ownerid@odata.bind'] = ownerBind;
    if (!forUpdate && overriddenCreatedOn && attrs.create.has('overriddencreatedon')) {
        payload.overriddencreatedon = overriddenCreatedOn;
    }

    // A file past the inline limit cannot ride the request at all; it is
    // stripped here and block-uploaded once the note exists.
    let largeFile = null;
    if (payload.documentbody && payload.documentbody.length > MAX_ANNOTATION_FILE_SIZE) {
        largeFile = {
            subject: payload.subject ?? '',
            notetext: payload.notetext ?? '',
            filename: payload.filename,
            mimetype: payload.mimetype,
            documentbody: payload.documentbody,
        };
        delete payload.documentbody;
    }

    // statecode & co. are refused on create and have to follow the record.
    const deferredColumns = forUpdate ? null : updateOnlyColumns(node.record, node.metadata, attrs);
    return { payload, deferredColumns, dropped, largeFile };
}

/**
 * Folds the plan into ONE nested payload: 1:N children as arrays on their
 * collection navigation property, backfilled N:1 parents as objects on their
 * single-valued one, nested to whatever depth the plan reaches. Only valid
 * when {@link isSimpleTree} holds.
 */
function nestPlan(plan, built) {
    const byKey = new Map(plan.nodes.map((node) => [node.key, node]));
    const childrenOf = new Map();
    for (const node of plan.nodes) {
        if (!node.parentKey || node === plan.root) continue;
        if (!childrenOf.has(node.parentKey)) childrenOf.set(node.parentKey, []);
        childrenOf.get(node.parentKey).push(node);
    }

    const nest = (node) => {
        const { payload } = built.get(node.key);

        // A parent that has to be created rides along as an object on the same
        // navigation property its bind would have used; one that already
        // exists stays a bind.
        for (const [bindKey, value] of node.binds) {
            const parent = value.nodeKey ? byKey.get(value.nodeKey) : null;
            if (parent?.kind !== 'parent') continue;
            delete payload[bindKey];
            payload[bindKey.slice(0, -'@odata.bind'.length)] = nest(parent);
        }

        for (const child of childrenOf.get(node.key) ?? []) {
            const navProp = child.rel.ReferencedEntityNavigationPropertyName;
            const childPayload = nest(child);
            // Nesting IS the parent link; restating it would be redundant at
            // best and, on a polymorphic lookup, contradictory.
            delete childPayload[child.parentBind];
            (payload[navProp] ??= []).push(childPayload);
        }
        return payload;
    };
    return nest(plan.root);
}

/**
 * Writes the plan.
 *
 * A tree of creates goes as a single deep insert — one request, atomic, and
 * with Dataverse's own error surfacing unwrapped. Anything a deep insert
 * cannot express (updates, deletions, a record referenced twice, a cycle)
 * goes as one change set instead, which is equally atomic but reports
 * failures inside a MIME part.
 */
async function executePlan(plan, client, options, onProgress) {
    const dropped = new Set();
    const largeFiles = [];
    const built = new Map();

    for (const node of plan.nodes) {
        if (node.action === ACTIONS.SKIP) continue;
        const result = await buildNodePayload(node, client, options);
        built.set(node.key, result);
        for (const column of result.dropped) dropped.add(column);
        if (result.largeFile) largeFiles.push({ ...result.largeFile, node });
    }

    /** statecode & co., which no create accepts and which must follow. */
    const stateFollowUps = plan.nodes
        .filter((node) => built.get(node.key)?.deferredColumns)
        .map((node) => ({ node, payload: built.get(node.key).deferredColumns }));

    if (isSimpleTree(plan)) {
        onProgress?.(1, 'deep insert');
        await createClonedRecord(client, plan.root.metadata, nestPlan(plan, built));
        // Deep insert cannot carry these, so they are a second pass — the one
        // place this path gives up atomicity that a change set would keep.
        const notes = [];
        for (const { node, payload } of stateFollowUps) {
            try {
                await client.send('PATCH', `/${node.entitySet}(${node.targetId})`, payload);
            } catch (e) {
                notes.push(`${node.entity}: ${Object.keys(payload).join(', ')} could not be applied after the record was created — ${e.message}`);
            }
        }
        return { operations: 1, mode: 'deep insert', dropped: [...dropped], largeFiles, notes };
    }

    const changeSet = client.changeSet();
    for (const node of plan.order) {
        if (node.action === ACTIONS.SKIP) continue;
        const { payload } = built.get(node.key);
        if (node.action === ACTIONS.CREATE) changeSet.create(node.entitySet, payload);
        else changeSet.update(node.entitySet, node.targetId, payload);
    }
    // In the same change set, so the state lands in the same transaction as
    // the record rather than a best-effort second pass.
    for (const { node, payload } of stateFollowUps) changeSet.update(node.entitySet, node.targetId, payload);
    for (const node of plan.order) {
        if (!node.deferred.length) continue;
        const patch = {};
        for (const { bindKey, value } of node.deferred) patch[bindKey] = value.path;
        changeSet.update(node.entitySet, node.targetId, patch);
    }
    for (const removal of plan.deletes) changeSet.delete(removal.entitySet, removal.id);

    onProgress?.(changeSet.length, 'change set');
    await client.batch(changeSet);
    return { operations: changeSet.length, mode: 'change set', dropped: [...dropped], largeFiles, notes: [] };
}

// ── Dataverse writes ──────────────────────────────────────────────────────
// `Prefer: return=representation` is why this doesn't go through Dataverse.send:
// the created id has to come back in the body, not an OData-EntityId header.
async function createClonedRecord(client, entityMetadata, payload) {
    const response = await request({
        url: `${client.base}/${entityMetadata.EntitySetName}`,
        method: 'POST',
        headers: {
            'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'Accept': 'application/json',
            'Content-Type': 'application/json', 'Prefer': 'return=representation',
            // This one write goes around the client (it needs the created row
            // back in the body), so the client's headers are merged by hand.
            ...client.defaultHeaders,
        },
        body: JSON.stringify(payload),
        credentials: true,
    });
    return response.json()?.[entityMetadata.PrimaryIdAttribute] ?? null;
}

// See https://learn.microsoft.com/power-apps/developer/data-platform/attachment-annotation-files
async function uploadLargeAnnotation(client, parentLogicalName, parentEntitySetName, parentId, annotation) {
    const target = {
        '@odata.type': 'Microsoft.Dynamics.CRM.annotation',
        subject: annotation.subject,
        notetext: annotation.notetext,
        filename: annotation.filename,
        mimetype: annotation.mimetype ?? 'application/octet-stream',
    };

    const init = await client.send('POST', '/InitializeAnnotationBlocksUpload', {
        Target: {
            ...target,
            [`objectid_${parentLogicalName}@odata.bind`]: `/${parentEntitySetName}(${parentId})`,
        },
    });
    const token = init.FileContinuationToken;

    const blockIds = [];
    for (let offset = 0, block = 0; offset < annotation.documentbody.length; offset += UPLOAD_BLOCK_SIZE, block++) {
        const blockId = btoa(String(block).padStart(5, '0'));
        await client.send('POST', '/UploadBlock', {
            BlockId: blockId,
            BlockData: annotation.documentbody.substring(offset, offset + UPLOAD_BLOCK_SIZE),
            FileContinuationToken: token,
        });
        blockIds.push(blockId);
    }

    await client.send('POST', '/CommitAnnotationBlocksUpload', {
        Target: target,
        BlockList: blockIds,
        FileContinuationToken: token,
    });
}

// ── Payload preview ───────────────────────────────────────────────────────
// The preview renders the payload that would actually be sent, not a
// reconstruction of it — so what you see is what the API gets.
const labelCache = {};

async function fetchAttributeLabels(entityName) {
    const key = cacheKey(entityName, dv);
    if (!labelCache[key]) {
        try {
            const data = await dv.get(`/EntityDefinitions(LogicalName='${entityName}')/Attributes?$select=LogicalName,DisplayName`);
            const labels = {};
            for (const attribute of data.value ?? []) {
                const label = attribute.DisplayName?.UserLocalizedLabel?.Label;
                if (label) labels[attribute.LogicalName] = label;
            }
            labelCache[key] = labels;
        } catch (e) {
            console.warn('[Deep Clone] no attribute labels for', entityName, e);
            labelCache[key] = {};
        }
    }
    return labelCache[key];
}

/** "foo@odata.bind" / "foo_account@odata.bind" → the lookup's attribute name. */
function bindAttribute(key, record) {
    const raw = key.slice(0, key.indexOf('@'));
    if (`_${raw}_value` in record) return raw;
    const cut = raw.lastIndexOf('_');
    return cut > 0 ? raw.slice(0, cut) : raw;
}

const FORMATTED = '@OData.Community.Display.V1.FormattedValue';

function displayValue(record, key, value) {
    const formatted = record?.[`${key}${FORMATTED}`];
    if (formatted !== undefined && formatted !== '') return formatted;
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    const text = String(value ?? '');
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * Loose equality for "would this write actually change anything": the payload
 * and the stored record often disagree on type (numeric strings, date
 * precision) while meaning the same value.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isBlank = (value) => value === null || value === undefined
    || (typeof value === 'string' && value.trim() === '');

function sameValue(a, b) {
    if (a === b) return true;
    if (isBlank(a) && isBlank(b)) return true;   // null and "" both mean unset
    if (isBlank(a) || isBlank(b)) return false;
    if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);

    const [textA, textB] = [String(a).trim(), String(b).trim()];
    if (textA === textB) return true;
    // Coerce only where the type says it is safe: "007" and "7" are the same
    // number but not the same text, and a text column may well hold either.
    if (typeof a === 'number' || typeof b === 'number') {
        const [numA, numB] = [Number(textA), Number(textB)];
        return !Number.isNaN(numA) && !Number.isNaN(numB) && numA === numB;
    }
    if (ISO_DATE.test(textA) && ISO_DATE.test(textB)) return Date.parse(textA) === Date.parse(textB);
    if (GUID_RE.test(textA) && GUID_RE.test(textB)) return textA.toLowerCase() === textB.toLowerCase();
    return false;
}

const bindTargetId = (path) => String(path).match(/\(([^)]+)\)/)?.[1] ?? '';

/**
 * Payload entries as label/value pairs, primary name first. With `compareTo`
 * (the record as it stands in the target) each field also carries what it is
 * now and whether the write would move it.
 */
function payloadFields(payload, record, labels, primaryNameAttr, compareTo = null) {
    const fields = [];
    const diff = (field, next, current, currentDisplay) => {
        if (!compareTo) return field;
        field.before = currentDisplay ?? (current === undefined || current === null || current === '' ? '—' : String(current));
        field.changed = !sameValue(next, current);
        return field;
    };

    for (const [key, value] of Object.entries(payload)) {
        if (Array.isArray(value)) continue; // child collections get their own nodes
        if (key.includes('@odata.bind')) {
            const attr = bindAttribute(key, record ?? {});
            fields.push(diff({
                key: attr,
                label: labels[attr] ?? attr,
                value: record?.[`_${attr}_value${FORMATTED}`] ?? String(value),
            }, bindTargetId(value), compareTo?.[`_${attr}_value`], compareTo?.[`_${attr}_value${FORMATTED}`]));
            continue;
        }
        if (key === 'documentbody') {
            fields.push({ key, label: 'File', value: `${Math.round(String(value).length * 0.75 / 1024)} KB` });
            continue;
        }
        fields.push(diff({ key, label: labels[key] ?? key, value: displayValue(record, key, value) },
            value, compareTo?.[key], compareTo ? displayValue(compareTo, key, compareTo[key]) : undefined));
    }
    return fields.sort((a, b) => (a.key === primaryNameAttr ? -1 : b.key === primaryNameAttr ? 1 : 0));
}

// Longest-common-subsequence over words, so "…setup and access requests" vs
// "…setup and access requests today" reads as one added word rather than two
// versions of the whole sentence.
const TOKENS = /(\s+)/;
// Token pairs. ~1000 words a side costs ~15ms; a longer memo falls back to
// old → new rather than stalling the preview.
const DIFF_BUDGET = 4_000_000;

function inlineDiff(before, after) {
    if (!before || !after || before === '—') return null;
    // Atomic values (dates, ids, numbers, choice labels) read better as
    // old → new; only prose gains from an inline diff.
    if (before.length < 12 && after.length < 12) return null;
    if (ISO_DATE.test(before) || GUID_RE.test(before) || !Number.isNaN(Number(before))) return null;

    const a = before.split(TOKENS).filter(Boolean);
    const b = after.split(TOKENS).filter(Boolean);
    if (a.length * b.length > DIFF_BUDGET) return null;

    const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }

    const parts = [];
    const push = (type, text) => {
        const last = parts[parts.length - 1];
        if (last?.type === type) last.text += text;
        else parts.push({ type, text });
    };
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) { push('same', a[i]); i++; j++; }
        else if (lcs[i + 1][j] >= lcs[i][j + 1]) push('del', a[i++]);
        else push('add', b[j++]);
    }
    while (i < a.length) push('del', a[i++]);
    while (j < b.length) push('add', b[j++]);

    // Two unrelated strings shred into confetti; the arrow is clearer then.
    const shared = parts.reduce((n, part) => n + (part.type === 'same' ? part.text.trim().length : 0), 0);
    return shared / Math.max(before.length, after.length) < 0.3 ? null : parts;
}

function fieldRow(field) {
    const { label, value, before, changed } = field;
    const text = value === '' || value === null || value === undefined ? '—' : String(value);
    const parts = changed ? inlineDiff(String(before ?? ''), text) : null;
    const shown = changed
        ? (parts
            ? ui.el('span', { className: 'fv', title: `${before}  →  ${text}` },
                parts.map((part) => (part.type === 'same'
                    ? part.text
                    : ui.el('span', { className: part.type === 'add' ? 'ins' : 'del', textContent: part.text }))))
            : ui.el('span', { className: 'fv' }, [
                ui.el('span', { className: 'was', textContent: before, title: before }),
                ' → ',
                ui.el('span', { className: 'now', textContent: text, title: text }),
            ]))
        : ui.el('span', { className: `fv${text === '—' ? ' empty' : ''}`, textContent: text, title: text });
    return ui.el('div', { className: `dc-f${changed ? ' changed' : ''}${changed === false ? ' same' : ''}` }, [
        ui.el('span', { className: 'fk', textContent: label, title: label }),
        shown,
    ]);
}

function previewNode({ icon, title, subtitle, badge, badgeKind, fields, root, limit = 8 }) {
    const list = ui.el('div', { className: 'dc-node-fields' });
    // In diff mode what matters is the changes; everything else is noise that
    // stays one click away.
    const diffing = fields.some((field) => field.changed !== undefined);
    const shown = diffing ? fields.filter((field) => field.changed) : fields.slice(0, limit);
    const hidden = diffing ? fields.filter((field) => !field.changed) : fields.slice(limit);

    if (diffing && !shown.length) {
        list.append(ui.el('div', { className: 'dc-f same' }, [
            ui.el('span', { className: 'fv empty', textContent: 'Every column already matches — the update would write nothing new.' }),
        ]));
    }
    for (const field of shown) list.append(fieldRow(field));
    if (hidden.length) {
        const label = diffing
            ? `+ ${hidden.length} unchanged column${hidden.length > 1 ? 's' : ''}`
            : `+ ${hidden.length} more column${hidden.length > 1 ? 's' : ''}`;
        const more = ui.el('button', { className: 'dc-more', textContent: label });
        more.addEventListener('click', () => {
            for (const field of hidden) list.insertBefore(fieldRow(field), more);
            more.remove();
        });
        list.append(more);
    }
    return ui.el('div', { className: `dc-node${root ? ' root' : ''}` }, [
        ui.el('div', { className: 'dc-node-head' }, [
            ...(icon ? [icon] : []),
            ui.el('span', { className: 't', textContent: title, title }),
            ...(subtitle ? [ui.el('span', { className: 'sub', textContent: subtitle })] : []),
            ...(badge ? [ui.el('span', { className: `dc-badge${badgeKind ? ` ${badgeKind}` : ''}`, textContent: badge })] : []),
        ]),
        list,
    ]);
}

// ── Identity mapping (users & teams across environments) ──────────────────
// systemuser/team GUIDs are per-org, so a lookup at a user or team never
// survives a cross-environment copy on its id. What does survive is the Entra
// identity behind it: the object id when the org is AAD-synced, otherwise the
// UPN / email address. Matchers are ordered strongest first.
const IDENTITY_MATCHERS = {
    systemuser: [
        { attr: 'azureactivedirectoryobjectid', label: 'Entra object id', guid: true },
        { attr: 'domainname', label: 'UPN' },
        { attr: 'internalemailaddress', label: 'email' },
    ],
    team: [
        { attr: 'azureactivedirectoryobjectid', label: 'Entra object id', guid: true },
        { attr: 'emailaddress', label: 'email' },
        { attr: 'name', label: 'team name' },
    ],
};

const IDENTITY_SELECT = {
    systemuser: 'systemuserid,azureactivedirectoryobjectid,domainname,internalemailaddress,fullname',
    team: 'teamid,azureactivedirectoryobjectid,emailaddress,name',
};

// The avatar column is requested on top of the identity columns, and only
// where it exists: systemuser has an image column, team has none at all, and
// asking for a column a table doesn't have fails the whole read.
const IDENTITY_IMAGE_ATTR = { systemuser: 'entityimage_url', team: null };

const IDENTITY_LABEL_ATTR = { systemuser: 'fullname', team: 'name' };

// isdisabled comes along because a disabled user can still be referenced by a
// lookup, but cannot own a record — assigning one fails the whole create.
const IDENTITY_TARGET_SELECT = { systemuser: 'systemuserid,fullname,isdisabled', team: 'teamid,name' };

const identityCache = {};

const isIdentityEntity = (entityName) => entityName in IDENTITY_MATCHERS;
const odataQuote = (value) => encodeURIComponent(String(value).replace(/'/g, "''"));

/** The source-org user/team behind a lookup, with its stable identity columns. */
async function fetchIdentity(entityName, id) {
    const key = `${entityName}|${id}`;
    if (key in identityCache) return identityCache[key];

    const entitySet = entitySetNameSync(entityName);
    const core = IDENTITY_SELECT[entityName];
    const image = IDENTITY_IMAGE_ATTR[entityName];
    const read = (select) => dv.get(`/${entitySet}(${id})?$select=${select}`);

    try {
        identityCache[key] = await read(image ? `${core},${image}` : core);
    } catch (e) {
        // The avatar is decoration; never let it cost us the identity match.
        try {
            identityCache[key] = image ? await read(core) : null;
            if (identityCache[key]) console.warn('[Deep Clone] identity read without image for', entityName, id, e);
        } catch (inner) {
            console.warn('[Deep Clone] could not read identity for', entityName, id, inner);
            identityCache[key] = null;
        }
    }
    return identityCache[key];
}

/**
 * Finds the same person/team in the target org. Returns the match plus the
 * strategy that found it, or a reason when nothing usable turned up.
 */
async function resolveIdentityInTarget(client, entityName, identity) {
    if (!identity) return { status: 'unreadable' };
    const entitySet = entitySetNameSync(entityName);
    const idAttr = `${entityName}id`;
    const nameAttr = IDENTITY_LABEL_ATTR[entityName];
    let sawAmbiguous = false;

    for (const matcher of IDENTITY_MATCHERS[entityName]) {
        const value = identity[matcher.attr];
        if (!value) continue;
        const literal = matcher.guid ? cleanGuid(value) : `'${odataQuote(value)}'`;
        let matches;
        try {
            const data = await client.get(
                `/${entitySet}?$filter=${matcher.attr} eq ${literal}&$select=${IDENTITY_TARGET_SELECT[entityName]}&$top=2`);
            matches = data.value ?? [];
        } catch (e) {
            console.warn('[Deep Clone] identity lookup failed', matcher.attr, e);
            continue;
        }
        // Two hits means the key isn't unique here (team names across business
        // units, say) — fall through to a weaker but unambiguous matcher.
        if (matches.length > 1) { sawAmbiguous = true; continue; }
        if (matches.length === 1) {
            return {
                status: 'mapped',
                id: cleanGuid(matches[0][idAttr]),
                label: matches[0][nameAttr] ?? '',
                disabled: !!matches[0].isdisabled,
                matchedBy: matcher.label,
                matchedValue: value,
            };
        }
    }
    return { status: sawAmbiguous ? 'ambiguous' : 'unmatched' };
}

/**
 * The user's photo (or the team's image) when Dataverse holds one, falling
 * back to a glyph. Same-origin like the table icon, and broken loads degrade
 * to the glyph rather than a torn-image box.
 */
function identityIcon(entityName, imageUrl) {
    const fallback = entityName === 'team' ? '👥' : '👤';
    if (!imageUrl) return fallback;
    const img = ui.el('img', {
        className: `dc-avatar${entityName === 'team' ? ' team' : ''}`,
        src: imageUrl.startsWith('http') ? imageUrl : `${location.origin}${imageUrl}`,
        alt: '',
    });
    img.addEventListener('error', () => img.replaceWith(fallback));
    return img;
}

/**
 * Short display name for a source user/team. When the record itself could not
 * be read, the lookup's own formatted value still names it.
 */
function identityName(entityName, identity, fallback) {
    if (!identity) return fallback || entityName;
    const matcher = IDENTITY_MATCHERS[entityName].find((m) => identity[m.attr]);
    return identity[IDENTITY_LABEL_ATTR[entityName]] || (matcher && identity[matcher.attr]) || fallback || entityName;
}

// ── Target environments ───────────────────────────────────────────────────
// Known environments come from the environment-indicator's host cache; the
// user can also type any org URL, which is then remembered for next time.
async function fetchKnownEnvironments() {
    const env = createStore('environment-indicator');

    let currentEnvId = null;
    try { currentEnvId = cleanGuid((await dv.retrieveCurrentOrganization())?.EnvironmentId ?? ''); } catch { /* unknown */ }

    const currentHost = location.hostname.toLowerCase();
    const labelled = await loadEnvironments({ currentEnvId, store: env });
    const environments = labelled.filter((e) => e.host && !e.isCurrent && e.host !== currentHost);

    // Hosts the indicator has seen but nobody ever labelled still belong in the
    // list — they just arrive with no badge and no family.
    const hostCache = await env.get('envIndicator_hostCache', {});
    for (const [rawHost, envId] of Object.entries(hostCache)) {
        const host = rawHost.toLowerCase();
        const id = cleanGuid(String(envId));
        if (host === currentHost || id === currentEnvId) continue;
        if (environments.some((e) => e.host === host)) continue;
        environments.push({ envId: id, type: null, name: '', group: '', host, url: `https://${host}`, isCurrent: false });
    }

    const here = labelled.find((e) => e.isCurrent) ?? labelled.find((e) => e.host === currentHost);
    return {
        environments: environments.sort((a, b) => a.host.localeCompare(b.host)),
        currentGroup: here?.group ?? null,
    };
}

function normalizeOrgUrl(raw) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return null;
    try {
        const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
        return url.protocol === 'https:' ? `https://${url.hostname}` : null;
    } catch { return null; }
}

function describeTargetError(e, host) {
    if (e.status) {
        let message = e.body ?? e.message;
        try { message = JSON.parse(e.body).error?.message ?? message; } catch { /* not json */ }
        if (e.status === 401 || e.status === 403) {
            return new Error(`${host} rejected the request (${e.status}). Open that environment in another tab to sign in, then try again.`);
        }
        return new Error(`${host}: ${message}`);
    }
    return new Error(`Could not reach ${host}. Make sure you are signed in to that environment in another browser tab.`);
}

async function recordExists(client, entitySetName, primaryIdAttr, recordId) {
    try {
        await client.get(`/${entitySetName}(${recordId})?$select=${primaryIdAttr}`);
        return true;
    } catch (e) {
        if (e.status === 404) return false;
        throw e;
    }
}

/**
 * Checks a target org before anything is written: does the table exist, which
 * columns survive, do the lookup references resolve (users and teams by
 * identity, everything else by id), is the GUID still free.
 */
async function preflightTarget(targetUrl, host, entityName, recordId, sourceRecord, { mapIdentities = true } = {}) {
    const client = new Dataverse(targetUrl);
    let metadata;
    try {
        metadata = await fetchEntityMetadata(entityName, client);
    } catch (e) {
        if (e.status === 404) throw new Error(`Table "${entityName}" does not exist in ${host}.`);
        throw describeTargetError(e, host);
    }
    if (!metadata) throw new Error(`Table "${entityName}" does not exist in ${host}.`);

    try {
        const attrs = await fetchWritableAttributes(entityName, client);
        await prefetchLookupTargets(sourceRecord);

        const dropped = [];
        const lookups = [];
        cleanRecordForClone(sourceRecord, metadata.PrimaryIdAttribute, false, {
            allowed: attrs.create, dropped, lookups,
            // The target's own names: the bind keys collected here are the
            // ones that will be written to it.
            navProps: await fetchLookupNavProperties(entityName, client),
        });

        // Create-invalid isn't the same as unsupported: some columns are simply
        // set after the fact, so they don't belong in the "skipped" count.
        const deferredColumns = Object.keys(updateOnlyColumns(sourceRecord, metadata, attrs) ?? {});
        const droppedColumns = dropped.filter((column) => !deferredColumns.includes(column));

        // A lookup pointing at a record the target doesn't have would fail the
        // whole create, so those binds are cleared instead (and reported).
        const missingLookups = [];
        const mappedIdentities = [];
        const unmappedIdentities = [];
        const rebind = new Map();

        await Promise.all(lookups.map(async (lookup) => {
            if (mapIdentities && isIdentityEntity(lookup.targetEntity)) {
                const identity = await fetchIdentity(lookup.targetEntity, lookup.id);
                const match = await resolveIdentityInTarget(client, lookup.targetEntity, identity);
                if (match.status === 'mapped') {
                    if (match.id !== lookup.id) rebind.set(lookup.bindKey, `/${lookup.targetSet}(${match.id})`);
                    mappedIdentities.push({
                        ...lookup, ...match,
                        source: identityName(lookup.targetEntity, identity, lookup.label),
                        image: identity?.entityimage_url ?? null,
                    });
                    return;
                }
                unmappedIdentities.push({
                    ...lookup, reason: match.status,
                    source: identityName(lookup.targetEntity, identity, lookup.label),
                });
                missingLookups.push(lookup);
                return;
            }
            const targetIdAttr = metadataCache[cacheKey(lookup.targetEntity, dv)]?.PrimaryIdAttribute
                ?? `${lookup.targetEntity}id`;
            try {
                if (!(await recordExists(client, lookup.targetSet, targetIdAttr, lookup.id))) missingLookups.push(lookup);
            } catch { missingLookups.push(lookup); }
        }));

        // The owner never rides along on its GUID either, but it is the one
        // user reference nearly every record has — so map it the same way.
        const owner = mapIdentities
            ? await resolveOwner(client, sourceRecord)
            : { status: 'skipped' };

        const exists = await recordExists(client, metadata.EntitySetName, metadata.PrimaryIdAttribute, recordId);

        // overriddencreatedon is a date-only column, so the clone inherits the
        // source's creation DATE; the time of day is not carried over.
        const createdOn = {
            supported: attrs.create.has('overriddencreatedon') && !!sourceRecord.createdon,
            value: sourceRecord.createdon ?? null,
            label: sourceRecord['createdon@OData.Community.Display.V1.FormattedValue']
                ?? (sourceRecord.createdon ?? '').slice(0, 10),
        };

        return {
            createdOn,
            url: targetUrl, host, client, metadata, attrs, exists, missingLookups,
            dropped: droppedColumns, deferredColumns,
            mappedIdentities, unmappedIdentities, rebind, owner, mapIdentities,
            dropBindKeys: new Set(missingLookups.map((lookup) => lookup.bindKey)),
            ownerBind: owner.status === 'mapped' ? `/${owner.entitySet}(${owner.id})` : null,
        };
    } catch (e) {
        throw e.status ? describeTargetError(e, host) : e;
    }
}

async function resolveOwner(client, sourceRecord) {
    const ownerId = cleanGuid(sourceRecord._ownerid_value ?? '');
    const ownerEntity = sourceRecord['_ownerid_value@Microsoft.Dynamics.CRM.lookuplogicalname'];
    if (!ownerId || !isIdentityEntity(ownerEntity)) return { status: 'none' };

    const identity = await fetchIdentity(ownerEntity, ownerId);
    const match = await resolveIdentityInTarget(client, ownerEntity, identity);
    return {
        ...match,
        // A disabled user can't be assigned; leaving the owner unset keeps the
        // create working (the record lands on the caller instead).
        status: match.status === 'mapped' && match.disabled ? 'disabled' : match.status,
        entity: ownerEntity,
        entitySet: entitySetNameSync(ownerEntity),
        source: identityName(ownerEntity, identity,
            sourceRecord['_ownerid_value@OData.Community.Display.V1.FormattedValue']),
        image: identity?.entityimage_url ?? null,
    };
}

// ── "Open as new" prefill ─────────────────────────────────────────────────
// Without Xrm.Navigation we prefill via extraqs; lookups use the classic
// field/fieldname/fieldtype triplet, which UCI still honors.
function openAsNewForm(sourceRecord, entityMetadata, entityName) {
    const parts = [];
    const push = (key, value) => parts.push(`${key}=${encodeURIComponent(value)}`);

    for (const [key, value] of Object.entries(sourceRecord)) {
        if (key.includes('@')) continue;
        const lower = key.toLowerCase();
        if (SYSTEM_FIELDS.includes(lower) || READONLY_FIELDS.includes(lower)) continue;
        if (key === entityMetadata.PrimaryIdAttribute) continue;
        if (value === null || value === undefined || typeof value === 'object') continue;
        if (isLookupValueKey(key)) continue;
        push(key, value);
    }

    for (const [key, value] of Object.entries(sourceRecord)) {
        if (!isLookupValueKey(key) || !value) continue;
        const targetEntity = sourceRecord[`${key}@Microsoft.Dynamics.CRM.lookuplogicalname`];
        if (!targetEntity) continue;
        const attrName = key.slice(1, -6);
        if (SYSTEM_LOOKUPS.includes(attrName)) continue;
        push(attrName, value);
        push(`${attrName}name`, sourceRecord[`${key}@OData.Community.Display.V1.FormattedValue`] ?? '');
        push(`${attrName}type`, targetEntity);
    }

    const extraqs = encodeURIComponent(parts.join('&'));
    window.open(`${location.origin}/main.aspx?pagetype=entityrecord&etn=${encodeURIComponent(entityName)}&extraqs=${extraqs}`, '_blank');
}

// ── Dialog ────────────────────────────────────────────────────────────────
let dialogOpen = false;

function getRecordContext() {
    const params = new URLSearchParams(location.search);
    const entityName = params.get('etn');
    const recordId = params.get('id');
    return params.get('pagetype') === 'entityrecord' && entityName && recordId
        ? { entityName, recordId: cleanGuid(recordId) } : null;
}

async function openCloneDialog() {
    const context = getRecordContext();
    if (!context) { ui.toast('⚠️ Open a record to clone it.'); return; }
    if (dialogOpen) return;
    dialogOpen = true;

    const state = {
        cloneMode: 'openForm',
        selected: new Map(), // SchemaName -> relationship
        relUpdate: new Map(), // SchemaName -> overwrite rows that already exist
        metadata: null,
        sourceRecord: null,
        relationships: [],
        target: null,        // preflight result for the chosen environment
        preserveIds: true,
        mapIdentities: true,
        // Off by default, to match what Dataverse does on its own: a new
        // record is owned by, and created by, whoever made the call — the
        // impersonated user when impersonating. Carrying the source's owner
        // and creation date across is migration behaviour, so it is asked for
        // rather than assumed. (createdby is not writable at all; only the
        // DATE can be carried over, through overriddencreatedon.)
        preserveOwner: false,
        preserveCreatedOn: false,
        // Additive by default: a promotion run adds what is missing and
        // leaves everything already in the target alone. Both destructive
        // behaviours are opt-in and are spelled out in the preview.
        backfillParents: true,
        updateExistingRelated: false,
        deleteOrphans: false,
        // MSCRMCallerID, remembered per target environment the way the
        // solution deployer does it.
        impersonateUserId: '',
        impersonateUserName: '',
        maxDepth: 1,
        plan: null,
        knownEnvs: [], currentEnvGroup: null, envGroupOpen: {},
        savedEnvs: [],
    };
    // With the GUID preserved, an existing target record is updated in place.
    const isUpsert = () => !!(state.target?.exists && state.preserveIds);

    /**
     * The owner to write, or null to let Dataverse decide. Leaving it unset is
     * the default: the platform then assigns the caller — the impersonated
     * user when impersonating — which is what a normal create does.
     */
    const ownerBindForWrite = () => (state.preserveOwner ? state.target?.ownerBind ?? null : null);

    // Shared by the preview and the write, so the preview can never drift from
    // what actually gets sent.
    const crossEnvOptions = (upsert) => ({
        client: state.target.client,
        preserveIds: state.preserveIds,
        setOwner: false,            // source-org user ids mean nothing in the target
        forUpdate: upsert,
        dropBindKeys: state.target.dropBindKeys,
        rebind: state.target.rebind,
        ownerBind: ownerBindForWrite(),
        overriddenCreatedOn: !upsert && state.preserveCreatedOn && state.target.createdOn.supported
            ? state.target.createdOn.value : null,
    });

    /**
     * Restores the user chosen for this environment and points the target
     * client at them. Applied to the CLIENT rather than to individual writes,
     * so the preflight reads, the plan and the write all speak as the same
     * user — a plan built as one identity and written as another would preview
     * the wrong thing.
     */
    async function applyImpersonationForTarget(url) {
        const map = await store.get('impersonationMap', {});
        const saved = map[url.toLowerCase()];
        state.impersonateUserId = saved?.id ?? '';
        state.impersonateUserName = saved?.name ?? '';
        state.target?.client.impersonate(state.impersonateUserId);
        state.plan = null;
    }

    async function setImpersonation(user) {
        const url = state.target.url;
        const map = await store.get('impersonationMap', {});
        if (user) map[url.toLowerCase()] = { id: user.systemuserid, name: user.fullname, email: user.internalemailaddress ?? '' };
        else delete map[url.toLowerCase()];
        await store.set('impersonationMap', map);
        await applyImpersonationForTarget(url);
        // Existence checks and writable-column reads were answered as the
        // previous identity; both can differ for another user.
        state.target = await preflightTarget(url, state.target.host, context.entityName, context.recordId,
            state.sourceRecord, { mapIdentities: state.mapIdentities });
        state.target.type = state.knownEnvs.find((e) => e.url === url)?.type ?? null;
        state.target.client.impersonate(state.impersonateUserId);
    }

    /**
     * Plans the whole graph against the target: which records exist, what
     * each one becomes, and in what order they can be written. Everything the
     * preview shows and the write performs comes from this one object.
     */
    async function buildPlan() {
        const selection = new Map([...state.selected].map(([schemaName, rel]) => [
            schemaName,
            { rel, updateExisting: state.relUpdate.get(schemaName) ?? state.updateExistingRelated },
        ]));
        return buildClonePlan({
            source: dv,
            target: state.target.client,
            root: {
                entity: context.entityName,
                id: context.recordId,
                record: state.sourceRecord,
                metadata: state.metadata,
            },
            // A table missing from the target is a fact about the plan, not a
            // failure — the planner reports it and drops that branch.
            metadataFor: async (entity, client) => {
                try { return await fetchEntityMetadata(entity, client); } catch { return null; }
            },
            // Bind keys are read from the TARGET's metadata: they are written
            // there, and a table can be named differently between orgs.
            lookupsOf: async (record, entity) =>
                collectLookups(record, await fetchLookupNavProperties(entity, state.target.client)),
            isIdentity: isIdentityEntity,
            parentBindKey: async (childEntity, attribute, parentEntity) =>
                bindKeyFor(await fetchLookupNavProperties(childEntity, state.target.client), attribute, parentEntity),
            selected: selection,
            options: {
                preserveIds: state.preserveIds,
                backfillParents: state.backfillParents,
                updateExistingRelated: state.updateExistingRelated,
                deleteOrphans: state.deleteOrphans,
                maxDepth: state.maxDepth,
            },
        });
    }

    /** The source record, expanded with the child collections that are selected. */
    async function sourceWithChildren(selected) {
        if (!selected.length) return state.sourceRecord;
        const expand = selected.map((rel) => rel.ReferencedEntityNavigationPropertyName).join(',');
        return dv.get(`/${state.metadata.EntitySetName}(${context.recordId})?$expand=${expand}`, ANNOTATIONS);
    }

    const backdrop = ui.mount(ui.el('div', { className: 'ppt dc-backdrop' }));
    let releaseEscape = () => {};
    const dispose = () => { dialogOpen = false; backdrop.remove(); releaseEscape(); };
    releaseEscape = ui.onEscape(dispose);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) dispose(); });

    const body = ui.el('div', { className: 'dc-body' });
    // The write is deliberately reachable only from the preview: seeing what
    // lands is the last step before it does.
    const executeBtn = ui.el('button', { className: 'ppt-btn primary', textContent: '📝 Open New Form' });
    const previewBtn = ui.el('button', { className: 'ppt-btn primary', textContent: '👁 Preview' });
    const backBtn = ui.el('button', { className: 'ppt-btn', textContent: '← Back', style: 'margin-right:auto;display:none' });
    let previewing = false;
    const footer = ui.el('div', { className: 'dc-footer', style: 'display:none' }, [
        backBtn,
        ui.el('button', { className: 'ppt-btn', textContent: 'Cancel', onclick: dispose }),
        previewBtn,
        executeBtn,
    ]);
    backdrop.appendChild(ui.el('div', { className: 'dc-modal' }, [
        ui.el('div', { className: 'dc-header' }, [
            ui.el('h2', {}, ['📋 Clone Record', ui.el('span', { className: 'dc-tag', textContent: context.entityName })]),
            ui.el('button', { className: 'ppt-icon-btn', textContent: '✕', title: 'Close (Esc)', onclick: dispose }),
        ]),
        body,
        footer,
    ]));

    const showLoading = (message) => body.replaceChildren(
        ui.el('div', { className: 'dc-center' }, [ui.el('div', { className: 'dc-spinner' }), message]));
    const showError = (title, message, retry) => body.replaceChildren(ui.el('div', { className: 'dc-center' }, [
        ui.el('div', { style: 'font-size:32px', textContent: '❌' }),
        ui.el('div', { style: 'color:var(--danger);font-weight:600', textContent: title }),
        ui.el('div', { className: 'dc-error', textContent: message }),
        ...(retry ? [ui.el('button', { className: 'ppt-btn', textContent: 'Try Again', onclick: retry })] : []),
    ]));

    function syncFooter() {
        const openForm = state.cloneMode === 'openForm';
        backBtn.style.display = previewing ? '' : 'none';
        executeBtn.disabled = false;

        if (!previewing) {
            // Options view: the only way forward is the preview — except for
            // the prefilled form, where the form itself is the preview.
            executeBtn.style.display = openForm ? '' : 'none';
            executeBtn.textContent = '📝 Open New Form';
            previewBtn.style.display = openForm ? 'none' : '';
            previewBtn.disabled = state.cloneMode === 'crossEnv' && !state.target;
            previewBtn.textContent = previewBtn.disabled ? '🌐 Select an Environment' : '👁 Preview';
            return;
        }

        previewBtn.style.display = 'none';
        executeBtn.style.display = '';
        if (state.cloneMode === 'deep') { executeBtn.textContent = '📋 Deep Clone & Save'; return; }
        // With deletions in the plan the button has to say so — this is the
        // last thing read before a destructive write.
        executeBtn.textContent = state.plan?.stats.delete
            ? `⚠️ Apply to ${state.target.host} (deletes ${state.plan.stats.delete})`
            : (isUpsert() ? `⬆️ Update in ${state.target.host}` : `⬆️ Clone to ${state.target.host}`);
    }

    function renderOptions(recordName) {
        const hasRelationships = state.relationships.length > 0;


        const relSection = ui.el('div', { style: 'display:none' });
        const envSection = ui.el('div', { style: 'display:none' });

        // Cross-environment writes go through a change set, which updates and
        // creates in the same transaction — so related records are in scope
        // even when the target already has the root. (Same-org deep clone is
        // still a deep insert, which only ever creates.)
        const relSectionVisible = () => (state.cloneMode === 'deep')
            || (state.cloneMode === 'crossEnv' && !!state.target);
        const syncSections = () => {
            relSection.style.display = relSectionVisible() ? '' : 'none';
            envSection.style.display = state.cloneMode === 'crossEnv' ? '' : 'none';
        };
        const selectAll = ui.el('input', { type: 'checkbox', style: 'margin-right:6px;accent-color:var(--accent)' });
        const selectAllLabel = ui.el('label', {
            style: 'display:none;font-size:12px;color:var(--accent);cursor:pointer;user-select:none',
        }, [selectAll, 'Select All']);
        const relList = ui.el('div', { className: 'dc-rel-list' });
        const relLoading = ui.el('div', { className: 'dc-center', style: 'padding:16px;font-size:13px' }, ['Loading related records…']);
        relList.appendChild(relLoading);

        relSection.append(
            ui.el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px' }, [
                ui.el('span', { style: 'font-size:13px;font-weight:600', textContent: 'Select Related Records to Clone' }),
                selectAllLabel,
            ]),
            hasRelationships ? relList : ui.el('div', { className: 'ppt-note', style: 'text-align:center', textContent: 'No cloneable 1:N relationships found for this entity.' }),
        );

        const rowCheckboxes = [];
        const updateSelectAll = () => {
            const visible = rowCheckboxes.filter((c) => c.row.style.display !== 'none');
            const checked = visible.filter((c) => c.checkbox.checked).length;
            selectAll.checked = visible.length > 0 && checked === visible.length;
            selectAll.indeterminate = checked > 0 && checked < visible.length;
        };
        selectAll.addEventListener('change', () => {
            for (const { row, checkbox, rel } of rowCheckboxes) {
                if (row.style.display === 'none') continue;
                checkbox.checked = selectAll.checked;
                if (selectAll.checked) state.selected.set(rel.SchemaName, rel);
                else state.selected.delete(rel.SchemaName);
            }
        });

        const MODES = [
            { id: 'openForm', label: '📝 Open as New', desc: 'Opens a new form with pre-filled values. Review and save it manually, or discard it without creating anything.' },
            { id: 'deep', label: '📋 Deep Clone', desc: 'Creates this record and the selected child records (1:N) in this environment immediately, via deep insert.', disabled: !hasRelationships },
            { id: 'crossEnv', label: '🌐 To Environment', desc: 'Copies this record into another environment you are signed in to, optionally keeping the same GUID.' },
        ];
        const modeDesc = ui.el('div', { className: 'dc-mode-desc' });
        const segment = ui.el('div', { className: 'dc-seg' });
        const segItems = [];
        for (const mode of MODES) {
            const input = ui.el('input', {
                type: 'radio', name: 'dc-mode', checked: state.cloneMode === mode.id, disabled: !!mode.disabled,
            });
            const item = ui.el('label', {
                className: `dc-seg-item${state.cloneMode === mode.id ? ' active' : ''}${mode.disabled ? ' disabled' : ''}`,
            }, [input, mode.label]);
            item.dataset.tip = mode.disabled ? 'This table has no cloneable 1:N relationships.' : mode.desc;
            input.addEventListener('change', () => {
                state.cloneMode = mode.id;
                syncMode();
                syncSections();
                syncFooter();
            });
            segItems.push({ item, input });
            segment.append(item);
        }
        const syncMode = () => {
            for (const { item, input } of segItems) item.classList.toggle('active', input.checked);
            modeDesc.textContent = MODES.find((mode) => mode.id === state.cloneMode)?.desc ?? '';
        };

        // ── Target environment picker ─────────────────────────────────────
        // No section heading: while picking, the list speaks for itself; once
        // connected, the target card names the environment.
        const envBody = ui.el('div');
        envSection.append(envBody);

        const connect = async (url) => {
            const host = new URL(url).hostname;
            envBody.replaceChildren(ui.el('div', { className: 'dc-center', style: 'padding:16px;font-size:13px' }, [
                ui.el('div', { className: 'dc-spinner' }), `Checking ${host}…`,
            ]));
            try {
                state.target = await preflightTarget(url, host, context.entityName, context.recordId,
                    state.sourceRecord, { mapIdentities: state.mapIdentities });
                state.target.type = state.knownEnvs.find((e) => e.url === url)?.type ?? null;
                await applyImpersonationForTarget(url);
                if (!state.knownEnvs.some((e) => e.url === url) && !state.savedEnvs.includes(url)) {
                    state.savedEnvs = [...state.savedEnvs, url].slice(-8);
                    await store.set('targetEnvironments', state.savedEnvs);
                }
            } catch (e) {
                state.target = null;
                renderEnvPicker(e.message);
                syncSections();
                syncFooter();
                return;
            }
            renderEnvPicker();
            syncSections();
            syncFooter();
        };

        function renderEnvPicker(errorMessage) {
            if (state.target) { renderTargetSummary(); return; }

            const urlInput = ui.el('input', { className: 'ppt-input', placeholder: 'https://yourorg.crm4.dynamics.com', style: 'margin-bottom:8px' });
            const connectBtn = ui.el('button', { className: 'ppt-btn', textContent: 'Connect' });
            const submit = () => {
                const url = normalizeOrgUrl(urlInput.value);
                if (!url) { ui.toast('⚠️ Enter a valid https org URL.'); return; }
                connect(url);
            };
            connectBtn.addEventListener('click', submit);
            urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

            // A clone target is nearly always a sibling stage of the project
            // you are in, so that family opens and the others stay folded.
            const buttons = [];
            const groups = groupEnvironments(state.knownEnvs, { currentGroup: state.currentEnvGroup });
            for (const group of groups) {
                const key = group.group.toLowerCase();
                const isOpen = key in state.envGroupOpen
                    ? state.envGroupOpen[key]
                    : (group.isCurrent || groups.length === 1);
                const rows = group.envs.map((env) => {
                    // Names are whatever the registry already knows; this picker
                    // does not go fetch them, the indicator and deployer do.
                    const button = ui.el('button', { className: 'dc-env-btn' }, [
                        ...(env.type ? [envTypeBadge(env.type)] : []),
                        ...(env.name ? [ui.el('span', { className: 'name', textContent: env.name })] : []),
                        ui.el('span', { className: 'host', textContent: env.host }),
                    ]);
                    button.addEventListener('click', () => connect(env.url));
                    return button;
                });

                // One unnamed family is just a flat list; no header earns its space.
                if (groups.length === 1 && !group.group) { buttons.push(...rows); continue; }

                const head = ui.el('button', { className: 'dc-env-group-head' }, [
                    ui.el('span', { className: 'caret', textContent: isOpen ? '▼' : '▶' }),
                    ui.el('span', { textContent: group.label }),
                    ui.el('span', { className: 'count', textContent: `(${group.envs.length})` }),
                    ...(group.isCurrent ? [ui.el('span', { className: 'here', textContent: 'cloning from here' })] : []),
                ]);
                head.addEventListener('click', () => {
                    state.envGroupOpen[key] = !isOpen;
                    renderEnvPicker(errorMessage);
                });
                buttons.push(ui.el('div', { className: 'dc-env-group' },
                    isOpen ? [head, ui.el('div', { className: 'dc-env-group-body' }, rows)] : [head]));
            }
            for (const url of state.savedEnvs) {
                if (state.knownEnvs.some((e) => e.url === url)) continue;
                const button = ui.el('button', { className: 'dc-env-btn' }, [
                    ui.el('span', { className: 'host', textContent: new URL(url).hostname }),
                ]);
                button.addEventListener('click', () => connect(url));
                const remove = ui.el('button', { className: 'ppt-icon-btn', textContent: '🗑️', title: 'Forget this environment' });
                remove.addEventListener('click', async () => {
                    state.savedEnvs = state.savedEnvs.filter((u) => u !== url);
                    await store.set('targetEnvironments', state.savedEnvs);
                    renderEnvPicker();
                });
                buttons.push(ui.el('div', { className: 'dc-env-row' }, [button, remove]));
            }

            envBody.replaceChildren(
                ...(errorMessage ? [ui.el('div', { className: 'dc-error', style: 'margin-bottom:12px', textContent: errorMessage })] : []),
                ...(buttons.length
                    ? [ui.el('span', { className: 'ppt-label', style: 'margin-top:0', textContent: 'Known environments' }), ...buttons]
                    : []),
                ui.el('span', { className: 'ppt-label', textContent: 'Or enter an org URL' }),
                urlInput,
                connectBtn,
                ui.el('div', { className: 'ppt-note', style: 'margin-top:12px' }, [
                    'You must already be signed in to the target environment in this browser — the extension reuses your session and never stores credentials.',
                ]),
            );
        }

        // The label carries the full explanation as a tooltip: read once, then
        // it stops costing space on every visit.
        const optionChip = (checkbox, label, hint) => {
            const chip = ui.el('label', { className: `dc-opt${checkbox.checked ? ' on' : ''}` },
                [checkbox, label, ui.el('span', { className: 'info', textContent: 'ⓘ' })]);
            chip.dataset.tip = hint;
            checkbox.addEventListener('change', () => chip.classList.toggle('on', checkbox.checked));
            return chip;
        };

        /**
         * "Write as another user" — MSCRMCallerID, the same mechanism the
         * solution deployer uses, remembered per environment. Worth having
         * here because a promoted configuration usually wants to be owned and
         * audited as the service account, not as whoever ran the clone.
         */
        function impersonationSection() {
            const section = ui.el('div', { className: 'dc-imp' });

            if (state.impersonateUserId) {
                section.append(ui.el('div', { className: 'dc-imp-on' }, [
                    ui.el('span', { textContent: '👤' }),
                    ui.el('span', { className: 'who' }, [
                        'Writing as ',
                        ui.el('strong', { textContent: state.impersonateUserName }),
                    ]),
                    ui.el('button', {
                        className: 'ppt-icon-btn', textContent: '✕', title: 'Write as yourself again',
                        onclick: async () => {
                            await setImpersonation(null);
                            renderTargetSummary();
                            syncFooter();
                        },
                    }),
                ]));
                return section;
            }

            const input = ui.el('input', {
                className: 'ppt-input',
                placeholder: 'Write as another user — search the target by name or email…',
            });
            const results = ui.el('div', { className: 'dc-imp-results', style: 'display:none' });
            let timer = null;
            input.addEventListener('input', () => {
                clearTimeout(timer);
                timer = setTimeout(async () => {
                    const term = input.value.trim();
                    if (term.length < 2) { results.style.display = 'none'; return; }
                    results.replaceChildren(ui.el('div', { className: 'dc-imp-item muted', textContent: 'Searching…' }));
                    results.style.display = '';
                    try {
                        // Disabled users cannot be impersonated, so they are
                        // not worth offering.
                        const data = await state.target.client.get(
                            `/systemusers?$filter=isdisabled eq false and (contains(fullname,'${odataQuote(term)}') or contains(internalemailaddress,'${odataQuote(term)}'))&$select=systemuserid,fullname,internalemailaddress&$top=15&$orderby=fullname asc`);
                        const users = data.value ?? [];
                        results.replaceChildren(...(users.length
                            ? users.map((user) => {
                                const item = ui.el('div', { className: 'dc-imp-item' }, [
                                    ui.el('strong', { textContent: user.fullname }),
                                    ui.el('span', { className: 'mail', textContent: user.internalemailaddress ?? '' }),
                                ]);
                                item.addEventListener('click', async () => {
                                    results.style.display = 'none';
                                    await setImpersonation(user);
                                    renderTargetSummary();
                                    syncFooter();
                                });
                                return item;
                            })
                            : [ui.el('div', { className: 'dc-imp-item muted', textContent: 'No matching users' })]));
                    } catch (e) {
                        results.replaceChildren(ui.el('div', { className: 'dc-imp-item err', textContent: `Could not search users: ${e.message}` }));
                    }
                }, 350);
            });
            input.addEventListener('keydown', (e) => { if (e.key === 'Escape') results.style.display = 'none'; });

            section.append(input, results, ui.el('div', { className: 'ppt-note', style: 'margin-top:6px' }, [
                'Requires the "Act on Behalf of Another User" privilege in the target. Records are created and audited as that user.',
            ]));
            return section;
        }

        function renderTargetSummary() {
            const target = state.target;
            // One row per fact: label on the left, status icon + short value on
            // the right, details demoted to a sub-line.
            const row = (label, icon, value, sub) => [
                ui.el('div', { className: 'k', textContent: label }),
                ui.el('div', { className: 'v' }, [
                    ui.el('span', { className: 'st' }, [icon]),
                    ui.el('span', { className: `val${icon === '⚠️' ? ' warn' : ''}` }, [
                        value,
                        ...(sub ? [ui.el('span', { className: 'sub', textContent: sub })] : []),
                    ]),
                ]),
            ];

            const change = ui.el('button', { className: 'ppt-btn', textContent: 'Change' });
            change.addEventListener('click', () => {
                state.target = null;
                state.plan = null;
                renderEnvPicker();
                syncSections();
                syncFooter();
            });

            const preserve = ui.el('input', { type: 'checkbox', checked: state.preserveIds });
            preserve.addEventListener('change', () => {
                state.preserveIds = preserve.checked;
                state.plan = null;
                renderTargetSummary();
                syncSections();
                syncFooter();
            });

            // Re-resolving identities means re-running the preflight.
            const mapIdentities = ui.el('input', { type: 'checkbox', checked: state.mapIdentities });
            mapIdentities.addEventListener('change', () => {
                state.mapIdentities = mapIdentities.checked;
                connect(target.url);
            });

            const keepCreatedOn = ui.el('input', { type: 'checkbox', checked: state.preserveCreatedOn });
            keepCreatedOn.addEventListener('change', () => {
                state.preserveCreatedOn = keepCreatedOn.checked;
                state.plan = null;
                renderTargetSummary();
            });

            const keepOwner = ui.el('input', { type: 'checkbox', checked: state.preserveOwner });
            keepOwner.addEventListener('change', () => {
                state.preserveOwner = keepOwner.checked;
                state.plan = null;
                renderTargetSummary();
            });

            // The graph options. All three change what the plan contains, so
            // any cached plan is dropped and rebuilt on the next preview.
            const graphOption = (key, onChange) => {
                const box = ui.el('input', { type: 'checkbox', checked: state[key] });
                box.addEventListener('change', () => {
                    state[key] = box.checked;
                    state.plan = null;
                    onChange?.();
                });
                return box;
            };
            const backfill = graphOption('backfillParents');
            const updateRelated = graphOption('updateExistingRelated', () => {
                // The per-relationship toggles follow the global default until
                // they are set individually.
                state.relUpdate.clear();
                renderTargetSummary();
            });
            const deleteOrphans = graphOption('deleteOrphans', renderTargetSummary);

            // How far the selected relationships keep expanding. Level 1 is
            // the record's own children; beyond that each cloned child is
            // itself expanded, which is where a graph can grow fast — so this
            // stays an explicit choice rather than a default.
            const depth = ui.el('select', {
                className: 'ppt-input',
                style: 'width:auto;padding:4px 8px;font-size:12px;margin:0',
                title: 'How many levels of 1:N children to follow',
            }, [1, 2, 3].map((level) => ui.el('option', {
                value: String(level),
                selected: state.maxDepth === level,
                textContent: level === 1 ? 'Direct children only' : `Nested, ${level} levels`,
            })));
            depth.addEventListener('change', () => {
                state.maxDepth = Number(depth.value);
                state.plan = null;
            });

            // Non-identity lookups fail on their id; user/team ones fail their
            // identity match, which is worth spelling out separately.
            const missingPlain = target.missingLookups.filter((l) => !isIdentityEntity(l.targetEntity));
            // Self-contained: 'unreadable' is a failure on THIS side, the rest
            // are about the target, so neither can share a trailing clause.
            const IDENTITY_REASONS = {
                unmatched: 'no match in the target',
                ambiguous: 'more than one match in the target',
                unreadable: 'the record could not be read in this environment',
                disabled: 'the matched user is disabled in the target',
            };

            // "Jane Doe" when both orgs agree on the name, "Jane D. → Jane Doe"
            // when they don't — the interesting part is what it became.
            const mappedValue = (m) => {
                const targetName = m.label || m.id;
                return m.source && m.source !== targetName ? `${m.source} → ${targetName}` : targetName;
            };

            const tableLabel = state.metadata.DisplayName?.UserLocalizedLabel?.Label || context.entityName;
            // Whoever the writes will actually be made as.
            const callerLabel = state.impersonateUserId ? state.impersonateUserName : 'You';
            const callerIcon = state.impersonateUserId ? '👤' : '🙋';

            const report = ui.el('div', { className: 'dc-report' }, [
                ...row('Table', tableIcon(state.metadata), tableLabel,
                    tableLabel === context.entityName
                        ? 'exists in the target'
                        : `${context.entityName} · exists in the target`),
                ...(target.dropped.length
                    ? row('Columns', '⚠️', `${target.dropped.length} skipped`,
                        `missing or read-only in the target: ${target.dropped.slice(0, 6).join(', ')}${target.dropped.length > 6 ? '…' : ''}`)
                    : row('Columns', '✅', 'All supported in the target')),
                ...(target.deferredColumns.length && !isUpsert()
                    ? row('After create', 'ℹ️', `${target.deferredColumns.join(', ')} applied in a second pass`,
                        'the target rejects these on create — the record is created first, then updated')
                    : []),
                ...(missingPlain.length
                    ? row('Lookups', '⚠️', `${missingPlain.length} cleared`,
                        `no such record in the target: ${missingPlain.slice(0, 4).map((l) => l.attrName).join(', ')}${missingPlain.length > 4 ? '…' : ''}`)
                    : []),
                ...target.mappedIdentities.flatMap((m) => row(
                    m.attrName, identityIcon(m.targetEntity, m.image),
                    mappedValue(m), `matched by ${m.matchedBy}`)),
                ...target.unmappedIdentities.flatMap((m) => row(
                    m.attrName, '⚠️', `${m.source} — left empty`,
                    IDENTITY_REASONS[m.reason] ?? m.reason)),
                // Who ends up owning and creating the record. With "Keep
                // owner" off — the default — nothing is written and Dataverse
                // assigns the caller, so the answer is simply who that is.
                ...(isUpsert() ? [] : (state.preserveOwner
                    ? (target.owner.status === 'mapped'
                        ? row('Owner', identityIcon(target.owner.entity, target.owner.image),
                            mappedValue(target.owner), `carried over from the source · matched by ${target.owner.matchedBy}`)
                        : row('Owner', '⚠️', callerLabel,
                            `${target.owner.source} could not be carried over — ${IDENTITY_REASONS[target.owner.status] ?? target.owner.status}`))
                    : row('Owner', callerIcon, callerLabel,
                        'assigned by Dataverse, as on any new record'))),
                ...(isUpsert() ? [] : row('Created by', callerIcon, callerLabel,
                    'Dataverse always records the caller; the source creator cannot be carried over')),
                ...(isUpsert()
                    ? []
                    : (target.createdOn.supported && state.preserveCreatedOn
                        ? row('Created on', '📅', target.createdOn.label, 'stamped via overriddencreatedon — date only, no time of day')
                        : row('Created on', 'ℹ️', 'Now',
                            target.createdOn.supported ? 'the source date is not carried over' : 'the target does not accept overriddencreatedon on this table'))),
                ...(state.preserveIds
                    ? (target.exists
                        ? row('Record ID', 'ℹ️', 'Already exists — will update in place',
                            'related records are handled too: missing ones are created, existing ones follow the options above')
                        : row('Record ID', '✅', 'Free in the target', context.recordId))
                    : row('Record ID', 'ℹ️', 'Generated by the target', 'the source GUID is not reused')),
            ]);

            envBody.replaceChildren(
                ui.el('div', { className: 'dc-target' }, [
                    ...(target.type ? [envTypeBadge(target.type)] : []),
                    ui.el('span', { className: 'host', textContent: target.host }),
                    change,
                ]),
                impersonationSection(),
                ui.el('div', { className: 'dc-opts' }, [
                    optionChip(preserve, 'Same record ID',
                        'Creates the record in the target with the source GUID, so references from other environments and solutions keep resolving. Child records keep their GUIDs too.'),
                    optionChip(mapIdentities, 'Map users & teams',
                        'User and team GUIDs differ per environment, so those lookups (and the owner) are re-pointed by Entra object id, then UPN / email address.'),
                    ...(isUpsert() ? [] : [optionChip(keepOwner, 'Keep owner',
                        'Off (default): Dataverse assigns the owner itself — you, or the user being impersonated — which is what a normal create does. On: the source record\'s owner is matched in the target by Entra identity and assigned explicitly. Created-by is never carried over; Dataverse always records the caller.')]),
                    ...(target.createdOn.supported && !isUpsert()
                        ? [optionChip(keepCreatedOn, 'Keep created-on',
                            'Off (default): the record is dated now, as a new record normally is. On: the source date is stamped through overriddencreatedon, the column Dataverse reserves for migrated records — date-only, so the time of day is not carried over.')]
                        : []),
                    optionChip(backfill, 'Create missing parents',
                        'A lookup pointing at a record the target does not have is normally cleared. With this on, that record is created too — with the same GUID — along with anything it references in turn. Their own child records are never pulled in.'),
                    optionChip(updateRelated, 'Overwrite existing related',
                        'Off: related records already present in the target are left exactly as they are, and only missing ones are created. On: they are overwritten with the source values. Can be set per relationship in the list below.'),
                    optionChip(deleteOrphans, 'Delete removed related',
                        'DESTRUCTIVE. Deletes records that exist under the target parent but no longer exist under the source — for keeping a promoted configuration exactly in step. Every deletion is listed in the preview before anything is written.'),
                    depth,
                ]),
                report,
            );
        }

        const optionNodes = [
            ui.el('div', { className: 'dc-source' }, [
                ui.el('span', { className: 'lbl', textContent: 'Source' }),
                ui.el('span', { className: 'name', textContent: recordName, title: recordName }),
            ]),
            segment,
            modeDesc,
            envSection,
            relSection,
        ];
        // Detached nodes keep their state, so returning from the preview does
        // not re-run the relationship counts.
        const showOptions = () => {
            previewing = false;
            body.replaceChildren(...optionNodes);
            syncFooter();
        };

        // A read-only echo of the options view. Deliberately not the live
        // controls: changing them here would silently invalidate the tree
        // below, which is the one thing a confirmation step must not do.
        function previewContext() {
            const crossEnv = state.cloneMode === 'crossEnv';
            const mode = MODES.find((entry) => entry.id === state.cloneMode);
            const header = ui.el('div', { className: 'dc-ctx' }, [
                ui.el('span', { className: 'mode', textContent: mode?.label ?? '' }),
                ui.el('span', { className: 'arrow', textContent: '→' }),
            ]);
            if (crossEnv && state.target) {
                if (state.target.type) header.append(envTypeBadge(state.target.type));
                header.append(ui.el('span', { className: 'host', textContent: state.target.host, title: state.target.host }));
            } else {
                header.append(ui.el('span', { className: 'host', textContent: location.hostname, title: location.hostname }));
            }

            const staticChip = (on, label) => ui.el('span', {
                className: `dc-opt static ${on ? 'on' : 'off'}`,
                textContent: `${on ? '✓' : '✕'} ${label}`,
            });
            const chips = crossEnv ? ui.el('div', { className: 'dc-opts', style: 'margin: 10px 0 0' }, [
                staticChip(state.preserveIds, 'Same record ID'),
                staticChip(state.mapIdentities, 'Map users & teams'),
                ...(isUpsert() ? [] : [staticChip(state.preserveOwner, 'Keep owner')]),
                ...(state.target.createdOn.supported && !isUpsert()
                    ? [staticChip(state.preserveCreatedOn, 'Keep created-on')] : []),
                staticChip(state.backfillParents, 'Create missing parents'),
                staticChip(state.updateExistingRelated, 'Overwrite existing related'),
                staticChip(state.deleteOrphans, 'Delete removed related'),
                ...(state.impersonateUserId
                    ? [staticChip(true, `Writing as ${state.impersonateUserName}`)] : []),
            ]) : null;

            return ui.el('div', { className: 'dc-ctx-wrap' }, chips ? [header, chips] : [header]);
        }

        /**
         * The plan as it will be executed: one card per record, in write
         * order, each labelled with what happens to it. A record reached from
         * several places appears once — which is the point of the plan — and
         * says so.
         */
        async function buildPlanTree(plan) {
            const { stats } = plan;
            const counter = (kind, count, label) => (count
                ? [ui.el('span', { className: `c ${kind}`, textContent: `${count} ${label}` })] : []);

            const container = ui.el('div', {}, [
                ui.el('div', { className: 'dc-sum' }, [
                    ...counter('new', stats.create, 'to create'),
                    ...counter('update', stats.update, 'to update'),
                    ...counter('skip', stats.skip, 'left as-is'),
                    ...counter('del', stats.delete, 'to DELETE'),
                ]),
            ]);

            if (plan.deletes.length) {
                container.append(ui.el('div', { className: 'dc-del-box' }, [
                    ui.el('div', { className: 'hd', textContent: `${plan.deletes.length} record(s) will be permanently deleted from ${state.target.host}` }),
                    ...plan.deletes.slice(0, 12).map((removal) => ui.el('div', {
                        className: 'it',
                        textContent: `✕ ${removal.entity} — ${removal.label}`,
                        title: `${removal.entity} ${removal.id}`,
                    })),
                    ...(plan.deletes.length > 12
                        ? [ui.el('div', { className: 'it', textContent: `…and ${plan.deletes.length - 12} more` })] : []),
                ]));
            }

            for (const warning of plan.warnings) {
                container.append(ui.el('div', { className: 'dc-warn', style: 'margin-bottom:10px', textContent: warning }));
            }

            const BADGES = {
                [ACTIONS.CREATE]: { badge: 'NEW', kind: 'new' },
                [ACTIONS.UPDATE]: { badge: 'UPDATE', kind: 'update' },
                [ACTIONS.SKIP]: { badge: 'UNCHANGED', kind: 'skip' },
            };

            // Cards are built up front: rendering walks the tree recursively
            // and cannot await inside that walk.
            const cards = new Map();
            for (const node of plan.nodes) {
                const labels = await fetchAttributeLabels(node.entity);
                const nameAttr = node.metadata.PrimaryNameAttribute;
                const { badge, kind } = BADGES[node.action];
                // A skipped record is not written, so there is no payload to
                // show — only the fact that it is already there.
                const fields = node.action === ACTIONS.SKIP ? [
                    { key: '', label: 'Already in the target', value: 'left exactly as it is' },
                ] : payloadFields(
                    (await buildNodePayload(node, state.target.client, {
                        ownerBind: ownerBindForWrite(),
                        overriddenCreatedOn: state.preserveCreatedOn && state.target.createdOn.supported
                            ? state.target.createdOn.value : null,
                    })).payload,
                    node.record, labels, nameAttr);

                // Only meaningful for a backfilled parent: a record with many
                // children is not "shared", it just has children.
                const shared = node.kind === 'parent' && node.referencedBy.size > 1
                    ? `referenced ${node.referencedBy.size}× — created once` : null;
                cards.set(node.key, () => previewNode({
                    root: node.kind === 'root',
                    icon: tableIcon(node.metadata, '📄'),
                    title: node.record[nameAttr] ?? `${node.entity} ${node.targetId.slice(0, 8)}…`,
                    subtitle: [node.entity, shared].filter(Boolean).join(' · '),
                    badge,
                    badgeKind: kind,
                    fields,
                    limit: node.kind === 'root' ? 8 : 4,
                }));
            }

            // Containment, so children hang under the record they belong to
            // rather than all landing beside the root. A self-referential
            // relationship builds a real hierarchy here — a config and the
            // translations that live in the same table.
            const childrenOf = new Map();
            for (const node of plan.nodes) {
                if (!node.parentKey || node === plan.root) continue;
                if (!childrenOf.has(node.parentKey)) childrenOf.set(node.parentKey, []);
                childrenOf.get(node.parentKey).push(node);
            }

            const SHOWN = 5;
            const drawn = new Set();
            // Returns null for a record already placed elsewhere in the tree:
            // it is created once, so it is shown once.
            const draw = (node) => {
                if (drawn.has(node.key)) return null;
                drawn.add(node.key);
                const card = cards.get(node.key)();

                const children = (childrenOf.get(node.key) ?? []).filter((child) => !drawn.has(child.key));
                if (!children.length) return card;

                // Grouped by relationship: several collections under one
                // record stay legible only if each is named.
                const groups = new Map();
                for (const child of children) {
                    const name = child.rel?.SchemaName ?? 'related';
                    if (!groups.has(name)) groups.set(name, []);
                    groups.get(name).push(child);
                }

                const branch = ui.el('div', { className: 'dc-branch' });
                for (const [schemaName, group] of groups) {
                    branch.append(ui.el('div', {
                        className: 'dc-branch-title',
                        textContent: `${group.length} × ${group[0].entity}  ·  ${schemaName}`,
                        title: schemaName,
                    }));
                    for (const child of group.slice(0, SHOWN)) {
                        const rendered = draw(child);
                        if (rendered) branch.append(rendered);
                    }
                    if (group.length > SHOWN) {
                        branch.append(ui.el('div', {
                            className: 'dc-branch-title',
                            textContent: `…and ${group.length - SHOWN} more`,
                        }));
                    }
                }
                return ui.el('div', {}, [card, branch]);
            };

            // Backfilled parents come first: they are prerequisites, written
            // before the record that references them.
            const parents = plan.nodes.filter((node) => node.kind === 'parent');
            const tree = ui.el('div', { className: 'dc-tree' });
            const place = (node) => {
                const rendered = draw(node);
                if (rendered) tree.append(rendered);
            };
            if (parents.length) {
                tree.append(ui.el('div', { className: 'dc-branch-title', textContent: 'Missing referenced records, created first' }));
                for (const parent of parents) place(parent);
                tree.append(ui.el('div', { className: 'dc-branch-title', style: 'margin-top:6px', textContent: 'The record being cloned' }));
            }
            place(plan.root);
            // Anything the containment walk never reached still has to be
            // visible — the preview must account for every write.
            for (const node of plan.nodes) place(node);
            container.append(tree);

            if (stats.deferred) {
                container.append(ui.el('div', { className: 'ppt-note', style: 'margin-top:12px' }, [
                    `${stats.deferred} circular reference(s) are set in a follow-up step inside the same transaction, once both records exist.`,
                ]));
            }
            return container;
        }

        async function buildPreviewTree() {
            const crossEnv = state.cloneMode === 'crossEnv';
            const upsert = crossEnv && isUpsert();
            const selected = upsert ? [] : [...state.selected.values()];
            const sourceRecord = await sourceWithChildren(selected);
            const { payload, largeAnnotations } = await buildClonePayload(
                sourceRecord, state.metadata, selected, crossEnv ? crossEnvOptions(upsert) : {});

            const labels = await fetchAttributeLabels(context.entityName);
            const primaryName = payload[state.metadata.PrimaryNameAttribute] ?? recordName;

            // For an update, the record as it stands in the target is the
            // interesting half of the story: show the write as a diff.
            let targetRecord = null;
            if (upsert) {
                try {
                    targetRecord = await state.target.client.get(
                        `/${state.target.metadata.EntitySetName}(${context.recordId})`, ANNOTATIONS);
                } catch (e) {
                    console.warn('[Deep Clone] could not read the target record for the diff:', e);
                }
            }

            const fields = payloadFields(payload, sourceRecord, labels, state.metadata.PrimaryNameAttribute, targetRecord);
            const changes = fields.filter((field) => field.changed).length;
            const tree = ui.el('div', { className: 'dc-tree' }, [
                previewNode({
                    root: true,
                    icon: tableIcon(state.metadata, '📄'),
                    title: primaryName,
                    badge: targetRecord
                        ? (changes ? `${changes} CHANGE${changes > 1 ? 'S' : ''}` : 'NO CHANGES')
                        : (upsert ? 'UPDATE' : 'NEW'),
                    badgeKind: targetRecord && !changes ? '' : (upsert ? 'update' : 'new'),
                    subtitle: payload[state.metadata.PrimaryIdAttribute] ?? (crossEnv ? '' : 'new id'),
                    fields,
                }),
            ]);

            for (const rel of selected) {
                const children = payload[rel.ReferencedEntityNavigationPropertyName];
                if (!Array.isArray(children) || !children.length) continue;
                const childMetadata = await fetchEntityMetadata(rel.ReferencingEntity);
                const childLabels = await fetchAttributeLabels(rel.ReferencingEntity);
                const idAttr = childMetadata?.PrimaryIdAttribute;
                const nameAttr = childMetadata?.PrimaryNameAttribute;
                const sourceChildren = sourceRecord[rel.ReferencedEntityNavigationPropertyName] ?? [];
                const byId = new Map(sourceChildren.map((child) => [cleanGuid(child[idAttr] ?? ''), child]));

                const branch = ui.el('div', { className: 'dc-branch' }, [
                    ui.el('div', { className: 'dc-branch-title', textContent: `${children.length} × ${rel.ReferencingEntity}` }),
                ]);
                const SHOWN = 5;
                for (const [index, child] of children.slice(0, SHOWN).entries()) {
                    const source = byId.get(cleanGuid(child[idAttr] ?? '')) ?? sourceChildren[index];
                    branch.append(previewNode({
                        icon: tableIcon(childMetadata, '📄'),
                        title: child[nameAttr] ?? source?.[nameAttr] ?? rel.ReferencingEntity,
                        badge: 'NEW',
                        badgeKind: 'new',
                        fields: payloadFields(child, source, childLabels, nameAttr),
                        limit: 5,
                    }));
                }
                if (children.length > SHOWN) {
                    branch.append(ui.el('div', { className: 'dc-branch-title', textContent: `…and ${children.length - SHOWN} more` }));
                }
                tree.append(branch);
            }

            if (largeAnnotations.length) {
                tree.append(ui.el('div', { className: 'dc-branch' }, [
                    ui.el('div', { className: 'dc-branch-title', textContent: `${largeAnnotations.length} large file(s) uploaded after the record is created` }),
                    ...largeAnnotations.map((annotation) => previewNode({
                        icon: '📎',
                        title: annotation.filename ?? annotation.subject ?? 'File',
                        fields: [{ label: 'Size', value: `${Math.round(annotation.documentbody.length * 0.75 / 1024)} KB` }],
                        limit: 2,
                    })),
                ]));
            }
            return tree;
        }

        // Assigned, not added: renderOptions runs again after a retry.
        backBtn.onclick = showOptions;
        previewBtn.onclick = async () => {
            previewing = true;
            syncFooter();
            showLoading('Building preview…');
            try {
                if (state.cloneMode === 'crossEnv') {
                    showLoading('Planning the record graph…');
                    state.plan = await buildPlan();
                    body.replaceChildren(previewContext(), await buildPlanTree(state.plan));
                    syncFooter();
                    return;
                }
                body.replaceChildren(previewContext(), await buildPreviewTree());
            } catch (e) {
                console.error('[Deep Clone] preview failed:', e);
                showError('Could not build the preview', e.body ?? e.message, showOptions);
            }
        };

        showOptions();
        syncMode();
        renderEnvPicker();
        syncSections();
        footer.style.display = 'flex';
        syncFooter();

        // Child record counts load lazily; rows appear only when records exist.
        if (hasRelationships) {
            (async () => {
                let visibleCount = 0;
                for (const rel of state.relationships) {
                    const checkbox = ui.el('input', { type: 'checkbox' });
                    const count = ui.el('span', { className: 'count', textContent: '…' });
                    // Per-relationship override of "Overwrite existing
                    // related": translations may need republishing while some
                    // other collection must be left alone.
                    const overwrite = ui.el('button', {
                        className: 'ppt-icon-btn',
                        style: 'display:none;flex-shrink:0',
                        title: 'Overwrite rows of this relationship that already exist in the target',
                    });
                    const syncOverwrite = () => {
                        const on = state.relUpdate.get(rel.SchemaName) ?? state.updateExistingRelated;
                        overwrite.textContent = on ? '✏️' : '🚫';
                        overwrite.title = on
                            ? 'Existing rows of this relationship WILL be overwritten — click to leave them as they are'
                            : 'Existing rows of this relationship are left as they are — click to overwrite them';
                        overwrite.style.display = state.cloneMode === 'crossEnv' ? '' : 'none';
                    };
                    overwrite.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const on = state.relUpdate.get(rel.SchemaName) ?? state.updateExistingRelated;
                        state.relUpdate.set(rel.SchemaName, !on);
                        state.plan = null;
                        syncOverwrite();
                    });
                    const row = ui.el('label', { className: 'dc-rel', style: 'display:none' }, [
                        checkbox,
                        ui.el('div', { style: 'flex:1;min-width:0' }, [
                            ui.el('div', { className: 't', textContent: rel.ReferencingEntity }),
                            ui.el('div', { className: 'd', textContent: rel.SchemaName }),
                        ]),
                        count,
                        overwrite,
                    ]);
                    checkbox.addEventListener('change', () => {
                        if (checkbox.checked) state.selected.set(rel.SchemaName, rel);
                        else state.selected.delete(rel.SchemaName);
                        state.plan = null;
                        syncOverwrite();
                        updateSelectAll();
                    });
                    syncOverwrite();
                    rowCheckboxes.push({ row, checkbox, rel });
                    relList.appendChild(row);

                    try {
                        const data = await dv.get(`/${state.metadata.EntitySetName}(${context.recordId})/${rel.ReferencedEntityNavigationPropertyName}?$count=true&$top=1`,
                            { Prefer: 'odata.include-annotations="*"' });
                        const total = data['@odata.count'] ?? (data.value?.length ?? 0);
                        if (total > 0) {
                            row.style.display = '';
                            let text = `${total} record${total > 1 ? 's' : ''}`;
                            if (rel.ReferencingEntity === 'annotation') text = `${total} note${total > 1 ? 's' : ''}`;
                            count.textContent = text;
                            visibleCount++;
                        }
                    } catch { /* leave the row hidden */ }
                }
                relLoading.remove();
                selectAllLabel.style.display = visibleCount > 0 ? '' : 'none';
                if (!visibleCount) {
                    relList.appendChild(ui.el('div', { className: 'dc-center', style: 'padding:16px;font-size:13px' }, ['No related records found to clone.']));
                }
                updateSelectAll();
            })();
        }
    }

    function renderSuccess(newRecordId, childCount, uploadResults, { origin = location.origin, updated = false, notes = [] } = {}) {
        const failed = uploadResults.filter((r) => !r.success);
        const url = `${origin}/main.aspx?pagetype=entityrecord&etn=${encodeURIComponent(context.entityName)}&id=${encodeURIComponent(newRecordId)}`;
        const summary = updated
            ? 'Existing record updated in the target environment.'
            : (childCount > 0 ? `Cloned record with ${childCount} related record${childCount > 1 ? 's' : ''}.` : 'Record cloned successfully.');
        body.replaceChildren(ui.el('div', { className: 'dc-center' }, [
            ui.el('div', { style: 'font-size:48px', textContent: failed.length ? '⚠️' : '✅' }),
            ui.el('div', { style: `font-size:17px;font-weight:600;color:${failed.length ? '#835C00' : '#107C10'}`, textContent: failed.length ? 'Clone Completed with Warnings' : (updated ? 'Update Successful!' : 'Clone Successful!') }),
            ui.el('div', { style: 'font-size:14px', textContent: summary }),
            ...notes.map((note) => ui.el('div', { className: 'dc-warn', textContent: note })),
            ...(uploadResults.length ? [ui.el('div', { className: failed.length ? 'dc-warn' : 'ppt-note' }, [
                failed.length
                    ? `Some large files failed to upload:\n${failed.map((f) => `✗ ${f.filename}: ${f.error}`).join('\n')}`
                    : `✓ ${uploadResults.length} large file(s) uploaded separately`,
            ])] : []),
            ui.el('a', { className: 'ppt-btn primary', href: url, target: '_blank', textContent: 'Open Cloned Record →', style: 'text-decoration:none' }),
        ]));
        footer.replaceChildren(ui.el('button', { className: 'ppt-btn', textContent: 'Close', onclick: dispose }));
    }

    // Cross-environment: the record is written to the target org with the same
    // GUID (unless opted out), so it stays identifiable across environments.
    /**
     * Writes the planned graph as one atomic change set. Everything the
     * preview showed — creates, updates, deferred references, deletions —
     * lands together or not at all.
     */
    async function executePlannedClone() {
        const target = state.target;
        const plan = state.plan;

        const result = await executePlan(plan, target.client, {
            preserveIds: state.preserveIds,
            ownerBind: ownerBindForWrite(),
            overriddenCreatedOn: state.preserveCreatedOn && target.createdOn.supported
                ? target.createdOn.value : null,
        }, (operations, mode) => {
            executeBtn.textContent = mode === 'deep insert'
                ? 'Writing (deep insert)…'
                : `Writing ${operations} operation${operations > 1 ? 's' : ''}…`;
        });

        const uploadResults = [];
        if (result.largeFiles.length) {
            executeBtn.textContent = 'Uploading large files…';
            for (const file of result.largeFiles) {
                try {
                    const parent = plan.nodes.find((node) => node.key === file.node.parentKey);
                    await uploadLargeAnnotation(target.client,
                        parent?.entity ?? context.entityName,
                        parent?.entitySet ?? target.metadata.EntitySetName,
                        parent?.targetId ?? plan.root.targetId, file);
                    uploadResults.push({ success: true, filename: file.filename });
                } catch (e) {
                    uploadResults.push({ success: false, filename: file.filename, error: e.message });
                }
            }
        }

        const notes = [];
        notes.push(result.mode === 'deep insert'
            ? 'Written as a single deep insert.'
            : `${result.operations} operation(s) written as one change set, in a single transaction.`);
        notes.push(...result.notes);
        if (state.impersonateUserId) {
            notes.push(`Written as ${state.impersonateUserName} — that user owns the records and appears as their creator.`);
        }
        if (plan.stats.skip) {
            notes.push(`${plan.stats.skip} related record(s) already in the target were left unchanged. Turn on "Overwrite existing related" to update them instead.`);
        }
        if (plan.stats.delete) notes.push(`${plan.stats.delete} record(s) were deleted from the target.`);
        const backfilled = plan.nodes.filter((node) => node.kind === 'parent' && node.action === ACTIONS.CREATE);
        if (backfilled.length) {
            notes.push(`${backfilled.length} missing parent record(s) were created with their original GUIDs: ${backfilled.map((node) => node.entity).join(', ')}`);
        }
        // Only claim the owner was carried over if it actually was.
        const ownerCarried = state.preserveOwner && target.owner.status === 'mapped';
        if (target.mappedIdentities.length || ownerCarried) {
            const mapped = target.mappedIdentities.map((m) => `${m.attrName} → ${m.label || m.id}`);
            if (ownerCarried) mapped.unshift(`owner → ${target.owner.label || target.owner.id}`);
            notes.push(`Users & teams mapped to the target environment: ${mapped.join(', ')}`);
        }
        if (!state.preserveOwner) {
            notes.push(state.impersonateUserId
                ? `Owner and created-by were assigned by Dataverse to ${state.impersonateUserName}, the impersonated user.`
                : 'Owner and created-by were assigned by Dataverse to you, as on any new record.');
        }
        if (result.dropped.length) {
            notes.push(`${result.dropped.length} column(s) were skipped — missing or read-only in the target: ${result.dropped.slice(0, 10).join(', ')}${result.dropped.length > 10 ? '…' : ''}`);
        }
        for (const warning of plan.warnings) notes.push(warning);

        renderSuccess(plan.root.targetId, plan.stats.create + plan.stats.update - 1, uploadResults,
            { origin: target.url, updated: plan.root.action === ACTIONS.UPDATE, notes });
    }

    async function executeCrossEnvClone() {
        const target = state.target;
        const upsert = isUpsert();
        const selected = upsert ? [] : [...state.selected.values()];
        const sourceRecord = await sourceWithChildren(selected);
        const { payload, largeAnnotations, deferred } =
            await buildClonePayload(sourceRecord, state.metadata, selected, crossEnvOptions(upsert));

        let newRecordId;
        if (upsert) {
            delete payload[target.metadata.PrimaryIdAttribute];
            await target.client.send('PATCH', `/${target.metadata.EntitySetName}(${context.recordId})`, payload);
            newRecordId = context.recordId;
        } else {
            newRecordId = await createClonedRecord(target.client, target.metadata, payload);
            if (!newRecordId) throw new Error('Record was created but its ID could not be determined.');
        }

        // statecode & co. only stick once the record exists. A failure here
        // leaves a good record in the default state, so it is reported, not thrown.
        let deferredNote = null;
        if (!upsert && deferred) {
            executeBtn.textContent = 'Applying state…';
            try {
                await target.client.send('PATCH', `/${target.metadata.EntitySetName}(${newRecordId})`, deferred);
            } catch (e) {
                deferredNote = `The record was created, but ${Object.keys(deferred).join(', ')} could not be applied afterwards: ${e.message}`;
            }
        }

        const uploadResults = [];
        if (largeAnnotations.length) {
            executeBtn.textContent = 'Uploading large files…';
            for (const annotation of largeAnnotations) {
                try {
                    await uploadLargeAnnotation(target.client, context.entityName, target.metadata.EntitySetName, newRecordId, annotation);
                    uploadResults.push({ success: true, filename: annotation.filename });
                } catch (e) {
                    uploadResults.push({ success: false, filename: annotation.filename, error: e.message });
                }
            }
        }

        const childCount = selected.reduce((sum, rel) => {
            const children = sourceRecord[rel.ReferencedEntityNavigationPropertyName];
            return sum + (Array.isArray(children) ? children.length : 0);
        }, 0);
        const notes = [];
        if (deferredNote) notes.push(deferredNote);
        // Only claim the owner was carried over if it actually was.
        const ownerCarried = state.preserveOwner && target.owner.status === 'mapped';
        if (target.mappedIdentities.length || ownerCarried) {
            const mapped = target.mappedIdentities.map((m) => `${m.attrName} → ${m.label || m.id}`);
            if (ownerCarried) mapped.unshift(`owner → ${target.owner.label || target.owner.id}`);
            notes.push(`Users & teams mapped to the target environment: ${mapped.join(', ')}`);
        }
        if (!state.preserveOwner) {
            notes.push(state.impersonateUserId
                ? `Owner and created-by were assigned by Dataverse to ${state.impersonateUserName}, the impersonated user.`
                : 'Owner and created-by were assigned by Dataverse to you, as on any new record.');
        }
        if (target.missingLookups.length) {
            notes.push(`${target.missingLookups.length} lookup reference(s) were left empty because the target has no matching record: ${target.missingLookups.map((l) => l.attrName).join(', ')}`);
        }
        if (target.dropped.length) {
            notes.push(`${target.dropped.length} column(s) were skipped — missing or read-only in the target: ${target.dropped.slice(0, 10).join(', ')}${target.dropped.length > 10 ? '…' : ''}`);
        }
        if (childCount) {
            notes.push(state.preserveIds
                ? 'Child records were created with their original GUIDs, but without their other lookup references.'
                : 'Child records were created with new GUIDs and without their other lookup references.');
        }
        renderSuccess(newRecordId, childCount, uploadResults, { origin: target.url, updated: upsert, notes });
    }

    async function executeClone() {
        if (state.cloneMode === 'openForm') {
            dispose();
            openAsNewForm(state.sourceRecord, state.metadata, context.entityName);
            return;
        }

        executeBtn.disabled = true;
        executeBtn.textContent = state.cloneMode === 'crossEnv' ? 'Writing to target…' : 'Cloning…';
        try {
            if (state.cloneMode === 'crossEnv') {
                // The plan is built by the preview, which is the only way to
                // reach this button — so it is always the plan that was shown
                // that gets written.
                await (state.plan ? executePlannedClone() : executeCrossEnvClone());
                return;
            }

            const selected = [...state.selected.values()];
            const sourceRecord = await sourceWithChildren(selected);
            const { payload, largeAnnotations } = await buildClonePayload(sourceRecord, state.metadata, selected);
            const newRecordId = await createClonedRecord(dv, state.metadata, payload);
            if (!newRecordId) throw new Error('Record was created but its ID could not be determined.');

            const uploadResults = [];
            if (largeAnnotations.length) {
                executeBtn.textContent = 'Uploading large files…';
                for (const annotation of largeAnnotations) {
                    try {
                        await uploadLargeAnnotation(dv, context.entityName, state.metadata.EntitySetName, newRecordId, annotation);
                        uploadResults.push({ success: true, filename: annotation.filename });
                    } catch (e) {
                        uploadResults.push({ success: false, filename: annotation.filename, error: e.message });
                    }
                }
            }

            const childCount = selected.reduce((sum, rel) => {
                const children = sourceRecord[rel.ReferencedEntityNavigationPropertyName];
                return sum + (Array.isArray(children) ? children.length : 0);
            }, 0);
            renderSuccess(newRecordId, childCount, uploadResults);
        } catch (e) {
            console.error('[Deep Clone] clone failed:', e);
            let message = e.body ?? e.message;
            try { message = JSON.parse(e.body).error?.message ?? message; } catch { /* not json */ }
            executeBtn.disabled = false;
            syncFooter();
            showError('Clone Failed', message, load);
        }
    }
    executeBtn.addEventListener('click', executeClone);

    async function load() {
        showLoading('Loading record and relationships…');
        footer.style.display = 'none';
        try {
            state.metadata = await fetchEntityMetadata(context.entityName);
            if (!state.metadata) throw new Error('Could not load entity metadata');
            state.relationships = await fetchCloneableRelationships(context.entityName);
            state.sourceRecord = await dv.get(`/${state.metadata.EntitySetName}(${context.recordId})`, ANNOTATIONS);
            state.savedEnvs = await store.get('targetEnvironments', []);
            ({ environments: state.knownEnvs, currentGroup: state.currentEnvGroup } = await fetchKnownEnvironments());
            const recordName = state.sourceRecord[state.metadata.PrimaryNameAttribute]
                ?? context.recordId.slice(0, 8) + '…';
            renderOptions(recordName);
        } catch (e) {
            showError('Error Loading Record', e.message);
        }
    }
    load();
}

export default {
    init() {
        dv = new Dataverse();
        store = createStore('deep-clone');
        ui.addStyle('dc', STYLE);
        commands.register({ toolId: 'deep-clone', title: 'Clone Record', icon: '📋', run: openCloneDialog });
    },
};
