// Audit Viewer (native).
// Fast record change-history browser on the Dataverse audits table: filter by
// entity, record, user, operation and date range; changes render as a compact
// table with old/new values, optionset color pills and clickable lookup links.

import { Dataverse } from '../core/dataverse.js';
import * as ui from '../core/ui.js';
import * as commands from '../core/commands.js';

const PAGE_SIZE = 50;
const OPERATION_LABELS = { 1: 'Create', 2: 'Update', 3: 'Delete', 4: 'Access' };
const AUDIT_PREFER = { Prefer: `odata.include-annotations="*",odata.maxpagesize=${PAGE_SIZE}` };

const STYLE = `
    .audit-backdrop {
        position: fixed; inset: 0; background: rgba(0,0,0,0.3);
        z-index: 2147483000; animation: ppt-fade 0.15s ease;
    }
    .audit-panel {
        position: fixed; top: 0; right: 0; bottom: 0;
        width: 75vw; min-width: 480px; max-width: 1800px;
        background: var(--bg); display: flex; flex-direction: column;
        box-shadow: -4px 0 24px rgba(0,0,0,0.18);
        animation: audit-slide 0.25s ease;
    }
    .audit-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 24px; border-bottom: 1px solid var(--border); flex-shrink: 0;
    }
    .audit-header h2 { margin: 0; font-size: 17px; font-weight: 600; }
    .audit-tag {
        background: var(--bg2); color: var(--accent); padding: 2px 8px;
        border-radius: 4px; font-size: 11px; font-weight: 600;
    }
    .audit-filters { padding: 14px 24px; border-bottom: 1px solid var(--border); background: var(--bg2); flex-shrink: 0; }
    .audit-filter-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
    .audit-filter-row + .audit-filter-row { margin-top: 12px; }
    .audit-group { display: flex; flex-direction: column; position: relative; }
    .audit-group .ppt-label { margin: 0 0 4px; }
    .audit-clear-x {
        position: absolute; right: 8px; bottom: 7px; background: transparent;
        border: none; color: var(--muted); cursor: pointer; font-size: 13px;
        padding: 2px 4px; border-radius: 3px; line-height: 1;
    }
    .audit-clear-x:hover { background: var(--bg); color: var(--text); }
    .audit-dropdown {
        display: none; position: absolute; top: 100%; left: 0; right: 0;
        background: var(--bg); border: 1px solid var(--border);
        border-radius: 0 0 4px 4px; max-height: 200px; overflow-y: auto;
        z-index: 10; box-shadow: var(--shadow);
    }
    .audit-dropdown-item { padding: 8px 12px; cursor: pointer; font-size: 13px; border-bottom: 1px solid var(--border); }
    .audit-dropdown-item:hover { background: var(--bg2); }
    .audit-dropdown-msg { padding: 10px 12px; font-size: 13px; color: var(--muted); }
    .audit-chip {
        padding: 5px 12px; font-size: 12px; font-weight: 600;
        border: 1px solid var(--border); border-radius: 16px;
        background: var(--bg); color: var(--text); cursor: pointer; font-family: inherit;
    }
    .audit-chip:hover, .audit-chip.active { border-color: var(--accent); color: var(--accent); }
    .audit-results { flex: 1; overflow-y: auto; }
    .audit-count { padding: 10px 24px; border-bottom: 1px solid var(--border); font-size: 13px; color: var(--muted); }
    .audit-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .audit-table th {
        text-align: left; padding: 8px 10px; font-weight: 600; color: var(--muted);
        font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px;
        border-bottom: 2px solid var(--border); background: var(--bg2);
        white-space: nowrap; position: sticky; top: 0; z-index: 1;
    }
    .audit-table td { padding: 6px 10px; border-bottom: 1px solid var(--border); vertical-align: top; line-height: 1.4; }
    .audit-table tr.group-start td { border-top: 1px solid var(--border); }
    .audit-old { color: #C50F1F; max-width: 300px; overflow-x: auto; }
    .audit-new { color: #107C10; max-width: 300px; overflow-x: auto; }
    @media (prefers-color-scheme: dark) {
        .audit-old { color: #F1707B; }
        .audit-new { color: #6CCB5F; }
    }
    .audit-link { color: var(--accent); text-decoration: none; font-weight: 600; }
    .audit-link:hover { text-decoration: underline; }
    .audit-icon { width: 16px; height: 16px; vertical-align: middle; margin-right: 4px; object-fit: contain; }
    .audit-pill {
        display: inline-block; padding: 2px 8px; border-radius: 12px;
        font-size: 12px; font-weight: 500; white-space: nowrap;
    }
    .audit-spinner {
        width: 28px; height: 28px; border: 3px solid var(--border);
        border-top-color: var(--accent); border-radius: 50%;
        animation: audit-spin 0.7s linear infinite;
    }
    .audit-center { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 48px; color: var(--muted); }
    .audit-footer {
        display: none; padding: 12px 24px; border-top: 1px solid var(--border);
        background: var(--bg2); flex-shrink: 0; text-align: center;
    }
    .audit-footer .inner { display: inline-flex; align-items: center; gap: 12px; }
    @keyframes audit-slide { from { transform: translateX(100%); } }
    @keyframes audit-spin { to { transform: rotate(360deg); } }
`;

let dv;

// ── Caches ────────────────────────────────────────────────────────────────
const attributeNameCache = {}; // entity -> { logicalName: displayLabel }
const displayNameCache = {};   // "entity,guid" -> primary-name value
const optionsetColorCache = {}; // "entity.attribute" -> { value: hexColor }
const entityInfoCache = {};    // entity -> { displayName, primaryNameAttr, ... } | null
let entityListCache = null;    // auditable entities

// ── Small helpers ─────────────────────────────────────────────────────────
const cleanGuid = (guid) => (guid ? guid.replace(/[{}]/g, '').toLowerCase() : '');
const odataQuote = (s) => s.replace(/'/g, "''");

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

function formatStamp(date, { ms = true } = {}) {
    const dateStr = `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
    if (date.getHours() + date.getMinutes() + date.getSeconds() + date.getMilliseconds() === 0) return dateStr;
    let out = `${dateStr} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    if (ms && date.getMilliseconds()) out += '.' + pad(date.getMilliseconds(), 3);
    return out;
}

function parseDateString(val) {
    if (typeof val !== 'string') return null;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) {
        const d = new Date(val);
        if (!isNaN(d)) return d;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
        const d = new Date(val + 'T00:00:00');
        if (!isNaN(d)) return d;
    }
    const us = val.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?$/);
    if (us) {
        const d = new Date(us[3], us[1] - 1, us[2], us[4] ?? 0, us[5] ?? 0, us[6] ?? 0);
        if (!isNaN(d)) return d;
    }
    return null;
}

function contrastText(hex) {
    const clean = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16));
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5 ? '#000000' : '#ffffff';
}

const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// ── Metadata / lookup helpers ─────────────────────────────────────────────
async function fetchAttributeNames(entityName) {
    if (attributeNameCache[entityName]) return attributeNameCache[entityName];
    try {
        const data = await dv.get(`/EntityDefinitions(LogicalName='${entityName}')/Attributes?$select=LogicalName,DisplayName`);
        const map = {};
        for (const attr of data.value ?? []) {
            map[attr.LogicalName] = attr.DisplayName?.UserLocalizedLabel?.Label || attr.LogicalName;
        }
        return (attributeNameCache[entityName] = map);
    } catch (e) {
        console.warn('[Audit Viewer] no metadata for', entityName, e);
        return {};
    }
}

async function fetchAuditableEntities() {
    if (entityListCache) return entityListCache;
    try {
        const data = await dv.get('/EntityDefinitions?$select=LogicalName,DisplayName,PrimaryNameAttribute,PrimaryIdAttribute,EntitySetName&$filter=IsAuditEnabled/Value eq true');
        entityListCache = (data.value ?? []).map((e) => ({
            logicalName: e.LogicalName,
            displayName: e.DisplayName?.UserLocalizedLabel?.Label || e.LogicalName,
            primaryNameAttr: e.PrimaryNameAttribute,
            primaryIdAttr: e.PrimaryIdAttribute,
            entitySetName: e.EntitySetName,
        })).sort((a, b) => a.displayName.localeCompare(b.displayName));
        return entityListCache;
    } catch (e) {
        console.warn('[Audit Viewer] could not list auditable entities', e);
        return [];
    }
}

async function fetchEntityInfo(entityName) {
    if (!entityName) return null;
    if (entityName in entityInfoCache) return entityInfoCache[entityName];
    try {
        const data = await dv.get(`/EntityDefinitions(LogicalName='${entityName}')?$select=LogicalName,DisplayName,PrimaryNameAttribute,PrimaryIdAttribute,EntitySetName,IconVectorName,IconSmallName`);
        return (entityInfoCache[entityName] = {
            displayName: data.DisplayName?.UserLocalizedLabel?.Label || data.LogicalName,
            primaryNameAttr: data.PrimaryNameAttribute,
            primaryIdAttr: data.PrimaryIdAttribute,
            entitySetName: data.EntitySetName,
            iconName: data.IconSmallName || data.IconVectorName || null,
        });
    } catch (e) {
        console.warn('[Audit Viewer] no entity info for', entityName, e);
        return (entityInfoCache[entityName] = null);
    }
}

async function fetchRecordDisplayName(entityName, recordId) {
    const cacheKey = `${entityName},${recordId}`;
    if (displayNameCache[cacheKey]) return displayNameCache[cacheKey];
    const info = await fetchEntityInfo(entityName);
    if (!info?.entitySetName || !info.primaryNameAttr) return null;
    try {
        const data = await dv.get(`/${info.entitySetName}(${recordId})?$select=${info.primaryNameAttr}`);
        const name = data[info.primaryNameAttr] ?? null;
        if (name) displayNameCache[cacheKey] = name;
        return name;
    } catch {
        return null;
    }
}

async function fetchOptionsetColors(entityName, attributeName) {
    const cacheKey = `${entityName}.${attributeName}`;
    if (optionsetColorCache[cacheKey]) return optionsetColorCache[cacheKey];
    const attrType = attributeName === 'statuscode' ? 'StatusAttributeMetadata'
        : attributeName === 'statecode' ? 'StateAttributeMetadata' : 'PicklistAttributeMetadata';
    try {
        const data = await dv.get(`/EntityDefinitions(LogicalName='${entityName}')/Attributes(LogicalName='${attributeName}')/Microsoft.Dynamics.CRM.${attrType}?$select=LogicalName&$expand=OptionSet($select=Options)`);
        const colors = {};
        for (const option of data.OptionSet?.Options ?? []) {
            if (option.Color) colors[String(option.Value)] = option.Color;
        }
        return (optionsetColorCache[cacheKey] = colors);
    } catch {
        return (optionsetColorCache[cacheKey] = {});
    }
}

async function searchUsers(text) {
    try {
        const data = await dv.get(`/systemusers?$select=systemuserid,fullname&$filter=contains(fullname,'${odataQuote(text)}')&$orderby=fullname asc&$top=20`);
        return (data.value ?? []).map((u) => ({ id: u.systemuserid, name: u.fullname }));
    } catch { return []; }
}

async function searchRecords(entityName, text) {
    const meta = (await fetchAuditableEntities()).find((e) => e.logicalName === entityName);
    if (!meta?.entitySetName || !meta.primaryNameAttr) return [];
    const filter = text ? `&$filter=contains(${meta.primaryNameAttr},'${odataQuote(text)}')` : '';
    try {
        const data = await dv.get(`/${meta.entitySetName}?$select=${meta.primaryIdAttr},${meta.primaryNameAttr}&$top=20&$orderby=${meta.primaryNameAttr} asc${filter}`);
        return (data.value ?? []).map((r) => ({ id: r[meta.primaryIdAttr], name: r[meta.primaryNameAttr] }));
    } catch { return []; }
}

async function fetchUserName(userId) {
    try { return (await dv.get(`/systemusers(${userId})?$select=fullname`)).fullname ?? null; }
    catch { return null; }
}

// ── Value rendering (HTML strings; everything user-sourced is escaped) ────
const recordUrl = (entityName, id) =>
    `${location.origin}/main.aspx?pagetype=entityrecord&etn=${encodeURIComponent(entityName)}&id=${encodeURIComponent(cleanGuid(id))}`;

function buildUserLink(name, userId) {
    if (!userId) return escapeHtml(name);
    return `<a href="${escapeHtml(recordUrl('systemuser', userId))}" target="_blank" class="audit-link" style="font-weight:400">${escapeHtml(name)}</a>`;
}

async function buildRecordLink(displayText, entityName, recordId) {
    const info = await fetchEntityInfo(entityName);
    const icon = info?.iconName
        ? `<img class="audit-icon" src="${escapeHtml(`${location.origin}/WebResources/${info.iconName}`)}" alt="">`
        : '';
    return `${icon}<a href="${escapeHtml(recordUrl(entityName, recordId))}" target="_blank" class="audit-link" title="Open ${escapeHtml(info?.displayName || entityName)} record">${escapeHtml(displayText)}</a>`;
}

function optionsetPill(label, value, colors) {
    if (!label && value == null) return '';
    const text = label || String(value);
    const color = colors && value != null ? colors[String(value)] : null;
    if (!color) return escapeHtml(text);
    const hex = color.startsWith('#') ? color : `#${color}`;
    return `<span class="audit-pill" style="background:${escapeHtml(hex)};color:${contrastText(hex)}">${escapeHtml(text)}</span>`;
}

async function formatValueHtml(val) {
    if (val === null || val === undefined || val === '') return '';
    if (typeof val === 'boolean') return val ? 'Yes' : 'No';
    if (typeof val === 'number') return escapeHtml(String(val));
    if (typeof val === 'string') {
        if (val === 'True') return 'Yes';
        if (val === 'False') return 'No';
        const ref = val.match(/^([a-z_]+),([0-9a-f-]{36})$/i);
        if (ref) {
            const name = await fetchRecordDisplayName(ref[1], ref[2]);
            return buildRecordLink(name || ref[2].slice(0, 8) + '…', ref[1], ref[2]);
        }
        const date = parseDateString(val);
        if (date) return escapeHtml(formatStamp(date));
        return escapeHtml(val);
    }
    const id = val.id ?? val.Id;
    const logicalName = val.logicalName ?? val.LogicalName;
    if (id && logicalName) return buildRecordLink(val.name ?? val.Name ?? id.slice(0, 8) + '…', logicalName, id);
    return escapeHtml(val.name ?? val.Name ?? val.Label ?? (val.Value !== undefined ? String(val.Value) : String(val)));
}

// ── The panel ─────────────────────────────────────────────────────────────
let panelOpen = false;

function getPageContext() {
    const params = new URLSearchParams(location.search);
    const entityName = params.get('etn');
    if (params.get('pagetype') === 'entityrecord' && entityName && params.get('id')) {
        return { entityName, recordId: cleanGuid(params.get('id')) };
    }
    if (params.get('pagetype') === 'entitylist' && entityName) return { entityName };
    return null;
}

function openAuditViewer() {
    if (panelOpen) return;
    panelOpen = true;

    const context = getPageContext();
    const onRecord = !!context?.recordId;
    const filters = {
        entityName: context?.entityName ?? '',
        recordId: context?.recordId ?? '',
        userId: '',
        operation: '',
        startDate: '',
        endDate: '',
    };
    const pages = { list: [], current: 0, totalCount: null };

    const backdrop = ui.mount(ui.el('div', { className: 'ppt audit-backdrop' }));
    let releaseEscape = () => {};
    const dispose = () => { panelOpen = false; backdrop.remove(); releaseEscape(); };
    releaseEscape = ui.onEscape(dispose);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) dispose(); });

    const panel = ui.el('div', { className: 'audit-panel' });
    panel.innerHTML = `
        <div class="audit-header">
            <h2>🔍 Audit Viewer ${onRecord ? `<span class="audit-tag">${escapeHtml(filters.entityName)}</span>` : ''}</h2>
            <button class="ppt-icon-btn" data-act="close" title="Close (Esc)">✕</button>
        </div>
        <div class="audit-filters">
            <div class="audit-filter-row">
                ${onRecord ? `
                <div class="audit-group" style="min-width:200px">
                    <span class="ppt-label">Record</span>
                    <div class="ppt-note" style="margin:0;padding:7px 12px">${escapeHtml(filters.entityName)} — ${escapeHtml(filters.recordId.slice(0, 8))}…</div>
                </div>` : `
                <div class="audit-group" style="flex:1;min-width:160px">
                    <span class="ppt-label">Entity</span>
                    <select class="ppt-select" data-f="entity"><option value="">All entities</option></select>
                </div>
                <div class="audit-group" style="flex:1.5;min-width:180px">
                    <span class="ppt-label">Record</span>
                    <input class="ppt-input" data-f="record" type="text" placeholder="Search by name…" autocomplete="off">
                    <button class="audit-clear-x" data-act="clear-record" hidden>✕</button>
                    <div class="audit-dropdown" data-dd="record"></div>
                </div>`}
                <div class="audit-group" style="flex:1;min-width:180px">
                    <span class="ppt-label">User</span>
                    <input class="ppt-input" data-f="user" type="text" placeholder="Search user…" autocomplete="off">
                    <button class="audit-clear-x" data-act="clear-user" hidden>✕</button>
                    <div class="audit-dropdown" data-dd="user"></div>
                </div>
                <div class="audit-group" style="min-width:120px">
                    <span class="ppt-label">Operation</span>
                    <select class="ppt-select" data-f="operation">
                        <option value="">All</option>
                        <option value="1">Create</option><option value="2">Update</option>
                        <option value="3">Delete</option><option value="4">Access</option>
                    </select>
                </div>
            </div>
            <div class="audit-filter-row">
                <div class="audit-group" style="min-width:140px">
                    <span class="ppt-label">From</span>
                    <input class="ppt-input" data-f="start" type="date">
                </div>
                <div class="audit-group" style="min-width:140px">
                    <span class="ppt-label">To</span>
                    <input class="ppt-input" data-f="end" type="date">
                </div>
                <div style="display:flex;gap:4px">
                    <button class="audit-chip" data-range="today">Today</button>
                    <button class="audit-chip" data-range="7">7 days</button>
                    <button class="audit-chip" data-range="30">30 days</button>
                    <button class="audit-chip" data-range="90">90 days</button>
                </div>
                <div style="flex:1"></div>
                <div style="display:flex;gap:8px">
                    <button class="ppt-btn" data-act="clear">Clear</button>
                    <button class="ppt-btn primary" data-act="search">🔍 Search</button>
                </div>
            </div>
        </div>
        <div class="audit-results">
            <div class="audit-count" hidden></div>
            <div class="audit-list">
                <div class="audit-center">Configure filters and click Search to view audit entries.</div>
            </div>
        </div>
        <div class="audit-footer">
            <span class="inner">
                <button class="ppt-btn" data-act="prev">◀ Previous</button>
                <span class="audit-page-info" style="font-size:13px;color:var(--muted)"></span>
                <button class="ppt-btn" data-act="next">Next ▶</button>
            </span>
        </div>`;
    backdrop.appendChild(panel);

    const $ = (sel) => panel.querySelector(sel);
    const list = $('.audit-list');
    const countEl = $('.audit-count');
    const footer = $('.audit-footer');

    // ── Typeahead dropdowns ──────────────────────────────────────────────
    function wireTypeahead({ input, dropdown, clearBtn, search, onPick, onType }) {
        let timer = null;
        input.addEventListener('input', () => {
            clearTimeout(timer);
            onType();
            clearBtn.hidden = true;
            timer = setTimeout(async () => {
                const text = input.value.trim();
                const items = await search(text);
                if (items === null) return; // search decided to hide/skip
                dropdown.replaceChildren(...(items.length
                    ? items.map((item) => {
                        const node = ui.el('div', { className: 'audit-dropdown-item', textContent: item.name });
                        node.addEventListener('mousedown', () => {
                            input.value = item.name;
                            clearBtn.hidden = false;
                            dropdown.style.display = 'none';
                            onPick(item);
                        });
                        return node;
                    })
                    : [ui.el('div', { className: 'audit-dropdown-msg', textContent: 'No results found' })]));
                dropdown.style.display = 'block';
            }, 350);
        });
        input.addEventListener('blur', () => setTimeout(() => { dropdown.style.display = 'none'; }, 200));
        clearBtn.addEventListener('click', () => {
            input.value = '';
            clearBtn.hidden = true;
            onType();
        });
    }

    if (!onRecord) {
        wireTypeahead({
            input: $('[data-f=record]'),
            dropdown: $('[data-dd=record]'),
            clearBtn: $('[data-act=clear-record]'),
            onType: () => { filters.recordId = ''; },
            onPick: (item) => { filters.recordId = item.id; },
            search: async (text) => {
                const entityName = $('[data-f=entity]').value;
                if (!entityName) {
                    if (text.length >= 2) {
                        $('[data-dd=record]').replaceChildren(ui.el('div', { className: 'audit-dropdown-msg', textContent: 'Select an entity first' }));
                        $('[data-dd=record]').style.display = 'block';
                    }
                    return null;
                }
                if (text.length < 2) { $('[data-dd=record]').style.display = 'none'; return null; }
                return searchRecords(entityName, text);
            },
        });
        $('[data-f=entity]').addEventListener('change', () => {
            filters.recordId = '';
            $('[data-f=record]').value = '';
            $('[data-act=clear-record]').hidden = true;
        });
        fetchAuditableEntities().then((entities) => {
            $('[data-f=entity]')?.append(...entities.map((e) => ui.el('option', {
                value: e.logicalName,
                textContent: `${e.displayName} (${e.logicalName})`,
                selected: e.logicalName === filters.entityName,
            })));
        });
    }

    wireTypeahead({
        input: $('[data-f=user]'),
        dropdown: $('[data-dd=user]'),
        clearBtn: $('[data-act=clear-user]'),
        onType: () => { filters.userId = ''; },
        onPick: (item) => { filters.userId = item.id; },
        search: async (text) => {
            if (text.length < 2) { $('[data-dd=user]').style.display = 'none'; return null; }
            return searchUsers(text);
        },
    });

    // ── Filter actions ───────────────────────────────────────────────────
    $('[data-act=close]').addEventListener('click', dispose);

    for (const chip of panel.querySelectorAll('.audit-chip')) {
        chip.addEventListener('click', () => {
            const start = new Date();
            if (chip.dataset.range !== 'today') start.setDate(start.getDate() - Number(chip.dataset.range));
            $('[data-f=start]').value = isoDate(start);
            $('[data-f=end]').value = isoDate(new Date());
            panel.querySelectorAll('.audit-chip').forEach((c) => c.classList.toggle('active', c === chip));
        });
    }

    function gatherFilters() {
        if (!onRecord) filters.entityName = $('[data-f=entity]')?.value ?? '';
        filters.operation = $('[data-f=operation]').value;
        filters.startDate = $('[data-f=start]').value;
        filters.endDate = $('[data-f=end]').value;
    }

    $('[data-act=search]').addEventListener('click', () => { gatherFilters(); performSearch(); });
    panel.querySelectorAll('.ppt-input, .ppt-select').forEach((element) =>
        element.addEventListener('keydown', (e) => { if (e.key === 'Enter') { gatherFilters(); performSearch(); } }));

    $('[data-act=clear]').addEventListener('click', () => {
        for (const input of panel.querySelectorAll('.ppt-input')) input.value = '';
        for (const select of panel.querySelectorAll('.ppt-select')) select.value = '';
        panel.querySelectorAll('.audit-chip').forEach((c) => c.classList.remove('active'));
        panel.querySelectorAll('.audit-clear-x').forEach((b) => { b.hidden = true; });
        Object.assign(filters, {
            entityName: onRecord ? context.entityName : '',
            recordId: onRecord ? context.recordId : '',
            userId: '', operation: '', startDate: '', endDate: '',
        });
        pages.list = []; pages.current = 0; pages.totalCount = null;
        countEl.hidden = true;
        footer.style.display = 'none';
        list.replaceChildren(ui.el('div', { className: 'audit-center', textContent: 'Configure filters and click Search to view audit entries.' }));
    });

    $('[data-act=prev]').addEventListener('click', () => {
        if (pages.current > 0) { pages.current--; renderResults(); }
    });
    $('[data-act=next]').addEventListener('click', async () => {
        if (pages.list[pages.current + 1]) { pages.current++; renderResults(); return; }
        const nextLink = pages.list[pages.current]?.nextLink;
        if (!nextLink) return;
        showLoading();
        try {
            const data = await dv.get(nextLink, AUDIT_PREFER);
            pages.list.push({ entities: data.value ?? [], nextLink: data['@odata.nextLink'] ?? null });
            pages.current++;
            renderResults();
        } catch (e) {
            if (e.status !== 403) console.error('[Audit Viewer] fetch error:', e);
            showError(e);
        }
    });

    // ── Search & rendering ───────────────────────────────────────────────
    function showLoading() {
        countEl.hidden = true;
        footer.style.display = 'none';
        list.innerHTML = '<div class="audit-center"><div class="audit-spinner"></div>Loading audit entries…</div>';
    }

    function showError(error) {
        const forbidden = error?.status === 403;
        const title = forbidden ? 'You don’t have permission to view audit history' : 'Error loading audits';
        const detail = forbidden
            ? 'Your security role needs Read access to the Audit table (and auditing must be enabled for this table).'
            : error?.message ?? String(error);
        list.replaceChildren(ui.el('div', { className: 'audit-center' }, [
            ui.el('div', { style: 'color:var(--danger);font-weight:600', textContent: title }),
            ui.el('div', { style: 'font-size:13px;max-width:520px;word-break:break-word', textContent: detail }),
            ui.el('div', { style: 'font-size:12px', textContent: 'Make sure auditing is enabled and you have the required permissions.' }),
        ]));
    }

    async function performSearch() {
        pages.list = []; pages.current = 0; pages.totalCount = null;
        showLoading();
        try {
            const parts = [
                '$select=auditid,createdon,_objectid_value,objecttypecode,_userid_value,_callinguserid_value,action,operation,changedata',
                '$orderby=createdon desc',
                '$count=true',
            ];
            const predicates = [];
            if (filters.recordId) predicates.push(`_objectid_value eq ${filters.recordId}`);
            if (filters.entityName) predicates.push(`objecttypecode eq '${filters.entityName}'`);
            if (filters.userId) predicates.push(`_userid_value eq ${filters.userId}`);
            if (filters.startDate) predicates.push(`createdon ge ${filters.startDate}T00:00:00Z`);
            if (filters.endDate) predicates.push(`createdon le ${filters.endDate}T23:59:59Z`);
            if (filters.operation) predicates.push(`operation eq ${filters.operation}`);
            if (predicates.length) parts.push('$filter=' + predicates.join(' and '));

            const data = await dv.get('/audits?' + parts.join('&'), AUDIT_PREFER);
            pages.list.push({ entities: data.value ?? [], nextLink: data['@odata.nextLink'] ?? null });
            pages.totalCount = typeof data['@odata.count'] === 'number' ? data['@odata.count'] : null;
            renderResults();
        } catch (e) {
            // 403 = user can't read the audit table (no privilege or auditing off).
            // That's an expected user-state, not an extension error — don't shout in the console.
            if (e.status !== 403) console.error('[Audit Viewer] fetch error:', e);
            showError(e);
        }
    }

    function renderResults() {
        const page = pages.list[pages.current];
        if (!page?.entities.length) {
            countEl.hidden = true;
            footer.style.display = 'none';
            list.replaceChildren(ui.el('div', { className: 'audit-center', textContent: 'No audit entries found for the current filters.' }));
            return;
        }

        const start = pages.current * PAGE_SIZE + 1;
        countEl.hidden = false;
        countEl.textContent = `Showing ${start}–${start + page.entities.length - 1}`
            + (pages.totalCount !== null ? ` of ${pages.totalCount.toLocaleString()}` : '') + ' audit entries';

        const showRecordCol = !onRecord;
        const colCount = showRecordCol ? 7 : 6;
        list.innerHTML = `
            <table class="audit-table">
                <thead><tr>
                    <th style="width:140px">Date</th>
                    ${showRecordCol ? '<th style="width:200px">Record</th>' : ''}
                    <th style="width:200px">Changed by</th>
                    <th style="width:80px">Event</th>
                    <th style="width:160px">Changed Field</th>
                    <th>Old Value</th><th>New Value</th>
                </tr></thead>
                <tbody><tr><td colspan="${colCount}" class="audit-center">Loading changes…</td></tr></tbody>
            </table>`;

        buildRows(page.entities, showRecordCol).then((rows) => {
            const tbody = list.querySelector('tbody');
            if (!tbody) return;
            tbody.innerHTML = rows.length ? rows.join('')
                : `<tr><td colspan="${colCount}" class="audit-center">No field-level changes found.</td></tr>`;
            // Icons come from WebResources; hide broken ones (no inline handlers — page CSP).
            for (const img of tbody.querySelectorAll('img.audit-icon')) {
                img.addEventListener('error', () => { img.style.display = 'none'; });
            }
        });

        const hasPrev = pages.current > 0;
        const hasNext = !!page.nextLink || !!pages.list[pages.current + 1];
        footer.style.display = hasPrev || hasNext ? 'block' : 'none';
        $('[data-act=prev]').disabled = !hasPrev;
        $('[data-act=next]').disabled = !hasNext;
        $('.audit-page-info').textContent = `Page ${pages.current + 1}`;
        $('.audit-results').scrollTop = 0;
    }

    async function buildRows(entities, showRecordCol) {
        const rows = [];
        for (const audit of entities) {
            const opLabel = audit['operation@OData.Community.Display.V1.FormattedValue']
                || OPERATION_LABELS[audit.operation] || 'Unknown';
            const entityName = audit['_objectid_value@Microsoft.Dynamics.CRM.lookuplogicalname'] || audit.objecttypecode || '';
            const objectId = audit._objectid_value || '';
            const objectName = audit['_objectid_value@OData.Community.Display.V1.FormattedValue'] || objectId.slice(0, 8) + '…';
            const createdOn = audit.createdon ? formatStamp(new Date(audit.createdon)) : '';

            const recordHtml = showRecordCol ? await buildRecordLink(objectName, entityName, objectId) : '';

            const userId = audit._userid_value || '';
            const userName = audit['_userid_value@OData.Community.Display.V1.FormattedValue'] || '';
            const callUserId = audit._callinguserid_value || '';
            let userHtml = buildUserLink(userName, userId);
            if (callUserId && userId && callUserId !== userId) {
                const callName = audit['_callinguserid_value@OData.Community.Display.V1.FormattedValue']
                    || await fetchUserName(callUserId) || 'Unknown';
                userHtml += ` <span style="color:var(--muted);font-size:11px">(by ${buildUserLink(callName, callUserId)})</span>`;
            }

            let changes = [];
            try { changes = JSON.parse(audit.changedata ?? '{}').changedAttributes ?? []; }
            catch { /* not JSON changedata */ }

            const labels = changes.length ? await fetchAttributeNames(entityName) : {};

            if (!changes.length) {
                rows.push(`<tr class="group-start">
                    <td>${escapeHtml(createdOn)}</td>
                    ${showRecordCol ? `<td>${recordHtml}</td>` : ''}
                    <td>${userHtml}</td><td>${escapeHtml(opLabel)}</td>
                    <td colspan="3" style="color:var(--muted);font-style:italic">No field changes</td>
                </tr>`);
                continue;
            }

            for (let i = 0; i < changes.length; i++) {
                const attr = changes[i];
                const label = labels[attr.logicalName] || attr.logicalName;
                let oldHtml, newHtml;
                if (attr.oldName !== undefined || attr.newName !== undefined) {
                    const colors = await fetchOptionsetColors(entityName, attr.logicalName);
                    oldHtml = optionsetPill(attr.oldName ?? '', attr.oldValue, colors);
                    newHtml = optionsetPill(attr.newName ?? '', attr.newValue, colors);
                } else {
                    oldHtml = await formatValueHtml(attr.oldValue);
                    newHtml = await formatValueHtml(attr.newValue);
                }
                rows.push(i === 0
                    ? `<tr class="group-start">
                        <td rowspan="${changes.length}">${escapeHtml(createdOn)}</td>
                        ${showRecordCol ? `<td rowspan="${changes.length}">${recordHtml}</td>` : ''}
                        <td rowspan="${changes.length}">${userHtml}</td>
                        <td rowspan="${changes.length}">${escapeHtml(opLabel)}</td>
                        <td>${escapeHtml(label)}</td>
                        <td class="audit-old">${oldHtml}</td><td class="audit-new">${newHtml}</td>
                    </tr>`
                    : `<tr><td>${escapeHtml(label)}</td>
                        <td class="audit-old">${oldHtml}</td><td class="audit-new">${newHtml}</td>
                    </tr>`);
            }
        }
        return rows;
    }

    if (context) performSearch();
}

export default {
    init() {
        dv = new Dataverse();
        ui.addStyle('audit', STYLE);
        commands.register({
            toolId: 'audit-viewer',
            title: 'Open Audit Viewer',
            icon: '📋',
            run: openAuditViewer,
        });
    },
};
