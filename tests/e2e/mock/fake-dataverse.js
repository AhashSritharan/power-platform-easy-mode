// A fake Dynamics 365 org for the mock browser tests: serves a stub main.aspx
// for the extension to start on, and answers the Dataverse Web API from
// in-memory tables plus per-test handlers.
//
//   const org = new FakeOrg('contoso.crm4.dynamics.com');
//   org.table('solutions', [{ solutionid: '…', uniquename: 'Core', ismanaged: false }]);
//   org.on('POST', '/ExportSolutionAsync', (req) => ({ AsyncOperationId: '…', ExportJobId: '…' }));
//   …
//   org.calls('POST', '/ImportSolutionAsync')[0].body
//
// A request nothing answers gets a 501 and is listed in `org.unhandled`; the
// mock fixture fails the test on any. The point is that a tool cannot quietly
// start calling something no test has thought about.
//
// Entity-set reads understand what the tools send: $filter (eq, ne, gt, ge,
// lt, le, and, or, not, parentheses, contains/startswith/endswith), $select,
// $orderby, $top, and a key in parentheses. Anything else is a handler's job.

import { runFetchXml } from './fake-fetchxml.js';

const API = '/api/data/v9.2';

export const guid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// The parts of a real main.aspx the tools anchor to, copied from a live org's
// DOM: the top bar with the Dynamics 365 button (where the Environment
// Indicator docks its badge), then the page.
const STUB_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Fake Dynamics 365</title>
<style>body{margin:0;font-family:sans-serif} #topBar{height:48px;background:#1f1f1f;color:#fff;display:flex;align-items:center;padding:0 12px}</style></head>
<body><div id="topBar" data-id="topBar" role="presentation"><div role="presentation"><button data-id="dynamics-button">Dynamics 365</button></div></div>
<div id="mainContent" style="padding:24px">Fake Dynamics 365</div></body></html>`;

export class FakeOrg {
    constructor(host, { environmentId = guid(host.length), name = host.split('.')[0] } = {}) {
        this.host = host;
        this.origin = `https://${host}`;
        this.environmentId = environmentId;
        this.name = name;
        this.userId = guid(1);
        this.tables = {};
        this.handlers = [];
        this.requests = [];
        this.unhandled = [];
    }

    /** Sets (replacing) an entity set's rows. Returns the rows array, live. */
    table(entitySet, rows = []) {
        this.tables[entitySet] = rows;
        return rows;
    }

    /**
     * A table with metadata, answered under EntityDefinitions the way a live
     * org shapes it, plus its rows:
     *
     *   org.entity({ logicalName: 'contact', primaryName: 'fullname', attributes: [
     *       { name: 'firstname', type: 'String', label: 'First Name' },
     *       { name: 'preferredcontactmethodcode', type: 'Picklist', options: [[1, 'Any'], [2, 'Email']] },
     *       { name: 'parentcustomerid', type: 'Customer', targets: { account: 'parentcustomerid_account' } },
     *   ], rows: [...] })
     *
     * Attributes take `updatable` (default true), `creatable` (default:
     * updatable), `attributeOf`, `typeName`, `options` ([value, label, color?])
     * and, for lookups, `targets` ({ entity: navigationProperty }).
     * `oneToMany` lists the 1:N relationships to other fake entities:
     * [{ schemaName, navigation, entity, attribute }] — their rows are the
     * child entity's rows whose `_<attribute>_value` is the parent's id, for
     * /set(id)/navigation and $expand alike. Rows are stored as given: put the
     * annotations a test needs (FormattedValue, lookuplogicalname) on them.
     */
    entity({ logicalName, entitySetName = `${logicalName}s`, primaryId = `${logicalName}id`, primaryName = 'name', displayName, attributes = [], oneToMany = [], rows = [] }) {
        this.entities ??= {};
        this.entities[logicalName] = { logicalName, entitySetName, primaryId, primaryName, displayName: displayName ?? logicalName, attributes, oneToMany };
        return this.table(entitySet(this.entities[logicalName]), rows);
    }

    /**
     * Answers requests: `pattern` is a path after /api/data/v9.2 (exact, or a
     * prefix when it ends in "*") or a RegExp tested against path + query.
     * `handler(req)` returns the JSON body, or { status, json | body, headers }
     * for anything else; undefined passes the request on. Later handlers win.
     */
    on(method, pattern, handler) {
        this.handlers.unshift({ method: method.toUpperCase(), pattern, handler });
        return this;
    }

    /** The requests that matched, oldest first. */
    calls(method, pattern) {
        return this.requests.filter((r) => r.method === method.toUpperCase() && matches(pattern, r));
    }

    async handle(route) {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === '/main.aspx' || url.pathname === '/') {
            return route.fulfill({ contentType: 'text/html', body: STUB_PAGE });
        }
        // Tools call v9.0 as well as v9.2; the fake answers every version alike.
        const version = url.pathname.match(/^\/api\/data\/v9\.\d+/)?.[0];
        const api = !!version;
        const raw = request.postData();
        let body = raw;
        try { body = raw ? JSON.parse(raw) : null; } catch { /* not JSON — SOAP and the like */ }
        const req = {
            method: request.method(),
            api,
            path: decodeURIComponent(api ? url.pathname.slice(version.length) : url.pathname),
            query: url.searchParams,
            search: decodeURIComponent(url.search),
            headers: request.headers(),
            body,
        };
        if (api && req.method === 'POST' && req.path === '/$batch') return route.fulfill(this.batch(raw));
        this.requests.push(req);

        let result;
        try {
            result = this.respond(req);
        } catch (e) {
            result = { status: 500, json: { error: { code: '0x80040216', message: `Fake org: ${e.message}` } } };
        }
        if (result === undefined) {
            this.unhandled.push(`${req.method} ${req.path}${req.search}`);
            result = { status: 501, json: { error: { code: '0x80040216', message: `Fake org has no answer for ${req.method} ${req.path}` } } };
        }
        return route.fulfill(toResponse(result));
    }

    /**
     * A $batch of change sets, answered the way a live org does (format
     * copied from a real response): each operation goes through the same
     * handlers as a single request and is recorded in `requests`; `$N`
     * references resolve to what operation N created. Any failure rolls the
     * tables back and the whole batch answers 400 with just the failing part.
     */
    batch(raw) {
        const CRLF = '\r\n';
        const snapshot = structuredClone(this.tables);
        const created = {};
        const results = [];
        const boundaries = [...raw.matchAll(/boundary=(changeset_[\w-]+)/g)].map((m) => m[1]);
        const parts = boundaries.flatMap((b) => raw.split(`--${b}`).slice(1).filter((p) => !p.startsWith('--')));
        for (const part of parts) {
            const contentId = part.match(/^Content-ID:\s*(\S+)/mi)?.[1];
            const line = part.match(/^(GET|POST|PATCH|PUT|DELETE) (\S+) HTTP\/1\.1$/m);
            const [head, ...rest] = part.slice(line.index).split(/\r?\n\r?\n/);
            const bodyText = rest.join('\n\n').trim();
            let target = line[2];
            if (target.startsWith('$')) target = created[target.slice(1)] ?? target;
            const url = new URL(target, this.origin);
            const version = url.pathname.match(/^\/api\/data\/v9\.\d+/)?.[0] ?? '';
            const headers = Object.fromEntries(head.split(/\r?\n/).slice(1).map((h) => h.split(/:\s*/)).map(([k, ...v]) => [k.toLowerCase(), v.join(':')]));
            let body = bodyText || null;
            try { body = bodyText ? JSON.parse(bodyText) : null; } catch { /* leave as text */ }
            const req = {
                method: line[1], api: true, batch: true,
                path: decodeURIComponent(url.pathname.slice(version.length)), query: url.searchParams,
                search: decodeURIComponent(url.search), headers, body,
            };
            this.requests.push(req);
            let result = this.respond(req);
            if (result === undefined) {
                this.unhandled.push(`${req.method} ${req.path}${req.search} (in $batch)`);
                result = { status: 501, json: { error: { code: '0x80040216', message: `Fake org has no answer for ${req.method} ${req.path}` } } };
            }
            const response = toResponse(result);
            const entityId = response.headers?.['OData-EntityId'];
            if (entityId && contentId) created[contentId] = entityId;
            results.push({ contentId, ...response });
            if (response.status >= 400) break;
        }
        const failed = results.find((r) => r.status >= 400);
        if (failed) this.tables = snapshot;
        const shown = failed ? [failed] : results;
        const statusText = (s) => ({ 200: 'OK', 204: 'No Content', 400: 'Bad Request', 404: 'Not Found', 500: 'Internal Server Error', 501: 'Not Implemented' }[s] ?? '');
        const changeset = `changesetresponse_${guid(results.length)}`;
        const batch = `batchresponse_${guid(results.length + 1)}`;
        const body = [`--${batch}`, `Content-Type: multipart/mixed; boundary=${changeset}`, '',
            ...shown.map((r) => [`--${changeset}`, 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', `Content-ID: ${r.contentId}`, '',
                `HTTP/1.1 ${r.status} ${statusText(r.status)}`, 'OData-Version: 4.0',
                ...(r.headers?.['OData-EntityId'] ? [`Location: ${r.headers['OData-EntityId']}`, `OData-EntityId: ${r.headers['OData-EntityId']}`] : []),
                ...(r.body ? ['Content-Type: application/json; odata.metadata=minimal'] : []),
                '', r.body ?? ''].join(CRLF)),
            `--${changeset}--`, `--${batch}--`, ''].join(CRLF);
        return { status: failed ? 400 : 200, contentType: `multipart/mixed; boundary=${batch}`, body };
    }

    /** A row's 1:N children through `navigation`, or null when no such relationship is declared. */
    children(set, row, navigation) {
        const parent = Object.values(this.entities ?? {}).find((e) => e.entitySetName === set);
        const rel = parent?.oneToMany.find((r) => r.navigation === navigation);
        if (!rel) return null;
        const child = this.entities[rel.entity];
        const id = String(row[parent.primaryId]).toLowerCase();
        return (this.tables[child.entitySetName] ?? []).filter((r) => String(r[`_${rel.attribute}_value`] ?? '').toLowerCase() === id);
    }

    respond(req) {
        for (const h of this.handlers) {
            if (h.method !== req.method || !matches(h.pattern, req)) continue;
            const result = h.handler(req);
            if (result !== undefined) return result;
        }
        return this.builtIn(req);
    }

    builtIn(req) {
        if (!req.api) return undefined;
        if (req.method === 'GET' && req.path.startsWith('/RetrieveCurrentOrganization')) {
            return {
                Detail: {
                    EnvironmentId: this.environmentId, OrganizationId: guid(2), FriendlyName: this.name,
                    UrlName: this.name, Endpoints: { Count: 0, Keys: [], Values: [] },
                },
            };
        }
        if (req.method === 'GET' && /^\/WhoAmI(\(\))?$/.test(req.path)) { // both spellings work live
            return { UserId: this.userId, BusinessUnitId: guid(3), OrganizationId: guid(2) };
        }
        if (req.method === 'GET' && req.path.startsWith('/EntityDefinitions')) return this.metadata(req);
        const m = req.path.match(/^\/([A-Za-z_][\w]*)(?:\(([^)]*)\))?(?:\/([A-Za-z_]\w*))?$/);
        if (!m || !(m[1] in this.tables)) return undefined;
        const [, set, key, navigation] = m;
        const rows = this.tables[set];
        if (req.method === 'GET') {
            if (key) {
                const row = rows.find((r) => rowHasKey(r, key));
                if (!row) return notFound(set, key);
                if (navigation) {
                    const children = this.children(set, row, navigation);
                    if (!children) return undefined;
                    return withCount(children, req.query);
                }
                const out = select(row, req.query.get('$select'));
                for (const nav of (req.query.get('$expand') ?? '').split(',').map((n) => n.replace(/\(.*$/, '').trim()).filter(Boolean)) {
                    const children = this.children(set, row, nav);
                    if (!children) throw new Error(`no navigation property ${nav} on ${set}`);
                    out[nav] = children;
                }
                return out;
            }
            const fetchXml = req.query.get('fetchXml');
            if (fetchXml) {
                const def = Object.values(this.entities ?? {}).find((e) => e.entitySetName === set);
                return runFetchXml(fetchXml, rows, { primaryId: def?.primaryId, userId: this.userId });
            }
            // Prefer: odata.maxpagesize=N pages through @odata.nextLink, as a live org does.
            const pageSize = Number((req.headers.prefer ?? '').match(/odata\.maxpagesize=(\d+)/)?.[1]);
            if (pageSize) {
                const offset = Number(req.query.get('$skiptoken') ?? 0);
                const all = withCount(rows, req.query);
                const page = { ...all, value: all.value.slice(offset, offset + pageSize) };
                if (offset + pageSize < all.value.length) {
                    const next = new URL(`${this.origin}/api/data/v9.2${req.path}`);
                    for (const [k, v] of req.query) if (k !== '$skiptoken') next.searchParams.set(k, v);
                    next.searchParams.set('$skiptoken', String(offset + pageSize));
                    page['@odata.nextLink'] = next.href;
                }
                return page;
            }
            return withCount(rows, req.query);
        }
        if (req.method === 'POST' && !key) {
            // The row keeps the id it was sent with (a preserved GUID), else gets one.
            const idAttr = Object.values(this.entities ?? {}).find((e) => e.entitySetName === set)?.primaryId ?? `${set.replace(/s$/, '')}id`;
            const row = { ...req.body };
            row[idAttr] ??= guid(1000 + rows.length);
            rows.push(row);
            const entityId = `${this.origin}${API}/${set}(${row[idAttr]})`;
            if (/return=representation/.test(req.headers.prefer ?? '')) return { status: 201, headers: { 'OData-EntityId': entityId }, json: row };
            return { status: 204, headers: { 'OData-EntityId': entityId } };
        }
        if ((req.method === 'PATCH' || req.method === 'DELETE') && key) {
            const index = rows.findIndex((r) => rowHasKey(r, key));
            if (index < 0) return notFound(set, key);
            if (req.method === 'PATCH') Object.assign(rows[index], req.body);
            else rows.splice(index, 1);
            return { status: 204 };
        }
        return undefined;
    }
}

/**
 * Answers RetrieveRequiredComponents / RetrieveDependentComponents with
 * dependency rows shaped like a live org's (fields copied from a real
 * response): `dependencies` maps "type:objectid" of the component asked about
 * to [{ type, id }] on the other side. Parameters may be inline or aliases.
 */
export function dependencyRows(kind, dependencies) {
    return (req) => {
        const inline = req.path.match(/ObjectId=([^,)]+),ComponentType=([^,)]+)/);
        const param = (value) => (value?.startsWith('@') ? req.query.get(value) : value);
        const id = param(inline?.[1])?.toLowerCase();
        const type = Number(param(inline?.[2]));
        const other = kind === 'required' ? 'required' : 'dependent';
        const self = kind === 'required' ? 'dependent' : 'required';
        return {
            value: (dependencies[`${type}:${id}`] ?? []).map((d, i) => ({
                '@odata.type': '#Microsoft.Dynamics.CRM.dependency',
                dependencyid: guid(900 + i),
                dependencytype: 2,
                [`${self}componenttype`]: type,
                [`${self}componentobjectid`]: id,
                [`${self}componentparentid`]: '00000000-0000-0000-0000-000000000000',
                [`${other}componenttype`]: d.type,
                [`${other}componentobjectid`]: d.id,
                [`${other}componentparentid`]: '00000000-0000-0000-0000-000000000000',
            })),
        };
    };
}

// ── Metadata ──────────────────────────────────────────────────────────────
const entitySet = (e) => e.entitySetName;
const labelOf = (text) => ({
    LocalizedLabels: text ? [{ Label: text, LanguageCode: 1033 }] : [],
    UserLocalizedLabel: text ? { Label: text, LanguageCode: 1033 } : null,
});
const LOOKUPS = ['Lookup', 'Customer', 'Owner'];
const CAST = {
    String: 'StringAttributeMetadata', Memo: 'MemoAttributeMetadata', Integer: 'IntegerAttributeMetadata',
    BigInt: 'BigIntAttributeMetadata', Double: 'DoubleAttributeMetadata', Decimal: 'DecimalAttributeMetadata',
    Money: 'MoneyAttributeMetadata', Boolean: 'BooleanAttributeMetadata', DateTime: 'DateTimeAttributeMetadata',
    Picklist: 'PicklistAttributeMetadata', State: 'StateAttributeMetadata', Status: 'StatusAttributeMetadata',
    Lookup: 'LookupAttributeMetadata', Customer: 'LookupAttributeMetadata', Owner: 'LookupAttributeMetadata',
    Uniqueidentifier: null, Virtual: null,
};

function attributeMetadata(a, i) {
    const cast = CAST[a.type];
    return {
        ...(cast ? { '@odata.type': `#Microsoft.Dynamics.CRM.${cast}` } : {}),
        MetadataId: guid(5000 + i),
        AttributeOf: a.attributeOf ?? null,
        AttributeType: a.type,
        IsValidForRead: a.readable ?? true,
        IsValidForUpdate: a.updatable ?? true,
        IsValidForCreate: a.creatable ?? a.updatable ?? true,
        LogicalName: a.name,
        AttributeTypeName: { Value: a.typeName ?? `${a.type}Type` },
        DisplayName: labelOf(a.label ?? null),
    };
}

const optionMetadata = ([value, text, color = null]) => ({ Value: value, Color: color, Label: labelOf(text) });

FakeOrg.prototype.metadata = function metadata(req) {
    const entities = this.entities ?? {};
    const m = req.path.match(/^\/EntityDefinitions(?:\(LogicalName='([^']+)'\))?(?:\/(Attributes|ManyToOneRelationships|OneToManyRelationships)(?:\(LogicalName='([^']+)'\))?(?:\/Microsoft\.Dynamics\.CRM\.(\w+))?)?$/);
    if (!m) return undefined;
    const [, name, part, attrName, cast] = m;
    const entityMetadata = (e) => ({
        MetadataId: guid(4000 + Object.keys(entities).indexOf(e.logicalName)), LogicalName: e.logicalName,
        EntitySetName: e.entitySetName, PrimaryIdAttribute: e.primaryId, PrimaryNameAttribute: e.primaryName,
        DisplayName: labelOf(e.displayName), IconSmallName: null, IconVectorName: null, ObjectTypeCode: 10000,
        IsValidForAdvancedFind: true, IsAuditEnabled: { Value: true, CanBeChanged: true },
    });
    if (!name) return { value: query(Object.values(entities).map(entityMetadata), req.query) };
    const e = entities[name];
    if (!e) return { status: 404, json: { error: { code: '0x80040217', message: `Could not find an entity with name ${name}.` } } };
    if (!part) return select(entityMetadata(e), req.query.get('$select'));
    if (part === 'OneToManyRelationships') {
        const relationships = e.oneToMany.map((r) => ({
            SchemaName: r.schemaName, ReferencedEntity: e.logicalName, ReferencingEntity: r.entity,
            ReferencingAttribute: r.attribute, ReferencedEntityNavigationPropertyName: r.navigation,
        }));
        return { value: query(relationships, req.query) };
    }
    if (part === 'ManyToOneRelationships') {
        const relationships = e.attributes.filter((a) => LOOKUPS.includes(a.type)).flatMap((a) => Object.entries(a.targets ?? {}).map(([target, nav]) => ({
            SchemaName: `${e.logicalName}_${a.name}_${target}`, ReferencingEntity: e.logicalName, ReferencingAttribute: a.name,
            ReferencedEntity: target, ReferencingEntityNavigationPropertyName: nav,
        })));
        return { value: query(relationships, req.query) };
    }
    if (!attrName) {
        // /Attributes/Microsoft.Dynamics.CRM.StringAttributeMetadata: the columns of that type.
        const all = e.attributes.map((a, i) => ({ a, meta: attributeMetadata(a, i) }));
        const ofType = cast ? all.filter(({ meta }) => meta['@odata.type'] === `#Microsoft.Dynamics.CRM.${cast}`) : all;
        return { value: query(ofType.map(({ a, meta }) => (cast && a.options ? { ...meta, OptionSet: { Options: a.options.map(optionMetadata) } } : meta)), req.query) };
    }
    const index = e.attributes.findIndex((a) => a.name === attrName);
    if (index < 0) return { status: 404, json: { error: { code: '0x80040217', message: `Could not find attribute ${attrName}.` } } };
    const a = e.attributes[index];
    const typed = { ...attributeMetadata(a, index) };
    if (cast && a.options) {
        if (a.type === 'Boolean') {
            typed.OptionSet = { TrueOption: optionMetadata([1, a.options[1] ?? 'Yes']), FalseOption: optionMetadata([0, a.options[0] ?? 'No']) };
        } else typed.OptionSet = { Options: a.options.map(optionMetadata) };
    }
    if (cast && LOOKUPS.includes(a.type)) typed.Targets = Object.keys(a.targets ?? {});
    return typed;
};

function matches(pattern, req) {
    if (pattern instanceof RegExp) return pattern.test(req.path + req.search);
    if (pattern.endsWith('*')) return req.path.startsWith(pattern.slice(0, -1));
    return req.path === pattern;
}

function toResponse(result) {
    if (result && typeof result === 'object' && ('status' in result || 'json' in result || 'body' in result)) {
        const { status = 200, json, body, headers = {}, contentType } = result;
        if (json !== undefined) return { status, headers, contentType: 'application/json', body: JSON.stringify(json) };
        return { status, headers, contentType: contentType ?? 'text/plain', body: body ?? '' };
    }
    return { status: 200, contentType: 'application/json', body: JSON.stringify(result) };
}

const notFound = (set, key) => ({ status: 404, json: { error: { code: '0x80040217', message: `${set} With Id = ${key} Does Not Exist` } } });

const stripKey = (key) => key.replace(/^'|'$/g, '').replace(/[{}]/g, '').toLowerCase();
const rowHasKey = (row, key) => Object.entries(row).some(([k, v]) => /id$/i.test(k) && String(v).toLowerCase() === stripKey(key));

function select(row, fields) {
    if (!fields) return { ...row };
    const wanted = new Set(fields.split(',').map((s) => s.trim()));
    const out = {};
    // A selected column brings its annotations (FormattedValue, lookuplogicalname…) along.
    for (const [key, value] of Object.entries(row)) if (wanted.has(key.split('@')[0])) out[key] = value;
    // Keys come along, as Dataverse sends the primary key whatever is selected.
    for (const [k, v] of Object.entries(row)) if (/id$/.test(k) && !(k in out) && !k.startsWith('_')) out[k] = v;
    return out;
}

/** { value } for a collection read, with @odata.count when $count=true asks for it. */
function withCount(rows, params) {
    const value = query(rows, params);
    if (params.get('$count') !== 'true') return { value };
    const filter = params.get('$filter');
    return { '@odata.count': (filter ? rows.filter(parseFilter(filter)) : rows).length, value };
}

export function query(rows, params) {
    let out = rows;
    const filter = params.get('$filter');
    if (filter) {
        const predicate = parseFilter(filter);
        out = out.filter(predicate);
    }
    const orderby = params.get('$orderby');
    if (orderby) {
        const [field, dir] = orderby.split(',')[0].trim().split(/\s+/);
        const sign = dir?.toLowerCase() === 'desc' ? -1 : 1;
        out = [...out].sort((a, b) => (a[field] > b[field] ? sign : a[field] < b[field] ? -sign : 0));
    }
    const top = Number(params.get('$top'));
    if (top) out = out.slice(0, top);
    return out.map((row) => select(row, params.get('$select')));
}

// ── $filter ───────────────────────────────────────────────────────────────
// A small recursive-descent parser over the OData expressions the tools use.

function tokenize(text) {
    const tokens = [];
    const re = /\s*(?:('(?:[^']|'')*')|([(),])|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})|(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)|(-?\d+(?:\.\d+)?)|([A-Za-z_][\w./]*))/giy;
    let m;
    while (re.lastIndex < text.length && (m = re.exec(text))) {
        if (m[1] !== undefined) tokens.push({ type: 'value', value: m[1].slice(1, -1).replace(/''/g, "'") });
        else if (m[2] !== undefined) tokens.push({ type: m[2] === '(' ? 'open' : m[2] === ')' ? 'close' : 'comma' });
        else if (m[3] !== undefined) tokens.push({ type: 'value', value: m[3].toLowerCase(), guid: true });
        // A date-time literal compares as its ISO text, as the rows store it.
        else if (m[4] !== undefined) tokens.push({ type: 'value', value: m[4] });
        else if (m[5] !== undefined) tokens.push({ type: 'value', value: Number(m[5]) });
        else tokens.push({ type: 'word', value: m[6] });
        if (!m[0].length) break;
    }
    if (re.lastIndex < text.trimEnd().length) throw new Error(`cannot parse $filter near "${text.slice(re.lastIndex)}"`);
    return tokens;
}

export function parseFilter(text) {
    const tokens = tokenize(text);
    let i = 0;
    const peek = () => tokens[i];
    const take = () => tokens[i++];
    const expect = (type) => {
        const t = take();
        if (t?.type !== type) throw new Error(`$filter: expected ${type} in "${text}"`);
        return t;
    };
    const word = (w) => peek()?.type === 'word' && peek().value.toLowerCase() === w;

    function operand() {
        const t = take();
        if (t.type === 'value') return () => t.value;
        if (t.type === 'word') {
            const lower = t.value.toLowerCase();
            if (lower === 'true' || lower === 'false') return () => lower === 'true';
            if (lower === 'null') return () => null;
            // A path ("IsAuditEnabled/Value") walks into complex properties.
            return (row) => {
                const v = t.value.split('/').reduce((o, key) => o?.[key], row);
                return typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v.toLowerCase() : v;
            };
        }
        throw new Error(`$filter: unexpected token in "${text}"`);
    }

    function primary() {
        if (peek()?.type === 'open') {
            take();
            const inner = or();
            expect('close');
            return inner;
        }
        if (word('not')) {
            take();
            const inner = primary();
            return (row) => !inner(row);
        }
        const fn = peek()?.type === 'word' && tokens[i + 1]?.type === 'open' && ['contains', 'startswith', 'endswith'].includes(peek().value.toLowerCase());
        if (fn) {
            const name = take().value.toLowerCase();
            expect('open');
            const field = operand();
            expect('comma');
            const value = operand();
            expect('close');
            return (row) => {
                const a = String(field(row) ?? '').toLowerCase();
                const b = String(value(row) ?? '').toLowerCase();
                return name === 'contains' ? a.includes(b) : name === 'startswith' ? a.startsWith(b) : a.endsWith(b);
            };
        }
        const left = operand();
        const op = take()?.value?.toLowerCase();
        const right = operand();
        // Booleans also match 'true' / 'false' — the virtual tables are queried that way.
        const loose = (a, b) => (typeof a === 'boolean' && typeof b === 'string' ? String(a) === b.toLowerCase() : a == b); // eslint-disable-line eqeqeq
        const compare = {
            eq: (a, b) => loose(a, b), ne: (a, b) => !loose(a, b),
            gt: (a, b) => a > b, ge: (a, b) => a >= b, lt: (a, b) => a < b, le: (a, b) => a <= b,
        }[op];
        if (!compare) throw new Error(`$filter: unknown operator "${op}" in "${text}"`);
        return (row) => compare(left(row), right(row));
    }

    function and() {
        let left = primary();
        while (word('and')) {
            take();
            const l = left, r = primary();
            left = (row) => l(row) && r(row);
        }
        return left;
    }

    function or() {
        let left = and();
        while (word('or')) {
            take();
            const l = left, r = and();
            left = (row) => l(row) || r(row);
        }
        return left;
    }

    const predicate = or();
    if (i < tokens.length) throw new Error(`$filter: trailing input in "${text}"`);
    return predicate;
}
