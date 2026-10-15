// Flow Run Monitor (native).
// Explores the Dataverse flowruns elastic table: filterable run list with
// table/timeline/stats/errors/chart views, a run-details drawer, a
// connected-runs tree (parent/child runs via parentrunid) with zoom & pan,
// and CSV export. Runs open directly in Power Automate via the environment id
// from RetrieveCurrentOrganization.

import * as ui from '../core/ui.js';
import * as commands from '../core/commands.js';
import { showConnectedRunsDialog, extractErrorMessage as extractRunError, isGenericError, resolveRunError, errorSignature, fetchRunsByNames } from './shared/run-tree.js';
import { buildCanvasOriginResolver } from './shared/canvas-apps.js';
import { resolveCurrentOrg } from './shared/current-org.js';

const ANNOTATIONS = { Prefer: 'odata.include-annotations="*"' };

// $top is a hard TOTAL in the Web API, and using it suppresses @odata.nextLink
// — the response just stops and offers no continuation, so no amount of paging
// code can get past it. odata.maxpagesize is the page size that DOES come with
// a continuation link. Any query here that wants more than one page must use
// this and must NOT set $top. (flowruns is an elastic table, whose default page
// size is 500; shared/run-tree.js's fetchChildRuns is the working precedent —
// no $top, pages to thousands.)
const paged = (size) => ({ Prefer: `odata.include-annotations="*",odata.maxpagesize=${size}` });
const PAGE_SIZE = 50;
const ERRORS_RESOLVE_LIMIT = 100; // max generic failures whose child chain the Errors view drills for root causes
const ERRORS_RESOLVE_BATCH = 10;  // root-cause drill-downs run concurrently at a time
const FAILURES_PAGE_SIZE = 500;   // odata.maxpagesize for the Errors view — the elastic-table default
const MAX_FAILURES = 5000;        // safety valve against a runaway window, not a page size — failures page in via nextLink
const ANALYTICS_PAGE_SIZE = 500;  // odata.maxpagesize for the Stats and Chart aggregates
const MAX_ANALYTICS = 20000;      // budget for those aggregates
const RUN_FIELDS = 'flowrunid,name,status,starttime,endtime,duration,errorcode,errormessage,triggertype,modernflowtype,_workflow_value,_ownerid_value,workflowid,parentrunid';

const STYLE = `
    .frm-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.3); z-index: 2147483000; animation: ppt-fade 0.15s ease; }
    .frm-panel {
        position: fixed; top: 0; right: 0; bottom: 0;
        width: 85vw; min-width: 800px; max-width: 1800px;
        background: var(--bg); display: flex; flex-direction: column;
        box-shadow: -4px 0 24px rgba(0,0,0,0.18); animation: frm-slide 0.25s ease;
    }
    .frm-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 24px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .frm-header h2 { margin: 0; font-size: 18px; font-weight: 600; }
    .frm-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 24px; background: var(--bg2); border-bottom: 1px solid var(--border); flex-shrink: 0; flex-wrap: wrap; }
    .frm-toolbar-left { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .frm-tabs { display: flex; gap: 2px; background: var(--border); padding: 2px; border-radius: 6px; }
    .frm-tab { padding: 6px 14px; font-size: 12px; font-weight: 600; border: none; background: transparent; color: var(--muted); cursor: pointer; border-radius: 4px; font-family: inherit; }
    .frm-tab.active { background: var(--bg); color: var(--text); box-shadow: 0 1px 2px rgba(0,0,0,0.1); }
    .frm-chip { padding: 4px 10px; font-size: 11px; font-weight: 600; border: 1px solid var(--border); border-radius: 16px; background: var(--bg); color: var(--text); cursor: pointer; font-family: inherit; }
    .frm-chip:hover, .frm-chip.active { border-color: var(--accent); color: var(--accent); }
    .frm-filters { display: flex; flex-wrap: wrap; gap: 12px; padding: 12px 24px; background: var(--bg2); border-bottom: 1px solid var(--border); flex-shrink: 0; align-items: flex-end; }
    .frm-group { display: flex; flex-direction: column; gap: 4px; position: relative; }
    .frm-group .ppt-label { margin: 0; }
    .frm-content { flex: 1; overflow-y: auto; position: relative; }
    .frm-footer { padding: 10px 24px; border-top: 1px solid var(--border); flex-shrink: 0; background: var(--bg2); display: flex; align-items: center; justify-content: space-between; }
    .frm-footer-info { font-size: 13px; color: var(--muted); }
    .frm-selected {
        display: flex; align-items: center; gap: 6px; padding: 5px 10px; margin-bottom: 4px;
        background: var(--bg); border: 1px solid var(--accent); border-radius: 4px; font-size: 12px;
    }
    .frm-selected .name { flex: 1; color: var(--accent); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px; }
    .frm-ac {
        display: none; position: absolute; top: 100%; left: 0; right: 0; background: var(--bg);
        border: 1px solid var(--border); border-radius: 0 0 4px 4px; max-height: 200px;
        overflow-y: auto; z-index: 10; box-shadow: var(--shadow);
    }
    .frm-ac-item { padding: 8px 12px; cursor: pointer; font-size: 13px; border-bottom: 1px solid var(--border); }
    .frm-ac-item:hover { background: var(--bg2); }
    .frm-ac-msg { padding: 10px 12px; font-size: 13px; color: var(--muted); }
    .frm-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .frm-table th {
        text-align: left; padding: 10px 12px; font-weight: 600; color: var(--muted); font-size: 11px;
        text-transform: uppercase; letter-spacing: 0.3px; border-bottom: 2px solid var(--border);
        background: var(--bg2); white-space: nowrap; position: sticky; top: 0; z-index: 1;
    }
    .frm-table td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    .frm-table tr:hover td { background: var(--bg2); }
    .frm-table.frm-rows tbody tr { cursor: pointer; }
    .frm-badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; white-space: nowrap; }
    .frm-mono { font-family: Consolas, monospace; font-size: 11px; color: var(--muted); }
    .frm-icon-btn { background: transparent; border: none; cursor: pointer; padding: 5px; border-radius: 4px; font-size: 15px; line-height: 1; }
    .frm-icon-btn:hover { background: var(--bg2); }
    .frm-loading { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 48px; color: var(--muted); font-size: 14px; }
    .frm-spinner { width: 28px; height: 28px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: frm-spin 0.7s linear infinite; }
    .frm-error-msg { background: #FDE7E9; border: 1px solid #F1BBBC; color: #D13438; padding: 12px 16px; border-radius: 6px; font-size: 13px; margin: 16px 24px; word-break: break-word; }
    @media (prefers-color-scheme: dark) { .frm-error-msg { background: #3a1416; border-color: #6b2a2e; color: #F1707B; } }
    .frm-empty { display: flex; flex-direction: column; align-items: center; padding: 64px 24px; color: var(--muted); text-align: center; }
    .frm-empty .icon { font-size: 48px; margin-bottom: 16px; opacity: 0.5; }
    .frm-empty .title { font-size: 16px; font-weight: 600; color: var(--text); margin-bottom: 8px; }
    .frm-stats { padding: 24px; display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }
    .frm-stat-card { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 20px; }
    .frm-stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); font-weight: 600; margin-bottom: 8px; }
    .frm-stat-value { font-size: 32px; font-weight: 600; }
    .frm-stat-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
    .frm-chart-block { padding: 0 24px 24px; }
    .frm-chart-title { font-size: 14px; font-weight: 600; margin: 0 0 16px; }
    .frm-bar-row { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
    .frm-bar-label { width: 110px; font-size: 12px; color: var(--muted); text-align: right; flex-shrink: 0; }
    .frm-chart-block.wide .frm-bar-label { width: 280px; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .frm-bar-track { flex: 1; height: 24px; background: var(--bg2); border-radius: 4px; overflow: hidden; }
    .frm-bar-fill { height: 100%; border-radius: 4px; display: flex; align-items: center; justify-content: flex-end; padding-right: 8px; min-width: 24px; }
    .frm-bar-fill span { font-size: 11px; font-weight: 600; color: #fff; }
    .frm-errors-view { padding: 20px 24px 24px; }
    .frm-subbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
    .frm-subbar .ppt-label { margin: 0; }
    .frm-seg { display: flex; gap: 2px; background: var(--border); padding: 2px; border-radius: 6px; }
    .frm-seg button { padding: 5px 12px; font-size: 11px; font-weight: 600; border: none; background: transparent; color: var(--muted); cursor: pointer; border-radius: 4px; font-family: inherit; }
    .frm-seg button.active { background: var(--bg); color: var(--text); box-shadow: 0 1px 2px rgba(0,0,0,0.1); }
    .frm-issue { background: var(--bg); border: 1px solid var(--border); border-left: 4px solid #D13438; border-radius: 6px; margin-bottom: 10px; }
    .frm-issue-head { display: flex; align-items: flex-start; gap: 16px; padding: 12px 14px; cursor: pointer; }
    .frm-issue-head:hover { background: var(--bg2); }
    .frm-issue-main { flex: 1; min-width: 0; }
    .frm-issue-title { font-size: 13px; font-weight: 600; margin-bottom: 3px; word-break: break-word; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .frm-issue-msg { font-size: 12px; color: var(--muted); margin-top: 4px; word-break: break-word; line-height: 1.45; }
    .frm-issue-meta { font-size: 11px; color: var(--muted); display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 6px; }
    .frm-issue-side { display: flex; align-items: center; gap: 14px; flex-shrink: 0; }
    .frm-issue-count { text-align: right; min-width: 56px; }
    .frm-issue-count b { display: block; font-size: 22px; font-weight: 600; color: #D13438; line-height: 1.1; }
    .frm-issue-count span { font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; color: var(--muted); }
    .frm-issue-body { padding: 0 14px 14px; }
    .frm-tag { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; background: var(--bg2); color: var(--muted); border: 1px solid var(--border); }
    .frm-tag.code { font-family: Consolas, monospace; color: #D13438; border-color: #D1343840; background: #D1343810; }
    .frm-spark { display: flex; align-items: flex-end; gap: 1px; height: 28px; width: 150px; flex-shrink: 0; }
    .frm-spark i { flex: 1; min-height: 2px; background: #D13438; opacity: 0.8; border-radius: 1px 1px 0 0; }
    .frm-spark i.zero { background: var(--border); opacity: 1; }
    .frm-truncated { background: #FFF4CE; border: 1px solid #F2C94C; color: #6b5200; padding: 10px 14px; border-radius: 6px; font-size: 12px; line-height: 1.5; margin-bottom: 14px; }
    @media (prefers-color-scheme: dark) { .frm-truncated { background: #3a3116; border-color: #6b5a2a; color: #F5D97B; } }
    .frm-chain { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; color: var(--text); margin-top: 6px; }
    .frm-chain .arrow { opacity: 0.45; }
    .frm-chain .caught { color: #107C10; }
    .frm-chain .cut { color: #835C00; font-weight: 600; cursor: help; }
    .frm-chain .direct { opacity: 0.7; font-style: italic; }
    .frm-paths { margin-top: 6px; }
    .frm-paths .lead { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; opacity: 0.6; margin-bottom: 2px; }
    .frm-path-row { display: flex; align-items: baseline; gap: 8px; }
    .frm-path-row .frm-chain { margin-top: 0; }
    .frm-path-row .count { font-size: 11px; font-weight: 600; opacity: 0.85; white-space: nowrap; }
    .frm-path-row .more { font-size: 11px; opacity: 0.7; font-style: italic; }
    .frm-chain .origin { color: #D13438; font-weight: 600; }
    .frm-issue-title .arrow { opacity: 0.45; font-weight: 400; }
    .frm-bd { border-top: 1px solid var(--border); padding-top: 10px; }
    .frm-bd + .frm-bd { margin-top: 12px; }
    .frm-bd-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; color: var(--muted); font-weight: 600; margin-bottom: 6px; }
    .frm-bd-row { display: flex; align-items: center; gap: 10px; padding: 5px 0; font-size: 12px; }
    .frm-bd-name { flex: 1; min-width: 0; word-break: break-word; }
    .frm-bd-track { width: 120px; height: 8px; background: var(--bg2); border-radius: 4px; overflow: hidden; flex-shrink: 0; }
    .frm-bd-fill { height: 100%; background: #D13438; opacity: 0.75; border-radius: 4px; }
    .frm-bd-count { width: 44px; text-align: right; font-weight: 600; flex-shrink: 0; }
    .frm-error-code { font-family: Consolas, monospace; font-size: 13px; font-weight: 600; color: #D13438; }
    .frm-error-count { background: #FDE7E9; color: #A4262C; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
    @media (prefers-color-scheme: dark) { .frm-error-count { background: #3a1416; color: #F1707B; } .frm-error-code { color: #F1707B; } }
    .frm-error-message { font-size: 12px; padding: 8px 12px; background: var(--bg2); border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
    .frm-chart-view { padding: 24px; }
    .frm-legend { display: flex; gap: 16px; font-size: 12px; color: var(--muted); }
    .frm-legend-dot { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
    .frm-time-chart-wrap { display: flex; gap: 8px; height: 200px; }
    .frm-time-y { display: flex; flex-direction: column; justify-content: space-between; align-items: flex-end; font-size: 10px; color: var(--muted); width: 40px; }
    .frm-time-chart { flex: 1; display: flex; align-items: flex-end; gap: 1px; background: var(--bg2); border-radius: 4px; padding: 8px; overflow-x: auto; }
    .frm-time-bar { display: flex; flex-direction: column; justify-content: flex-end; height: 100%; }
    .frm-time-stack { display: flex; flex-direction: column; width: 100%; border-radius: 2px 2px 0 0; overflow: hidden; }
    .frm-time-seg { min-height: 2px; }
    .frm-time-x { display: flex; justify-content: space-between; padding: 8px 48px 0; font-size: 10px; color: var(--muted); }
    .frm-timeline-view { padding: 16px 24px; }
    .frm-tl-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--border); }
    .frm-tl-row:hover { background: var(--bg2); }
    .frm-tl-label { width: 180px; flex-shrink: 0; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .frm-tl-track { flex: 1; height: 18px; background: var(--bg2); border-radius: 2px; position: relative; }
    .frm-tl-bar { position: absolute; height: 100%; border-radius: 2px; min-width: 4px; }
    .frm-tl-duration { width: 60px; flex-shrink: 0; font-size: 11px; color: var(--muted); text-align: right; }
    .frm-detail {
        position: absolute; right: 0; top: 0; bottom: 0; width: 400px; background: var(--bg);
        border-left: 1px solid var(--border); box-shadow: -2px 0 12px rgba(0,0,0,0.1);
        z-index: 2; display: flex; flex-direction: column;
    }
    .frm-detail-header { padding: 14px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
    .frm-detail-body { flex: 1; overflow-y: auto; padding: 16px; }
    .frm-detail-row { display: flex; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
    .frm-detail-row .l { width: 100px; flex-shrink: 0; color: var(--muted); }
    .frm-detail-row .v { flex: 1; word-break: break-all; }
    @keyframes frm-slide { from { transform: translateX(100%); } }
    @keyframes frm-spin { to { transform: rotate(360deg); } }
`;

let dv; // the org of the open panel — see openPanel
let dvOrigin = null;
let environmentIdCache = null;

// ── Formatting helpers ────────────────────────────────────────────────────
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    // Quotes too — the same values are interpolated into attributes.
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const odataQuote = (s) => encodeURIComponent(String(s).replace(/'/g, "''"));

const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const formatDateTime = (iso) => (iso ? new Date(iso).toLocaleString() : '-');

function formatDuration(ms) {
    if (!ms && ms !== 0) return '-';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

function formatRelativeTime(iso) {
    if (!iso) return '-';
    const diffSec = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (diffSec < 60) return 'just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
    return new Date(iso).toLocaleDateString();
}

function parseDurationInput(value) {
    const match = value?.match(/^(\d+)(ms|s|m|h)?$/i);
    if (!match) return null;
    const num = parseInt(match[1], 10);
    return { s: num * 1000, m: num * 60000, h: num * 3600000 }[(match[2] ?? 'ms').toLowerCase()] ?? num;
}

function getStatusColor(status) {
    return {
        succeeded: '#107C10', failed: '#D13438', running: '#0F6CBD',
        cancelled: '#835C00', waiting: '#8764B8',
    }[(status ?? '').toLowerCase()] ?? '#616161';
}

// The views hold a raw errormessage string; the shared extractor takes a run
// record and unwraps nested serialized JSON (deeper than the old single-parse
// this replaced). Wrap it to keep the string-in signature the views use.
const extractErrorMessage = (errormessage) => extractRunError({ errormessage }) ?? '';

const flowName = (run) => run['_workflow_value@OData.Community.Display.V1.FormattedValue'] || 'Unknown Flow';
const FLOW_TYPE_LABELS = { 0: 'Power Automate', 1: 'Copilot Studio', 2: 'M365 Copilot Agent' };

function statusBadge(status) {
    const color = getStatusColor(status);
    return `<span class="frm-badge" style="background:${color}15;color:${color};border:1px solid ${color}30">${escapeHtml(status || 'Unknown')}</span>`;
}

// ── Data access ───────────────────────────────────────────────────────────
function dateFilterParts(filters) {
    const parts = [];
    if (filters.startDateFrom) {
        parts.push(`starttime ge ${filters.startDateFrom.includes('T') ? filters.startDateFrom + ':00Z' : filters.startDateFrom + 'T00:00:00Z'}`);
    }
    if (filters.startDateTo) {
        parts.push(`starttime le ${filters.startDateTo.includes('T') ? filters.startDateTo + ':00Z' : filters.startDateTo + 'T23:59:59Z'}`);
    }
    return parts;
}

function scopeFilterParts(filters) {
    const parts = dateFilterParts(filters);
    if (filters.workflowId) parts.push(`_workflow_value eq ${filters.workflowId}`);
    if (filters.ownerId) parts.push(`_ownerid_value eq ${filters.ownerId}`);
    return parts;
}

async function fetchFlowRuns(filters, paginationUrl = null) {
    let url = paginationUrl;
    if (!url) {
        const parts = scopeFilterParts(filters);
        if (filters.status) parts.push(`status eq '${filters.status}'`);
        if (filters.triggerType) parts.push(`triggertype eq '${odataQuote(filters.triggerType)}'`);
        if (filters.modernFlowType) parts.push(`modernflowtype eq ${filters.modernFlowType}`);
        if (filters.errorCode) parts.push(`contains(errorcode,'${odataQuote(filters.errorCode)}')`);
        if (filters.searchText) parts.push(`contains(name,'${odataQuote(filters.searchText)}')`);
        const filterQuery = parts.length ? `&$filter=${parts.join(' and ')}` : '';
        url = `/flowruns?$select=${RUN_FIELDS}${filterQuery}&$orderby=starttime desc`;
    }

    // maxpagesize, not $top — with $top there is no nextLink, and the Next
    // button this feeds would never have anywhere to go.
    const data = await dv.get(url, paged(PAGE_SIZE));
    let records = data.value ?? [];

    // Duration filtering happens client-side (elastic tables don't support it)
    const min = parseDurationInput(filters.durationMin);
    const max = parseDurationInput(filters.durationMax);
    if (min !== null || max !== null) {
        records = records.filter((r) => r.duration != null
            && (min === null || r.duration >= min)
            && (max === null || r.duration <= max));
    }

    return { records, nextLink: data['@odata.nextLink'] ?? null };
}

async function fetchWorkflows(searchText) {
    const search = searchText ? `contains(name,'${odataQuote(searchText)}') and ` : '';
    try {
        const data = await dv.get(`/workflows?$select=workflowid,name&$top=20&$filter=${search}category eq 5&$orderby=name`);
        return data.value ?? [];
    } catch { return []; }
}

async function fetchUsers(searchText) {
    const filter = searchText ? `&$filter=contains(fullname,'${odataQuote(searchText)}')` : '';
    try {
        const data = await dv.get(`/systemusers?$select=systemuserid,fullname&$top=20${filter}&$orderby=fullname`);
        return data.value ?? [];
    } catch { return []; }
}

async function fetchEnvironmentId() {
    if (!environmentIdCache) {
        try {
            environmentIdCache = (await dv.retrieveCurrentOrganization())?.EnvironmentId ?? null;
        } catch (e) {
            console.warn('[Flow Run Monitor] could not get environment id:', e);
        }
    }
    return environmentIdCache;
}

async function openFlowRun(workflowId, runName) {
    if (!workflowId || !runName) return;
    const environmentId = await fetchEnvironmentId();
    if (!environmentId) { ui.toast('⚠️ Could not determine the environment id.'); return; }
    window.open(`https://make.powerautomate.com/environments/${environmentId}/flows/${workflowId}/runs/${runName}?v3=true`, '_blank');
}

// OData GET against this org, annotations included — shared by the connected-
// runs tree and the root-cause drill-down in the list/detail views.
const apiGet = (path) => dv.get(path, ANNOTATIONS);

// The connected-runs tree lives in shared/run-tree.js; wire it to this org.
function showConnectedRuns(run) {
    showConnectedRunsDialog({
        startRun: run,
        apiGet,
        subtitle: flowName(run),
        openRun: (r) => openFlowRun(r._workflow_value, r.name),
        resolveOrigin: buildCanvasOriginResolver(apiGet, async (appId) => {
            const environmentId = await fetchEnvironmentId();
            return environmentId ? `https://apps.powerapps.com/play/e/${environmentId}/a/${appId}?source=portal` : null;
        }),
    });
}

// Follows @odata.nextLink until `limit` rows are collected or the server runs
// out of pages, the same way fetchChildRuns does in shared/run-tree.js: $top
// is the page size, `limit` is the budget. Truncating matters more here than
// it looks — a cut that lands mid-chain separates a child run from its parent,
// and the cascade stitching can then file the failure under the wrong flow, so
// callers are expected to surface `truncated`.
export async function fetchPagedRuns(apiGet, url, limit, onPage) {
    const runs = [];
    let next = url;
    while (next && runs.length < limit) {
        const data = await apiGet(next);
        runs.push(...(data.value ?? []));
        next = data['@odata.nextLink'] ?? null;
        onPage?.(runs.length);
    }
    return { runs: runs.slice(0, limit), truncated: Boolean(next) || runs.length > limit };
}

// ── Failure issue model ───────────────────────────────────────────────────
// Failures are fingerprinted into "issues" that can be pivoted three ways:
// by flow, by error, or by the flow×error cross ("this flow hit this error N
// times"). Pure and exported — this is the only part of the Errors view with
// real logic and no UI to eyeball. See scripts/flow-run-monitor-test.mjs.
export const SPARK_BUCKETS = 36;

// One failed run, with the drilled-out root cause folded in where there was
// one. `cause` comes from resolveRunError(); null when the run's own message
// was already specific enough.
export function toOccurrence(run, cause = null) {
    const message = cause?.message ?? extractErrorMessage(run.errormessage) ?? run.errorcode ?? 'Failed';
    return {
        run,
        stamp: new Date(run.starttime).getTime() || 0,
        flowId: run._workflow_value || 'unknown',
        flowLabel: flowName(run),
        errorCode: run.errorcode || 'Unknown Error',
        message,
        signature: errorSignature(message),
        sourceFlow: cause?.sourceFlow ?? null,
    };
}

// Fold a drilled-out root cause into an occurrence after the fact — the
// child-run lookup that finds it is async and happens after the rows load.
export function applyCause(occ, cause) {
    occ.message = cause.message;
    occ.signature = errorSignature(cause.message);
    occ.sourceFlow = cause.sourceFlow ?? occ.sourceFlow;
    return occ;
}

// ── Cascade collapsing ────────────────────────────────────────────────────
// flow1 calls flow2 calls flow3, and flow3 is where the error actually
// happens. That writes THREE failed rows: flow3's real message, and two
// ancestors saying "an action failed". Counting them as three problems
// triples every number and sends you to investigate two flows that are
// working perfectly — they just had the bad luck of calling something.
//
// Child runs carry parentrunid = the parent run's `name`, so a cascade can be
// stitched from the rows already fetched, with no extra API calls. Each
// distinct LEAF failure (a failed run with no failed child in the set) becomes
// one incident, attributed to the flow the error really happened in and
// carrying the call chain that led there. A run with two failed children is
// genuinely two incidents, and appears in both chains.
function makeIncident(chain) {
    const entry = chain[0];
    const origin = chain[chain.length - 1];
    return {
        origin,               // where the error actually happened
        entry,                // the run that was triggered, top of the chain
        chain,                // [entry … origin], outermost first
        runs: chain.map((o) => o.run),
        // Ancestors that caught the error are context, never failures.
        failedRuns: chain.filter((o) => !o.caught).map((o) => o.run),
        // The innermost ancestor that swallowed the error, if any: the flow
        // whose error handling is the reason nobody noticed.
        handledBy: [...chain].reverse().find((o) => o.caught) ?? null,
        // False when the top of the chain still points at a parent that was
        // never retrieved. Such a chain is cut short, not finished, and must
        // not be presented as a flow that nothing called.
        complete: !entry.run.parentrunid,
        // The grouping and sparkline helpers read these fields directly, so an
        // incident is interchangeable with a lone occurrence everywhere below.
        // Anchored on the origin: the question is when the error happened, not
        // when the business process that led to it started.
        stamp: origin.stamp || entry.stamp,
        flowId: origin.flowId,
        flowLabel: origin.flowLabel,
        errorCode: origin.errorCode,
        message: origin.message,
        signature: origin.signature,
        sourceFlow: origin.sourceFlow,
    };
}

export function buildCascades(occurrences, { collapse = true } = {}) {
    if (!collapse) return occurrences.filter((occ) => !occ.caught).map((occ) => makeIncident([occ]));

    const byRunName = new Map();
    for (const occ of occurrences) if (occ.run.name) byRunName.set(occ.run.name, occ);

    const parentOf = new Map();
    const hasFailedChild = new Set();
    for (const occ of occurrences) {
        const parent = occ.run.parentrunid ? byRunName.get(occ.run.parentrunid) : null;
        if (!parent || parent === occ) continue;
        parentOf.set(occ, parent);
        hasFailedChild.add(parent);
    }

    // A leaf is a failure with nothing failed beneath it. A caught ancestor
    // reports success, so it can never be where an error originated even if
    // its own child fell outside the fetched rows.
    return occurrences.filter((occ) => !occ.caught && !hasFailedChild.has(occ)).map((leaf) => {
        const chain = [leaf];
        const seen = new Set(chain);
        for (let up = parentOf.get(leaf); up && !seen.has(up); up = parentOf.get(up)) {
            seen.add(up);
            chain.unshift(up);
        }
        return makeIncident(chain);
    });
}

// A parent that catches the error — a Scope with a configure-run-after, a
// try/catch pattern — ends up Succeeded, so a failed-runs query never returns
// it and the chain looks like it starts at the child. That hides the business
// process that actually triggered the work, which is usually the thing the
// person is looking for.
//
// So: for every chain whose top still points at a parentrunid we haven't got,
// fetch that run whatever its status and keep walking up. The results join the
// occurrence pool, where buildCascades stitches them in like any other row —
// tagged `caught` so they read as context and are never counted as failures.
// Bounded on both hops and total lookups; a wall of failures must not turn
// into thousands of requests.
export async function collectAncestors(incidents, fetchRuns, { maxHops = 4, limit = 1000 } = {}) {
    const known = new Set();
    for (const incident of incidents) {
        for (const occ of incident.chain) if (occ.run.name) known.add(occ.run.name);
    }
    const pending = (names) => [...new Set(names.filter((n) => n && !known.has(n)))];

    const found = [];
    let frontier = pending(incidents.map((i) => i.entry.run.parentrunid));

    for (let hop = 0; hop < maxHops && frontier.length && found.length < limit; hop++) {
        const wanted = frontier.slice(0, limit - found.length);
        for (const name of wanted) known.add(name);

        const runs = [...(await fetchRuns(wanted).catch(() => new Map())).values()];

        for (const run of runs) {
            const occ = toOccurrence(run);
            occ.caught = (run.status ?? '').toLowerCase() !== 'failed';
            if (occ.caught) {
                // Nothing to group on — this run reports success. Keep only
                // what the chain breadcrumb needs.
                occ.message = '';
                occ.signature = '';
                occ.errorCode = run.status || 'Succeeded';
            }
            found.push(occ);
        }
        frontier = pending(runs.map((r) => r.parentrunid));
    }
    return found;
}

// Ancestors in a collapsed chain only ever said "an action failed". Hand them
// the origin's message so they still read sensibly when cascade collapsing is
// switched off. An ancestor shared by two failed children keeps the first
// message assigned; it is implicated in both either way.
export function propagateOriginCause(incidents) {
    for (const incident of incidents) {
        if (incident.chain.length < 2) continue;
        for (const ancestor of incident.chain.slice(0, -1)) {
            if (ancestor.caught || !isGenericError(ancestor.message)) continue;
            applyCause(ancestor, { message: incident.origin.message, sourceFlow: incident.origin.flowLabel });
        }
    }
    return incidents;
}

// errorSignature normalises ids, numbers and urls away, so "record 41 missing"
// and "record 77 missing" land in the same bucket.
export const errorKeyOf = (occ) => `${occ.errorCode}::${occ.signature}`;

// The caller: the flow at the top of the chain, which is the flow whose data
// or timing led into the failure. Same origin + same error but a different
// caller is worth separating — one caller may be feeding it bad input while
// the others are fine.
export const callerKeyOf = (incident) => (incident.chain.length > 1 ? incident.entry.flowId
    : incident.complete ? '' : '?');
export const callerLabelOf = (incident) => (incident.chain.length > 1 ? incident.entry.flowLabel
    : incident.complete ? 'Triggered directly' : 'Caller not loaded');

export const groupKeyOf = (item, groupBy) => (groupBy === 'flow' ? item.flowId
    : groupBy === 'error' ? errorKeyOf(item)
    : groupBy === 'caller' ? `${callerKeyOf(item)}::${item.flowId}::${errorKeyOf(item)}`
    : `${item.flowId}::${errorKeyOf(item)}`);

// Dimensions the pivot leaves free, so a card can offer exactly the
// breakdowns that still vary inside it.
const FIXED_BY_PIVOT = {
    flow: ['flow'],
    error: ['error'],
    'flow-error': ['flow', 'error'],
    caller: ['flow', 'error', 'caller'],
};
export const openDimensions = (groupBy) =>
    ['flow', 'error', 'caller'].filter((d) => !(FIXED_BY_PIVOT[groupBy] ?? []).includes(d));

// Incidents in, issues out. Keys come off the incident's ORIGIN, so a cascade
// is filed under the flow that actually broke rather than under whichever
// ancestor happened to be looked at.
export function buildIssues(incidents, groupBy, sort = 'count') {
    const map = new Map();
    for (const incident of incidents) {
        const key = groupKeyOf(incident, groupBy);
        let issue = map.get(key);
        if (!issue) {
            issue = { key, groupBy, sample: incident, incidents: [], first: incident.stamp, last: incident.stamp };
            map.set(key, issue);
        }
        issue.incidents.push(incident);
        if (incident.stamp && incident.stamp < issue.first) issue.first = incident.stamp;
        if (incident.stamp > issue.last) issue.last = incident.stamp;
    }
    return [...map.values()].sort((a, b) => (sort === 'recent' ? b.last - a.last
        : sort === 'first' ? a.first - b.first
        : b.incidents.length - a.incidents.length || b.last - a.last));
}

// Distinct failed runs behind an issue — always >= its incident count, and
// strictly greater wherever a cascade was collapsed.
export const issueRunCount = (issue) => new Set(issue.incidents.flatMap((i) => i.failedRuns)).size;

// Counts along the dimension the current pivot doesn't group by: the flows
// behind one error, or the errors behind one flow.
export function issueBreakdown(issue, by) {
    const map = new Map();
    for (const incident of issue.incidents) {
        const key = by === 'flow' ? incident.flowId
            : by === 'caller' ? callerKeyOf(incident)
            : errorKeyOf(incident);
        let row = map.get(key);
        if (!row) {
            row = {
                key,
                count: 0,
                label: by === 'flow' ? incident.flowLabel
                    : by === 'caller' ? callerLabelOf(incident)
                    : incident.message,
                code: incident.errorCode,
                // What the 🔎 drill-down filters on: the flow this row is about.
                flowId: by === 'caller' ? callerKeyOf(incident) : incident.flowId,
                // A caller that ends Succeeded swallowed the error — worth
                // flagging, since its own run history looks clean.
                caught: by === 'caller' ? Boolean(incident.entry.caught) : false,
            };
            map.set(key, row);
        }
        row.count++;
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
}

// The distinct ROUTES behind an issue. Grouping by caller alone collapses
// "A -> B -> C" and "A -> C" into one row and loses the middle flow, which is
// usually the one that actually chose to make the call. Two incidents share a
// route only if every hop matches.
export function distinctPaths(incidents) {
    const map = new Map();
    for (const incident of incidents) {
        const key = incident.chain.map((o) => o.flowId).join('>') + (incident.complete ? '' : '>?');
        let row = map.get(key);
        if (!row) { row = { key, incident, count: 0 }; map.set(key, row); }
        row.count++;
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
}

// Occurrence histogram over a window shared by every card, so the sparkline
// shapes are comparable between issues rather than each self-scaled in time.
export function sparkBins(items, windowStart, windowEnd, buckets = SPARK_BUCKETS) {
    const span = Math.max(1, windowEnd - windowStart);
    const bins = new Array(buckets).fill(0);
    for (const occ of items) {
        if (!occ.stamp) continue;
        const ratio = (occ.stamp - windowStart) / span;
        bins[Math.min(buckets - 1, Math.max(0, Math.floor(ratio * buckets)))]++;
    }
    return bins;
}

export const truncate = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

// ── Panel ─────────────────────────────────────────────────────────────────
let panelOpen = false;

async function openPanel() {
    if (panelOpen) return;
    panelOpen = true; // claimed while the org is resolved

    const org = await resolveCurrentOrg({ purpose: 'its flow runs can be read' });
    if (!org) { panelOpen = false; return; }
    // A maker-portal tab can move to another environment without reloading.
    if (org.origin !== dvOrigin) environmentIdCache = null;
    dv = org.dv;
    dvOrigin = org.origin;

    const filters = {
        status: '', workflowId: '', workflowName: '',
        startDateFrom: toLocalInput(new Date(Date.now() - 7 * 86400000)),
        startDateTo: toLocalInput(new Date()),
        triggerType: '', modernFlowType: '', ownerId: '', ownerName: '',
        errorCode: '', searchText: '', durationMin: '', durationMax: '',
    };
    let flowRuns = [];
    let nextLink = null;
    let previousLinks = [];
    let currentView = 'table';
    let isLoading = false;
    let detailPanel = null;

    const backdrop = ui.mount(ui.el('div', { className: 'ppt frm-backdrop' }));
    let releaseEscape = () => {};
    const dispose = () => { panelOpen = false; backdrop.remove(); releaseEscape(); };
    releaseEscape = ui.onEscape(dispose);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) dispose(); });

    const panel = ui.el('div', { className: 'frm-panel' });
    panel.innerHTML = `
        <div class="frm-header">
            <div style="display:flex;align-items:center;gap:12px">
                <h2>⚡ Flow Run Monitor</h2>
                <span class="ppt-note" style="margin:0;padding:4px 10px;font-size:12px;font-weight:600;color:var(--accent)">Power Automate</span>
            </div>
            <button class="ppt-icon-btn" data-action="close" title="Close (Esc)">✕</button>
        </div>
        <div class="frm-toolbar">
            <div class="frm-toolbar-left">
                <div class="frm-tabs">
                    <button class="frm-tab active" data-view="table">📋 Table</button>
                    <button class="frm-tab" data-view="timeline">⏱ Timeline</button>
                    <button class="frm-tab" data-view="stats">📊 Stats</button>
                    <button class="frm-tab" data-view="errors">🔴 Errors</button>
                    <button class="frm-tab" data-view="chart">📈 Chart</button>
                </div>
                <div style="display:flex;gap:6px;flex-wrap:wrap">
                    <button class="frm-chip active" data-status="">All</button>
                    <button class="frm-chip" data-status="Succeeded">✓ Succeeded</button>
                    <button class="frm-chip" data-status="Failed">✗ Failed</button>
                    <button class="frm-chip" data-status="Running">⟳ Running</button>
                    <button class="frm-chip" data-status="Cancelled">⊘ Cancelled</button>
                </div>
                <div style="display:flex;gap:6px;flex-wrap:wrap">
                    <button class="frm-chip" data-range="1">1h</button>
                    <button class="frm-chip" data-range="24">24h</button>
                    <button class="frm-chip active" data-range="168">7d</button>
                    <button class="frm-chip" data-range="720">30d</button>
                </div>
            </div>
            <div style="display:flex;gap:8px">
                <button class="ppt-btn" data-action="toggle-filters">⚙ Filters<span data-slot="filter-count"></span></button>
                <button class="ppt-btn" data-action="refresh">↻ Refresh</button>
                <button class="ppt-btn" data-action="export">⬇ Export CSV</button>
            </div>
        </div>
        <div class="frm-filters" hidden>
            <div class="frm-group"><span class="ppt-label">Search</span><input type="text" class="ppt-input" data-f="search" placeholder="Search by name…" style="width:170px"></div>
            <div class="frm-group" style="width:200px">
                <span class="ppt-label">Flow</span>
                <div data-sel="workflow" style="display:none"></div>
                <input type="text" class="ppt-input" data-f="workflow" placeholder="Search flows…">
                <div class="frm-ac" data-ac="workflow"></div>
            </div>
            <div class="frm-group"><span class="ppt-label">From</span><input type="datetime-local" class="ppt-input" data-f="from" value="${filters.startDateFrom}" style="width:180px"></div>
            <div class="frm-group"><span class="ppt-label">To</span><input type="datetime-local" class="ppt-input" data-f="to" value="${filters.startDateTo}" style="width:180px"></div>
            <div class="frm-group"><span class="ppt-label">Trigger Type</span><input type="text" class="ppt-input" data-f="trigger" placeholder="e.g. Manual" style="width:110px"></div>
            <div class="frm-group"><span class="ppt-label">Flow Type</span>
                <select class="ppt-select" data-f="flowtype" style="width:150px">
                    <option value="">All Types</option>
                    <option value="0">Power Automate</option>
                    <option value="1">Copilot Studio</option>
                    <option value="2">M365 Copilot Agent</option>
                </select>
            </div>
            <div class="frm-group" style="width:180px">
                <span class="ppt-label">Owner</span>
                <div data-sel="owner" style="display:none"></div>
                <input type="text" class="ppt-input" data-f="owner" placeholder="Search users…">
                <div class="frm-ac" data-ac="owner"></div>
            </div>
            <div class="frm-group"><span class="ppt-label">Duration Min</span><input type="text" class="ppt-input" data-f="durmin" placeholder="e.g. 5s" style="width:80px" title="e.g. 100ms, 5s, 1m, 1h"></div>
            <div class="frm-group"><span class="ppt-label">Duration Max</span><input type="text" class="ppt-input" data-f="durmax" placeholder="e.g. 30s" style="width:80px"></div>
            <div class="frm-group"><span class="ppt-label">Error Code</span><input type="text" class="ppt-input" data-f="errcode" placeholder="e.g. 429" style="width:90px"></div>
            <button class="ppt-btn primary" data-action="apply">Apply Filters</button>
            <button class="ppt-btn" data-action="clear">Clear</button>
        </div>
        <div class="frm-content"></div>
        <div class="frm-footer">
            <span class="frm-footer-info">Loading…</span>
            <span class="frm-pagination" style="display:flex;gap:8px;align-items:center"></span>
        </div>`;
    backdrop.appendChild(panel);

    const $ = (sel) => panel.querySelector(sel);
    const content = $('.frm-content');
    const footerInfo = $('.frm-footer-info');
    const pagination = $('.frm-pagination');
    $('[data-action=close]').addEventListener('click', dispose);

    // ── Run actions shared by views ──────────────────────────────────────
    function wireRunActions(container, runs) {
        for (const btn of container.querySelectorAll('[data-action="view-details"]')) {
            btn.addEventListener('click', () => {
                const run = runs.find((r) => r.flowrunid === btn.dataset.runid);
                if (run) showRunDetails(run);
            });
        }
        for (const btn of container.querySelectorAll('[data-action="view-tree"]')) {
            btn.addEventListener('click', () => {
                const run = runs.find((r) => r.flowrunid === btn.dataset.runid);
                if (run) showConnectedRuns(run);
            });
        }
        for (const btn of container.querySelectorAll('[data-action="open-run"]')) {
            btn.addEventListener('click', () => openFlowRun(btn.dataset.workflowid, btn.dataset.runname));
        }
    }

    // ── Views ────────────────────────────────────────────────────────────
    const emptyState = (icon, title, text) =>
        `<div class="frm-empty"><div class="icon">${icon}</div><div class="title">${title}</div>${text}</div>`;

    function renderTableView(runs) {
        if (!runs.length) {
            content.innerHTML = emptyState('📊', 'No flow runs found', 'Try adjusting your filters or date range');
            return;
        }
        content.innerHTML = `
            <div style="overflow-x:auto"><table class="frm-table frm-rows">
                <thead><tr><th>Status</th><th>Flow</th><th>Run ID</th><th>Start Time</th><th>Duration</th><th>Trigger</th><th>Error</th><th>Actions</th></tr></thead>
                <tbody>
                ${runs.map((run) => {
                    const msg = extractErrorMessage(run.errormessage);
                    return `<tr data-runid="${run.flowrunid}" title="Click for run details">
                        <td>${statusBadge(run.status)}</td>
                        <td>${escapeHtml(flowName(run))}</td>
                        <td><span class="frm-mono" title="${run.flowrunid || ''}">${run.flowrunid?.substring(0, 12) || '-'}…</span></td>
                        <td><div title="${formatDateTime(run.starttime)}">${formatRelativeTime(run.starttime)}</div>
                            <div style="font-size:10px;color:var(--muted)">${formatDateTime(run.starttime)}</div></td>
                        <td>${formatDuration(run.duration)}</td>
                        <td><span class="frm-mono">${escapeHtml(run.triggertype || '-')}</span></td>
                        <td>${run.errorcode || msg ? `<div style="max-width:300px">
                            ${run.errorcode ? `<div style="color:#D13438;font-size:11px;font-weight:600">${escapeHtml(run.errorcode)}</div>` : ''}
                            ${msg ? `<div style="font-size:11px;margin-top:2px;white-space:pre-wrap;word-break:break-word;max-height:60px;overflow-y:auto;color:var(--muted)">${escapeHtml(msg.substring(0, 200))}${msg.length > 200 ? '…' : ''}</div>` : ''}
                        </div>` : '-'}</td>
                        <td style="white-space:nowrap">
                            <button class="frm-icon-btn" data-action="view-details" data-runid="${run.flowrunid}" title="View Details">🔍</button>
                            <button class="frm-icon-btn" data-action="view-tree" data-runid="${run.flowrunid}" title="Connected Runs">🔀</button>
                            <button class="frm-icon-btn" data-action="open-run" data-runname="${escapeHtml(run.name || '')}" data-workflowid="${run._workflow_value || ''}" title="Open in Power Automate">↗️</button>
                        </td>
                    </tr>`;
                }).join('')}
                </tbody>
            </table></div>`;
        // Whole-row click beats hunting for the magnifier on every row.
        for (const row of content.querySelectorAll('tbody tr[data-runid]')) {
            row.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                const run = runs.find((r) => r.flowrunid === row.dataset.runid);
                if (run) showRunDetails(run);
            });
        }
        wireRunActions(content, runs);
    }

    function renderTimelineView(runs) {
        const timedRuns = runs.filter((r) => r.starttime && r.duration > 0);
        if (!timedRuns.length) {
            content.innerHTML = emptyState('⏱', 'No timing data', 'Runs don’t have timing information');
            return;
        }
        const startTimes = timedRuns.map((r) => new Date(r.starttime).getTime());
        const minTime = Math.min(...startTimes);
        const maxTime = Math.max(...timedRuns.map((r) => new Date(r.starttime).getTime() + (r.duration ?? 0)));
        const span = maxTime - minTime || 1;

        content.innerHTML = `
            <div class="frm-timeline-view">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
                    <div class="frm-chart-title" style="margin:0">Run Timeline (Waterfall)</div>
                    <div style="font-size:11px;color:var(--muted)">${formatDateTime(new Date(minTime).toISOString())} → ${formatDateTime(new Date(maxTime).toISOString())}</div>
                </div>
                ${timedRuns.map((run) => {
                    const left = ((new Date(run.starttime).getTime() - minTime) / span) * 100;
                    const width = Math.max(0.5, (run.duration / span) * 100);
                    return `<div class="frm-tl-row">
                        <div class="frm-tl-label" title="${escapeHtml(flowName(run))}">${escapeHtml(flowName(run).substring(0, 25))}</div>
                        <div class="frm-tl-track"><div class="frm-tl-bar" style="left:${left}%;width:${width}%;background:${getStatusColor(run.status)}"
                            title="${run.status}: ${formatDuration(run.duration)}\n${formatDateTime(run.starttime)}"></div></div>
                        <div class="frm-tl-duration">${formatDuration(run.duration)}</div>
                        <div style="display:flex;gap:2px">
                            <button class="frm-icon-btn" data-action="view-details" data-runid="${run.flowrunid}" title="Details">🔍</button>
                            <button class="frm-icon-btn" data-action="view-tree" data-runid="${run.flowrunid}" title="Connected Runs">🔀</button>
                        </div>
                    </div>`;
                }).join('')}
            </div>`;
        wireRunActions(content, timedRuns);
    }

    async function renderStatsView() {
        content.innerHTML = '<div class="frm-loading"><div class="frm-spinner"></div>Calculating statistics…</div>';
        const parts = scopeFilterParts(filters);
        const filterQuery = parts.length ? `&$filter=${parts.join(' and ')}` : '';
        const { runs } = await fetchPagedRuns(
            (u) => dv.get(u, paged(ANALYTICS_PAGE_SIZE)),
            `/flowruns?$select=status,duration,errorcode,_workflow_value${filterQuery}`,
            MAX_ANALYTICS);

        const byStatus = (s) => runs.filter((r) => r.status?.toLowerCase() === s).length;
        const total = runs.length;
        const succeeded = byStatus('succeeded');
        const failed = byStatus('failed');
        const durations = runs.filter((r) => r.duration > 0).map((r) => r.duration);
        const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

        const errorCodes = {};
        for (const r of runs) if (r.errorcode) errorCodes[r.errorcode] = (errorCodes[r.errorcode] ?? 0) + 1;
        const topErrors = Object.entries(errorCodes).sort((a, b) => b[1] - a[1]).slice(0, 5);

        // Which flows are actually burning — the question right after "how
        // many failed", and the way into the Errors view's pivots.
        const perFlow = new Map();
        for (const r of runs) {
            const label = flowName(r);
            const row = perFlow.get(label) ?? { total: 0, failed: 0 };
            row.total++;
            if (r.status?.toLowerCase() === 'failed') row.failed++;
            perFlow.set(label, row);
        }
        const topFailing = [...perFlow.entries()]
            .filter(([, row]) => row.failed > 0)
            .sort((a, b) => b[1].failed - a[1].failed)
            .slice(0, 8)
            .map(([label, row]) => [`${label} — ${((row.failed / row.total) * 100).toFixed(0)}% of ${row.total}`, row.failed, '#D13438']);

        const breakdown = [
            ['Succeeded', succeeded, '#107C10'], ['Failed', failed, '#D13438'],
            ['Running', byStatus('running'), '#0F6CBD'], ['Cancelled', byStatus('cancelled'), '#835C00'],
            ['Waiting', byStatus('waiting'), '#8764B8'],
        ].filter(([, count]) => count > 0);
        const maxCount = Math.max(...breakdown.map(([, c]) => c), 1);

        const barChart = (rows, maxValue, color) => rows.map(([label, count, rowColor]) => `
            <div class="frm-bar-row">
                <div class="frm-bar-label" title="${escapeHtml(label)}" ${color ? 'style="font-family:monospace;font-size:11px"' : ''}>${escapeHtml(label)}</div>
                <div class="frm-bar-track"><div class="frm-bar-fill" style="width:${(count / maxValue) * 100}%;background:${rowColor ?? color}"><span>${count.toLocaleString()}</span></div></div>
            </div>`).join('');

        content.innerHTML = `
            <div class="frm-stats">
                <div class="frm-stat-card"><div class="frm-stat-label">Total Runs</div><div class="frm-stat-value">${total.toLocaleString()}</div><div class="frm-stat-sub">In selected period</div></div>
                <div class="frm-stat-card"><div class="frm-stat-label">Success Rate</div><div class="frm-stat-value" style="color:#107C10">${total ? ((succeeded / total) * 100).toFixed(1) : 0}%</div><div class="frm-stat-sub">${succeeded.toLocaleString()} succeeded</div></div>
                <div class="frm-stat-card"><div class="frm-stat-label">Failure Rate</div><div class="frm-stat-value" style="color:#D13438">${total ? ((failed / total) * 100).toFixed(1) : 0}%</div><div class="frm-stat-sub">${failed.toLocaleString()} failed</div></div>
                <div class="frm-stat-card"><div class="frm-stat-label">Avg Duration</div><div class="frm-stat-value" style="color:var(--accent)">${formatDuration(avg)}</div><div class="frm-stat-sub">Min: ${formatDuration(durations.length ? Math.min(...durations) : 0)} / Max: ${formatDuration(durations.length ? Math.max(...durations) : 0)}</div></div>
            </div>
            <div class="frm-chart-block"><div class="frm-chart-title">Status Distribution</div>${barChart(breakdown, maxCount)}</div>
            ${topFailing.length ? `<div class="frm-chart-block wide"><div class="frm-chart-title">Top Failing Flows</div>${barChart(topFailing, topFailing[0][1])}
                <div style="margin-top:12px"><button class="ppt-btn" data-action="goto-errors">🔴 Break these down by flow × error →</button></div></div>` : ''}
            ${topErrors.length ? `<div class="frm-chart-block"><div class="frm-chart-title">Top Error Codes</div>${barChart(topErrors, topErrors[0][1], '#D13438')}</div>` : ''}`;

        content.querySelector('[data-action="goto-errors"]')?.addEventListener('click', () => setView('errors'));
    }

    // ── Errors view (issue list) ─────────────────────────────────────────
    // Modelled on issue trackers. Failed runs are stitched into incidents (a
    // whole parent→child failure cascade is ONE incident, filed under the flow
    // the error actually happened in), fingerprinted, and pivoted by flow, by
    // error, by the flow×error cross, or by caller — each with a sparkline on
    // a shared time window and drill-downs into whichever dimensions the
    // current pivot leaves free.
    const errorsState = { groupBy: 'flow-error', sort: 'count', query: '', collapse: true };
    const expandedIssues = new Set();
    let errorCache = null; // { key, occurrences } — pivoting must not re-fetch

    const GROUP_LABELS = { 'flow-error': 'Flow × Error', error: 'Error', flow: 'Flow', caller: 'Caller → Flow' };
    const SORT_LABELS = { count: 'Incidents', recent: 'Most recent', first: 'First seen' };
    const DIMENSION_LABELS = { flow: 'flow', error: 'error', caller: 'caller' };

    const setLoading = (text) => { content.innerHTML = `<div class="frm-loading"><div class="frm-spinner"></div>${text}</div>`; };

    // The occurrence pool behind the Errors view: every failed run in scope,
    // plus the ancestors pulled in to complete cascades. Cached against the
    // scope filters so switching pivot/sort/query/collapse is instant.
    async function loadFailureOccurrences() {
        const cacheKey = JSON.stringify(scopeFilterParts(filters));
        if (errorCache?.key === cacheKey) return errorCache.occurrences;

        setLoading('Loading failures…');
        const parts = [`status eq 'Failed'`, ...scopeFilterParts(filters)];
        const url = `/flowruns?$select=flowrunid,name,status,starttime,duration,errorcode,errormessage,_workflow_value,parentrunid&$orderby=starttime desc&$filter=${parts.join(' and ')}`;
        const { runs: failedRuns, truncated } = await fetchPagedRuns((u) => dv.get(u, paged(FAILURES_PAGE_SIZE)), url, MAX_FAILURES, (loaded) => {
            if (loaded >= FAILURES_PAGE_SIZE) setLoading(`Loading failures — ${loaded.toLocaleString()} so far…`);
        });
        if (!panelOpen) return [];

        const occurrences = failedRuns.map((run) => toOccurrence(run));
        if (!occurrences.length) {
            errorCache = { key: cacheKey, occurrences, truncated };
            return occurrences;
        }

        // 1. Stitch the cascades that are already fully inside the fetched
        //    rows. Free — no requests — and it decides what still needs asking.
        let incidents = buildCascades(occurrences);

        // 2. Climb past ancestors a failed-runs query can't see: a parent that
        //    caught the error ends Succeeded. Without this the chain looks
        //    like it starts at the child and the triggering process is hidden.
        setLoading('Tracing call chains…');
        const ancestors = await collectAncestors(incidents, (names) => fetchRunsByNames(apiGet, names));
        if (!panelOpen) return [];
        occurrences.push(...ancestors);
        incidents = buildCascades(occurrences);

        // 3. Only origins whose real cause lies outside the fetched window
        //    still need the child-run drill. Everything stitched above already
        //    knows where its error came from, which is most of them — the old
        //    code drilled every ancestor of every cascade for the same answer.
        const unresolved = incidents
            .map((incident) => incident.origin)
            .filter((occ) => isGenericError(extractErrorMessage(occ.run.errormessage)))
            .slice(0, ERRORS_RESOLVE_LIMIT);
        if (unresolved.length) {
            setLoading(`Resolving root causes <span data-slot="resolve-progress">0/${unresolved.length}</span>…`);
        }
        for (let i = 0; i < unresolved.length && panelOpen; i += ERRORS_RESOLVE_BATCH) {
            await Promise.all(unresolved.slice(i, i + ERRORS_RESOLVE_BATCH).map(async (occ) => {
                const cause = await resolveRunError(apiGet, occ.run).catch(() => null);
                if (cause?.resolved) applyCause(occ, cause);
            }));
            const progress = content.querySelector('[data-slot="resolve-progress"]');
            if (progress) progress.textContent = `${Math.min(i + ERRORS_RESOLVE_BATCH, unresolved.length)}/${unresolved.length}`;
        }
        if (!panelOpen) return [];

        // 4. Hand each cascade's ancestors the origin's message, so they still
        //    read sensibly with cascade collapsing switched off.
        propagateOriginCause(buildCascades(occurrences));

        errorCache = { key: cacheKey, occurrences, truncated };
        return occurrences;
    }

    function sparkline(issue, windowStart, windowEnd) {
        const bins = sparkBins(issue.incidents, windowStart, windowEnd);
        const peak = Math.max(...bins, 1);
        return `<div class="frm-spark" title="Incidents across the filtered period — peak ${peak} per bucket">${bins
            .map((n) => `<i class="${n ? '' : 'zero'}" style="height:${n ? Math.max(12, (n / peak) * 100) : 0}%"></i>`)
            .join('')}</div>`;
    }

    // Order Intake ✓ → Router ✓ → Inventory Sync ✗ — read left to right as
    // "this called this called this, and the last one is where it broke".
    function chainTrail(incident, always = false) {
        if (incident.chain.length < 2 && incident.complete) {
            return always ? '<div class="frm-chain"><span class="direct">triggered directly</span></div>' : '';
        }
        const cut = incident.complete ? '' : `<span class="cut" title="This run has a parent run that could not be retrieved, so the chain above it is unknown — it was not triggered directly">…?</span><span class="arrow">→</span>`;
        return `<div class="frm-chain">${cut}${incident.chain.map((occ, idx) => {
            const last = idx === incident.chain.length - 1;
            const mark = occ.caught ? '✓' : '✗';
            const title = last ? 'Where the error actually happened'
                : occ.caught ? `Succeeded — ${occ.errorCode}. This flow handled the error, so its own history looks clean`
                : 'Failed because the call below it failed';
            return `${idx ? '<span class="arrow">→</span>' : ''}<span class="${last ? 'origin' : occ.caught ? 'caught' : ''}" title="${escapeHtml(title)}">${escapeHtml(truncate(occ.flowLabel, 40))} ${mark}</span>`;
        }).join('')}</div>`;
    }

    // One card can cover the same failure reached by several different routes.
    // Rendering only the sample's chain presents one of them as if it were the
    // only path — that is how a caller, or a middle flow, goes missing.
    function pathTrails(issue) {
        const paths = distinctPaths(issue.incidents);
        if (paths.length === 1) return chainTrail(paths[0].incident);
        const shown = paths.slice(0, 3);
        return `<div class="frm-paths">
            <span class="lead">reached by ${paths.length} route${paths.length !== 1 ? 's' : ''}</span>
            ${shown.map((row) => `<div class="frm-path-row">${chainTrail(row.incident, true)}<span class="count">×${row.count.toLocaleString()}</span></div>`).join('')}
            ${paths.length > shown.length ? `<div class="frm-path-row"><span class="more">+${paths.length - shown.length} more route${paths.length - shown.length !== 1 ? 's' : ''}</span></div>` : ''}
        </div>`;
    }

    function incidentsTable(incidents) {
        return `<table class="frm-table" style="margin-top:4px">
            <thead><tr><th>Where it broke</th><th>Call chain</th><th>Time</th><th>Duration</th><th>Actions</th></tr></thead><tbody>
            ${incidents.slice(0, 25).map((incident) => `<tr>
                <td>${escapeHtml(incident.flowLabel)}</td>
                <td>${incident.chain.length > 1
                    ? `<span class="frm-tag" title="${escapeHtml(incident.chain.map((o) => o.flowLabel).join(' → '))}">${escapeHtml(truncate(callerLabelOf(incident), 28))} →${incident.chain.length > 2 ? ` +${incident.chain.length - 2} →` : ''}</span>`
                    : '<span style="color:var(--muted);font-size:11px">direct</span>'}</td>
                <td title="${formatDateTime(incident.origin.run.starttime)}">${formatRelativeTime(incident.origin.run.starttime)}</td>
                <td>${formatDuration(incident.origin.run.duration)}</td>
                <td style="white-space:nowrap">
                    <button class="frm-icon-btn" data-action="view-details" data-runid="${incident.origin.run.flowrunid}" title="Details of the run that broke">🔍</button>
                    <button class="frm-icon-btn" data-action="view-tree" data-runid="${incident.entry.run.flowrunid}" title="Connected runs, from the top of the chain">🔀</button>
                    <button class="frm-icon-btn" data-action="open-run" data-runname="${escapeHtml(incident.origin.run.name || '')}" data-workflowid="${incident.origin.run._workflow_value || ''}" title="Open the failing run in Power Automate">↗️</button>
                </td></tr>`).join('')}
            ${incidents.length > 25 ? `<tr><td colspan="5" style="text-align:center;color:var(--muted);font-size:12px">+ ${incidents.length - 25} more incidents</td></tr>` : ''}
            </tbody></table>`;
    }

    function breakdownBlock(issue, by) {
        const rows = issueBreakdown(issue, by);
        if (rows.length < 2) return '';
        const peak = rows[0].count;
        return `<div class="frm-bd">
            <div class="frm-bd-title">By ${DIMENSION_LABELS[by]}</div>
            ${rows.slice(0, 12).map((row) => `<div class="frm-bd-row">
                <div class="frm-bd-name" title="${escapeHtml(row.label)}">${by === 'error' ? `<span class="frm-tag code">${escapeHtml(row.code)}</span> ` : ''}${escapeHtml(truncate(row.label, 110))}${row.caught ? ' <span class="frm-tag" title="This caller succeeded — it caught the error, so its own run history looks clean">caught ✓</span>' : ''}</div>
                <div class="frm-bd-track"><div class="frm-bd-fill" style="width:${(row.count / peak) * 100}%"></div></div>
                <div class="frm-bd-count">${row.count.toLocaleString()}</div>
                ${by !== 'error' && row.flowId && row.flowId !== 'unknown' && row.flowId !== '?'
                    ? `<button class="frm-icon-btn" data-action="filter-flow" data-flowid="${escapeHtml(row.flowId)}" data-flowname="${escapeHtml(row.label)}" title="Filter every view to this flow">🔎</button>`
                    : '<span style="width:25px"></span>'}
            </div>`).join('')}
            ${rows.length > 12 ? `<div style="font-size:11px;color:var(--muted);padding-top:6px">+ ${rows.length - 12} more</div>` : ''}
        </div>`;
    }

    function issueCard(issue, windowStart, windowEnd) {
        const { groupBy } = errorsState;
        const { sample } = issue;
        const count = issue.incidents.length;
        const runCount = issueRunCount(issue);
        const expanded = expandedIssues.has(issue.key);
        const flows = new Set(issue.incidents.map((i) => i.flowId));
        const errors = new Set(issue.incidents.map(errorKeyOf));
        const callers = new Set(issue.incidents.map(callerKeyOf));
        const codeChip = `<span class="frm-tag code">${escapeHtml(sample.errorCode)}</span>`;

        let title;
        let message;
        if (groupBy === 'flow') {
            title = escapeHtml(sample.flowLabel);
            message = `${errors.size} distinct error${errors.size !== 1 ? 's' : ''} originating in this flow`;
        } else if (groupBy === 'error') {
            const names = [...new Set(issue.incidents.map((i) => i.flowLabel))];
            title = `${codeChip}<span>${escapeHtml(truncate(sample.message, 140))}</span>`;
            message = `Originates in ${flows.size} flow${flows.size !== 1 ? 's' : ''}${names.length <= 3 ? `: ${names.map((f) => escapeHtml(f)).join(', ')}` : ''}`;
        } else if (groupBy === 'caller') {
            title = `<span>${escapeHtml(callerLabelOf(sample))}</span><span class="arrow">→</span><span>${escapeHtml(sample.flowLabel)}</span>${codeChip}`;
            message = escapeHtml(truncate(sample.message, 220));
        } else {
            title = `${escapeHtml(sample.flowLabel)}${codeChip}`;
            message = escapeHtml(truncate(sample.message, 220));
        }
        if (sample.sourceFlow && sample.sourceFlow !== sample.flowLabel && groupBy !== 'flow') {
            message += `<div style="margin-top:3px;font-style:italic">root cause surfaced from ${escapeHtml(sample.sourceFlow)}</div>`;
        }

        const cascades = issue.incidents.filter((i) => i.chain.length > 1).length;
        const handled = issue.incidents.filter((i) => i.handledBy).length;
        const dimensions = openDimensions(groupBy);

        return `<div class="frm-issue" data-issue="${escapeHtml(issue.key)}">
            <div class="frm-issue-head" data-action="toggle-issue">
                <div class="frm-issue-main">
                    <div class="frm-issue-title">${title}</div>
                    <div class="frm-issue-msg">${message}</div>
                    ${pathTrails(issue)}
                    <div class="frm-issue-meta">
                        <span title="${formatDateTime(new Date(issue.first).toISOString())}">first ${formatRelativeTime(new Date(issue.first).toISOString())}</span>
                        <span title="${formatDateTime(new Date(issue.last).toISOString())}">last ${formatRelativeTime(new Date(issue.last).toISOString())}</span>
                        ${groupBy === 'flow'
                            ? `<span>${errors.size} error${errors.size !== 1 ? 's' : ''}</span>`
                            : `<span>${flows.size} flow${flows.size !== 1 ? 's' : ''}</span>`}
                        ${runCount > count ? `<span title="A cascade writes one failed run per flow in the chain; they are one incident, not ${runCount} problems">${runCount} failed runs</span>` : ''}
                        ${handled ? `<span class="frm-tag" title="An ancestor caught the error and reported success, so this never showed as a failure at the top">${handled} caught upstream</span>` : ''}
                    </div>
                </div>
                <div class="frm-issue-side">
                    ${sparkline(issue, windowStart, windowEnd)}
                    <div class="frm-issue-count"><b>${count.toLocaleString()}</b><span>incident${count !== 1 ? 's' : ''}</span></div>
                    <span class="frm-icon-btn" data-slot="chevron">${expanded ? '▲' : '▼'}</span>
                </div>
            </div>
            <div class="frm-issue-body" ${expanded ? '' : 'hidden'}>
                ${dimensions.map((by) => breakdownBlock(issue, by)).join('')}
                <div class="frm-bd">
                    <div class="frm-bd-title">Incidents${cascades ? ` — ${cascades} arrived through a call chain` : ''}</div>
                    ${incidentsTable(issue.incidents)}
                </div>
                ${groupBy === 'error' ? '' : `<div style="margin-top:10px">
                    <button class="ppt-btn" data-action="filter-flow" data-flowid="${escapeHtml(sample.flowId)}" data-flowname="${escapeHtml(sample.flowLabel)}">🔎 Filter all views to ${escapeHtml(truncate(sample.flowLabel, 40))}</button>
                </div>`}
            </div>
        </div>`;
    }

    function paintIssues(occurrences) {
        const incidents = buildCascades(occurrences, { collapse: errorsState.collapse });
        const query = errorsState.query.trim().toLowerCase();
        const matching = query
            ? incidents.filter((i) => i.message.toLowerCase().includes(query)
                || i.chain.some((o) => o.flowLabel.toLowerCase().includes(query))
                || i.errorCode.toLowerCase().includes(query))
            : incidents;
        const issues = buildIssues(matching, errorsState.groupBy, errorsState.sort);
        const stamps = incidents.map((i) => i.stamp).filter(Boolean);
        const windowStart = stamps.length ? Math.min(...stamps) : 0;
        const windowEnd = stamps.length ? Math.max(...stamps) : 1;

        const flows = new Set(matching.map((i) => i.flowId));
        const errors = new Set(matching.map(errorKeyOf));
        const runCount = new Set(matching.flatMap((i) => i.failedRuns)).size;
        const cascades = matching.filter((i) => i.chain.length > 1).length;
        content.querySelector('[data-slot="issue-summary"]').innerHTML = `
            <div class="frm-stat-card"><div class="frm-stat-label">Incidents</div><div class="frm-stat-value" style="color:#D13438">${matching.length.toLocaleString()}</div><div class="frm-stat-sub">${runCount.toLocaleString()} failed run${runCount !== 1 ? 's' : ''}${cascades ? ` · ${cascades.toLocaleString()} incident${cascades !== 1 ? 's' : ''} arrived through a call chain` : ''}</div></div>
            <div class="frm-stat-card"><div class="frm-stat-label">Distinct Errors</div><div class="frm-stat-value" style="color:#835C00">${errors.size.toLocaleString()}</div><div class="frm-stat-sub">fingerprinted — ids, numbers and urls ignored</div></div>
            <div class="frm-stat-card"><div class="frm-stat-label">Flows To Investigate</div><div class="frm-stat-value" style="color:var(--accent)">${flows.size.toLocaleString()}</div><div class="frm-stat-sub">where the errors originate, not everyone downstream</div></div>`;

        const list = content.querySelector('[data-slot="issue-list"]');
        list.innerHTML = issues.length
            ? issues.map((issue) => issueCard(issue, windowStart, windowEnd)).join('')
            : emptyState('🔍', 'Nothing matches', 'No failures match the current issue filter');

        for (const head of list.querySelectorAll('[data-action="toggle-issue"]')) {
            head.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                const card = head.closest('.frm-issue');
                const body = card.querySelector('.frm-issue-body');
                body.hidden = !body.hidden;
                card.querySelector('[data-slot="chevron"]').textContent = body.hidden ? '▼' : '▲';
                if (body.hidden) expandedIssues.delete(card.dataset.issue);
                else expandedIssues.add(card.dataset.issue);
            });
        }
        for (const btn of list.querySelectorAll('[data-action="filter-flow"]')) {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                applyFlowFilter(btn.dataset.flowid, btn.dataset.flowname);
            });
        }
        wireRunActions(list, matching.flatMap((i) => i.runs));
    }

    async function renderErrorsView() {
        const occurrences = await loadFailureOccurrences();
        if (!panelOpen || currentView !== 'errors') return;
        if (!occurrences.length) {
            content.innerHTML = emptyState('✓', 'No failures found', 'Great news! No failed runs in the selected period.');
            return;
        }

        const segment = (name, labels, active) => `<div class="frm-seg" data-seg="${name}">${Object.entries(labels)
            .map(([value, label]) => `<button data-${name}="${value}" class="${value === active ? 'active' : ''}">${label}</button>`).join('')}</div>`;

        content.innerHTML = `
            <div class="frm-errors-view">
                <div class="frm-stats" data-slot="issue-summary" style="padding:0 0 20px"></div>
                ${errorCache?.truncated ? `<div class="frm-truncated">
                    ⚠ Showing the first ${MAX_FAILURES.toLocaleString()} failures in this range. Narrow the date window, or filter to a flow,
                    to see the rest — a cascade with one end outside this cut can be filed under the wrong flow.
                </div>` : ''}
                <div class="frm-subbar">
                    <span class="ppt-label">Group by</span>${segment('group', GROUP_LABELS, errorsState.groupBy)}
                    <span class="ppt-label">Sort</span>${segment('sort', SORT_LABELS, errorsState.sort)}
                    <button class="frm-chip ${errorsState.collapse ? 'active' : ''}" data-action="toggle-collapse"
                        title="A flow that calls a flow that fails also fails. Collapsed, that whole chain counts as one incident filed under the flow the error really happened in. Off, every failed run is listed on its own.">⛓ Collapse cascades</button>
                    <input type="text" class="ppt-input" data-f="issueq" placeholder="Filter by flow, message or code…" style="width:240px;margin-left:auto" value="${escapeHtml(errorsState.query)}">
                </div>
                <div data-slot="issue-list"></div>
            </div>`;

        for (const btn of content.querySelectorAll('[data-seg="group"] button')) {
            btn.addEventListener('click', () => {
                if (errorsState.groupBy === btn.dataset.group) return;
                errorsState.groupBy = btn.dataset.group;
                expandedIssues.clear(); // keys belong to the previous pivot
                content.querySelectorAll('[data-seg="group"] button').forEach((b) => b.classList.toggle('active', b === btn));
                paintIssues(occurrences);
            });
        }
        for (const btn of content.querySelectorAll('[data-seg="sort"] button')) {
            btn.addEventListener('click', () => {
                errorsState.sort = btn.dataset.sort;
                content.querySelectorAll('[data-seg="sort"] button').forEach((b) => b.classList.toggle('active', b === btn));
                paintIssues(occurrences);
            });
        }
        const collapseBtn = content.querySelector('[data-action="toggle-collapse"]');
        collapseBtn.addEventListener('click', () => {
            errorsState.collapse = !errorsState.collapse;
            expandedIssues.clear();
            collapseBtn.classList.toggle('active', errorsState.collapse);
            paintIssues(occurrences);
        });
        // Only the summary and list repaint, so the caret stays in this input.
        const queryInput = content.querySelector('[data-f="issueq"]');
        let queryTimer = null;
        queryInput.addEventListener('input', () => {
            clearTimeout(queryTimer);
            queryTimer = setTimeout(() => {
                errorsState.query = queryInput.value;
                paintIssues(occurrences);
            }, 250);
        });

        paintIssues(occurrences);
    }

    async function renderChartView() {
        content.innerHTML = '<div class="frm-loading"><div class="frm-spinner"></div>Building time series chart…</div>';
        const parts = scopeFilterParts(filters);
        const filterQuery = parts.length ? `&$filter=${parts.join(' and ')}` : '';
        const { runs } = await fetchPagedRuns(
            (u) => dv.get(u, paged(ANALYTICS_PAGE_SIZE)),
            `/flowruns?$select=status,starttime,duration&$orderby=starttime asc${filterQuery}`,
            MAX_ANALYTICS);

        if (!runs.length) {
            content.innerHTML = emptyState('📈', 'No data for chart', 'Try adjusting your filters or date range');
            return;
        }

        const hourly = new Map();
        for (const run of runs) {
            const d = new Date(run.starttime);
            const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`;
            if (!hourly.has(key)) hourly.set(key, { succeeded: 0, failed: 0, other: 0, total: 0 });
            const bucket = hourly.get(key);
            bucket.total++;
            const status = (run.status ?? '').toLowerCase();
            if (status === 'succeeded') bucket.succeeded++;
            else if (status === 'failed') bucket.failed++;
            else bucket.other++;
        }
        const chartData = [...hourly.entries()].map(([time, v]) => ({ time, ...v })).sort((a, b) => a.time.localeCompare(b.time));
        const maxTotal = Math.max(...chartData.map((d) => d.total), 1);
        const barWidth = Math.max(4, Math.min(20, Math.floor(800 / chartData.length)));

        content.innerHTML = `
            <div class="frm-chart-view">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
                    <div class="frm-chart-title" style="margin:0">Runs Over Time (Hourly)</div>
                    <div class="frm-legend">
                        <span><span class="frm-legend-dot" style="background:#107C10"></span>Succeeded</span>
                        <span><span class="frm-legend-dot" style="background:#D13438"></span>Failed</span>
                        <span><span class="frm-legend-dot" style="background:#0F6CBD"></span>Other</span>
                    </div>
                </div>
                <div class="frm-time-chart-wrap">
                    <div class="frm-time-y"><span>${maxTotal}</span><span>${Math.floor(maxTotal / 2)}</span><span>0</span></div>
                    <div class="frm-time-chart">
                        ${chartData.map((d) => `
                            <div class="frm-time-bar" style="width:${barWidth}px" title="${d.time}\n✓ ${d.succeeded} | ✗ ${d.failed} | Other ${d.other}">
                                <div class="frm-time-stack" style="height:${(d.total / maxTotal) * 100}%">
                                    ${d.other > 0 ? `<div class="frm-time-seg" style="flex:${d.other};background:#0F6CBD"></div>` : ''}
                                    ${d.failed > 0 ? `<div class="frm-time-seg" style="flex:${d.failed};background:#D13438"></div>` : ''}
                                    ${d.succeeded > 0 ? `<div class="frm-time-seg" style="flex:${d.succeeded};background:#107C10"></div>` : ''}
                                </div>
                            </div>`).join('')}
                    </div>
                </div>
                <div class="frm-time-x">
                    <span>${chartData[0]?.time ?? ''}</span>
                    <span>${chartData[Math.floor(chartData.length / 2)]?.time ?? ''}</span>
                    <span>${chartData[chartData.length - 1]?.time ?? ''}</span>
                </div>
                <div style="text-align:center;margin-top:16px;font-size:12px;color:var(--muted)">Showing ${runs.length} runs across ${chartData.length} hours</div>
            </div>`;
    }

    function showRunDetails(run) {
        detailPanel?.remove();
        detailPanel = ui.el('div', { className: 'frm-detail' });
        const row = (label, valueHtml) => `<div class="frm-detail-row"><div class="l">${label}</div><div class="v">${valueHtml}</div></div>`;
        detailPanel.innerHTML = `
            <div class="frm-detail-header">
                <span style="font-size:16px;font-weight:600">Run Details</span>
                <button class="ppt-icon-btn" data-action="close-detail" title="Close">✕</button>
            </div>
            <div class="frm-detail-body">
                <div class="ppt-label">General</div>
                ${row('Status', statusBadge(run.status))}
                ${row('Flow', escapeHtml(flowName(run)))}
                ${row('Run ID', `<span class="frm-mono">${run.flowrunid || '-'}</span>`)}
                ${row('Workflow ID', `<span class="frm-mono">${run._workflow_value || run.workflowid || '-'}</span>`)}
                <div class="ppt-label">Timing</div>
                ${row('Start Time', `${formatRelativeTime(run.starttime)} <span style="color:var(--muted);font-size:10px">(${formatDateTime(run.starttime)})</span>`)}
                ${row('End Time', `${formatRelativeTime(run.endtime)} <span style="color:var(--muted);font-size:10px">(${formatDateTime(run.endtime)})</span>`)}
                ${row('Duration', formatDuration(run.duration))}
                <div class="ppt-label">Trigger</div>
                ${row('Type', `<span class="frm-mono">${escapeHtml(run.triggertype || '-')}</span>`)}
                ${row('Flow Type', FLOW_TYPE_LABELS[run.modernflowtype] ?? '-')}
                ${run.parentrunid ? row('Parent Run', `<span class="frm-mono">${escapeHtml(run.parentrunid)}</span>`) : ''}
                ${run.errorcode || run.errormessage ? `
                    <div class="ppt-label">Error Details</div>
                    <div class="frm-error-message" style="border-left:3px solid #D13438">
                        ${run.errorcode ? `<div class="frm-error-code">${escapeHtml(run.errorcode)}</div>` : ''}
                        ${escapeHtml(extractErrorMessage(run.errormessage))}
                        <div data-slot="err-cause" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)" hidden></div>
                    </div>` : ''}
                <div style="margin-top:16px;display:flex;flex-direction:column;gap:8px">
                    <button class="ppt-btn" data-action="detail-tree" style="width:100%">🔀 View Connected Runs</button>
                    <button class="ppt-btn primary" data-action="detail-open" style="width:100%">Open in Power Automate ↗</button>
                </div>
            </div>`;
        content.appendChild(detailPanel);
        detailPanel.querySelector('[data-action="close-detail"]').addEventListener('click', () => { detailPanel.remove(); detailPanel = null; });
        detailPanel.querySelector('[data-action="detail-tree"]').addEventListener('click', () => showConnectedRuns(run));
        detailPanel.querySelector('[data-action="detail-open"]').addEventListener('click', () => openFlowRun(run._workflow_value, run.name));

        // "A dependent action failed" tells the user nothing — drill into the
        // failed child runs for the real cause and append it below the message.
        const causeEl = detailPanel.querySelector('[data-slot="err-cause"]');
        if (causeEl && (run.status ?? '').toLowerCase() === 'failed' && isGenericError(extractErrorMessage(run.errormessage))) {
            causeEl.hidden = false;
            causeEl.style.color = 'var(--muted)';
            causeEl.textContent = '↳ Resolving root cause…';
            resolveRunError(apiGet, run).then((cause) => {
                if (!causeEl.isConnected) return; // drawer closed / replaced
                if (!cause?.resolved) { causeEl.hidden = true; return; }
                causeEl.style.color = '#D13438';
                causeEl.title = (cause.sourceFlow ? `via ${cause.sourceFlow}:\n` : '') + cause.message;
                causeEl.textContent = `↳ ${cause.sourceFlow ? cause.sourceFlow + ': ' : ''}${cause.message}`;
            }).catch(() => { if (causeEl.isConnected) causeEl.hidden = true; });
        }
    }

    // ── Loading + pagination ─────────────────────────────────────────────
    function updateFooter() {
        footerInfo.textContent = `Showing ${flowRuns.length} run${flowRuns.length !== 1 ? 's' : ''}${nextLink ? ' (more available)' : ''}`;
        if (!['table', 'timeline'].includes(currentView)) { pagination.style.display = 'none'; return; }
        pagination.style.display = 'flex';
        pagination.replaceChildren(
            ui.el('button', {
                className: 'ppt-btn', textContent: '← Previous', disabled: !previousLinks.length,
                onclick: () => {
                    const prev = previousLinks.pop();
                    loadData(prev === 'FIRST' ? null : prev);
                },
            }),
            ui.el('span', { style: 'font-size:12px;color:var(--muted)', textContent: `Page ${previousLinks.length + 1}` }),
            ui.el('button', {
                className: 'ppt-btn', textContent: 'Next →', disabled: !nextLink,
                onclick: () => {
                    previousLinks.push(previousLinks.length === 0 ? 'FIRST' : currentPageUrl);
                    loadData(nextLink);
                },
            }),
        );
    }

    let currentPageUrl = null;
    async function loadData(paginationUrl = null) {
        if (isLoading) return;
        isLoading = true;
        detailPanel = null;
        content.innerHTML = '<div class="frm-loading"><div class="frm-spinner"></div>Loading flow runs…</div>';
        try {
            if (currentView === 'stats') await renderStatsView();
            else if (currentView === 'errors') await renderErrorsView();
            else if (currentView === 'chart') await renderChartView();
            else {
                const result = await fetchFlowRuns(filters, paginationUrl);
                currentPageUrl = paginationUrl;
                flowRuns = result.records;
                nextLink = result.nextLink;
                if (currentView === 'timeline') renderTimelineView(flowRuns);
                else renderTableView(flowRuns);
                updateFooter();
            }
            if (['stats', 'errors', 'chart'].includes(currentView)) {
                footerInfo.textContent = '';
                pagination.style.display = 'none';
            }
        } catch (e) {
            content.innerHTML = `<div class="frm-error-msg">Failed to load flow runs: ${escapeHtml(e.message)}</div>`;
        }
        isLoading = false;
    }

    const resetPagination = () => { nextLink = null; previousLinks = []; };
    // Any change to the scope filters invalidates the resolved-failure cache.
    const invalidate = () => { errorCache = null; resetPagination(); };

    // ── Toolbar/filter wiring ────────────────────────────────────────────
    function setView(view) {
        currentView = view;
        panel.querySelectorAll('.frm-tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
        resetPagination();
        loadData();
    }

    for (const tab of panel.querySelectorAll('.frm-tab')) {
        tab.addEventListener('click', () => setView(tab.dataset.view));
    }

    for (const chip of panel.querySelectorAll('.frm-chip[data-status]')) {
        chip.addEventListener('click', () => {
            panel.querySelectorAll('.frm-chip[data-status]').forEach((c) => c.classList.remove('active'));
            chip.classList.add('active');
            filters.status = chip.dataset.status;
            resetPagination();
            loadData();
        });
    }

    // Quick ranges keep the datetime inputs in sync so the two never disagree.
    function setRange(hours) {
        filters.startDateFrom = toLocalInput(new Date(Date.now() - hours * 3600000));
        filters.startDateTo = toLocalInput(new Date());
        $('[data-f=from]').value = filters.startDateFrom;
        $('[data-f=to]').value = filters.startDateTo;
    }

    for (const chip of panel.querySelectorAll('.frm-chip[data-range]')) {
        chip.addEventListener('click', () => {
            panel.querySelectorAll('.frm-chip[data-range]').forEach((c) => c.classList.remove('active'));
            chip.classList.add('active');
            setRange(Number(chip.dataset.range));
            invalidate();
            loadData();
        });
    }

    const filtersEl = $('.frm-filters');
    const filterCount = $('[data-slot="filter-count"]');
    function updateFilterCount() {
        const active = [filters.searchText, filters.workflowId, filters.triggerType,
            filters.modernFlowType, filters.ownerId, filters.errorCode,
            filters.durationMin, filters.durationMax].filter(Boolean).length;
        filterCount.textContent = active ? ` (${active})` : '';
        filterCount.style.color = active ? 'var(--accent)' : '';
    }
    $('[data-action="toggle-filters"]').addEventListener('click', () => { filtersEl.hidden = !filtersEl.hidden; });

    function gatherFilters() {
        filters.searchText = $('[data-f=search]').value.trim();
        filters.startDateFrom = $('[data-f=from]').value;
        filters.startDateTo = $('[data-f=to]').value;
        filters.triggerType = $('[data-f=trigger]').value.trim();
        filters.modernFlowType = $('[data-f=flowtype]').value;
        filters.errorCode = $('[data-f=errcode]').value.trim();
        filters.durationMin = $('[data-f=durmin]').value.trim();
        filters.durationMax = $('[data-f=durmax]').value.trim();
        updateFilterCount();
    }

    // Drilling from an issue card: pin every view to that one flow. Runs whose
    // workflow lookup is empty group under a placeholder id that is not a guid,
    // so there is nothing to filter on.
    function applyFlowFilter(flowId, label) {
        if (!flowId || flowId === 'unknown') { ui.toast('These runs have no flow to filter on'); return; }
        filters.workflowId = flowId;
        filters.workflowName = label;
        showSelectedChip($('[data-sel=workflow]'), label, () => {
            filters.workflowId = '';
            filters.workflowName = '';
            updateFilterCount();
        });
        filtersEl.hidden = false;
        updateFilterCount();
        invalidate();
        setView('table');
        ui.toast(`Filtered to ${label}`);
    }

    $('[data-action=refresh]').addEventListener('click', () => { errorCache = null; loadData(currentPageUrl); });
    $('[data-action=apply]').addEventListener('click', () => {
        gatherFilters();
        panel.querySelectorAll('.frm-chip[data-range]').forEach((c) => c.classList.remove('active'));
        invalidate();
        loadData();
    });
    $('[data-f=search]').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { gatherFilters(); invalidate(); loadData(); }
    });

    $('[data-action=clear]').addEventListener('click', () => {
        Object.assign(filters, {
            status: '', workflowId: '', workflowName: '', startDateFrom: '', startDateTo: '',
            triggerType: '', modernFlowType: '', ownerId: '', ownerName: '',
            errorCode: '', searchText: '', durationMin: '', durationMax: '',
        });
        for (const input of panel.querySelectorAll('.frm-filters input, .frm-filters select')) input.value = '';
        for (const sel of panel.querySelectorAll('[data-sel]')) { sel.style.display = 'none'; sel.replaceChildren(); }
        panel.querySelectorAll('.frm-chip[data-status]').forEach((c) => c.classList.toggle('active', c.dataset.status === ''));
        panel.querySelectorAll('.frm-chip[data-range]').forEach((c) => c.classList.remove('active'));
        updateFilterCount();
        invalidate();
        loadData();
    });

    $('[data-action=export]').addEventListener('click', () => {
        if (!flowRuns.length) { ui.toast('No data to export'); return; }
        const headers = ['Run ID', 'Flow Name', 'Status', 'Start Time', 'End Time', 'Duration (ms)', 'Trigger Type', 'Flow Type', 'Workflow ID', 'Error Code', 'Error Message'];
        const rows = flowRuns.map((run) => [
            run.flowrunid ?? '', flowName(run), run.status ?? '', run.starttime ?? '', run.endtime ?? '',
            run.duration ?? '', run.triggertype ?? '', FLOW_TYPE_LABELS[run.modernflowtype] ?? '',
            run._workflow_value ?? run.workflowid ?? '', run.errorcode ?? '',
            (run.errormessage ?? '').replace(/[\n\r]/g, ' '),
        ]);
        const csv = [headers, ...rows].map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
        link.download = `flow-runs-${new Date().toISOString().slice(0, 10)}.csv`;
        link.click();
        URL.revokeObjectURL(link.href);
    });

    // Flow / owner lookup filters
    function showSelectedChip(selected, name, onClear) {
        selected.replaceChildren(ui.el('div', { className: 'frm-selected' }, [
            ui.el('span', { className: 'name', textContent: name, title: name }),
            ui.el('button', {
                className: 'ppt-icon-btn', textContent: '✕', style: 'font-size:13px;padding:2px',
                onclick: () => { onClear(); selected.style.display = 'none'; selected.replaceChildren(); },
            }),
        ]));
        selected.style.display = 'block';
    }

    function wireLookup({ input, dropdown, selected, search, onPick, onClear }) {
        let timer = null;
        input.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(async () => {
                const text = input.value.trim();
                if (!text) { dropdown.style.display = 'none'; return; }
                dropdown.innerHTML = '<div class="frm-ac-msg">Searching…</div>';
                dropdown.style.display = 'block';
                const items = await search(text);
                dropdown.replaceChildren(...(items.length
                    ? items.map((item) => {
                        const node = ui.el('div', { className: 'frm-ac-item', textContent: item.name });
                        node.addEventListener('mousedown', () => {
                            onPick(item);
                            input.value = '';
                            dropdown.style.display = 'none';
                            showSelectedChip(selected, item.name, onClear);
                        });
                        return node;
                    })
                    : [ui.el('div', { className: 'frm-ac-msg', textContent: 'No results found' })]));
            }, 350);
        });
        input.addEventListener('blur', () => setTimeout(() => { dropdown.style.display = 'none'; }, 200));
    }

    wireLookup({
        input: $('[data-f=workflow]'), dropdown: $('[data-ac=workflow]'), selected: $('[data-sel=workflow]'),
        search: async (text) => (await fetchWorkflows(text)).map((w) => ({ id: w.workflowid, name: w.name })),
        onPick: (item) => { filters.workflowId = item.id; filters.workflowName = item.name; updateFilterCount(); },
        onClear: () => { filters.workflowId = ''; filters.workflowName = ''; updateFilterCount(); },
    });
    wireLookup({
        input: $('[data-f=owner]'), dropdown: $('[data-ac=owner]'), selected: $('[data-sel=owner]'),
        search: async (text) => (await fetchUsers(text)).map((u) => ({ id: u.systemuserid, name: u.fullname })),
        onPick: (item) => { filters.ownerId = item.id; filters.ownerName = item.name; updateFilterCount(); },
        onClear: () => { filters.ownerId = ''; filters.ownerName = ''; updateFilterCount(); },
    });

    loadData();
}

export default {
    init() {
        ui.addStyle('frm', STYLE);
        commands.register({ toolId: 'flow-run-monitor', title: 'Open Flow Run Monitor', icon: '📈', svg: 'pulse', run: openPanel });
    },
};
