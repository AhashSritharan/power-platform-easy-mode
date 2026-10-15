// Record Browser (native).
// Every record of a table in a grid, with every column — no view to edit
// first, and nothing changed in the org. Opened from a list it starts on that
// view: its columns lead, and its filter shows as a chip that can be removed
// to see the whole table. Sort on any column (several at once), filter any
// column with operators that fit its type, pick or hide the columns. The
// search box looks in every column and marks the phrase where it occurs.
// Clicking a row opens it in the Record Editor; file columns download and
// image columns show their thumbnail. Read-only by design.
//
// Queries are FetchXML rather than OData: only FetchXML can take a view's
// filter (link-entity conditions included) and add ours to it, filter a
// lookup on its name, and sort a lookup by name. Paging uses the paging
// cookie, with the primary key as the last sort so pages never overlap.
// A query naming hundreds of columns can pass the URL limit; past that it is
// sent as a GET inside $batch, where it travels in the body.

import { Dataverse } from '../core/dataverse.js';
import { request, HttpError } from '../core/http.js';
import * as ui from '../core/ui.js';
import * as commands from '../core/commands.js';
import { openRecordForm } from '../core/agent.js';
import { cleanGuid, fetchEntityInfo, fetchOptionsetColors, choiceColor } from './shared/records.js';
import { fileLink, imageThumb, saveBlob } from './shared/record-files.js';
import {
    installGridStyle, applySort, createMenus, menuItem, chip, sortChipText, headerButton, loadingBlock, errorMessage,
} from './shared/grid.js';
import { openRecordEditor } from './field-editor.js';

let store; // set in init()

const PAGE_SIZE = 100;
// Comfortably under the 32 KB Dataverse accepts for a GET URL.
const MAX_URL = 30000;

// ── Columns ───────────────────────────────────────────────────────────────
//
// kind decides how a column is fetched, shown, sorted and filtered:
//   text, number, date, bool, guid   plain values
//   choice     one option — filtered by picking options
//   choices    multi-select — filtered with contain-values
//   lookup     a reference — filtered and sorted on the record's name
//   file       a download link; image: its thumbnail. Neither sorts or filters.

const KINDS = {
    String: 'text', Memo: 'text', EntityName: 'text',
    Integer: 'number', BigInt: 'number', Double: 'number', Decimal: 'number', Money: 'number',
    DateTime: 'date', Boolean: 'bool', Uniqueidentifier: 'guid',
    Picklist: 'choice', State: 'choice', Status: 'choice',
    Lookup: 'lookup', Customer: 'lookup', Owner: 'lookup',
};
const VIRTUAL_KINDS = { MultiSelectPicklistType: 'choices', FileType: 'file', ImageType: 'image' };
// Lookups that always point at a user, so "is me" can be offered on them.
const USER_LOOKUPS = new Set(['createdby', 'modifiedby', 'createdonbehalfby', 'modifiedonbehalfby', 'owninguser']);

/**
 * A column from its attribute metadata, or null when it has nothing to show.
 * `names` is every attribute's logical name, for the lookup-name companions.
 */
export function toColumn(attr, names = new Set()) {
    if (!attr.IsValidForRead) return null;
    const kind = attr.AttributeType === 'Virtual' ? VIRTUAL_KINDS[attr.AttributeTypeName?.Value] : KINDS[attr.AttributeType];
    // Companions (lookup names, an image's url) are left out — but an image
    // column itself names its id column as AttributeOf.
    if (!kind || (attr.AttributeOf && kind !== 'image' && kind !== 'file')) return null;
    const name = attr.LogicalName;
    return {
        name,
        label: attr.DisplayName?.UserLocalizedLabel?.Label || name,
        type: attr.AttributeType,
        kind,
        // SQL cannot order by long text; files, images and multi-selects have no order.
        sortable: !['file', 'image', 'choices'].includes(kind) && attr.AttributeType !== 'Memo',
        filterable: kind !== 'file' && kind !== 'image',
        nameAttr: kind === 'lookup' && names.has(`${name}name`) ? `${name}name` : null,
        isUser: kind === 'lookup' && (attr.AttributeType === 'Owner' || USER_LOOKUPS.has(name)),
    };
}

/**
 * Every column of a table from its attribute metadata, by label. An image's
 * id column (entityimageid) is dropped: the image column shows it better.
 */
export function columnsFromMetadata(attrs, maxLengths = new Map()) {
    const names = new Set(attrs.map((a) => a.LogicalName));
    const imageIds = new Set(attrs.filter((a) => a.AttributeTypeName?.Value === 'ImageType' && a.AttributeOf).map((a) => a.AttributeOf));
    return attrs.filter((a) => !imageIds.has(a.LogicalName)).map((a) => toColumn(a, names)).filter(Boolean)
        .map((col) => (maxLengths.get(col.name) > BLOB_LENGTH ? { ...col, blob: true } : col))
        .sort((a, b) => a.label.localeCompare(b.label));
}

// Text columns sized for whole files (a web resource's content, a solution's
// upgrade info: ~1 GB) are left out of the all-column search. A contains-match
// over them took a web resource search from under a second to 37. Ordinary
// text columns stop at 1 MB.
const BLOB_LENGTH = 1024 * 1024;

/** Where a column's value sits on a returned row. */
export const valueKey = (col) => (col.kind === 'lookup' ? `_${col.name}_value` : col.name);

const FORMATTED = '@OData.Community.Display.V1.FormattedValue';

// ── Operators ─────────────────────────────────────────────────────────────

const DATA_OPS = [['hasdata', 'Contains data'], ['nodata', 'Does not contain data']];
const TEXT_OPS = [
    ['contains', 'Contains'], ['notcontains', 'Does not contain'],
    ['startswith', 'Begins with'], ['notstartswith', 'Does not begin with'],
    ['endswith', 'Ends with'], ['eq', 'Equals'], ['ne', 'Does not equal'],
];

/** The operators a column offers: [op, label][]. */
export function operatorsFor(col) {
    switch (col.kind) {
        case 'text': return [...TEXT_OPS, ...DATA_OPS];
        case 'number': return [['eq', 'Equals'], ['ne', 'Does not equal'], ['gt', 'Greater than'], ['ge', 'Greater than or equal to'],
            ['lt', 'Less than'], ['le', 'Less than or equal to'], ...DATA_OPS];
        case 'date': return [['on', 'On'], ['onorafter', 'On or after'], ['onorbefore', 'On or before'],
            ['lastdays', 'In the last N days'], ...DATA_OPS];
        case 'bool': return [['true', 'Yes'], ['false', 'No'], ...DATA_OPS];
        case 'guid': return [['eq', 'Equals'], ['ne', 'Does not equal'], ...DATA_OPS];
        case 'choice': return [['in', 'Equals'], ['notin', 'Does not equal'], ...DATA_OPS];
        case 'choices': return [['containvalues', 'Contains values'], ['notcontainvalues', 'Does not contain values'], ...DATA_OPS];
        case 'lookup': return [
            ...(col.nameAttr ? [['contains', 'Name contains'], ['startswith', 'Name begins with'], ['eq', 'Name equals']] : []),
            ...(col.isUser ? [['me', 'Is me']] : []),
            ['id', 'Record id equals'], ...DATA_OPS,
        ];
        default: return [];
    }
}

const NO_VALUE_OPS = new Set(['hasdata', 'nodata', 'true', 'false', 'me']);
export const needsValue = (op) => !NO_VALUE_OPS.has(op);
const LIST_OPS = new Set(['in', 'notin', 'containvalues', 'notcontainvalues']);
const isGuid = (v) => /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i.test(v);

// ── FetchXML ──────────────────────────────────────────────────────────────

export const xmlEscape = (value) => String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// In a like value % _ and [ are wildcards; bracketed, they match themselves.
const likeEscape = (value) => String(value).replace(/[[%_]/g, (ch) => `[${ch}]`);

const condition = (attribute, operator, value) => (value === undefined
    ? `<condition attribute="${xmlEscape(attribute)}" operator="${operator}" />`
    : `<condition attribute="${xmlEscape(attribute)}" operator="${operator}" value="${xmlEscape(value)}" />`);

const valuesCondition = (attribute, operator, values) =>
    `<condition attribute="${xmlEscape(attribute)}" operator="${operator}">${values.map((v) => `<value>${xmlEscape(v)}</value>`).join('')}</condition>`;

/** One filter condition as FetchXML, or null when it is incomplete. */
export function conditionXml(col, { op, value }) {
    const list = Array.isArray(value) ? value : null;
    const v = list ? null : String(value ?? '').trim();
    if (needsValue(op) && (list ? !list.length : !v)) return null;
    const name = col.name;
    if (op === 'hasdata') return condition(name, 'not-null');
    if (op === 'nodata') return condition(name, 'null');

    // A GUID column takes only a GUID: anything else is a FormatException.
    if (col.kind === 'guid') return isGuid(v) && (op === 'eq' || op === 'ne') ? condition(name, op, cleanGuid(v)) : null;
    // Text and lookup names compare alike; a lookup compares on its name column.
    const textOn = col.kind === 'lookup' ? col.nameAttr : name;
    switch (op) {
        case 'contains': return condition(textOn, 'like', `%${likeEscape(v)}%`);
        case 'notcontains': return condition(textOn, 'not-like', `%${likeEscape(v)}%`);
        case 'startswith': return condition(textOn, 'like', `${likeEscape(v)}%`);
        case 'notstartswith': return condition(textOn, 'not-like', `${likeEscape(v)}%`);
        case 'endswith': return condition(textOn, 'like', `%${likeEscape(v)}`);
        case 'eq': return condition(textOn, 'eq', v);
        case 'ne': return condition(textOn, 'ne', v);
        case 'gt': case 'ge': case 'lt': case 'le': return condition(name, op, v);
        case 'on': return condition(name, 'on', v);
        case 'onorafter': return condition(name, 'on-or-after', v);
        case 'onorbefore': return condition(name, 'on-or-before', v);
        case 'lastdays': {
            const days = Number.parseInt(v, 10);
            return days > 0 ? condition(name, 'last-x-days', String(days)) : null;
        }
        case 'true': return condition(name, 'eq', '1');
        case 'false': return condition(name, 'eq', '0');
        case 'in': return valuesCondition(name, 'in', list);
        case 'notin': return valuesCondition(name, 'not-in', list);
        case 'containvalues': return valuesCondition(name, 'contain-values', list);
        case 'notcontainvalues': return valuesCondition(name, 'not-contain-values', list);
        case 'me': return condition(name, 'eq-userid');
        case 'id': return isGuid(v) ? condition(name, 'eq', cleanGuid(v)) : null;
        default: return null;
    }
}

/** How a condition reads on its chip: "Name begins with "Con"". */
export function describeCondition(col, { op, value, labels }) {
    const opLabel = operatorsFor(col).find(([key]) => key === op)?.[1] ?? op;
    if (col.kind === 'bool' && (op === 'true' || op === 'false')) return `${col.label}: ${opLabel}`;
    if (op === 'lastdays') return `${col.label} in the last ${value} days`;
    if (!needsValue(op)) return `${col.label} ${opLabel.toLowerCase()}`;
    const shown = LIST_OPS.has(op) ? (labels ?? value).join(', ') : value;
    return `${col.label} ${opLabel.toLowerCase()} "${shown}"`;
}

/**
 * The query for one grid state.
 *   entity      { name, primaryId, primaryName }
 *   columns     column objects to fetch
 *   conditions  [{ column, op, value }] — column is a logical name
 *   view        { filters, links, orders, distinct } from viewParts, or null
 */
/**
 * The search box as one OR filter over every column that can hold the
 * phrase: text contains it, a lookup's record name contains it, a choice has
 * an option whose label contains it (`options`: column → [{ value, label }]),
 * and a number or GUID column equals it when the phrase is one. Dates,
 * yes/no, files and images are not searched. Null when nothing can match.
 */
export function searchFilterXml(columns, text, options = new Map()) {
    const phrase = String(text ?? '').trim();
    if (!phrase) return null;
    const like = `%${likeEscape(phrase)}%`;
    const lower = phrase.toLowerCase();
    const number = /^-?\d+(\.\d+)?$/.test(phrase) ? Number(phrase) : null;
    const guid = isGuid(phrase) ? cleanGuid(phrase) : null;
    const conditions = [];
    for (const col of columns) {
        switch (col.kind) {
            case 'text': if (!col.blob) conditions.push(condition(col.name, 'like', like)); break;
            case 'lookup':
                if (col.nameAttr) conditions.push(condition(col.nameAttr, 'like', like));
                if (guid) conditions.push(condition(col.name, 'eq', guid));
                break;
            case 'choice': case 'choices': {
                const values = (options.get(col.name) ?? []).filter((o) => o.label.toLowerCase().includes(lower)).map((o) => String(o.value));
                if (values.length) conditions.push(valuesCondition(col.name, col.kind === 'choice' ? 'in' : 'contain-values', values));
                break;
            }
            case 'number':
                // A whole-number column refuses 12.5 outright rather than not matching it.
                if (number != null && (Number.isInteger(number) || !['Integer', 'BigInt'].includes(col.type))) {
                    conditions.push(condition(col.name, 'eq', String(number)));
                }
                break;
            case 'guid': if (guid) conditions.push(condition(col.name, 'eq', guid)); break;
            default: break;
        }
    }
    return conditions.length ? `<filter type="or">${conditions.join('')}</filter>` : null;
}

/** Where the phrase occurs in a shown value, case-insensitive: [start, end][]. */
export function matchRanges(text, phrase) {
    const needle = String(phrase ?? '').trim().toLowerCase();
    if (!needle) return [];
    const haystack = String(text).toLowerCase();
    const ranges = [];
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
        ranges.push([at, at + needle.length]);
    }
    return ranges;
}

export function buildFetchXml({
    entity, columns, byName = new Map(columns.map((c) => [c.name, c])), conditions = [], search = '', sort = [],
    view = null, page = 1, pagingCookie = null, count = PAGE_SIZE, extraFilter = '',
    searchColumns = null, searchOptions = new Map(),
}) {
    const attributes = new Set([entity.primaryId]);
    for (const col of columns) {
        attributes.add(col.name);
        if (col.kind === 'file') attributes.add(`${col.name}_name`);
    }
    const filters = [];
    if (view?.filters) filters.push(view.filters);
    const text = search.trim();
    if (text && searchColumns) {
        // A phrase nothing can hold matches no record, rather than every record.
        filters.push(searchFilterXml(searchColumns, text, searchOptions)
            ?? condition(entity.primaryId, 'null'));
    } else if (text && entity.primaryName) {
        filters.push(condition(entity.primaryName, 'like', `%${likeEscape(text)}%`));
    }
    for (const c of conditions) {
        const col = byName.get(c.column);
        const xml = col && conditionXml(col, c);
        if (xml) filters.push(xml);
    }
    if (extraFilter) filters.push(extraFilter);

    const orders = sort.length
        ? sort.map(({ column, dir }) => `<order attribute="${xmlEscape(column)}" descending="${dir === 'desc'}" />`)
        : (view?.orders ?? []).map(({ column, dir }) => `<order attribute="${xmlEscape(column)}" descending="${dir === 'desc'}" />`);
    // The key last, so rows that tie on every sort column still have one order.
    orders.push(`<order attribute="${xmlEscape(entity.primaryId)}" descending="false" />`);

    const fetchAttrs = [
        'version="1.0"', 'mapping="logical"', `count="${count}"`, `page="${page}"`, 'returntotalrecordcount="true"',
        ...(view?.distinct ? ['distinct="true"'] : []),
        ...(pagingCookie ? [`paging-cookie="${xmlEscape(pagingCookie)}"`] : []),
    ];
    return `<fetch ${fetchAttrs.join(' ')}><entity name="${xmlEscape(entity.name)}">`
        + [...attributes].map((a) => `<attribute name="${xmlEscape(a)}" />`).join('')
        + orders.join('')
        + (filters.length ? `<filter type="and">${filters.join('')}</filter>` : '')
        + (view?.links ?? '')
        + '</entity></fetch>';
}

/** The next page's cookie out of a response's paging-cookie annotation. */
export function parsePagingCookie(annotation) {
    const raw = annotation?.match(/pagingcookie="([^"]*)"/)?.[1];
    if (!raw) return null;
    try { return decodeURIComponent(decodeURIComponent(raw)); } catch { return null; }
}

/** The root-table columns of a view's layout, in its order. */
export function layoutColumns(layoutXml) {
    return [...String(layoutXml ?? '').matchAll(/<cell\b[^>]*\bname="([^"]+)"/g)]
        .map((m) => m[1]).filter((name) => !name.includes('.'));
}

/**
 * What a view adds to the query: its root filters, the link-entities that
 * filter (their columns dropped — only the root table is shown), its sort.
 */
function viewParts(fetchXml) {
    const doc = new DOMParser().parseFromString(fetchXml, 'text/xml');
    const entity = doc.querySelector('fetch > entity');
    if (!entity || doc.querySelector('parsererror')) return null;
    const children = [...entity.children];
    const serializer = new XMLSerializer();
    const links = children.filter((n) => n.tagName === 'link-entity' && n.querySelector('filter, condition'));
    for (const link of links) link.querySelectorAll('attribute, all-attributes, order').forEach((n) => n.remove());
    const isAggregate = doc.documentElement.getAttribute('aggregate') === 'true';
    if (isAggregate) return null;
    return {
        filters: children.filter((n) => n.tagName === 'filter').map((n) => serializer.serializeToString(n)).join(''),
        links: links.map((n) => serializer.serializeToString(n)).join(''),
        orders: children.filter((n) => n.tagName === 'order' && n.getAttribute('attribute') && !n.getAttribute('alias'))
            .map((n) => ({ column: n.getAttribute('attribute'), dir: n.getAttribute('descending') === 'true' ? 'desc' : 'asc' })),
        distinct: doc.documentElement.getAttribute('distinct') === 'true',
    };
}

// ── Data access ───────────────────────────────────────────────────────────

let dv;
const metadataCache = {};

async function loadColumns(entityName) {
    if (!metadataCache[entityName]) {
        const base = `/EntityDefinitions(LogicalName='${entityName}')/Attributes`;
        // MaxLength is only on the typed text metadata, one request per type.
        const lengths = Promise.all(['StringAttributeMetadata', 'MemoAttributeMetadata'].map((cast) =>
            dv.get(`${base}/Microsoft.Dynamics.CRM.${cast}?$select=LogicalName,MaxLength`)
                .then((data) => data.value ?? []).catch(() => [])))
            .then((sets) => new Map(sets.flat().map((a) => [a.LogicalName, a.MaxLength])));
        metadataCache[entityName] = Promise.all([
            dv.get(`${base}?$select=LogicalName,DisplayName,AttributeType,AttributeTypeName,AttributeOf,IsValidForRead`),
            lengths,
        ])
            .then(([data, maxLengths]) => columnsFromMetadata(data.value ?? [], maxLengths))
            .catch((e) => { delete metadataCache[entityName]; throw e; });
    }
    return metadataCache[entityName];
}

const optionsCache = {};
const CHOICE_CAST = {
    Picklist: 'PicklistAttributeMetadata', State: 'StateAttributeMetadata', Status: 'StatusAttributeMetadata',
    Virtual: 'MultiSelectPicklistAttributeMetadata',
};

async function loadOptions(entityName, col) {
    const key = `${entityName}.${col.name}`;
    optionsCache[key] ??= dv.get(`/EntityDefinitions(LogicalName='${entityName}')/Attributes(LogicalName='${col.name}')`
        + `/Microsoft.Dynamics.CRM.${CHOICE_CAST[col.type]}?$select=LogicalName&$expand=OptionSet($select=Options)`)
        .then((data) => (data.OptionSet?.Options ?? []).map((o) => ({
            value: o.Value, label: o.Label?.UserLocalizedLabel?.Label || `Value ${o.Value}`,
        })))
        .catch(() => []);
    return optionsCache[key];
}

const allOptionsCache = {};

/** Every choice column's options on a table, for search: column → [{ value, label }]. */
function loadAllOptions(entityName) {
    allOptionsCache[entityName] ??= Promise.all(Object.values(CHOICE_CAST).map((cast) =>
        dv.get(`/EntityDefinitions(LogicalName='${entityName}')/Attributes/Microsoft.Dynamics.CRM.${cast}`
            + '?$select=LogicalName&$expand=OptionSet($select=Options)')
            .then((data) => data.value ?? [])
            .catch(() => [])))
        .then((sets) => new Map(sets.flat().map((attr) => [attr.LogicalName, (attr.OptionSet?.Options ?? []).map((o) => ({
            value: o.Value, label: o.Label?.UserLocalizedLabel?.Label || `Value ${o.Value}`,
        }))])));
    return allOptionsCache[entityName];
}

let tablesPromise = null;
function loadTables() {
    tablesPromise ??= dv.get('/EntityDefinitions?$select=LogicalName,DisplayName&$filter=IsValidForAdvancedFind eq true')
        .then((data) => (data.value ?? []).map((t) => ({
            name: t.LogicalName, label: t.DisplayName?.UserLocalizedLabel?.Label || t.LogicalName,
        })).sort((a, b) => a.label.localeCompare(b.label)))
        .catch(() => { tablesPromise = null; return []; });
    return tablesPromise;
}

/**
 * A GET whose URL is too long for the address line, sent inside $batch.
 * Exported so it can be checked against a live org without a wide table.
 */
export async function batchGet(path, headers) {
    const boundary = `batch_${Math.random().toString(36).slice(2, 10)}`;
    const body = [
        `--${boundary}`, 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', '',
        `GET ${dv.base}${path} HTTP/1.1`, 'Accept: application/json',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', '',
        `--${boundary}--`, '',
    ].join('\r\n');
    const response = await request({
        url: `${dv.base}/$batch`, method: 'POST', credentials: true, body,
        headers: { 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', Accept: 'application/json', 'Content-Type': `multipart/mixed; boundary=${boundary}` },
    });
    const status = Number(response.text.match(/HTTP\/1\.1 (\d{3})/)?.[1] ?? 0);
    const json = response.text.slice(response.text.indexOf('{'), response.text.lastIndexOf('}') + 1);
    if (status < 200 || status >= 300) throw new HttpError(status, '', json);
    return JSON.parse(json);
}

async function runFetch(entitySetName, fetchXml) {
    const path = `/${entitySetName}?fetchXml=${encodeURIComponent(fetchXml)}`;
    const headers = { Prefer: 'odata.include-annotations="*"' };
    return dv.base.length + path.length > MAX_URL ? batchGet(path, headers) : dv.get(path, headers);
}

async function loadView(viewId, userView) {
    const set = userView ? 'userqueries' : 'savedqueries';
    try {
        return await dv.get(`/${set}(${viewId})?$select=name,fetchxml,layoutxml`);
    } catch (e) {
        console.warn('[Record Browser] could not read the view:', e);
        return null;
    }
}

async function loadDefaultView(entityName) {
    try {
        const data = await dv.get(`/savedqueries?$select=savedqueryid,name,fetchxml,layoutxml&$filter=returnedtypecode eq '${entityName}'`
            + ' and querytype eq 0 and isdefault eq true&$top=1');
        return data.value?.[0] ?? null;
    } catch {
        return null;
    }
}

// ── Page context ──────────────────────────────────────────────────────────

/** The table (and view) the page is on: { entityName, viewId?, userView? } or null. */
function getPageContext() {
    const params = new URLSearchParams(location.search);
    const get = (name) => [...params].find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
    const entityName = get('etn');
    if (!entityName) return null;
    const viewId = get('pagetype') === 'entitylist' ? get('viewid') : null;
    return {
        entityName,
        viewId: viewId ? cleanGuid(viewId) : null,
        userView: get('viewtype') === '4230',
        fromList: get('pagetype') === 'entitylist',
    };
}

// ── Styles ────────────────────────────────────────────────────────────────

const STYLE = `
    .rb-panel { width: 94vw; max-width: none; }
    .rb-table td { white-space: nowrap; }
    .rb-table td .rb-text { display: inline-block; max-width: 360px; overflow: hidden; text-overflow: ellipsis; vertical-align: top; }
    /* The open button and the first column stay put while the grid scrolls sideways. */
    .rb-table td.rb-act, .rb-table th.rb-act { width: 36px; min-width: 36px; max-width: 36px; padding: 4px 0 4px 6px; position: sticky; left: 0; background: var(--bg); z-index: 1; }
    .rb-table td.rb-act + td, .rb-table th.rb-act + th { position: sticky; left: 36px; background: var(--bg); z-index: 1; box-shadow: inset -1px 0 0 var(--border); }
    .rb-table th.rb-act, .rb-table th.rb-act + th { background: var(--bg2); z-index: 2; }
    .rb-table tbody tr:hover td.rb-act, .rb-table tbody tr:hover td.rb-act + td { background: var(--bg2); }
    .rb-open { border: none; background: none; color: var(--muted); cursor: pointer; padding: 2px 4px; border-radius: 4px; font-size: 13px; }
    .rb-open:hover { color: var(--accent); background: var(--border); }
    .rb-link { color: var(--accent); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
    .rb-pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; }
    .rb-empty { color: var(--muted); }
    .rb-hit { background: rgba(255, 200, 0, 0.45); color: inherit; border-radius: 2px; padding: 0 1px; }
    .rb-colsearch { margin: 0 4px 6px; width: calc(100% - 8px); }
    /* Matches the Record Editor's "Hide empty", at toolbar-button height. */
    .rb-toggle { display: flex; align-items: center; gap: 6px; height: 34px; font-size: 12px; color: var(--muted); cursor: pointer; white-space: nowrap; }
    .rb-colpick label[hidden] { display: none; }
    .rb-colpick label .rb-logical { margin-left: auto; color: var(--muted); font-family: Consolas, monospace; font-size: 11px; }
    .rb-options { max-height: 220px; overflow-y: auto; margin-bottom: 6px; }
    .rb-options label { display: flex; gap: 8px; align-items: center; padding: 3px 4px; cursor: pointer; }
    .rb-menu-wide { max-width: 420px; min-width: 320px; }
`;

// ── Panel ─────────────────────────────────────────────────────────────────

let panelOpen = false;

async function openBrowser() {
    if (panelOpen) return;
    panelOpen = true;
    const page = getPageContext();
    const views = await store.get('views', {});
    const hideEmptyBox = ui.el('input', { type: 'checkbox', checked: await store.get('hideEmpty', false) });

    const state = {
        entity: null,        // { name, label, primaryId, primaryName, entitySetName }
        all: [],             // every column of the table
        byName: new Map(),
        columns: [],         // logical names shown
        sort: [],
        conditions: [],
        search: '',
        view: null,          // { id, name, parts, columns } when started from a view
        useView: false,
        rows: [],
        page: 1,
        cookie: null,
        more: false,
        total: null,
        loading: false,
        error: null,
        seq: 0,
        colors: {},          // column -> option colours
        searchOptions: new Map(), // column -> options, for searching choices by label
    };
    const viewKey = () => (state.view && state.useView ? `${state.entity.name}|${state.view.id}` : state.entity?.name);
    const shown = () => state.columns.map((c) => state.byName.get(c)).filter(Boolean);
    // What the grid draws: the shown columns, minus — with "Hide empty" on —
    // those no loaded row has a value in. They are still fetched, so a column
    // comes back as soon as a loaded row fills it.
    const hasValue = (col, row) => row[valueKey(col)] != null && row[valueKey(col)] !== '';
    const visible = () => (hideEmptyBox.checked && state.rows.length
        ? shown().filter((col) => state.rows.some((row) => hasValue(col, row)))
        : shown());

    // ── Layout ──
    const backdrop = ui.mount(ui.el('div', { className: 'ppt grid-backdrop' }));
    const menus = createMenus(backdrop);
    let releaseEscape = () => {};
    const dispose = () => { panelOpen = false; menus.close(); backdrop.remove(); releaseEscape(); };
    releaseEscape = ui.onEscape(dispose);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) dispose(); });

    const title = ui.el('h2', { textContent: '📋 Record Browser' });
    const tableInput = ui.el('input', { className: 'ppt-input', type: 'text', placeholder: 'Pick a table…', style: 'min-width:240px' });
    const tables = loadTables();
    const tablePicker = ui.suggest({
        input: tableInput,
        empty: 'No table matches',
        items: async (text) => {
            // Focusing the box shows every table, not just the one it names.
            const query = text === state.entity?.display ? '' : text.toLowerCase();
            return (await tables)
                .filter((t) => !query || t.label.toLowerCase().includes(query) || t.name.includes(query))
                .slice(0, 60).map((t) => ({ label: t.label, sub: t.name, name: t.name }));
        },
        onPick: (item) => {
            tableInput.value = `${item.label} (${item.name})`;
            if (item.name !== state.entity?.name) openTable(item.name);
        },
    });
    const searchInput = ui.el('input', {
        className: 'ppt-input', type: 'text', placeholder: '🔍 Search all columns…', style: 'min-width:240px', spellcheck: false,
        title: 'Text, lookup names and choice labels contain it; numbers and GUIDs equal it',
    });
    const columnsButton = ui.el('button', { className: 'ppt-btn', textContent: '▦ Columns', title: 'Choose the columns shown' });
    const exportButton = ui.el('button', { className: 'ppt-btn', textContent: '⬇ Export CSV', title: 'The loaded rows and shown columns, as CSV' });
    const chips = ui.el('div', { className: 'grid-chips' });
    const content = ui.el('div', { className: 'grid-content' });
    const status = ui.el('div', { className: 'grid-status' });

    const panel = ui.el('div', { className: 'grid-panel rb-panel' }, [
        ui.el('div', { className: 'grid-header' }, [
            title,
            ui.el('button', { className: 'ppt-icon-btn', textContent: '✕', title: 'Close', onclick: dispose }),
        ]),
        ui.el('div', { className: 'grid-toolbar' }, [
            ui.el('label', { className: 'grid-field' }, [ui.el('span', { textContent: 'Table' }), tablePicker.node]),
            ui.el('label', { className: 'grid-field', style: 'flex:1' }, [ui.el('span', { textContent: 'Search' }), searchInput]),
            ui.el('div', { className: 'grid-field' }, [ui.el('span', { innerHTML: '&nbsp;' }), columnsButton]),
            ui.el('div', { className: 'grid-field' }, [ui.el('span', { innerHTML: '&nbsp;' }), exportButton]),
            ui.el('div', { className: 'grid-field' }, [ui.el('span', { innerHTML: '&nbsp;' }),
                ui.el('label', { className: 'rb-toggle', title: 'Hide the columns that are empty in every loaded row' }, [hideEmptyBox, 'Hide empty'])]),
        ]),
        chips,
        content,
        status,
    ]);
    backdrop.appendChild(panel);

    // ── Views and columns ──
    function saveView() {
        views[viewKey()] = { columns: state.columns, sort: state.sort };
        store.set('views', views);
    }

    // Images are left out of "all": every thumbnail rides along in each page.
    const allColumns = () => state.all.filter((c) => c.kind !== 'image').map((c) => c.name);

    function showAllColumns() {
        state.columns = [...new Set([...state.columns, ...allColumns()])];
        saveView();
        reload();
    }

    function resetColumns() {
        delete views[viewKey()];
        store.set('views', views);
        state.columns = defaultColumns();
        state.sort = [];
        reload();
    }

    /**
     * Every column, the familiar ones first: the view's in its order, or
     * without a view the name and the usual audit columns; then the rest by
     * label. The first one stays pinned while the grid scrolls sideways.
     */
    function defaultColumns() {
        const fromView = (state.useView ? state.view?.columns : null)?.filter((c) => state.byName.has(c)) ?? [];
        const leading = fromView.length ? fromView
            : [state.entity.primaryName, 'createdon', 'modifiedon', 'ownerid', 'statecode'].filter((c) => c && state.byName.has(c));
        return [...new Set([...leading, ...allColumns()])];
    }

    function applySavedView() {
        const saved = views[viewKey()];
        state.columns = (saved?.columns ?? defaultColumns()).filter((c) => state.byName.has(c));
        if (!state.columns.length) state.columns = defaultColumns();
        state.sort = (saved?.sort ?? []).filter((s) => state.byName.get(s.column)?.sortable);
    }

    async function openTable(entityName, { viewId = null, userView = false, fromList = false } = {}) {
        state.error = null;
        state.rows = [];
        state.conditions = [];
        state.search = searchInput.value = '';
        content.replaceChildren(loadingBlock('Loading table…'));
        try {
            const info = await fetchEntityInfo(entityName);
            if (!info) throw new Error(`No table named ${entityName}`);
            const [all, view] = await Promise.all([
                loadColumns(entityName),
                viewId ? loadView(viewId, userView) : fromList ? loadDefaultView(entityName) : null,
            ]);
            if (!panelOpen) return;
            state.entity = { name: entityName, label: info.displayName, primaryId: info.primaryIdAttr, primaryName: info.primaryNameAttr, entitySetName: info.entitySetName };
            state.all = all;
            state.byName = new Map(all.map((c) => [c.name, c]));
            const parts = view?.fetchxml ? viewParts(view.fetchxml) : null;
            state.view = parts ? { id: viewId ?? view.savedqueryid, name: view.name, parts, columns: layoutColumns(view.layoutxml) } : null;
            state.useView = !!state.view;
            tableInput.value = state.entity.display = `${info.displayName} (${entityName})`;
            title.textContent = `📋 Record Browser — ${info.displayName}`;
            applySavedView();
            reload();
        } catch (e) {
            state.error = `Could not open ${entityName}: ${errorMessage(e)}`;
            render();
        }
    }

    // ── Menus ──
    function openColumnMenu(anchor, col) {
        menus.open(anchor, (menu, close) => {
            if (col.sortable) {
                const sortBy = (dir) => (e) => {
                    state.sort = applySort(state.sort, col.name, dir, e.shiftKey);
                    saveView(); close(); reload();
                };
                const az = col.kind === 'text' || col.kind === 'lookup';
                menu.append(
                    menuItem(az ? '↑ Sort A to Z' : '↑ Sort ascending', sortBy('asc')),
                    menuItem(az ? '↓ Sort Z to A' : '↓ Sort descending', sortBy('desc')),
                    ui.el('div', { className: 'grid-dim', style: 'padding:0 10px 4px', textContent: 'Shift-click to add as a secondary sort' }),
                    ui.el('hr'),
                );
            }
            if (col.filterable) {
                menu.append(filterForm(col, close), ui.el('hr'));
                if (state.conditions.some((c) => c.column === col.name)) {
                    menu.append(menuItem('✕ Clear filters on this column', () => {
                        state.conditions = state.conditions.filter((c) => c.column !== col.name);
                        close(); reload();
                    }));
                }
            }
            menu.append(ui.el('div', { className: 'grid-dim', style: 'padding:2px 10px 4px', textContent: `${col.name} · ${col.type}` }));
            if (state.columns.length > 1) {
                menu.append(menuItem('Remove column', () => {
                    state.columns = state.columns.filter((c) => c !== col.name);
                    state.sort = state.sort.filter((s) => s.column !== col.name);
                    saveView(); close(); reload();
                }));
            }
        });
    }

    function filterForm(col, close) {
        const ops = operatorsFor(col);
        const form = ui.el('div', { style: 'padding:4px 6px' });
        form.appendChild(ui.el('div', { className: 'grid-menu-title', style: 'padding:0 0 6px', textContent: `Filter by ${col.label}` }));
        const opSelect = ui.el('select', { className: 'ppt-select' }, ops.map(([value, label]) => ui.el('option', { value, textContent: label })));
        const valueInput = ui.el('input', { className: 'ppt-input', type: 'text', placeholder: 'Value' });
        // Choices are picked from the column's own options.
        const optionBox = ui.el('div', { className: 'rb-options' });
        const picked = new Map(); // value -> label
        if (col.kind === 'choice' || col.kind === 'choices') {
            optionBox.append(ui.el('span', { className: 'grid-dim', textContent: 'Loading options…' }));
            loadOptions(state.entity.name, col).then((options) => {
                optionBox.replaceChildren(...(options.length ? options.map((o) => {
                    const box = ui.el('input', { type: 'checkbox' });
                    box.addEventListener('change', () => (box.checked ? picked.set(o.value, o.label) : picked.delete(o.value)));
                    return ui.el('label', {}, [box, o.label]);
                }) : [ui.el('span', { className: 'grid-dim', textContent: 'No options' })]));
            });
        }
        const syncValue = () => {
            const op = opSelect.value;
            const list = LIST_OPS.has(op);
            valueInput.style.display = needsValue(op) && !list ? '' : 'none';
            optionBox.style.display = list ? '' : 'none';
            valueInput.type = col.kind === 'date' && op !== 'lastdays' ? 'date' : col.kind === 'number' || op === 'lastdays' ? 'number' : 'text';
            valueInput.placeholder = op === 'id' ? 'Record GUID' : 'Value';
        };
        opSelect.addEventListener('change', syncValue);
        syncValue();
        const apply = () => {
            const op = opSelect.value;
            const list = LIST_OPS.has(op);
            const c = list
                ? { column: col.name, op, value: [...picked.keys()].map(String), labels: [...picked.values()] }
                : { column: col.name, op, value: valueInput.value };
            if (!conditionXml(col, c)) { (list ? opSelect : valueInput).focus(); return; }
            // A yes/no column only ever needs one condition — Yes replaces No.
            if (col.kind === 'bool') state.conditions = state.conditions.filter((x) => x.column !== col.name);
            state.conditions.push(c);
            close(); reload();
        };
        valueInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
        form.append(opSelect, valueInput, optionBox,
            ui.el('button', { className: 'ppt-btn primary', style: 'width:100%', textContent: 'Apply filter', onclick: apply }));
        setTimeout(() => (needsValue(opSelect.value) && !LIST_OPS.has(opSelect.value) ? valueInput : opSelect).focus(), 0);
        return form;
    }

    columnsButton.addEventListener('click', () => {
        if (!state.entity) return;
        menus.open(columnsButton, (menu, close) => {
            menu.classList.add('rb-menu-wide');
            menu.appendChild(ui.el('div', { className: 'grid-menu-title', textContent: `Columns · ${state.columns.length} of ${state.all.length} shown` }));
            const filter = ui.el('input', { className: 'ppt-input rb-colsearch', placeholder: 'Find a column…', spellcheck: false });
            const list = ui.el('div', { className: 'grid-colpick rb-colpick' });
            const changed = () => {
                state.sort = state.sort.filter((s) => state.columns.includes(s.column));
                saveView(); reload();
            };
            // Shown columns first, in their order; the rest alphabetically.
            const ordered = [...shown(), ...state.all.filter((c) => !state.columns.includes(c.name))];
            const labels = ordered.map((col) => {
                const box = ui.el('input', { type: 'checkbox', checked: state.columns.includes(col.name) });
                box.addEventListener('change', () => {
                    if (box.checked) state.columns.push(col.name);
                    else if (state.columns.length > 1) state.columns = state.columns.filter((c) => c !== col.name);
                    else { box.checked = true; return; }
                    changed();
                });
                const node = ui.el('label', { title: col.name }, [box, col.label, ui.el('span', { className: 'rb-logical', textContent: col.name })]);
                node.dataset.haystack = `${col.label}\n${col.name}`.toLowerCase();
                return node;
            });
            list.append(...labels);
            filter.addEventListener('input', () => {
                const q = filter.value.trim().toLowerCase();
                for (const node of labels) node.hidden = !!q && !node.dataset.haystack.includes(q);
            });
            menu.append(filter, list, ui.el('hr'),
                menuItem('☑ Show all columns (except images)', () => { close(); showAllColumns(); }),
                menuItem(state.useView && state.view ? `↺ Reset: all columns, the view's first` : '↺ Reset to all columns', () => {
                    close(); resetColumns();
                }));
            setTimeout(() => filter.focus(), 0);
        });
    });

    // ── Rendering ──
    function renderChips() {
        chips.replaceChildren();
        if (state.view && state.useView) {
            chips.appendChild(chip(`View: ${state.view.name}`, () => {
                state.useView = false;
                applySavedView();
                reload();
            }, { removeTitle: 'Drop the view\'s filter — show every record of the table' }));
        } else if (state.view) {
            chips.appendChild(ui.el('button', {
                className: 'grid-link', textContent: `↺ Back to view "${state.view.name}"`,
                onclick: () => { state.useView = true; applySavedView(); reload(); },
            }));
        }
        state.conditions.forEach((c, i) => {
            const col = state.byName.get(c.column);
            chips.appendChild(chip(col ? describeCondition(col, c) : c.column,
                () => { state.conditions.splice(i, 1); reload(); }, { removeTitle: 'Remove filter' }));
        });
        state.sort.forEach((s, i) => {
            chips.appendChild(chip(sortChipText(state.sort, i, state.byName.get(s.column)?.label ?? s.column),
                () => { state.sort.splice(i, 1); saveView(); reload(); }, { sort: true, removeTitle: 'Remove sort' }));
        });
        if (state.conditions.length || state.sort.length || state.search) {
            chips.appendChild(ui.el('button', {
                className: 'grid-link', textContent: 'Clear filters & sort',
                onclick: () => {
                    state.conditions = [];
                    state.sort = [];
                    state.search = searchInput.value = '';
                    saveView(); reload();
                },
            }));
        }
    }

    /** A shown value as text nodes, with the search phrase marked wherever it occurs. */
    function highlight(text) {
        const ranges = matchRanges(text, state.search);
        if (!ranges.length) return [text];
        const parts = [];
        let last = 0;
        for (const [start, end] of ranges) {
            if (start > last) parts.push(text.slice(last, start));
            parts.push(ui.el('mark', { className: 'rb-hit', textContent: text.slice(start, end) }));
            last = end;
        }
        if (last < text.length) parts.push(text.slice(last));
        return parts;
    }

    function cell(col, row) {
        const raw = row[valueKey(col)];
        const recordId = row[state.entity.primaryId];
        const media = { entitySetName: state.entity.entitySetName, recordId, column: col.name };
        if (col.kind === 'file') return fileLink({ ...media, fileName: row[`${col.name}_name`], hasFile: raw != null && raw !== '' });
        if (col.kind === 'image') return imageThumb({ ...media, thumbnail: raw, title: col.label });
        if (raw == null || raw === '') return null;
        const text = row[`${valueKey(col)}${FORMATTED}`] ?? String(raw);
        if (col.kind === 'lookup') {
            const target = row[`${valueKey(col)}@Microsoft.Dynamics.CRM.lookuplogicalname`];
            return ui.el('span', {
                className: 'rb-link rb-text', title: `Open ${text}`,
                onclick: (e) => { e.stopPropagation(); openForm(target, raw); },
            }, highlight(text));
        }
        const pill = col.kind === 'choice' ? choiceColor(state.colors[col.name], raw) : null;
        const span = ui.el('span', { className: `rb-text${pill ? ' rb-pill' : ''}`, title: text.length > 40 ? text.slice(0, 2000) : '' }, highlight(text));
        if (pill) Object.assign(span.style, pill);
        if (col.kind === 'guid' || col.type === 'EntityName') span.classList.add('grid-mono');
        return span;
    }

    function renderTable() {
        const scroll = { top: content.scrollTop, left: content.scrollLeft };
        content.replaceChildren();
        if (state.error) {
            content.appendChild(ui.el('div', { className: 'ppt-note', style: 'color:var(--danger);margin:12px', textContent: state.error }));
            return;
        }
        if (!state.entity) {
            content.appendChild(ui.el('div', { className: 'ppt-note', style: 'text-align:center;padding:24px;margin:12px', textContent: 'Pick a table to browse its records.' }));
            return;
        }
        if (state.loading && !state.rows.length) { content.appendChild(loadingBlock('Loading records…')); return; }
        if (!state.rows.length) {
            content.appendChild(ui.el('div', { className: 'ppt-note', style: 'text-align:center;padding:24px;margin:12px', textContent: '📭 No records match.' }));
            return;
        }
        const cols = visible();
        const headRow = ui.el('tr', {}, [ui.el('th', { className: 'rb-act' })]);
        for (const col of cols) {
            headRow.appendChild(ui.el('th', { title: col.name }, [headerButton({
                label: col.label, sort: state.sort, column: col.name,
                filtered: state.conditions.some((c) => c.column === col.name),
                title: col.sortable || col.filterable ? 'Sort and filter' : col.name,
                onClick: (button) => openColumnMenu(button, col),
            })]));
        }
        const tbody = ui.el('tbody');
        for (const row of state.rows) {
            const id = row[state.entity.primaryId];
            const tr = ui.el('tr', { title: 'Open in the Record Editor' }, [ui.el('td', { className: 'rb-act' }, [ui.el('button', {
                className: 'rb-open', textContent: '↗', title: 'Open the form in a new tab',
                onclick: (e) => { e.stopPropagation(); openForm(state.entity.name, id); },
            })])]);
            for (const col of cols) {
                const value = cell(col, row);
                tr.appendChild(ui.el('td', {}, [value ?? ui.el('span', { className: 'rb-empty', textContent: '' })]));
            }
            tr.addEventListener('click', (e) => {
                if (window.getSelection()?.toString()) return; // selecting text to copy
                if (e.target.closest('a, img, .rb-link, .ppt-file-link')) return;
                openRecordEditor({ entityName: state.entity.name, recordId: cleanGuid(id) }, { onSaved: () => refreshRow(id) });
            });
            tbody.appendChild(tr);
        }
        content.appendChild(ui.el('table', { className: 'grid-table rb-table' }, [ui.el('thead', {}, [headRow]), tbody]));
        content.scrollTop = scroll.top;
        content.scrollLeft = scroll.left;
    }

    function renderStatus() {
        status.replaceChildren();
        if (!state.entity || state.error) return;
        const total = state.total == null ? '' : state.total.limited ? ` of 5000+` : ` of ${state.total.count.toLocaleString()}`;
        status.appendChild(ui.el('span', {
            className: 'grid-dim',
            textContent: `${state.rows.length.toLocaleString()}${total} records · ${visible().length} of ${state.all.length} columns`
                + (visible().length < state.columns.length ? ` (${state.columns.length - visible().length} empty hidden)` : ''),
        }));
        if (state.more) {
            status.appendChild(ui.el('button', {
                className: 'ppt-btn', disabled: state.loading,
                textContent: state.loading ? 'Loading…' : `⬇ Load ${PAGE_SIZE} more`,
                onclick: () => loadPage(),
            }));
        }
        exportButton.disabled = !state.rows.length;
    }

    function render() {
        renderChips();
        renderTable();
        renderStatus();
    }

    // ── Data ──
    const query = (extra = {}) => buildFetchXml({
        entity: state.entity, columns: shown(), byName: state.byName, conditions: state.conditions,
        search: state.search, sort: state.sort, view: state.useView ? state.view?.parts : null,
        // Search goes over every column of the table, shown or not.
        searchColumns: state.all, searchOptions: state.searchOptions, ...extra,
    });

    async function loadPage({ initial = false } = {}) {
        const seq = ++state.seq;
        state.loading = true;
        state.error = null;
        if (initial) render(); else renderStatus();
        try {
            if (state.search.trim()) state.searchOptions = await loadAllOptions(state.entity.name);
            const data = await runFetch(state.entity.entitySetName, query({ page: state.page, pagingCookie: state.cookie }));
            if (seq !== state.seq || !panelOpen) return;
            state.rows.push(...(data.value ?? []));
            state.more = !!data['@Microsoft.Dynamics.CRM.morerecords'];
            state.cookie = parsePagingCookie(data['@Microsoft.Dynamics.CRM.fetchxmlpagingcookie']);
            state.page += 1;
            const count = data['@Microsoft.Dynamics.CRM.totalrecordcount'];
            if (initial) {
                state.total = count >= 0
                    ? { count, limited: !!data['@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded'] } : null;
            }
        } catch (e) {
            if (seq !== state.seq || !panelOpen) return;
            state.error = `Could not load records: ${errorMessage(e)}`;
        } finally {
            if (seq === state.seq) {
                state.loading = false;
                render();
            }
        }
    }

    function loadColors() {
        for (const col of shown()) {
            if (col.kind !== 'choice' || state.colors[col.name]) continue;
            state.colors[col.name] = {};
            fetchOptionsetColors(state.entity.name, col.name).then((colors) => {
                state.colors[col.name] = colors;
                if (panelOpen && Object.keys(colors).length && !state.loading) renderTable();
            });
        }
    }

    function reload() {
        state.rows = [];
        state.page = 1;
        state.cookie = null;
        state.more = false;
        state.total = null;
        loadColors();
        loadPage({ initial: true });
    }

    /** One row again after the Record Editor saved it, in place. */
    async function refreshRow(id) {
        try {
            const data = await runFetch(state.entity.entitySetName, query({
                page: 1, count: 1, extraFilter: `<condition attribute="${xmlEscape(state.entity.primaryId)}" operator="eq" value="${xmlEscape(cleanGuid(id))}" />`,
            }));
            const index = state.rows.findIndex((r) => r[state.entity.primaryId] === id);
            if (index === -1 || !panelOpen) return;
            // A row the edit took out of the filter goes; otherwise it updates.
            if (data.value?.[0]) state.rows[index] = data.value[0];
            else {
                state.rows.splice(index, 1);
                if (state.total && !state.total.limited) state.total.count -= 1;
            }
            renderTable(); renderStatus();
        } catch (e) {
            console.warn('[Record Browser] could not refresh the row:', e);
        }
    }

    function openForm(entityName, id) {
        if (!entityName || !id) return;
        openRecordForm(entityName, cleanGuid(id)).then((result) => {
            if (!result.ok) {
                window.open(`${location.origin}/main.aspx?pagetype=entityrecord&etn=${encodeURIComponent(entityName)}&id=${encodeURIComponent(cleanGuid(id))}`, '_blank', 'noopener');
            }
        });
    }

    function exportCsv() {
        const cols = visible(); // what the grid shows is what gets exported
        const quoteCsv = (v) => (/[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
        const valueOf = (col, row) => {
            const raw = row[valueKey(col)];
            if (col.kind === 'file') return row[`${col.name}_name`] ?? (raw ? '(file)' : '');
            if (col.kind === 'image') return raw ? '(image)' : '';
            if (raw == null) return '';
            return String(row[`${valueKey(col)}${FORMATTED}`] ?? raw);
        };
        const lines = [
            cols.map((c) => quoteCsv(c.label)).join(','),
            ...state.rows.map((row) => cols.map((c) => quoteCsv(valueOf(c, row))).join(',')),
        ];
        // The BOM makes Excel read the file as UTF-8.
        saveBlob(new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' }), `${state.entity.name}.csv`);
    }

    // ── Wiring ──
    let searchDebounce = null;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => { state.search = searchInput.value; if (state.entity) reload(); }, 350);
    });
    exportButton.addEventListener('click', exportCsv);
    hideEmptyBox.addEventListener('change', () => {
        store.set('hideEmpty', hideEmptyBox.checked);
        renderTable();
        renderStatus();
    });

    // A name typed out in full and confirmed with Enter or Tab works too.
    tableInput.addEventListener('change', async () => {
        const text = tableInput.value.trim();
        const logical = text.match(/\(([a-z0-9_]+)\)$/i)?.[1]
            ?? (await tables).find((t) => t.label.toLowerCase() === text.toLowerCase())?.name
            ?? (/^[a-z0-9_]+$/i.test(text) ? text.toLowerCase() : null);
        if (logical && logical !== state.entity?.name) openTable(logical);
    });
    tableInput.addEventListener('focus', () => tableInput.select());

    if (page) openTable(page.entityName, page);
    else {
        render();
        setTimeout(() => tableInput.focus(), 0);
    }
}

export default {
    init({ store: toolStore }) {
        store = toolStore;
        dv = new Dataverse();
        installGridStyle();
        ui.addStyle('rb', STYLE);
        commands.register({
            toolId: 'record-browser',
            title: 'Browse Records',
            subtitle: `Every column of a table, the view's first — sort and filter without editing a view`,
            icon: '📋', svg: 'documentBulletList',
            run: openBrowser,
        });
    },
};
