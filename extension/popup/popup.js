// Popup: shows the menu commands registered by tools on the current tab as a
// scannable icon grid, ordered by tool category.
import { TOOLS, CATEGORY_ORDER } from '../src/registry.js';

const toolCategory = new Map(TOOLS.map((t) => [t.id, t.category]));
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
        </div>`;
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

    // Cluster related tools by category (stable sort keeps registration order
    // within a category), without per-tool headers — the icons do the anchoring.
    const catRank = (toolId) => {
        const index = CATEGORY_ORDER.indexOf(toolCategory.get(toolId));
        return index === -1 ? CATEGORY_ORDER.length : index;
    };
    const ordered = commands
        .map((command, i) => ({ command, i }))
        .sort((a, b) => catRank(a.command.toolId) - catRank(b.command.toolId) || a.i - b.i)
        .map((entry) => entry.command);

    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const command of ordered) {
        const tile = document.createElement('button');
        tile.className = 'tile';
        tile.title = command.caption; // full caption on hover

        const icon = document.createElement('span');
        icon.className = 'tile-icon';
        icon.textContent = command.icon || '⚡';

        const label = document.createElement('span');
        label.className = 'tile-label';
        label.textContent = tileLabel(command.caption);

        tile.append(icon, label);
        tile.addEventListener('click', async () => {
            await chrome.tabs.sendMessage(tabId, { type: 'invoke-command', cmdId: command.cmdId });
            window.close();
        });
        grid.appendChild(tile);
    }

    content.innerHTML = '';
    content.appendChild(grid);
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
