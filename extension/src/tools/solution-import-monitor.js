// Solution Import Monitor (native).
// Live side panel showing active solution operations (progress, elapsed time)
// and recently completed ones, with a drill-down log viewer that renders
// embedded XML error payloads as readable tables.
//
// Two sources feed the panel, because neither one sees every operation:
//   importjobs             — imports, with the component-level log XML.
//   msdyn_solutionhistory  — what the maker portal's "See history" page shows:
//                            upgrades and uninstalls too, with their failure
//                            diagnostics in errorcode/exceptionmessage.
// Rows from both are merged into one chronological feed; an upgrade that ran as
// an import appears in both tables, so those pairs are matched and shown once.

import { Dataverse } from '../core/dataverse.js';
import * as ui from '../core/ui.js';
import * as commands from '../core/commands.js';

let dataverse; // created in init() — modules must stay side-effect free at load

const STYLE = `
    .sim-backdrop {
        position: fixed; inset: 0; background: rgba(0,0,0,0.3);
        z-index: 2147483000; animation: ppt-fade 0.15s ease;
    }
    .sim-panel {
        position: fixed; top: 0; right: 0; bottom: 0;
        width: 60vw; min-width: 480px; max-width: 1000px;
        background: var(--bg); display: flex; flex-direction: column;
        box-shadow: -4px 0 24px rgba(0,0,0,0.18);
        animation: sim-slide 0.25s ease;
    }
    .sim-header, .sim-footer {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 24px; flex-shrink: 0;
    }
    .sim-header { border-bottom: 1px solid var(--border); }
    .sim-footer { border-top: 1px solid var(--border); background: var(--bg2); }
    .sim-header h2 { margin: 0; font-size: 17px; font-weight: 600; }
    .sim-content { flex: 1; overflow-y: auto; padding: 16px 24px; }
    .sim-live {
        display: inline-flex; align-items: center; gap: 5px; margin-left: 10px;
        background: #DFF6DD; color: #107C10; border: 1px solid #A7E3A5;
        padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600;
    }
    .sim-live::before {
        content: ""; width: 6px; height: 6px; border-radius: 50%;
        background: #107C10; animation: sim-pulse 2s ease infinite;
    }
    .sim-section { margin: 0 0 12px; display: flex; align-items: center; gap: 8px; }
    .sim-card {
        border: 1px solid var(--border); border-radius: 8px;
        padding: 16px; margin-bottom: 12px;
    }
    .sim-progress { height: 8px; background: var(--border); border-radius: 4px; overflow: hidden; position: relative; margin: 10px 0 8px; }
    .sim-progress > div { height: 100%; background: var(--accent); border-radius: 4px; transition: width 0.5s ease; }
    .sim-progress > .indeterminate { width: 30%; position: absolute; animation: sim-progress-slide 1.5s ease-in-out infinite; }
    .sim-spinner {
        display: inline-block; width: 14px; height: 14px; flex-shrink: 0;
        border: 2px solid var(--border); border-top-color: var(--accent);
        border-radius: 50%; animation: sim-spin 0.7s linear infinite;
    }
    .sim-spinner.large { width: 28px; height: 28px; border-width: 3px; }
    .sim-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .sim-table th {
        text-align: left; padding: 8px 10px; font-weight: 600; color: var(--muted);
        font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px;
        border-bottom: 2px solid var(--border); background: var(--bg2);
        white-space: nowrap; position: sticky; top: 0;
    }
    .sim-table td { padding: 6px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
    .sim-table tr:hover td { background: var(--bg2); }
    .sim-badge {
        display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px;
        border-radius: 12px; font-size: 11px; font-weight: 600; white-space: nowrap;
    }
    .sim-badge.ok   { background: #DFF6DD; color: #107C10; border: 1px solid #A7E3A5; }
    .sim-badge.fail { background: #FDE7E9; color: #D13438; border: 1px solid #F1BBBC; }
    .sim-badge.warn { background: #FFF4CE; color: #835C00; border: 1px solid #F5D06C; }
    .sim-badge.plain { background: var(--bg2); color: var(--muted); border: 1px solid var(--border); }
    .sim-filter { cursor: pointer; }
    .sim-filter.active { outline: 2px solid currentColor; outline-offset: 1px; }
    .sim-log {
        position: fixed; inset: 0; margin: auto; z-index: 2147483050;
        max-width: 900px; width: 95%; max-height: 90vh; height: fit-content;
        background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
        display: flex; flex-direction: column; box-shadow: var(--shadow);
    }
    .sim-log.fullscreen { max-width: 100vw; width: 100vw; max-height: 100vh; height: 100vh; border-radius: 0; }
    .sim-log-table-wrap { flex: 1; overflow-y: auto; min-height: 120px; }
    .sim-xml { margin: 4px 0; border: 1px solid var(--border); border-radius: 4px; overflow-x: auto; }
    .sim-xml table { border-collapse: collapse; width: 100%; }
    .sim-xml td { padding: 4px 8px; border: 1px solid var(--border); vertical-align: top; font-size: 12px; overflow-wrap: anywhere; }
    .sim-xml .k { background: var(--bg2); color: var(--muted); font-weight: 600; white-space: nowrap; width: 1%; }
    .sim-xml .h { background: var(--bg2); color: var(--accent); font-weight: 600; font-size: 11px; text-transform: uppercase; white-space: nowrap; }
    .sim-filterbar {
        display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
        margin-bottom: 12px;
    }
    .sim-filterbar .ppt-input, .sim-filterbar .ppt-select {
        width: auto; padding: 6px 10px; font-size: 13px;
    }
    .sim-loadmore {
        display: flex; align-items: center; justify-content: space-between;
        gap: 12px; padding: 10px 2px 0;
    }
    .sim-muted { color: var(--muted); }
    .sim-dim { color: var(--muted); font-size: 12px; }
    .sim-detail { width: 100%; border-collapse: collapse; font-size: 13px; }
    .sim-detail th {
        text-align: left; padding: 5px 14px 5px 0; width: 1%; white-space: nowrap;
        vertical-align: top; color: var(--muted); font-weight: 600;
    }
    .sim-detail td { padding: 5px 0; vertical-align: top; overflow-wrap: anywhere; }
    .sim-banner {
        margin: 10px 24px 0; padding: 10px 12px; border-radius: 6px; font-size: 12px;
        background: #FDE7E9; border: 1px solid #F1BBBC; color: #A4262C;
    }
    .sim-pre {
        margin: 0; padding: 10px; border: 1px solid var(--border); border-radius: 4px;
        background: var(--bg2); font-size: 11px; white-space: pre-wrap;
        overflow-wrap: anywhere; max-height: 260px; overflow: auto;
    }
    @keyframes sim-slide { from { transform: translateX(100%); } }
    @keyframes sim-spin { to { transform: rotate(360deg); } }
    @keyframes sim-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
    @keyframes sim-progress-slide { 0% { left: -30%; } 100% { left: 100%; } }
`;

// ── Formatting helpers ────────────────────────────────────────────────────

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
}

function formatDuration(ms) {
    if (ms < 0) return '—';
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ${secs % 60}s`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatTime(dateStr) {
    return dateStr ? new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const date = new Date(dateStr);
    if (date.toDateString() === new Date().toDateString()) return 'Today ' + formatTime(dateStr);
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + formatTime(dateStr);
}

// ── Data access ───────────────────────────────────────────────────────────

const JOB_FIELDS = 'importjobid,solutionname,name,progress,createdon,completedon,startedon,modifiedon';
const PAGE_SIZE = 25;

// Sent for documentation and for providers that honour it — the one measured
// here ignores $select and returns every column anyway. msdyn_result is
// deliberately absent: see the verdict logic in historyRow().
const HISTORY_FIELDS = [
    'msdyn_solutionhistoryid', 'msdyn_name', 'msdyn_operation', 'msdyn_suboperation',
    'msdyn_status', 'msdyn_starttime', 'msdyn_endtime', 'msdyn_totaltime',
    'msdyn_errorcode', 'msdyn_exceptionmessage', 'msdyn_exceptionstack', 'msdyn_activityid',
    'msdyn_solutionversion', 'msdyn_publishername',
].join(',');

// Upgrade-shaped work only: any operation whose suboperation is Upgrade (2) or
// InlineUpgrade (5), plus every Uninstall (1) — that covers both the promote
// half of a staged upgrade and a plain solution delete. Publish/Export rows are
// left out; this panel is about deployments, not customization churn.
const HISTORY_SCOPE = '(msdyn_suboperation eq 2 or msdyn_suboperation eq 5 or msdyn_operation eq 1)';

const OPERATION_LABEL = {
    0: 'Import', 1: 'Uninstall', 2: 'Export', 3: 'Publish', 4: 'Publish All',
    5: 'Language Provision', 6: 'Import Translation', 7: 'Ribbon Metadata',
    8: 'Workflow Set State', 9: 'None', 10: 'Export Lite', 11: 'Updating Missing Packages',
};
const SUBOPERATION_LABEL = {
    0: 'None', 1: 'New', 2: 'Upgrade', 3: 'Update', 4: 'Delete', 5: 'Inline Upgrade',
    6: 'Waiting For Missing Packages', 7: 'Installed Missing Packages',
    8: 'Failed Installing Missing Packages',
};

// What to call the operation in one word. The raw pair is ambiguous on its own:
// an upgrade arrives as Import+Upgrade while the promote step that finishes a
// two-step upgrade arrives as Uninstall+Upgrade.
export function operationLabel(history) {
    const operation = history.msdyn_operation;
    const sub = history.msdyn_suboperation;
    if (sub === 2) return operation === 1 ? 'Apply upgrade' : 'Upgrade';
    if (sub === 5) return 'Inline upgrade';
    if (operation === 1) return sub === 4 ? 'Delete' : 'Uninstall';
    return OPERATION_LABEL[operation] ?? 'Operation';
}

const hasErrorCode = (code) => code != null && String(code).trim() !== ''
    && !/^0x?0*$/i.test(String(code).trim());

// A solution import that fails very early (e.g. an invalid file — error 80072031)
// can leave its importjob with `completedon` never written, so filtering on
// `completedon eq null` alone marks that dead job "active" indefinitely (you see
// it accrue absurd elapsed times like 55h). We weed those ghosts out with the
// serialisation invariant, not with arbitrary time limits:
//   Dataverse runs one solution import at a time. Starting an import while another
//   is running fails immediately — so a NEWER import that *succeeded* proves nothing
//   was running when it did, which means any older still-open job had already died
//   without writing completedon. (A newer *failure* proves nothing: it may have
//   failed precisely because the older one was still running.)
// The only case this can't decide is a lone early failure that is itself the newest
// import, with no later success to compare against; there we fall back to inactivity.
const GHOST_IDLE_MS = 30 * 60 * 1000; // 30 min without any update ⇒ treat as dead

// Returns { active, dead }:
//   active — imports genuinely still running.
//   dead   — open jobs (completedon never written) we judge terminal: early
//            failures like 80072031. They never enter the completedon-based
//            completed query, so the caller surfaces them there as failures.
async function fetchActiveImports() {
    // Fetch recent jobs regardless of completion so we can see whether a later
    // import has already succeeded. A truly active job has the newest createdon,
    // so it is always within this window.
    const data = await dataverse.get(`/importjobs?$select=${JOB_FIELDS}&$orderby=createdon desc&$top=20`);
    const jobs = data.value ?? [];
    // createdon of the newest import that reached 100% (i.e. actually succeeded).
    const latestSuccessCreatedMs = jobs.reduce((max, job) => {
        const succeeded = job.completedon && Math.round(job.progress ?? 0) >= 100;
        return succeeded ? Math.max(max, new Date(job.createdon).getTime()) : max;
    }, 0);
    const now = Date.now();

    const active = [];
    const dead = [];
    for (const job of jobs) {
        if (job.completedon) continue; // finished normally ⇒ the completed query owns it
        const supersededBySuccess = latestSuccessCreatedMs && new Date(job.createdon).getTime() < latestSuccessCreatedMs;
        const touched = job.modifiedon || job.startedon || job.createdon;
        const idle = touched && now - new Date(touched).getTime() > GHOST_IDLE_MS; // no later success to compare against
        (supersededBySuccess || idle ? dead : active).push(job);
    }
    return { active, dead };
}

// Completed imports, filtered server-side by name/date and paged via
// odata.maxpagesize + @odata.nextLink. Result status lives only inside the
// `data` XML blob, so status filtering happens client-side after parsing.
function fetchCompletedImports(filters, nextLink) {
    const headers = { Prefer: `odata.maxpagesize=${PAGE_SIZE}` };
    if (nextLink) return dataverse.get(nextLink, headers);

    const conditions = ['completedon ne null'];
    const name = filters.name.trim().replace(/'/g, "''");
    if (name) conditions.push(`(contains(solutionname,'${name}') or contains(name,'${name}'))`);
    if (filters.from) conditions.push(`completedon ge ${new Date(filters.from + 'T00:00:00').toISOString()}`);
    if (filters.to) conditions.push(`completedon le ${new Date(filters.to + 'T23:59:59.999').toISOString()}`);

    return dataverse.get(
        `/importjobs?$select=${JOB_FIELDS},data&$filter=${conditions.join(' and ')}&$orderby=completedon desc`,
        headers);
}

// msdyn_solutionhistory is a *virtual* table, and its provider — not the Web API
// — decides which query options mean anything. Measured against a live org:
//   $top, $orderby   honoured.
//   $select          ignored; every column comes back regardless.
//   $filter          ignored *silently* — the request succeeds and returns
//                    unfiltered rows, so there is no error to fall back from.
// Everything that decides what appears therefore runs client-side. The $filter is
// still sent: it costs nothing, and narrows the payload wherever a provider does
// honour it, while the client-side pass keeps the result correct either way.
//
// The window is bounded rather than paged. Solution history is dominated by
// WorkflowSetState churn (seven rows in seven seconds during a single publish),
// so a 25-row page can easily hold no deployment at all; asking for one large
// slice and filtering it beats making the user click past the noise.
const HISTORY_WINDOW = 250;

function fetchHistory(conditions, top) {
    const filter = conditions.length ? `$filter=${conditions.join(' and ')}&` : '';
    return dataverse.get(
        `/msdyn_solutionhistories?$select=${HISTORY_FIELDS}&${filter}$orderby=msdyn_starttime desc&$top=${top}`);
}

const inHistoryScope = (history) =>
    history.msdyn_suboperation === 2 || history.msdyn_suboperation === 5 || history.msdyn_operation === 1;

function historyMatchesFilters(history, filters) {
    const name = filters.name.trim().toLowerCase();
    if (name && !(history.msdyn_name ?? '').toLowerCase().includes(name)) return false;
    const when = history.msdyn_endtime && new Date(history.msdyn_endtime);
    if (filters.from && when && when < new Date(filters.from + 'T00:00:00')) return false;
    if (filters.to && when && when > new Date(filters.to + 'T23:59:59.999')) return false;
    return true;
}

// A row whose operation died without ever writing msdyn_endtime stays "open"
// forever. Imports have the one-at-a-time invariant to prove an older open job is
// dead; history has no equivalent — nested rows mean "a newer row finished" proves
// nothing — so age is the only signal available. The bound is deliberately loose
// (a real uninstall in this org ran 22 minutes) and stale rows are dropped rather
// than reported as failures that cannot be substantiated.
const HISTORY_ACTIVE_WINDOW_MS = 4 * 60 * 60 * 1000;

// Solution-history operations still running (no end time yet). The slice is wider
// than it looks like it needs to be precisely because $filter does not narrow it:
// the running row has to survive whatever churn was written after it started.
async function fetchActiveHistory() {
    const data = await fetchHistory([HISTORY_SCOPE, 'msdyn_endtime eq null'], 100);
    const now = Date.now();
    return (data.value ?? []).filter((history) => {
        if (history.msdyn_endtime || !inHistoryScope(history)) return false;
        const started = history.msdyn_starttime && new Date(history.msdyn_starttime).getTime();
        return started && now - started <= HISTORY_ACTIVE_WINDOW_MS;
    });
}

// Finished solution-history operations: one bounded slice per reload, not paged.
function fetchCompletedHistory(filters) {
    const conditions = [HISTORY_SCOPE, 'msdyn_endtime ne null'];
    const name = filters.name.trim().replace(/'/g, "''");
    if (name) conditions.push(`contains(msdyn_name,'${name}')`);
    if (filters.from) conditions.push(`msdyn_endtime ge ${new Date(filters.from + 'T00:00:00').toISOString()}`);
    if (filters.to) conditions.push(`msdyn_endtime le ${new Date(filters.to + 'T23:59:59.999').toISOString()}`);
    return fetchHistory(conditions, HISTORY_WINDOW);
}

// ── Unified rows ──────────────────────────────────────────────────────────
//
// Both sources are folded into one row shape so the table, the filters and the
// drill-down button do not have to care which table a row came from:
//   { id, solution, operation, time, durationMs, status, errorCode, errorText,
//     job, history }

const jobStartMs = (job) => new Date(job.startedon || job.createdon).getTime();

// `job.result` is present only once the job has been parsed by the completed
// query; still-running jobs come through without one.
export function importJobRow(job) {
    return {
        id: `job:${job.importjobid}`,
        solution: job.solutionname || job.name || 'Unknown',
        operation: 'Import',
        time: new Date(job.completedon || job.createdon).getTime(),
        durationMs: job.completedon ? new Date(job.completedon) - jobStartMs(job) : null,
        status: job.result?.status ?? 'running',
        errorCode: job.result?.errorCode ?? '',
        errorText: job.result?.errorText ?? '',
        job,
        history: null,
    };
}

export function historyRow(history) {
    const started = history.msdyn_starttime ? new Date(history.msdyn_starttime).getTime() : null;
    const ended = history.msdyn_endtime ? new Date(history.msdyn_endtime).getTime() : null;
    // The verdict comes from the error code and message, NOT from msdyn_result.
    // The docs describe msdyn_result as a Success/Failure boolean, but the virtual
    // provider never populates it — and its documented default is False, so
    // trusting it would brand every successful operation a failure the moment a
    // provider started returning the default. Successful rows carry errorcode "0"
    // and an empty exception message; failures carry a real code, a message, or both.
    const failed = hasErrorCode(history.msdyn_errorcode)
        || (history.msdyn_exceptionmessage ?? '').trim() !== '';
    return {
        id: `history:${history.msdyn_solutionhistoryid}`,
        solution: history.msdyn_name || 'Unknown',
        operation: operationLabel(history),
        time: ended ?? started ?? 0,
        durationMs: history.msdyn_totaltime != null
            ? history.msdyn_totaltime * 1000
            : (started != null && ended != null ? ended - started : null),
        status: ended == null ? 'running' : (failed ? 'failure' : 'success'),
        errorCode: hasErrorCode(history.msdyn_errorcode) ? String(history.msdyn_errorcode) : '',
        errorText: history.msdyn_exceptionmessage ?? '',
        job: null,
        history,
    };
}

// An upgrade that ran as an import writes both an importjob and an Import-
// operation history row. Pair them so the feed shows one row: the importjob
// side keeps the component log, the history side supplies the real operation
// name ("Upgrade" rather than a bare "Import") and the exception message.
const MATCH_WINDOW_MS = 5 * 60 * 1000;

export function mergeRows(jobRows, historyRows) {
    const unmatchedJobs = new Set(jobRows.filter((row) => row.job));
    const merged = [];

    for (const row of historyRows) {
        if (row.history.msdyn_operation !== 0) { merged.push(row); continue; }
        const name = row.solution.trim().toLowerCase();
        const started = row.history.msdyn_starttime ? new Date(row.history.msdyn_starttime).getTime() : null;

        // Nearest start time inside the window, so two imports of the same
        // solution minutes apart cannot cross-match.
        let best = null, bestGap = Infinity;
        if (started != null) {
            for (const candidate of unmatchedJobs) {
                if (candidate.solution.trim().toLowerCase() !== name) continue;
                const gap = Math.abs(jobStartMs(candidate.job) - started);
                if (gap <= MATCH_WINDOW_MS && gap < bestGap) { best = candidate; bestGap = gap; }
            }
        }
        if (!best) { merged.push(row); continue; }

        unmatchedJobs.delete(best);
        best.operation = row.operation;
        best.history = row.history;
        if (!best.errorCode) best.errorCode = row.errorCode;
        if (!best.errorText) best.errorText = row.errorText;
        // The history row is the authority on failure: an import log can parse
        // clean while the operation as a whole was rolled back.
        if (row.status === 'failure') best.status = 'failure';
    }

    return [...merged, ...jobRows].sort((a, b) => b.time - a.time);
}

async function getImportLogXml(importJobId) {
    try {
        const data = await dataverse.get(`/RetrieveFormattedImportJobResults(ImportJobId=${importJobId})`);
        if (data.FormattedResults) return data.FormattedResults;
    } catch (e) {
        console.warn('[Import Monitor] RetrieveFormattedImportJobResults failed, falling back:', e);
    }
    const job = await dataverse.get(`/importjobs(${importJobId})?$select=data`);
    if (job.data) return job.data;
    throw new Error('No import log data available');
}

function parseImportResult(job) {
    const result = { status: job.progress != null && Math.round(job.progress) >= 100 ? 'success' : 'failure', errorCode: '', errorText: '' };
    if (job.data) {
        try {
            const xml = new DOMParser().parseFromString(job.data, 'text/xml');
            const root = xml.documentElement;
            // The root <importexportxml> attributes carry the overall verdict
            // (succeeded="success|warning|failure"); individual <result> nodes
            // only describe single components. Warnings (e.g. missing translation
            // languages) count as success — nearly every import has some.
            const succeeded = root?.nodeName === 'importexportxml' ? root.getAttribute('succeeded') : null;
            if (['success', 'warning', 'failure'].includes(succeeded)) {
                result.status = succeeded === 'failure' ? 'failure' : 'success';
                const code = root.getAttribute('errorcode');
                if (code && code !== '0') { result.status = 'failure'; result.errorCode = code; }
            } else {
                const node = xml.querySelector('result');
                if (node) {
                    if (node.getAttribute('result') === 'failure') result.status = 'failure';
                    const code = node.getAttribute('errorcode');
                    if (code && code !== '0') { result.status = 'failure'; result.errorCode = code; }
                    result.errorText = node.getAttribute('errortext') ?? '';
                }
            }
            if (result.status !== 'success' && !result.errorText) {
                const bad = [...xml.querySelectorAll('result')].find((node) =>
                    node.getAttribute('errortext') && node.getAttribute('errorcode') !== '0');
                if (bad) {
                    result.errorText = bad.getAttribute('errortext');
                    if (!result.errorCode) result.errorCode = bad.getAttribute('errorcode') ?? '';
                }
            }
        } catch { /* ignore XML parse errors */ }
    }
    return result;
}

function parseLogXml(xmlString) {
    const xml = new DOMParser().parseFromString(xmlString, 'text/xml');
    const results = [];

    const worksheets = xml.getElementsByTagNameNS('*', 'Worksheet');
    if (worksheets.length > 0) {
        // Excel XML from RetrieveFormattedImportJobResults; 2nd worksheet = components.
        // Columns: DateTime | ComponentType | ID | Name | LocalizedName | OriginalName | Description | Status | ErrorCode | ErrorText
        const rows = (worksheets[1] ?? worksheets[0]).getElementsByTagNameNS('*', 'Row');
        for (let i = 2; i < rows.length; i++) {
            const values = [...rows[i].getElementsByTagNameNS('*', 'Cell')].map(
                (cell) => cell.getElementsByTagNameNS('*', 'Data')[0]?.textContent.trim() ?? '');
            if (values.every((v) => !v)) continue;

            const status = (values[7] ?? '').toLowerCase();
            if (!status) continue;
            const errorcode = values[8] ?? '';
            const hasError = errorcode && errorcode !== '0';
            const unprocessed = status.includes('nicht') || status.includes('not') || status.includes('unprocessed');

            results.push({
                result: unprocessed ? 'failure' : (hasError ? 'warning' : 'success'),
                errorcode,
                errortext: values[9] ?? '',
                component: values[1] ?? '',
                name: values[3] ?? '',
            });
        }
    } else {
        for (const node of xml.querySelectorAll('result')) {
            results.push({
                result: node.getAttribute('result') ?? '',
                errorcode: node.getAttribute('errorcode') ?? '0',
                errortext: node.getAttribute('errortext') ?? '',
                component: node.getAttribute('component') ?? '',
                name: node.getAttribute('name') ?? '',
            });
        }
    }
    return results;
}

// ── XML-in-error-text rendering (nested tables) ───────────────────────────

function getElementFields(element) {
    const fields = {};
    const order = [];
    for (const attr of element.attributes ?? []) { fields[attr.name] = attr.value; order.push(attr.name); }
    for (const child of element.children) {
        if (!fields[child.nodeName]) { fields[child.nodeName] = []; order.push(child.nodeName); }
        fields[child.nodeName].push(child);
    }
    if (order.length === 0) {
        const text = [...element.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('').trim();
        if (text) { fields.value = text; order.push('value'); }
    }
    return { fields, order };
}

function renderFieldValue(value) {
    if (typeof value === 'string') {
        return value ? `<span style="white-space:nowrap">${escapeHtml(value)}</span>` : '<span class="sim-muted">—</span>';
    }
    if (Array.isArray(value)) return renderObjectArrayTable(value);
    return '';
}

function renderObjectArrayTable(elements) {
    const columns = [];
    const rows = elements.map((element) => {
        const parsed = getElementFields(element);
        for (const name of parsed.order) if (!columns.includes(name)) columns.push(name);
        return parsed;
    });
    let html = '<table><tr>' + columns.map((c) => `<td class="h">${escapeHtml(c)}</td>`).join('') + '</tr>';
    for (const row of rows) {
        html += '<tr>' + columns.map((c) =>
            `<td>${row.fields[c] === undefined ? '<span class="sim-muted">—</span>' : renderFieldValue(row.fields[c])}</td>`).join('') + '</tr>';
    }
    return html + '</table>';
}

function xmlToTableHtml(xmlStr) {
    const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
    if (doc.querySelector('parsererror') || !doc.documentElement) return null;
    const root = doc.documentElement;
    const { fields, order } = getElementFields(root);
    let inner = '<table>';
    for (const name of order) {
        inner += `<tr><td class="k">${escapeHtml(name)}</td><td>${renderFieldValue(fields[name])}</td></tr>`;
    }
    inner += '</table>';
    return `<div class="sim-xml"><div class="h" style="padding:4px 8px">${escapeHtml(root.nodeName)}</div>${inner}</div>`;
}

function formatErrorText(errortext, renderXmlAsTable) {
    if (!errortext) return '';
    if (!renderXmlAsTable) return `<span class="sim-muted">${escapeHtml(errortext)}</span>`;

    const xmlMatch = errortext.match(/<([A-Za-z][\w]*)\b[^>]*>[\s\S]*?<\/\1>/);
    if (!xmlMatch) return `<span class="sim-muted">${escapeHtml(errortext)}</span>`;

    const before = errortext.slice(0, xmlMatch.index).replace(/[\s:]+$/, '').trim();
    const after = errortext.slice(xmlMatch.index + xmlMatch[0].length).replace(/^[\s,]+/, '').trim();
    const table = xmlToTableHtml(xmlMatch[0]);
    if (!table) return `<span class="sim-muted">${escapeHtml(errortext)}</span>`;

    return (before ? `<div style="margin-bottom:6px">${escapeHtml(before)}</div>` : '')
        + table
        + (after ? `<div class="sim-dim" style="margin-top:4px">${escapeHtml(after)}</div>` : '');
}

// ── Log viewer ────────────────────────────────────────────────────────────

const RESULT_BADGE = {
    success: '<span class="sim-badge ok">✓</span>',
    failure: '<span class="sim-badge fail">✕</span>',
    warning: '<span class="sim-badge warn">⚠</span>',
};

const isError = (entry) => (entry.errortext && entry.errortext.trim()) || (entry.errorcode && entry.errorcode !== '0');

function renderLogTableBody(tbody, entries, filter) {
    const filtered = (filter === 'errors' ? entries.filter(isError) : [...entries])
        .sort((a, b) => ({ failure: 0, warning: 1, success: 2 }[a.result] ?? 3) - ({ failure: 0, warning: 1, success: 2 }[b.result] ?? 3));

    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="padding:24px;text-align:center" class="sim-muted">No entries match this filter</td></tr>';
        return;
    }
    tbody.innerHTML = filtered.map((entry) => {
        const badge = RESULT_BADGE[entry.result] ?? `<span class="sim-badge plain">${escapeHtml(entry.result || '—')}</span>`;
        let error = '';
        if (entry.errorcode && entry.errorcode !== '0') error += `<code style="font-size:11px;color:#D13438">${escapeHtml(entry.errorcode)}</code> `;
        if (entry.errortext) error += formatErrorText(entry.errortext, filter === 'errors');
        return `<tr>
            <td style="text-align:center;width:70px">${badge}</td>
            <td class="sim-dim" style="white-space:nowrap">${escapeHtml(entry.component)}</td>
            <td style="font-weight:600;word-break:break-word">${escapeHtml(entry.name)}</td>
            <td style="font-size:12px;word-break:break-word">${error || '<span class="sim-muted">—</span>'}</td>
        </tr>`;
    }).join('');
}

// Opens a modal shell over the panel; returns the shell plus its disposer.
function openModal() {
    const backdrop = ui.mount(ui.el('div', { className: 'ppt sim-backdrop' }));
    let releaseEscape = () => {};
    const dispose = () => { backdrop.remove(); releaseEscape(); };
    releaseEscape = ui.onEscape(dispose);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) dispose(); });

    const shell = ui.el('div', { className: 'sim-log' });
    backdrop.appendChild(shell);
    return { shell, dispose };
}

// Operations with no importjob behind them (upgrades applied via promote,
// uninstalls) have no component log — their diagnostics are the solution-
// history fields, so show those instead of an empty table.
function openHistoryDetail(row) {
    const history = row.history;
    const { shell, dispose } = openModal();
    shell.style.maxWidth = '760px';

    const header = ui.el('div', { className: 'sim-header' });
    header.append(
        ui.el('h2', { textContent: `📋 ${row.operation} — ${row.solution}` }),
        ui.el('div', { style: 'display:flex;gap:6px;align-items:center' }, [
            ui.el('button', {
                className: 'ppt-icon-btn', textContent: '⛶', title: 'Toggle fullscreen',
                onclick: () => shell.classList.toggle('fullscreen'),
            }),
            ui.el('button', { className: 'ppt-icon-btn', textContent: '✕', title: 'Close', onclick: dispose }),
        ]),
    );

    const statusBadge = row.status === 'success'
        ? '<span class="sim-badge ok">✓ Success</span>'
        : (row.status === 'running'
            ? '<span class="sim-badge warn">⋯ Running</span>'
            : `<span class="sim-badge fail">✕ Failed${row.errorCode ? ` (${escapeHtml(row.errorCode)})` : ''}</span>`);

    const fields = [
        ['Solution', escapeHtml(history.msdyn_name ?? '—')],
        ['Operation', escapeHtml(OPERATION_LABEL[history.msdyn_operation] ?? '—')],
        ['Suboperation', escapeHtml(SUBOPERATION_LABEL[history.msdyn_suboperation] ?? '—')],
        ['Version', escapeHtml(history.msdyn_solutionversion || '—')],
        ['Publisher', escapeHtml(history.msdyn_publishername || '—')],
        ['Started', escapeHtml(formatDate(history.msdyn_starttime))],
        ['Ended', escapeHtml(history.msdyn_endtime ? formatDate(history.msdyn_endtime) : '—')],
        ['Duration', escapeHtml(row.durationMs != null ? formatDuration(row.durationMs) : '—')],
        ['Result', statusBadge],
        ['Error code', row.errorCode ? `<code style="color:#D13438">${escapeHtml(row.errorCode)}</code>` : '<span class="sim-muted">—</span>'],
        ['Activity ID', history.msdyn_activityid
            ? `<code style="font-size:11px">${escapeHtml(history.msdyn_activityid)}</code>`
            : '<span class="sim-muted">—</span>'],
    ];

    const body = ui.el('div', { className: 'sim-log-table-wrap', style: 'padding:16px 24px' });
    body.innerHTML = '<table class="sim-detail">'
        + fields.map(([label, value]) => `<tr><th>${label}</th><td>${value}</td></tr>`).join('')
        + '</table>';

    // Solution dependency failures embed an XML payload in the exception
    // message — the same renderer the import log uses turns it into a table.
    if (history.msdyn_exceptionmessage) {
        body.insertAdjacentHTML('beforeend',
            `<div class="ppt-label" style="margin:20px 0 6px">Exception message</div>
             <div style="font-size:12px">${formatErrorText(history.msdyn_exceptionmessage, true)}</div>`);
    }
    if (history.msdyn_exceptionstack) {
        body.insertAdjacentHTML('beforeend',
            `<details style="margin-top:16px"><summary class="sim-dim" style="cursor:pointer">Exception stack</summary>
             <pre class="sim-pre" style="margin-top:8px">${escapeHtml(history.msdyn_exceptionstack)}</pre></details>`);
    }
    if (!history.msdyn_exceptionmessage && !history.msdyn_exceptionstack && row.status === 'failure') {
        body.insertAdjacentHTML('beforeend',
            '<div class="ppt-note" style="margin-top:16px">This operation failed without recording an exception message.</div>');
    }

    shell.append(header, body);
}

async function openImportLogViewer(row) {
    const importJobId = row.job.importjobid;
    const solutionName = row.solution;
    const { shell, dispose } = openModal();
    shell.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;gap:10px;padding:48px"><div class="sim-spinner large"></div><span class="sim-muted">Loading import log…</span></div>';

    let entries, rawXml;
    try {
        rawXml = await getImportLogXml(importJobId);
        entries = parseLogXml(rawXml);
    } catch (e) {
        shell.innerHTML = '';
        shell.style.maxWidth = '420px';
        shell.append(
            ui.el('div', { className: 'ppt-dialog-header' }, [
                ui.el('h2', { textContent: 'Could not load log' }),
                ui.el('button', { className: 'ppt-icon-btn', textContent: '✕', onclick: dispose }),
            ]),
            ui.el('div', { className: 'ppt-dialog-body' }, [
                ui.el('div', { className: 'ppt-note', textContent: e.message }),
            ]),
        );
        return;
    }

    const errorCount = entries.filter(isError).length;
    let activeFilter = errorCount > 0 ? 'errors' : 'all';

    shell.innerHTML = '';
    const header = ui.el('div', { className: 'sim-header' });
    header.append(
        ui.el('h2', { textContent: `📋 ${row.operation} Log — ${solutionName || 'Unknown'}` }),
        ui.el('div', { style: 'display:flex;gap:6px;align-items:center' }, [
            ui.el('button', {
                className: 'ppt-btn', textContent: '⬇ Download XML',
                onclick: () => {
                    const url = URL.createObjectURL(new Blob([rawXml], { type: 'application/xml' }));
                    const a = ui.el('a', { href: url, download: `${solutionName || 'import'}_log.xml` });
                    a.click();
                    URL.revokeObjectURL(url);
                },
            }),
            ui.el('button', {
                className: 'ppt-icon-btn', textContent: '⛶', title: 'Toggle fullscreen',
                onclick: () => shell.classList.toggle('fullscreen'),
            }),
            ui.el('button', { className: 'ppt-icon-btn', textContent: '✕', title: 'Close', onclick: dispose }),
        ]),
    );

    const tbody = ui.el('tbody');
    const filters = ui.el('div', { style: 'display:flex;gap:10px;padding:10px 24px;border-bottom:1px solid var(--border);align-items:center;flex-wrap:wrap' });
    const filterButtons = [];
    const addFilter = (label, count, filter, cls) => {
        if (filter === 'errors' && count === 0) return;
        const btn = ui.el('span', { className: `sim-badge ${cls} sim-filter${activeFilter === filter ? ' active' : ''}`, textContent: `${label} ${count}` });
        btn.addEventListener('click', () => {
            activeFilter = filter;
            for (const b of filterButtons) b.classList.remove('active');
            btn.classList.add('active');
            renderLogTableBody(tbody, entries, activeFilter);
        });
        filterButtons.push(btn);
        filters.appendChild(btn);
    };
    addFilter('Errors', errorCount, 'errors', 'fail');
    addFilter('All Components', entries.length, 'all', 'plain');

    const counts = ['success', 'failure', 'warning'].map((r) => entries.filter((e) => e.result === r).length);
    filters.appendChild(ui.el('span', {
        className: 'sim-dim', style: 'margin-left:auto',
        textContent: [counts[0] && `${counts[0]} processed`, counts[1] && `${counts[1]} skipped`, counts[2] && `${counts[2]} with warnings`].filter(Boolean).join(' · '),
    }));

    const tableWrap = ui.el('div', { className: 'sim-log-table-wrap' });
    if (!entries.length) {
        tableWrap.innerHTML = '<div style="padding:48px;text-align:center" class="sim-muted">📭 No result entries found in this import log</div>';
    } else {
        const table = ui.el('table', { className: 'sim-table' });
        table.innerHTML = '<thead><tr><th style="text-align:center;width:70px">Result</th><th>Component</th><th>Name</th><th>Error</th></tr></thead>';
        renderLogTableBody(tbody, entries, activeFilter);
        table.appendChild(tbody);
        tableWrap.appendChild(table);
    }

    shell.append(header, filters, tableWrap);

    // A matched solution-history row often explains a failure the component log
    // does not — an upgrade can roll back with every component reported clean.
    if (row.history?.msdyn_exceptionmessage) {
        const banner = ui.el('div', { className: 'sim-banner' });
        banner.innerHTML = `<strong>${escapeHtml(row.operation)} failed${row.errorCode ? ` (${escapeHtml(row.errorCode)})` : ''}</strong>
            <div style="margin-top:6px">${formatErrorText(row.history.msdyn_exceptionmessage, true)}</div>`;
        shell.insertBefore(banner, filters);
    }
}

const openLogViewer = (row) => (row.job ? openImportLogViewer(row) : openHistoryDetail(row));

// ── Side panel ────────────────────────────────────────────────────────────

let panelOpen = false;
let pollTimer = null;

// An in-flight operation: an importjob (which reports a percentage) or a
// solution-history row that has started but not ended (which does not).
function renderActiveCard({ title, operation, progress, startTime }) {
    const card = ui.el('div', { className: 'sim-card', style: 'border-color:#B3D4FC' });
    card.append(
        ui.el('div', { style: 'display:flex;align-items:center;justify-content:space-between' }, [
            ui.el('div', { style: 'display:flex;align-items:center;gap:8px' }, [
                ui.el('span', { className: 'sim-spinner' }),
                ui.el('span', { style: 'font-weight:600', textContent: title }),
                ui.el('span', { className: 'sim-badge plain', textContent: operation }),
            ]),
            ui.el('span', { className: 'sim-dim', textContent: `⏱ ${startTime ? formatDuration(Date.now() - new Date(startTime).getTime()) : '—'}` }),
        ]),
        (() => {
            const bar = ui.el('div', { className: 'sim-progress' });
            bar.appendChild(progress > 0
                ? ui.el('div', { style: `width:${Math.min(progress, 100)}%` })
                : ui.el('div', { className: 'indeterminate' }));
            return bar;
        })(),
        ui.el('div', { style: 'display:flex;justify-content:space-between' }, [
            ui.el('span', {
                style: 'font-weight:600;color:var(--accent);font-size:13px',
                textContent: progress > 0 ? `${progress}%` : (progress === null ? 'In progress…' : 'Starting…'),
            }),
            ui.el('span', { className: 'sim-dim', textContent: startTime ? `Started ${formatTime(startTime)}` : '' }),
        ]),
    );
    return card;
}

function renderActiveSection(active, error) {
    const container = ui.el('div');
    container.appendChild(ui.el('div', { className: 'sim-section' }, [
        ui.el('span', { className: 'ppt-label', style: 'margin:0', textContent: 'Active Operations' }),
        ui.el('span', { className: `sim-badge ${active.length ? 'ok' : 'plain'}`, textContent: String(active.length) }),
    ]));
    if (error) {
        container.appendChild(ui.el('div', { className: 'ppt-note', style: 'color:var(--danger)', textContent: `Error loading solution operations: ${error}` }));
    } else if (!active.length) {
        container.appendChild(ui.el('div', {
            className: 'ppt-note', style: 'text-align:center;padding:24px',
            textContent: '✅ No active operations — all solution imports and upgrades have completed.',
        }));
    } else {
        for (const card of active) container.appendChild(renderActiveCard(card));
    }
    return container;
}

function renderOperationsTable(rows) {
    const table = ui.el('table', { className: 'sim-table' });
    table.innerHTML = '<thead><tr><th>Solution</th><th>Operation</th><th>Completed</th><th>Duration</th><th style="text-align:center">Result</th><th style="text-align:center">Log</th></tr></thead>';
    const tbody = ui.el('tbody');
    for (const row of rows) {
        const tr = ui.el('tr');
        tr.append(
            ui.el('td', { style: 'font-weight:600', textContent: row.solution }),
            ui.el('td', { className: 'sim-dim', style: 'white-space:nowrap', textContent: row.operation }),
            ui.el('td', { className: 'sim-dim', style: 'white-space:nowrap', textContent: row.time ? formatDate(new Date(row.time).toISOString()) : '—' }),
            ui.el('td', { className: 'sim-dim', textContent: row.durationMs != null ? formatDuration(row.durationMs) : '—' }),
            (() => {
                const cell = ui.el('td', { style: 'text-align:center' });
                cell.appendChild(ui.el('span', {
                    className: `sim-badge ${row.status === 'success' ? 'ok' : 'fail'}`,
                    title: row.errorText,
                    textContent: row.status === 'success' ? '✓ Success' : `✕ Failed${row.errorCode ? ` (${row.errorCode})` : ''}`,
                }));
                return cell;
            })(),
            (() => {
                const cell = ui.el('td', { style: 'text-align:center' });
                cell.appendChild(ui.el('button', {
                    className: 'ppt-btn', style: 'padding:3px 8px;font-size:11px',
                    textContent: row.job ? '📋 View' : '🔎 Details',
                    onclick: () => openLogViewer(row),
                }));
                return cell;
            })(),
        );
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return ui.el('div', { style: 'border:1px solid var(--border);border-radius:6px;overflow:hidden' }, [table]);
}

function openMonitor() {
    if (panelOpen) return;
    panelOpen = true;

    const state = {
        filters: { name: '', status: 'all', from: '', to: '' },
        jobs: [],        // loaded completed jobs, each with a parsed .result
        dead: [],        // early-failed jobs (no completedon) surfaced as failures
        history: [],     // loaded solution-history operations (upgrades, uninstalls)
        nextLink: null,
        historyCapped: false, // history came back at the window limit
        loading: false,
        error: null,
        historyError: null, // non-fatal: the panel still works without history
        seq: 0,          // discards out-of-order responses while typing
    };
    // Dead jobs never change, so parse each one's error once and keep it for the
    // panel's lifetime instead of re-fetching the log XML on every 3s poll.
    const deadCache = new Map(); // importjobid -> job with parsed .result

    const backdrop = ui.mount(ui.el('div', { className: 'ppt sim-backdrop' }));
    let releaseEscape = () => {};
    const dispose = () => {
        panelOpen = false;
        clearInterval(pollTimer);
        backdrop.remove();
        releaseEscape();
    };
    releaseEscape = ui.onEscape(dispose);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) dispose(); });

    // ── Active section (re-rendered by the poll) ──
    const activeContainer = ui.el('div');
    activeContainer.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;gap:10px;padding:48px"><div class="sim-spinner large"></div><span class="sim-muted">Loading solution operations…</span></div>';

    // Solution history is refetched on a slower beat than imports. $select is
    // ignored by its provider, so every row arrives carrying its full exception
    // stack — and an operation that reports no percentage gains nothing from a
    // three-second refresh. Between beats the last slice is reused.
    const HISTORY_POLL_MS = 12_000;
    let activeHistory = [];
    let activeHistoryAt = 0;

    async function pollActiveHistory() {
        if (activeHistoryAt && Date.now() - activeHistoryAt < HISTORY_POLL_MS) return activeHistory;
        activeHistoryAt = Date.now();
        try {
            activeHistory = await fetchActiveHistory();
        } catch (e) {
            console.warn('[Import Monitor] active solution-history poll failed:', e);
            activeHistory = [];
        }
        return activeHistory;
    }

    let lastActiveIds = null;
    async function pollActive() {
        let active = [], dead = [], runningHistory = [], error = null;
        // Import jobs and solution history are polled together; a failure to read
        // history must not blank out the imports, so each is settled separately.
        const [jobResult, historyResult] = await Promise.allSettled([fetchActiveImports(), pollActiveHistory()]);
        if (jobResult.status === 'fulfilled') ({ active, dead } = jobResult.value);
        else error = jobResult.reason.message;
        if (historyResult.status === 'fulfilled') runningHistory = historyResult.value;
        if (!panelOpen) return;

        // A running upgrade shows up in both tables; the importjob wins because
        // only it reports a percentage.
        const activeRows = active.map(importJobRow);
        const cards = mergeRows(activeRows, runningHistory.map(historyRow)).map((row) => ({
            title: row.solution,
            operation: row.operation,
            progress: row.job ? Math.round(row.job.progress ?? 0) : null,
            startTime: row.job
                ? (row.job.startedon || row.job.createdon)
                : row.history.msdyn_starttime,
        }));
        activeContainer.replaceChildren(renderActiveSection(cards, error));

        // Early-failed jobs never wrote completedon, so the completed query can't
        // find them — surface them there as failures. Enrich each once (data is
        // static) and drop any whose record has since disappeared.
        const deadIds = new Set(dead.map((job) => job.importjobid));
        let deadChanged = false;
        for (const id of [...deadCache.keys()]) {
            if (!deadIds.has(id)) { deadCache.delete(id); deadChanged = true; }
        }
        for (const job of dead) {
            if (deadCache.has(job.importjobid) || !panelOpen) continue;
            let result = { status: 'failure', errorCode: '', errorText: '' };
            try {
                const full = await dataverse.get(`/importjobs(${job.importjobid})?$select=data`);
                result = parseImportResult({ ...job, data: full.data });
            } catch { /* keep the plain failure verdict */ }
            deadCache.set(job.importjobid, { ...job, result });
            deadChanged = true;
        }
        if (deadChanged) {
            state.dead = [...deadCache.values()].sort((a, b) => new Date(b.createdon) - new Date(a.createdon));
            renderCompleted();
        }

        // When the active set changes (an operation finished), the list below is stale.
        const ids = [
            ...active.map((job) => job.importjobid),
            ...runningHistory.map((history) => history.msdyn_solutionhistoryid),
        ].sort().join();
        if (lastActiveIds !== null && ids !== lastActiveIds) reloadCompleted();
        lastActiveIds = ids;
    }

    // ── Completed section (filter bar is built once so inputs keep focus) ──
    const completedBadge = ui.el('span', { className: 'sim-badge plain', textContent: '…' });
    const completedContainer = ui.el('div');

    const nameInput = ui.el('input', {
        className: 'ppt-input', type: 'text', placeholder: '🔍 Solution name…',
        style: 'flex:1;min-width:150px',
    });
    const statusSelect = ui.el('select', { className: 'ppt-select', title: 'Filter by result' });
    statusSelect.innerHTML = '<option value="all">All results</option><option value="success">✓ Success</option><option value="failure">✕ Failed</option>';
    const fromInput = ui.el('input', { className: 'ppt-input', type: 'date', title: 'Completed on or after' });
    const toInput = ui.el('input', { className: 'ppt-input', type: 'date', title: 'Completed on or before' });
    const clearButton = ui.el('button', {
        className: 'ppt-btn', textContent: 'Clear', title: 'Clear all filters',
        onclick: () => {
            nameInput.value = fromInput.value = toInput.value = '';
            statusSelect.value = 'all';
            state.filters = { name: '', status: 'all', from: '', to: '' };
            reloadCompleted();
        },
    });
    const filterBar = ui.el('div', { className: 'sim-filterbar' }, [
        nameInput, statusSelect, fromInput,
        ui.el('span', { className: 'sim-dim', textContent: '–' }),
        toInput, clearButton,
    ]);

    // Dead jobs (always failures) are held client-side, so apply the same
    // name/date filters the server applies to the paged queries.
    function visibleDead() {
        const name = state.filters.name.trim().toLowerCase();
        return state.dead.filter((job) => {
            if (name && !`${job.solutionname ?? ''} ${job.name ?? ''}`.toLowerCase().includes(name)) return false;
            const when = job.completedon || job.createdon;
            if (state.filters.from && when && new Date(when) < new Date(state.filters.from + 'T00:00:00')) return false;
            if (state.filters.to && when && new Date(when) > new Date(state.filters.to + 'T23:59:59.999')) return false;
            return true;
        });
    }

    // One chronological feed of everything loaded. Status filtering happens here
    // because an import's verdict only emerges from parsing its log XML.
    function visibleRows() {
        const rows = mergeRows(
            [...visibleDead(), ...state.jobs].map(importJobRow),
            state.history.map(historyRow));
        return state.filters.status === 'all'
            ? rows
            : rows.filter((row) => row.status === state.filters.status);
    }

    const loadedCount = () => state.jobs.length + state.dead.length + state.history.length;

    function renderCompleted() {
        completedBadge.textContent = '…';
        completedContainer.replaceChildren();

        if (state.error) {
            completedContainer.appendChild(ui.el('div', { className: 'ppt-note', style: 'color:var(--danger)', textContent: `Error loading completed imports: ${state.error}` }));
            return;
        }
        if (state.loading && !loadedCount()) {
            completedContainer.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;gap:10px;padding:32px"><div class="sim-spinner"></div><span class="sim-muted">Loading completed operations…</span></div>';
            return;
        }

        // The badge counts merged rows rather than source records: an upgrade
        // written to both tables is one operation, not two.
        const visible = visibleRows();
        completedBadge.textContent = String(visible.length);
        if (!visible.length) {
            completedContainer.appendChild(ui.el('div', {
                className: 'ppt-note', style: 'text-align:center;padding:24px',
                textContent: loadedCount()
                    ? `None of the ${loadedCount()} loaded operations match this result filter — load more or clear the filter.`
                    : '📭 No completed operations match these filters.',
            }));
        } else {
            completedContainer.appendChild(renderOperationsTable(visible));
        }

        // Only imports page. History arrives as one bounded slice, so "load more"
        // extends the import half alone.
        const more = state.nextLink ? ' — more imports available' : '';
        const statusText = state.filters.status === 'all'
            ? `Showing ${visible.length} operations${more}`
            : `Showing ${visible.length} of ${loadedCount()} loaded${more}`;
        const loadMore = ui.el('div', { className: 'sim-loadmore' }, [
            ui.el('span', { className: 'sim-dim', textContent: statusText }),
        ]);
        if (state.nextLink) {
            loadMore.appendChild(ui.el('button', {
                className: 'ppt-btn', textContent: state.loading ? 'Loading…' : `⬇ Load ${PAGE_SIZE} more`,
                disabled: state.loading,
                onclick: () => loadCompletedPage(),
            }));
        }
        completedContainer.appendChild(loadMore);
        if (state.historyError) {
            completedContainer.appendChild(ui.el('div', {
                className: 'sim-dim', style: 'margin-top:6px',
                textContent: `Upgrades and uninstalls could not be loaded (${state.historyError}) — showing imports only.`,
            }));
        } else if (state.historyCapped) {
            completedContainer.appendChild(ui.el('div', {
                className: 'sim-dim', style: 'margin-top:6px',
                textContent: `Upgrades and uninstalls cover the ${HISTORY_WINDOW} most recent solution-history records; narrow the date range to reach further back.`,
            }));
        }
    }

    async function loadCompletedPage({ initial = false } = {}) {
        const seq = ++state.seq;
        state.loading = true;
        state.error = null;
        renderCompleted();

        const [jobs, history] = await Promise.allSettled([
            initial || state.nextLink ? fetchCompletedImports(state.filters, state.nextLink) : null,
            initial ? fetchCompletedHistory(state.filters) : null,
        ]);
        if (seq !== state.seq || !panelOpen) return;

        if (jobs.status === 'rejected') {
            state.error = jobs.reason.message;
        } else if (jobs.value) {
            for (const job of jobs.value.value ?? []) {
                const result = parseImportResult(job);
                delete job.data; // the raw log XML can be huge — don't retain it
                state.jobs.push({ ...job, result });
            }
            state.nextLink = jobs.value['@odata.nextLink'] ?? null;
        }

        // An environment without the solution-history table still gets a working
        // panel — the imports half simply carries it, with a note.
        if (history.status === 'rejected') {
            state.historyError = history.reason.message;
        } else if (history.value) {
            state.historyError = null;
            // The provider ignores $filter, so this pass is what actually selects
            // the rows — the request's own filter cannot be relied on.
            const raw = history.value.value ?? [];
            state.historyCapped = raw.length >= HISTORY_WINDOW;
            state.history = raw.filter((row) =>
                row.msdyn_endtime && inHistoryScope(row) && historyMatchesFilters(row, state.filters));
        }

        state.loading = false;
        renderCompleted();
    }

    function reloadCompleted() {
        state.jobs = [];
        state.history = [];
        state.nextLink = null;
        state.historyCapped = false;
        loadCompletedPage({ initial: true });
    }

    let nameDebounce = null;
    nameInput.addEventListener('input', () => {
        state.filters.name = nameInput.value;
        clearTimeout(nameDebounce);
        nameDebounce = setTimeout(reloadCompleted, 350);
    });
    statusSelect.addEventListener('change', () => {
        state.filters.status = statusSelect.value;
        renderCompleted(); // client-side only — no refetch needed
    });
    for (const [input, key] of [[fromInput, 'from'], [toInput, 'to']]) {
        input.addEventListener('change', () => {
            state.filters[key] = input.value;
            reloadCompleted();
        });
    }

    const content = ui.el('div', { className: 'sim-content' }, [
        activeContainer,
        ui.el('div', { className: 'sim-section', style: 'margin-top:24px' }, [
            ui.el('span', { className: 'ppt-label', style: 'margin:0', textContent: 'Completed Operations' }),
            completedBadge,
        ]),
        filterBar,
        completedContainer,
    ]);

    const panel = ui.el('div', { className: 'sim-panel' }, [
        ui.el('div', { className: 'sim-header' }, [
            ui.el('h2', {}, [
                document.createTextNode('📦 Solution Import Monitor'),
                ui.el('span', { className: 'sim-live', textContent: 'Live' }),
            ]),
            ui.el('button', { className: 'ppt-icon-btn', textContent: '✕', title: 'Close', onclick: dispose }),
        ]),
        content,
        ui.el('div', { className: 'sim-footer' }, [
            ui.el('span', { className: 'sim-dim', textContent: 'Active operations auto-refresh every 3 seconds' }),
            ui.el('button', { className: 'ppt-btn', textContent: '🔄 Refresh now', onclick: () => { pollActive(); reloadCompleted(); } }),
        ]),
    ]);
    backdrop.appendChild(panel);

    pollActive();
    reloadCompleted();
    pollTimer = setInterval(pollActive, 3000);
}

export default {
    init() {
        dataverse = new Dataverse();
        ui.addStyle('sim', STYLE);
        commands.register({
            toolId: 'solution-import-monitor',
            title: 'Open Solution Import Monitor',
            icon: '📦',
            run: openMonitor,
        });
    },
};
