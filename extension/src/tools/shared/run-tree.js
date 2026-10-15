// Connected-runs tree, shared by Flow Run Monitor (Dynamics pages) and
// Run Page Actions (Power Automate run pages).
//
// Builds the chain of ACTUAL flow runs around a starting run using the
// Dataverse flowruns table: walks up parentrunid to the topmost triggering
// run, then loads descendant runs lazily downwards. Sibling runs of the SAME
// child flow (e.g. 100 apply-to-each child-flow calls) collapse into one
// group card with a status roll-up, duration stats and a pager
// (prev / next / next failed) — only the selected iteration's subtree is
// fetched and rendered, so a 500-run tree stays a handful of cards.
// Every node is a real run the caller can open (the openRun callback decides
// how).

import * as ui from '../../core/ui.js';

export const RUN_FIELDS = 'flowrunid,name,status,starttime,endtime,duration,errorcode,errormessage,triggertype,modernflowtype,_workflow_value,_ownerid_value,workflowid,parentrunid';

const MAX_DEPTH = 10;
const MAX_CHILDREN = 5000; // safety valve against runaway trees, not a page size — children page in via nextLink
const ERROR_RESOLVE_LIMIT = 100; // max failed iterations per group whose child chain we fetch for root causes
const ERROR_RESOLVE_BATCH = 10; // root-cause walks fetched concurrently at a time

const STYLE = `
    .rt-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.3); z-index: 2147483040; animation: ppt-fade 0.15s ease; }
    .rt-shell {
        position: fixed; inset: 0; margin: auto; z-index: 2147483050;
        width: 800px; max-width: 90vw; height: 80vh;
        background: var(--bg); border-radius: 8px; box-shadow: var(--shadow);
        display: flex; flex-direction: column;
    }
    .rt-shell.fullscreen { width: 100vw; max-width: 100vw; height: 100vh; border-radius: 0; }
    .rt-header, .rt-footer { display: flex; align-items: center; justify-content: space-between; padding: 14px 24px; flex-shrink: 0; }
    .rt-header { border-bottom: 1px solid var(--border); }
    .rt-footer { border-top: 1px solid var(--border); background: var(--bg2); }
    .rt-body { flex: 1; overflow: hidden; background: var(--bg2); position: relative; }
    .rt-drag { width: 100%; height: 100%; overflow: auto; cursor: grab; user-select: none; padding: 20px; box-sizing: border-box; display: flex; justify-content: center; }
    .rt-drag.dragging { cursor: grabbing; }
    .rt-zoom { transform-origin: top center; display: flex; flex-direction: column; align-items: center; min-width: max-content; padding: 20px; }
    .rt-zoom-btn { background: var(--bg2); border: none; cursor: pointer; padding: 4px 8px; border-radius: 3px; color: var(--text); font-size: 14px; font-weight: 600; min-width: 28px; font-family: inherit; }
    .rt-zoom-btn:hover { background: var(--border); }
    .rt-scope-wrapper { display: flex; flex-direction: column; align-items: center; }
    .rt-scope-header { position: relative; z-index: 1; background: var(--bg2); padding: 0 12px; }
    .rt-scope-body { background: var(--bg2); border: 2px solid var(--muted); border-radius: 4px; padding: 28px 20px 20px; margin-top: -20px; }
    .rt-scope-children { display: flex; flex-direction: column; align-items: center; gap: 10px; }
    .rt-node-card {
        display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: var(--bg);
        border: 1px solid var(--border); border-radius: 6px; width: 320px; min-width: 320px; box-sizing: border-box;
    }
    .rt-node-card.highlight { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(15,108,189,0.25); }
    .rt-node-bar { width: 4px; min-height: 32px; border-radius: 2px; flex-shrink: 0; align-self: stretch; }
    .rt-node-flow { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rt-node-details { display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: 11px; color: var(--muted); }
    .rt-rollup { flex-wrap: wrap; }
    .rt-badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; white-space: nowrap; }
    .rt-chevron { background: transparent; border: none; cursor: pointer; padding: 2px 4px; font-size: 11px; line-height: 1; color: var(--muted); border-radius: 3px; flex-shrink: 0; font-family: inherit; }
    .rt-chevron:hover { background: var(--bg2); color: var(--text); }
    .rt-pager { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
    .rt-pager-btn { font-family: inherit; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg2); color: var(--text); cursor: pointer; line-height: 1.5; }
    .rt-pager-btn:hover:not(:disabled) { background: var(--border); }
    .rt-pager-btn:disabled { opacity: 0.4; cursor: default; }
    .rt-pager-label { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .rt-pager-jump { font-family: inherit; font-size: 11px; color: var(--muted); background: none; border: none; cursor: pointer; padding: 2px 4px; border-radius: 3px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .rt-pager-jump:hover { background: var(--bg2); color: var(--text); text-decoration: underline; }
    .rt-pager-input { width: 48px; font-family: inherit; font-size: 11px; padding: 1px 4px; border: 1px solid var(--accent); border-radius: 3px; background: var(--bg); color: var(--text); box-sizing: border-box; }
    .rt-pager-failed { color: #D13438; margin-left: auto; }
    .rt-cause { display: block; color: #D13438; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rt-errlist { display: flex; flex-direction: column; gap: 3px; margin-top: 6px; }
    .rt-err-row {
        display: flex; align-items: baseline; gap: 6px; width: 100%; font-family: inherit; font-size: 11px;
        text-align: left; background: rgba(209,52,56,0.06); border: 1px solid rgba(209,52,56,0.25);
        border-radius: 4px; padding: 3px 8px; cursor: pointer; color: var(--text); box-sizing: border-box;
    }
    .rt-err-row:hover { background: rgba(209,52,56,0.14); }
    .rt-err-count { color: #D13438; font-weight: 600; white-space: nowrap; }
    .rt-err-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
    .rt-icon-btn { background: transparent; border: none; cursor: pointer; padding: 5px; border-radius: 4px; font-size: 15px; line-height: 1; }
    .rt-icon-btn:hover { background: var(--bg2); }
    .rt-spinner { width: 28px; height: 28px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: rt-spin 0.7s linear infinite; }
    .rt-spinner-sm { width: 16px; height: 16px; border-width: 2px; flex-shrink: 0; }
    .rt-slot { display: flex; align-items: center; gap: 8px; padding: 4px 8px; color: var(--muted); font-size: 12px; }
    .rt-note-line { font-size: 11px; color: var(--muted); text-align: center; padding: 2px 0; }
    .rt-center { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 48px; color: var(--muted); text-align: center; }
    .rt-error { background: rgba(209,52,56,0.12); border: 1px solid #F1BBBC; color: #D13438; padding: 12px 16px; border-radius: 6px; font-size: 13px; margin: 16px 24px; word-break: break-word; }
    @keyframes rt-spin { to { transform: rotate(360deg); } }
`;

// ── Formatting helpers ────────────────────────────────────────────────────
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
}

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

const statusOf = (run) => (run.status ?? '').toLowerCase();

function getStatusColor(status) {
    return {
        succeeded: '#107C10', failed: '#D13438', running: '#0F6CBD',
        cancelled: '#835C00', waiting: '#8764B8',
    }[(status ?? '').toLowerCase()] ?? '#616161';
}

export const runFlowName = (run) => run['_workflow_value@OData.Community.Display.V1.FormattedValue'] || 'Unknown Flow';

function statusBadge(status) {
    const color = getStatusColor(status);
    return `<span class="rt-badge" style="background:${color}15;color:${color};border:1px solid ${color}30">${escapeHtml(status || 'Unknown')}</span>`;
}

// ── Error mining ──────────────────────────────────────────────────────────
// The flowruns table is the only error source reachable with cookie
// credentials (action-level outputs live behind the token-authed flow API,
// which this extension deliberately doesn't call). errormessage is often
// JSON — {"code":…,"message":…}, sometimes with nested serialized JSON — and
// for "a dependent action failed" cases the REAL reason usually sits on a
// failed child-flow run further down the chain.

// Deepest message string in an error-ish structure: {error:{…}}, details[],
// or a forwarded connector response like {statusCode, headers, body:{message}}
function deepMessage(value) {
    if (value == null) return null;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        for (const item of value) {
            const message = deepMessage(item);
            if (message) return message;
        }
        return null;
    }
    if (typeof value !== 'object') return null;
    for (const key of ['error', 'innerError', 'details', 'body']) {
        if (value[key]) {
            const message = deepMessage(value[key]);
            if (message) return message;
        }
    }
    return typeof value.message === 'string' ? value.message : null;
}

export function extractErrorMessage(run) {
    let text = String(run.errormessage ?? '').trim();
    // Unwrap up to 3 layers of (nested) serialized JSON
    for (let i = 0; i < 3 && /^[{[]/.test(text); i++) {
        try {
            const message = deepMessage(JSON.parse(text));
            if (!message) break;
            text = String(message).trim();
        } catch { break; }
    }
    return text || null;
}

// Messages that just say "something below me failed" — worth digging past
const GENERIC_ERROR = /an action failed|no dependent actions succeeded|childworkflowunhandledfailure|the (?:workflow|flow) run failed/i;
export const isGenericError = (text) => !text || GENERIC_ERROR.test(text);

// Grouping key: same error modulo ids, numbers and urls
export function errorSignature(text) {
    return String(text ?? '').toLowerCase()
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '‹id›')
        .replace(/https?:\/\/\S+/g, '‹url›')
        .replace(/\d+/g, '#')
        .replace(/\s+/g, ' ')
        .trim().slice(0, 160);
}

// Root cause for a single run, decoupled from the lazy tree model above, for
// callers (e.g. Flow Run Monitor's list/detail views) that hold a raw run
// record rather than a tree node. While the run's own message is only "a
// dependent action failed", follow its failed child runs downwards until a
// real message appears (bounded by MAX_DEPTH). Returns:
//   { message, resolved, sourceFlow }
//   resolved   — true once a non-generic message was found
//   sourceFlow — the descendant flow the message came from, or null if it was
//                already on the passed-in run
export async function resolveRunError(apiGet, run) {
    let best = { message: extractErrorMessage(run), run };
    let current = run;
    const visited = new Set([current.name]);
    for (let hop = 0; hop < MAX_DEPTH && isGenericError(best.message); hop++) {
        let children;
        try { ({ runs: children } = await fetchChildRuns(apiGet, current.name)); }
        catch { break; }
        const failedChild = children.find((r) =>
            statusOf(r) === 'failed' && r.name && !visited.has(r.name));
        if (!failedChild) break;
        visited.add(failedChild.name);
        current = failedChild;
        const message = extractErrorMessage(failedChild);
        if (message) best = { message, run: failedChild };
    }
    return {
        message: best.message ?? run.errorcode ?? 'Failed',
        resolved: !isGenericError(best.message),
        sourceFlow: best.run !== run ? runFlowName(best.run) : null,
    };
}

// ── Data access (apiGet: OData path → parsed JSON, annotations included) ──
// Point lookups by run name, batched and paged.
//
// Paged because flowruns is an elastic table: a filtered query fans out across
// partitions and CAN return an empty page while @odata.nextLink still has more
// — the row exists, it just isn't on page one. The single-GET version of this
// returned null in that case, silently reporting "no such run" and breaking
// every caller that climbs a run chain.
//
// Batched because climbing out of a few hundred cascades is otherwise a few
// hundred round trips: one query covers NAMES_PER_QUERY names, and stops
// paging as soon as every name in the chunk has been found.
const NAMES_PER_QUERY = 20;
const MAX_LOOKUP_PAGES = 50;

export async function fetchRunsByNames(apiGet, runNames) {
    const quote = (name) => encodeURIComponent(String(name).replace(/'/g, "''"));
    const found = new Map();
    const unique = [...new Set(runNames.filter(Boolean))].map(String);

    for (let i = 0; i < unique.length; i += NAMES_PER_QUERY) {
        const chunk = unique.slice(i, i + NAMES_PER_QUERY);
        const clause = chunk.map((name) => `name eq '${quote(name)}'`).join(' or ');
        let url = `/flowruns?$select=${RUN_FIELDS}&$filter=(${clause})`;
        let pages = 0;
        while (url && pages++ < MAX_LOOKUP_PAGES && chunk.some((name) => !found.has(name))) {
            const data = await apiGet(url);
            for (const run of data.value ?? []) if (run.name) found.set(String(run.name), run);
            url = data['@odata.nextLink'] ?? null;
        }
    }
    return found;
}

export async function fetchRunByName(apiGet, runName) {
    return (await fetchRunsByNames(apiGet, [runName])).get(String(runName)) ?? null;
}

// Follows @odata.nextLink continuations (apiGet passes full URLs through)
// until MAX_CHILDREN runs are collected or the server runs out of pages.
async function fetchChildRuns(apiGet, runName) {
    const quoted = encodeURIComponent(String(runName).replace(/'/g, "''"));
    let url = `/flowruns?$select=${RUN_FIELDS}&$filter=parentrunid eq '${quoted}'&$orderby=starttime asc`;
    const runs = [];
    while (url && runs.length < MAX_CHILDREN) {
        const data = await apiGet(url);
        runs.push(...(data.value ?? []));
        url = data['@odata.nextLink'] ?? null;
    }
    return { runs: runs.slice(0, MAX_CHILDREN), truncated: !!url || runs.length > MAX_CHILDREN };
}

// Walk up to the topmost triggering run. pathNames collects every run name on
// the way (and doubles as the cycle guard) so the tree can keep the start
// run's ancestor chain selected inside iteration groups.
async function findRootRun(apiGet, startRun) {
    let root = startRun;
    const pathNames = new Set([startRun.name]);
    while (root.parentrunid && !pathNames.has(root.parentrunid)) {
        const parent = await fetchRunByName(apiGet, root.parentrunid).catch(() => null);
        if (!parent) break;
        pathNames.add(parent.name);
        root = parent;
    }
    return { root, pathNames };
}

// ── Lazy tree model ───────────────────────────────────────────────────────
// Node:  { run, depth, groups: null (children not fetched) | Group[], truncated, expanded }
// Group: { nodes: Node[], selected } — sibling runs of the same child flow,
//         ordered by starttime; only nodes[selected] renders its subtree.

function makeNode(ctx, run, depth) {
    ctx.visited.add(run.name);
    return { run, depth, groups: null, truncated: false, expanded: true, loading: null };
}

function defaultSelection(ctx, nodes) {
    const onPath = nodes.findIndex((n) => ctx.pathNames.has(n.run.name));
    if (onPath >= 0) return onPath;
    const firstFailed = nodes.findIndex((n) => statusOf(n.run) === 'failed');
    return firstFailed >= 0 ? firstFailed : 0;
}

async function loadChildren(ctx, node) {
    if (node.groups !== null || node.depth >= MAX_DEPTH) return;
    node.loading ??= (async () => {
        const { runs, truncated } = await fetchChildRuns(ctx.apiGet, node.run.name);
        if (ctx.disposed()) return;
        const byWorkflow = new Map();
        for (const run of runs) {
            if (!run.name || ctx.visited.has(run.name)) continue;
            const key = run._workflow_value ?? runFlowName(run);
            if (!byWorkflow.has(key)) byWorkflow.set(key, []);
            byWorkflow.get(key).push(makeNode(ctx, run, node.depth + 1));
        }
        node.truncated = truncated;
        node.groups = [...byWorkflow.values()].map((nodes) => ({
            nodes,
            selected: defaultSelection(ctx, nodes),
        }));
    })();
    try { await node.loading; } finally { node.loading = null; }
}

// Load this node's children, then recurse into each group's SELECTED node —
// one path per group per level instead of the whole tree. Deeper fetch
// failures degrade to leaves; only this node's own fetch propagates.
async function loadSelectedPath(ctx, node) {
    await loadChildren(ctx, node);
    if (ctx.disposed() || !node.groups) return;
    await Promise.all(node.groups.map((group) =>
        loadSelectedPath(ctx, group.nodes[group.selected]).catch(() => {})));
}

// While a failed run's message is only "a dependent action failed", follow
// its failed child runs downwards until a real message appears. Fetches the
// (few) failed iterations' children on demand; results are cached per node.
function resolveRootCause(ctx, node) {
    node.rootCause ??= (async () => {
        let best = { message: extractErrorMessage(node.run), run: node.run };
        let current = node;
        for (let hop = 0; hop < MAX_DEPTH && isGenericError(best.message); hop++) {
            try { await loadChildren(ctx, current); } catch { break; }
            if (ctx.disposed() || !current.groups) break;
            const failedChild = current.groups.flatMap((g) => g.nodes)
                .find((n) => statusOf(n.run) === 'failed');
            if (!failedChild) break;
            current = failedChild;
            const message = extractErrorMessage(failedChild.run);
            if (message) best = { message, run: failedChild.run };
        }
        const resolved = !isGenericError(best.message);
        const message = best.message ?? node.run.errorcode ?? 'Failed';
        return {
            message,
            resolved,
            sourceFlow: best.run !== node.run ? runFlowName(best.run) : null,
            signature: errorSignature(message),
        };
    })();
    return node.rootCause;
}

// Distinct root causes across a group's failed iterations, most frequent
// first: [{ message, sourceFlow, indices }]. Only the first
// ERROR_RESOLVE_LIMIT failures get the child-chain treatment; the rest
// bucket by their immediate errormessage.
function resolveGroupErrors(ctx, group) {
    group.errorSummary ??= (async () => {
        const failed = group.nodes
            .map((node, index) => ({ node, index }))
            .filter(({ node }) => statusOf(node.run) === 'failed');
        const toResolve = failed.slice(0, ERROR_RESOLVE_LIMIT);
        for (let i = 0; i < toResolve.length && !ctx.disposed(); i += ERROR_RESOLVE_BATCH) {
            await Promise.all(toResolve.slice(i, i + ERROR_RESOLVE_BATCH)
                .map(({ node }) => resolveRootCause(ctx, node).catch(() => null)));
        }
        const buckets = new Map();
        for (const { node, index } of failed) {
            const cause = node.rootCause ? await node.rootCause.catch(() => null) : null;
            const message = cause?.message ?? extractErrorMessage(node.run) ?? node.run.errorcode ?? 'Failed';
            const signature = cause?.signature ?? errorSignature(message);
            if (!buckets.has(signature)) {
                buckets.set(signature, { message, sourceFlow: cause?.sourceFlow ?? null, indices: [] });
            }
            buckets.get(signature).indices.push(index);
        }
        ctx.updateInfo(); // root-cause walks may have discovered new runs
        return [...buckets.values()].sort((a, b) => b.indices.length - a.indices.length);
    })();
    return group.errorSummary;
}

// ── Rendering ─────────────────────────────────────────────────────────────
const CHEVRON_HTML = '<button class="rt-chevron" data-action="toggle" title="Collapse / expand this branch">▾</button>';

function detailsHtml(run) {
    return `
        <div class="rt-node-details">
            <span title="${run.starttime ? new Date(run.starttime).toLocaleString() : ''}">${formatRelativeTime(run.starttime)}</span>
            <span>•</span><span>${formatDuration(run.duration)}</span>
            ${run.errorcode ? `<span style="color:#D13438">• ${escapeHtml(run.errorcode)}</span>` : ''}
        </div>`;
}

// Fill the card's hidden cause line once the run's root cause is known.
// Only shown when we found something more specific than "an action failed".
function attachCause(ctx, card, node) {
    if (statusOf(node.run) !== 'failed') return;
    const slot = card.querySelector('[data-slot="cause"]');
    resolveRootCause(ctx, node).then((cause) => {
        if (ctx.disposed()) return;
        ctx.updateInfo(); // the walk may have discovered new runs
        if (!cause?.resolved || !slot) return;
        slot.hidden = false;
        slot.title = (cause.sourceFlow ? `via ${cause.sourceFlow}:\n` : '') + cause.message;
        slot.textContent = `↳ ${cause.sourceFlow ? cause.sourceFlow + ': ' : ''}${cause.message}`;
    }).catch(() => {});
}

const CAUSE_SLOT_HTML = '<div class="rt-node-details rt-cause" data-slot="cause" hidden></div>';

const STATUS_GLYPHS = { succeeded: '✓', failed: '✗', cancelled: '⊘', running: '►', waiting: '◔' };

function rollupHtml(group) {
    const counts = new Map();
    for (const n of group.nodes) {
        const status = statusOf(n.run) || 'unknown';
        counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    const order = ['succeeded', 'failed', 'running', 'cancelled', 'waiting'];
    const keys = [...order.filter((s) => counts.has(s)), ...[...counts.keys()].filter((s) => !order.includes(s))];
    const parts = keys.map((s) =>
        `<span style="color:${getStatusColor(s)};font-weight:600" title="${escapeHtml(s)}: ${counts.get(s)}">${STATUS_GLYPHS[s] ?? escapeHtml(s)} ${counts.get(s)}</span>`);
    const durations = group.nodes.map((n) => n.run.duration).filter((d) => typeof d === 'number').sort((a, b) => a - b);
    if (durations.length) {
        const median = durations[(durations.length - 1) >> 1];
        parts.push(`<span>med ${formatDuration(median)} · max ${formatDuration(durations[durations.length - 1])}</span>`);
    }
    return `<div class="rt-node-details rt-rollup">${parts.join('')}</div>`;
}

function buildRunCard(ctx, node) {
    const run = node.run;
    const card = ui.el('div', { className: `rt-node-card${run.flowrunid === ctx.highlightRunId ? ' highlight' : ''}` });
    card.innerHTML = `
        ${node.groups?.length ? CHEVRON_HTML : ''}
        <div class="rt-node-bar" style="background:${getStatusColor(run.status)}"></div>
        <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px">
                ${statusBadge(run.status)}
                <span class="rt-node-flow" title="${escapeHtml(runFlowName(run))}">${escapeHtml(runFlowName(run).substring(0, 30))}</span>
            </div>
            ${detailsHtml(run)}
            ${CAUSE_SLOT_HTML}
        </div>
        <button class="rt-icon-btn" data-action="open-run" title="Open this run">↗️</button>`;
    card.querySelector('[data-action="open-run"]').onclick = (e) => { e.stopPropagation(); ctx.openRun(run); };
    attachCause(ctx, card, node);
    return card;
}

// One card for N sibling runs of the same flow: shows the selected run's
// details plus a status roll-up, duration stats and a pager.
function buildGroupCard(ctx, group, onSelect) {
    const node = group.nodes[group.selected];
    const run = node.run;
    const total = group.nodes.length;
    const failedIdx = group.nodes.map((n, i) => (statusOf(n.run) === 'failed' ? i : -1)).filter((i) => i >= 0);
    const nextFailed = failedIdx.find((i) => i > group.selected) ?? failedIdx.find((i) => i !== group.selected);

    const card = ui.el('div', { className: `rt-node-card${run.flowrunid === ctx.highlightRunId ? ' highlight' : ''}` });
    card.innerHTML = `
        ${node.groups?.length ? CHEVRON_HTML : ''}
        <div class="rt-node-bar" style="background:${getStatusColor(run.status)}"></div>
        <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px">
                ${statusBadge(run.status)}
                <span class="rt-node-flow" title="${escapeHtml(runFlowName(run))}">${escapeHtml(runFlowName(run).substring(0, 30))}</span>
                <span class="rt-badge" style="background:var(--bg2);color:var(--muted);border:1px solid var(--border)" title="${total} runs of this flow share this parent run">×${total}</span>
            </div>
            ${detailsHtml(run)}
            ${CAUSE_SLOT_HTML}
            ${rollupHtml(group)}
            ${failedIdx.length ? '<div class="rt-errlist" data-slot="errlist"><div class="rt-note-line" style="text-align:left;padding:0">Resolving errors…</div></div>' : ''}
            <div class="rt-pager">
                <button class="rt-pager-btn" data-action="prev" title="Previous run" ${group.selected === 0 ? 'disabled' : ''}>◀</button>
                <button class="rt-pager-jump" data-action="jump" title="Click to jump to a specific run">${group.selected + 1} / ${total}</button>
                <button class="rt-pager-btn" data-action="next" title="Next run" ${group.selected === total - 1 ? 'disabled' : ''}>▶</button>
                ${failedIdx.length ? `<button class="rt-pager-btn rt-pager-failed" data-action="next-failed" title="Jump to the next failed run" ${nextFailed === undefined ? 'disabled' : ''}>✗ next failed</button>` : ''}
            </div>
        </div>
        <button class="rt-icon-btn" data-action="open-run" title="Open this run">↗️</button>`;
    card.querySelector('[data-action="open-run"]').onclick = (e) => { e.stopPropagation(); ctx.openRun(run); };
    card.querySelector('[data-action="prev"]').onclick = () => onSelect(group.selected - 1);
    card.querySelector('[data-action="next"]').onclick = () => onSelect(group.selected + 1);
    if (nextFailed !== undefined) card.querySelector('[data-action="next-failed"]').onclick = () => onSelect(nextFailed);

    // Click the "37 / 100" label to type a run number and jump straight to it
    const jumpLabel = card.querySelector('[data-action="jump"]');
    jumpLabel.onclick = () => {
        const input = ui.el('input', {
            className: 'rt-pager-input', type: 'number', min: '1', max: String(total),
            value: String(group.selected + 1), title: 'Enter to jump, Esc to cancel',
        });
        jumpLabel.replaceWith(input);
        input.focus();
        input.select();
        let settled = false;
        const restore = () => { settled = true; input.replaceWith(jumpLabel); };
        const commit = () => {
            if (settled) return;
            const target = Math.min(total, Math.max(1, parseInt(input.value, 10) || group.selected + 1)) - 1;
            if (target !== group.selected) { settled = true; onSelect(target); }
            else restore();
        };
        input.addEventListener('keydown', (e) => {
            e.stopPropagation(); // keep Esc from closing the dialog
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') restore();
        });
        input.addEventListener('blur', commit);
        input.addEventListener('mousedown', (e) => e.stopPropagation());
    };
    attachCause(ctx, card, node);
    if (failedIdx.length) fillErrorList(ctx, card, group, onSelect);
    return card;
}

// Distinct-error rows on a group card; clicking a row pages to the next
// iteration that failed with that error.
function fillErrorList(ctx, card, group, onSelect) {
    resolveGroupErrors(ctx, group).then((summary) => {
        const slot = card.querySelector('[data-slot="errlist"]');
        if (ctx.disposed() || !slot) return;
        slot.replaceChildren(...summary.map((bucket) => {
            const row = ui.el('button', {
                className: 'rt-err-row',
                title: `${bucket.sourceFlow ? `via ${bucket.sourceFlow}:\n` : ''}${bucket.message}\n\nClick to jump to the next run with this error`,
            });
            row.innerHTML = `
                <span class="rt-err-count">✗ ${bucket.indices.length}×</span>
                <span class="rt-err-text">${escapeHtml((bucket.sourceFlow ? bucket.sourceFlow + ': ' : '') + bucket.message)}</span>`;
            row.onclick = () => {
                const next = bucket.indices.find((i) => i > group.selected) ?? bucket.indices[0];
                if (next !== group.selected) onSelect(next);
            };
            return row;
        }));
    }).catch(() => {});
}

// Scope box (card on top, content inside); wires the card's collapse chevron
// to `node.expanded` when a node is given.
function scopeWrapper(card, content, node) {
    const bodyEl = ui.el('div', { className: 'rt-scope-body' }, [content]);
    const wrapper = ui.el('div', { className: 'rt-scope-wrapper' }, [
        ui.el('div', { className: 'rt-scope-header' }, [card]),
        bodyEl,
    ]);
    const chevron = card.querySelector('[data-action="toggle"]');
    if (chevron && node) {
        const apply = () => {
            bodyEl.style.display = node.expanded ? '' : 'none';
            chevron.textContent = node.expanded ? '▾' : '▸';
        };
        chevron.onclick = (e) => { e.stopPropagation(); node.expanded = !node.expanded; apply(); };
        apply();
    }
    return wrapper;
}

function renderNodeWithCard(ctx, node, card) {
    if (!node.groups?.length) return ui.el('div', {}, [card]);
    const children = ui.el('div', { className: 'rt-scope-children' },
        node.groups.map((group) => renderGroup(ctx, group)));
    if (node.truncated) {
        children.appendChild(ui.el('div', { className: 'rt-note-line', textContent: `Only the first ${MAX_CHILDREN} child runs are loaded` }));
    }
    return scopeWrapper(card, children, node);
}

function renderNode(ctx, node) {
    return renderNodeWithCard(ctx, node, buildRunCard(ctx, node));
}

function loadingSlot() {
    return ui.el('div', { className: 'rt-slot' }, [
        ui.el('div', { className: 'rt-spinner rt-spinner-sm' }),
        'Loading child runs…',
    ]);
}

function renderGroup(ctx, group) {
    if (group.nodes.length === 1) return renderNode(ctx, group.nodes[0]);
    const container = ui.el('div');
    const render = () => {
        const node = group.nodes[group.selected];
        const stillCurrent = () => !ctx.disposed() && group.nodes[group.selected] === node;
        const card = buildGroupCard(ctx, group, (index) => { group.selected = index; render(); });
        if (node.groups === null && node.depth < MAX_DEPTH) {
            // Selected a not-yet-fetched iteration: show its card now, subtree when ready
            container.replaceChildren(scopeWrapper(card, loadingSlot(), null));
            loadSelectedPath(ctx, node).then(() => {
                ctx.updateInfo();
                if (stillCurrent()) render();
            }).catch((e) => {
                if (!stillCurrent()) return;
                container.replaceChildren(scopeWrapper(card, ui.el('div', { className: 'rt-slot' }, [
                    `⚠️ Couldn't load child runs: ${e.message}`,
                    ui.el('button', { className: 'rt-pager-btn', textContent: 'Retry', onclick: render }),
                ]), null));
            });
        } else {
            container.replaceChildren(renderNodeWithCard(ctx, node, card));
        }
    };
    render();
    return container;
}

// Origin cards sit above the root run: the canvas app(s) that triggered it.
const APP_PURPLE = '#742774';

function renderOriginCard(entry) {
    return `
        <div class="rt-node-card">
            <div class="rt-node-bar" style="background:${APP_PURPLE}"></div>
            <div style="flex:1;min-width:0">
                <div style="display:flex;align-items:center;gap:8px">
                    <span class="rt-badge" style="background:${APP_PURPLE}15;color:${APP_PURPLE};border:1px solid ${APP_PURPLE}30">📱 Canvas App</span>
                    <span class="rt-node-flow" title="${escapeHtml(entry.label)}">${escapeHtml(entry.label.substring(0, 30))}</span>
                </div>
                <div class="rt-node-details"><span>${escapeHtml(entry.subLabel ?? '')}</span></div>
            </div>
            ${entry.url ? `<button class="rt-icon-btn" data-action="open-origin" data-url="${escapeHtml(entry.url)}" title="Open this app">↗️</button>` : ''}
        </div>`;
}

/**
 * showConnectedRunsDialog({ startRun, apiGet, subtitle, openRun, resolveOrigin })
 *   startRun      — a flowruns record (with annotations) to build the tree around
 *   apiGet        — async (path) => json against the right Dataverse org
 *   openRun       — (run) => void, called for the node the user opens
 *   resolveOrigin — optional async (rootRun) => [{label, subLabel, url}] | null;
 *                   entries render as origin cards above the root run
 */
export async function showConnectedRunsDialog({ startRun, apiGet, subtitle, openRun, resolveOrigin }) {
    ui.addStyle('rt', STYLE);

    let disposed = false;
    const backdrop = ui.mount(ui.el('div', { className: 'ppt rt-backdrop' }));
    let releaseEscape = () => {};
    const dispose = () => { disposed = true; backdrop.remove(); releaseEscape(); };
    releaseEscape = ui.onEscape(dispose);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) dispose(); });

    const body = ui.el('div', { className: 'rt-body' });
    body.innerHTML = '<div class="rt-center"><div class="rt-spinner"></div>Building run tree…</div>';
    const info = ui.el('span', { style: 'font-size:12px;color:var(--muted)', textContent: 'Loading…' });
    const zoomLabel = ui.el('span', { style: 'font-size:11px;font-weight:600;color:var(--muted);min-width:40px;text-align:center', textContent: '100%' });

    const shell = ui.el('div', { className: 'rt-shell' }, [
        ui.el('div', { className: 'rt-header' }, [
            ui.el('div', {}, [
                ui.el('div', { style: 'font-size:16px;font-weight:600', textContent: '🔀 Connected Runs' }),
                ui.el('div', { style: 'font-size:12px;color:var(--muted);margin-top:2px', textContent: subtitle ?? runFlowName(startRun) }),
            ]),
            ui.el('div', { style: 'display:flex;align-items:center;gap:6px' }, [
                ui.el('button', { className: 'rt-zoom-btn', textContent: '−', title: 'Zoom out' }),
                zoomLabel,
                ui.el('button', { className: 'rt-zoom-btn', textContent: '+', title: 'Zoom in' }),
                ui.el('button', { className: 'rt-zoom-btn', textContent: '⟲', title: 'Reset zoom', style: 'font-size:12px' }),
                ui.el('button', { className: 'ppt-icon-btn', textContent: '⛶', title: 'Toggle fullscreen', onclick: () => shell.classList.toggle('fullscreen') }),
                ui.el('button', { className: 'ppt-icon-btn', textContent: '✕', title: 'Close', onclick: dispose }),
            ]),
        ]),
        body,
        ui.el('div', { className: 'rt-footer' }, [
            info,
            ui.el('button', { className: 'ppt-btn primary', textContent: 'Close', onclick: dispose }),
        ]),
    ]);
    backdrop.appendChild(shell);

    // Discovered runs so far; "+" while unselected iterations still hide unfetched subtrees
    let rootNode = null;
    const updateInfo = () => {
        if (!rootNode) return;
        let count = 0;
        let partial = false;
        (function walk(node) {
            count++;
            if (node.groups === null) {
                if (node.depth < MAX_DEPTH) partial = true;
                return;
            }
            if (node.truncated) partial = true;
            for (const group of node.groups) group.nodes.forEach(walk);
        })(rootNode);
        info.textContent = `${count}${partial ? '+' : ''} connected run(s) • Drag to pan, Ctrl+scroll to zoom`;
    };

    const ctx = {
        apiGet,
        openRun,
        highlightRunId: startRun.flowrunid,
        pathNames: new Set(),
        visited: new Set(),
        disposed: () => disposed,
        updateInfo,
    };

    try {
        const { root, pathNames } = await findRootRun(apiGet, startRun);
        ctx.pathNames = pathNames;
        rootNode = makeNode(ctx, root, 0);
        await loadSelectedPath(ctx, rootNode);
    } catch (e) {
        body.innerHTML = `<div class="rt-error">Failed to build run tree: ${escapeHtml(e.message)}</div>`;
        info.textContent = 'Error loading tree';
        return;
    }
    if (disposed) return;

    if (!rootNode.groups?.length && rootNode.run.name === startRun.name) {
        body.innerHTML = '<div class="rt-center"><div style="font-size:32px">🔀</div><div style="font-weight:600;color:var(--text)">No connected runs found</div>This run has no parent or child runs</div>';
        info.textContent = 'No connected runs';
        return;
    }
    updateInfo();

    // Where did the root run come from? (e.g. the canvas app that triggered it)
    let origin = null;
    if (resolveOrigin) {
        try { origin = await resolveOrigin(rootNode.run); } catch { /* tree renders without it */ }
        if (disposed) return;
    }

    let treeEl = renderNode(ctx, rootNode);
    if (origin?.length) {
        const header = ui.el('div', { className: 'rt-scope-header' });
        header.innerHTML = origin.map(renderOriginCard).join('');
        for (const btn of header.querySelectorAll('[data-action="open-origin"]')) {
            btn.addEventListener('click', (e) => { e.stopPropagation(); window.open(btn.dataset.url, '_blank'); });
        }
        treeEl = ui.el('div', { className: 'rt-scope-wrapper' }, [
            header,
            ui.el('div', { className: 'rt-scope-body' }, [
                ui.el('div', { className: 'rt-scope-children' }, [treeEl]),
            ]),
        ]);
    }
    body.innerHTML = '<div class="rt-drag"><div class="rt-zoom"></div></div>';
    body.querySelector('.rt-zoom').appendChild(treeEl);

    // Zoom + drag-to-pan
    const dragEl = body.querySelector('.rt-drag');
    const zoomEl = body.querySelector('.rt-zoom');
    let zoom = 1;
    const setZoom = (next, centerX = null, centerY = null) => {
        next = Math.max(0.25, Math.min(2, next));
        if (centerX !== null) {
            const rect = dragEl.getBoundingClientRect();
            const relX = centerX - rect.left + dragEl.scrollLeft;
            const relY = centerY - rect.top + dragEl.scrollTop;
            const factor = next / zoom;
            dragEl.scrollLeft = relX * factor - (centerX - rect.left);
            dragEl.scrollTop = relY * factor - (centerY - rect.top);
        }
        zoom = next;
        zoomEl.style.transform = `scale(${zoom})`;
        zoomLabel.textContent = Math.round(zoom * 100) + '%';
    };
    const centerOnHighlight = () => {
        const node = zoomEl.querySelector('.rt-node-card.highlight');
        if (!node) return;
        const rect = dragEl.getBoundingClientRect();
        dragEl.scrollLeft = (node.offsetLeft + node.offsetWidth / 2) * zoom - rect.width / 2;
        dragEl.scrollTop = (node.offsetTop + node.offsetHeight / 2) * zoom - rect.height / 2;
    };

    const [zoomOut, zoomIn, zoomReset] = shell.querySelectorAll('.rt-zoom-btn');
    zoomOut.addEventListener('click', () => setZoom(zoom - 0.25));
    zoomIn.addEventListener('click', () => setZoom(zoom + 0.25));
    zoomReset.addEventListener('click', () => { setZoom(1); setTimeout(centerOnHighlight, 50); });

    let drag = null;
    dragEl.addEventListener('mousedown', (e) => {
        if (e.target.closest('button, a, input')) return;
        drag = { x: e.pageX, y: e.pageY, left: dragEl.scrollLeft, top: dragEl.scrollTop };
        dragEl.classList.add('dragging');
    });
    const endDrag = () => { drag = null; dragEl.classList.remove('dragging'); };
    dragEl.addEventListener('mouseleave', endDrag);
    dragEl.addEventListener('mouseup', endDrag);
    dragEl.addEventListener('mousemove', (e) => {
        if (!drag) return;
        e.preventDefault();
        dragEl.scrollLeft = drag.left - (e.pageX - drag.x) * 1.5;
        dragEl.scrollTop = drag.top - (e.pageY - drag.y) * 1.5;
    });
    dragEl.addEventListener('wheel', (e) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            setZoom(zoom + (e.deltaY > 0 ? -0.25 : 0.25), e.clientX, e.clientY);
        }
    }, { passive: false });

    setTimeout(centerOnHighlight, 100);
}
