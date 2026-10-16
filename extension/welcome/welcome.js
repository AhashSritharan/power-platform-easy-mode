// Welcome page: a short setup that asks for everything once — which tools to
// run, the labels of the environments the user can access, and the Clockify
// settings both Clockify tools share. It writes the same storage the tools and
// the options page read, so running it again shows what was chosen before.
import { TOOLS, CATEGORY_ORDER, isToolEnabled } from '../src/registry.js';
import { createStore } from '../src/core/storage.js';
import { ENV_TYPES, loadEnvironments } from '../src/tools/shared/environments.js';
import { parseDiscoveredEnvironments, saveDiscoveredEnvironments } from '../src/tools/shared/environment-discovery.js';
import {
    CLOCKIFY_API, loadClockifySettings, saveClockifySettings,
    ROUNDING_BLOCKS, normalizeRounding, describeRounding,
} from '../src/tools/shared/clockify-settings.js';

const $ = (selector) => document.querySelector(selector);
const el = (tag, props = {}, children = []) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
};

const ENABLED_KEY = 'enabledTools';
const LAUNCHER_KEY = 'launcher';
const CLOCKIFY_TOOLS = ['jira-clockify-timer', 'clockify-sync'];

// What the user picks on the first step; later steps depend on it.
const choices = {};

const STEPS = [
    { id: 'tools', label: 'Tools', leave: saveTools },
    { id: 'environments', label: 'Environments', leave: saveEnvironments },
    { id: 'clockify', label: 'Clockify', when: () => CLOCKIFY_TOOLS.some((id) => choices[id]), enter: enterClockify, leave: saveClockify },
    { id: 'done', label: 'Done' },
];
let current = 0;

const activeSteps = () => STEPS.filter((step) => !step.when || step.when());

// The steps ahead change as tools are switched on and off (Clockify comes and goes).
function renderStepper() {
    $('#stepper').replaceChildren(...activeSteps().map((s, i) => el('li', {
        className: i === current ? 'active' : i < current ? 'done' : '',
        textContent: s.label,
    })));
}

function show(index, { scroll = true } = {}) {
    current = index;
    const step = activeSteps()[index];
    for (const panel of document.querySelectorAll('.step')) panel.hidden = panel.dataset.step !== step.id;
    renderStepper();
    step.enter?.();
    if (!scroll) return;
    document.querySelector(`.step[data-step="${step.id}"] h2`).focus({ preventScroll: true });
    window.scrollTo({ top: $('.setup').offsetTop - 16, behavior: 'smooth' });
}

async function move(action) {
    const step = activeSteps()[current];
    if (action === 'next') {
        try {
            await step.leave?.();
        } catch (e) {
            console.error('[Power Platform Toolbox] setup could not save:', e);
            return;
        }
    }
    show(Math.max(0, Math.min(current + (action === 'back' ? -1 : 1), activeSteps().length - 1)));
}

document.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action) move(action);
});
$('#open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

// ── 1. Tools ──────────────────────────────────────────────────────────────
function siteSummary(matches) {
    const sites = new Set();
    for (const pattern of matches) {
        if (pattern.includes('dynamics.com')) sites.add('Dynamics 365');
        else if (pattern.includes('powerautomate.com')) sites.add('Power Automate');
        else if (pattern.includes('powerapps.com')) sites.add('Power Apps');
        else if (pattern.includes('atlassian.net')) sites.add('Jira');
    }
    return [...sites].join(' · ');
}

async function renderTools() {
    const { [ENABLED_KEY]: enabled = {}, [LAUNCHER_KEY]: launcher } = await chrome.storage.local.get([ENABLED_KEY, LAUNCHER_KEY]);
    $('#launcher-toggle').checked = !launcher?.hidden;
    const list = $('#tool-list');
    for (const category of CATEGORY_ORDER) {
        const tools = TOOLS.filter((tool) => tool.category === category);
        if (!tools.length) continue;
        const section = el('section', { className: 'category' }, [el('h3', { textContent: category })]);
        for (const tool of tools) {
            choices[tool.id] = isToolEnabled(tool.id, enabled);
            const checkbox = el('input', { type: 'checkbox', checked: choices[tool.id] });
            checkbox.setAttribute('aria-label', `Enable ${tool.name}`);
            checkbox.addEventListener('change', () => { choices[tool.id] = checkbox.checked; renderStepper(); });
            section.append(el('div', { className: 'tool' }, [
                el('div', { className: 'info' }, [
                    el('div', { className: 'name', textContent: tool.name }),
                    el('div', { className: 'desc', textContent: tool.description }),
                    el('div', { className: 'meta', textContent: siteSummary(tool.matches) }),
                ]),
                el('label', { className: 'switch' }, [checkbox, el('span', { className: 'slider' })]),
            ]));
        }
        list.append(section);
    }
}

// Every tool's choice is stored explicitly, as the options page does: an
// opt-in tool cannot fall back to "missing means on".
async function saveTools() {
    const { [LAUNCHER_KEY]: launcher } = await chrome.storage.local.get(LAUNCHER_KEY);
    await chrome.storage.local.set({
        [ENABLED_KEY]: Object.fromEntries(TOOLS.map((tool) => [tool.id, !!choices[tool.id]])),
        [LAUNCHER_KEY]: { ...launcher, hidden: !$('#launcher-toggle').checked },
    });
}

// ── 2. Environments ───────────────────────────────────────────────────────
let discovered = [];
const SLOW_DISCOVERY_MS = 15_000;

$('#find-environments').addEventListener('click', async () => {
    const button = $('#find-environments');
    const status = $('#env-status');
    button.disabled = true;
    status.className = 'status';
    status.textContent = 'Reading your environments from the maker portal…';
    const slow = setTimeout(() => {
        status.textContent = 'Still waiting. If the maker portal asks you to sign in, do that in the tab that just opened — it closes by itself afterwards.';
    }, SLOW_DISCOVERY_MS);
    let result;
    try {
        result = await chrome.runtime.sendMessage({ type: 'discover-environments' });
    } catch (e) {
        result = { ok: false, error: e.message };
    } finally {
        clearTimeout(slow);
        button.disabled = false;
    }
    if (!result?.ok) {
        status.className = 'status error';
        status.textContent = `❌ ${result?.error ?? 'Could not read your environments.'}`;
        button.textContent = 'Try again';
        return;
    }
    discovered = parseDiscoveredEnvironments(result.response);
    status.textContent = discovered.length
        ? `${discovered.length} environment${discovered.length === 1 ? '' : 's'} found. Check the labels, then continue.`
        : 'No environments with a Dataverse database were found for your account.';
    button.textContent = 'Find again';
    await renderEnvironments();
});

async function renderEnvironments() {
    // Labels set before (in the Environment Indicator or an earlier setup) win
    // over a suggestion.
    const known = new Map((await loadEnvironments()).map((env) => [env.envId, env]));
    const typeOptions = [['', 'No label'], ...Object.keys(ENV_TYPES).map((type) => [type, `${ENV_TYPES[type].icon} ${type}`])];
    $('#env-list').replaceChildren(...discovered.map((env) => {
        const select = el('select', {}, typeOptions.map(([value, label]) => el('option', { value, textContent: label })));
        select.value = known.get(env.envId)?.type ?? env.suggestedType ?? '';
        select.setAttribute('aria-label', `Label for ${env.name}`);
        select.addEventListener('change', () => { env.type = select.value || null; });
        env.type = select.value || null;
        return el('div', { className: 'env-row' }, [
            el('div', { className: 'env-main' }, [
                el('div', { className: 'env-name', textContent: env.name || env.host }),
                el('div', { className: 'env-host', textContent: `${env.host}${env.sku ? ` · ${env.sku}` : ''}` }),
            ]),
            select,
        ]);
    }));
    $('#env-next').hidden = !discovered.length;
}

async function saveEnvironments() {
    if (discovered.length) await saveDiscoveredEnvironments(discovered);
}

// ── 3. Clockify ───────────────────────────────────────────────────────────
let clockify = { apiKey: '', workspaceId: '', userId: '' };
let clockifyEntered = false;
const syncStore = createStore('clockify-sync');

async function clockifyGet(path, apiKey) {
    const response = await fetch(CLOCKIFY_API + path, { headers: { 'X-Api-Key': apiKey } });
    if (!response.ok) {
        let message = '';
        try { message = (await response.json())?.message ?? ''; } catch { /* not json */ }
        throw new Error(response.status === 401 ? 'Clockify did not accept that API key.' : message || `Clockify answered ${response.status}.`);
    }
    return response.json();
}

async function connectClockify() {
    const apiKey = $('#clockify-key').value.trim();
    const status = $('#clockify-status');
    const select = $('#clockify-workspace');
    if (!apiKey) { status.className = 'status error'; status.textContent = 'Enter your API key first.'; return; }
    status.className = 'status';
    status.textContent = 'Connecting…';
    try {
        const [user, workspaces] = await Promise.all([clockifyGet('/user', apiKey), clockifyGet('/workspaces', apiKey)]);
        clockify = { ...clockify, apiKey, userId: user.id };
        const preferred = [clockify.workspaceId, user.activeWorkspace, user.defaultWorkspace]
            .find((id) => id && workspaces.some((ws) => ws.id === id)) ?? workspaces[0]?.id ?? '';
        select.replaceChildren(...workspaces.map((ws) => el('option', { value: ws.id, textContent: ws.name })));
        select.disabled = !workspaces.length;
        select.value = preferred;
        status.className = 'status ok';
        status.textContent = `✅ Connected as ${user.name}`;
    } catch (e) {
        status.className = 'status error';
        status.textContent = `❌ ${e.message}`;
    }
}
$('#clockify-connect').addEventListener('click', connectClockify);

const roundingBlock = $('#rounding-block');
const roundingUp = $('#rounding-up');
roundingBlock.append(...ROUNDING_BLOCKS.map((block) => el('option', { value: String(block), textContent: block ? `${block}-minute blocks` : 'No rounding' })));
const readRounding = () => normalizeRounding({ block: roundingBlock.value, roundUpFrom: roundingUp.value });
function paintRounding() {
    const { block } = readRounding();
    $('#rounding-up-row').hidden = !block;
    roundingUp.max = String(block || 1);
    $('#rounding-example').textContent = describeRounding(readRounding());
}
roundingBlock.addEventListener('change', paintRounding);
roundingUp.addEventListener('input', paintRounding);

async function enterClockify() {
    $('#rounding').hidden = !choices['clockify-sync'];
    if (clockifyEntered) return;
    clockifyEntered = true;
    clockify = await loadClockifySettings();
    $('#clockify-key').value = clockify.apiKey;
    const rounding = normalizeRounding(await syncStore.get('clockify_rounding', null));
    roundingBlock.value = String(rounding.block);
    roundingUp.value = String(rounding.roundUpFrom);
    paintRounding();
    if (clockify.apiKey) await connectClockify();
}

async function saveClockify() {
    const apiKey = $('#clockify-key').value.trim();
    const select = $('#clockify-workspace');
    await saveClockifySettings({
        apiKey,
        workspaceId: select.disabled ? clockify.workspaceId : select.value,
        ...(apiKey === clockify.apiKey && clockify.userId ? { userId: clockify.userId } : {}),
    });
    if (choices['clockify-sync']) await syncStore.set('clockify_rounding', readRounding());
}

// ── Start ─────────────────────────────────────────────────────────────────
for (const heading of document.querySelectorAll('.step h2')) heading.tabIndex = -1;

renderTools().then(() => show(0, { scroll: false }));
