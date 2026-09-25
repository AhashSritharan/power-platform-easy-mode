// Solution Deployer (native).
// Deploys unmanaged solutions between environments: create-or-pick a solution,
// export from the current org, import into a target org with live importjob
// progress, then publish. Also checks missing dependencies against a target
// (with one-click "add to solution" fixes) and cleans up the deployed solution
// (optionally also removing the unmanaged layers it left behind).
//
// The import goes over as one ordinary proxied POST to ImportSolutionAsync,
// and the job is then watched from here. It used to be fired from a helper tab
// on the target origin with `keepalive`, which silently capped the request body
// at 64 KiB — every solution larger than that was dropped by the browser before
// it left, and the deploy sat at 0% waiting for an import job the platform had
// never heard of.

import { Dataverse } from '../core/dataverse.js';
import { request } from '../core/http.js';
import { createStore } from '../core/storage.js';
import * as ui from '../core/ui.js';
import * as commands from '../core/commands.js';
import {
    ENV_TYPES, backfillNames, envIndicatorStore, groupEnvironments,
    loadEnvironments, normalizeRecord,
} from './shared/environments.js';

const STYLE = `
    .sd-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.3); z-index: 2147483000; animation: ppt-fade 0.15s ease; }
    .sd-panel {
        position: fixed; top: 0; right: 0; bottom: 0;
        width: 60vw; min-width: 480px; max-width: 1200px;
        background: var(--bg); display: flex; flex-direction: column;
        box-shadow: -4px 0 24px rgba(0,0,0,0.18); animation: sd-slide 0.25s ease;
    }
    .sd-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 24px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .sd-header h2 { margin: 0; font-size: 18px; font-weight: 600; }
    .sd-content { flex: 1; overflow-y: auto; padding: 16px 24px; }
    .sd-footer { padding: 14px 24px; border-top: 1px solid var(--border); flex-shrink: 0; background: var(--bg2); display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
    .sd-badge { background: var(--bg2); color: var(--accent); padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .sd-chip { padding: 5px 12px; font-size: 12px; font-weight: 600; border: 1px solid var(--border); border-radius: 16px; background: var(--bg); color: var(--text); cursor: pointer; font-family: inherit; }
    .sd-chip:hover, .sd-chip.active { border-color: var(--accent); color: var(--accent); }
    .sd-alert-info { background: var(--bg2); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 6px; padding: 12px 16px; font-size: 13px; margin-bottom: 16px; line-height: 1.5; }
    .sd-ok-box { padding: 12px 16px; border: 1px solid #A7E3A5; background: #DFF6DD; border-radius: 6px; margin-bottom: 12px; }
    .sd-err-box { padding: 14px 16px; border: 1px solid #F1BBBC; background: #FDE7E9; border-radius: 8px; }
    .sd-btn-success { background: #107C10; color: #fff; border: none; padding: 8px 20px; border-radius: 4px; font-size: 14px; font-weight: 600; font-family: inherit; cursor: pointer; }
    .sd-btn-success:hover { background: #0E6A0E; }
    .sd-btn-danger { background: #D13438; color: #fff; border: none; padding: 8px 20px; border-radius: 4px; font-size: 14px; font-weight: 600; font-family: inherit; cursor: pointer; }
    .sd-btn-danger:hover { background: #B10E11; }
    .sd-btn-success:disabled, .sd-btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }
    .sd-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 2147483050; display: flex; align-items: center; justify-content: center; animation: ppt-fade 0.15s ease; }
    .sd-modal {
        background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 24px;
        max-width: 600px; width: 90%; max-height: 80vh; overflow-y: auto;
        box-shadow: var(--shadow); display: flex; flex-direction: column; animation: ppt-pop 0.15s ease;
    }
    .sd-item { padding: 8px 12px; cursor: pointer; font-size: 13px; border-bottom: 1px solid var(--border); }
    .sd-item:hover { background: var(--bg2); }
    .sd-dropdown {
        position: absolute; top: 100%; left: 0; right: 0; background: var(--bg);
        border: 1px solid var(--border); border-radius: 0 0 4px 4px; max-height: 300px;
        overflow-y: auto; z-index: 10; box-shadow: var(--shadow);
    }
    .sd-spinner { width: 28px; height: 28px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: sd-spin 0.7s linear infinite; }
    .sd-env-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    .sd-env-btn { flex: 1; display: flex; align-items: center; gap: 10px; text-align: left; font-size: 12px; padding: 7px 12px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg); color: var(--text); cursor: pointer; font-family: inherit; min-width: 0; }
    .sd-env-btn:hover { border-color: var(--accent); }
    .sd-env-btn.selected { border-color: var(--accent); background: var(--bg2); box-shadow: inset 3px 0 0 var(--accent); }
    .sd-env-btn.selected .env-name, .sd-env-btn.selected strong { color: var(--accent); }
    .sd-env-btn .target-tag { margin-left: auto; flex-shrink: 0; font-size: 11px; font-weight: 600; color: var(--accent); white-space: nowrap; }
    .sd-env-btn .host { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sd-env-btn .env-name { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sd-env-group { border: 1px solid var(--border); border-radius: 6px; margin-bottom: 6px; overflow: hidden; }
    .sd-env-group-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px; background: var(--bg2); border: 0; font: inherit; font-size: 12px; font-weight: 600; color: var(--text); text-align: left; cursor: pointer; }
    .sd-env-group-head:hover { color: var(--accent); }
    .sd-env-group-head .caret { font-size: 9px; color: var(--muted); width: 10px; flex-shrink: 0; }
    .sd-env-group-head .count { font-weight: 400; font-size: 11px; color: var(--muted); }
    .sd-env-group-head .here { margin-left: auto; font-weight: 600; font-size: 11px; color: var(--accent); }
    .sd-env-group-body { padding: 6px 6px 2px; }
    .sd-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .sd-table th { padding: 8px 10px; text-align: left; font-weight: 600; color: var(--muted); border-bottom: 2px solid var(--border); white-space: nowrap; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; background: var(--bg2); position: sticky; top: 0; z-index: 1; }
    .sd-table td { padding: 8px 10px; word-break: break-word; border-bottom: 1px solid var(--border); }
    .sd-table tr:hover td { background: var(--bg2); }
    @keyframes sd-slide { from { transform: translateX(100%); } }
    @keyframes sd-spin { to { transform: rotate(360deg); } }
    @keyframes sd-progress-slide { 0% { left: -40%; } 100% { left: 100%; } }

    /* Dark overrides live last on purpose. A media query adds no specificity,
       so one sitting above its base rule quietly loses the cascade and paints
       a light swatch onto the dark panel. Anything hardcoding a colour above
       belongs here; rules built from the theme variables never need an entry. */
    @media (prefers-color-scheme: dark) {
        .sd-ok-box { background: #10380f; border-color: #1f5c1d; }
        .sd-err-box { background: #3a1416; border-color: #6b2a2e; }
    }
`;

let dv;
let store;
const cfmStore = () => createStore('cloud-flow-manager');

const cleanGuid = (guid) => (guid ? guid.replace(/[{}]/g, '').toLowerCase() : '');
const odataQuote = (s) => encodeURIComponent(String(s).replace(/'/g, "''"));
const isValidGuid = (guid) => !!guid && guid !== '00000000-0000-0000-0000-000000000000'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(guid);

function decodeHtmlEntities(text) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = text ?? '';
    return textarea.value;
}

function formatDuration(ms) {
    if (ms < 0) return '—';
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

// ── Environment identity ──────────────────────────────────────────────────
let currentEnvIdCache = null;
async function getCurrentEnvId() {
    if (!currentEnvIdCache) {
        try {
            const detail = await dv.retrieveCurrentOrganization();
            currentEnvIdCache = cleanGuid(detail?.EnvironmentId ?? '');
        } catch { /* stays null */ }
    }
    return currentEnvIdCache || null;
}

// Deploy targets, minus the environment being deployed from, plus the family
// that environment belongs to so the picker can open it. Environments the
// indicator has never seen a Dynamics host for are dropped: there is nothing
// to POST a solution at.
async function loadIndicatorEnvironments() {
    const environments = await loadEnvironments({
        currentEnvId: await getCurrentEnvId(),
        hostOnly: true,
        store: envIndicatorStore(),
    });
    // The current environment is normally matched by id; the host is the
    // fallback for when its id was never resolved on this page.
    const here = environments.find((env) => env.isCurrent)
        ?? environments.find((env) => env.host === location.hostname.toLowerCase());
    state.currentEnvGroup = here?.group ?? null;
    state.indicatorEnvs = environments.filter((env) => env !== here);
}

async function getEnvInfoForUrl(url) {
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        const env = envIndicatorStore();
        const hostCache = await env.get('envIndicator_hostCache', {});
        const mappings = await env.get('envIndicator_mappings', {});
        const envId = hostCache[hostname];
        const record = normalizeRecord(envId === undefined ? undefined : mappings[envId]);
        return record.type && ENV_TYPES[record.type]
            ? { ...ENV_TYPES[record.type], envId, hostname, name: record.name }
            : null;
    } catch { return null; }
}

// ── Target-environment API (cross-origin via the background proxy) ────────
async function targetApi(targetUrl, endpoint, options = {}) {
    try {
        const response = await request({
            url: targetUrl.replace(/\/+$/, '') + '/api/data/v9.2' + endpoint,
            method: options.method ?? 'GET',
            headers: {
                'OData-MaxVersion': '4.0', 'OData-Version': '4.0',
                'Accept': 'application/json', 'Content-Type': 'application/json',
                ...(options.headers ?? {}),
            },
            body: options.body ?? null,
            credentials: true,
        });
        if (response.status === 204) return { success: true };
        try { return response.json(); } catch { return { success: true }; }
    } catch (e) {
        // The status rides along: a caller polling for a record that does not
        // exist yet needs to tell a 404 (an answer) from no answer at all.
        if (e.status) {
            const error = new Error(`Target API ${e.status}: ${e.message}\n${e.body ?? ''}`);
            error.status = e.status;
            throw error;
        }
        throw new Error('Network error reaching target environment. Ensure you are logged in to the target environment in another tab.');
    }
}

async function targetSoap(targetUrl, xmlBody) {
    try {
        const response = await request({
            url: targetUrl.replace(/\/+$/, '') + '/XRMServices/2011/Organization.svc/web',
            method: 'POST',
            headers: {
                'Accept': 'application/xml, text/xml, */*',
                'Content-Type': 'text/xml; charset=utf-8',
                'SOAPAction': 'http://schemas.microsoft.com/xrm/2011/Contracts/Services/IOrganizationService/Execute',
            },
            body: xmlBody,
            credentials: true,
        });
        return response.text;
    } catch (e) {
        let msg = e.body ?? '';
        const fault = msg.match(/<Message[^>]*>([^<]+)<\/Message>/);
        if (fault) msg = fault[1];
        if (e.status) throw new Error(`Target SOAP API ${e.status}: ${msg || e.message}`);
        throw new Error('Network error reaching target environment via SOAP. Ensure you are logged in.');
    }
}

// ── Source-environment actions ────────────────────────────────────────────
async function createSolution(uniqueName, displayName, publisher) {
    if (!publisher) {
        let data = await dv.get(`/publishers?$filter=uniquename eq 'DefaultPublisherForOrg'&$select=publisherid,uniquename,customizationprefix`);
        publisher = data.value?.[0];
        if (!publisher) {
            data = await dv.get('/publishers?$select=publisherid,uniquename,customizationprefix&$top=1');
            publisher = data.value?.[0];
        }
    }
    if (!publisher) throw new Error('No publisher found. Cannot create solution.');
    return dv.create('solutions', {
        uniquename: uniqueName,
        friendlyname: displayName || uniqueName,
        version: '1.0.0.0',
        'publisherid@odata.bind': `/publishers(${publisher.publisherid})`,
    });
}

// ── Export ────────────────────────────────────────────────────────────────
// ExportSolutionAsync rather than the synchronous ExportSolution, for the same
// reason the import side is async: a 12 MB solution measured 48–80s to export
// synchronously against a live org, close enough to gateway timeouts to lose a
// deploy that had already done most of its work.
//
// The async path also leaves a trace. It writes an `exportsolutionupload` row
// holding the zip, whose id *is* the ExportJobId — that row is what the Export
// History tool lists and re-downloads, and those rows survive for years. The
// synchronous action writes no row at all (measured against a live org on
// 2026-08-14), so a solution exported that way leaves no record behind.
const EXPORT_POLL_MS = 2000;
const EXPORT_LIMITS = {
    silence: 300000, // 5 min of an org that answers nothing at all
    total: 3600000,  // 1 h for the whole export
};

/**
 * Waits out an export's async job. The read is injected so the state machine
 * can be exercised without an environment: see scripts/solution-export-test.mjs.
 *
 * Resolves on success — and also when the job record has vanished, because a
 * record cleaned up moments after succeeding cannot be told apart from one that
 * never existed. The download that follows is the better judge of which it was:
 * it either hands back a file or says why it cannot.
 */
export async function pollExportProgress({
    readAsyncOperation, log = () => {},
    pollMs = EXPORT_POLL_MS, limits = EXPORT_LIMITS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
    const startTime = Date.now();
    let lastSignal = Date.now();
    let queuedLogged = false;

    for (;;) {
        await sleep(pollMs);

        let op = null;
        try {
            op = await readAsyncOperation();
            lastSignal = Date.now();
        } catch (e) {
            if (e.status === 404) return;          // gone: let the download decide
            if (e.status) lastSignal = Date.now(); // reachable, just unhappy
        }

        if (op) {
            if (op.statecode === ASYNC_COMPLETED) {
                if (op.statuscode === 30) return;
                const reason = (op.friendlymessage || op.message || '').split('\n')[0].trim();
                const verdict = ASYNC_STATUS[op.statuscode] ?? `ended with status ${op.statuscode}`;
                throw new Error(`The export job ${verdict}${reason ? `: ${reason}` : '.'}`);
            }
            if (!queuedLogged && op.statuscode < ASYNC_RUNNING) {
                queuedLogged = true;
                log('info', '⏳ Export queued, waiting for a worker to pick it up…');
            }
        }

        if (Date.now() - lastSignal >= limits.silence) {
            throw new Error('Lost contact with this environment while exporting.');
        }
        if (Date.now() - startTime >= limits.total) {
            throw new Error('The export job has not finished. Check the system jobs in this environment.');
        }
    }
}

async function exportSolution(solutionUniqueName, managed, { log = () => {} } = {}) {
    const started = await dv.send('POST', '/ExportSolutionAsync', {
        SolutionName: solutionUniqueName,
        Managed: managed === true,
    });
    const asyncOperationId = cleanGuid(started?.AsyncOperationId ?? '');
    const exportJobId = cleanGuid(started?.ExportJobId ?? '');
    if (!isValidGuid(asyncOperationId) || !isValidGuid(exportJobId)) {
        throw new Error('The export request was accepted but returned no job ids.');
    }

    await pollExportProgress({
        log,
        readAsyncOperation: () => dv.get(
            `/asyncoperations(${asyncOperationId})?$select=statecode,statuscode,friendlymessage,message`),
    });

    const downloaded = await dv.send('POST', '/DownloadSolutionExportData', { ExportJobId: exportJobId });
    const file = downloaded?.ExportSolutionFile;
    if (!file) throw new Error('The export job finished but returned no solution file to download.');
    return file;
}

function generateGuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// ── Import ────────────────────────────────────────────────────────────────
// ImportSolutionAsync hands the work to the platform and returns an id
// immediately, so nothing has to hold a connection open for the length of the
// import — which is what the synchronous action demands, and what the old
// helper tab tried to fake with `keepalive`. It is also Microsoft's own
// recommendation for any solution big enough to risk a timeout. The queue wait
// before a worker picks the job up is real, but small next to the import.
//
// ComponentParameters is deliberately absent: it exists to override connection
// references and environment variable values, and an empty collection is not
// the same as no collection — Dataverse tries to type the empty array and
// answers "Custom state is not set for entity type crmbaseentity".
async function startImport(targetUrl, solutionFileBase64, callerIdGuid, importJobId) {
    const result = await targetApi(targetUrl, '/ImportSolutionAsync', {
        method: 'POST',
        headers: callerIdGuid ? { MSCRMCallerID: callerIdGuid } : {},
        body: JSON.stringify({
            OverwriteUnmanagedCustomizations: true,
            PublishWorkflows: true,
            CustomizationFile: solutionFileBase64,
            ImportJobId: importJobId,
        }),
    });
    const asyncOperationId = cleanGuid(result?.AsyncOperationId ?? '');
    if (!isValidGuid(asyncOperationId)) {
        throw new Error('The target accepted the import request but returned no async job id.');
    }
    return asyncOperationId;
}

// ── State ─────────────────────────────────────────────────────────────────
let panelOpen = false;
let state = {};
let solutionListCache = null;
let publisherListCache = null;
let sourceDependenciesCache = null;

// Shadow-DOM element refs for live progress updates
const els = { panel: null, log: null, progressBar: null, progressLabel: null, elapsed: null };

// "Last used" solution and target belong to the environment they were picked
// in: the same browser visits several orgs, and a solution unique name from one
// of them does not resolve in the next. Restoring across orgs looks like a
// genuine selection and then fails at export with "The given solution unique
// name is not valid". The host keys them apart; it is also the right default
// for the target, since each stage promotes to its own next one.
const envScopedKey = (key) => `${key}:${location.hostname.toLowerCase()}`;
const recall = (key, defaultValue) => store.get(envScopedKey(key), defaultValue);
const remember = (key, value) => store.set(envScopedKey(key), value);

async function resetState() {
    state = {
        mode: 'deploy', step: 'select', deployMode: 'new',
        selectedPublisher: null,
        newSolutionId: '', newSolutionUniqueName: '', newSolutionDisplayName: '', newSolutionReady: false,
        existingSolutionId: '', existingSolutionName: '', existingSolutionDisplayName: '',
        solutionName: '', targetEnvUrl: '', savedTargets: [],
        impersonateUserId: '', impersonateUserName: '',
        cleanupSolutionName: '', cleanupRemoveLayers: false,
        flowCheck: { status: 'idle', total: 0, off: [] },
        depCheckSolutionName: '', depCheckSolutionDisplayName: '', depCheckTargetUrl: '',
        depCheckResults: null, depCheckStatus: 'idle', depCheckError: '',
        progressLog: [], progressStatus: 'idle', importProgress: -1,
        importStartTime: 0, importElapsedInterval: null, publishing: false, errorMessage: '',
        indicatorEnvs: [], currentEnvGroup: null, envGroupOpen: {},
    };
    solutionListCache = null;
    publisherListCache = null;

    state.savedTargets = await store.get('targetEnvironments', []);
    await loadIndicatorEnvironments();

    const lastSolution = await recall('lastSolutionName', '');
    if (lastSolution) {
        state.deployMode = 'existing';
        state.existingSolutionId = await recall('lastSolutionId', '');
        state.existingSolutionName = lastSolution;
        state.existingSolutionDisplayName = await recall('lastSolutionDisplayName', '');
        state.cleanupSolutionName = lastSolution;
        state.depCheckSolutionName = lastSolution;
        state.depCheckSolutionDisplayName = state.existingSolutionDisplayName;
    }
    const lastTarget = await recall('lastTargetUrl', '');
    if (lastTarget) {
        state.targetEnvUrl = lastTarget;
        state.depCheckTargetUrl = lastTarget;
        await applyImpersonationForTarget();
    }
}

async function applyImpersonationForTarget() {
    const map = await store.get('impersonationMap', {});
    const saved = state.targetEnvUrl ? map[state.targetEnvUrl.toLowerCase()] : null;
    state.impersonateUserId = saved?.id ?? '';
    state.impersonateUserName = saved?.name ?? '';
}

// ── Logging & progress (live updates into the rendered panel) ────────────
const LOG_STYLES = {
    info: 'color:var(--muted)',
    success: 'color:#107C10;background:rgba(16,124,16,0.12)',
    warning: 'color:#835C00;background:rgba(245,208,108,0.18)',
    error: 'color:#D13438;background:rgba(209,52,56,0.12)',
};

function addLog(level, message) {
    state.progressLog.push({ level, message, time: new Date() });
    if (els.log?.isConnected) {
        els.log.appendChild(ui.el('div', {
            textContent: `[${new Date().toLocaleTimeString()}] ${message}`,
            style: `padding:4px 8px;font-size:12px;border-radius:4px;margin-bottom:2px;font-family:Consolas,monospace;word-break:break-word;${LOG_STYLES[level] ?? ''}`,
        }));
        els.log.scrollTop = els.log.scrollHeight;
    }
}

function updateProgressBar(progress) {
    if (els.progressLabel?.isConnected) {
        els.progressLabel.textContent = progress < 0 ? 'Working…' : `${Math.round(progress)}%`;
    }
    if (!els.progressBar?.isConnected) return;
    els.progressBar.style.cssText = progress < 0
        ? 'height:100%;width:30%;background:var(--accent);border-radius:4px;position:absolute;animation:sd-progress-slide 1.5s ease-in-out infinite'
        : `height:100%;width:${Math.min(progress, 100)}%;background:var(--accent);border-radius:4px;transition:width 0.5s ease`;
}

function updateElapsedLabel() {
    if (els.elapsed?.isConnected && state.importStartTime) {
        els.elapsed.textContent = `⏱ ${formatDuration(Date.now() - state.importStartTime)}`;
    }
}

// ── Import progress polling ───────────────────────────────────────────────
// Two sources, because neither is sufficient alone: the importjob row carries
// the percentage and the component-level log but does not exist until a worker
// picks the job up, and can be left frozen at 0% with `completedon` never
// written when an import dies early. The async operation always has a status,
// and it is the one that ends the wait.
//
// Every read is injected, so the state machine can be exercised without a
// target environment: see scripts/solution-import-test.mjs.
const ASYNC_COMPLETED = 3;
const ASYNC_RUNNING = 20; // below this the job is queued, not yet executing
const ASYNC_STATUS = { 30: 'succeeded', 31: 'failed', 32: 'was canceled' };
const POLL_MS = 1500;
const LIMITS = {
    silence: 300000, // 5 min of a target that answers nothing at all
    queue: 3600000,  // 1 h waiting for a worker to pick the job up
    stall: 1800000,  // 30 min of a started job reporting nothing new
};

export function pollImportProgress({
    readJob, readFailure, readAsyncOperation, asyncOperationId,
    log = () => {}, onProgress = () => {}, pollMs = POLL_MS, limits = LIMITS,
}) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        let lastProgress = -1;
        let lastStatus = -1;
        let lastSignal = Date.now();   // last time the target told us anything
        let lastMovement = Date.now(); // last time the import actually advanced
        let queuedLogged = false;
        let inFlight = false;
        let finished = false;

        const done = (fn) => {
            if (finished) return;
            finished = true;
            clearInterval(interval);
            fn();
        };

        /** Ends the wait: the import log's own verdict wins, `fallback` stands in. */
        async function settle(fallback) {
            let failure = fallback;
            try { failure = (await readFailure()) ?? fallback; }
            catch { /* unreadable — `fallback` stands */ }
            if (failure) { done(() => reject(new Error(failure))); return; }
            log('info', `Import completed in ${Math.round((Date.now() - startTime) / 1000)}s.`);
            done(resolve);
        }

        /** The percentage, while there is a job row to read it from. */
        async function pollJob() {
            let job;
            try {
                job = await readJob();
                lastSignal = Date.now();
            } catch (e) {
                // Any answer at all, 404 included, means the target is reachable;
                // the row simply does not exist while the job waits its turn.
                if (e.status) lastSignal = Date.now();
                return false;
            }
            if (!job) return false;

            if (typeof job.progress === 'number' && job.progress !== lastProgress) {
                lastProgress = job.progress;
                lastMovement = Date.now();
                onProgress(job.progress);
                if (job.progress < 100) log('info', `Import progress: ${job.progress.toFixed(0)}%`);
            }
            // A finished job is the whole answer — and it outlives the async
            // operation record, which the platform may clean up.
            if (job.completedon) { await settle(null); return true; }
            return false;
        }

        /** The async job's own verdict, once it has one. */
        async function pollAsyncOperation() {
            let op;
            try {
                op = await readAsyncOperation(asyncOperationId);
            } catch {
                return false; // a blip, or the record was cleaned up: the guards decide
            }
            if (!op) return false; // an answer with no record in it decides nothing
            lastSignal = Date.now();
            if (op.statuscode !== lastStatus) {
                lastStatus = op.statuscode;
                lastMovement = Date.now();
            }

            if (op.statecode !== ASYNC_COMPLETED) {
                if (!queuedLogged && op.statuscode < ASYNC_RUNNING) {
                    queuedLogged = true;
                    log('info', '⏳ Import queued on target, waiting for a worker to pick it up…');
                }
                return false;
            }
            if (op.statuscode === 30) { await settle(null); return true; }

            const reason = (op.friendlymessage || op.message || '').split('\n')[0].trim();
            const verdict = ASYNC_STATUS[op.statuscode] ?? `ended with status ${op.statuscode}`;
            await settle(`The import job on the target ${verdict}${reason ? `: ${reason}` : '.'}`);
            return true;
        }

        async function tick() {
            if (finished || inFlight) return;
            inFlight = true;
            try {
                if (await pollJob()) return;
                if (await pollAsyncOperation()) return;

                // Ways out of a wait that would never end on its own: the
                // target stopped answering, the job was never picked up, or a
                // started job sat unchanged long enough that something on the
                // platform is stuck. A queued job reports nothing new by
                // definition, so it gets its own, longer rope rather than
                // tripping the stall limit while it waits its turn.
                const queued = lastStatus >= 0 && lastStatus < ASYNC_RUNNING;
                if (Date.now() - lastSignal >= limits.silence) {
                    done(() => reject(new Error('Lost contact with the target environment while importing.')));
                } else if (queued && Date.now() - startTime >= limits.queue) {
                    done(() => reject(new Error(
                        'The import is still queued on the target environment and has not started. Check the system jobs there.')));
                } else if (!queued && Date.now() - lastMovement >= limits.stall) {
                    done(() => reject(new Error(lastProgress < 0
                        ? 'The import has not started on the target environment. Check the solution history there.'
                        : `The import stopped reporting progress at ${lastProgress.toFixed(0)}%. Check the solution history on the target.`)));
                }
            } finally {
                inFlight = false;
            }
        }

        const interval = setInterval(tick, pollMs);
        tick();
    });
}

// Wires the poller to a target environment: every read runs as the user the
// import runs as, so impersonation cannot lose sight of its own job.
function watchImport(targetUrl, importJobId, asyncOperationId, callerIdGuid) {
    const headers = callerIdGuid ? { MSCRMCallerID: callerIdGuid } : {};
    return pollImportProgress({
        asyncOperationId,
        readJob: () => targetApi(targetUrl, `/importjobs(${importJobId})?$select=progress,completedon`, { headers }),
        readAsyncOperation: (id) => targetApi(
            targetUrl, `/asyncoperations(${id})?$select=statecode,statuscode,message,friendlymessage`, { headers }),
        readFailure: async () => {
            const detail = await targetApi(targetUrl, `/importjobs(${importJobId})?$select=data`, { headers });
            const data = detail.data ?? '';
            if (!/result="failure"/i.test(data)) return null;
            const err = data.match(/errortext="([^"]*)"/i);
            return err?.[1] ? decodeHtmlEntities(err[1]) : 'Solution import failed on target.';
        },
        log: addLog,
        onProgress: (progress) => { state.importProgress = progress; updateProgressBar(progress); },
    });
}

// ── Pipelines ─────────────────────────────────────────────────────────────
async function runDeployPipeline() {
    state.progressLog = [];
    state.progressStatus = 'running';
    state.errorMessage = '';
    renderPanel();

    const solutionUniqueName = state.deployMode === 'existing' ? state.existingSolutionName : state.newSolutionUniqueName;
    try {
        addLog('info', `Using solution "${state.existingSolutionDisplayName || state.newSolutionDisplayName || solutionUniqueName}"…`);
        addLog('info', 'Exporting solution (unmanaged)…');
        state.importProgress = -1;
        updateProgressBar(-1);
        const solutionFile = await exportSolution(solutionUniqueName, false, { log: addLog });
        addLog('success', `Solution exported (${Math.round(solutionFile.length * 0.75 / 1024)} KB).`);

        const impersonateId = state.impersonateUserId || null;
        if (impersonateId) addLog('info', `Impersonating user: ${state.impersonateUserName} (${impersonateId})`);

        const importJobId = generateGuid();
        addLog('info', `Importing to target: ${state.targetEnvUrl}…`);
        state.importProgress = 0;
        state.importStartTime = Date.now();
        state.publishing = false;
        renderPanel();
        updateProgressBar(0);
        const asyncOperationId = await startImport(state.targetEnvUrl, solutionFile, impersonateId, importJobId);
        addLog('success', `Import job created on target (async operation ${asyncOperationId}).`);
        await watchImport(state.targetEnvUrl, importJobId, asyncOperationId, impersonateId);
        state.importProgress = 100;
        updateProgressBar(100);
        addLog('success', 'Solution imported to target.');

        addLog('info', 'Publishing all customizations on target…');
        state.publishing = true;
        renderPanel();
        updateProgressBar(100);
        const publishHeaders = impersonateId ? { MSCRMCallerID: impersonateId } : {};
        await targetApi(state.targetEnvUrl, '/PublishAllXml', { method: 'POST', headers: publishHeaders, body: JSON.stringify({}) });
        addLog('success', 'All customizations published.');

        state.progressStatus = 'success';
        state.solutionName = solutionUniqueName;
        addLog('success', '✅ Deployment completed successfully!');
        addLog('info', `Solution "${solutionUniqueName}" is kept on source for reuse.`);

        await remember('lastSolutionName', solutionUniqueName);
        await remember('lastSolutionDisplayName', state.existingSolutionDisplayName || state.newSolutionDisplayName || solutionUniqueName);
        await remember('lastSolutionId', state.existingSolutionId || state.newSolutionId || '');
        await remember('lastTargetUrl', state.targetEnvUrl);
    } catch (e) {
        state.progressStatus = 'error';
        state.errorMessage = e.message;
        addLog('error', `❌ Deployment failed: ${e.message}`);
    }

    clearInterval(state.importElapsedInterval);
    state.importElapsedInterval = null;
    renderPanel();

    if (state.progressStatus === 'success') await checkTargetFlowStates();
}

// ── Post-deployment flow check ────────────────────────────────────────────
// Imported cloud flows land turned off more often than not, and the "Check
// Flows" button is easy to miss — so look for disabled flows ourselves and
// nudge the user before they close the panel.
const isFlowOn = (flow) => (flow.msdyn_status !== undefined
    ? flow.msdyn_status !== 0
    : /aktiv|active|on/.test((flow.msdyn_statusname ?? '').toLowerCase()));

async function fetchTargetSolutionFlows(targetUrl, solutionUniqueName) {
    const solutions = await targetApi(targetUrl, `/solutions?$filter=uniquename eq '${odataQuote(solutionUniqueName)}'&$select=solutionid`);
    const solutionId = solutions.value?.[0]?.solutionid;
    if (!solutionId) return [];
    const filter = encodeURIComponent(`(msdyn_solutionid eq ${solutionId}) and (msdyn_componenttype eq 29 and msdyn_workflowcategory eq '5')`);
    const data = await targetApi(targetUrl, `/msdyn_solutioncomponentsummaries?$filter=${filter}&$orderby=msdyn_displayname asc&api-version=9.1`);
    return data.value ?? [];
}

async function checkTargetFlowStates() {
    state.flowCheck = { status: 'checking', total: 0, off: [] };
    addLog('info', 'Checking cloud flow states on target…');
    try {
        const flows = await fetchTargetSolutionFlows(state.targetEnvUrl, state.solutionName);
        const off = flows.filter((f) => !isFlowOn(f)).map((f) => f.msdyn_displayname || f.msdyn_name || 'Unnamed flow');
        state.flowCheck = { status: 'done', total: flows.length, off };
        if (!flows.length) addLog('info', 'No cloud flows in this solution.');
        else if (!off.length) addLog('success', `⚡ All ${flows.length} cloud flow(s) are turned on.`);
        else addLog('warning', `⚡ ${off.length} of ${flows.length} cloud flow(s) are turned OFF on the target.`);
    } catch (e) {
        state.flowCheck = { status: 'error', total: 0, off: [] };
        addLog('warning', `Could not check cloud flow states: ${e.message}`);
    }
    renderPanel();

    // Don't ambush someone who already closed the panel.
    if (panelOpen && state.flowCheck.status === 'done' && state.flowCheck.off.length && await showFlowsOffDialog()) {
        await openFlowManagerOnTarget();
    }
}

// Storage-based handoff: Cloud Flow Manager claims open_request in a tab on
// the matching origin (same-origin or freshly opened). The request carries the
// id of the tab we open, so a stray tab that happens to sit on the target
// origin cannot swallow the handoff while the user watches the new one.
async function openFlowManagerOnTarget() {
    let targetOrigin = '';
    try { targetOrigin = new URL(state.targetEnvUrl).origin; } catch { /* ignore */ }
    const openRequest = { solution: state.solutionName, targetOrigin, tabId: null, ts: Date.now() };
    if (targetOrigin && targetOrigin !== location.origin) {
        const opened = await chrome.runtime
            .sendMessage({ type: 'open-tab', url: targetOrigin + '/main.aspx', active: true })
            .catch(() => null);
        openRequest.tabId = opened?.tabId ?? null;
    }
    await cfmStore().set('open_request', openRequest);
    closePanel();
}

async function runCleanupPipeline() {
    state.progressLog = [];
    state.progressStatus = 'running';
    state.errorMessage = '';
    renderPanel();

    const COMPONENT_LOGICAL_NAMES = {
        1: 'entity', 2: 'attribute', 9: 'optionset', 10: 'entityrelationship',
        20: 'role', 24: 'systemform', 26: 'savedquery', 29: 'workflow',
        60: 'systemform', 61: 'webresource', 62: 'sitemap',
        66: 'customcontrol', 70: 'fieldsecurityprofile', 80: 'appmodule',
        91: 'pluginassembly', 92: 'sdkmessageprocessingstep', 95: 'serviceendpoint',
        300: 'canvasapp', 372: 'environmentvariabledefinition',
    };

    try {
        const targetUrl = state.targetEnvUrl;
        const solName = state.cleanupSolutionName;
        const removeLayers = state.cleanupRemoveLayers;

        addLog('info', `Looking up solution "${solName}" on target…`);
        const solutions = await targetApi(targetUrl, `/solutions?$filter=uniquename eq '${odataQuote(solName)}'&$select=solutionid`);
        const sol = solutions.value?.[0];
        if (!sol) throw new Error(`Solution '${solName}' not found on target.`);

        if (removeLayers) {
            const componentsData = await targetApi(targetUrl, `/solutioncomponents?$filter=_solutionid_value eq '${sol.solutionid}'&$select=solutioncomponentid,componenttype,objectid&$top=1000`);
            const components = componentsData.value ?? [];
            addLog('success', `Found ${components.length} component(s).`);

            addLog('info', 'Removing active customizations (unmanaged layers)…');
            let successCount = 0, skipCount = 0, errorCount = 0;
            for (const comp of components) {
                const logicalName = COMPONENT_LOGICAL_NAMES[comp.componenttype];
                if (!logicalName) { skipCount++; continue; }
                try {
                    await targetApi(targetUrl, '/RemoveActiveCustomization', {
                        method: 'POST',
                        body: JSON.stringify({ LogicalName: logicalName, Id: comp.objectid }),
                    });
                    successCount++;
                    addLog('success', `  Removed layer: ${logicalName} (${comp.objectid})`);
                } catch (e) {
                    if (/not Active layer|not supported|is not Active/.test(e.message)) skipCount++;
                    else {
                        errorCount++;
                        addLog('warning', `  Could not remove: ${logicalName} (${comp.objectid}) — ${e.message}`);
                    }
                }
            }
            addLog('info', `Results: ${successCount} removed, ${skipCount} skipped, ${errorCount} errors.`);
        } else {
            addLog('info', 'Keeping active customizations — the unmanaged layers stay until a managed import overwrites them.');
        }

        addLog('info', `Deleting solution "${solName}" on target…`);
        await targetApi(targetUrl, `/solutions(${sol.solutionid})`, { method: 'DELETE' });
        addLog('success', 'Solution deleted from target.');

        state.progressStatus = 'success';
        addLog('success', removeLayers
            ? '✅ Cleanup completed! Unmanaged layers removed and solution deleted.'
            : '✅ Cleanup completed! Solution deleted, customizations kept.');
    } catch (e) {
        state.progressStatus = 'error';
        state.errorMessage = e.message;
        addLog('error', `❌ Cleanup failed: ${e.message}`);
    }
    renderPanel();
}

// ── Dependency check ──────────────────────────────────────────────────────
const COMPONENT_TYPE_LABELS = {
    1: 'Entity', 2: 'Attribute', 3: 'Relationship', 4: 'Picklist Value',
    5: 'Lookup Value', 9: 'Option Set', 10: 'Entity Relationship',
    13: 'Managed Property', 14: 'Entity Key', 16: 'Privilege',
    20: 'Security Role', 24: 'System Form', 25: 'Dashboard',
    26: 'View', 29: 'Workflow / Flow', 60: 'System Form',
    61: 'Web Resource', 62: 'Site Map', 65: 'Plugin Assembly',
    66: 'Custom Control', 70: 'Field Security Profile',
    80: 'Model-driven App', 91: 'Plugin Assembly',
    92: 'SDK Message Processing Step', 95: 'Service Endpoint',
    300: 'Canvas App', 371: 'Connector',
    380: 'Env Variable Definition', 381: 'Env Variable Value',
};
const componentTypeLabel = (type) => COMPONENT_TYPE_LABELS[type] ?? `Component (${type})`;

async function getSourceDependencies(solutionName) {
    if (!sourceDependenciesCache) {
        const response = await dv.get(`/RetrieveMissingDependenciesWithMetadata(SolutionUniqueName='${odataQuote(solutionName)}',SkipManagedDependencies=true)`);
        sourceDependenciesCache = response.value ?? [];
    }
    return sourceDependenciesCache;
}

async function resolveMissingComponent(req, dep) {
    if (!state.depCheckSolutionName || !req) return null;
    const reqNameLower = (req.SchemaName || req.DisplayName || '').toLowerCase();
    const depNameLower = (dep?.SchemaName || dep?.DisplayName || '').toLowerCase();

    try {
        for (const d of await getSourceDependencies(state.depCheckSolutionName)) {
            if (d.requiredcomponentname && reqNameLower && d.requiredcomponentname.toLowerCase() === reqNameLower) {
                return { id: d.requiredcomponentobjectid, type: d.requiredcomponenttype };
            }
            if (dep?.Id && isValidGuid(dep.Id) && d.dependentcomponentobjectid?.toLowerCase() === dep.Id.toLowerCase()) {
                return { id: d.requiredcomponentobjectid, type: d.requiredcomponenttype };
            }
            const sourceDepName = (d.dependentcomponentname || d.dependentcomponentdisplayname || '').toLowerCase();
            if (depNameLower && sourceDepName === depNameLower) {
                return { id: d.requiredcomponentobjectid, type: d.requiredcomponenttype };
            }
        }
    } catch (e) {
        console.warn('[Solution Deployer] dependency-cache resolution failed:', e);
    }

    // Fallback: direct lookups for common component types
    const reqName = req.SchemaName || req.DisplayName || '';
    const type = req.Type;
    if (reqName) {
        try {
            if (reqName.includes('shared') || type === 10083 || type === 10082) {
                const res = await dv.get(`/connectionreferences?$filter=connectionreferencelogicalname eq '${odataQuote(reqName)}'&$select=connectionreferenceid`);
                if (res.value?.length) {
                    const typeRes = await dv.get(`/EntityDefinitions(LogicalName='connectionreference')?$select=ObjectTypeCode`);
                    return { id: res.value[0].connectionreferenceid, type: typeRes.ObjectTypeCode ?? type };
                }
            }
            if (type === 380) {
                const res = await dv.get(`/environmentvariabledefinitions?$filter=schemaname eq '${odataQuote(reqName)}'&$select=environmentvariabledefinitionid`);
                if (res.value?.length) return { id: res.value[0].environmentvariabledefinitionid, type: 380 };
            }
            if (type === 1) {
                const res = await dv.get(`/EntityDefinitions?$filter=LogicalName eq '${odataQuote(reqName)}'&$select=MetadataId`);
                if (res.value?.length) return { id: res.value[0].MetadataId, type: 1 };
            }
        } catch (e) {
            console.warn('[Solution Deployer] fallback lookup failed:', e);
        }
    }
    return null;
}

async function addMissingComponentToSolution(componentId, componentType) {
    return dv.send('POST', '/AddSolutionComponent', {
        ComponentId: componentId,
        ComponentType: componentType,
        SolutionUniqueName: state.depCheckSolutionName,
        AddRequiredComponents: false,
    });
}

async function runDependencyCheck() {
    if (!state.depCheckSolutionName || !state.depCheckTargetUrl) return;
    state.depCheckStatus = 'running';
    state.depCheckResults = null;
    state.depCheckError = '';
    sourceDependenciesCache = null;
    renderPanel();

    try {
        const solutionFile = await exportSolution(state.depCheckSolutionName, false);

        // RetrieveMissingComponents needs the file in the request body; the Web
        // API only exposes it as a GET function (URL-length limited), so SOAP it.
        const soapBody = `
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <Execute xmlns="http://schemas.microsoft.com/xrm/2011/Contracts/Services">
      <request i:type="c:RetrieveMissingComponentsRequest"
               xmlns:c="http://schemas.microsoft.com/crm/2011/Contracts"
               xmlns:i="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts"
               xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic">
        <a:Parameters>
          <a:KeyValuePairOfstringanyType>
            <b:key>CustomizationFile</b:key>
            <b:value i:type="d:base64Binary" xmlns:d="http://www.w3.org/2001/XMLSchema">${solutionFile}</b:value>
          </a:KeyValuePairOfstringanyType>
        </a:Parameters>
        <a:RequestId i:nil="true"/>
        <a:RequestName>RetrieveMissingComponents</a:RequestName>
      </request>
    </Execute>
  </s:Body>
</s:Envelope>`;
        const soapResponse = await targetSoap(state.depCheckTargetUrl, soapBody.trim());

        const xml = new DOMParser().parseFromString(soapResponse, 'text/xml');
        const parseComponentNode = (node) => {
            const obj = {};
            for (const child of node?.children ?? []) {
                obj[child.localName] = child.localName === 'Type' ? parseInt(child.textContent, 10) : child.textContent;
            }
            return obj;
        };
        const missing = [...xml.getElementsByTagName('*')]
            .filter((node) => node.localName === 'MissingComponent')
            .map((node) => {
                const children = [...node.children];
                return {
                    RequiredComponent: parseComponentNode(children.find((c) => c.localName === 'RequiredComponent')),
                    DependentComponent: parseComponentNode(children.find((c) => c.localName === 'DependentComponent')),
                };
            });

        state.depCheckResults = missing;
        state.depCheckStatus = 'done';
    } catch (e) {
        console.error('[Solution Deployer] dependency check failed:', e);
        state.depCheckError = e.message;
        state.depCheckResults = null;
        state.depCheckStatus = 'done';
    }
    renderPanel();
}

function formatDependencyResultsAsText(results) {
    let targetHost = state.depCheckTargetUrl;
    try { targetHost = new URL(state.depCheckTargetUrl).hostname; } catch { /* keep raw */ }
    const lines = [
        'Missing Dependencies Report', '',
        `Solution: ${state.depCheckSolutionDisplayName || state.depCheckSolutionName}`,
        `Target: ${targetHost}`,
        `Date: ${new Date().toLocaleString()}`,
        `Missing: ${results.length}`, '',
        'Required Component'.padEnd(35) + 'Type'.padEnd(25) + 'Solution'.padEnd(25) + 'Depends On'.padEnd(30) + 'Parent',
        '-'.repeat(140),
    ];
    for (const mc of results) {
        const req = mc.RequiredComponent ?? {};
        const dep = mc.DependentComponent ?? {};
        lines.push(
            (req.SchemaName || req.DisplayName || req.Id || '—').substring(0, 33).padEnd(35)
            + componentTypeLabel(req.Type).substring(0, 23).padEnd(25)
            + (req.Solution || '—').substring(0, 23).padEnd(25)
            + (dep.SchemaName || dep.DisplayName || dep.Id || '—').substring(0, 28).padEnd(30)
            + (req.ParentSchemaName || req.ParentDisplayName || '—'));
    }
    return lines.join('\n');
}

// ── UI building blocks ────────────────────────────────────────────────────
function envBox(role, hostname, envInfo) {
    return ui.el('div', {
        style: `border:2px solid ${envInfo?.border ?? 'var(--border)'};background:${envInfo?.bg ?? 'var(--bg2)'};border-radius:8px;padding:12px 16px;text-align:center;min-width:140px;max-width:180px`,
    }, [
        ui.el('div', { style: 'font-size:10px;font-weight:600;color:#838383;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px', textContent: role }),
        ui.el('div', {
            style: `display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;color:${envInfo?.color ?? '#616161'};background:#fff;border:1px solid ${envInfo?.border ?? '#D1D1D1'};margin-bottom:6px`,
            textContent: envInfo ? `${envInfo.icon} ${envInfo.label}` : '❓ Unknown',
        }),
        ui.el('div', { style: 'font-size:11px;color:#616161;word-break:break-all;line-height:1.3', textContent: hostname }),
    ]);
}

// `onDismiss` fires when the dialog is closed without a decision — Escape or a
// click on the backdrop — so a caller awaiting an answer always gets one.
function sdModal(renderFn, onDismiss) {
    const overlay = ui.mount(ui.el('div', { className: 'ppt sd-overlay' }));
    let releaseEscape = () => {};
    const close = () => { overlay.remove(); releaseEscape(); };
    const dismiss = () => { close(); onDismiss?.(); };
    releaseEscape = ui.onEscape(dismiss);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) dismiss(); });
    const modal = ui.el('div', { className: 'sd-modal' });
    modal.addEventListener('mousedown', (e) => e.stopPropagation());
    overlay.appendChild(modal);
    renderFn(modal, close, overlay);
    return close;
}

function envTypeBadge(type) {
    const config = ENV_TYPES[type] ?? { color: '#616161', bg: '#F5F5F5', border: '#D1D1D1', icon: '🌐', label: type };
    return ui.el('span', {
        style: `background:${config.bg};color:${config.color};border:1px solid ${config.border};padding:2px 8px;border-radius:3px;font-size:11px;font-weight:700;flex-shrink:0`,
        textContent: `${config.icon} ${config.label ?? type}`,
    });
}

// The target box holds whatever was typed or picked, the list holds canonical
// urls; matching on the host alone keeps a trailing slash, a missing scheme or
// a deep link from hiding the row the target actually points at.
function urlHost(url) {
    const raw = String(url ?? '').trim();
    if (!raw) return '';
    try {
        return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase();
    } catch {
        return raw.replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').toLowerCase();
    }
}
const isSelectedEnv = (url, selectedUrl) => {
    const host = urlHost(url);
    return host !== '' && host === urlHost(selectedUrl);
};

// Known environments, grouped into the families the indicator keeps. A deploy
// almost always goes to a sibling stage of the project you are in, so that
// family is expanded and everything else folds away behind a header. The row
// matching the target box is marked, so the typed url and the list never look
// like two unrelated controls.
function envQuickList(onPick, selectedUrl = '') {
    const wrap = ui.el('div', { style: 'margin-bottom:12px' });
    if (state.indicatorEnvs.length) {
        wrap.append(ui.el('span', { className: 'ppt-label', textContent: 'Known environments' }));
        const groups = groupEnvironments(state.indicatorEnvs, { currentGroup: state.currentEnvGroup });
        const labelByEnvId = new Map();

        for (const group of groups) {
            const key = group.group.toLowerCase();
            // The family you are deploying from starts open, as does the one
            // holding the current target — a marked row behind a folded header
            // is no feedback at all. The rest stay folded until the user says
            // otherwise, which sticks for the session.
            const holdsTarget = group.envs.some((env) => isSelectedEnv(env.url, selectedUrl));
            const isOpen = key in state.envGroupOpen
                ? state.envGroupOpen[key]
                : (group.isCurrent || holdsTarget || groups.length === 1);
            const head = ui.el('button', { className: 'sd-env-group-head' }, [
                ui.el('span', { className: 'caret', textContent: isOpen ? '▼' : '▶' }),
                ui.el('span', { textContent: group.label }),
                ui.el('span', { className: 'count', textContent: `(${group.envs.length})` }),
                ...(group.isCurrent ? [ui.el('span', { className: 'here', textContent: 'deploying from here' })] : []),
            ]);
            head.addEventListener('click', () => {
                state.envGroupOpen[key] = !isOpen;
                renderPanel();
            });

            const body = ui.el('div', { className: 'sd-env-group-body' });
            for (const env of group.envs) {
                const label = env.name
                    ? ui.el('span', { style: 'min-width:0' }, [
                        ui.el('div', { className: 'env-name', textContent: env.name }),
                        ui.el('div', { className: 'host', textContent: env.host }),
                    ])
                    : ui.el('span', { className: 'host', textContent: env.host });
                labelByEnvId.set(env.envId, label);
                const selected = isSelectedEnv(env.url, selectedUrl);
                const btn = ui.el('button', { className: `sd-env-btn${selected ? ' selected' : ''}` }, [
                    envTypeBadge(env.type), label,
                    ...(selected ? [ui.el('span', { className: 'target-tag', textContent: '✓ current target' })] : []),
                ]);
                btn.addEventListener('click', () => onPick(env.url));
                body.append(ui.el('div', { className: 'sd-env-row' }, [btn]));
            }
            // Nothing has been grouped yet (no names known): a header saying
            // "Ungrouped" would only be in the way, so the list stays flat.
            if (groups.length === 1 && !group.group) wrap.append(body);
            else wrap.append(ui.el('div', { className: 'sd-env-group' }, isOpen ? [head, body] : [head]));
        }

        // Environments labelled before names were stored show only a host until
        // their org answers; each row fills itself in without a re-render.
        backfillNames(state.indicatorEnvs, {
            store: envIndicatorStore(),
            onUpdate: (env) => {
                const label = labelByEnvId.get(env.envId);
                if (!label?.isConnected) return;
                label.className = '';
                label.style.minWidth = '0';
                label.replaceChildren(
                    ui.el('div', { className: 'env-name', textContent: env.name }),
                    ui.el('div', { className: 'host', textContent: env.host }));
            },
        });
    }
    if (state.savedTargets.length) {
        wrap.append(ui.el('span', { className: 'ppt-label', textContent: 'Saved environments' }));
        for (const t of state.savedTargets) {
            const selected = isSelectedEnv(t.url, selectedUrl);
            const btn = ui.el('button', { className: `sd-env-btn${selected ? ' selected' : ''}` }, [
                ui.el('span', { style: 'min-width:0' }, [
                    ui.el('strong', { textContent: t.name }),
                    ui.el('div', { className: 'host', textContent: t.url }),
                ]),
                ...(selected ? [ui.el('span', { className: 'target-tag', textContent: '✓ current target' })] : []),
            ]);
            btn.addEventListener('click', () => onPick(t.url));
            const del = ui.el('button', { className: 'ppt-icon-btn', textContent: '🗑️', title: 'Remove' });
            del.addEventListener('click', async () => {
                state.savedTargets = state.savedTargets.filter((x) => x.url !== t.url);
                await store.set('targetEnvironments', state.savedTargets);
                renderPanel();
            });
            wrap.append(ui.el('div', { className: 'sd-env-row' }, [btn, del]));
        }
    }
    return wrap;
}

function solutionPicker(title, loadSolutions, onPick) {
    sdModal((modal, close) => {
        modal.append(ui.el('h3', { style: 'margin:0 0 16px;font-size:16px;font-weight:600', textContent: title }));
        const loading = ui.el('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:12px;padding:32px' }, [
            ui.el('div', { className: 'sd-spinner' }),
            ui.el('span', { style: 'color:var(--muted);font-size:14px', textContent: 'Loading solutions…' }),
        ]);
        modal.append(loading);

        loadSolutions().then((solutions) => {
            loading.remove();
            const search = ui.el('input', { className: 'ppt-input', placeholder: 'Filter solutions…', style: 'margin-bottom:12px' });
            const list = ui.el('div', { style: 'max-height:400px;overflow-y:auto;border:1px solid var(--border);border-radius:6px' });
            const renderList = (filter) => {
                const filtered = solutions.filter((s) => !filter
                    || s.friendlyname.toLowerCase().includes(filter.toLowerCase())
                    || s.uniquename.toLowerCase().includes(filter.toLowerCase()));
                list.replaceChildren(...(filtered.length
                    ? filtered.map((s) => {
                        const item = ui.el('div', { className: 'sd-item' }, [
                            ui.el('strong', { textContent: s.friendlyname }),
                            ui.el('span', { style: 'color:var(--muted);font-size:11px', textContent: ` ${s.uniquename} v${s.version}` }),
                        ]);
                        item.addEventListener('click', () => { close(); onPick(s); });
                        return item;
                    })
                    : [ui.el('div', { style: 'padding:16px;text-align:center;color:var(--muted)', textContent: 'No matching solutions' })]));
            };
            renderList('');
            search.addEventListener('input', () => renderList(search.value.trim()));
            modal.append(search, list, ui.el('button', { className: 'ppt-btn', textContent: 'Cancel', style: 'margin-top:12px;align-self:flex-end', onclick: close }));
        }).catch((e) => {
            loading.replaceChildren(
                ui.el('div', { style: 'color:#D13438;font-weight:600', textContent: 'Error loading solutions' }),
                ui.el('div', { style: 'color:var(--muted);font-size:13px', textContent: e.message }),
            );
        });
    });
}

async function searchSolutions() {
    if (!solutionListCache) {
        const data = await dv.get('/solutions?$filter=ismanaged eq false and isvisible eq true&$select=solutionid,friendlyname,uniquename,version&$orderby=friendlyname asc');
        solutionListCache = data.value ?? [];
    }
    return solutionListCache;
}

// ── Confirmation modals ───────────────────────────────────────────────────
function warningAlert(w) {
    const colors = {
        error: 'background:#FDE7E9;border:1px solid #F1BBBC;color:#D13438',
        warning: 'background:#FFF4CE;border:1px solid #F5D06C;color:#835C00',
        info: 'background:#E5F1FB;border:1px solid #B3D4FC;color:#0F6CBD',
    };
    return ui.el('div', {
        style: `padding:10px 14px;border-radius:6px;font-size:13px;font-weight:500;${colors[w.level] ?? colors.info}`,
        textContent: `${w.icon} ${w.text}`,
    });
}

// Confirmation dialog whose backdrop/cancel resolve false and whose confirm
// button resolves true. `buildBody(modal)` fills everything above the buttons.
function confirmModal(buildBody, confirmButton, cancelLabel = 'Cancel') {
    return new Promise((resolve) => {
        sdModal((modal, close) => {
            const decide = (value) => { close(); resolve(value); };
            buildBody(modal);
            modal.append(ui.el('div', { style: 'display:flex;justify-content:flex-end;gap:8px' }, [
                ui.el('button', { className: 'ppt-btn', textContent: cancelLabel, onclick: () => decide(false) }),
                ...(confirmButton ? [ui.el('button', {
                    className: confirmButton.className,
                    textContent: confirmButton.label,
                    onclick: () => decide(true),
                })] : []),
            ]));
        }, () => resolve(false));
    });
}

async function showDeployConfirmation() {
    const sourceInfo = await getEnvInfoForUrl(location.origin);
    const targetInfo = await getEnvInfoForUrl(state.targetEnvUrl);
    const solutionName = state.deployMode === 'existing'
        ? (state.existingSolutionDisplayName || state.existingSolutionName) : state.newSolutionDisplayName;
    let targetHostname = state.targetEnvUrl;
    try { targetHostname = new URL(state.targetEnvUrl).hostname; } catch { /* keep raw */ }

    const warnings = [];
    const isSameEnv = !!(sourceInfo?.envId && targetInfo?.envId && sourceInfo.envId === targetInfo.envId);
    if (isSameEnv) warnings.push({ level: 'error', icon: '🚫', text: 'Source and target are the same environment!' });
    if (sourceInfo && sourceInfo.label !== 'DEV') warnings.push({ level: 'warning', icon: '⚠️', text: `Source is ${sourceInfo.label} — you should typically deploy from DEV.` });
    if (targetInfo?.label === 'PROD') warnings.push({ level: 'warning', icon: '🔴', text: 'Target is PRODUCTION — proceed with extra caution.' });
    if (!sourceInfo) warnings.push({ level: 'info', icon: 'ℹ️', text: 'Source environment type is unknown. Set it up in the Environment Indicator.' });
    if (!targetInfo) warnings.push({ level: 'info', icon: 'ℹ️', text: 'Target environment type is unknown. Set it up in the Environment Indicator.' });

    return confirmModal((modal) => {
        modal.append(
            ui.el('h3', { style: 'margin:0 0 20px;font-size:18px;font-weight:600', textContent: 'Confirm Deployment' }),
            ui.el('div', { style: 'display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:20px;flex-wrap:wrap' }, [
                envBox('SOURCE', location.hostname, sourceInfo),
                ui.el('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:4px' }, [
                    ui.el('div', {
                        className: 'sd-badge', textContent: solutionName, title: solutionName,
                        style: 'max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
                    }),
                    ui.el('div', { style: 'font-size:24px;color:var(--muted)', textContent: '→' }),
                ]),
                envBox('TARGET', targetHostname, targetInfo),
            ]),
            ...(warnings.length ? [ui.el('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-bottom:20px' }, warnings.map(warningAlert))] : []),
        );
    }, isSameEnv ? null : {
        className: targetInfo?.label === 'PROD' ? 'sd-btn-danger' : 'sd-btn-success',
        label: targetInfo?.label === 'PROD' ? '🚀 Deploy to PROD' : '🚀 Deploy Now',
    });
}

function showFlowsOffDialog() {
    const { total, off } = state.flowCheck;
    const shown = off.slice(0, 8);
    const rest = off.length - shown.length;

    return confirmModal((modal) => {
        modal.style.borderTop = '4px solid #F5D06C';
        modal.append(
            ui.el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:16px' }, [
                ui.el('span', { style: 'background:#FFF4CE;color:#835C00;padding:4px 10px;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase', textContent: '⚡ Flows' }),
                ui.el('h3', { style: 'margin:0;font-size:18px;font-weight:600', textContent: 'Some flows are turned off' }),
            ]),
            ui.el('div', { style: 'font-size:13px;margin-bottom:12px' }, [
                `The deployment succeeded, but ${off.length} of ${total} cloud flow(s) in this solution are turned off on the target. Imported flows usually need to be enabled — and their connection references checked — before anything runs.`,
            ]),
            ui.el('div', { style: 'max-height:180px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:16px;background:var(--bg2)' },
                shown.map((name) => ui.el('div', {
                    style: 'font-size:12px;padding:3px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis',
                    textContent: `⚫ ${name}`,
                })).concat(rest > 0
                    ? [ui.el('div', { style: 'font-size:12px;padding:3px 4px;color:var(--muted)', textContent: `…and ${rest} more` })]
                    : [])),
        );
    }, { className: 'ppt-btn primary', label: '⚡ Check Flows' }, 'Not now');
}

async function showCleanupConfirmation() {
    const sourceInfo = await getEnvInfoForUrl(location.origin);
    const targetInfo = await getEnvInfoForUrl(state.targetEnvUrl);
    let targetHostname = state.targetEnvUrl;
    try { targetHostname = new URL(state.targetEnvUrl).hostname; } catch { /* keep raw */ }

    const removeLayers = state.cleanupRemoveLayers;
    const warnings = [];
    const isSameEnv = !!(sourceInfo?.envId && targetInfo?.envId && sourceInfo.envId === targetInfo.envId);
    if (isSameEnv) warnings.push({ level: 'error', icon: '🚫', text: 'You are cleaning up the same environment you are on!' });
    if (removeLayers) warnings.push({ level: 'warning', icon: '⚠️', text: 'Active customizations will be reverted to their managed state — your unmanaged changes on this environment are lost.' });
    if (removeLayers && targetInfo?.label === 'PROD') warnings.push({ level: 'warning', icon: '🔴', text: 'Target is PRODUCTION — removing layers on PROD is risky.' });
    if (targetInfo?.label === 'DEV') warnings.push({ level: 'warning', icon: '⚠️', text: 'Target is DEV — cleanup is usually done on TEST/UAT/PROD after deploying managed.' });
    if (!targetInfo) warnings.push({ level: 'info', icon: 'ℹ️', text: 'Target environment type is unknown. Set it up in the Environment Indicator.' });

    return confirmModal((modal) => {
        modal.style.borderTop = '4px solid #D13438';
        modal.append(
            ui.el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:20px' }, [
                ui.el('span', { style: 'background:#FDE7E9;color:#D13438;padding:4px 10px;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase', textContent: '🧹 CLEANUP' }),
                ui.el('h3', { style: 'margin:0;font-size:18px;font-weight:600', textContent: 'Confirm Cleanup' }),
            ]),
            ui.el('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:10px;margin-bottom:16px;padding:16px;background:rgba(209,52,56,0.06);border:1px solid #F1BBBC;border-radius:8px' }, [
                ui.el('div', {
                    style: 'font-size:11px;font-weight:600;color:#D13438;text-transform:uppercase;letter-spacing:0.5px',
                    textContent: removeLayers ? 'Deleting solution + removing unmanaged layers on' : 'Deleting solution on',
                }),
                envBox('TARGET', targetHostname, targetInfo),
                ui.el('div', { style: 'display:inline-flex;gap:6px;background:var(--bg);border:1px solid #F1BBBC;color:#D13438;padding:6px 14px;border-radius:4px;font-size:13px;font-weight:600', textContent: `🗑️ ${state.cleanupSolutionName}` }),
            ]),
            ui.el('div', { className: 'sd-alert-info' }, [
                ui.el('strong', { textContent: 'What will happen: ' }),
                removeLayers
                    ? '1. Remove active customization (unmanaged layer) from each component. 2. Delete the unmanaged solution from the target.'
                    : 'Delete the unmanaged solution from the target. Components and their active customizations stay — the next managed import overwrites them.',
            ]),
            ...(warnings.length ? [ui.el('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-bottom:20px' }, warnings.map(warningAlert))] : []),
        );
    }, isSameEnv ? null : {
        className: 'sd-btn-danger',
        label: targetInfo?.label === 'PROD' ? '🧹 Clean up PROD' : '🧹 Run Cleanup',
    });
}

// ── Panel rendering ───────────────────────────────────────────────────────
let backdrop = null;

let releasePanelEscape = () => {};

function closePanel() {
    clearInterval(state.importElapsedInterval);
    state.importElapsedInterval = null;
    backdrop?.remove();
    backdrop = null;
    panelOpen = false;
    releasePanelEscape();
}

async function openDeployer() {
    if (panelOpen) return;
    panelOpen = true;
    await resetState();
    backdrop = ui.mount(ui.el('div', { className: 'ppt sd-backdrop' }));
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closePanel(); });
    releasePanelEscape = ui.onEscape(closePanel);
    els.panel = ui.el('div', { className: 'sd-panel' });
    backdrop.appendChild(els.panel);
    renderPanel();
}

function renderPanel() {
    if (!els.panel?.isConnected) return;
    els.panel.replaceChildren(renderHeader(), renderContent(), renderFooter());
}

function renderHeader() {
    const stepLabels = { select: 'Select Components', target: 'Choose Target', progress: 'Deploying…', done: 'Complete' };
    if (state.mode === 'cleanup') { stepLabels.select = 'Cleanup Setup'; stepLabels.progress = 'Cleaning up…'; }
    else if (state.mode === 'dependencies') stepLabels.select = 'Dependency Check';
    return ui.el('div', { className: 'sd-header' }, [
        ui.el('div', { style: 'display:flex;align-items:center;gap:12px' }, [
            ui.el('h2', { textContent: '🚀 Solution Deployer' }),
            ui.el('span', { className: 'sd-badge', textContent: stepLabels[state.step] ?? state.step }),
        ]),
        ui.el('button', { className: 'ppt-icon-btn', textContent: '✕', title: 'Close (Esc)', onclick: closePanel }),
    ]);
}

function renderContent() {
    const content = ui.el('div', { className: 'sd-content' });
    if (state.step === 'select') {
        content.append(renderModeTabs());
        if (state.mode === 'deploy') {
            content.append(renderDeployModeToggle(), state.deployMode === 'new' ? renderNewSolutionSetup() : renderExistingSolutionSelect());
        } else if (state.mode === 'dependencies') {
            content.append(renderDependencyCheckForm());
        } else {
            content.append(renderCleanupForm());
        }
    } else if (state.step === 'target') {
        content.append(renderTargetSelection());
    } else {
        content.append(renderProgress());
    }
    return content;
}

function modeChip(label, isActive, onClick) {
    const chip = ui.el('button', { className: `sd-chip${isActive ? ' active' : ''}`, textContent: label });
    chip.addEventListener('click', onClick);
    return chip;
}

function renderModeTabs() {
    return ui.el('div', { style: 'display:flex;gap:4px;margin-bottom:16px' }, [
        modeChip('🚀 Deploy', state.mode === 'deploy', () => { state.mode = 'deploy'; renderPanel(); }),
        modeChip('🔍 Check Deps', state.mode === 'dependencies', () => {
            state.mode = 'dependencies';
            state.depCheckStatus = 'idle'; state.depCheckResults = null; state.depCheckError = '';
            renderPanel();
        }),
        modeChip('🧹 Cleanup', state.mode === 'cleanup', () => { state.mode = 'cleanup'; renderPanel(); }),
    ]);
}

function renderDeployModeToggle() {
    return ui.el('div', { style: 'display:flex;gap:4px;margin-bottom:16px' }, [
        modeChip('📦 New Solution', state.deployMode === 'new', () => { state.deployMode = 'new'; renderPanel(); }),
        modeChip('📋 Existing Solution', state.deployMode === 'existing', () => { state.deployMode = 'existing'; renderPanel(); }),
    ]);
}

function openSolutionInPowerApps(environmentId, solutionId) {
    window.open(`https://make.powerapps.com/environments/${environmentId}/solutions/${solutionId}`, '_blank');
}

function renderNewSolutionSetup() {
    const container = ui.el('div');
    if (state.newSolutionReady) {
        container.append(
            ui.el('div', { className: 'sd-ok-box' }, [
                ui.el('div', { style: 'font-weight:600;color:#107C10;margin-bottom:8px;font-size:14px', textContent: '✅ Solution created' }),
                ui.el('div', { style: 'font-size:13px;margin-bottom:12px' }, [
                    ui.el('strong', { textContent: state.newSolutionDisplayName }),
                    ui.el('div', { style: 'color:var(--muted);font-size:12px', textContent: state.newSolutionUniqueName }),
                ]),
                ui.el('div', { className: 'sd-alert-info', style: 'margin:0' }, [
                    ui.el('strong', { textContent: 'Add components in Power Apps. ' }),
                    'The solution has been opened in a new tab. Add your components there, then come back and click Next to deploy.',
                ]),
            ]),
            ui.el('button', {
                className: 'ppt-btn', textContent: '🔗 Re-open in Power Apps', style: 'margin-bottom:12px',
                onclick: async () => {
                    const envId = await getCurrentEnvId();
                    if (envId && state.newSolutionId) openSolutionInPowerApps(envId, state.newSolutionId);
                },
            }),
            ui.el('button', {
                className: 'ppt-btn danger', textContent: 'Start over with a different solution',
                onclick: () => {
                    Object.assign(state, { newSolutionId: '', newSolutionUniqueName: '', newSolutionDisplayName: '', newSolutionReady: false, selectedPublisher: null });
                    renderPanel();
                },
            }),
        );
        return container;
    }

    container.append(ui.el('div', { className: 'sd-alert-info' }, [
        ui.el('strong', { textContent: 'New Solution. ' }),
        'Create a new solution and add components using the Power Apps maker portal. Then come back here to export and deploy it to the target environment.',
    ]));

    const select = ui.el('select', { className: 'ppt-select', style: 'width:100%', disabled: true }, [
        ui.el('option', { value: '', textContent: 'Loading publishers…' }),
    ]);
    container.append(ui.el('span', { className: 'ppt-label', textContent: 'Publisher' }), select);
    (async () => {
        try {
            if (!publisherListCache) {
                const data = await dv.get('/publishers?$select=publisherid,uniquename,friendlyname,customizationprefix&$orderby=friendlyname asc');
                publisherListCache = data.value ?? [];
            }
            select.disabled = false;
            select.replaceChildren(
                ui.el('option', { value: '', textContent: 'Default Publisher' }),
                ...publisherListCache.map((p) => ui.el('option', {
                    value: p.publisherid,
                    textContent: `${p.friendlyname} (${p.customizationprefix})`,
                    selected: state.selectedPublisher?.publisherid === p.publisherid,
                })));
            select.addEventListener('change', () => {
                state.selectedPublisher = publisherListCache.find((p) => p.publisherid === select.value) ?? null;
            });
        } catch {
            select.replaceChildren(ui.el('option', { textContent: 'Error loading publishers' }));
        }
    })();

    const createBtn = ui.el('button', {
        className: 'ppt-btn primary',
        style: 'width:100%;margin-top:16px;padding:12px 20px',
        textContent: '📦 Create Solution & Open in Power Apps',
    });
    createBtn.addEventListener('click', async () => {
        const envId = await getCurrentEnvId();
        if (!envId) { ui.toast('⚠️ Could not determine the environment id.'); return; }
        createBtn.disabled = true;
        createBtn.textContent = 'Creating…';
        try {
            const ts = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
            const uniqueName = `QuickDeploy_${ts}`;
            const displayName = `Quick Deploy ${new Date().toLocaleString()}`;
            await createSolution(uniqueName, displayName, state.selectedPublisher);
            const data = await dv.get(`/solutions?$filter=uniquename eq '${odataQuote(uniqueName)}'&$select=solutionid&$top=1`);
            const solutionId = data.value?.[0]?.solutionid;
            if (!solutionId) throw new Error('Solution was created but could not retrieve its ID.');
            state.newSolutionId = cleanGuid(solutionId);
            state.newSolutionUniqueName = uniqueName;
            state.newSolutionDisplayName = displayName;
            state.newSolutionReady = true;
            openSolutionInPowerApps(envId, state.newSolutionId);
            renderPanel();
        } catch (e) {
            createBtn.disabled = false;
            createBtn.textContent = '📦 Create Solution & Open in Power Apps';
            ui.toast(`❌ Failed to create solution: ${e.message}`, 5000);
        }
    });
    container.append(createBtn);
    return container;
}

function renderExistingSolutionSelect() {
    const container = ui.el('div');
    container.append(ui.el('div', { className: 'sd-alert-info' }, [
        ui.el('strong', { textContent: 'Deploy Existing Solution. ' }),
        'Select an unmanaged solution from this environment.',
    ]));

    if (state.existingSolutionName) {
        container.append(ui.el('div', { className: 'sd-ok-box', style: 'display:flex;align-items:center;justify-content:space-between;gap:8px' }, [
            ui.el('div', {}, [
                ui.el('strong', { style: 'color:#107C10', textContent: 'Selected: ' }),
                state.existingSolutionDisplayName || state.existingSolutionName,
                ui.el('div', { style: 'font-size:12px;color:var(--muted)', textContent: state.existingSolutionName }),
            ]),
            ui.el('div', { style: 'display:flex;gap:8px;flex-shrink:0' }, [
                ui.el('button', {
                    className: 'ppt-btn', textContent: '🔗 Open', style: 'font-size:12px;padding:6px 12px',
                    onclick: async () => {
                        const envId = await getCurrentEnvId();
                        if (!envId) return;
                        if (!state.existingSolutionId && state.existingSolutionName) {
                            try {
                                const data = await dv.get(`/solutions?$filter=uniquename eq '${odataQuote(state.existingSolutionName)}'&$select=solutionid&$top=1`);
                                if (data.value?.[0]) {
                                    state.existingSolutionId = cleanGuid(data.value[0].solutionid);
                                    await remember('lastSolutionId', state.existingSolutionId);
                                }
                            } catch { /* ignore */ }
                        }
                        if (state.existingSolutionId) openSolutionInPowerApps(envId, state.existingSolutionId);
                    },
                }),
                ui.el('button', {
                    className: 'ppt-btn', textContent: 'Change', style: 'font-size:12px;padding:6px 12px',
                    onclick: () => {
                        Object.assign(state, { existingSolutionId: '', existingSolutionName: '', existingSolutionDisplayName: '' });
                        renderPanel();
                    },
                }),
            ]),
        ]));
    } else {
        container.append(ui.el('button', {
            className: 'ppt-btn', textContent: '📦 Select a solution…', style: 'width:100%',
            onclick: () => solutionPicker('Select Solution to Deploy', searchSolutions, async (s) => {
                state.existingSolutionId = cleanGuid(s.solutionid);
                state.existingSolutionName = s.uniquename;
                state.existingSolutionDisplayName = s.friendlyname;
                await remember('lastSolutionId', state.existingSolutionId);
                await remember('lastSolutionName', s.uniquename);
                await remember('lastSolutionDisplayName', s.friendlyname);
                renderPanel();
            }),
        }));
    }
    return container;
}

function renderDependencyCheckForm() {
    const container = ui.el('div');
    container.append(ui.el('div', { className: 'sd-alert-info' }, [
        ui.el('strong', { textContent: 'Dependency Check. ' }),
        'Exports the solution from this environment and checks for missing dependencies on the target.',
    ]));

    container.append(ui.el('span', { className: 'ppt-label', textContent: 'Solution' }));
    if (state.depCheckSolutionName) {
        container.append(ui.el('div', { className: 'sd-ok-box', style: 'display:flex;align-items:center;justify-content:space-between;gap:8px' }, [
            ui.el('div', {}, [
                ui.el('strong', { style: 'color:#107C10', textContent: 'Selected: ' }),
                state.depCheckSolutionDisplayName || state.depCheckSolutionName,
                ui.el('div', { style: 'font-size:12px;color:var(--muted)', textContent: state.depCheckSolutionName }),
            ]),
            ui.el('button', {
                className: 'ppt-btn', textContent: 'Change', style: 'font-size:12px;padding:6px 12px;flex-shrink:0',
                onclick: () => {
                    Object.assign(state, { depCheckSolutionName: '', depCheckSolutionDisplayName: '', depCheckResults: null, depCheckStatus: 'idle', depCheckError: '' });
                    renderPanel();
                },
            }),
        ]));
    } else {
        container.append(ui.el('button', {
            className: 'ppt-btn', textContent: '📦 Select a solution…', style: 'width:100%;margin-bottom:16px',
            onclick: () => solutionPicker('Select Solution to Check', searchSolutions, (s) => {
                Object.assign(state, {
                    depCheckSolutionName: s.uniquename, depCheckSolutionDisplayName: s.friendlyname,
                    depCheckResults: null, depCheckStatus: 'idle', depCheckError: '',
                });
                renderPanel();
            }),
        }));
    }

    const targetInput = ui.el('input', { className: 'ppt-input', type: 'text', placeholder: 'https://yourorg.crm.dynamics.com', value: state.depCheckTargetUrl });
    // Re-render on every way the target can change, so the list below always
    // agrees with the box: picking a row and typing a url are the same act.
    // A verdict belongs to the target it was computed against, so moving the
    // target drops it — the results box reads the url live and would otherwise
    // vouch for an environment nothing was ever checked on.
    const setDepCheckTarget = (url) => {
        const next = String(url).replace(/\/+$/, '');
        if (next === state.depCheckTargetUrl) return;
        state.depCheckTargetUrl = next;
        Object.assign(state, { depCheckResults: null, depCheckStatus: 'idle', depCheckError: '' });
    };
    targetInput.addEventListener('change', () => {
        setDepCheckTarget(targetInput.value);
        renderPanel();
    });
    container.append(
        ui.el('span', { className: 'ppt-label', textContent: 'Target environment URL' }),
        targetInput,
        ui.el('div', { style: 'font-size:12px;color:var(--muted);margin:4px 0 16px', textContent: 'Make sure you are logged in to the target environment in another browser tab.' }),
        envQuickList((url) => {
            setDepCheckTarget(url);
            renderPanel();
        }, state.depCheckTargetUrl),
    );

    if (state.depCheckStatus === 'running') {
        container.append(ui.el('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:12px;padding:32px;border:1px solid var(--border);background:var(--bg2);border-radius:8px;margin-top:16px' }, [
            ui.el('div', { className: 'sd-spinner' }),
            ui.el('span', { style: 'color:var(--muted);font-size:14px', textContent: 'Exporting solution and checking dependencies…' }),
        ]));
    } else if (state.depCheckStatus === 'done') {
        container.append(renderDependencyResults());
    }
    return container;
}

function renderDependencyResults() {
    const container = ui.el('div', { style: 'margin-top:16px' });

    if (state.depCheckError) {
        container.append(ui.el('div', { className: 'sd-err-box' }, [
            ui.el('div', { style: 'font-weight:600;color:#D13438;margin-bottom:8px;font-size:14px', textContent: '❌ Dependency check failed' }),
            ui.el('div', { style: 'font-size:13px;word-break:break-word;font-family:Consolas,monospace', textContent: state.depCheckError }),
            ui.el('button', { className: 'ppt-btn', textContent: '🔄 Retry', style: 'margin-top:12px', onclick: () => runDependencyCheck() }),
        ]));
        return container;
    }

    const results = state.depCheckResults ?? [];
    const resetDepCheck = () => {
        Object.assign(state, { depCheckSolutionName: '', depCheckSolutionDisplayName: '', depCheckResults: null, depCheckStatus: 'idle', depCheckError: '' });
        renderPanel();
    };

    if (!results.length) {
        let targetHostname = state.depCheckTargetUrl;
        try { targetHostname = new URL(state.depCheckTargetUrl).hostname; } catch { /* keep raw */ }
        container.append(ui.el('div', { className: 'sd-ok-box', style: 'padding:20px;text-align:center' }, [
            ui.el('div', { style: 'font-size:36px;margin-bottom:8px', textContent: '✅' }),
            ui.el('div', { style: 'font-weight:600;color:#107C10;font-size:16px;margin-bottom:6px', textContent: 'No missing dependencies!' }),
            ui.el('div', { style: 'font-size:13px' }, [
                'Solution ', ui.el('strong', { textContent: state.depCheckSolutionDisplayName || state.depCheckSolutionName }),
                ' can be safely imported to ', ui.el('strong', { textContent: targetHostname }), '.',
            ]),
            ui.el('div', { style: 'display:flex;justify-content:center;margin-top:16px' }, [
                ui.el('button', { className: 'ppt-btn', textContent: '🔄 Check Another', onclick: resetDepCheck }),
            ]),
        ]));
        return container;
    }

    const addAllBtn = ui.el('button', { className: 'ppt-btn primary', style: 'font-size:12px;padding:4px 10px', textContent: '➕ Add All Missing', title: 'Add all missing components to the solution on the source environment' });
    addAllBtn.addEventListener('click', async () => {
        addAllBtn.disabled = true;
        addAllBtn.textContent = '⏳ Adding…';
        let addedCount = 0;
        const errors = [];
        for (const mc of results) {
            const req = mc.RequiredComponent;
            if (!req?.Type) continue;
            let compId = req.Id;
            let compType = req.Type;
            if (!isValidGuid(compId)) {
                const resolved = await resolveMissingComponent(req, mc.DependentComponent);
                if (resolved && isValidGuid(resolved.id)) { compId = resolved.id; compType = resolved.type; }
            }
            if (!isValidGuid(compId)) { errors.push(`Could not resolve valid ID for ${req.SchemaName || 'Unknown Component'}`); continue; }
            try { await addMissingComponentToSolution(compId, compType); addedCount++; }
            catch (e) { errors.push(e.message); }
        }
        if (errors.length) {
            console.error('[Solution Deployer] errors adding components:', errors);
            ui.toast(`Added ${addedCount} components; ${errors.length} error(s) — see console.`, 5000);
        }
        addAllBtn.textContent = errors.length ? '⚠️ Partial Success' : '✅ All Added';
        setTimeout(() => runDependencyCheck(), 1500);
    });

    const copyBtn = ui.el('button', { className: 'ppt-btn', style: 'font-size:12px;padding:4px 10px', textContent: '📋 Copy' });
    copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(formatDependencyResultsAsText(results)).then(() => ui.toast('📋 Report copied'));
    });

    container.append(ui.el('div', { className: 'sd-err-box', style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap;padding:12px 16px' }, [
        ui.el('div', { style: 'font-weight:600;color:#D13438;font-size:14px', textContent: `❌ ${results.length} missing ${results.length === 1 ? 'dependency' : 'dependencies'} found` }),
        ui.el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, [
            addAllBtn, copyBtn,
            ui.el('button', { className: 'ppt-btn', style: 'font-size:12px;padding:4px 10px', textContent: '🔄 Check Another', onclick: resetDepCheck }),
        ]),
    ]));

    const filterInput = ui.el('input', { className: 'ppt-input', placeholder: 'Filter results…', style: 'margin-bottom:8px' });
    const tableWrap = ui.el('div', { style: 'max-height:360px;overflow-y:auto;border:1px solid var(--border);border-radius:6px' });

    function renderTable(filter) {
        const table = ui.el('table', { className: 'sd-table' });
        table.appendChild(ui.el('thead', {}, [ui.el('tr', {},
            ['Required Component', 'Type', 'Solution', 'Depends On', 'Parent', 'Action'].map((h) =>
                ui.el('th', { textContent: h, style: h === 'Action' ? 'text-align:center' : '' })))]));
        const tbody = ui.el('tbody');
        const filterLower = (filter ?? '').toLowerCase();

        for (const mc of results) {
            const req = mc.RequiredComponent ?? {};
            const dep = mc.DependentComponent ?? {};
            const cells = [
                req.SchemaName || req.DisplayName || req.Id || '—',
                componentTypeLabel(req.Type),
                req.Solution || '—',
                dep.SchemaName || dep.DisplayName || dep.Id || '—',
                req.ParentSchemaName || req.ParentDisplayName || '—',
            ];
            if (filterLower && !cells.join(' ').toLowerCase().includes(filterLower)) continue;

            const addBtn = ui.el('button', { className: 'ppt-btn', style: 'font-size:11px;padding:2px 6px', textContent: '➕ Add', title: 'Add this component to the source solution' });
            addBtn.addEventListener('click', async () => {
                if (!req.Type) return;
                addBtn.disabled = true;
                addBtn.textContent = '⏳';
                try {
                    let compId = req.Id;
                    let compType = req.Type;
                    if (!isValidGuid(compId)) {
                        const resolved = await resolveMissingComponent(req, dep);
                        if (resolved && isValidGuid(resolved.id)) { compId = resolved.id; compType = resolved.type; }
                    }
                    if (!isValidGuid(compId)) throw new Error('Could not resolve valid GUID for this component.');
                    await addMissingComponentToSolution(compId, compType);
                    addBtn.textContent = '✅';
                    addBtn.title = 'Successfully added';
                } catch (e) {
                    addBtn.textContent = '❌';
                    addBtn.title = 'Error: ' + e.message;
                    addBtn.disabled = false;
                }
            });

            tbody.appendChild(ui.el('tr', {}, [
                ...cells.map((value, i) => ui.el('td', {
                    textContent: value, title: value,
                    style: i === 0 ? 'font-weight:600;color:#D13438' : '',
                })),
                ui.el('td', { style: 'text-align:center' }, [addBtn]),
            ]));
        }
        if (!tbody.children.length) {
            tbody.appendChild(ui.el('tr', {}, [ui.el('td', { colSpan: 6, style: 'padding:16px;text-align:center;color:var(--muted)', textContent: 'No matching results' })]));
        }
        table.appendChild(tbody);
        tableWrap.replaceChildren(table);
    }
    renderTable('');
    filterInput.addEventListener('input', () => renderTable(filterInput.value.trim()));
    container.append(filterInput, tableWrap);
    return container;
}

function renderCleanupForm() {
    const container = ui.el('div');
    container.append(ui.el('div', { className: 'sd-alert-info' }, [
        ui.el('strong', { textContent: 'Cleanup Mode. ' }),
        'Deletes the unmanaged solution from the target environment so it no longer shows up after deployment. Your customizations stay active and get overwritten by the next managed import (with "overwrite unmanaged customizations"). Use this after deploying the managed version.',
    ]));

    const targetInput = ui.el('input', { className: 'ppt-input', type: 'text', placeholder: 'https://yourorg.crm.dynamics.com', value: state.targetEnvUrl });
    targetInput.addEventListener('change', () => {
        state.targetEnvUrl = targetInput.value.replace(/\/+$/, '');
        renderPanel();
    });
    container.append(ui.el('span', { className: 'ppt-label', textContent: 'Target environment URL' }), targetInput,
        ui.el('div', { style: 'margin-top:12px' }),
        envQuickList((url) => {
            state.targetEnvUrl = url;
            renderPanel();
        }, state.targetEnvUrl));

    const solInput = ui.el('input', { className: 'ppt-input', type: 'text', placeholder: 'e.g. QuickDeploy_20260512', value: state.cleanupSolutionName });
    solInput.addEventListener('change', () => { state.cleanupSolutionName = solInput.value.trim(); });
    const fetchBtn = ui.el('button', { className: 'ppt-btn', style: 'margin-top:8px', textContent: '📦 Fetch solutions from target…' });
    fetchBtn.addEventListener('click', () => {
        if (!state.targetEnvUrl) { ui.toast('Enter target URL first.'); return; }
        solutionPicker('Select Solution to Clean Up',
            async () => (await targetApi(state.targetEnvUrl, '/solutions?$filter=ismanaged eq false and isvisible eq true&$select=solutionid,friendlyname,uniquename,version&$orderby=friendlyname asc')).value ?? [],
            (s) => { state.cleanupSolutionName = s.uniquename; renderPanel(); });
    });
    const layersCheckbox = ui.el('input', { type: 'checkbox', checked: state.cleanupRemoveLayers, style: 'margin-top:2px;accent-color:#D13438' });
    layersCheckbox.addEventListener('change', () => { state.cleanupRemoveLayers = layersCheckbox.checked; });
    const layersOption = ui.el('label', {
        style: 'display:flex;gap:8px;align-items:flex-start;margin-top:16px;padding:12px;border:1px solid var(--border);border-radius:6px;cursor:pointer',
    }, [
        layersCheckbox,
        ui.el('div', {}, [
            ui.el('div', { style: 'font-size:13px;font-weight:600', textContent: 'Also remove active customizations (unmanaged layers)' }),
            ui.el('div', {
                style: 'font-size:12px;color:var(--muted);margin-top:2px',
                textContent: 'Reverts every component to its managed state — only needed when you want to undo a change that broke something. Leave off for normal post-deployment cleanup.',
            }),
        ]),
    ]);

    container.append(
        ui.el('span', { className: 'ppt-label', textContent: 'Solution unique name' }),
        solInput, fetchBtn, layersOption,
    );
    return container;
}

function renderTargetSelection() {
    const container = ui.el('div');

    const input = ui.el('input', { className: 'ppt-input', type: 'text', placeholder: 'https://yourorg.crm.dynamics.com', value: state.targetEnvUrl });
    input.addEventListener('change', async () => {
        state.targetEnvUrl = input.value.replace(/\/+$/, '');
        await applyImpersonationForTarget();
        renderPanel();
    });
    container.append(
        ui.el('span', { className: 'ppt-label', textContent: 'Target environment URL' }),
        input,
        ui.el('div', { style: 'font-size:12px;color:var(--muted);margin:4px 0 16px', textContent: 'Make sure you are logged in to the target environment in another browser tab.' }),
        envQuickList(async (url) => {
            state.targetEnvUrl = url;
            await applyImpersonationForTarget();
            renderPanel();
        }, state.targetEnvUrl),
    );

    const nameInput = ui.el('input', { className: 'ppt-input', type: 'text', placeholder: 'Environment name (e.g. "Test")', style: 'margin-bottom:8px' });
    const urlInput = ui.el('input', { className: 'ppt-input', type: 'text', placeholder: 'https://yourorg-test.crm.dynamics.com', style: 'margin-bottom:8px' });
    container.append(ui.el('div', { style: 'border:1px solid var(--border);border-radius:6px;padding:12px;margin-top:12px' }, [
        ui.el('div', { style: 'font-size:13px;font-weight:600;margin-bottom:8px', textContent: 'Save a new target environment' }),
        nameInput, urlInput,
        ui.el('button', {
            className: 'ppt-btn', textContent: '+ Save environment',
            onclick: async () => {
                const name = nameInput.value.trim();
                const url = urlInput.value.trim().replace(/\/+$/, '');
                if (!name || !url) return;
                if (!state.savedTargets.some((t) => t.url === url)) {
                    state.savedTargets.push({ name, url });
                    await store.set('targetEnvironments', state.savedTargets);
                }
                renderPanel();
            },
        }),
    ]));

    const impSection = ui.el('div', { style: 'border:1px solid var(--border);border-radius:6px;padding:12px;margin-top:16px' }, [
        ui.el('div', { style: 'font-size:13px;font-weight:600;margin-bottom:4px', textContent: 'Import as another user (optional)' }),
        ui.el('div', { style: 'font-size:12px;color:var(--muted);margin-bottom:8px', textContent: 'MSCRMCallerID impersonation so imported components are owned by the selected user (e.g. a pipeline app user). Requires System Administrator.' }),
    ]);
    if (state.impersonateUserId) {
        impSection.append(ui.el('div', { className: 'sd-ok-box', style: 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;margin-bottom:0' }, [
            ui.el('span', { style: 'font-size:13px' }, [
                ui.el('strong', { style: 'color:#107C10', textContent: 'Importing as: ' }),
                state.impersonateUserName,
            ]),
            ui.el('button', {
                className: 'ppt-icon-btn', textContent: '✕', title: 'Clear impersonation',
                onclick: async () => {
                    state.impersonateUserId = '';
                    state.impersonateUserName = '';
                    if (state.targetEnvUrl) {
                        const map = await store.get('impersonationMap', {});
                        delete map[state.targetEnvUrl.toLowerCase()];
                        await store.set('impersonationMap', map);
                    }
                    renderPanel();
                },
            }),
        ]));
    } else {
        const impWrap = ui.el('div', { style: 'position:relative' });
        const impInput = ui.el('input', { className: 'ppt-input', type: 'text', placeholder: 'Search users on target by name or email…' });
        const impResults = ui.el('div', { className: 'sd-dropdown', style: 'display:none' });
        let impTimer = null;
        impInput.addEventListener('input', () => {
            clearTimeout(impTimer);
            impTimer = setTimeout(async () => {
                const term = impInput.value.trim();
                if (term.length < 2 || !state.targetEnvUrl) { impResults.style.display = 'none'; return; }
                impResults.replaceChildren(ui.el('div', { style: 'padding:10px 12px;font-size:13px;color:var(--muted)', textContent: 'Searching…' }));
                impResults.style.display = 'block';
                try {
                    const data = await targetApi(state.targetEnvUrl,
                        `/systemusers?$filter=isdisabled eq false and (contains(fullname,'${odataQuote(term)}') or contains(internalemailaddress,'${odataQuote(term)}'))&$select=systemuserid,fullname,internalemailaddress&$top=15&$orderby=fullname asc`);
                    const users = data.value ?? [];
                    impResults.replaceChildren(...(users.length
                        ? users.map((u) => {
                            const item = ui.el('div', { className: 'sd-item' }, [
                                ui.el('strong', { textContent: u.fullname }),
                                ui.el('span', { style: 'color:var(--muted);font-size:11px', textContent: ` ${u.internalemailaddress ?? ''}` }),
                            ]);
                            item.addEventListener('click', async () => {
                                state.impersonateUserId = u.systemuserid;
                                state.impersonateUserName = u.fullname;
                                const map = await store.get('impersonationMap', {});
                                map[state.targetEnvUrl.toLowerCase()] = { id: u.systemuserid, name: u.fullname, email: u.internalemailaddress ?? '' };
                                await store.set('impersonationMap', map);
                                renderPanel();
                            });
                            return item;
                        })
                        : [ui.el('div', { style: 'padding:10px 12px;font-size:13px;color:var(--muted)', textContent: 'No users found' })]));
                } catch (e) {
                    impResults.replaceChildren(ui.el('div', { style: 'padding:10px 12px;font-size:13px;color:#D13438', textContent: `Error: ${e.message}` }));
                }
            }, 350);
        });
        impInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') impResults.style.display = 'none'; });
        impWrap.append(impInput, impResults);
        impSection.append(impWrap);
        if (!state.targetEnvUrl) {
            impSection.append(ui.el('div', { style: 'font-size:12px;color:var(--muted);margin-top:6px', textContent: 'Enter a target URL above first, then search for users.' }));
        }
    }
    container.append(impSection);

    container.append(ui.el('div', { className: 'sd-alert-info', style: 'margin-top:16px;margin-bottom:0' }, [
        ui.el('strong', { textContent: 'Deploy Summary. ' }),
        `Solution "${state.deployMode === 'existing' ? (state.existingSolutionDisplayName || state.existingSolutionName) : state.newSolutionDisplayName}" will be exported and imported into the target environment. The solution is kept on source for reuse.`,
    ]));
    return container;
}

function renderProgress() {
    const container = ui.el('div');
    const statusStyles = {
        running: 'color:var(--accent);background:var(--bg2);border:1px solid var(--border)',
        success: 'color:#107C10;background:rgba(16,124,16,0.12);border:1px solid #A7E3A5',
        error: 'color:#D13438;background:rgba(209,52,56,0.12);border:1px solid #F1BBBC',
    };
    const statusLabels = { running: '⏳ In Progress…', success: '✅ Complete', error: '❌ Failed' };
    container.append(ui.el('div', {
        style: `padding:12px 16px;border-radius:6px;font-size:14px;font-weight:600;margin-bottom:12px;${statusStyles[state.progressStatus] ?? ''}`,
        textContent: statusLabels[state.progressStatus] ?? 'Processing…',
    }));

    if (state.progressStatus === 'running') {
        const solutionDisplay = state.mode === 'cleanup'
            ? state.cleanupSolutionName
            : state.deployMode === 'existing'
                ? (state.existingSolutionDisplayName || state.existingSolutionName || 'Solution')
                : (state.newSolutionDisplayName || state.newSolutionUniqueName || 'Solution');
        els.elapsed = ui.el('div', { style: 'font-size:12px;color:var(--muted);white-space:nowrap', textContent: `⏱ ${formatDuration(state.importStartTime ? Date.now() - state.importStartTime : 0)}` });
        els.progressBar = ui.el('div');
        els.progressLabel = ui.el('div', { style: 'font-size:13px;font-weight:600;color:var(--accent)' });

        let targetHost = '';
        try { targetHost = `→ ${new URL(state.targetEnvUrl).hostname}`; } catch { /* no target url */ }

        container.append(ui.el('div', { style: 'border:1px solid var(--border);background:var(--bg);border-radius:8px;padding:16px;margin-bottom:16px' }, [
            ui.el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px' }, [
                ui.el('div', { style: 'display:flex;align-items:center;gap:8px;min-width:0' }, [
                    state.publishing
                        ? ui.el('span', { style: 'color:#107C10;font-size:14px', textContent: '✓' })
                        : ui.el('span', { className: 'sd-spinner', style: 'width:14px;height:14px;border-width:2px' }),
                    ui.el('div', { style: 'font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', textContent: solutionDisplay }),
                ]),
                els.elapsed,
            ]),
            ui.el('div', { style: 'height:8px;background:var(--border);border-radius:4px;overflow:hidden;margin-bottom:8px;position:relative' }, [els.progressBar]),
            ui.el('div', { style: 'display:flex;align-items:center;justify-content:space-between' }, [
                els.progressLabel,
                ui.el('div', { style: 'font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-left:12px', textContent: targetHost }),
            ]),
        ]));
        updateProgressBar(state.importProgress);
        clearInterval(state.importElapsedInterval);
        state.importElapsedInterval = setInterval(updateElapsedLabel, 1000);
    }

    els.log = ui.el('div', { style: 'overflow-y:auto;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:8px;min-height:200px;max-height:400px' });
    for (const entry of state.progressLog) {
        els.log.appendChild(ui.el('div', {
            textContent: `[${entry.time.toLocaleTimeString()}] ${entry.message}`,
            style: `padding:4px 8px;font-size:12px;border-radius:4px;margin-bottom:2px;font-family:Consolas,monospace;word-break:break-word;${LOG_STYLES[entry.level] ?? ''}`,
        }));
    }
    container.append(ui.el('span', { className: 'ppt-label', textContent: 'Activity log' }), els.log);
    els.log.scrollTop = els.log.scrollHeight;
    return container;
}

function renderFooter() {
    const footer = ui.el('div', { className: 'sd-footer' });

    if (state.step === 'select') {
        footer.append(ui.el('button', { className: 'ppt-btn', textContent: 'Cancel', onclick: closePanel }));
        if (state.mode === 'deploy') {
            const ready = state.deployMode === 'new' ? state.newSolutionReady : !!state.existingSolutionName;
            footer.append(ui.el('button', {
                className: 'ppt-btn primary', textContent: 'Next: Choose Target →', disabled: !ready,
                onclick: () => { state.step = 'target'; renderPanel(); },
            }));
        } else if (state.mode === 'dependencies') {
            if (state.depCheckStatus === 'done' && state.depCheckResults?.length === 0 && !state.depCheckError) {
                footer.append(ui.el('button', {
                    className: 'sd-btn-success', textContent: '🚀 Deploy Now',
                    onclick: async () => {
                        Object.assign(state, {
                            mode: 'deploy', deployMode: 'existing', step: 'target',
                            existingSolutionName: state.depCheckSolutionName,
                            existingSolutionDisplayName: state.depCheckSolutionDisplayName,
                            targetEnvUrl: state.depCheckTargetUrl,
                        });
                        await applyImpersonationForTarget();
                        renderPanel();
                    },
                }));
            }
            footer.append(ui.el('button', {
                className: 'ppt-btn primary',
                textContent: state.depCheckStatus === 'running' ? '⏳ Checking…' : '🔍 Check Dependencies',
                disabled: !state.depCheckSolutionName || !state.depCheckTargetUrl || state.depCheckStatus === 'running',
                onclick: () => runDependencyCheck(),
            }));
        } else {
            footer.append(ui.el('button', {
                className: 'sd-btn-danger', textContent: '🧹 Run Cleanup',
                disabled: !state.cleanupSolutionName || !state.targetEnvUrl,
                onclick: async () => {
                    if (!(await showCleanupConfirmation())) return;
                    state.step = 'progress';
                    runCleanupPipeline();
                },
            }));
        }
    } else if (state.step === 'target') {
        footer.append(
            ui.el('button', { className: 'ppt-btn', textContent: '← Back', onclick: () => { state.step = 'select'; renderPanel(); } }),
            ui.el('button', {
                className: 'sd-btn-success', textContent: '🚀 Deploy Now', disabled: !state.targetEnvUrl,
                onclick: async () => {
                    if (!state.targetEnvUrl || !(await showDeployConfirmation())) return;
                    state.step = 'progress';
                    renderPanel();
                    runDeployPipeline();
                },
            }),
        );
    } else {
        footer.append(ui.el('button', {
            className: 'ppt-btn',
            textContent: state.progressStatus === 'running' ? 'Running…' : 'Close',
            disabled: state.progressStatus === 'running',
            onclick: closePanel,
        }));
        if (state.progressStatus === 'success' || state.progressStatus === 'error') {
            footer.append(ui.el('button', {
                className: 'ppt-btn primary', textContent: '🔄 New Deployment',
                onclick: async () => { await resetState(); renderPanel(); },
            }));
        }
        if (state.mode === 'deploy' && state.progressStatus === 'success' && state.solutionName) {
            const offCount = state.flowCheck?.off.length ?? 0;
            footer.append(ui.el('button', {
                className: offCount ? 'ppt-btn primary' : 'ppt-btn',
                textContent: offCount ? `⚡ Check Flows (${offCount} off)` : '⚡ Check Flows',
                title: offCount
                    ? `${offCount} cloud flow(s) are turned off on the target — open Cloud Flow Manager to enable them`
                    : 'Open Cloud Flow Manager on the target to check that flows are enabled',
                onclick: openFlowManagerOnTarget,
            }));
        }
        if (state.mode === 'deploy' && state.progressStatus === 'success') {
            const ribbonBtn = ui.el('button', { className: 'ppt-btn', textContent: '🎀 Generate Ribbons', title: 'Regenerate ribbon metadata on the target environment' });
            ribbonBtn.addEventListener('click', async () => {
                const impersonateId = cleanGuid(state.impersonateUserId || '');
                ribbonBtn.disabled = true;
                ribbonBtn.textContent = 'Requesting…';
                addLog('info', 'Requesting ribbon metadata regeneration on target…');
                try {
                    await targetApi(state.targetEnvUrl, '/RegenerateRibbonMetadataForAllEntities', {
                        method: 'POST',
                        headers: impersonateId ? { MSCRMCallerID: impersonateId } : {},
                    });
                    addLog('success', '🎀 Ribbon regeneration started. This background operation can take 15+ minutes; check Solution History on the target.');
                    ribbonBtn.textContent = '✅ Ribbon Regen Started';
                } catch (e) {
                    addLog('error', `Ribbon metadata regeneration failed: ${e.message}`);
                    ribbonBtn.disabled = false;
                    ribbonBtn.textContent = '🎀 Generate Ribbons';
                }
            });
            footer.append(ribbonBtn);
        }
        if (state.mode === 'cleanup' && state.progressStatus === 'success' && state.cleanupSolutionName) {
            const deleteBtn = ui.el('button', { className: 'sd-btn-danger', textContent: '🗑️ Delete from Source' });
            deleteBtn.addEventListener('click', async () => {
                const ok = await ui.confirmDialog(
                    `Delete solution "${state.cleanupSolutionName}" from the SOURCE environment (${location.origin})? This cannot be undone.`,
                    { title: 'Delete from source', okLabel: 'Delete' });
                if (!ok) return;
                deleteBtn.disabled = true;
                deleteBtn.textContent = 'Deleting…';
                try {
                    const solutions = await dv.get(`/solutions?$filter=uniquename eq '${odataQuote(state.cleanupSolutionName)}'&$select=solutionid`);
                    const sol = solutions.value?.[0];
                    if (!sol) throw new Error(`Solution '${state.cleanupSolutionName}' not found.`);
                    await dv.delete('solutions', sol.solutionid);
                    addLog('success', `Solution "${state.cleanupSolutionName}" deleted from source.`);
                    deleteBtn.textContent = '✅ Deleted';
                } catch (e) {
                    addLog('error', `Failed to delete from source: ${e.message}`);
                    deleteBtn.disabled = false;
                    deleteBtn.textContent = '🗑️ Delete from Source';
                }
            });
            footer.append(deleteBtn);
        }
    }
    return footer;
}

export default {
    init({ store: toolStore }) {
        dv = new Dataverse();
        store = toolStore;
        ui.addStyle('sd', STYLE);
        commands.register({ toolId: 'solution-deployer', title: 'Open Solution Deployer', icon: '🚀', run: openDeployer });
    },
};
