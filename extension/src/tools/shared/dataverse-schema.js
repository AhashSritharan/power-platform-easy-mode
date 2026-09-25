// Building a Parse JSON schema (and a field list) for a Dataverse query,
// straight from table metadata — no sample run required.
//
// Why this exists: "Get row by ID" cannot $expand a 1:N collection, so the
// only way to pull child rows in one call is "List rows" with a filter on the
// primary key. That returns an array, which makes the designer wrap every
// downstream reference in an Apply to each — so people unwrap it with
// first(...) in a Compose, and lose all dynamic content, because a Compose
// output is untyped. Feeding the same JSON through Parse JSON with an explicit
// schema gives the tokens back, without the loop.
//
// Two rules make the generated schema safe at runtime:
//   • nothing is ever `required` — Dataverse omits null columns entirely, and
//     a missing required property fails Parse JSON at runtime;
//   • every scalar type is unioned with "null", because columns that ARE
//     present can still be null.
// Anything unrecognised becomes {} (accept anything) rather than a guess that
// could fail validation.

const FORMATTED = '@OData.Community.Display.V1.FormattedValue';
const LOOKUP_LOGICAL_NAME = '@Microsoft.Dynamics.CRM.lookuplogicalname';
const LOOKUP_NAV_PROPERTY = '@Microsoft.Dynamics.CRM.associatednavigationproperty';

const MAX_EXPAND_DEPTH = 5;

// Dataverse AttributeType → JSON type. Absent means "emit {}".
const JSON_TYPES = {
    String: 'string', Memo: 'string', Uniqueidentifier: 'string', DateTime: 'string',
    EntityName: 'string', ManagedProperty: 'boolean', Boolean: 'boolean',
    Integer: 'integer', BigInt: 'integer', Picklist: 'integer', State: 'integer', Status: 'integer',
    Decimal: 'number', Double: 'number', Money: 'number',
    Lookup: 'string', Customer: 'string', Owner: 'string',
};

const LOOKUP_TYPES = new Set(['Lookup', 'Customer', 'Owner']);
// Types Dataverse ships a display string for alongside the raw value.
const FORMATTED_TYPES = new Set([
    'Picklist', 'State', 'Status', 'Boolean', 'DateTime', 'Money', 'Decimal', 'Double', 'Integer', 'BigInt',
]);

// ── $expand / $select parsing ─────────────────────────────────────────────

/** Splits on `separator`, ignoring separators nested inside parentheses. */
function splitTopLevel(text, separator) {
    const parts = [];
    let depth = 0;
    let current = '';
    for (const char of text) {
        if (char === '(') depth++;
        else if (char === ')') depth--;
        if (char === separator && depth === 0) { parts.push(current); current = ''; }
        else current += char;
    }
    parts.push(current);
    return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * "child($select=a,b;$expand=parent($select=c)),lookup" →
 * [{ name: 'child', select: ['a','b'], expand: [{ name: 'parent', ... }] }, ...]
 */
export function parseExpand(text) {
    if (!text?.trim()) return [];
    return splitTopLevel(text, ',').map((item) => {
        const open = item.indexOf('(');
        if (open === -1) return { name: item.trim(), select: null, expand: [] };

        const inner = item.slice(open + 1, item.lastIndexOf(')'));
        const options = {};
        for (const option of splitTopLevel(inner, ';')) {
            const eq = option.indexOf('=');
            if (eq !== -1) options[option.slice(0, eq).trim().toLowerCase()] = option.slice(eq + 1).trim();
        }
        return {
            name: item.slice(0, open).trim(),
            select: options.$select ? splitTopLevel(options.$select, ',') : null,
            expand: parseExpand(options.$expand ?? ''),
        };
    });
}

export function parseSelect(text) {
    return text?.trim() ? splitTopLevel(text, ',') : null;
}

// ── Metadata ──────────────────────────────────────────────────────────────

/**
 * Table metadata, fetched once per table and kept for the lifetime of the
 * dialog. A single record with three expands otherwise re-reads the same
 * attribute list several times over.
 */
export class MetadataCatalog {
    constructor(dataverse) {
        this.dv = dataverse;
        this.tables = null;
        this.details = new Map();
    }

    async allTables() {
        this.tables ??= (await this.dv.get(
            '/EntityDefinitions?$select=LogicalName,EntitySetName,DisplayName,DisplayCollectionName,PrimaryIdAttribute,PrimaryNameAttribute'))?.value ?? [];
        return this.tables;
    }

    /** Resolves either an entity set name ("accounts") or a logical name ("account"). */
    async findTable(name) {
        const wanted = String(name ?? '').trim().toLowerCase();
        if (!wanted) return null;
        const tables = await this.allTables();
        return tables.find((t) => t.EntitySetName?.toLowerCase() === wanted)
            ?? tables.find((t) => t.LogicalName?.toLowerCase() === wanted)
            ?? null;
    }

    /** { attributes: Map, oneToMany, manyToOne, manyToMany } for a logical name. */
    async detail(logicalName) {
        if (this.details.has(logicalName)) return this.details.get(logicalName);

        const base = `/EntityDefinitions(LogicalName='${logicalName}')`;
        const promise = (async () => {
            const [attributes, oneToMany, manyToOne, manyToMany] = await Promise.all([
                this.dv.get(`${base}/Attributes?$select=LogicalName,SchemaName,DisplayName,AttributeType,AttributeOf`),
                this.dv.get(`${base}/OneToManyRelationships?$select=SchemaName,ReferencedEntityNavigationPropertyName,ReferencingEntity`),
                this.dv.get(`${base}/ManyToOneRelationships?$select=SchemaName,ReferencingEntityNavigationPropertyName,ReferencedEntity,ReferencingAttribute`),
                this.dv.get(`${base}/ManyToManyRelationships?$select=SchemaName,Entity1LogicalName,Entity2LogicalName,Entity1NavigationPropertyName,Entity2NavigationPropertyName`),
            ]);
            return {
                // Attributes with AttributeOf set are the derived companions of
                // another column (formatted variants, money base values); they
                // are never returned as properties of their own.
                attributes: new Map((attributes?.value ?? [])
                    .filter((a) => !a.AttributeOf)
                    .map((a) => [a.LogicalName, a])),
                oneToMany: oneToMany?.value ?? [],
                manyToOne: manyToOne?.value ?? [],
                manyToMany: manyToMany?.value ?? [],
            };
        })();

        this.details.set(logicalName, promise);
        return promise;
    }
}

/** The navigation property `name` on `logicalName`, or null if there is no such relationship. */
async function resolveNavigation(catalog, logicalName, name) {
    const detail = await catalog.detail(logicalName);

    const toMany = detail.oneToMany.find((r) => r.ReferencedEntityNavigationPropertyName === name);
    if (toMany) return { kind: 'array', target: toMany.ReferencingEntity, relationship: toMany.SchemaName };

    const toOne = detail.manyToOne.find((r) => r.ReferencingEntityNavigationPropertyName === name);
    if (toOne) {
        return {
            kind: 'object',
            target: toOne.ReferencedEntity,
            relationship: toOne.SchemaName,
            // The lookup column the expand travels along — its display name is
            // what the designer labels the relationship with ("Primary Contact").
            via: toOne.ReferencingAttribute,
        };
    }

    const manyToMany = detail.manyToMany.find((r) =>
        r.Entity1NavigationPropertyName === name || r.Entity2NavigationPropertyName === name);
    if (manyToMany) {
        return {
            kind: 'array',
            target: manyToMany.Entity1NavigationPropertyName === name
                ? manyToMany.Entity2LogicalName
                : manyToMany.Entity1LogicalName,
            relationship: manyToMany.SchemaName,
        };
    }
    return null;
}

// ── Schema construction ───────────────────────────────────────────────────

const scalarType = (jsonType) => (jsonType ? { type: [jsonType, 'null'] } : {});

/** The user-facing name behind a metadata Label, or null when it has none. */
const labelOf = (label) =>
    label?.UserLocalizedLabel?.Label ?? label?.LocalizedLabels?.[0]?.Label ?? null;

/**
 * Adds one column to the schema, and one picker row per property it produces.
 * `ctx` carries where we are: the property path so far, the matching display
 * names, and the nearest enclosing collection.
 */
function addAttribute(properties, attribute, options, ctx) {
    const isLookup = LOOKUP_TYPES.has(attribute.AttributeType);
    // A lookup is never returned under its own logical name — the value comes
    // back as `_<name>_value`, which is also how it must be referenced later.
    const name = isLookup ? `_${attribute.LogicalName}_value` : attribute.LogicalName;
    const label = labelOf(attribute.DisplayName) ?? attribute.LogicalName;
    const jsonType = JSON_TYPES[attribute.AttributeType];

    properties[name] = scalarType(jsonType);
    ctx.add(name, label, 'scalar', jsonType ?? 'any');
    if (!options.includeAnnotations) return;

    if (isLookup || FORMATTED_TYPES.has(attribute.AttributeType)) {
        properties[`${name}${FORMATTED}`] = { type: ['string', 'null'] };
        ctx.add(`${name}${FORMATTED}`, `${label} (display value)`, 'scalar', 'string');
    }
    if (isLookup) {
        properties[`${name}${LOOKUP_LOGICAL_NAME}`] = { type: ['string', 'null'] };
        ctx.add(`${name}${LOOKUP_LOGICAL_NAME}`, `${label} (target table)`, 'scalar', 'string');
        properties[`${name}${LOOKUP_NAV_PROPERTY}`] = { type: ['string', 'null'] };
        ctx.add(`${name}${LOOKUP_NAV_PROPERTY}`, `${label} (navigation property)`, 'scalar', 'string');
    }
}

/**
 * The requested columns of `logicalName`, resolved against its metadata.
 * `$select` entries may be written either way round for a lookup
 * (`ownerid` or `_ownerid_value`); both land on the same attribute.
 */
async function selectedAttributes(catalog, logicalName, select, warnings, where) {
    const { attributes } = await catalog.detail(logicalName);
    if (!select) return [...attributes.values()];

    const chosen = [];
    for (const raw of select) {
        const entry = raw.trim();
        const candidate = entry.replace(/^_(.+)_value$/, '$1');
        const attribute = attributes.get(entry) ?? attributes.get(candidate);
        if (attribute) chosen.push(attribute);
        else warnings.push(`Column "${entry}" was not found on ${where} — left out of the schema.`);
    }
    return chosen;
}

/**
 * A cursor into the record being described: where the current object sits in
 * the JSON, what to call that position in words, and which collection (if any)
 * encloses it. Field rows are collected through it as the schema is built, so
 * the picker gets display names metadata already has rather than having to
 * reverse-engineer them from the finished schema.
 */
function fieldContext(fields, { path = [], labels = [], arrayPath = null, arrayLabels = [] } = {}) {
    return {
        path, labels, arrayPath, arrayLabels,
        add(name, label, kind, type) {
            fields.push({
                path: [...path, name],
                labels: [...labels, label],
                arrayPath,
                // The innermost collection is the one item() refers to, so it
                // is what the row is badged with; the rest of the chain is
                // carried for searching, since expansions nest up to five deep
                // and only the outer name may be the one the user remembers.
                arrayLabel: arrayLabels.at(-1) ?? null,
                arrayLabels,
                kind, type,
            });
        },
        /** Descends into an expanded single record — the path simply grows. */
        into(name, label) {
            return fieldContext(fields, {
                path: [...path, name], labels: [...labels, label], arrayPath, arrayLabels,
            });
        },
        /**
         * Descends into an expanded collection. Paths restart, because
         * everything below is addressed from item() inside a loop over it.
         */
        intoCollection(name, label) {
            return fieldContext(fields, {
                path: [],
                labels: [],
                arrayPath: [...(arrayPath ?? []), ...path, name],
                arrayLabels: [...arrayLabels, label],
            });
        },
    };
}

async function buildProperties(catalog, logicalName, select, expand, options, warnings, depth, where, ctx) {
    const properties = { '@odata.etag': { type: ['string', 'null'] } };
    ctx.add('@odata.etag', 'ETag', 'scalar', 'string');

    for (const attribute of await selectedAttributes(catalog, logicalName, select, warnings, where)) {
        addAttribute(properties, attribute, options, ctx);
    }

    if (depth >= MAX_EXPAND_DEPTH) {
        if (expand.length) warnings.push(`Stopped expanding below ${where} at ${MAX_EXPAND_DEPTH} levels.`);
        return properties;
    }

    for (const item of expand) {
        const nav = await resolveNavigation(catalog, logicalName, item.name);
        if (!nav) {
            warnings.push(`No relationship named "${item.name}" on ${where} — that property accepts anything in the schema.`);
            properties[item.name] = {};
            ctx.add(item.name, item.name, 'scalar', 'any');
            continue;
        }

        const label = await navigationLabel(catalog, logicalName, item.name, nav);
        ctx.add(item.name, label, nav.kind === 'array' ? 'array' : 'object', nav.kind === 'array' ? 'array' : 'object');

        const child = {
            type: 'object',
            properties: await buildProperties(
                catalog, nav.target, item.select, item.expand, options, warnings, depth + 1,
                `${where} → ${item.name} (${nav.target})`,
                nav.kind === 'array' ? ctx.intoCollection(item.name, label) : ctx.into(item.name, label)),
        };
        properties[item.name] = nav.kind === 'array' ? { type: 'array', items: child } : child;
    }

    return properties;
}

/**
 * What to call an expanded relationship. A single record is named after the
 * lookup it travels along ("Primary Contact"); a collection is named after the
 * table it holds ("Contacts"), which is how the designer labels them too.
 */
async function navigationLabel(catalog, logicalName, navName, nav) {
    if (nav.kind === 'object' && nav.via) {
        const { attributes } = await catalog.detail(logicalName);
        const label = labelOf(attributes.get(nav.via)?.DisplayName);
        if (label) return label;
    }
    const target = (await catalog.allTables()).find((t) => t.LogicalName === nav.target);
    return (nav.kind === 'array' ? labelOf(target?.DisplayCollectionName) : null)
        ?? labelOf(target?.DisplayName)
        ?? navName;
}

/**
 * buildRecordSchema(catalog, { table, select, expand, includeAnnotations })
 *   → { schema, table, warnings, fields }
 * `schema` describes ONE record — i.e. what first(...) of a List rows body
 * yields. Wrap it with {@link wrapAsListBody} for the whole response.
 * `fields` is the flat, display-named list behind the field picker.
 */
export async function buildRecordSchema(catalog, { table, select, expand, includeAnnotations = true }) {
    const resolved = await catalog.findTable(table);
    if (!resolved) throw new Error(`No table matches "${table}" in this environment.`);

    const warnings = [];
    const fields = [];
    const properties = await buildProperties(
        catalog, resolved.LogicalName,
        parseSelect(select), parseExpand(expand),
        { includeAnnotations }, warnings, 0, resolved.LogicalName,
        fieldContext(fields));

    return { schema: { type: 'object', properties }, table: resolved, warnings, fields };
}

/** The full "List rows" body — `{ value: [ <record> ] }` — around a record schema. */
export function wrapAsListBody(recordSchema) {
    return {
        type: 'object',
        properties: {
            '@odata.context': { type: ['string', 'null'] },
            value: { type: 'array', items: recordSchema },
        },
    };
}

/**
 * The schema as the designer needs it PASTED, which is not quite the schema.
 *
 * A string that begins with "@" is an expression in the Logic Apps definition
 * language, so a property NAME starting with one — "@odata.etag", and
 * "@odata.context" on a whole body — is read as an expression rather than as
 * text, and the flow will not publish: the designer reports the schema as
 * invalid. "@@" is the documented escape for a literal "@", and the runtime
 * unescapes it, so what Parse JSON actually matches is still "@odata.etag".
 *
 * Only a LEADING "@" is special. The annotation suffixes carry theirs in the
 * middle of the name, where it is ordinary text and must be left alone.
 */
export function escapeLeadingAt(schema) {
    if (!schema || typeof schema !== 'object') return schema;

    const escaped = { ...schema };
    if (schema.properties) {
        escaped.properties = Object.fromEntries(
            Object.entries(schema.properties).map(([name, value]) =>
                [name.startsWith('@') ? `@${name}` : name, escapeLeadingAt(value)]),
        );
    }
    if (schema.items) escaped.items = escapeLeadingAt(schema.items);
    return escaped;
}

// ── Field list ────────────────────────────────────────────────────────────

const segments = (path) => path.map((name) => `?['${name}']`).join('');

/** The display name of a field row, as the dynamic content list would show it. */
export function labelFor(row) {
    return row.labels.join(' → ');
}

/**
 * The expression that reads a flattened row. Rows below a collection are only
 * reachable from inside a loop over it, so they are expressed against items().
 */
export function expressionFor(row, sourceExpression) {
    if (!row.arrayPath) return `${sourceExpression}${segments(row.path)}`;
    return `item()${segments(row.path)}`;
}
