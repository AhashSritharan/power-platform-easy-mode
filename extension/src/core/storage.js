// Namespaced key-value storage on chrome.storage.local.
//
// Every tool gets its own namespace; keys are laid out as `vals/<ns>/<key>`.
// The same layout is synced into the MAIN world by src/gm/bridge.js, so legacy
// tools (and the PowerPlatformEnvironments page bridge) see native tools'
// data without any extra plumbing. All data stays on-device.

// In an orphaned content script (see core/lifecycle.js) storage is simply
// gone: reads fall back to their default, writes are dropped. The page is
// already beyond saving — the point is not to throw at every caller.

import { isToolEnabled } from '../registry.js';
import { callExtension, isExtensionAlive, noteInvalidated } from './lifecycle.js';

const PREFIX = 'vals/';

export function createStore(ns) {
    const full = (key) => `${PREFIX}${ns}/${key}`;

    return {
        async get(key, defaultValue) {
            const result = await callExtension(() => chrome.storage.local.get(full(key)), {});
            const value = result[full(key)];
            return value === undefined ? defaultValue : value;
        },

        async set(key, value) {
            await callExtension(() => chrome.storage.local.set({ [full(key)]: value }));
        },

        async remove(key) {
            await callExtension(() => chrome.storage.local.remove(full(key)));
        },

        /** Invoke cb(newValue) whenever `key` changes (any tab). Returns unsubscribe. */
        watch(key, cb) {
            if (!isExtensionAlive()) {
                noteInvalidated();
                return () => {};
            }
            const listener = (changes, area) => {
                if (area === 'local' && full(key) in changes) cb(changes[full(key)].newValue);
            };
            chrome.storage.onChanged.addListener(listener);
            return () => {
                try { chrome.storage.onChanged.removeListener(listener); } catch { /* context gone */ }
            };
        },
    };
}

/** Extension-wide settings (not tool data). */
export const settings = {
    async getEnabledMap() {
        const { enabledTools } = await callExtension(() => chrome.storage.local.get('enabledTools'), {});
        return enabledTools ?? {}; // missing entry = the registry default
    },
    async isEnabled(toolId) {
        return isToolEnabled(toolId, await this.getEnabledMap());
    },
    /** Floating launcher: { hidden?: boolean, top?: fraction of the window height }. */
    async getLauncher() {
        const { launcher } = await callExtension(() => chrome.storage.local.get('launcher'), {});
        return launcher ?? {};
    },
    async setLauncher(patch) {
        const current = await this.getLauncher();
        await callExtension(() => chrome.storage.local.set({ launcher: { ...current, ...patch } }));
    },};
