// Add Existing Components (native).
// The maker portal's "Add existing" dialog, with the grid a model-driven view
// has: sort on any column (several at once), filter any column with the usual
// operators, and choose which columns are shown.
//
// The source is the same one the portal reads — `msdyn_solutioncomponentsummaries`
// scoped to the Default solution and one component type — so every type the
// portal can add is covered by one query shape. It is a virtual table, but
// unlike msdyn_solutionhistory its provider does honour the query. Measured on
// 2026-09-25 against two orgs:
//
//   • $filter works: eq/ne, contains/startswith/endswith (case-insensitive),
//     not, and/or, and ge/gt/le/lt on the ISO date strings.
//   • $orderby works, on several columns at once.
//   • Almost every column is typed Edm.String, booleans included: they must be
//     compared as 'true'/'false', and an unquoted `false` is a 400.
//   • Empty columns come back as '' rather than null, so "contains data" has
//     to rule out both.
//   • Without `Prefer: odata.maxpagesize` it stops at exactly 5000 rows with no
//     nextLink and `msdyn_total: 5000` — a silent cap, not a count. With it, it
//     pages through @odata.nextLink. `$skip` is refused outright.
//   • msdyn_objectid is the ComponentId AddSolutionComponent wants, for tables
//     too (it is the MetadataId). Adding is idempotent: a component already in
//     the solution answers 200 with the same row id.
//
// Opened from a solution in the maker portal, the panel targets that solution
// and reaches the environment through the host cache or a remembered URL.
//
// It can also take over from the portal's own "Add existing" panel: a button
// in that panel's header reopens the same component type here. What the
// portal panel is showing is read from the query it sent — see
// parsePortalQuery — so this does not depend on the UI language.

import { Dataverse } from '../core/dataverse.js';
import { getSite } from '../core/context.js';
import * as ui from '../core/ui.js';
import * as commands from '../core/commands.js';
import { resolveCurrentOrg } from './shared/current-org.js';
import {
    installGridStyle, applySort, createMenus, menuItem, chip, sortChipText, headerButton, loadingBlock, errorMessage,
} from './shared/grid.js';

export { applySort };

let store; // set in init()

// The Default solution id is fixed across every Dataverse org.
const DEFAULT_SOLUTION_ID = 'fd140aaf-4df4-11dd-bd17-0019b9312238';
const PAGE_SIZE = 100;
// A batch is all-or-nothing per change set; keeping sets small keeps one bad
// component from rolling back a selection of hundreds.
const ADD_CHUNK = 100;

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ── Columns ───────────────────────────────────────────────────────────────
//
// kind decides the filter operators on offer:
//   text      free text
//   category  free text, plus the values seen in the loaded rows as choices —
//             these hold localised labels ("Script (JScript)", "Draft"), so a
//             fixed list would be wrong in half the orgs
//   bool      yes / no, sent as the strings the provider stores
//   date      ISO strings, compared as such

export const COLUMNS = {
    msdyn_displayname: { label: 'Display name', kind: 'text' },
    msdyn_name: { label: 'Name', kind: 'text' },
    msdyn_schemaname: { label: 'Schema name', kind: 'text' },
    msdyn_uniquename: { label: 'Unique name', kind: 'text' },
    msdyn_typename: { label: 'Type', kind: 'category' },
    msdyn_primaryentityname: { label: 'Table', kind: 'category' },
    msdyn_workflowcategoryname: { label: 'Category', kind: 'category' },
    msdyn_statusname: { label: 'Status', kind: 'category' },
    msdyn_sdkmessagename: { label: 'Message', kind: 'category' },
    msdyn_executionstage: { label: 'Stage', kind: 'category' },
    msdyn_ismanaged: { label: 'Managed', kind: 'bool' },
    msdyn_iscustomizable: { label: 'Customizable', kind: 'bool' },
    msdyn_iscustom: { label: 'Custom', kind: 'bool' },
    msdyn_hasactivecustomization: { label: 'Has unmanaged layer', kind: 'bool' },
    msdyn_isauditenabled: { label: 'Auditing', kind: 'bool' },
    msdyn_owner: { label: 'Owner', kind: 'text' },
    msdyn_version: { label: 'Version', kind: 'text' },
    msdyn_description: { label: 'Description', kind: 'text' },
    msdyn_modifiedon: { label: 'Modified', kind: 'date' },
    msdyn_createdon: { label: 'Created', kind: 'date' },
};

/** Always fetched: identity for adding, plus what the fallbacks read. */
const BASE_SELECT = ['msdyn_objectid', 'msdyn_componenttype', 'msdyn_name', 'msdyn_displayname'];

export const OPERATORS = {
    text: [
        ['contains', 'Contains'], ['notcontains', 'Does not contain'],
        ['startswith', 'Begins with'], ['notstartswith', 'Does not begin with'],
        ['endswith', 'Ends with'], ['notendswith', 'Does not end with'],
        ['eq', 'Equals'], ['ne', 'Does not equal'],
        ['hasdata', 'Contains data'], ['nodata', 'Does not contain data'],
    ],
    bool: [['true', 'Yes'], ['false', 'No']],
    date: [['onorafter', 'On or after'], ['onorbefore', 'On or before'], ['lastdays', 'In the last N days']],
};
OPERATORS.category = [['eq', 'Equals'], ['ne', 'Does not equal'], ...OPERATORS.text.filter(([op]) => op !== 'eq' && op !== 'ne')];

const NO_VALUE_OPS = new Set(['hasdata', 'nodata', 'true', 'false']);
export const needsValue = (op) => !NO_VALUE_OPS.has(op);

// ── Component types ───────────────────────────────────────────────────────
//
// The core types have fixed codes. Table-backed types (connection reference,
// custom API, …) are numbered by their table's ObjectTypeCode, which differs
// between orgs, so those are looked up in solutioncomponentdefinitions at
// runtime instead — see loadDynamicTypes.

const FLOW_COLUMNS = ['msdyn_displayname', 'msdyn_workflowcategoryname', 'msdyn_primaryentityname', 'msdyn_statusname', 'msdyn_ismanaged', 'msdyn_modifiedon'];
const byTable = ['msdyn_displayname', 'msdyn_primaryentityname', 'msdyn_typename', 'msdyn_ismanaged', 'msdyn_modifiedon'];

const processType = (key, label, category) => ({
    key, label, componentType: 29, columns: FLOW_COLUMNS,
    fixedFilter: category == null ? null : `msdyn_workflowcategory eq '${category}'`,
});

export const CORE_TYPES = [
    { key: '1', label: 'Table', componentType: 1, columns: ['msdyn_displayname', 'msdyn_name', 'msdyn_iscustom', 'msdyn_ismanaged', 'msdyn_modifiedon'] },
    { key: '9', label: 'Choice (global)', componentType: 9 },
    { key: '61', label: 'Web resource', componentType: 61, columns: ['msdyn_displayname', 'msdyn_name', 'msdyn_typename', 'msdyn_ismanaged', 'msdyn_modifiedon'] },
    processType('29-5', 'Cloud flow', 5),
    processType('29-0', 'Classic workflow', 0),
    processType('29-2', 'Business rule', 2),
    processType('29-3', 'Action', 3),
    processType('29-4', 'Business process flow', 4),
    processType('29-6', 'Desktop flow', 6),
    processType('29', 'Process (all categories)', null),
    { key: '80', label: 'Model-driven app', componentType: 80 },
    { key: '300', label: 'Canvas / code app', componentType: 300, columns: ['msdyn_displayname', 'msdyn_name', 'msdyn_typename', 'msdyn_ismanaged', 'msdyn_modifiedon'] },
    { key: '62', label: 'Site map', componentType: 62 },
    { key: '60', label: 'Form / dashboard', componentType: 60, columns: byTable },
    { key: '26', label: 'View', componentType: 26, columns: byTable },
    { key: '59', label: 'Chart', componentType: 59, columns: byTable },
    { key: '20', label: 'Security role', componentType: 20 },
    { key: '70', label: 'Field security profile', componentType: 70 },
    { key: '380', label: 'Environment variable', componentType: 380, columns: ['msdyn_displayname', 'msdyn_schemaname', 'msdyn_ismanaged', 'msdyn_modifiedon'] },
    { key: '91', label: 'Plug-in assembly', componentType: 91, columns: ['msdyn_displayname', 'msdyn_version', 'msdyn_ismanaged', 'msdyn_modifiedon'] },
    { key: '90', label: 'Plug-in type', componentType: 90, columns: ['msdyn_displayname', 'msdyn_typename', 'msdyn_ismanaged', 'msdyn_modifiedon'] },
    { key: '92', label: 'Plug-in step', componentType: 92, columns: ['msdyn_displayname', 'msdyn_sdkmessagename', 'msdyn_primaryentityname', 'msdyn_executionstage', 'msdyn_ismanaged'] },
    { key: '95', label: 'Service endpoint', componentType: 95 },
    { key: '66', label: 'Custom control (PCF)', componentType: 66 },
    { key: '36', label: 'Email template', componentType: 36 },
    { key: '31', label: 'Report', componentType: 31 },
    { key: '63', label: 'Connection role', componentType: 63 },
    { key: '401', label: 'AI model', componentType: 401 },
];

const DEFAULT_COLUMNS = ['msdyn_displayname', 'msdyn_name', 'msdyn_ismanaged', 'msdyn_modifiedon'];

// Table-backed types worth listing with the core ones rather than under "More".
const PROMOTED_TABLE_TYPES = {
    connectionreference: 'Connection reference',
    customapi: 'Custom API',
    pluginpackage: 'Plug-in package',
    bot: 'Copilot agent',
    botcomponent: 'Copilot agent component',
    appaction: 'Command (app action)',
    powerpagesite: 'Power Pages site',
};

/** "msdyn_knowledgeassetconfiguration" / "CustomAPI" → something readable. */
const prettify = (name) => String(name).replace(/^msdyn_/i, '').replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2');

async function loadDynamicTypes(dv) {
    try {
        const data = await dv.get('/solutioncomponentdefinitions?$select=name,primaryentityname,solutioncomponenttype,isdisplayable'
            + '&$filter=isdisplayable eq true');
        return (data.value ?? []).map((d) => ({
            key: `t${d.solutioncomponenttype}`,
            label: PROMOTED_TABLE_TYPES[d.primaryentityname] ?? prettify(d.name),
            componentType: d.solutioncomponenttype,
            promoted: d.primaryentityname in PROMOTED_TABLE_TYPES,
        })).sort((a, b) => a.label.localeCompare(b.label));
    } catch (e) {
        console.warn('[Add Existing] could not list table-backed component types:', e);
        return [];
    }
}

// ── Query building ────────────────────────────────────────────────────────

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

const addDays = (isoDate, days) => {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
};

/**
 * One condition as an OData clause, or null when it is incomplete.
 * `now` is injectable so "last N days" can be tested.
 */
export function conditionClause({ column, op, value }, now = new Date()) {
    const v = String(value ?? '').trim();
    if (needsValue(op) && !v) return null;
    switch (op) {
        case 'contains': return `contains(${column},${quote(v)})`;
        case 'notcontains': return `not contains(${column},${quote(v)})`;
        case 'startswith': return `startswith(${column},${quote(v)})`;
        case 'notstartswith': return `not startswith(${column},${quote(v)})`;
        case 'endswith': return `endswith(${column},${quote(v)})`;
        case 'notendswith': return `not endswith(${column},${quote(v)})`;
        case 'eq': return `${column} eq ${quote(v)}`;
        case 'ne': return `${column} ne ${quote(v)}`;
        // Empty comes back as '' as often as null, so both count as no data.
        case 'hasdata': return `${column} ne null and ${column} ne ''`;
        case 'nodata': return `${column} eq null or ${column} eq ''`;
        case 'true': return `${column} eq 'true'`;
        case 'false': return `${column} eq 'false'`;
        // Dates are strings like "2026-08-07T03:30:06.000Z", so a bare day
        // compares correctly as a prefix: ge the day, lt the day after.
        case 'onorafter': return `${column} ge ${quote(v)}`;
        case 'onorbefore': return `${column} lt ${quote(addDays(v, 1))}`;
        case 'lastdays': {
            const days = Number.parseInt(v, 10);
            if (!(days > 0)) return null;
            const since = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
            return `${column} ge ${quote(since)}`;
        }
        default: return null;
    }
}

/** How a condition reads on its chip: "Name begins with cr123_". */
export function describeCondition({ column, op, value }) {
    const col = COLUMNS[column];
    const ops = OPERATORS[col?.kind ?? 'text'];
    const opLabel = ops.find(([key]) => key === op)?.[1] ?? op;
    const label = col?.label ?? column;
    if (col?.kind === 'bool') return `${label}: ${opLabel}`;
    if (op === 'lastdays') return `${label} in the last ${value} days`;
    return needsValue(op) ? `${label} ${opLabel.toLowerCase()} "${value}"` : `${label} ${opLabel.toLowerCase()}`;
}

/**
 * The summaries query for one grid state. Returns the path to GET; paging is
 * driven by the Prefer header, never by $top (which would suppress nextLink).
 */
export function buildQuery({ type, conditions = [], search = '', sort = [], columns = [], solutionId = DEFAULT_SOLUTION_ID }) {
    const clauses = [`msdyn_solutionid eq ${solutionId}`, `msdyn_componenttype eq ${type.componentType}`];
    if (type.fixedFilter) clauses.push(type.fixedFilter);
    const text = search.trim();
    if (text) clauses.push(`contains(msdyn_displayname,${quote(text)}) or contains(msdyn_name,${quote(text)})`);
    for (const condition of conditions) {
        const clause = conditionClause(condition);
        if (clause) clauses.push(clause);
    }
    const filter = clauses.map((c) => `(${c})`).join(' and ');
    const select = [...new Set([...BASE_SELECT, ...columns])].join(',');
    // Always end on the name, so rows that tie on every chosen sort column —
    // or on an empty display name — still come back in a stable order and
    // pages cannot overlap.
    const order = sort.map(({ column, dir }) => `${column} ${dir}`);
    if (!sort.some((s) => s.column === 'msdyn_name')) order.push('msdyn_name asc');
    return `/msdyn_solutioncomponentsummaries?$select=${select}`
        + `&$filter=${encodeURIComponent(filter)}&$orderby=${encodeURIComponent(order.join(','))}`;
}

// ── Taking over from the portal ───────────────────────────────────────────
//
// Every portal "Add existing" panel lists its components with one query:
//
//   $filter=((<type clause>)) and (msdyn_iscustomizable eq 'true')
//
// The type clause is anything from `msdyn_componenttype eq 61` to
// `msdyn_componenttype eq 29 and msdyn_workflowcategory ne '5' and …` for
// "Processes", and the customizable test is left out for some types
// (connection references, environment variables). Reusing the clause as it
// was sent reproduces exactly the set the portal showed. Next to it the panel
// sends the same query scoped to the open solution — that one only marks what
// is already in, so it is not a candidate.

/** Index of the paren closing the one at `open`, skipping quoted literals; -1 if none. */
function closingParen(text, open) {
    let depth = 0;
    let quoted = false;
    for (let i = open; i < text.length; i++) {
        const ch = text[i];
        if (ch === "'") {
            if (quoted && text[i + 1] === "'") { i++; continue; }
            quoted = !quoted;
        } else if (!quoted && ch === '(') depth++;
        else if (!quoted && ch === ')' && --depth === 0) return i;
    }
    return -1;
}

function unwrap(expr) {
    let text = expr.trim();
    while (text.startsWith('(') && closingParen(text, 0) === text.length - 1) text = text.slice(1, -1).trim();
    return text;
}

/** The top-level `and` operands of a filter, each without its outer parens. */
export function conjuncts(filter) {
    const text = unwrap(filter);
    const parts = [];
    let depth = 0;
    let quoted = false;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "'") {
            if (quoted && text[i + 1] === "'") { i++; continue; }
            quoted = !quoted;
        } else if (quoted) continue;
        else if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (depth === 0 && /^ and /i.test(text.slice(i, i + 5))) {
            parts.push(text.slice(start, i));
            start = i + 5;
            i += 4;
        }
    }
    parts.push(text.slice(start));
    return parts.map(unwrap).filter(Boolean);
}

/**
 * What a portal "Add existing" list query asked for, or null when the URL is
 * not one: { orgUrl, componentType, typeClause, customizableOnly, search }.
 */
export function parsePortalQuery(url) {
    let parsed;
    try { parsed = new URL(url); } catch { return null; }
    if (!/\/msdyn_solutioncomponentsummaries$/i.test(parsed.pathname)) return null;
    const filter = parsed.searchParams.get('$filter');
    if (!filter) return null;

    const scoped = filter.match(new RegExp(`msdyn_solutionid eq (${GUID.source})`, 'i'))?.[1]?.toLowerCase();
    if (scoped && scoped !== DEFAULT_SOLUTION_ID) return null;

    const result = { orgUrl: parsed.origin, componentType: null, typeClause: null, customizableOnly: false, search: '' };
    for (const part of conjuncts(filter)) {
        if (/^msdyn_iscustomizable eq 'true'$/i.test(part)) { result.customizableOnly = true; continue; }
        const search = part.match(/contains\(msdyn_name,\s*'((?:[^']|'')*)'\)/i);
        if (search) { result.search = search[1].replace(/''/g, "'"); continue; }
        const type = part.match(/msdyn_componenttype eq (\d+)/i);
        if (type && result.componentType == null) {
            result.componentType = Number(type[1]);
            result.typeClause = part.replace(/\s+/g, ' ');
        }
    }
    return result.componentType == null ? null : result;
}

/** The listed type that shows exactly what the portal's clause does, or null. */
export function typeForPortalClause(clause, types) {
    const plain = clause.match(/^msdyn_componenttype eq (\d+)$/i);
    if (plain) return types.find((t) => !t.fixedFilter && t.componentType === Number(plain[1])) ?? null;
    const category = clause.match(/^msdyn_componenttype eq 29 and msdyn_workflowcategory eq '(\d+)'$/i);
    if (category) return types.find((t) => t.key === `29-${category[1]}`) ?? null;
    return null;
}

// ── Formatting ────────────────────────────────────────────────────────────

function formatCell(column, value) {
    if (value == null || value === '') return '';
    const kind = COLUMNS[column]?.kind;
    if (kind === 'bool') return String(value) === 'true' ? 'Yes' : 'No';
    if (kind === 'date') {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? String(value)
            : date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
    }
    return String(value);
}

// ── Styles ────────────────────────────────────────────────────────────────
// The grid itself is shared (see shared/grid.js); only the rows already in the
// target solution are styled here.

const STYLE = `
    .grid-table tbody tr.in-target { cursor: default; }
    .grid-table tbody tr.in-target td { color: var(--muted); }
`;

// ── Environment ───────────────────────────────────────────────────────────

/**
 * The Dataverse client and the solution the page is showing, if any. An org
 * URL taken from the portal's own request needs no lookup at all.
 */
async function resolveContext(knownOrgUrl = null) {
    const solutionId = location.pathname.match(new RegExp(`/solutions/(${GUID.source})`, 'i'))?.[1]?.toLowerCase() ?? null;
    if (knownOrgUrl && getSite() !== 'dynamics') {
        return { dv: new Dataverse(knownOrgUrl), solutionId, envKey: new URL(knownOrgUrl).host };
    }
    const org = await resolveCurrentOrg({ purpose: 'its components can be listed and added' });
    return org && { dv: org.dv, solutionId, envKey: org.host };
}

// ── Panel ─────────────────────────────────────────────────────────────────

let panelOpen = false;

/**
 * `preset` comes from the portal's Add-existing panel: the parsed query
 * (see parsePortalQuery) plus the panel's `title`.
 */
async function openPanel(preset = null) {
    if (panelOpen) return;
    const context = await resolveContext(preset?.orgUrl);
    if (!context) { ui.toast('Cancelled — a Dynamics 365 URL is needed to list components.'); return; }
    panelOpen = true;
    const { dv, envKey } = context;

    const remembered = await store.get('lastTarget', {});
    const views = await store.get('views', {});
    let typeKey = await store.get('lastType', '61');

    // The org-specific types arrive with their own request. Only wait for it
    // when the type to open is one of them; otherwise it loads alongside the
    // first page.
    const dynamicTypes = loadDynamicTypes(dv);
    let portalType = null;
    const withDynamic = (dynamic) => [...(portalType ? [portalType] : []), ...CORE_TYPES,
        ...dynamic.filter((t) => t.promoted), ...dynamic.filter((t) => !t.promoted)];
    let types = CORE_TYPES;
    if (preset) {
        let match = typeForPortalClause(preset.typeClause, CORE_TYPES);
        if (!match && !CORE_TYPES.some((t) => t.componentType === preset.componentType)) {
            types = withDynamic(await dynamicTypes);
            match = typeForPortalClause(preset.typeClause, types);
        }
        if (match) typeKey = match.key;
        else {
            // A selection none of ours reproduces ("Processes" is every
            // category but three) is kept exactly as the portal sent it.
            portalType = {
                key: 'portal', label: preset.title || `Component type ${preset.componentType}`,
                componentType: preset.componentType, fixedFilter: preset.typeClause,
                columns: preset.componentType === 29 ? FLOW_COLUMNS : undefined,
            };
            types = [portalType, ...types];
            typeKey = portalType.key;
        }
    } else if (!CORE_TYPES.some((t) => t.key === typeKey)) {
        types = withDynamic(await dynamicTypes);
        if (!types.some((t) => t.key === typeKey)) typeKey = '61';
    }

    const state = {
        solutions: [],
        targetId: context.solutionId ?? remembered[envKey] ?? '',
        types,
        typeKey,
        columns: [],
        sort: [],
        conditions: [],
        search: '',
        rows: [],
        nextLink: null,
        loading: false,
        error: null,
        seq: 0,
        inTarget: new Set(),
        selected: new Map(), // objectid → row
        lastClicked: null,
        adding: false,
        addRequired: false,
        includeSubcomponents: false,
    };
    const currentType = () => state.types.find((t) => t.key === state.typeKey) ?? CORE_TYPES[0];

    function applyView() {
        const type = currentType();
        const saved = views[type.key];
        state.columns = (saved?.columns ?? type.columns ?? DEFAULT_COLUMNS).filter((c) => COLUMNS[c]);
        state.sort = (saved?.sort ?? []).filter((s) => COLUMNS[s.column]);
        // Same default as the portal: only what can be customized. Kept as an
        // ordinary chip so it can be removed like any other filter.
        state.conditions = [{ column: 'msdyn_iscustomizable', op: 'true', value: '' }];
    }
    applyView();
    if (preset) {
        // Whatever the portal panel was filtering on carries over.
        if (!preset.customizableOnly) state.conditions = [];
        state.search = preset.search ?? '';
    }

    function saveView() {
        views[state.typeKey] = { columns: state.columns, sort: state.sort };
        store.set('views', views);
    }

    // ── Layout ──
    const backdrop = ui.mount(ui.el('div', { className: 'ppt grid-backdrop' }));
    let releaseEscape = () => {};
    const dispose = () => {
        panelOpen = false;
        menus.close();
        backdrop.remove();
        releaseEscape();
    };
    releaseEscape = ui.onEscape(dispose);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) dispose(); });

    const targetSelect = ui.el('select', { className: 'ppt-select', style: 'min-width:220px' });
    const typeSelect = ui.el('select', { className: 'ppt-select', style: 'min-width:200px' });
    const searchInput = ui.el('input', {
        className: 'ppt-input', type: 'text', placeholder: '🔍 Search name / display name…', style: 'min-width:240px',
        value: state.search,
    });
    const columnsButton = ui.el('button', { className: 'ppt-btn', textContent: '▦ Columns', title: 'Choose the columns shown' });
    const chips = ui.el('div', { className: 'grid-chips' });
    const content = ui.el('div', { className: 'grid-content' });
    const status = ui.el('div', { className: 'grid-status' });
    const selectedLabel = ui.el('span', { className: 'grid-dim' });
    const addButton = ui.el('button', { className: 'ppt-btn primary', textContent: 'Add to solution' });
    const requiredBox = ui.el('input', { type: 'checkbox' });
    const subcomponentsBox = ui.el('input', { type: 'checkbox' });
    const subcomponentsLabel = ui.el('label', { title: 'Tables only: add every column, form, view and relationship too, instead of the table alone' },
        [subcomponentsBox, 'Include all table objects']);

    const panel = ui.el('div', { className: 'grid-panel' }, [
        ui.el('div', { className: 'grid-header' }, [
            ui.el('h2', { textContent: '➕ Add Existing Components' }),
            ui.el('button', { className: 'ppt-icon-btn', textContent: '✕', title: 'Close', onclick: dispose }),
        ]),
        ui.el('div', { className: 'grid-toolbar' }, [
            ui.el('label', { className: 'grid-field' }, [ui.el('span', { textContent: 'Add to' }), targetSelect]),
            ui.el('label', { className: 'grid-field' }, [ui.el('span', { textContent: 'Component type' }), typeSelect]),
            ui.el('label', { className: 'grid-field', style: 'flex:1' }, [ui.el('span', { textContent: 'Search' }), searchInput]),
            ui.el('div', { className: 'grid-field' }, [ui.el('span', { innerHTML: '&nbsp;' }), columnsButton]),
        ]),
        chips,
        content,
        status,
        ui.el('div', { className: 'grid-footer' }, [
            selectedLabel,
            ui.el('div', { style: 'display:flex;align-items:center;gap:16px' }, [
                subcomponentsLabel,
                ui.el('label', { title: 'Also add every component the selection depends on' }, [requiredBox, 'Add required components']),
                addButton,
            ]),
        ]),
    ]);
    backdrop.appendChild(panel);

    // ── Popover menus (column header, column picker) ──
    const menus = createMenus(backdrop);
    const openMenu = menus.open;

    function openColumnMenu(anchor, column) {
        openMenu(anchor, (menu, close) => {
            const sortBy = (dir) => (e) => {
                state.sort = applySort(state.sort, column, dir, e.shiftKey);
                saveView(); close(); reload();
            };
            menu.append(
                menuItem('↑ Sort A to Z', sortBy('asc')),
                menuItem('↓ Sort Z to A', sortBy('desc')),
                ui.el('div', { className: 'grid-dim', style: 'padding:0 10px 4px', textContent: 'Shift-click to add as a secondary sort' }),
                ui.el('hr'),
            );
            menu.append(filterForm(column, close));
            menu.append(ui.el('hr'));
            if (state.conditions.some((c) => c.column === column)) {
                menu.append(menuItem('✕ Clear filters on this column', () => {
                    state.conditions = state.conditions.filter((c) => c.column !== column);
                    close(); reload();
                }));
            }
            if (state.columns.length > 1) {
                menu.append(menuItem('Remove column', () => {
                    state.columns = state.columns.filter((c) => c !== column);
                    state.sort = state.sort.filter((s) => s.column !== column);
                    saveView(); close(); reload();
                }));
            }
        });
    }

    function filterForm(column, close) {
        const kind = COLUMNS[column].kind;
        const form = ui.el('div', { style: 'padding:4px 6px' });
        form.appendChild(ui.el('div', { className: 'grid-menu-title', style: 'padding:0 0 6px', textContent: `Filter by ${COLUMNS[column].label}` }));
        const opSelect = ui.el('select', { className: 'ppt-select' },
            OPERATORS[kind].map(([value, label]) => ui.el('option', { value, textContent: label })));
        const valueInput = ui.el('input', {
            className: 'ppt-input', type: kind === 'date' ? 'date' : 'text',
            placeholder: kind === 'category' ? 'Type or pick a value' : 'Value',
        });
        let valueField = valueInput;
        if (kind === 'category') {
            // Offer what is actually there — the loaded rows' distinct values.
            const values = [...new Set(state.rows.map((r) => r[column]).filter((v) => v != null && v !== ''))].map(String).sort();
            valueField = ui.suggest({
                input: valueInput,
                items: (text) => values.filter((v) => !text || v.toLowerCase().includes(text.toLowerCase())).map((v) => ({ label: v })),
                onPick: (item) => { valueInput.value = item.label; },
            }).node;
        }
        const syncValue = () => {
            const op = opSelect.value;
            valueField.style.display = needsValue(op) ? '' : 'none';
            valueInput.type = op === 'lastdays' ? 'number' : kind === 'date' ? 'date' : 'text';
        };
        opSelect.addEventListener('change', syncValue);
        syncValue();
        const apply = () => {
            const condition = { column, op: opSelect.value, value: valueInput.value };
            if (!conditionClause(condition)) { valueInput.focus(); return; }
            // A bool column only ever needs one condition — Yes replaces No.
            if (kind === 'bool') state.conditions = state.conditions.filter((c) => c.column !== column);
            state.conditions.push(condition);
            close(); reload();
        };
        valueInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
        form.append(opSelect, valueField, ui.el('button', { className: 'ppt-btn primary', style: 'width:100%', textContent: 'Apply filter', onclick: apply }));
        setTimeout(() => (needsValue(opSelect.value) ? valueInput : opSelect).focus(), 0);
        return form;
    }

    columnsButton.addEventListener('click', () => openMenu(columnsButton, (menu) => {
        menu.appendChild(ui.el('div', { className: 'grid-menu-title', textContent: 'Columns' }));
        const list = ui.el('div', { className: 'grid-colpick' });
        // Columns this type never fills are listed last, so the useful ones
        // are not lost among the fields that only mean something for plug-ins.
        const filled = (c) => state.rows.some((r) => r[c] != null && r[c] !== '');
        const keys = Object.keys(COLUMNS).sort((a, b) =>
            (state.columns.includes(b) - state.columns.includes(a))
            || (state.rows.length ? filled(b) - filled(a) : 0));
        for (const key of keys) {
            const box = ui.el('input', { type: 'checkbox', checked: state.columns.includes(key) });
            box.addEventListener('change', () => {
                if (box.checked) state.columns.push(key);
                else if (state.columns.length > 1) state.columns = state.columns.filter((c) => c !== key);
                else { box.checked = true; return; }
                state.sort = state.sort.filter((s) => state.columns.includes(s.column));
                saveView();
                reload();
            });
            list.appendChild(ui.el('label', {}, [box, COLUMNS[key].label]));
        }
        menu.append(list, ui.el('hr'), menuItem('↺ Reset to default columns', () => {
            delete views[state.typeKey];
            store.set('views', views);
            const type = currentType();
            state.columns = [...(type.columns ?? DEFAULT_COLUMNS)];
            state.sort = [];
            menus.close(); reload();
        }));
    }));

    // ── Rendering ──
    function renderChips() {
        chips.replaceChildren();
        state.conditions.forEach((condition, i) => {
            chips.appendChild(chip(describeCondition(condition),
                () => { state.conditions.splice(i, 1); reload(); }, { removeTitle: 'Remove filter' }));
        });
        state.sort.forEach((s, i) => {
            chips.appendChild(chip(sortChipText(state.sort, i, COLUMNS[s.column].label),
                () => { state.sort.splice(i, 1); saveView(); reload(); }, { sort: true, removeTitle: 'Remove sort' }));
        });
        if (state.conditions.length || state.sort.length || state.search) {
            chips.appendChild(ui.el('button', {
                className: 'grid-link', textContent: 'Clear all',
                onclick: () => {
                    state.conditions = [];
                    state.sort = [];
                    state.search = searchInput.value = '';
                    saveView(); reload();
                },
            }));
        }
    }

    function selectableRows() {
        return state.rows.filter((r) => !state.inTarget.has(r.msdyn_objectid));
    }

    function renderTable() {
        content.replaceChildren();
        if (state.error) {
            content.appendChild(ui.el('div', { className: 'ppt-note', style: 'color:var(--danger);margin:12px', textContent: state.error }));
            return;
        }
        if (state.loading && !state.rows.length) {
            content.appendChild(loadingBlock('Loading components…'));
            return;
        }
        if (!state.rows.length) {
            content.appendChild(ui.el('div', { className: 'ppt-note', style: 'text-align:center;padding:24px;margin:12px', textContent: '📭 No components match.' }));
            return;
        }

        const selectable = selectableRows();
        const allBox = ui.el('input', {
            type: 'checkbox', title: 'Select all loaded rows',
            checked: selectable.length > 0 && selectable.every((r) => state.selected.has(r.msdyn_objectid)),
        });
        allBox.addEventListener('click', (e) => e.stopPropagation());
        allBox.addEventListener('change', () => {
            for (const row of selectable) {
                if (allBox.checked) state.selected.set(row.msdyn_objectid, row);
                else state.selected.delete(row.msdyn_objectid);
            }
            renderTable(); renderStatus();
        });

        const headRow = ui.el('tr', {}, [ui.el('th', { className: 'check' }, [allBox])]);
        for (const column of state.columns) {
            headRow.appendChild(ui.el('th', {}, [headerButton({
                label: COLUMNS[column].label, sort: state.sort, column,
                filtered: state.conditions.some((c) => c.column === column),
                onClick: (button) => openColumnMenu(button, column),
            })]));
        }

        const tbody = ui.el('tbody');
        state.rows.forEach((row, index) => {
            const id = row.msdyn_objectid;
            const inTarget = state.inTarget.has(id);
            const selected = state.selected.has(id);
            const box = ui.el('input', { type: 'checkbox', checked: selected || inTarget, disabled: inTarget });
            const tr = ui.el('tr', { className: `${selected ? 'selected' : ''}${inTarget ? ' in-target' : ''}` },
                [ui.el('td', { className: 'check' }, [box])]);
            state.columns.forEach((column, i) => {
                const text = formatCell(column, row[column]) || (column === 'msdyn_displayname' ? row.msdyn_name : '');
                const td = ui.el('td', {
                    className: column === 'msdyn_name' || column === 'msdyn_schemaname' || column === 'msdyn_uniquename' ? 'grid-mono' : '',
                    textContent: text,
                });
                if (i === 0 && inTarget) td.append(' ', ui.el('span', { className: 'grid-badge', textContent: 'in solution' }));
                tr.appendChild(td);
            });
            if (!inTarget) {
                tr.addEventListener('click', (e) => {
                    // Shift-click selects the range from the last clicked row.
                    if (e.shiftKey && state.lastClicked != null) {
                        const [from, to] = [state.lastClicked, index].sort((a, b) => a - b);
                        const turnOn = !selected;
                        for (const r of state.rows.slice(from, to + 1)) {
                            if (state.inTarget.has(r.msdyn_objectid)) continue;
                            if (turnOn) state.selected.set(r.msdyn_objectid, r);
                            else state.selected.delete(r.msdyn_objectid);
                        }
                    } else if (selected) state.selected.delete(id);
                    else state.selected.set(id, row);
                    state.lastClicked = index;
                    renderTable(); renderStatus();
                });
            }
            tbody.appendChild(tr);
        });

        const table = ui.el('table', { className: 'grid-table' }, [ui.el('thead', {}, [headRow]), tbody]);
        const scrollTop = content.scrollTop;
        content.appendChild(table);
        content.scrollTop = scrollTop;
    }

    function renderStatus() {
        status.replaceChildren(ui.el('span', {
            className: 'grid-dim',
            textContent: `${state.rows.length} loaded${state.nextLink ? ' — more available' : ''}`
                + (state.inTarget.size ? ` · ${state.rows.filter((r) => state.inTarget.has(r.msdyn_objectid)).length} already in the solution` : ''),
        }));
        if (state.nextLink) {
            status.appendChild(ui.el('button', {
                className: 'ppt-btn',
                textContent: state.loading ? 'Loading…' : `⬇ Load ${PAGE_SIZE} more`,
                disabled: state.loading,
                onclick: () => loadPage(),
            }));
        }
        const count = state.selected.size;
        selectedLabel.textContent = count ? `${count} selected` : 'Nothing selected';
        addButton.disabled = !count || !state.targetId || state.adding;
        addButton.textContent = state.adding ? 'Adding…' : count ? `Add ${count} to solution` : 'Add to solution';
        subcomponentsLabel.style.display = currentType().componentType === 1 ? '' : 'none';
    }

    function render() {
        renderChips();
        renderTable();
        renderStatus();
    }

    // ── Data ──
    async function loadPage({ initial = false } = {}) {
        const seq = ++state.seq;
        state.loading = true;
        state.error = null;
        renderStatus();
        if (initial) renderTable();
        try {
            const path = initial ? buildQuery({
                type: currentType(), conditions: state.conditions, search: state.search,
                sort: state.sort, columns: state.columns,
            }) : state.nextLink;
            const data = await dv.get(path, { Prefer: `odata.maxpagesize=${PAGE_SIZE}` });
            if (seq !== state.seq || !panelOpen) return;
            state.rows.push(...(data.value ?? []));
            state.nextLink = data['@odata.nextLink'] ?? null;
        } catch (e) {
            if (seq !== state.seq || !panelOpen) return;
            state.error = `Could not load components: ${errorMessage(e)}`;
        } finally {
            if (seq === state.seq) {
                state.loading = false;
                render();
            }
        }
    }

    function reload() {
        state.rows = [];
        state.nextLink = null;
        state.lastClicked = null;
        render();
        loadPage({ initial: true });
    }

    /** Object ids of this type already in the target, so they can be marked. */
    async function loadTargetMembers() {
        const type = currentType();
        const targetId = state.targetId;
        state.inTarget = new Set();
        if (!targetId) return;
        try {
            let path = `/solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${targetId} and componenttype eq ${type.componentType}`;
            const ids = new Set();
            while (path) {
                const data = await dv.get(path, { Prefer: 'odata.maxpagesize=5000' });
                for (const row of data.value ?? []) ids.add(row.objectid);
                path = data['@odata.nextLink'] ?? null;
            }
            if (state.targetId !== targetId || currentType() !== type) return;
            state.inTarget = ids;
            for (const id of ids) state.selected.delete(id);
            render();
        } catch (e) {
            console.warn('[Add Existing] could not read the target solution:', e);
        }
    }

    async function addSelected() {
        const target = state.solutions.find((s) => s.solutionid === state.targetId);
        if (!target || !state.selected.size) return;
        const componentType = currentType().componentType;
        const rows = [...state.selected.values()];
        state.adding = true;
        renderStatus();

        let added = 0;
        try {
            for (let i = 0; i < rows.length; i += ADD_CHUNK) {
                const changeSet = dv.changeSet();
                // An unbound action is POSTed at its own name, which is all
                // ChangeSet#create does with an entity set.
                for (const row of rows.slice(i, i + ADD_CHUNK)) {
                    changeSet.create('AddSolutionComponent', {
                        ComponentId: row.msdyn_objectid,
                        ComponentType: componentType,
                        SolutionUniqueName: target.uniquename,
                        AddRequiredComponents: requiredBox.checked,
                        DoNotIncludeSubcomponents: componentType === 1 ? !subcomponentsBox.checked : false,
                    });
                }
                addButton.textContent = `Adding ${Math.min(i + ADD_CHUNK, rows.length)} / ${rows.length}…`;
                await dv.batch(changeSet);
                for (const row of rows.slice(i, i + ADD_CHUNK)) {
                    state.inTarget.add(row.msdyn_objectid);
                    state.selected.delete(row.msdyn_objectid);
                }
                added += Math.min(ADD_CHUNK, rows.length - i);
            }
            ui.toast(`✅ Added ${added} component${added === 1 ? '' : 's'} to ${target.friendlyname}.`
                + (getSite() === 'dynamics' ? '' : ' Refresh the solution page to see them.'), 5000);
        } catch (e) {
            ui.toast(`⚠️ ${added ? `Added ${added}, then failed` : 'Could not add'}: ${errorMessage(e)}`, 8000);
        } finally {
            state.adding = false;
            render();
        }
    }

    // ── Wiring ──
    targetSelect.addEventListener('change', () => {
        state.targetId = targetSelect.value;
        store.set('lastTarget', { ...remembered, [envKey]: state.targetId });
        remembered[envKey] = state.targetId;
        loadTargetMembers();
        renderStatus();
    });
    typeSelect.addEventListener('change', () => {
        state.typeKey = typeSelect.value;
        store.set('lastType', state.typeKey);
        state.selected.clear();
        applyView();
        loadTargetMembers();
        reload();
    });
    let searchDebounce = null;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => { state.search = searchInput.value; reload(); }, 350);
    });
    addButton.addEventListener('click', addSelected);

    function renderTypeOptions() {
        const core = state.types.filter((t) => !t.key.startsWith('t') || t.promoted);
        const more = state.types.filter((t) => t.key.startsWith('t') && !t.promoted);
        const option = (t) => ui.el('option', { value: t.key, textContent: t.label, selected: t.key === state.typeKey });
        typeSelect.replaceChildren(
            ui.el('optgroup', { label: 'Common' }, core.map(option)),
            ...(more.length ? [ui.el('optgroup', { label: 'More component types' }, more.map(option))] : []),
        );
    }
    renderTypeOptions();

    // Solutions and the org-specific types load alongside the first page.
    (async () => {
        try {
            const data = await dv.get('/solutions?$filter=ismanaged eq false and isvisible eq true and uniquename ne \'Default\''
                + '&$select=solutionid,friendlyname,uniquename,version&$orderby=friendlyname asc');
            state.solutions = data.value ?? [];
        } catch (e) {
            state.error = `Could not list solutions: ${errorMessage(e)}`;
        }
        if (!state.solutions.some((s) => s.solutionid === state.targetId)) state.targetId = '';
        targetSelect.replaceChildren(
            ui.el('option', { value: '', textContent: '— pick a solution —' }),
            ...state.solutions.map((s) => ui.el('option', {
                value: s.solutionid, textContent: `${s.friendlyname} (${s.version})`, selected: s.solutionid === state.targetId,
            })),
        );
        loadTargetMembers();
        renderStatus();
    })();
    dynamicTypes.then((dynamic) => {
        if (!panelOpen || !dynamic.length) return;
        state.types = withDynamic(dynamic);
        renderTypeOptions();
    });

    reload();
    setTimeout(() => searchInput.focus(), 0);
}

// ── Portal panel hand-off ─────────────────────────────────────────────────
//
// The portal's queries are read from Resource Timing entries rather than by
// wrapping its fetch/XHR: an entry carries the full URL of every request the
// page makes, needs no MAIN-world code, and leaves the page's own network
// stack untouched.

// A dialog is the portal's Add-existing panel when it carries this subheader —
// a class name, not text, so it holds in every UI language.
const PORTAL_PANEL = '[role="dialog"][aria-modal="true"]';
const PORTAL_PANEL_MARKER = '.solution-components-addexisting-subheader';
// The panel's query can start a moment before the panel is in the DOM.
const QUERY_LEAD_MS = 3000;

function watchPortalPanel() {
    const queries = []; // { at, preset } — recent list queries, oldest first
    try {
        new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                if (!entry.name.includes('msdyn_solutioncomponentsummaries')) continue;
                const preset = parsePortalQuery(entry.name);
                if (!preset) continue;
                queries.push({ at: entry.startTime, preset });
                if (queries.length > 20) queries.shift();
            }
        }).observe({ type: 'resource', buffered: true });
    } catch (e) {
        console.warn('[Add Existing] resource timing is unavailable; the portal hand-off is off:', e);
        return;
    }

    let current = null; // { dialog, surface, openedAt }

    function attach(dialog) {
        const header = dialog.querySelector('[id$="-headerText"]');
        if (!header?.parentElement) return;
        const surf = ui.surface(header.parentElement);
        const button = ui.el('button', {
            className: 'ppt-btn', style: 'margin-left:12px;padding:4px 10px;font-size:12px;white-space:nowrap',
            textContent: '🔍 Filter & sort in Toolbox',
            title: 'Open this list in Add Existing Components — sort and filter on any column',
        });
        button.addEventListener('click', () => handOff(dialog, header.textContent.trim()));
        surf.root.appendChild(ui.el('span', { className: 'ppt', style: 'display:inline-flex;align-items:center' }, [button]));
        current = { dialog, surface: surf, openedAt: performance.now() };
    }

    function handOff(dialog, title) {
        // The newest list query sent for this panel: the one it opened with,
        // or a later one if the user has searched since.
        const since = (current?.openedAt ?? 0) - QUERY_LEAD_MS;
        const query = [...queries].reverse().find((q) => q.at >= since);
        if (!query) {
            ui.toast('Could not tell which components this panel lists yet — try again once it has loaded.');
            return;
        }
        // The panel searches its list client-side — typing only re-sends the
        // "already in this solution" query — so what was typed is read from
        // the box itself.
        const typed = dialog.querySelector('input[role="searchbox"]')?.value?.trim();
        // Its first button is the close (×). Closing it keeps the portal from
        // showing a stale list once components are added from our panel.
        dialog.querySelector('button')?.click();
        openPanel({ ...query.preset, title, search: typed || query.preset.search });
    }

    let frame = 0;
    const check = () => {
        frame = 0;
        if (current && !current.dialog.isConnected) {
            current.surface.destroy();
            current = null;
        }
        if (current) return;
        const dialog = [...document.querySelectorAll(PORTAL_PANEL)].find((d) => d.querySelector(PORTAL_PANEL_MARKER));
        if (dialog) attach(dialog);
    };
    // The portal re-renders constantly; coalesce into one check per frame.
    new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(check); })
        .observe(document.body ?? document.documentElement, { childList: true, subtree: true });
    check();
}

export default {
    init({ store: toolStore }) {
        store = toolStore;
        installGridStyle();
        ui.addStyle('sae', STYLE);
        commands.register({
            toolId: 'solution-add-existing',
            title: 'Add Existing Components (filterable)',
            icon: '➕', svg: 'addSquareMultiple',
            run: () => openPanel(),
        });
        if (getSite() === 'powerapps-maker') watchPortalPanel();
    },
};
