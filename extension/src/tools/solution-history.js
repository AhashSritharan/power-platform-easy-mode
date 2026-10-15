// Solution History (native).
// One side panel for everything that went in and out of an environment:
//   Imports — live progress of running imports/upgrades/uninstalls and the
//             completed ones with their failure logs (shared/solution-imports.js)
//   Exports — every async export the environment still holds, re-downloadable
//             (shared/solution-exports.js)
//
// Works on a Dynamics page against its own org, and on the maker portals
// against the environment in the URL (see shared/current-org.js).

import * as ui from '../core/ui.js';
import * as commands from '../core/commands.js';
import { getSite } from '../core/context.js';
import { resolveCurrentOrg } from './shared/current-org.js';
import { STYLE as IMPORTS_STYLE, mountImports } from './shared/solution-imports.js';
import { STYLE as EXPORTS_STYLE, mountExports } from './shared/solution-exports.js';

const STYLE = `
    .sh-backdrop {
        position: fixed; inset: 0; background: rgba(0,0,0,0.3);
        z-index: 2147483000; animation: ppt-fade 0.15s ease;
    }
    .sh-panel {
        position: fixed; top: 0; right: 0; bottom: 0;
        width: 60vw; min-width: 480px; max-width: 1000px;
        background: var(--bg); display: flex; flex-direction: column;
        box-shadow: -4px 0 24px rgba(0,0,0,0.18);
        animation: sh-slide 0.25s ease;
    }
    .sh-header, .sh-footer {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 24px; flex-shrink: 0;
    }
    .sh-header { padding-bottom: 0; }
    .sh-header h2 { margin: 0; font-size: 17px; font-weight: 600; }
    .sh-org { margin-left: 10px; color: var(--muted); font-size: 12px; font-weight: 400; }
    .sh-footer { border-top: 1px solid var(--border); background: var(--bg2); }
    .sh-tabs { display: flex; gap: 4px; padding: 8px 24px 0; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .sh-tab {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 8px 14px; border: none; background: none; cursor: pointer;
        font: inherit; font-size: 13px; font-weight: 600; color: var(--muted);
        border-bottom: 2px solid transparent; margin-bottom: -1px;
    }
    .sh-tab:hover { color: inherit; }
    .sh-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
    .sh-content { flex: 1; overflow-y: auto; padding: 16px 24px; }
    .sh-dim { color: var(--muted); font-size: 12px; }
    .sh-live {
        display: inline-flex; align-items: center; gap: 5px;
        background: #DFF6DD; color: #107C10; border: 1px solid #A7E3A5;
        padding: 1px 7px; border-radius: 12px; font-size: 10px; font-weight: 600;
    }
    .sh-live::before {
        content: ""; width: 6px; height: 6px; border-radius: 50%;
        background: #107C10; animation: sh-pulse 2s ease infinite;
    }
    @keyframes sh-slide { from { transform: translateX(100%); } }
    @keyframes sh-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
`;

const TABS = {
    imports: {
        label: '📦 Imports',
        live: true,
        hint: 'Active operations auto-refresh every 3 seconds',
        mount: mountImports,
    },
    exports: {
        label: '📥 Exports',
        hint: 'Exports are kept by the environment for years.',
        mount: mountExports,
    },
};

// Set while the panel is open (or still resolving its org); switches tabs.
let openPanelAt = null;

let toolStore = null; // remembers the tab used last

async function openPanel(initialTab = 'imports') {
    if (openPanelAt) { openPanelAt(initialTab); return; }
    openPanelAt = () => {}; // claimed while the org is resolved

    const org = await resolveCurrentOrg({ purpose: 'its solution imports and exports can be read' });
    if (!org) { openPanelAt = null; return; }

    const views = {}; // tab id → { node, view } — mounted on first visit, kept after
    let active = null;

    const backdrop = ui.mount(ui.el('div', { className: 'ppt sh-backdrop' }));
    let releaseEscape = () => {};
    const dispose = () => {
        openPanelAt = null;
        for (const { view } of Object.values(views)) view.dispose();
        backdrop.remove();
        releaseEscape();
    };
    releaseEscape = ui.onEscape(dispose);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) dispose(); });

    const content = ui.el('div', { className: 'sh-content' });
    const hint = ui.el('span', { className: 'sh-dim' });
    const tabButtons = Object.entries(TABS).map(([id, tab]) => {
        const button = ui.el('button', { className: 'sh-tab', textContent: tab.label, onclick: () => show(id) });
        if (tab.live) button.appendChild(ui.el('span', { className: 'sh-live', textContent: 'Live' }));
        button.dataset.tab = id;
        return button;
    });

    function show(id) {
        if (!TABS[id] || id === active) return;
        active = id;
        toolStore?.set('lastTab', id);
        if (!views[id]) {
            const node = ui.el('div');
            content.appendChild(node);
            views[id] = { node, view: TABS[id].mount(node, org.dv) };
        }
        for (const [tabId, { node }] of Object.entries(views)) node.hidden = tabId !== id;
        for (const button of tabButtons) button.classList.toggle('active', button.dataset.tab === id);
        hint.textContent = TABS[id].hint;
        content.scrollTop = 0;
    }

    // Off Dynamics the org is not the page's own, so say which one this is.
    const orgLabel = getSite() === 'dynamics' ? [] : [ui.el('span', { className: 'sh-org', textContent: org.host })];

    backdrop.appendChild(ui.el('div', { className: 'sh-panel' }, [
        ui.el('div', { className: 'sh-header' }, [
            ui.el('h2', {}, [document.createTextNode('🗂️ Solution History'), ...orgLabel]),
            ui.el('button', { className: 'ppt-icon-btn', textContent: '✕', title: 'Close', onclick: dispose }),
        ]),
        ui.el('div', { className: 'sh-tabs' }, tabButtons),
        content,
        ui.el('div', { className: 'sh-footer' }, [
            hint,
            ui.el('button', { className: 'ppt-btn', textContent: '🔄 Refresh', onclick: () => views[active]?.view.refresh() }),
        ]),
    ]));

    openPanelAt = show;
    show(initialTab);
}

export default {
    init({ store }) {
        ui.addStyle('sh', STYLE);
        ui.addStyle('sim', IMPORTS_STYLE);
        ui.addStyle('seh', EXPORTS_STYLE);
        toolStore = store;
        // One entry point for the one panel; it reopens on the tab used last.
        commands.register({
            toolId: 'solution-history',
            title: 'Open Solution History',
            subtitle: 'Imports and exports',
            icon: '📦', svg: 'history',
            run: async () => openPanel(await store.get('lastTab', 'imports')),
        });
    },
};
