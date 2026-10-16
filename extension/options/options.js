// Options page: enable/disable individual tools. The service worker watches
// the enabledTools key and re-registers content scripts accordingly.
import { TOOLS, CATEGORY_ORDER, isToolEnabled } from '../src/registry.js';
import { loadClockifySettings } from '../src/tools/shared/clockify-settings.js';

const ENABLED_KEY = 'enabledTools';
// A Clockify tool switched on without an API key cannot do anything yet:
// its row links to the Clockify step of setup.
const CLOCKIFY_TOOLS = new Set(['jira-clockify-timer', 'clockify-sync']);
let clockifyConfigured = false;
const clockifyLinks = []; // [{ link, checkbox }]
const paintClockifyLinks = () => {
    for (const { link, checkbox } of clockifyLinks) link.hidden = !checkbox.checked || clockifyConfigured;
};
const list = document.getElementById('tool-list');
const hint = document.getElementById('reload-hint');

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

async function getEnabledMap() {
    const { [ENABLED_KEY]: enabled } = await chrome.storage.local.get(ENABLED_KEY);
    return enabled ?? {};
}

// Always store the explicit choice: opt-in tools can't fall back to "missing
// means on", and a deliberate toggle should survive a change of defaults.
async function setEnabled(toolId, isEnabled) {
    const enabled = await getEnabledMap();
    enabled[toolId] = isEnabled;
    await chrome.storage.local.set({ [ENABLED_KEY]: enabled });
    hint.hidden = false;
}

async function setAll(isEnabled) {
    const enabled = {};
    for (const tool of TOOLS) enabled[tool.id] = isEnabled;
    await chrome.storage.local.set({ [ENABLED_KEY]: enabled });
    hint.hidden = false;
    for (const checkbox of list.querySelectorAll('input[type=checkbox]')) {
        checkbox.checked = isEnabled;
    }
    paintClockifyLinks();
}

// ── Floating launcher (core/launcher.js) ──────────────────────────────────
const LAUNCHER_KEY = 'launcher';
const launcherToggle = document.getElementById('launcher-toggle');

async function renderLauncher() {
    const { [LAUNCHER_KEY]: launcher } = await chrome.storage.local.get(LAUNCHER_KEY);
    launcherToggle.checked = !launcher?.hidden;
}

launcherToggle.addEventListener('change', async () => {
    const { [LAUNCHER_KEY]: launcher } = await chrome.storage.local.get(LAUNCHER_KEY);
    await chrome.storage.local.set({ [LAUNCHER_KEY]: { ...launcher, hidden: !launcherToggle.checked } });
    hint.hidden = false;
});
// Hiding it from the page's own ✕ while this tab is open.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && LAUNCHER_KEY in changes) renderLauncher();
});

document.getElementById('enable-all').addEventListener('click', () => setAll(true));
document.getElementById('disable-all').addEventListener('click', () => setAll(false));

async function render() {
    const enabled = await getEnabledMap();
    clockifyConfigured = !!(await loadClockifySettings()).apiKey;
    clockifyLinks.length = 0;
    list.innerHTML = '';

    for (const category of CATEGORY_ORDER) {
        const tools = TOOLS.filter((t) => t.category === category);
        if (!tools.length) continue;

        const section = document.createElement('section');
        section.className = 'category';
        const heading = document.createElement('h2');
        heading.textContent = category;
        section.appendChild(heading);

        for (const tool of tools) {
            const row = document.createElement('div');
            row.className = 'tool';

            const info = document.createElement('div');
            info.className = 'info';
            info.innerHTML = `
                <div class="name"></div>
                <div class="desc"></div>
                <div class="meta"></div>`;
            info.querySelector('.name').textContent = tool.name;
            info.querySelector('.desc').textContent = tool.description;
            info.querySelector('.meta').textContent = `${siteSummary(tool.matches)} · v${tool.version}`
                + (tool.defaultEnabled === false ? ' · off by default' : '');

            const label = document.createElement('label');
            label.className = 'switch';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = isToolEnabled(tool.id, enabled);
            checkbox.setAttribute('aria-label', `Enable ${tool.name}`);
            checkbox.addEventListener('change', () => { setEnabled(tool.id, checkbox.checked); paintClockifyLinks(); });
            if (CLOCKIFY_TOOLS.has(tool.id)) {
                const link = Object.assign(document.createElement('a'), {
                    className: 'setup-link', href: '../welcome/welcome.html#clockify', target: '_blank',
                    textContent: 'Set up Clockify',
                });
                info.appendChild(link);
                clockifyLinks.push({ link, checkbox });
            }
            const slider = document.createElement('span');
            slider.className = 'slider';
            label.append(checkbox, slider);

            row.append(info, label);
            section.appendChild(row);
        }
        list.appendChild(section);
    }
    paintClockifyLinks();
}

render();
renderLauncher();
