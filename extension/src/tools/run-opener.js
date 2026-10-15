// Run Page Actions (native).
// Adds "Run tree", "Open run", "Re-run" and "Download" buttons to the Power
// Automate run page toolbar:
//   Run tree — shows the whole chain of connected runs (topmost trigger run
//              down to the deepest child runs) via the environment's Dataverse
//              flowruns table; every node opens that actual run.
//   Open run — extracts the child-flow id + run id from the raw inputs/outputs
//              panels and opens that run directly (or, for Canvas App
//              triggers, shows who/what triggered the flow).
//   Re-run   — captures the child-flow action inputs, opens the flow's details
//              page and auto-fills the Run panel with them.
//   Download — saves the captured parameters as JSON plus any file inputs.
//
// Network captures use the page agent's on-demand fetch/XHR interception
// (src/core/agent.js) since the isolated world cannot see the page's calls.

import { interceptNetwork } from '../core/agent.js';
import { createStore } from '../core/storage.js';
import { Dataverse } from '../core/dataverse.js';
import * as ui from '../core/ui.js';
import * as commands from '../core/commands.js';
import { fetchRunByName, showConnectedRunsDialog } from './shared/run-tree.js';
import { fetchCanvasAppNames, buildCanvasOriginResolver, resolveCanvasAppsForFlow } from './shared/canvas-apps.js';

const INTERCEPT_PATTERNS = [
    '/contents/ActionInputs', '/contents/ActionOutputs',
    '/contents/TriggerInputs', '/contents/TriggerOutputs',
];

let store;

// ── Generic helpers ───────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForElement(finder, timeout = 5000, interval = 50) {
    const immediate = finder();
    if (immediate) return immediate;
    const start = Date.now();
    while (Date.now() - start < timeout) {
        await sleep(interval);
        const found = finder();
        if (found) return found;
    }
    return null;
}

const findSpan = (text) => [...document.querySelectorAll('span')].find((s) => s.textContent === text);
const findSpanTrim = (text) => [...document.querySelectorAll('span')].find((s) => s.textContent.trim() === text);

function spanValueAfter(keySpan) {
    return keySpan?.nextElementSibling?.nextElementSibling?.textContent.slice(1, -1);
}

async function closePanel() {
    const button = await waitForElement(() => document.querySelector('button[title="Close"]'), 3000);
    button?.click();
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

// File params arrive as { name, contentBytes: base64 | { $content, $content-type } }
function fileParamToBlob(value) {
    let content = value.contentBytes;
    let contentType = value['$content-type'] ?? 'application/octet-stream';
    if (content && typeof content === 'object') {
        if (content['$content-type']) contentType = content['$content-type'];
        if (content['$content']) content = content['$content'];
    }
    content = content || '';
    try {
        const binary = atob(content);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: contentType });
    } catch {
        return new Blob([content], { type: contentType });
    }
}

function extractBodyParams(captured) {
    if (!captured) return {};
    if (captured.body && Object.keys(captured.body).length > 0) return captured.body;
    if (captured.host) {
        const { host, ...rest } = captured;
        return rest;
    }
    return {};
}

// Parameter type detection by manual-trigger property naming (text, text_1, …)
const isFileParam = ([k, v]) => /^file(_\d+)?$/i.test(k) || (typeof v === 'object' && v !== null && v.name);
const isBoolParam = ([k, v]) => /^boolean(_\d+)?$/i.test(k) || typeof v === 'boolean';
const isEmailParam = ([k]) => /^email(_\d+)?$/i.test(k);
const isTextParam = (entry) => !isFileParam(entry) && !isBoolParam(entry) && !isEmailParam(entry);

// ── Canvas App trigger details dialog ─────────────────────────────────────
function showCanvasAppDialog(info) {
    let formattedTime = info.timestamp;
    try {
        if (info.timestamp && info.timestamp !== 'Unknown') formattedTime = new Date(info.timestamp).toLocaleString();
    } catch { /* keep original */ }

    let playUrl = '';
    if (info.appId !== 'Unknown' && info.envId !== 'Unknown') {
        playUrl = `https://apps.powerapps.com/play/e/${info.envId}/a/${info.appId}?${info.tenantId !== 'Unknown' ? `tenantId=${info.tenantId}&` : ''}source=portal`;
    } else if (info.appId !== 'Unknown') {
        playUrl = `https://apps.powerapps.com/play/${info.appId}?source=portal`;
    }

    const field = (label, value, mono = false) => ui.el('div', { style: 'margin-bottom:12px' }, [
        ui.el('div', { className: 'ppt-label', style: 'margin:0 0 4px', textContent: label }),
        ui.el('div', {
            textContent: value,
            style: mono ? 'font-family:Consolas,monospace;font-size:13px;word-break:break-all;background:var(--bg2);padding:6px 8px;border-radius:4px' : 'font-size:14px',
        }),
    ]);

    const details = `Canvas App Trigger Details
━━━━━━━━━━━━━━━━━━━━━━━━━━━${info.appName ? `\nApp Name: ${info.appName}` : ''}
Triggered By: ${info.userName}
Email: ${info.userEmail}
Timestamp: ${formattedTime}
Region: ${info.region}

App ID: ${info.appId}
Environment ID: ${info.envId}
Tenant ID: ${info.tenantId}
User ID: ${info.userId}
Session ID: ${info.sessionId}${playUrl ? `\n\nApp URL: ${playUrl}` : ''}`;

    ui.modal({
        title: 'Canvas App Trigger Details',
        render: (body) => {
            body.append(
                ...(info.appName ? [field('App name', info.appName)] : []),
                ...(info.appNote ? [ui.el('div', { className: 'ppt-note', textContent: `ℹ️ ${info.appNote}` })] : []),
                field('Triggered by', `${info.userName} (${info.userEmail})`),
                field('Timestamp', formattedTime),
                field('Region', info.region),
                field('App ID', info.appId, true),
                field('Environment ID', info.envId, true),
                field('User ID', info.userId, true),
                field('Session ID', info.sessionId, true),
            );
        },
        buttons: [
            ...(playUrl ? [{ label: 'Open App', primary: true, onClick: () => window.open(playUrl, '_blank') }] : []),
            { label: 'Copy Details', onClick: () => navigator.clipboard.writeText(details).then(() => ui.toast('📋 Details copied')) },
            { label: 'Close', onClick: (close) => close() },
        ],
    });
}

// Resolve the triggering app's display name. The display name lives in the
// environment's canvasapps table. Quiet lookup — never prompts for an org URL
// just to decorate the dialog.
//   1. header app id → canvasapps (works for non-solution apps, whose header
//      carries the canvasappid GUID);
//   2. fallback: the flow's canvas-app dependencies — the same path the run
//      tree uses, which resolves SOLUTION apps whose header carries only a
//      logical name (extracted as 'Unknown').
// The dependency lookup needs the Dataverse workflowid, NOT the /flows/{id}
// segment from the URL (that's the flow's name — a different GUID). So resolve
// it from the run record via runId, exactly as the run tree does.
// Returns { name, id, note }: id may upgrade 'Unknown' to the resolved
// canvasappid; note flags the ambiguous multi-app case.
async function resolveCanvasAppName(appId, headerEnvId, runId) {
    const envId = (headerEnvId && headerEnvId !== 'Unknown' ? headerEnvId.toLowerCase() : null)
        ?? extractRunIds().envId;
    try {
        const orgUrl = await resolveOrgUrlQuiet(envId);
        if (!orgUrl) return { name: null, id: appId };
        const apiGet = (path) => new Dataverse(orgUrl).get(path);

        if (appId && appId !== 'Unknown') {
            const names = await fetchCanvasAppNames(apiGet, [appId]);
            const name = names.get(appId.toLowerCase());
            if (name) return { name, id: appId };
        }

        const workflowId = runId ? (await fetchRunByName(apiGet, runId).catch(() => null))?._workflow_value : null;
        if (workflowId) {
            const apps = await resolveCanvasAppsForFlow(apiGet, workflowId);
            const hit = apps.find((app) => app.name) ?? apps[0];
            if (hit?.name) {
                return {
                    name: hit.name,
                    id: appId && appId !== 'Unknown' ? appId : hit.id,
                    note: apps.length > 1
                        ? 'One of several apps using this flow — the exact trigger app isn’t recorded on this run.'
                        : null,
                };
            }
        }
        return { name: null, id: appId };
    } catch (e) {
        console.warn('[Run Page Actions] canvas app name lookup failed:', e);
        return { name: null, id: appId };
    }
}

// ── "Open run": jump to the child flow's run ──────────────────────────────
async function executeOpenRun() {
    const interception = interceptNetwork(INTERCEPT_PATTERNS);
    try {
        const rawInput = await waitForElement(() => findSpanTrim('Show raw inputs'));
        if (!rawInput) { ui.toast('⚠️ "Show raw inputs" not found — select a child-flow action first.'); return; }
        rawInput.click();

        // Wait for either a schema trigger or a child-flow reference to render
        const keys = await waitForElement(() => {
            const schemaKey = findSpan('"schema"');
            const workflowKey = findSpan('"workflowReferenceName"');
            return schemaKey || workflowKey ? { schemaKey, workflowKey } : null;
        }, 10000);

        let flowId;
        let runId;

        if (keys?.schemaKey) {
            // Schema trigger: the ids (and Canvas App headers) live in raw OUTPUTS
            await closePanel();
            interception.clear();

            const rawOutput = await waitForElement(() => findSpanTrim('Show raw outputs'));
            if (!rawOutput) { ui.toast('⚠️ "Show raw outputs" not found.'); return; }
            rawOutput.click();

            const captured = await interception.waitForCapture(5000);
            const headers = captured?.headers ?? {};
            const appIdHeader = headers['x-ms-client-app-id'] ?? '';

            if (appIdHeader.includes('/providers/Microsoft.PowerApps/apps/')) {
                await closePanel();
                const info = {
                    appId: appIdHeader.match(/\/providers\/Microsoft\.PowerApps\/apps\/([a-f0-9-]+)/i)?.[1] ?? 'Unknown',
                    envId: (headers['x-ms-client-environment-id'] ?? '').match(/\/providers\/Microsoft\.PowerApps\/environments\/([a-f0-9-]+)/i)?.[1] ?? 'Unknown',
                    tenantId: headers['x-ms-client-tenant-id'] ?? headers['x-ms-tenant-id'] ?? 'Unknown',
                    userName: headers['x-ms-user-name'] ?? 'Unknown',
                    userEmail: headers['x-ms-user-email'] ?? 'Unknown',
                    userId: headers['x-ms-user-id'] ?? headers['x-ms-client-object-id'] ?? 'Unknown',
                    timestamp: headers['x-ms-user-timestamp'] ?? 'Unknown',
                    sessionId: headers['x-ms-client-session-id'] ?? 'Unknown',
                    region: headers['x-ms-client-region'] ?? 'Unknown',
                };
                const resolved = await resolveCanvasAppName(info.appId, info.envId, extractRunIds().runId);
                info.appName = resolved.name;
                info.appId = resolved.id ?? info.appId;
                info.appNote = resolved.note ?? null;
                showCanvasAppDialog(info);
                return;
            }

            // Not a Canvas App: read the workflow name/run id from the rendered outputs
            const nameKey = await waitForElement(() => findSpan('"x-ms-workflow-name"'));
            flowId = spanValueAfter(nameKey);
            const runKey = await waitForElement(() => findSpan('"x-ms-workflow-run-id"'));
            runId = spanValueAfter(runKey);
            await closePanel();
        } else if (keys?.workflowKey) {
            // Child flow action: flow id from inputs, run id from outputs
            flowId = spanValueAfter(keys.workflowKey);
            await closePanel();

            const rawOutput = await waitForElement(() => findSpanTrim('Show raw outputs'));
            if (!rawOutput) { ui.toast('⚠️ "Show raw outputs" not found.'); return; }
            rawOutput.click();

            const runKey = await waitForElement(() => findSpan('"x-ms-workflow-run-id"'));
            runId = spanValueAfter(runKey);
            await closePanel();
        } else {
            ui.toast('⚠️ No child-flow reference or trigger schema found in this action.');
            return;
        }

        if (flowId && runId) {
            window.open(`${location.href.split('/flows/')[0]}/flows/${flowId}/runs/${runId}`, '_blank');
        } else {
            ui.toast('⚠️ Could not extract flow/run ids.');
        }
    } finally {
        interception.stop();
    }
}

// ── "Run tree": the full chain of connected runs around the current run ───
const ANNOTATIONS = { Prefer: 'odata.include-annotations="*"' };

function extractRunIds() {
    // [^/]+ instead of a GUID pattern: default environments are "Default-{guid}"
    const envIdRaw = location.href.match(/\/environments\/([^/]+)\//i)?.[1] ?? null;
    return {
        envIdRaw, // original casing, for play URLs
        envId: envIdRaw?.toLowerCase() ?? null, // cache keys
        runId: location.href.match(/\/runs\/([^/?#]+)/i)?.[1] ?? null,
    };
}

// Same resolution chain as the Expression Validator: own cache → the
// Environment Indicator's host↔envId mapping → (non-quiet only) ask the user.
async function resolveOrgUrlQuiet(envId) {
    if (!envId) return null;
    const cache = await store.get('orgUrlCache', {});
    if (cache[envId]) return cache[envId];

    const hostCache = await createStore('environment-indicator').get('envIndicator_hostCache', {});
    const host = Object.entries(hostCache).find(([, id]) => id === envId)?.[0];
    if (!host) return null;
    cache[envId] = `https://${host}`;
    await store.set('orgUrlCache', cache);
    return cache[envId];
}

async function resolveOrgUrl(envId) {
    const known = await resolveOrgUrlQuiet(envId);
    if (known) return known;

    return new Promise((resolve) => {
        const input = ui.el('input', { className: 'ppt-input', type: 'url', placeholder: 'https://yourorg.crm.dynamics.com' });
        let saved = null;
        const close = ui.modal({
            title: '🔀 Dynamics 365 URL',
            render: (body) => {
                body.append(
                    ui.el('div', { className: 'ppt-note', textContent: 'Enter the Dynamics 365 URL of this environment so the run tree can be read from its flowruns table. Remembered locally for next time.' }),
                    input,
                );
                input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
                setTimeout(() => input.focus(), 0);
            },
            buttons: [
                { label: 'Cancel', onClick: (c) => c() },
                { label: 'Continue', primary: true, onClick: () => save() },
            ],
            onClose: () => resolve(saved),
        });
        async function save() {
            let url = input.value.trim();
            if (url && !url.startsWith('https://')) url = 'https://' + url;
            if (!/\.dynamics\.com/i.test(url)) { ui.toast('⚠️ Enter a *.dynamics.com URL'); return; }
            saved = url.replace(/\/$/, '').split('/main.aspx')[0];
            if (envId) {
                const updated = await store.get('orgUrlCache', {});
                updated[envId] = saved;
                await store.set('orgUrlCache', updated);
            }
            close();
        }
    });
}

// A fresh browser has no Dataverse session for the environment's org yet, so
// the first cross-origin flowruns call 401s. The org URL is correct — the user
// just needs to open it once to sign in. Guide them, keep the cached URL.
function promptDynamicsSignIn(orgUrl, onRetry) {
    let host = orgUrl;
    try { host = new URL(orgUrl).host; } catch { /* keep raw */ }
    ui.modal({
        title: '🔐 Sign in to the environment',
        render: (body) => body.append(ui.el('div', { className: 'ppt-note', textContent:
            `The run tree reads this environment's Dataverse (${host}), but your browser isn't signed in to it yet. This often happens the first time you use the run tree after opening the browser. Open the environment once to sign in, then retry.` })),
        buttons: [
            { label: `Open ${host} ↗`, primary: true, onClick: () => window.open(orgUrl, '_blank') },
            { label: 'Retry', onClick: (close) => { close(); onRetry(); } },
            { label: 'Close', onClick: (close) => close() },
        ],
    });
}

async function executeRunTree() {
    const { envId, envIdRaw, runId } = extractRunIds();
    if (!runId) { ui.toast('⚠️ This works on flow run pages — open a run first.'); return; }

    const orgUrl = await resolveOrgUrl(envId);
    if (!orgUrl) return;

    const dv = new Dataverse(orgUrl);
    const apiGet = (path) => dv.get(path, ANNOTATIONS);

    let run;
    try {
        run = await fetchRunByName(apiGet, runId);
    } catch (e) {
        // 401/403: the org URL is correct, the browser just isn't signed in to
        // this environment's Dataverse yet. Keep the cached URL; guide the user.
        if (e.status === 401 || e.status === 403) {
            promptDynamicsSignIn(orgUrl, executeRunTree);
            return;
        }
        // A wrong/stale org URL is the usual cause — drop it so the next try re-asks
        if (envId) {
            const cache = await store.get('orgUrlCache', {});
            delete cache[envId];
            await store.set('orgUrlCache', cache);
        }
        ui.toast(`⚠️ Could not query the flowruns table: ${e.message}`);
        return;
    }
    if (!run) { ui.toast('⚠️ This run was not found in the environment\'s flowruns table.'); return; }

    const baseUrl = location.href.split('/flows/')[0];
    showConnectedRunsDialog({
        startRun: run,
        apiGet,
        openRun: (r) => window.open(`${baseUrl}/flows/${r._workflow_value}/runs/${r.name}?v3=true`, '_blank'),
        resolveOrigin: buildCanvasOriginResolver(
            apiGet,
            (appId) => (envIdRaw ? `https://apps.powerapps.com/play/e/${envIdRaw}/a/${appId}?source=portal` : null),
        ),
    });
}

// ── "Re-run": open details page with captured inputs, auto-fill Run panel ─
async function executeReRun() {
    const interception = interceptNetwork(INTERCEPT_PATTERNS);
    try {
        const rawInput = await waitForElement(() => findSpanTrim('Show raw inputs'));
        if (!rawInput) { ui.toast('⚠️ "Show raw inputs" not found — select a child-flow action first.'); return; }
        rawInput.click();

        const workflowKey = await waitForElement(() => findSpan('"workflowReferenceName"'));
        if (!workflowKey) { ui.toast('⚠️ Re-run only works on child-flow actions.'); await closePanel(); return; }
        const flowId = spanValueAfter(workflowKey);

        const captured = await interception.waitForCapture(5000);
        const bodyParams = extractBodyParams(captured);
        await closePanel();

        if (!flowId) { ui.toast('⚠️ Could not extract the flow id.'); return; }
        await store.set(`autorun_${flowId}`, JSON.stringify(bodyParams));
        window.open(`${location.href.split('/flows/')[0]}/flows/${flowId}/details`, '_blank');
    } finally {
        interception.stop();
    }
}

// ── "Download": save parameters + files from a child-flow action ──────────
async function executeDownload() {
    const interception = interceptNetwork(INTERCEPT_PATTERNS);
    try {
        const rawInput = await waitForElement(() => findSpanTrim('Show raw inputs'));
        if (!rawInput) { ui.toast('⚠️ "Show raw inputs" not found — select a child-flow action first.'); return; }
        rawInput.click();

        const workflowKey = await waitForElement(() => findSpan('"workflowReferenceName"'));
        if (!workflowKey) { ui.toast('⚠️ Download only works on child-flow actions.'); await closePanel(); return; }
        const flowId = spanValueAfter(workflowKey) ?? 'unknown';

        const captured = await interception.waitForCapture(5000);
        const bodyParams = extractBodyParams(captured);
        await closePanel();
        if (!Object.keys(bodyParams).length) { ui.toast('⚠️ No parameters captured.'); return; }

        const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
        const baseFilename = `${flowId.substring(0, 20)}_${timestamp}`;

        const entries = Object.entries(bodyParams);
        const fileParams = entries.filter(isFileParam);

        const paramsForJson = Object.fromEntries(entries.map(([key, value]) => [
            key,
            isFileParam([key, value])
                ? { name: value.name, hasContent: true, note: 'File downloaded separately' }
                : value,
        ]));
        downloadBlob(new Blob([JSON.stringify(paramsForJson, null, 2)], { type: 'application/json' }), `${baseFilename}_params.json`);

        for (const [key, value] of fileParams) {
            try {
                downloadBlob(fileParamToBlob(value), value.name || `${key}_file`);
                await sleep(200);
            } catch (e) {
                console.warn(`[Run Page Actions] could not download file ${key}:`, e);
            }
        }
        ui.toast(`⬇ Downloaded parameters${fileParams.length ? ` + ${fileParams.length} file(s)` : ''}`);
    } finally {
        interception.stop();
    }
}

// ── Auto-run on the details page (fills the Run panel) ────────────────────
async function checkAutoRunOnDetailsPage() {
    if (!location.href.includes('/details')) return;
    const flowId = location.href.match(/\/flows\/([^/]+)\/details/)?.[1];
    if (!flowId) return;

    const storageKey = `autorun_${flowId}`;
    const storedParams = await store.get(storageKey, null);
    if (!storedParams) return;
    await store.remove(storageKey); // one shot — never re-trigger

    await sleep(2000);
    try {
        const bodyParams = JSON.parse(storedParams);

        const runButton = await waitForElement(
            () => document.querySelector('button[data-automation-id="flowCommand-run"]'), 15000);
        if (!runButton) return;
        runButton.click();

        const panel = await waitForElement(() => document.querySelector('.ms-Panel-main'), 10000);
        if (!panel) return;

        const paramEntries = Object.entries(bodyParams);
        const byName = (a, b) => a[0].localeCompare(b[0]);
        const textParams = paramEntries.filter(isTextParam).sort(byName);
        const booleanParams = paramEntries.filter(isBoolParam).sort(byName);
        const fileParams = paramEntries.filter(isFileParam).sort(byName);
        const emailParams = paramEntries.filter(isEmailParam).sort(byName);

        await waitForElement(
            () => (panel.querySelectorAll('textarea.ms-TextField-field').length >= textParams.length ? true : null),
            10000, 200);
        await sleep(500); // let React settle

        // The Run panel renders inputs in order: text → boolean → file → email
        const allTextInputs = [...panel.querySelectorAll('textarea.ms-TextField-field')];
        const allToggles = [...panel.querySelectorAll('button[role="switch"]')];
        const allFileInputs = [...panel.querySelectorAll('input[type="file"]')];
        const allEmailInputs = [...panel.querySelectorAll('input.ms-BasePicker-input')];

        const setNativeValue = (input, value) => {
            const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(input, value);
            else input.value = value;
            input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: value }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        };

        for (let i = 0; i < textParams.length && i < allTextInputs.length; i++) {
            allTextInputs[i].focus();
            setNativeValue(allTextInputs[i], String(textParams[i][1]));
            await sleep(50);
        }

        for (let i = 0; i < booleanParams.length && i < allToggles.length; i++) {
            const shouldBeChecked = booleanParams[i][1];
            if ((allToggles[i].getAttribute('aria-checked') === 'true') !== shouldBeChecked) allToggles[i].click();
            await sleep(50);
        }

        for (let i = 0; i < fileParams.length && i < allFileInputs.length; i++) {
            const [, value] = fileParams[i];
            try {
                const contentType = value['$content-type']
                    ?? (typeof value.contentBytes === 'object' ? value.contentBytes?.['$content-type'] : null)
                    ?? 'application/octet-stream';
                const file = new File([fileParamToBlob(value)], value.name, { type: contentType });
                const dataTransfer = new DataTransfer();
                dataTransfer.items.add(file);
                allFileInputs[i].files = dataTransfer.files;
                allFileInputs[i].dispatchEvent(new Event('change', { bubbles: true }));
                allFileInputs[i].dispatchEvent(new Event('input', { bubbles: true }));
            } catch (e) {
                console.warn('[Run Page Actions] could not set file input:', e);
            }
            await sleep(50);
        }

        // Email pickers: type the address and confirm with Enter
        for (let i = 0; i < emailParams.length && i < allEmailInputs.length; i++) {
            const input = allEmailInputs[i];
            const value = String(emailParams[i][1]);
            input.focus();
            await sleep(100);
            setNativeValue(input, value);
            await sleep(300);
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            await sleep(200);
        }

        ui.toast('▶ Run panel pre-filled from the captured parameters. Review and hit Run.');
    } catch (e) {
        console.error('[Run Page Actions] auto-run failed:', e);
    }
}

// ── Toolbar button injection ──────────────────────────────────────────────
let injectionTimer = null;
let observer = null;
let lastUrl = null; // set when the observer starts — modules stay side-effect free at load

function queueButtonInjection(delay = 500) {
    if (injectionTimer) return;
    injectionTimer = setTimeout(() => {
        injectionTimer = null;
        addRunButtons();
    }, delay);
}

// The analysis buttons only make sense on an actual run page
// (/flows/{id}/runs/{runId}). The flow details page (/flows/{id}/details) and
// the designer share the same toolbar, but there's no run to analyse there.
const RUN_PAGE_RE = /\/flows\/[^/]+\/runs\/[^/?#]+/i;
const isRunPage = () => RUN_PAGE_RE.test(location.href);

const RUN_BUTTON_IDS = ['openRun', 'runDetails', 'downloadParams', 'runTree'];
function removeRunButtons() {
    for (const id of RUN_BUTTON_IDS) {
        const button = document.getElementById(id);
        (button?.closest('.ms-OverflowSet-item') ?? button)?.remove();
    }
}

function findMenubar() {
    return document.querySelector('.fl-ActionHeading-RightContent .fl-ActionHeading-menu [role="toolbar"].ms-OverflowSet')
        || document.querySelector('.fl-ActionHeading-menu [role="toolbar"].ms-OverflowSet')
        || document.querySelector('div[role="toolbar"].ms-OverflowSet')
        || document.querySelector('div[role="toolbar"]')
        || document.querySelector('div[role="menubar"].ms-OverflowSet')
        || document.querySelector('div[role="menubar"]')
        || document.querySelector('.ms-OverflowSet');
}

function findTemplateButton(menubar) {
    if (!menubar) return null;
    return menubar.querySelector('#editFlow')
        || menubar.querySelector('#resubmitFlowRun')
        || menubar.querySelector('#chat')
        || menubar.querySelector('button[aria-label="Edit"]')
        || menubar.querySelector('button[aria-label="Resubmit"]')
        || menubar.querySelector('button[aria-label="Copilot"]')
        || [...menubar.querySelectorAll('button')].find((button) =>
            !['openRun', 'runDetails', 'downloadParams', 'runTree'].includes(button.id || ''))
        || null;
}

// Buttons blend in by cloning an existing toolbar item and rewiring it.
function cloneToolbarItem(templateItem, { id, label, iconName, iconChar, onClick }) {
    const item = templateItem.cloneNode(true);
    const button = item.querySelector('button');
    button.id = id;
    button.setAttribute('data-automation-id', id);
    button.setAttribute('aria-label', label);
    button.removeAttribute('disabled');

    const labelEl = button.querySelector('.ms-Button-label');
    if (labelEl) labelEl.textContent = label;
    const icon = button.querySelector('.ms-Icon');
    if (icon) {
        icon.setAttribute('data-icon-name', iconName);
        icon.textContent = iconChar;
    }
    const hiddenDiv = item.querySelector('div[hidden]');
    if (hiddenDiv) {
        hiddenDiv.id = `fl-MenuBar-command47-${id}`;
        hiddenDiv.textContent = label;
    }
    button.addEventListener('click', onClick);
    return item;
}

function addRunButtons() {
    // SPA navigation doesn't reload the page, so a stale set of buttons can
    // linger after leaving a run. Drop them when we're no longer on a run page.
    if (!isRunPage()) { removeRunButtons(); return; }

    const menubar = findMenubar();
    if (!menubar) { queueButtonInjection(1000); return; }
    if (document.getElementById('openRun')) return;

    const templateButton = findTemplateButton(menubar);
    const templateItem = templateButton?.closest('.ms-OverflowSet-item');
    if (!templateItem) { queueButtonInjection(1000); return; }

    const openRunItem = cloneToolbarItem(templateItem, {
        id: 'openRun', label: 'Open run', iconName: 'OpenTab', iconChar: '', onClick: executeOpenRun,
    });

    // Insert before the designer/details view switch, or before the last separator
    const items = [...menubar.children];
    const lastSeparator = items.findLast((child) => child.querySelector('[role="separator"]'));
    const viewSwitchItem = items.find((child) => child.querySelector('#switchDesignerFlowRunDetails'));
    if (viewSwitchItem) menubar.insertBefore(openRunItem, viewSwitchItem);
    else if (lastSeparator) menubar.insertBefore(openRunItem, lastSeparator);
    else menubar.appendChild(openRunItem);

    const reRunItem = cloneToolbarItem(templateItem, {
        id: 'runDetails', label: 'Re-run', iconName: 'Play', iconChar: '', onClick: executeReRun,
    });
    menubar.insertBefore(reRunItem, openRunItem);

    const downloadItem = cloneToolbarItem(templateItem, {
        id: 'downloadParams', label: 'Download', iconName: 'Download', iconChar: '', onClick: executeDownload,
    });
    menubar.insertBefore(downloadItem, reRunItem);

    const runTreeItem = cloneToolbarItem(templateItem, {
        id: 'runTree', label: 'Run tree', iconName: 'Org', iconChar: '', onClick: executeRunTree,
    });
    menubar.insertBefore(runTreeItem, downloadItem);
}

function startObserver() {
    if (observer) return;
    lastUrl = location.href;
    const target = document.body ?? document.documentElement;
    observer = new MutationObserver((mutations) => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            setTimeout(checkAutoRunOnDetailsPage, 500);
            queueButtonInjection(500);
        }
        const toolbarAppeared = mutations.some((m) => m.addedNodes.length > 0
            && [...m.addedNodes].some((n) => n.nodeType === 1 && (
                n.matches?.('div[role="toolbar"]') || n.matches?.('div[role="menubar"]')
                || n.querySelector?.('div[role="toolbar"]') || n.querySelector?.('div[role="menubar"]')
                || n.querySelector?.('.fl-ActionHeading-menu') || n.querySelector?.('.ms-OverflowSet'))));
        if (toolbarAppeared) queueButtonInjection(750);
    });
    observer.observe(target, { childList: true, subtree: true });
}

function activate() {
    addRunButtons();
    checkAutoRunOnDetailsPage();
    startObserver();
}

export default {
    init({ store: toolStore }) {
        store = toolStore;
        commands.register({ toolId: 'run-opener', title: 'Show run page buttons', icon: '▶', svg: 'play', run: activate });
        commands.register({ toolId: 'run-opener', title: 'Show run tree (connected runs)', icon: '🔀', svg: 'textBulletListTree', run: executeRunTree });
        const start = () => activate();
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
        else start();
    },
};
