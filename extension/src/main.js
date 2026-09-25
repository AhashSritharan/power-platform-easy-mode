// Engine: loads enabled tools for the current page and serves the popup /
// command palette from the shared command registry.

import { TOOLS, isToolEnabled } from './registry.js';
import { createStore, settings } from './core/storage.js';
import { urlMatches } from './core/context.js';
import * as commands from './core/commands.js';
import { openPalette, toast } from './core/ui.js';
import { RELOAD_HINT, onExtensionInvalidated } from './core/lifecycle.js';

const toolNames = new Map(TOOLS.map((t) => [t.id, t.name]));

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
        case 'get-page-state':
            sendResponse({
                commands: commands.list().map((c) => ({
                    cmdId: c.cmdId,
                    toolId: c.toolId,
                    caption: c.title,
                    icon: c.icon,
                })),
            });
            break;
        case 'invoke-command':
            commands.invoke(msg.cmdId);
            sendResponse({ ok: true });
            break;
        case 'open-palette':
            openPalette(commands.all().map((c) => ({
                icon: c.icon,
                title: c.title,
                subtitle: toolNames.get(c.toolId),
                run: c.run,
            })));
            sendResponse({ ok: true });
            break;
    }
});

// Reloading/updating the extension orphans this script. Tools then fail soft,
// but the user still needs to know why the toolbox stopped reacting.
onExtensionInvalidated(() => toast(RELOAD_HINT, 8000));

loadTools();
