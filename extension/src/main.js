// Engine: loads enabled tools for the current page and serves the popup /
// command palette from the shared command registry, plus the floating
// launcher that opens the palette from the page itself.

import { TOOLS, isToolEnabled, groupByArea } from './registry.js';
import { createStore, settings } from './core/storage.js';
import { urlMatches } from './core/context.js';
import * as commands from './core/commands.js';
import { openPalette, toast } from './core/ui.js';
import { RELOAD_HINT, onExtensionInvalidated } from './core/lifecycle.js';
import { showLauncher } from './core/launcher.js';
import { discoveredEnvironments } from './core/agent.js';
import { DISCOVERY_PARAM } from './tools/shared/environment-discovery.js';

const tools = new Map(TOOLS.map((t) => [t.id, t]));

async function loadTools() {
    const enabled = await settings.getEnabledMap();
    const applicable = TOOLS.filter((tool) => isToolEnabled(tool.id, enabled) && urlMatches(tool.matches));

    for (const tool of applicable) {
        try {
            const module = await import(chrome.runtime.getURL(tool.file));
            await module.default.init({ store: createStore(tool.id), tool });
        } catch (e) {
            console.error(`[Power Platform Toolbox] tool "${tool.id}" failed:`, e);
        }
    }
}

function showPalette() {
    const toItem = (c, color) => {
        const tool = tools.get(c.toolId);
        return {
            icon: c.icon,
            svg: c.svg,
            title: c.title,
            // The tool name only adds something when the title does not already say it.
            subtitle: c.subtitle ?? (tool && !c.title.includes(tool.name) ? tool.name : undefined),
            keywords: tool ? `${tool.name} ${tool.description}` : '',
            color,
            run: c.run,
        };
    };
    openPalette({
        sections: groupByArea(commands.all()).map((area) => ({
            name: area.name,
            color: area.color,
            // Settings are rare and wordy: a plain list, not cards — as in the popup.
            layout: area.id === 'settings' ? 'list' : 'grid',
            items: area.commands.map((c) => toItem(c, area.color)),
        })),
    });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
        case 'get-page-state':
            sendResponse({
                commands: commands.list().map((c) => ({
                    cmdId: c.cmdId,
                    toolId: c.toolId,
                    caption: c.title,
                    icon: c.icon,
                    svg: c.svg,
                    kind: c.kind,
                })),
            });
            break;
        case 'invoke-command':
            commands.invoke(msg.cmdId);
            sendResponse({ ok: true });
            break;
        case 'open-palette':
            showPalette();
            sendResponse({ ok: true });
            break;
    }
});

// Reloading/updating the extension orphans this script. Tools then fail soft,
// but the user still needs to know why the toolbox stopped reacting.
onExtensionInvalidated(() => toast(RELOAD_HINT, 8000));

// The portal tab setup opened to find the user's environments: pass the list on.
if (location.hostname === 'make.powerapps.com' && new URLSearchParams(location.search).has(DISCOVERY_PARAM)) {
    discoveredEnvironments().then((response) => chrome.runtime.sendMessage({ type: 'environments-discovered', response }))
        .catch((e) => console.error('[Power Platform Toolbox] environment discovery failed:', e));
}

// The launcher only shows where some tool has something to offer.
loadTools().then(() => {
    if (commands.all().length) showLauncher(showPalette);
});
