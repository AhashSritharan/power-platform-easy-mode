// Popup: shows the menu commands registered by tools on the current tab as a
// scannable icon grid, grouped by area (see registry AREAS).
import { groupByArea } from '../src/registry.js';
import { icon } from '../src/core/icons.js';

// The command's Fluent icon, or its emoji when it has none.
const glyph = (command, size) => (command.svg && icon(command.svg, size)) || command.icon || '⚡';

const content = document.getElementById('content');

// Drop the redundant "Open " verb — the popup is already a launcher.
const tileLabel = (caption) => caption.replace(/^Open\s+/i, '');

document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;
document.getElementById('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('open-palette').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
        try { await chrome.tabs.sendMessage(tab.id, { type: 'open-palette' }); } catch { /* unsupported page */ }
    }
    window.close();
});

function renderUnsupported() {
    content.innerHTML = `
        <div class="empty">
            No tools are active on this page.
            <div class="sites">
                Tools run on:<br>
                • Dynamics 365 (<code>*.dynamics.com</code>)<br>
                • Power Apps (<code>make.powerapps.com</code>)<br>
                • Power Automate (<code>make.powerautomate.com</code>)<br>
                • Jira Cloud (<code>*.atlassian.net</code>)
            </div>
            <button id="run-setup" class="link-btn">🚀 Run setup</button>
        </div>`;
    document.getElementById('run-setup').addEventListener('click', async () => {
        await chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
        window.close();
    });
}

function renderCommands(tabId, commands) {
    if (!commands.length) {
        content.innerHTML = `
            <div class="empty">
                No tool commands on this page yet.<br>
                Tools appear here once they load — try reloading the tab.
            </div>`;
        return;
    }

    const invoke = async (command) => {
        await chrome.tabs.sendMessage(tabId, { type: 'invoke-command', cmdId: command.cmdId });
        window.close();
    };
    const tile = (command, color) => {
        const button = document.createElement('button');
        button.className = 'tile';
        button.title = command.caption; // full caption on hover
        button.style.setProperty('--tile', color);

        const icon = document.createElement('span');
        icon.className = 'tile-icon';
        icon.append(glyph(command, 24));

        const label = document.createElement('span');
        label.className = 'tile-label';
        label.textContent = tileLabel(command.caption);

        button.append(icon, label);
        button.addEventListener('click', () => invoke(command));
        return button;
    };
    const header = (name, color) => {
        const h = document.createElement('h2');
        h.className = 'area';
        h.textContent = name;
        if (color) h.style.setProperty('--tile', color);
        return h;
    };

    content.innerHTML = '';
    for (const area of groupByArea(commands)) {
        content.append(header(area.name, area.color));
        if (area.id === 'settings') {
            // Settings are rare and wordy: a plain list, not tiles.
            const list = document.createElement('div');
            list.className = 'settings';
            for (const command of area.commands) {
                const row = document.createElement('button');
                row.className = 'setting';
                row.append(glyph(command, 16), command.caption);
                row.addEventListener('click', () => invoke(command));
                list.appendChild(row);
            }
            content.appendChild(list);
            continue;
        }
        const grid = document.createElement('div');
        grid.className = 'grid';
        grid.append(...area.commands.map((c) => tile(c, area.color)));
        content.appendChild(grid);
    }
}

async function init() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { renderUnsupported(); return; }

    try {
        const state = await chrome.tabs.sendMessage(tab.id, { type: 'get-page-state' });
        renderCommands(tab.id, state?.commands ?? []);
    } catch {
        // No bridge in this tab — not one of the supported sites.
        renderUnsupported();
    }
}

init();
