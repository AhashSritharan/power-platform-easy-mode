// Shared Clockify settings.
//
// The API key, workspace and user id are the same for the Jira Clockify Timer
// and Clockify Sync, so they live once, in the `clockify` namespace, and are
// entered once — in setup or in either tool's settings. Before, each tool kept
// its own copy (`clockify_api_key` … in its own namespace); those still fill in
// whatever the shared settings have never been given, and the first save makes
// the shared settings complete, so they stand on their own from then on.

import { createStore } from '../../core/storage.js';

export const CLOCKIFY_API = 'https://api.clockify.me/api/v1';

const SHARED = 'clockify';
const LEGACY_TOOLS = ['clockify-sync', 'jira-clockify-timer'];
const FIELDS = { apiKey: 'api_key', workspaceId: 'workspace_id', userId: 'user_id' };

/** { apiKey, workspaceId, userId } — '' for anything never set. */
export async function loadClockifySettings({ storeFor = createStore } = {}) {
    const shared = storeFor(SHARED);
    const settings = {};
    for (const [field, key] of Object.entries(FIELDS)) {
        let value = await shared.get(key, undefined);
        for (const tool of LEGACY_TOOLS) {
            if (value !== undefined && value !== null) break;
            const legacy = await storeFor(tool).get(`clockify_${key}`, undefined);
            if (legacy) value = legacy;
        }
        settings[field] = value ?? '';
    }
    return settings;
}

/**
 * Save any of { apiKey, workspaceId, userId }. A new API key may belong to
 * another Clockify user, so it drops the user id unless one comes with it.
 */
export async function saveClockifySettings(patch, { storeFor = createStore } = {}) {
    const current = await loadClockifySettings({ storeFor });
    const next = { ...current, ...patch };
    if (patch.apiKey !== undefined && patch.apiKey !== current.apiKey && patch.userId === undefined) next.userId = '';
    const shared = storeFor(SHARED);
    for (const [field, key] of Object.entries(FIELDS)) await shared.set(key, next[field] ?? '');
    return next;
}

// ── Duration rounding (Clockify Sync) ─────────────────────────────────────
// Stored by Clockify Sync as `clockify_rounding`; here so setup offers the
// same choices and describes them the same way.

/** Block sizes durations can be rounded to; 0 is no rounding (the default). */
export const ROUNDING_BLOCKS = [0, 5, 10, 15, 30, 60];

/**
 * A rounding setting as saved or typed, made safe to use: a block size from
 * ROUNDING_BLOCKS, and the minute into a block from which it rounds up
 * (1 … block; at the block size itself it only ever rounds down).
 */
export function normalizeRounding(rounding) {
    const block = Number(rounding?.block);
    if (!ROUNDING_BLOCKS.includes(block) || block === 0) return { block: 0, roundUpFrom: 1 };
    const from = Math.trunc(Number(rounding.roundUpFrom));
    return { block, roundUpFrom: Number.isFinite(from) ? Math.min(Math.max(from, 1), block) : 1 };
}

/**
 * Minutes as they are imported: the started block is rounded up once it has
 * run for roundUpFrom minutes, and dropped below that (10-minute blocks from
 * 4: 14 → 20, 13 → 10).
 */
export function roundDuration(minutes, rounding) {
    const { block, roundUpFrom } = normalizeRounding(rounding);
    if (!block) return minutes;
    const started = minutes % block;
    if (!started) return minutes;
    return minutes - started + (started >= roundUpFrom ? block : 0);
}

/** One line showing what a rounding does, for the settings forms. */
export function describeRounding(rounding) {
    const { block, roundUpFrom } = normalizeRounding(rounding);
    if (!block) return 'Durations are imported to the minute, as tracked in Clockify.';
    if (roundUpFrom >= block) return `Durations are rounded down to whole ${block}-minute blocks.`;
    return `${block + roundUpFrom} min → ${roundDuration(block + roundUpFrom, { block, roundUpFrom })} min`
        + (roundUpFrom > 1 ? `, ${block + roundUpFrom - 1} min → ${block} min` : '');
}
