// Clockify → Dynamics 365 Sync (native).
// Imports Clockify time entries into msdyn_timeentry records: picks a date
// range (defaulting to the day after your last CRM entry), merges same-day
// entries with the same description, maps descriptions to CRM projects/tasks
// (remembered from previous imports, assignable for new ones), rounds to
// 15-minute blocks, and creates-or-updates the CRM records.

import { Dataverse } from '../core/dataverse.js';
import { request, HttpError } from '../core/http.js';
import * as ui from '../core/ui.js';
import * as commands from '../core/commands.js';

const CLOCKIFY_API = 'https://api.clockify.me/api/v1';

const STYLE = `
    .cs-loader {
        position: fixed; inset: 0; z-index: 2147483200;
        background: rgba(0,0,0,0.25); backdrop-filter: blur(2px);
        display: flex; align-items: center; justify-content: center;
    }
    .cs-loader .box {
        display: flex; flex-direction: column; align-items: center; gap: 14px;
        background: var(--bg); color: var(--text); padding: 28px 44px;
        border-radius: 8px; box-shadow: var(--shadow); font-weight: 600; font-size: 14px;
    }
    .cs-spinner {
        width: 30px; height: 30px; border: 3px solid var(--border);
        border-top-color: var(--accent); border-radius: 50%;
        animation: cs-spin 0.8s linear infinite;
    }
    .cs-entry {
        display: flex; align-items: flex-start; gap: 12px; padding: 12px;
        background: var(--bg2); border: 1px solid var(--border); border-radius: 6px;
        margin-bottom: 8px; cursor: pointer;
    }
    .cs-entry input { margin-top: 2px; width: 16px; height: 16px; accent-color: var(--accent); }
    .cs-entry .title { font-weight: 600; margin-bottom: 4px; }
    .cs-entry .meta { font-size: 12px; color: var(--muted); line-height: 1.5; }
    .cs-badge {
        display: inline-block; padding: 2px 6px; border-radius: 3px;
        font-size: 10px; font-weight: 600; margin-left: 8px; vertical-align: middle;
    }
    .cs-badge.known { background: #DFF6DD; color: #107C10; }
    .cs-badge.new, .cs-badge.stale { background: #FFF4CE; color: #835C00; }
    .cs-warn {
        background: #FFF4CE; border: 1px solid #F5D06C; border-radius: 6px;
        padding: 14px 16px; margin-bottom: 14px; color: #835C00;
    }
    @media (prefers-color-scheme: dark) {
        .cs-badge.known { background: #10380f; color: #6CCB5F; }
        .cs-badge.new, .cs-badge.stale { background: #3d3010; color: #F5D06C; }
        .cs-unknown .status.stale { color: #F5D06C; }
        .cs-warn { background: #3d3010; border-color: #6b5518; color: #F5D06C; }
    }
    .cs-warn .head { font-weight: 600; margin-bottom: 6px; font-size: 14px; }
    .cs-warn .sub { font-size: 12px; margin-bottom: 10px; }
    /* Where the entry lands in CRM, shown on every tile. */
    .cs-entry .target { margin-top: 2px; }
    .cs-entry .target.mapped { color: #107C10; }
    .cs-entry .target.stale { color: #835C00; }
    .cs-unknown {
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
        padding: 10px 12px; margin-bottom: 6px;
    }
    .cs-unknown .desc { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cs-unknown .status { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .cs-unknown .status.mapped { color: #107C10; }
    .cs-unknown .status.stale { color: #835C00; }
    @keyframes cs-spin { to { transform: rotate(360deg); } }
`;

let dv;
let store;
let config;

// ── Loading overlay ───────────────────────────────────────────────────────
let loader = null;
function showLoading(message) {
    hideLoading();
    loader = ui.mount(ui.el('div', { className: 'ppt cs-loader' }, [
        ui.el('div', { className: 'box' }, [
            ui.el('div', { className: 'cs-spinner' }),
            ui.el('span', { textContent: message }),
        ]),
    ]));
}
function hideLoading() {
    loader?.remove();
    loader = null;
}

// ── Clockify API ──────────────────────────────────────────────────────────
async function clockify(endpoint) {
    try {
        const response = await request({
            url: CLOCKIFY_API + endpoint,
            headers: { 'X-Api-Key': config.apiKey, 'Content-Type': 'application/json' },
        });
        return response.json();
    } catch (e) {
        if (e instanceof HttpError) {
            let message;
            try { message = JSON.parse(e.body)?.message; } catch { /* not json */ }
            throw new Error(message ?? e.message);
        }
        throw e;
    }
}

async function ensureClockifyUserId() {
    if (!config.userId) {
        config.userId = (await clockify('/user')).id;
        await store.set('clockify_user_id', config.userId);
    }
    return config.userId;
}

// ── Dataverse helpers ─────────────────────────────────────────────────────
let crmUserId = null;
async function getCrmUserId() {
    return (crmUserId ??= (await dv.get('/WhoAmI()')).UserId);
}

const odataString = (s) => encodeURIComponent(s.replace(/'/g, "''"));

const ACTIVE_PROJECT = 'statecode eq 0'; // msdyn_project: 0 = Active

// msdyn_description has a configurable max length and the Web API rejects
// anything longer, so ask the metadata what fits before writing. The promise is
// cached: the whole import shares one lookup.
let descriptionMaxLengthPromise = null;

function getDescriptionMaxLength() {
    descriptionMaxLengthPromise ??= (async () => {
        const attribute = `/EntityDefinitions(LogicalName='msdyn_timeentry')/Attributes(LogicalName='msdyn_description')`;
        // The cast has to match the column type; msdyn_description is a String
        // out of the box, but an org may have it as a Memo.
        for (const type of ['String', 'Memo']) {
            try {
                const data = await dv.get(`${attribute}/Microsoft.Dynamics.CRM.${type}AttributeMetadata?$select=MaxLength`);
                if (Number.isInteger(data?.MaxLength) && data.MaxLength > 0) return data.MaxLength;
            } catch { /* wrong cast for this column — try the next one */ }
        }
        console.warn('[Clockify Sync] could not read the msdyn_description max length — importing untruncated');
        return null; // unknown: better to import as-is than to cut on a guess
    })();
    return descriptionMaxLengthPromise;
}

async function getLastTimeEntryDate() {
    const userId = await getCrmUserId();
    const data = await dv.get(`/msdyn_timeentries?$select=msdyn_date&$filter=_ownerid_value eq ${userId} and msdyn_date le ${new Date().toISOString()}&$orderby=msdyn_date desc&$top=1`);
    return data.value?.[0]?.msdyn_date ?? null;
}

// Look up the project/task used the last time this description was imported.
async function findMapping(description) {
    if (!description) return { project: null, projectTask: null };
    try {
        const userId = await getCrmUserId();
        const data = await dv.get(`/msdyn_timeentries?$select=_msdyn_project_value,_msdyn_projecttask_value&$filter=_ownerid_value eq ${userId} and msdyn_description eq '${odataString(description)}'&$orderby=msdyn_start desc&$top=1`,
            { Prefer: 'odata.include-annotations="*"' });
        const entry = data.value?.[0];
        if (!entry) return { project: null, projectTask: null };
        const name = (field) => entry[`${field}@OData.Community.Display.V1.FormattedValue`] ?? entry[field];
        return {
            project: entry._msdyn_project_value ? { id: entry._msdyn_project_value, name: name('_msdyn_project_value') } : null,
            projectTask: entry._msdyn_projecttask_value ? { id: entry._msdyn_projecttask_value, name: name('_msdyn_projecttask_value') } : null,
        };
    } catch (e) {
        console.warn('[Clockify Sync] mapping lookup failed:', e);
        return { project: null, projectTask: null };
    }
}

async function recentProjects() {
    const userId = await getCrmUserId();
    const entries = await dv.get(`/msdyn_timeentries?$select=_msdyn_project_value&$filter=_ownerid_value eq ${userId} and _msdyn_project_value ne null&$orderby=msdyn_start desc&$top=100`);
    const ids = [...new Set((entries.value ?? []).map((e) => e._msdyn_project_value))].slice(0, 10);
    if (!ids.length) return [];
    const filter = ids.map((id) => `msdyn_projectid eq ${id}`).join(' or ');
    // Inactive projects drop out here: no point offering one you can't book on.
    const projects = await dv.get(`/msdyn_projects?$select=msdyn_projectid,msdyn_subject&$filter=(${filter}) and ${ACTIVE_PROJECT}`);
    const byId = new Map((projects.value ?? []).map((p) => [p.msdyn_projectid, p.msdyn_subject]));
    return ids.filter((id) => byId.has(id)).map((id) => ({ id, name: byId.get(id) }));
}

async function searchProjects(text) {
    const filter = text ? `(contains(msdyn_subject,'${odataString(text)}')) and ${ACTIVE_PROJECT}` : ACTIVE_PROJECT;
    const data = await dv.get(`/msdyn_projects?$select=msdyn_projectid,msdyn_subject&$orderby=msdyn_subject asc&$top=20&$filter=${filter}`);
    return (data.value ?? []).map((p) => ({ id: p.msdyn_projectid, name: p.msdyn_subject }));
}

/**
 * A project that was fine at the last import may have been closed since.
 * Flags every mapping whose project is no longer active (or no longer there),
 * so the dialog can ask for a new one instead of failing on import.
 */
async function markInactiveProjects(mappings) {
    const ids = [...new Set(Object.values(mappings).map((m) => m.project?.id).filter(Boolean))];
    if (!ids.length) return;
    try {
        const active = new Set();
        for (let i = 0; i < ids.length; i += 20) { // keep the $filter URL sane
            const filter = ids.slice(i, i + 20).map((id) => `msdyn_projectid eq ${id}`).join(' or ');
            const data = await dv.get(`/msdyn_projects?$select=msdyn_projectid&$filter=(${filter}) and ${ACTIVE_PROJECT}`);
            for (const project of data.value ?? []) active.add(project.msdyn_projectid);
        }
        for (const mapping of Object.values(mappings)) {
            if (mapping.project?.id) mapping.projectInactive = !active.has(mapping.project.id);
        }
    } catch (e) {
        // Not worth failing the import over — just skip the hint.
        console.warn('[Clockify Sync] project status check failed:', e);
    }
}

async function searchTasks(text, projectId) {
    const predicates = [];
    if (text) predicates.push(`contains(msdyn_subject,'${odataString(text)}')`);
    if (projectId) predicates.push(`_msdyn_project_value eq ${projectId}`);
    const filter = predicates.length ? `&$filter=${predicates.join(' and ')}` : '';
    const data = await dv.get(`/msdyn_projecttasks?$select=msdyn_projecttaskid,msdyn_subject&$orderby=msdyn_subject asc&$top=20${filter}`);
    return (data.value ?? []).map((t) => ({ id: t.msdyn_projecttaskid, name: t.msdyn_subject }));
}

// ── Date/format helpers ───────────────────────────────────────────────────
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function utcMidnight(isoString) {
    const d = new Date(isoString);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
}

function formatDateTime(dateTime) {
    return new Intl.DateTimeFormat('en-US', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false, timeZone: 'UTC',
    }).format(new Date(dateTime));
}

function formatDuration(ms) {
    const minutes = Math.round(ms / 60000);
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// ── CRM write ─────────────────────────────────────────────────────────────
/**
 * Entries with the same description on the same day, merged into one: it
 * starts at the earliest of them and runs for their summed duration.
 */
export function mergeTimeEntries(entries) {
    const merged = new Map();
    for (const entry of entries) {
        const key = `${(entry.description || '').trim()}|${entry.timeInterval.start.split('T')[0]}`;
        const durationMs = new Date(entry.timeInterval.end) - new Date(entry.timeInterval.start);
        const existing = merged.get(key);
        if (!existing) {
            merged.set(key, { ...entry, _totalMs: durationMs, _count: 1 });
        } else {
            if (new Date(entry.timeInterval.start) < new Date(existing.timeInterval.start)) {
                existing.timeInterval = { ...existing.timeInterval, start: entry.timeInterval.start };
            }
            existing._totalMs += durationMs;
            existing._count += 1;
        }
    }
    return [...merged.values()].map((entry) => ({
        ...entry,
        timeInterval: {
            start: entry.timeInterval.start,
            end: new Date(new Date(entry.timeInterval.start).getTime() + entry._totalMs).toISOString(),
        },
    }));
}

/** Minutes rounded to 15-minute blocks with a 5-minute grace (20 → 30, 18 → 15). */
export const roundToBlocks = (minutes) => Math.floor((minutes + 10) / 15) * 15;

async function createOrUpdateTimeEntry(entry, project, projectTask) {
    const start = new Date(entry.timeInterval.start);
    const end = new Date(entry.timeInterval.end);
    const durationMinutes = roundToBlocks(Math.round((end - start) / 60000));
    const description = entry.description || 'Imported from Clockify';
    const dateValue = utcMidnight(entry.timeInterval.start);

    const record = {
        msdyn_description: description,
        msdyn_duration: durationMinutes,
        msdyn_start: dateValue,
        msdyn_date: dateValue,
        msdyn_type: 192350000, // Work
        statecode: 0,
        statuscode: 1, // Draft
    };
    if (project?.id) record['msdyn_project@odata.bind'] = `/msdyn_projects(${project.id})`;
    if (projectTask?.id) record['msdyn_projectTask@odata.bind'] = `/msdyn_projecttasks(${projectTask.id})`;
    if (config.timeEntrySettingsId) record['msdyn_timeentrysettingId@odata.bind'] = `/msdyn_timeentrysettings(${config.timeEntrySettingsId})`;

    try {
        // If an entry with the same owner/description/project/date exists, update it.
        if (project?.id && description.trim()) {
            const userId = await getCrmUserId();
            const predicates = [
                `_ownerid_value eq ${userId}`,
                `msdyn_description eq '${odataString(description)}'`,
                `_msdyn_project_value eq ${project.id}`,
                `msdyn_date eq ${dateValue}`,
            ];
            if (projectTask?.id) predicates.push(`_msdyn_projecttask_value eq ${projectTask.id}`);
            const existing = await dv.get(`/msdyn_timeentries?$select=msdyn_timeentryid&$filter=${predicates.join(' and ')}`);
            const existingId = existing.value?.[0]?.msdyn_timeentryid;
            if (existingId) {
                await dv.update('msdyn_timeentries', existingId, record);
                return { success: true };
            }
        }
        await dv.create('msdyn_timeentries', record);
        return { success: true };
    } catch (e) {
        let message = e.body ?? e.message;
        try { message = JSON.parse(e.body).error?.message ?? message; } catch { /* not json */ }
        return { error: message };
    }
}

// ── Settings ──────────────────────────────────────────────────────────────
function openSettings() {
    const keyInput = ui.el('input', { className: 'ppt-input', type: 'password', value: config.apiKey, placeholder: 'From Clockify → Profile → API' });
    const wsInput = ui.el('input', { className: 'ppt-input', type: 'text', value: config.workspaceId, placeholder: 'From the workspace URL' });
    const settingsInput = ui.el('input', { className: 'ppt-input', type: 'text', value: config.timeEntrySettingsId, placeholder: 'Optional msdyn_timeentrysetting GUID' });
    ui.modal({
        title: '🕐 Clockify Sync Settings',
        render: (body) => {
            body.append(
                ui.el('div', { className: 'ppt-note', textContent: 'Stored only in your browser and sent only to api.clockify.me.' }),
                ui.el('label', { className: 'ppt-label', textContent: 'Clockify API key' }), keyInput,
                ui.el('label', { className: 'ppt-label', textContent: 'Clockify workspace ID' }), wsInput,
                ui.el('label', { className: 'ppt-label', textContent: 'Time entry settings ID (optional)' }), settingsInput,
            );
        },
        buttons: [
            {
                label: 'Test connection',
                onClick: async () => {
                    config.apiKey = keyInput.value.trim();
                    try {
                        const user = await clockify('/user');
                        config.userId = user.id;
                        await store.set('clockify_user_id', user.id);
                        ui.toast(`✅ Connected as ${user.name}`);
                    } catch (e) {
                        ui.toast(`❌ Connection failed: ${e.message}`, 4500);
                    }
                },
            },
            {
                label: 'Save', primary: true,
                onClick: async (close) => {
                    config.apiKey = keyInput.value.trim();
                    config.workspaceId = wsInput.value.trim();
                    config.timeEntrySettingsId = settingsInput.value.trim().replace(/[{}]/g, '');
                    await store.set('clockify_api_key', config.apiKey);
                    await store.set('clockify_workspace_id', config.workspaceId);
                    await store.set('clockify_timeentrysettings_id', config.timeEntrySettingsId);
                    close();
                    ui.toast('✅ Settings saved');
                },
            },
        ],
    });
}

// ── Import flow ───────────────────────────────────────────────────────────
async function startImport() {
    if (!config.apiKey || !config.workspaceId) { openSettings(); return; }

    let defaultStart;
    try {
        showLoading('Checking your last CRM time entry…');
        const lastDate = await getLastTimeEntryDate();
        if (lastDate) {
            const [year, month, day] = lastDate.split('T')[0].split('-').map(Number);
            const nextDay = new Date(year, month - 1, day + 1);
            defaultStart = isoDate(nextDay > new Date() ? new Date() : nextDay);
        }
    } catch (e) {
        console.warn('[Clockify Sync] could not read last time entry:', e);
    } finally {
        hideLoading();
    }
    if (!defaultStart) {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        defaultStart = isoDate(yesterday);
    }

    const startInput = ui.el('input', { className: 'ppt-input', type: 'date', value: defaultStart });
    const endInput = ui.el('input', { className: 'ppt-input', type: 'date', value: isoDate(new Date()) });
    ui.modal({
        title: '📊 Import from Clockify',
        render: (body) => {
            body.append(
                ui.el('label', { className: 'ppt-label', textContent: 'Start date' }), startInput,
                ui.el('label', { className: 'ppt-label', textContent: 'End date' }), endInput,
            );
        },
        buttons: [{
            label: 'Import', primary: true,
            onClick: async (close) => {
                if (!startInput.value || !endInput.value) { ui.toast('⚠️ Enter both start and end dates.'); return; }
                close();
                await fetchAndShowEntries(startInput.value, endInput.value);
            },
        }],
    });
}

async function fetchAndShowEntries(startDate, endDate) {
    let entries;
    try {
        showLoading('Fetching time entries from Clockify…');
        const userId = await ensureClockifyUserId();
        entries = await clockify(`/workspaces/${config.workspaceId}/user/${userId}/time-entries?start=${startDate}T00:00:00Z&end=${endDate}T23:59:59Z&hydrated=true&page-size=200`);
    } catch (e) {
        ui.toast(`❌ Error fetching from Clockify: ${e.message}`, 5000);
        return;
    } finally {
        hideLoading();
    }

    if (!entries?.length) { ui.toast('No time entries found for the specified date range.', 4000); return; }
    if (entries.some((e) => e.timeInterval?.end == null)) {
        ui.toast('⏱️ You have a running timer in Clockify. Stop all timers before importing.', 5000);
        return;
    }

    // Shorten over-long descriptions up front, before anything keys off them —
    // merging, mapping lookups, the duplicate check and the UI then all agree
    // with what actually lands in CRM.
    let maxDescription;
    try {
        showLoading('Checking the description field length…');
        maxDescription = await getDescriptionMaxLength();
    } finally {
        hideLoading();
    }
    let truncated = 0;
    if (maxDescription) {
        for (const entry of entries) {
            const description = entry.description ?? '';
            if (description.length <= maxDescription) continue;
            entry.description = description.slice(0, maxDescription).trimEnd();
            truncated += 1;
        }
    }
    if (truncated) {
        ui.toast(`✂️ ${truncated} description(s) shortened to ${maxDescription} characters to fit the CRM field.`, 6000);
    }

    const mergedEntries = mergeTimeEntries(entries);

    // Resolve known project mappings per unique description
    const mappings = {}; // description -> { project, projectTask, isKnown }
    const uniqueDescriptions = [...new Set(mergedEntries.map((e) => (e.description || '').trim()))];
    try {
        showLoading('Checking for existing project mappings…');
        await Promise.all(uniqueDescriptions.map(async (desc) => {
            const result = await findMapping(desc);
            mappings[desc] = { ...result, isKnown: !!result.project?.id };
        }));
        await markInactiveProjects(mappings);
    } finally {
        hideLoading();
    }

    showImportDialog(mergedEntries, mappings, uniqueDescriptions.filter((d) => !mappings[d].isKnown));
}

function showImportDialog(mergedEntries, mappings, unknownDescriptions) {
    const selection = new Set(mergedEntries.map((_, i) => i));

    ui.modal({
        title: '📊 Import Time Entries',
        width: 'min(800px, 95vw)',
        render: (body) => {
            const mappingLabel = (m) => [m?.project?.name, m?.projectTask?.name].filter(Boolean).join(' → ');

            // A description can appear in a warning block and on several tiles;
            // reassigning it anywhere repaints all of them.
            const refreshers = new Map(); // description -> repaint fns
            const register = (desc, paint) => refreshers.set(desc, [...(refreshers.get(desc) ?? []), paint]);
            const assign = (desc) => openAssignModal(desc, mergedEntries, mappings, (mapping) => {
                mappings[desc] = { ...mapping, isKnown: mappings[desc]?.isKnown ?? false };
                for (const paint of refreshers.get(desc) ?? []) paint();
            });

            // Compact row for the "needs attention" blocks above the entry list.
            const mappingRow = (desc) => {
                const status = ui.el('div', { className: 'status' });
                const button = ui.el('button', { className: 'ppt-btn', style: 'white-space:nowrap', onclick: () => assign(desc) });
                const paint = () => {
                    const mapping = mappings[desc];
                    const label = mappingLabel(mapping);
                    const stale = !!mapping?.projectInactive;
                    status.textContent = label
                        ? (stale ? `${label} — project is no longer active` : label)
                        : 'Not assigned';
                    status.classList.toggle('mapped', !!label && !stale);
                    status.classList.toggle('stale', stale);
                    // A stale mapping needs the same attention as an unassigned one.
                    button.textContent = label ? 'Change' : 'Assign';
                    button.classList.toggle('primary', !label || stale);
                };
                paint();
                register(desc, paint);
                return ui.el('div', { className: 'cs-unknown' }, [
                    ui.el('div', { style: 'flex:1;min-width:0' }, [
                        ui.el('div', { className: 'desc', textContent: desc || '(No description)' }),
                        status,
                    ]),
                    button,
                ]);
            };

            if (unknownDescriptions.length) {
                body.append(ui.el('div', { className: 'cs-warn' }, [
                    ui.el('div', { className: 'head', textContent: `⚠️ New descriptions found (${unknownDescriptions.length})` }),
                    ui.el('div', { className: 'sub', textContent: 'These have no existing project mapping. Click "Assign" to set a project and task:' }),
                    ui.el('div', { style: 'max-height:170px;overflow-y:auto' },
                        unknownDescriptions.map(mappingRow)),
                ]));
            }

            const unknown = new Set(unknownDescriptions);
            const mapped = [...new Set(mergedEntries.map((e) => (e.description || '').trim()))]
                .filter((desc) => !unknown.has(desc));

            // Projects closed since the last import: the mapping still resolves,
            // but booking on it would fail — surface those like unassigned ones.
            const staleDescriptions = mapped.filter((desc) => mappings[desc]?.projectInactive);
            if (staleDescriptions.length) {
                body.append(ui.el('div', { className: 'cs-warn' }, [
                    ui.el('div', { className: 'head', textContent: `⚠️ Mapped to an inactive project (${staleDescriptions.length})` }),
                    ui.el('div', { className: 'sub', textContent: 'The project used for these last time is no longer active. Pick a current one — importing them as they are will most likely fail:' }),
                    ui.el('div', { style: 'max-height:170px;overflow-y:auto' },
                        staleDescriptions.map(mappingRow)),
                ]));
            }

            body.append(ui.el('div', {
                style: 'color:var(--muted);font-size:13px;margin-bottom:10px',
                textContent: `Found ${mergedEntries.length} time entr${mergedEntries.length === 1 ? 'y' : 'ies'}. Select which ones to import — each tile shows where it lands in CRM:`,
            }));

            const list = ui.el('div', { style: 'max-height:300px;overflow-y:auto' });
            mergedEntries.forEach((entry, index) => {
                const desc = (entry.description || '').trim();
                const checkbox = ui.el('input', { type: 'checkbox', checked: true });
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) selection.add(index);
                    else selection.delete(index);
                });
                const badge = ui.el('span', { className: 'cs-badge' });
                const target = ui.el('div', { className: 'target' });
                const changeBtn = ui.el('button', {
                    className: 'ppt-btn', style: 'white-space:nowrap;align-self:center',
                });
                // The tile is a <label>, so a click would otherwise toggle the checkbox.
                changeBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    assign(desc);
                });
                const paintRow = () => {
                    const mapping = mappings[desc];
                    const label = mappingLabel(mapping);
                    const stale = !!mapping?.projectInactive;
                    const state = stale ? 'stale' : mapping?.isKnown ? 'known' : 'new';
                    badge.className = `cs-badge ${state}`;
                    badge.textContent = { stale: 'Inactive project', known: 'Known', new: 'New' }[state];
                    target.textContent = label
                        ? `🎯 ${label}${stale ? ' — project is no longer active' : ''}`
                        : '🎯 No project assigned yet';
                    target.classList.toggle('mapped', !!label && !stale);
                    target.classList.toggle('stale', stale || !label);
                    changeBtn.textContent = label ? 'Change' : 'Assign';
                    changeBtn.classList.toggle('primary', !label || stale);
                };
                paintRow();
                register(desc, paintRow);
                list.append(ui.el('label', { className: 'cs-entry' }, [
                    checkbox,
                    ui.el('div', { style: 'flex:1;min-width:0' }, [
                        ui.el('div', { className: 'title' }, [
                            entry.description || 'No description',
                            badge,
                        ]),
                        ui.el('div', { className: 'meta' }, [
                            `${formatDateTime(entry.timeInterval.start)} – ${formatDateTime(entry.timeInterval.end)} `,
                            ui.el('span', { style: 'color:var(--accent);font-weight:500', textContent: `(${formatDuration(entry._totalMs)})` }),
                            ...(entry.project?.name ? [ui.el('div', { textContent: `📁 ${entry.project.name}` })] : []),
                            ...(entry._count > 1 ? [ui.el('div', { style: 'color:var(--accent)', textContent: `Merged ${entry._count} entries` })] : []),
                            target,
                        ]),
                    ]),
                    changeBtn,
                ]));
            });
            body.append(list);
        },
        buttons: [
            { label: 'Cancel', onClick: (close) => close() },
            {
                label: 'Import', primary: true,
                onClick: async (close) => {
                    const selected = [...selection].sort((a, b) => a - b).map((i) => mergedEntries[i]);
                    if (!selected.length) { ui.toast('Select at least one time entry to import.'); return; }
                    close();
                    await runImport(selected, mappings);
                },
            },
        ],
    });
}

function openAssignModal(desc, mergedEntries, mappings, onDone) {
    const current = mappings[desc] ?? {};
    const local = { project: current.project ?? null, projectTask: current.projectTask ?? null };

    const matching = mergedEntries.filter((e) => (e.description || '').trim() === desc);
    const totalMs = matching.reduce((sum, e) => sum + (e._totalMs ?? 0), 0);
    const dates = [...new Set(matching.map((e) => e.timeInterval.start.split('T')[0]))].sort()
        .map((d) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })).join(', ');
    // Entries are grouped by description, so one group can span several Clockify projects.
    const clockifyProjects = [...new Set(matching.map((e) => e.project?.name).filter(Boolean))].join(', ');

    const projectInput = ui.el('input', { className: 'ppt-input', placeholder: 'Type to search projects…', value: local.project?.name ?? '' });
    const taskInput = ui.el('input', { className: 'ppt-input', placeholder: 'Type to search tasks…', value: local.projectTask?.name ?? '' });
    const asItems = (records) => records.map((record) => ({ label: record.name, record }));

    const projectPicker = ui.suggest({
        input: projectInput, debounce: 300, loading: 'Searching…', empty: 'No results found',
        items: async (text) => (text
            ? asItems(await searchProjects(text))
            : { items: asItems(await recentProjects()), header: 'Recent projects' }),
        onPick: ({ record }) => {
            projectInput.value = record.name;
            local.project = record;
            local.projectTask = null;
            taskInput.value = '';
        },
    });
    const taskPicker = ui.suggest({
        input: taskInput, debounce: 300, loading: 'Searching…', empty: 'No results found',
        items: async (text) => asItems(await searchTasks(text, local.project?.id)),
        onPick: ({ record }) => {
            taskInput.value = record.name;
            local.projectTask = record;
        },
    });

    ui.modal({
        title: 'Assign Project & Task',
        render: (body) => {
            body.append(
                ui.el('div', { className: 'ppt-note' }, [
                    ui.el('div', { style: 'font-weight:600;margin-bottom:4px;color:var(--text)', textContent: desc || '(No description)' }),
                    ui.el('div', { textContent: `⏱️ ${formatDuration(totalMs)} · 📅 ${dates}${matching.length > 1 ? ` · ${matching.length} entries` : ''}` }),
                    ...(clockifyProjects ? [ui.el('div', { textContent: `📁 ${clockifyProjects}` })] : []),
                ]),
                ui.el('label', { className: 'ppt-label', textContent: 'CRM Project' }),
                projectPicker.node,
                ui.el('label', { className: 'ppt-label', textContent: 'CRM Project Task' }),
                taskPicker.node,
            );
        },
        buttons: [{
            label: 'Done', primary: true,
            onClick: (close) => { close(); onDone(local); },
        }],
    });
}

async function runImport(entries, mappings) {
    let results;
    try {
        showLoading('Importing selected time entries into CRM…');
        results = await Promise.all(entries.map((entry) => {
            const mapping = mappings[(entry.description || '').trim()] ?? {};
            return createOrUpdateTimeEntry(entry, mapping.project, mapping.projectTask);
        }));
    } finally {
        hideLoading();
    }

    const errors = results.map((r, i) => (r.error ? `Entry ${i + 1}: ${r.error}` : null)).filter(Boolean);
    const imported = results.length - errors.length;
    ui.modal({
        title: 'Import Results',
        render: (body) => {
            body.append(ui.el('div', {
                style: 'white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto',
                textContent: `Import completed!\n\nImported: ${imported}\nErrors: ${errors.length}`
                    + (errors.length ? `\n\n${errors.join('\n')}` : ''),
            }));
        },
        buttons: [{
            label: 'OK', primary: true,
            onClick: (close) => {
                close();
                if (imported > 0) refreshTimeEntryGrid();
            },
        }],
    });
}

function refreshTimeEntryGrid() {
    try {
        const doc = document.querySelector('iframe[aria-label="Time Entry Grid"]').contentDocument;
        const refresh = doc.querySelector('button[name="Refresh"]');
        if (refresh) { refresh.click(); return; }
        doc.querySelector('button[aria-label="More commands"]')?.click();
        doc.querySelector('button[name="Refresh"]')?.click();
    } catch {
        location.reload();
    }
}

export default {
    async init({ store: toolStore }) {
        dv = new Dataverse();
        store = toolStore;
        ui.addStyle('cs', STYLE);
        config = {
            apiKey: await store.get('clockify_api_key', ''),
            workspaceId: await store.get('clockify_workspace_id', ''),
            userId: await store.get('clockify_user_id', ''),
            timeEntrySettingsId: await store.get('clockify_timeentrysettings_id', ''),
        };
        commands.register({ toolId: 'clockify-sync', title: 'Import from Clockify', icon: '📊', svg: 'clockArrowDownload', run: startImport });
        commands.register({ toolId: 'clockify-sync', title: 'Clockify Sync settings', icon: '🕐', svg: 'settings', kind: 'setting', run: openSettings });
    },
};
