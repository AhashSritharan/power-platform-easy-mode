// Record Editor (native).
// Shows every column of the current Dataverse record, bypassing the form:
// filter by name, logical name or value, and edit any updatable column in
// place with type-appropriate inputs (text, numbers, dates, choices, yes/no,
// multi-select, lookups incl. polymorphic targets), set values to NULL
// explicitly, then PATCH all pending changes via the Web API. File and image
// columns are shown read-only: a download link, and a thumbnail that opens
// the full image.

import { Dataverse } from '../core/dataverse.js';
import * as ui from '../core/ui.js';
import * as commands from '../core/commands.js';
import { openRecordForm } from '../core/agent.js';
import {
    cleanGuid, fetchEntityInfo, fetchRecordDisplayName, fetchOptionsetColors, entityIconUrl, choiceColor,
} from './shared/records.js';
import { fileLink, imageThumb } from './shared/record-files.js';

let dv;

const STYLE = `
    .fe-backdrop {
        position: fixed; inset: 0; background: rgba(0,0,0,0.4);
        z-index: 2147483000; display: flex; align-items: center; justify-content: center;
        animation: ppt-fade 0.15s ease;
    }
    .fe-modal {
        width: 1200px; max-width: 94vw; height: 90vh;
        background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
        box-shadow: var(--shadow); display: flex; flex-direction: column;
        animation: ppt-pop 0.15s ease;
    }
    .fe-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 24px; border-bottom: 1px solid var(--border); flex-shrink: 0;
    }
    .fe-header h2 { margin: 0; font-size: 17px; font-weight: 600; }
    .fe-tag { background: var(--bg2); color: var(--accent); padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; margin-left: 10px; }
    .fe-record { font-size: 13px; color: var(--muted); font-weight: 400; margin-left: 10px; }
    .fe-toolbar {
        display: flex; align-items: center; gap: 16px; padding: 12px 24px;
        border-bottom: 1px solid var(--border); flex-shrink: 0;
    }
    .fe-toolbar .ppt-input { flex: 1; }
    .fe-toggle { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); cursor: pointer; white-space: nowrap; }
    .fe-count { font-size: 12px; color: var(--muted); white-space: nowrap; }
    .fe-body { flex: 1; overflow-y: auto; padding: 0 24px 16px; }
    .fe-body > .fe-msg { margin-top: 12px; }
    .fe-tr {
        display: grid; grid-template-columns: minmax(0, 2fr) 120px minmax(0, 3fr) 64px;
        gap: 12px; align-items: start; padding: 6px 8px;
        border-bottom: 1px solid var(--border); border-left: 3px solid transparent;
    }
    .fe-tr[hidden], .fe-view[hidden], .fe-edit[hidden] { display: none; }
    .fe-tr:hover { background: var(--bg2); }
    .fe-tr.changed { border-left-color: var(--accent); background: var(--bg2); }
    .fe-tr.editing { background: var(--bg2); }
    .fe-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fe-logical { font-size: 11px; color: var(--muted); font-family: Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fe-type { font-size: 11px; color: var(--muted); white-space: nowrap; }
    .fe-val { font-size: 13px; line-height: 1.45; min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
    /* Long values are cut off rather than scrolled: a scroll box inside the
       list would catch the wheel mid-scroll whenever the pointer crosses it. */
    /* The full value opens in a dialog, so rows keep a steady height. */
    .fe-val.clamped { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden; }
    .fe-more {
        margin-top: 4px; padding: 2px 10px; border: 1px solid var(--border); border-radius: 12px;
        background: var(--bg2); color: var(--muted); font: inherit; font-size: 11px; font-weight: 600; cursor: pointer;
    }
    .fe-more:hover { color: var(--accent); border-color: var(--accent); }
    .fe-full { margin: 0; font-family: Consolas, monospace; font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
    .fe-full-edit { display: block; height: 60vh; resize: vertical; padding: 8px 10px; }
    /* JSON editor: a transparent textarea over a highlighted copy of its text.
       Both must lay text out identically, so they share every metric. */
    .fe-code { position: relative; height: 60vh; }
    .fe-code > pre, .fe-code > textarea {
        position: absolute; inset: 0; margin: 0; padding: 8px 10px; box-sizing: border-box;
        border: 1px solid var(--border); border-radius: 5px; overflow-y: scroll;
        font-family: Consolas, monospace; font-size: 12px; line-height: 1.5;
        white-space: pre-wrap; overflow-wrap: anywhere; letter-spacing: 0;
    }
    .fe-code > pre { background: var(--bg); color: var(--text); pointer-events: none; }
    .fe-code > textarea {
        background: transparent; color: transparent; caret-color: var(--text);
        resize: none; outline: none;
    }
    .fe-code > textarea:focus { border-color: var(--accent); }
    .fe-j-key { color: #0451a5; }
    .fe-j-str { color: #a31515; }
    .fe-j-num { color: #098658; }
    .fe-j-lit { color: #0000ff; }
    .fe-j-pun { color: var(--muted); }
    @media (prefers-color-scheme: dark) {
        .fe-j-key { color: #9cdcfe; }
        .fe-j-str { color: #ce9178; }
        .fe-j-num { color: #b5cea8; }
        .fe-j-lit { color: #569cd6; }
    }
    .fe-json-status { flex: 1; align-self: center; font-size: 12px; color: #107C10; }
    .fe-json-status.bad { color: var(--danger); }
    @media (prefers-color-scheme: dark) { .fe-json-status { color: #6CCB5F; } }
    .fe-val.empty { color: var(--muted); font-style: italic; }
    .fe-val.editable { cursor: pointer; }
    .fe-val .link { color: var(--accent); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
    .fe-icon { width: 16px; height: 16px; vertical-align: middle; margin-right: 6px; object-fit: contain;
        /* Table icons are drawn for light backgrounds — keep them visible in dark mode. */
        background: #fff; padding: 2px; border-radius: 3px; box-sizing: content-box;
    }
    .fe-pill { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; }
    .fe-raw { font-size: 11px; color: var(--muted); font-family: Consolas, monospace; margin-left: 6px; }
    .fe-actions { display: flex; justify-content: flex-end; gap: 2px; }
    .fe-actions .ppt-icon-btn { font-size: 13px; padding: 2px 6px; visibility: hidden; }
    .fe-tr:hover .fe-actions .ppt-icon-btn, .fe-tr.editing .fe-actions .ppt-icon-btn { visibility: visible; }
    .fe-cell { min-width: 0; }
    .fe-edit { padding: 2px 0; }
    .fe-pending { flex: 1; font-size: 12px; color: var(--muted); align-self: center; }
    .fe-footer {
        display: flex; justify-content: flex-end; gap: 8px; padding: 14px 24px;
        border-top: 1px solid var(--border); background: var(--bg2); flex-shrink: 0;
    }
    .fe-search { position: relative; }
    .fe-input-row { display: flex; align-items: flex-start; gap: 8px; }
    .fe-input-row > .ppt-input, .fe-input-row > .ppt-select { flex: 1; }
    .fe-input-row.null-state .ppt-input, .fe-input-row.null-state .ppt-select,
    .fe-input-row.null-state .fe-chipset { opacity: 0.5; pointer-events: none; }
    .fe-null-btn {
        padding: 6px 10px; background: var(--bg); border: 1px solid var(--danger);
        color: var(--danger); border-radius: 4px; font-size: 11px; font-weight: 600;
        cursor: pointer; white-space: nowrap; font-family: inherit;
    }
    /* While editing, the box itself may scroll: the pointer is meant to be there. */
    .fe-textarea { resize: vertical; font-size: 13px; line-height: inherit; overflow-wrap: anywhere; }
    .fe-side { display: flex; flex-direction: column; gap: 6px; }
    .fe-format-btn { border-color: var(--border); color: var(--text); }
    .fe-null-btn.cleared { background: #107C10; border-color: #107C10; color: #fff; }
    .fe-null-note {
        display: inline-block; margin-bottom: 8px; padding: 4px 10px;
        background: #FFF4CE; border: 1px solid #F5D06C; color: #835C00;
        border-radius: 4px; font-size: 11px; font-weight: 600;
    }
    .fe-selected {
        display: flex; align-items: center; gap: 8px; padding: 6px 12px;
        background: var(--bg); border: 1px solid var(--accent); border-radius: 4px; margin-bottom: 8px;
    }
    .fe-selected .name { flex: 1; font-size: 13px; color: var(--accent); font-weight: 500; }
    .fe-selected .name.link { cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
    .fe-selected .name.link:hover { filter: brightness(1.2); }
    .fe-selected .id { font-size: 10px; color: var(--muted); font-family: Consolas, monospace; }
    .fe-chipset {
        display: flex; flex-wrap: wrap; gap: 6px; padding: 8px;
        background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
        max-height: 150px; overflow-y: auto; flex: 1;
    }
    .fe-chip {
        padding: 4px 10px; font-size: 12px; border: 1px solid var(--border);
        border-radius: 16px; background: var(--bg); color: var(--text); cursor: pointer;
    }
    .fe-chip:hover, .fe-chip.selected { border-color: var(--accent); color: var(--accent); }
    .fe-msg { padding: 12px 16px; border-radius: 6px; font-size: 13px; margin-bottom: 16px; }
    .fe-msg.error { background: #FDE7E9; border: 1px solid #F1BBBC; color: #D13438; }
    .fe-msg.success { background: #DFF6DD; border: 1px solid #A7E3A5; color: #107C10; }
    @media (prefers-color-scheme: dark) {
        .fe-msg.error { background: #3a1416; color: #F1707B; }
        .fe-msg.success { background: #10380f; color: #6CCB5F; }
        .fe-null-note { background: #3d3010; color: #F5D06C; }
    }
    .fe-empty { text-align: center; padding: 32px; color: var(--muted); font-size: 13px; }
    .fe-spinner {
        display: inline-block; width: 16px; height: 16px; margin-right: 8px;
        border: 2px solid var(--border); border-top-color: var(--accent);
        border-radius: 50%; animation: fe-spin 0.7s linear infinite; vertical-align: middle;
    }
    @keyframes fe-spin { to { transform: rotate(360deg); } }
`;

const TYPE_LABELS = {
    String: 'Text', Memo: 'Multiline Text', Integer: 'Whole Number', BigInt: 'Big Integer',
    Double: 'Float', Decimal: 'Decimal', Money: 'Currency', Boolean: 'Yes/No',
    DateTime: 'Date Time', Picklist: 'Choice', State: 'Status', Status: 'Status Reason',
    Lookup: 'Lookup', Customer: 'Customer', Owner: 'Owner',
    Uniqueidentifier: 'GUID', MultiSelectPicklist: 'Choices', File: 'File', Image: 'Image',
};
const LOOKUP_TYPES = ['Lookup', 'Customer', 'Owner'];
const TEXT_TYPES = ['String', 'Memo'];
// Stored off the record: read-only here, shown by shared/record-files.js.
const MEDIA_TYPES = ['File', 'Image'];
// Multi-select choices, files and images all report AttributeType 'Virtual';
// their AttributeTypeName says which they are.
const VIRTUAL_TYPES = { MultiSelectPicklistType: 'MultiSelectPicklist', FileType: 'File', ImageType: 'Image' };
const HIDDEN_TYPES =['Virtual', 'CalendarRules', 'ManagedProperty', 'PartyList'];
const label = (attr) => attr.DisplayName?.UserLocalizedLabel?.Label || attr.LogicalName;
const optionLabel = (o) => o.Label?.UserLocalizedLabel?.Label || `Value ${o.Value}`;

// ── Metadata (cached) ─────────────────────────────────────────────────────
const attributesCache = {};
const navPropCache = {};

async function getAttributes(entityName) {
    if (!attributesCache[entityName]) {
        const data = await dv.get(`/EntityDefinitions(LogicalName='${entityName}')/Attributes?$select=LogicalName,DisplayName,AttributeType,AttributeTypeName,AttributeOf,IsValidForRead,IsValidForUpdate`);
        // Other virtual columns and AttributeOf companions (lookup names, yomi
        // fields, an image's url and timestamp) have no value of their own
        // worth showing.
        attributesCache[entityName] = (data.value ?? [])
            .map((a) => (VIRTUAL_TYPES[a.AttributeTypeName?.Value] ? { ...a, AttributeType: VIRTUAL_TYPES[a.AttributeTypeName.Value] } : a))
            // An image column names its id column as AttributeOf; the image is
            // kept and the bare id (entityimageid) goes instead.
            .filter((a, _, all) => a.IsValidForRead && !HIDDEN_TYPES.includes(a.AttributeType)
                && (!a.AttributeOf || MEDIA_TYPES.includes(a.AttributeType))
                && !all.some((m) => m.AttributeType === 'Image' && m.AttributeOf === a.LogicalName))
            .sort((a, b) => label(a).localeCompare(label(b)));
    }
    return attributesCache[entityName];
}

async function getTypedAttribute(entityName, attributeName, cast, expand) {
    try {
        return await dv.get(`/EntityDefinitions(LogicalName='${entityName}')/Attributes(LogicalName='${attributeName}')/Microsoft.Dynamics.CRM.${cast}?$select=LogicalName&$expand=OptionSet(${expand})`);
    } catch (e) {
        console.warn('[Record Editor] metadata fetch failed:', e);
        return null;
    }
}

const getOptions = async (entity, attr, cast) =>
    (await getTypedAttribute(entity, attr, cast, '$select=Options'))?.OptionSet?.Options ?? [];

async function getLookupTargets(entityName, attributeName) {
    try {
        const data = await dv.get(`/EntityDefinitions(LogicalName='${entityName}')/Attributes(LogicalName='${attributeName}')/Microsoft.Dynamics.CRM.LookupAttributeMetadata?$select=Targets`);
        return data.Targets ?? [];
    } catch { return []; }
}

// The Web API needs the real navigation property name for @odata.bind and for
// nulling a lookup — guessing from the logical name breaks on custom lookups
// (mixed-case schema names) and polymorphic Customer lookups.
async function getLookupNavProp(entityName, attributeName, targetEntity) {
    const key = `${entityName}.${attributeName}.${targetEntity}`;
    if (navPropCache[key] !== undefined) return navPropCache[key];
    try {
        const data = await dv.get(`/EntityDefinitions(LogicalName='${entityName}')/ManyToOneRelationships?$select=ReferencingEntityNavigationPropertyName,ReferencedEntity,ReferencingAttribute&$filter=ReferencingAttribute eq '${attributeName}'`);
        const relationships = data.value ?? [];
        const match = relationships.find((r) => r.ReferencedEntity === targetEntity) ?? relationships[0];
        return (navPropCache[key] = match?.ReferencingEntityNavigationPropertyName ?? attributeName);
    } catch {
        return (navPropCache[key] = attributeName);
    }
}

async function searchRecords(targetEntity, text) {
    const info = await fetchEntityInfo(targetEntity);
    if (!info) throw new Error(`No metadata for ${targetEntity}`);
    const filter = text ? `&$filter=contains(${info.primaryNameAttr},'${encodeURIComponent(text.replace(/'/g, "''"))}')` : '';
    const data = await dv.get(`/${info.entitySetName}?$select=${info.primaryNameAttr}&$top=20${filter}`);
    return (data.value ?? []).map((r) => ({
        id: r[info.primaryIdAttr],
        name: r[info.primaryNameAttr] || '(No name)',
    }));
}

// ── Read current value off the record for an attribute ────────────────────
function valueFromRecord(attr, record) {
    if (!record) return {};
    const name = attr.LogicalName;
    if (LOOKUP_TYPES.includes(attr.AttributeType)) {
        return {
            value: record[`_${name}_value`] ?? null,
            displayValue: record[`_${name}_value@OData.Community.Display.V1.FormattedValue`] ?? null,
            lookupTarget: record[`_${name}_value@Microsoft.Dynamics.CRM.lookuplogicalname`] ?? null,
        };
    }
    if (attr.AttributeType === 'DateTime') {
        const iso = record[name];
        if (!iso) return { value: null };
        const d = new Date(iso);
        const pad = (n) => String(n).padStart(2, '0');
        return { value: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` };
    }
    if (attr.AttributeType === 'MultiSelectPicklist') {
        const raw = record[name];
        return { value: raw ? raw.split(',').map((v) => parseInt(v.trim(), 10)) : null };
    }
    return {
        value: record[name] ?? null,
        displayValue: record[`${name}@OData.Community.Display.V1.FormattedValue`] ?? null,
    };
}

// ── Editor UI ─────────────────────────────────────────────────────────────
function selectedBadge(name, id, onClear, onOpen = null) {
    const nameEl = ui.el('span', { className: 'name', textContent: name });
    if (onOpen) {
        nameEl.classList.add('link');
        nameEl.title = 'Open this record';
        nameEl.addEventListener('click', onOpen);
    }
    const badge = ui.el('div', { className: 'fe-selected' }, [
        nameEl,
        ui.el('span', { className: 'id', textContent: id ?? '' }),
        ui.el('button', { className: 'ppt-icon-btn', textContent: '✕', style: 'font-size:14px;padding:2px 4px', onclick: onClear }),
    ]);
    return badge;
}

const recordUrl = (entityName, id) =>
    `${location.origin}/main.aspx?pagetype=entityrecord&etn=${encodeURIComponent(entityName)}&id=${encodeURIComponent(cleanGuid(id))}`;

// Xrm lives in the page's MAIN world, so openForm goes through the page agent.
// A plain URL keeps the link working if the agent or Xrm isn't there.
async function openLookupRecord(entityName, id) {
    if (!entityName || !id) { ui.toast('⚠️ No target record to open.'); return; }
    const result = await openRecordForm(entityName, cleanGuid(id));
    if (!result.ok) window.open(recordUrl(entityName, id), '_blank', 'noopener');
}

// "Format JSON" for a text value that parses as a JSON object or array.
function jsonFormatButton(input, onChange, onResize) {
    const parse = () => {
        if (!/^\s*[{[]/.test(input.value)) return null;
        try { return JSON.parse(input.value); } catch { return null; }
    };
    if (!parse()) return null;
    return ui.el('button', {
        className: 'fe-null-btn fe-format-btn', type: 'button', textContent: 'Format JSON',
        onclick: () => {
            const json = parse();
            if (!json) { ui.toast('⚠️ Not valid JSON anymore.'); return; }
            input.value = JSON.stringify(json, null, 2);
            onChange();
            onResize();
        },
    });
}

async function buildFieldInput(fieldState, container, entityName) {
    const attr = fieldState.attribute;
    const type = attr.AttributeType;
    container.innerHTML = '<div class="fe-empty"><span class="fe-spinner"></span>Loading options…</div>';

    const row = ui.el('div', { className: 'fe-input-row' });
    const nullBtn = ui.el('button', { className: 'fe-null-btn', type: 'button', textContent: 'Set Null' });
    let nullNote = null;

    const setNullState = () => {
        fieldState.setToNull = true;
        fieldState.value = null;
        nullBtn.textContent = '✓ Cleared';
        nullBtn.classList.add('cleared');
        row.classList.add('null-state');
        if (!nullNote) {
            nullNote = ui.el('div', { className: 'fe-null-note', textContent: '⚠ Will be set to NULL on save' });
            container.prepend(nullNote);
        }
    };
    const clearNullState = () => {
        fieldState.setToNull = false;
        nullBtn.textContent = 'Set Null';
        nullBtn.classList.remove('cleared');
        row.classList.remove('null-state');
        nullNote?.remove();
        nullNote = null;
    };
    nullBtn.addEventListener('click', () => {
        setNullState();
        const input = row.querySelector('input,select,textarea');
        if (input) input.value = '';
        row.querySelectorAll('.fe-chip.selected').forEach((c) => c.classList.remove('selected'));
        container.querySelector('.fe-selected')?.remove();
    });

    const numberParse = { Integer: (v) => parseInt(v, 10), BigInt: (v) => parseInt(v, 10), Double: parseFloat, Decimal: parseFloat, Money: parseFloat };

    if (type === 'Memo' || type === 'String' || numberParse[type] || type === 'DateTime' || type === 'Uniqueidentifier') {
        // Long or multi-line text (JSON blobs are common in text columns) gets a
        // textarea that grows with its content instead of a one-line input.
        const text = typeof fieldState.value === 'string' ? fieldState.value : '';
        const multiline = type === 'Memo' || (type === 'String' && (text.length > 60 || text.includes('\n')));
        const input = multiline
            ? ui.el('textarea', {
                className: 'ppt-input fe-textarea',
                rows: 1, value: fieldState.value ?? '',
            })
            : ui.el('input', {
                className: 'ppt-input',
                type: numberParse[type] ? 'number' : type === 'DateTime' ? 'datetime-local' : 'text',
                value: fieldState.value ?? '',
            });
        if (numberParse[type]) input.step = type === 'Integer' || type === 'BigInt' ? '1' : 'any';
        input.addEventListener('change', () => {
            clearNullState();
            const v = input.value;
            fieldState.value = v === '' ? null : (numberParse[type] ? numberParse[type](v) : v);
        });
        if (multiline) {
            const fit = () => {
                input.style.height = 'auto';
                input.style.height = `${Math.min(input.scrollHeight + 2, 300)}px`; // .fe-val max-height
            };
            input.addEventListener('input', fit);
            requestAnimationFrame(fit);
            const formatBtn = jsonFormatButton(input, () => input.dispatchEvent(new Event('change')), fit);
            row.append(input, ui.el('div', { className: 'fe-side' }, formatBtn ? [nullBtn, formatBtn] : [nullBtn]));
        } else row.append(input, nullBtn);
    } else if (type === 'Boolean') {
        const optionSet = (await getTypedAttribute(entityName, attr.LogicalName, 'BooleanAttributeMetadata', '$select=TrueOption,FalseOption'))?.OptionSet;
        const select = ui.el('select', { className: 'ppt-select' }, [
            ui.el('option', { value: '', textContent: '-- Select --' }),
            ui.el('option', { value: 'true', textContent: optionSet?.TrueOption?.Label?.UserLocalizedLabel?.Label || 'Yes', selected: fieldState.value === true }),
            ui.el('option', { value: 'false', textContent: optionSet?.FalseOption?.Label?.UserLocalizedLabel?.Label || 'No', selected: fieldState.value === false }),
        ]);
        select.addEventListener('change', () => {
            clearNullState();
            fieldState.value = select.value === '' ? null : select.value === 'true';
        });
        row.append(select, nullBtn);
    } else if (type === 'Picklist' || type === 'State' || type === 'Status') {
        const cast = { Picklist: 'PicklistAttributeMetadata', State: 'StateAttributeMetadata', Status: 'StatusAttributeMetadata' }[type];
        const options = (await getOptions(entityName, attr.LogicalName, cast))
            .map((o) => ({ value: o.Value, label: optionLabel(o) }));

        const holder = ui.el('div', { style: 'flex:1' });
        const showSelected = (lbl, value) => {
            holder.querySelector('.fe-selected')?.remove();
            holder.prepend(selectedBadge(lbl, String(value), () => {
                fieldState.value = null;
                holder.querySelector('.fe-selected')?.remove();
            }));
        };
        const input = ui.el('input', { className: 'ppt-input', placeholder: 'Search options…' });
        const search = ui.suggest({
            input, empty: 'No matching options',
            items: (text) => {
                const query = text.toLowerCase();
                return (query ? options.filter((o) => o.label.toLowerCase().includes(query)) : options)
                    .map((o) => ({ label: o.label, sub: String(o.value), value: o.value }));
            },
            onPick: (item) => {
                clearNullState();
                input.value = '';
                fieldState.value = item.value;
                showSelected(item.label, item.value);
            },
        });
        if (fieldState.value !== null && fieldState.value !== undefined) {
            const current = options.find((o) => o.value === fieldState.value);
            showSelected(current?.label ?? fieldState.displayValue ?? `Value ${fieldState.value}`, fieldState.value);
        }
        holder.append(ui.el('div', { className: 'fe-search' }, [search.node]));
        row.append(holder, nullBtn);
    } else if (type === 'MultiSelectPicklist') {
        const options = await getOptions(entityName, attr.LogicalName, 'MultiSelectPicklistAttributeMetadata');
        const selected = new Set(Array.isArray(fieldState.value) ? fieldState.value : []);
        const chipset = ui.el('div', { className: 'fe-chipset' }, options.map((o) => {
            const chip = ui.el('div', { className: `fe-chip${selected.has(o.Value) ? ' selected' : ''}`, textContent: optionLabel(o) });
            chip.addEventListener('click', () => {
                clearNullState();
                chip.classList.toggle('selected');
                if (chip.classList.contains('selected')) selected.add(o.Value);
                else selected.delete(o.Value);
                fieldState.value = selected.size ? [...selected] : null;
            });
            return chip;
        }));
        row.append(chipset, nullBtn);
    } else if (LOOKUP_TYPES.includes(type)) {
        const targets = await getLookupTargets(entityName, attr.LogicalName);
        const holder = ui.el('div', { style: 'flex:1' });
        let targetSelect = null;
        if (targets.length > 1) {
            targetSelect = ui.el('select', { className: 'ppt-select', style: 'width:auto;min-width:120px;margin-bottom:8px' },
                targets.map((t) => ui.el('option', { value: t, textContent: t, selected: t === fieldState.lookupTarget })));
            holder.append(targetSelect);
        }
        const currentTarget = () => targetSelect?.value ?? targets[0] ?? fieldState.lookupTarget;

        const showSelected = (name, id, target) => {
            holder.querySelector('.fe-selected')?.remove();
            const badge = selectedBadge(name, id, () => {
                fieldState.value = null;
                fieldState.displayValue = null;
                fieldState.setToNull = true;
                setNullState();
                badge.remove();
            }, id ? () => openLookupRecord(target, id) : null);
            holder.querySelector('.fe-search').before(badge);
        };

        const input = ui.el('input', { className: 'ppt-input', placeholder: 'Search records…' });
        const search = ui.suggest({
            input, debounce: 350, empty: 'No records found',
            items: async (text) => {
                const target = currentTarget();
                if (!target) throw new Error('No target table');
                return (await searchRecords(target, text)).map((r) => ({ label: r.name, sub: r.id, id: r.id, target }));
            },
            onPick: (item) => {
                clearNullState();
                input.value = '';
                fieldState.value = item.id;
                fieldState.displayValue = item.label;
                fieldState.lookupTarget = item.target;
                showSelected(item.label, item.id, item.target);
            },
        });
        holder.append(ui.el('div', { className: 'fe-search' }, [search.node]));
        targetSelect?.addEventListener('change', () => { input.value = ''; search.hide(); });
        if (fieldState.displayValue) {
            showSelected(fieldState.displayValue, fieldState.value ?? '', fieldState.lookupTarget ?? currentTarget());
        }
        row.append(holder, nullBtn);
    } else {
        const input = ui.el('input', { className: 'ppt-input', type: 'text', value: fieldState.value ?? '' });
        input.addEventListener('change', () => { clearNullState(); fieldState.value = input.value || null; });
        row.append(input, nullBtn);
    }

    container.replaceChildren(row);
}

// ── JSON highlighting ─────────────────────────────────────────────────────
// Lexical only, so half-typed JSON still colours sensibly while editing.
const JSON_TOKEN = /("(?:\\.|[^"\\])*"?)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])/g;

function highlightJson(text) {
    const fragment = document.createDocumentFragment();
    const span = (className, value) => ui.el('span', { className, textContent: value });
    let last = 0;
    for (const match of text.matchAll(JSON_TOKEN)) {
        if (match.index > last) fragment.append(text.slice(last, match.index));
        const [whole, str, colon, literal, number] = match;
        if (str) {
            fragment.append(span(colon ? 'fe-j-key' : 'fe-j-str', str));
            if (colon) fragment.append(span('fe-j-pun', colon));
        } else if (literal) fragment.append(span('fe-j-lit', whole));
        else if (number) fragment.append(span('fe-j-num', whole));
        else fragment.append(span('fe-j-pun', whole));
        last = match.index + whole.length;
    }
    if (last < text.length) fragment.append(text.slice(last));
    return fragment;
}

// ── Save ──────────────────────────────────────────────────────────────────
async function buildPayload(entityName, fields) {
    const payload = {};
    for (const field of fields) {
        const attr = field.attribute;
        const name = attr.LogicalName;

        if (LOOKUP_TYPES.includes(attr.AttributeType)) {
            if (field.setToNull) {
                const navProp = await getLookupNavProp(entityName, name, field.lookupTarget);
                payload[navProp] = null;
            } else if (field.value && field.lookupTarget) {
                const navProp = await getLookupNavProp(entityName, name, field.lookupTarget);
                const target = await fetchEntityInfo(field.lookupTarget);
                payload[`${navProp}@odata.bind`] = `/${target.entitySetName}(${cleanGuid(field.value)})`;
            }
            continue;
        }

        if (field.setToNull) { payload[name] = null; continue; }
        if (field.value === undefined || field.value === null) continue;

        if (attr.AttributeType === 'DateTime') payload[name] = new Date(field.value).toISOString();
        else if (attr.AttributeType === 'MultiSelectPicklist') payload[name] = field.value.join(',');
        else payload[name] = field.value;
    }
    return payload;
}

// ── Modal ─────────────────────────────────────────────────────────────────
function getFormContext() {
    const params = new URLSearchParams(location.search);
    const etn = params.get('etn');
    const id = params.get('id');
    return params.get('pagetype') === 'entityrecord' && etn && id
        ? { entityName: etn, recordId: cleanGuid(id) } : null;
}

// What the table shows for a column: the formatted value, plus the raw one
// where they differ in a useful way (choice values, lookup targets).
function displayOf(attr, record) {
    const lookup = LOOKUP_TYPES.includes(attr.AttributeType);
    const key = lookup ? `_${attr.LogicalName}_value` : attr.LogicalName;
    const raw = record?.[key];
    if (raw === null || raw === undefined || raw === '') return null;
    const text = record[`${key}@OData.Community.Display.V1.FormattedValue`] ?? String(raw);
    const target = lookup ? record[`${key}@Microsoft.Dynamics.CRM.lookuplogicalname`] ?? null : null;
    const showRaw = ['Picklist', 'State', 'Status', 'MultiSelectPicklist'].includes(attr.AttributeType) && text !== String(raw);
    return { raw: String(raw), text, target, sub: lookup ? target : showRaw ? String(raw) : null };
}

const fieldSnapshot = (field) => JSON.stringify([field.value ?? null, field.lookupTarget ?? null]);

// A row counts as changed once it would contribute to the PATCH payload.
const isChanged = (row) => !!row.field
    && (row.field.setToNull || (row.field.value != null && fieldSnapshot(row.field) !== row.original));

let editorOpen = false;

/**
 * The editor on the open form's record, or on `context` ({ entityName,
 * recordId }) when another tool opens it; `onSaved` runs after each save.
 */
export function openRecordEditor(context = getFormContext(), { onSaved } = {}) {
    dv ??= new Dataverse();
    ui.addStyle('fe', STYLE);
    if (!context) { ui.toast('⚠️ Open a record form first.'); return; }
    if (editorOpen) return;
    editorOpen = true;

    let rows = []; // { attr, disp, record, field, original, el, editEl, editBtn, haystack }
    let entitySetName = null;

    const backdrop = ui.mount(ui.el('div', { className: 'ppt fe-backdrop' }));
    let releaseEscape = () => {};
    const dispose = () => { editorOpen = false; backdrop.remove(); releaseEscape(); };
    const requestClose = async () => {
        const pending = rows.filter(isChanged).length;
        if (pending && !(await ui.confirmDialog(`Discard ${pending} pending change${pending === 1 ? '' : 's'}?`, { title: 'Record Editor', okLabel: 'Discard' }))) return;
        dispose();
    };
    releaseEscape = ui.onEscape(requestClose);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) requestClose(); });

    const recordLabel = ui.el('span', { className: 'fe-record' });
    const filterInput = ui.el('input', { className: 'ppt-input', placeholder: 'Filter by name, logical name or value…' });
    const hideEmpty = ui.el('input', { type: 'checkbox' });
    const changedOnly = ui.el('input', { type: 'checkbox' });
    const countLabel = ui.el('span', { className: 'fe-count' });
    const messageArea = ui.el('div');
    const list = ui.el('div', {}, [ui.el('div', { className: 'fe-empty' }, [ui.el('span', { className: 'fe-spinner' }), 'Loading record…'])]);
    const pendingLabel = ui.el('span', { className: 'fe-pending' });
    const saveBtn = ui.el('button', { className: 'ppt-btn primary', textContent: 'Save Changes', disabled: true });

    const modal = ui.el('div', { className: 'fe-modal' }, [
        ui.el('div', { className: 'fe-header' }, [
            ui.el('h2', {}, [
                'Record Editor',
                ui.el('span', { className: 'fe-tag', textContent: context.entityName }),
                recordLabel,
            ]),
            ui.el('button', { className: 'ppt-icon-btn', textContent: '✕', title: 'Close (Esc)', onclick: requestClose }),
        ]),
        ui.el('div', { className: 'fe-toolbar' }, [
            filterInput,
            ui.el('label', { className: 'fe-toggle' }, [hideEmpty, 'Hide empty']),
            ui.el('label', { className: 'fe-toggle' }, [changedOnly, 'Changed only']),
            countLabel,
        ]),
        ui.el('div', { className: 'fe-body' }, [messageArea, list]),
        ui.el('div', { className: 'fe-footer' }, [
            pendingLabel,
            ui.el('button', { className: 'ppt-btn', textContent: 'Close', onclick: requestClose }),
            saveBtn,
        ]),
    ]);
    backdrop.appendChild(modal);

    function showMessage(kind, text) {
        messageArea.replaceChildren(ui.el('div', { className: `fe-msg ${kind}`, textContent: text }));
    }

    function applyFilter() {
        const query = filterInput.value.trim().toLowerCase();
        let shown = 0;
        for (const row of rows) {
            const visible = (!query || row.haystack.includes(query))
                && (!hideEmpty.checked || row.disp || row.field || row.media)
                && (!changedOnly.checked || isChanged(row));
            row.el.hidden = !visible;
            if (visible) shown++;
        }
        countLabel.textContent = `${shown} of ${rows.length} columns`;
        requestAnimationFrame(measureClamps);
    }

    // Filtered-out rows have no layout yet, so each row is measured the first
    // time it's visible. All reads happen before any writes: one layout pass.
    function measureClamps() {
        const overflowing = rows.filter((row) => {
            if (row.measured || !row.disp || row.el.hidden || row.viewEl.hidden || !row.el.isConnected) return false;
            row.measured = true;
            return row.valueEl.scrollHeight > row.valueEl.clientHeight + 1;
        });
        for (const row of overflowing) {
            // One rule for where editing happens: a value that doesn't fit in
            // its row is edited in the dialog, everything else inline.
            row.long = TEXT_TYPES.includes(row.attr.AttributeType);
            row.moreBtn = ui.el('button', {
                className: 'fe-more', type: 'button',
                onclick: () => showFullValue(row),
            });
            row.viewEl.append(row.moreBtn);
            showText(row, row.field?.value ?? row.disp.text);
        }
    }

    // The value shown in the row's view (and the chip's size), which is the
    // staged text after a dialog edit.
    function showText(row, value) {
        if (row.textEl) row.textEl.textContent = value;
        if (row.moreBtn) row.moreBtn.textContent = `Show all · ${value.length.toLocaleString()} chars`;
    }

    function activate(row) {
        if (row.long) showFullValue(row, { edit: true });
        else openEdit(row);
    }

    // The full value in a dialog, read-only or straight into editing. Apply
    // stages the text on the row like an inline edit, so it is saved with
    // everything else.
    function showFullValue(row, { edit = false } = {}) {
        const { raw } = row.disp;
        const text = row.field?.value ?? row.disp.text;
        const parseJson = (value) => {
            if (!/^\s*[{[]/.test(value)) return { json: false };
            try { return { json: true, value: JSON.parse(value) }; } catch (e) { return { json: true, error: e.message }; }
        };
        const parsed = parseJson(text);
        const pretty = parsed.value !== undefined ? JSON.stringify(parsed.value, null, 2) : null;
        // JSON stored on one line is edited pretty-printed and stored compact
        // again, so a small edit doesn't reformat the whole column value.
        const compactOnApply = pretty !== null && !raw.includes('\n');
        const textual = TEXT_TYPES.includes(row.attr.AttributeType);

        ui.modal({
            title: label(row.attr),
            width: '900px',
            render: (body, close) => {
                const footer = ui.el('div', { className: 'ppt-dialog-footer' });
                body.after(footer);
                const button = (labelText, onclick, primary = false) =>
                    ui.el('button', { className: `ppt-btn${primary ? ' primary' : ''}`, textContent: labelText, onclick });

                const showView = () => {
                    const view = ui.el('pre', { className: 'fe-full' });
                    if (pretty) view.append(highlightJson(pretty));
                    else view.textContent = text;
                    body.replaceChildren(view);
                    const edit = row.attr.IsValidForUpdate
                        ? [button('Edit', () => (textual ? showEditor() : (close(), openEdit(row))))] : [];
                    footer.replaceChildren(
                        button('Copy', () => navigator.clipboard.writeText(text).then(() => ui.toast('Copied', 1500))),
                        ...edit,
                        button('Close', close, true),
                    );
                };

                const showEditor = () => {
                    const input = ui.el('textarea', {
                        className: parsed.json ? '' : 'ppt-input fe-full fe-full-edit',
                        value: pretty ?? text, spellcheck: false,
                    });
                    const status = ui.el('span', { className: 'fe-json-status' });
                    if (parsed.json) {
                        const shadow = ui.el('pre', { ariaHidden: 'true' });
                        // A trailing newline in a textarea still gets its own
                        // line; give the copy one too so heights stay equal.
                        const paint = () => shadow.replaceChildren(highlightJson(input.value), '\n');
                        input.addEventListener('input', () => {
                            paint();
                            const check = parseJson(input.value);
                            status.textContent = check.error ? `⚠ Invalid JSON: ${check.error}` : '✓ Valid JSON';
                            status.classList.toggle('bad', !!check.error);
                        });
                        input.addEventListener('scroll', () => { shadow.scrollTop = input.scrollTop; });
                        body.replaceChildren(ui.el('div', { className: 'fe-code' }, [shadow, input]));
                        input.dispatchEvent(new Event('input'));
                    } else {
                        body.replaceChildren(input);
                    }
                    footer.replaceChildren(
                        status,
                        button('Cancel', edit ? close : showView),
                        button('Apply', () => {
                            let value = input.value;
                            if (compactOnApply) {
                                const check = parseJson(value);
                                if (check.value !== undefined) value = JSON.stringify(check.value);
                            }
                            close();
                            stageText(row, value);
                        }, true),
                    );
                    input.focus();
                    input.setSelectionRange(0, 0);
                };

                if (edit) showEditor();
                else showView();
            },
        });
    }

    function refreshPending() {
        let pending = 0;
        for (const row of rows) {
            const changed = isChanged(row);
            row.el.classList.toggle('changed', changed);
            if (changed) pending++;
        }
        pendingLabel.textContent = pending ? `${pending} pending change${pending === 1 ? '' : 's'}` : '';
        saveBtn.disabled = pending === 0;
    }

    // A dialog edit: the row keeps its read-only look, showing the new text,
    // and is marked changed. Applying the original text again reverts it.
    function stageText(row, value) {
        if (value === row.disp.raw) { if (row.field) revertEdit(row); return; }
        if (!row.field) {
            row.field = { attribute: row.attr, setToNull: false, ...valueFromRecord(row.attr, row.record) };
            row.original = fieldSnapshot(row.field);
        }
        row.field.value = value;
        row.field.setToNull = false;
        showText(row, value);
        row.editBtn.textContent = '↺';
        row.editBtn.title = 'Revert';
        refreshPending();
    }

    function openEdit(row) {
        if (row.field) return;
        row.field = { attribute: row.attr, setToNull: false, ...valueFromRecord(row.attr, row.record) };
        row.original = fieldSnapshot(row.field);
        row.el.classList.add('editing');
        row.editBtn.textContent = '↺';
        row.editBtn.title = 'Revert';
        row.viewEl.hidden = true;
        row.editEl.hidden = false;
        buildFieldInput(row.field, row.editEl, context.entityName).then(() => {
            row.editEl.querySelector('input,select,textarea')?.focus();
        });
    }

    function revertEdit(row) {
        row.field = null;
        if (row.disp) showText(row, row.disp.text);
        row.el.classList.remove('editing');
        row.editBtn.textContent = '✎';
        row.editBtn.title = 'Edit';
        row.editEl.hidden = true;
        row.editEl.replaceChildren();
        row.viewEl.hidden = false;
        refreshPending();
    }

    function buildRow(attr, record) {
        if (MEDIA_TYPES.includes(attr.AttributeType)) return buildMediaRow(attr, record);
        const disp = displayOf(attr, record);
        const editable = attr.IsValidForUpdate;
        const typeLabel = TYPE_LABELS[attr.AttributeType] ?? attr.AttributeType;
        const row = { attr, disp, record, field: null, original: null };

        const valueEl = ui.el('div', { className: `fe-val${disp ? '' : ' empty'}${editable ? ' editable' : ''}` });
        if (!disp) valueEl.textContent = '(empty)';
        else if (disp.target) {
            valueEl.append(row.linkEl = ui.el('span', {
                className: 'link', textContent: disp.text, title: 'Open this record',
                onclick: (e) => { e.stopPropagation(); openLookupRecord(disp.target, disp.raw); },
            }));
        } else valueEl.append(row.textEl = ui.el('span', { textContent: disp.text }));
        if (disp?.sub) valueEl.append(ui.el('span', { className: 'fe-raw', textContent: disp.sub }));
        if (editable) {
            valueEl.title = 'Click to edit';
            valueEl.addEventListener('click', () => activate(row));
        }
        // Every value is clamped to four lines; whether it actually overflows
        // is measured once the row is laid out (see measureClamps).
        if (disp) valueEl.classList.add('clamped');
        row.valueEl = valueEl;
        row.viewEl = ui.el('div', { className: 'fe-view' }, [valueEl]);

        const copyBtn = ui.el('button', {
            className: 'ppt-icon-btn', textContent: '⧉', title: 'Copy raw value', disabled: !disp,
            onclick: () => navigator.clipboard.writeText(disp.raw).then(() => ui.toast('Copied', 1500)),
        });
        row.editBtn = ui.el('button', {
            className: 'ppt-icon-btn', textContent: '✎', title: 'Edit',
            onclick: () => (row.field ? revertEdit(row) : activate(row)),
        });
        row.editEl = ui.el('div', { className: 'fe-edit', hidden: true });

        row.el = ui.el('div', { className: 'fe-tr' }, [
            ui.el('div', { style: 'min-width:0' }, [
                ui.el('div', { className: 'fe-name', textContent: label(attr), title: label(attr) }),
                ui.el('div', { className: 'fe-logical', textContent: attr.LogicalName, title: attr.LogicalName }),
            ]),
            ui.el('div', { className: 'fe-type', textContent: editable ? typeLabel : `🔒 ${typeLabel}`, title: editable ? '' : 'Read-only column' }),
            ui.el('div', { className: 'fe-cell' }, [row.viewEl, row.editEl]),
            ui.el('div', { className: 'fe-actions' }, editable ? [copyBtn, row.editBtn] : [copyBtn]),
        ]);
        row.haystack = [label(attr), attr.LogicalName, disp?.text, disp?.raw].filter(Boolean).join('\n').toLowerCase();
        return row;
    }

    // A file or image column: a download link or a thumbnail, never edited here.
    function buildMediaRow(attr, record) {
        const column = attr.LogicalName;
        const typeLabel = TYPE_LABELS[attr.AttributeType];
        const fileName = record?.[`${column}_name`] ?? null;
        const value = attr.AttributeType === 'File'
            ? fileLink({ entitySetName, recordId: context.recordId, column, fileName, hasFile: !!record?.[column] })
            : imageThumb({ entitySetName, recordId: context.recordId, column, thumbnail: record?.[column], title: label(attr), size: 64 });
        const valueEl = ui.el('div', { className: `fe-val${value ? '' : ' empty'}` }, [value ?? '(empty)']);
        const row = { attr, disp: null, record, field: null, original: null, valueEl, media: !!value };
        row.viewEl = ui.el('div', { className: 'fe-view' }, [valueEl]);
        row.el = ui.el('div', { className: 'fe-tr' }, [
            ui.el('div', { style: 'min-width:0' }, [
                ui.el('div', { className: 'fe-name', textContent: label(attr), title: label(attr) }),
                ui.el('div', { className: 'fe-logical', textContent: column, title: column }),
            ]),
            ui.el('div', { className: 'fe-type', textContent: `🔒 ${typeLabel}`, title: 'Shown read-only here' }),
            ui.el('div', { className: 'fe-cell' }, [row.viewEl]),
            ui.el('div', { className: 'fe-actions' }),
        ]);
        row.haystack = [label(attr), column, fileName].filter(Boolean).join('\n').toLowerCase();
        return row;
    }

    // The input builders mutate field state without callbacks; recount after
    // any interaction inside the list (typeahead picks land on mousedown).
    for (const type of ['change', 'click', 'mousedown']) {
        list.addEventListener(type, () => setTimeout(refreshPending, 0));
    }
    filterInput.addEventListener('input', applyFilter);
    hideEmpty.addEventListener('change', applyFilter);
    changedOnly.addEventListener('change', applyFilter);

    async function load() {
        const entityInfo = await fetchEntityInfo(context.entityName);
        if (!entityInfo) throw new Error(`No metadata for ${context.entityName}`);
        entitySetName = entityInfo.entitySetName;
        const [record, attributes] = await Promise.all([
            dv.get(`/${entitySetName}(${context.recordId})`, { Prefer: 'odata.include-annotations="*"' }),
            getAttributes(context.entityName),
        ]);
        // A plain retrieve leaves out what file and image columns hold; asked
        // for by name they give the file id and name, and the thumbnail.
        const media = attributes.filter((a) => MEDIA_TYPES.includes(a.AttributeType)).map((a) => a.LogicalName);
        if (media.length) {
            const select = media.flatMap((c) => (attributes.find((a) => a.LogicalName === c).AttributeType === 'File' ? [c, `${c}_name`] : [c]));
            try {
                Object.assign(record, await dv.get(`/${entitySetName}(${context.recordId})?$select=${select.join(',')}`));
            } catch (e) {
                console.warn('[Record Editor] could not read file and image columns:', e);
            }
        }
        recordLabel.textContent = record[entityInfo.primaryNameAttr] || '';
        rows = attributes.map((attr) => buildRow(attr, record));
        list.replaceChildren(...rows.map((r) => r.el));
        applyFilter();
        refreshPending();
        decorateValues();
    }

    // Filled in after the table renders, so opening never waits on them:
    // table icons on lookups, names for lookups the Web API returned without
    // one (owningteam/owninguser have no companion name column), choice colours.
    function decorateValues() {
        for (const row of rows) {
            const { disp, attr } = row;
            if (!disp) continue;
            if (disp.target) {
                fetchEntityInfo(disp.target).then((info) => {
                    const url = entityIconUrl(info);
                    if (!url || !row.el.isConnected) return;
                    const icon = ui.el('img', { className: 'fe-icon', src: url, alt: '', title: info.displayName });
                    icon.addEventListener('error', () => icon.remove());
                    row.linkEl.before(icon);
                });
            }
            if (['Picklist', 'State', 'Status'].includes(attr.AttributeType)) {
                fetchOptionsetColors(context.entityName, attr.LogicalName).then((colors) => {
                    const pill = choiceColor(colors, disp.raw);
                    if (!pill || !row.el.isConnected) return;
                    row.textEl.classList.add('fe-pill');
                    Object.assign(row.textEl.style, pill);
                });
            }
            if (!disp.target || disp.text !== disp.raw) continue;
            fetchRecordDisplayName(disp.target, disp.raw).then((name) => {
                if (!name || !row.el.isConnected) return;
                disp.text = name;
                row.linkEl.textContent = name;
                row.haystack += `\n${name.toLowerCase()}`;
            });
        }
    }

    saveBtn.addEventListener('click', async () => {
        messageArea.replaceChildren();
        saveBtn.disabled = true;
        saveBtn.replaceChildren(ui.el('span', { className: 'fe-spinner' }), 'Saving…');
        try {
            const changed = rows.filter(isChanged);
            const payload = await buildPayload(context.entityName, changed.map((r) => r.field));
            if (!Object.keys(payload).length) throw new Error('No changes to save');
            await dv.update(entitySetName, context.recordId, payload);
            await load();
            onSaved?.();
            showMessage('success', `Saved ${changed.length} change${changed.length === 1 ? '' : 's'}. Refresh the form to see them there.`);
        } catch (e) {
            let message = e.body ?? e.message;
            try { message = JSON.parse(e.body).error?.message ?? message; } catch { /* not json */ }
            showMessage('error', message);
        } finally {
            saveBtn.replaceChildren('Save Changes');
            refreshPending();
        }
    });

    load().then(() => filterInput.focus()).catch((e) => {
        list.replaceChildren(ui.el('div', { className: 'fe-msg error', textContent: `Failed to load record: ${e.message}` }));
    });
}

export default {
    init() {
        commands.register({
            toolId: 'field-editor',
            title: 'Edit Record Values',
            icon: '🔧', svg: 'edit',
            run: () => openRecordEditor(),
        });
    },
};
