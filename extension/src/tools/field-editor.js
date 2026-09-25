// Field Editor (native).
// Update any column on the current Dataverse record, bypassing the form:
// search columns by name, edit with type-appropriate inputs (text, numbers,
// dates, choices, yes/no, multi-select, lookups incl. polymorphic targets),
// set values to NULL explicitly, then PATCH via the Web API.

import { Dataverse } from '../core/dataverse.js';
import * as ui from '../core/ui.js';
import * as commands from '../core/commands.js';
import { openRecordForm } from '../core/agent.js';

let dv;

const STYLE = `
    .fe-backdrop {
        position: fixed; inset: 0; background: rgba(0,0,0,0.4);
        z-index: 2147483000; display: flex; align-items: center; justify-content: center;
        animation: ppt-fade 0.15s ease;
    }
    .fe-modal {
        width: 700px; max-width: 90vw; min-height: 500px; max-height: 85vh;
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
    .fe-body { flex: 1; overflow-y: auto; padding: 16px 24px; }
    .fe-footer {
        display: flex; justify-content: flex-end; gap: 8px; padding: 14px 24px;
        border-top: 1px solid var(--border); background: var(--bg2); flex-shrink: 0;
    }
    .fe-search { position: relative; }
    .fe-ac {
        display: none; position: absolute; top: 100%; left: 0; right: 0;
        background: var(--bg); border: 1px solid var(--border); border-radius: 0 0 4px 4px;
        max-height: 200px; overflow-y: auto; z-index: 10; box-shadow: var(--shadow);
    }
    .fe-ac-item {
        display: flex; flex-direction: column; gap: 2px; padding: 8px 12px;
        cursor: pointer; font-size: 13px; border-bottom: 1px solid var(--border);
    }
    .fe-ac-item:hover { background: var(--bg2); }
    .fe-ac-logical { font-size: 11px; color: var(--muted); font-family: Consolas, monospace; }
    .fe-ac-type { font-size: 10px; color: var(--muted); background: var(--bg2); padding: 1px 6px; border-radius: 3px; margin-left: 8px; }
    .fe-ac-msg { padding: 10px 12px; font-size: 13px; color: var(--muted); }
    .fe-row { background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; padding: 12px 16px; margin-bottom: 12px; }
    .fe-row-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .fe-name { font-weight: 600; font-size: 13px; }
    .fe-logical { font-size: 11px; color: var(--muted); font-family: Consolas, monospace; margin-left: 8px; }
    .fe-type { font-size: 10px; color: var(--muted); background: var(--border); padding: 2px 8px; border-radius: 10px; margin-left: 8px; }
    .fe-remove { background: transparent; color: var(--danger); border: none; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; cursor: pointer; }
    .fe-remove:hover { background: var(--bg); }
    .fe-input-row { display: flex; align-items: flex-start; gap: 8px; }
    .fe-input-row > .ppt-input, .fe-input-row > .ppt-select { flex: 1; }
    .fe-input-row.null-state .ppt-input, .fe-input-row.null-state .ppt-select,
    .fe-input-row.null-state .fe-chipset { opacity: 0.5; pointer-events: none; }
    .fe-null-btn {
        padding: 6px 10px; background: var(--bg); border: 1px solid var(--danger);
        color: var(--danger); border-radius: 4px; font-size: 11px; font-weight: 600;
        cursor: pointer; white-space: nowrap; font-family: inherit;
    }
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
    Uniqueidentifier: 'GUID', MultiSelectPicklist: 'Choices',
};
const LOOKUP_TYPES = ['Lookup', 'Customer', 'Owner'];
const label = (attr) => attr.DisplayName?.UserLocalizedLabel?.Label || attr.LogicalName;
const optionLabel = (o) => o.Label?.UserLocalizedLabel?.Label || `Value ${o.Value}`;
const cleanGuid = (g) => (g ? g.replace(/[{}]/g, '').toLowerCase() : '');

// ── Metadata (cached) ─────────────────────────────────────────────────────
const entityMetaCache = {};
const attributesCache = {};
const navPropCache = {};

async function getEntityMeta(entityName) {
    return (entityMetaCache[entityName] ??= await dv.get(
        `/EntityDefinitions(LogicalName='${entityName}')?$select=LogicalName,DisplayName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute`));
}

async function getAttributes(entityName) {
    if (!attributesCache[entityName]) {
        const data = await dv.get(`/EntityDefinitions(LogicalName='${entityName}')/Attributes?$select=LogicalName,DisplayName,AttributeType,SchemaName&$filter=IsValidForUpdate eq true`);
        attributesCache[entityName] = data.value ?? [];
    }
    return attributesCache[entityName];
}

async function getTypedAttribute(entityName, attributeName, cast, expand) {
    try {
        return await dv.get(`/EntityDefinitions(LogicalName='${entityName}')/Attributes(LogicalName='${attributeName}')/Microsoft.Dynamics.CRM.${cast}?$select=LogicalName&$expand=OptionSet(${expand})`);
    } catch (e) {
        console.warn('[Field Editor] metadata fetch failed:', e);
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
    const meta = await getEntityMeta(targetEntity);
    const filter = text ? `&$filter=contains(${meta.PrimaryNameAttribute},'${encodeURIComponent(text.replace(/'/g, "''"))}')` : '';
    const data = await dv.get(`/${meta.EntitySetName}?$select=${meta.PrimaryNameAttribute}&$top=20${filter}`);
    return (data.value ?? []).map((r) => ({
        id: r[meta.PrimaryIdAttribute],
        name: r[meta.PrimaryNameAttribute] || '(No name)',
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
function typeahead({ input, dropdown, render, onPick, minChars = 0, debounce = 250 }) {
    let timer = null;
    const show = async () => {
        const text = input.value.trim();
        if (text.length < minChars) { dropdown.style.display = 'none'; return; }
        const items = await render(text);
        dropdown.replaceChildren(...items);
        dropdown.style.display = 'block';
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(show, debounce); });
    input.addEventListener('focus', show);
    input.addEventListener('blur', () => setTimeout(() => { dropdown.style.display = 'none'; }, 200));
    dropdown.addEventListener('mousedown', (e) => {
        const item = e.target.closest('.fe-ac-item');
        if (item) { onPick(item); input.value = ''; dropdown.style.display = 'none'; }
    });
}

function acItem(main, sub, data = {}) {
    const item = ui.el('div', { className: 'fe-ac-item' }, [
        typeof main === 'string' ? ui.el('span', { textContent: main }) : main,
        ui.el('span', { className: 'fe-ac-logical', textContent: sub }),
    ]);
    Object.assign(item.dataset, data);
    return item;
}

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
        const input = type === 'Memo'
            ? ui.el('textarea', { className: 'ppt-input', rows: 4, value: fieldState.value ?? '' })
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
        row.append(input, nullBtn);
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
        const dropdown = ui.el('div', { className: 'fe-ac' });
        typeahead({
            input, dropdown,
            render: (text) => {
                const query = text.toLowerCase();
                const matches = query ? options.filter((o) => o.label.toLowerCase().includes(query)) : options;
                return matches.length
                    ? matches.map((o) => acItem(o.label, String(o.value), { value: o.value, label: o.label }))
                    : [ui.el('div', { className: 'fe-ac-msg', textContent: 'No matching options' })];
            },
            onPick: (item) => {
                clearNullState();
                fieldState.value = parseInt(item.dataset.value, 10);
                showSelected(item.dataset.label, item.dataset.value);
            },
        });
        if (fieldState.value !== null && fieldState.value !== undefined) {
            const current = options.find((o) => o.value === fieldState.value);
            showSelected(current?.label ?? fieldState.displayValue ?? `Value ${fieldState.value}`, fieldState.value);
        }
        holder.append(ui.el('div', { className: 'fe-search' }, [input, dropdown]));
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
        const dropdown = ui.el('div', { className: 'fe-ac' });
        holder.append(ui.el('div', { className: 'fe-search' }, [input, dropdown]));
        typeahead({
            input, dropdown, debounce: 350,
            render: async (text) => {
                const target = currentTarget();
                if (!target) return [ui.el('div', { className: 'fe-ac-msg', textContent: 'No target entity' })];
                try {
                    const records = await searchRecords(target, text);
                    return records.length
                        ? records.map((r) => acItem(r.name, r.id, { id: r.id, name: r.name, target }))
                        : [ui.el('div', { className: 'fe-ac-msg', textContent: 'No records found' })];
                } catch (e) {
                    return [ui.el('div', { className: 'fe-ac-msg', textContent: `Error: ${e.message}` })];
                }
            },
            onPick: (item) => {
                clearNullState();
                fieldState.value = item.dataset.id;
                fieldState.displayValue = item.dataset.name;
                fieldState.lookupTarget = item.dataset.target;
                showSelected(item.dataset.name, item.dataset.id, item.dataset.target);
            },
        });
        targetSelect?.addEventListener('change', () => { input.value = ''; dropdown.style.display = 'none'; });
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
                const targetMeta = await getEntityMeta(field.lookupTarget);
                payload[`${navProp}@odata.bind`] = `/${targetMeta.EntitySetName}(${cleanGuid(field.value)})`;
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

let editorOpen = false;

function openEditor() {
    const context = getFormContext();
    if (!context) { ui.toast('⚠️ Open a record form first.'); return; }
    if (editorOpen) return;
    editorOpen = true;

    const fields = []; // { attribute, value, displayValue, lookupTarget, setToNull }
    let allAttributes = [];
    let entitySetName = null;
    let recordData = null;

    const backdrop = ui.mount(ui.el('div', { className: 'ppt fe-backdrop' }));
    let releaseEscape = () => {};
    const dispose = () => { editorOpen = false; backdrop.remove(); releaseEscape(); };
    releaseEscape = ui.onEscape(dispose);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) dispose(); });

    const messageArea = ui.el('div');
    const fieldsList = ui.el('div', {}, [ui.el('div', { className: 'fe-empty' }, [ui.el('span', { className: 'fe-spinner' }), 'Loading metadata…'])]);
    const attrInput = ui.el('input', { className: 'ppt-input', placeholder: 'Search for columns by name or logical name…' });
    const attrDropdown = ui.el('div', { className: 'fe-ac' });
    const saveBtn = ui.el('button', { className: 'ppt-btn primary', textContent: 'Save Changes' });

    const modal = ui.el('div', { className: 'fe-modal' }, [
        ui.el('div', { className: 'fe-header' }, [
            ui.el('h2', {}, [
                'Field Editor',
                ui.el('span', { className: 'fe-tag', textContent: context.entityName }),
            ]),
            ui.el('button', { className: 'ppt-icon-btn', textContent: '✕', title: 'Close (Esc)', onclick: dispose }),
        ]),
        ui.el('div', { className: 'fe-body' }, [
            messageArea,
            ui.el('div', { className: 'ppt-label', textContent: 'Add Fields' }),
            ui.el('div', { className: 'fe-search' }, [attrInput, attrDropdown]),
            ui.el('div', { className: 'ppt-label', textContent: 'Fields to Update' }),
            fieldsList,
        ]),
        ui.el('div', { className: 'fe-footer' }, [
            ui.el('button', { className: 'ppt-btn', textContent: 'Cancel', onclick: dispose }),
            saveBtn,
        ]),
    ]);
    backdrop.appendChild(modal);

    function showMessage(kind, text) {
        messageArea.replaceChildren(ui.el('div', { className: `fe-msg ${kind}`, textContent: text }));
    }

    function renderFields() {
        if (!fields.length) {
            fieldsList.replaceChildren(ui.el('div', { className: 'fe-empty', textContent: 'No fields added yet. Use the search above to add fields to edit.' }));
            return;
        }
        fieldsList.replaceChildren(...fields.map((field) => {
            const inputContainer = ui.el('div');
            const rowEl = ui.el('div', { className: 'fe-row' }, [
                ui.el('div', { className: 'fe-row-header' }, [
                    ui.el('div', {}, [
                        ui.el('span', { className: 'fe-name', textContent: label(field.attribute) }),
                        ui.el('span', { className: 'fe-logical', textContent: field.attribute.LogicalName }),
                        ui.el('span', { className: 'fe-type', textContent: TYPE_LABELS[field.attribute.AttributeType] ?? field.attribute.AttributeType }),
                    ]),
                    ui.el('button', {
                        className: 'fe-remove', type: 'button', textContent: 'Remove',
                        onclick: () => { fields.splice(fields.indexOf(field), 1); renderFields(); },
                    }),
                ]),
                inputContainer,
            ]);
            buildFieldInput(field, inputContainer, context.entityName);
            return rowEl;
        }));
    }

    typeahead({
        input: attrInput, dropdown: attrDropdown, minChars: 1, debounce: 200,
        render: (text) => {
            const query = text.toLowerCase();
            const matches = allAttributes.filter((a) =>
                label(a).toLowerCase().includes(query) || a.LogicalName.toLowerCase().includes(query)).slice(0, 15);
            return matches.length
                ? matches.map((a) => acItem(
                    ui.el('span', {}, [
                        label(a),
                        ui.el('span', { className: 'fe-ac-type', textContent: TYPE_LABELS[a.AttributeType] ?? a.AttributeType }),
                    ]),
                    a.LogicalName, { logical: a.LogicalName }))
                : [ui.el('div', { className: 'fe-ac-msg', textContent: 'No matching columns found' })];
        },
        onPick: (item) => {
            const attr = allAttributes.find((a) => a.LogicalName === item.dataset.logical);
            if (attr && !fields.some((f) => f.attribute.LogicalName === attr.LogicalName)) {
                fields.push({ attribute: attr, setToNull: false, ...valueFromRecord(attr, recordData) });
                renderFields();
            }
        },
    });

    saveBtn.addEventListener('click', async () => {
        messageArea.replaceChildren();
        saveBtn.disabled = true;
        saveBtn.replaceChildren(ui.el('span', { className: 'fe-spinner' }), 'Saving…');
        try {
            const payload = await buildPayload(context.entityName, fields);
            if (!Object.keys(payload).length) throw new Error('No changes to save');
            await dv.update(entitySetName, context.recordId, payload);
            showMessage('success', 'Changes saved successfully! Refresh the form to see updates.');
        } catch (e) {
            let message = e.body ?? e.message;
            try { message = JSON.parse(e.body).error?.message ?? message; } catch { /* not json */ }
            showMessage('error', message);
        } finally {
            saveBtn.disabled = false;
            saveBtn.replaceChildren('Save Changes');
        }
    });

    // Load metadata + current record values
    (async () => {
        try {
            const entityMeta = await getEntityMeta(context.entityName);
            entitySetName = entityMeta.EntitySetName;
            recordData = await dv.get(`/${entitySetName}(${context.recordId})`, { Prefer: 'odata.include-annotations="*"' });
            allAttributes = (await getAttributes(context.entityName))
                .sort((a, b) => label(a).localeCompare(label(b)));
            renderFields();
        } catch (e) {
            fieldsList.replaceChildren(ui.el('div', { className: 'fe-msg error', textContent: `Failed to load metadata: ${e.message}` }));
        }
    })();
}

export default {
    init() {
        dv = new Dataverse();
        ui.addStyle('fe', STYLE);
        commands.register({
            toolId: 'field-editor',
            title: 'Open Field Editor',
            icon: '🔧',
            run: openEditor,
        });
    },
};
