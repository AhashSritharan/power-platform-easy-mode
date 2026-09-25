// Clone planning: turns "this record" into an ordered, deduplicated list of
// writes against a target environment.
//
// The problem this solves is that a record graph is not a tree. The same
// record can be reached by several paths (two translations referencing one
// language row), and lookups can point back up the graph. A deep insert can
// only express a tree — every nested object is an unconditional create — so a
// record reached twice would be created twice, and a back-reference cannot be
// written at all.
//
// So the graph is walked once, keyed by SOURCE identity, and each distinct
// record becomes exactly one node. Every node is given its target GUID up
// front (the source GUID when ids are preserved, otherwise a fresh one), which
// means every edge is resolvable before anything is written — the plan is a
// flat, ordered list rather than a nested payload.
//
// Traversal rules, which exist to keep the blast radius finite:
//   • 1:N children are cloned, and may be expanded further (nested clone).
//   • N:1 parents are REFERENCED, never cloned — unless the target is missing
//     the record and backfill is on, in which case the parent is created (with
//     its own missing parents, recursively) but its children are NEVER
//     expanded. Without that rule, cloning one row reaches an entire org:
//     row → its account → every other row on that account.

const cleanGuid = (guid) => (guid ? String(guid).replace(/[{}]/g, '').toLowerCase() : '');

const nodeKey = (entity, id) => `${entity}|${cleanGuid(id)}`;

export const ACTIONS = { CREATE: 'create', UPDATE: 'update', SKIP: 'skip' };

/**
 * Orders nodes so every node follows the ones it references.
 *
 * Genuine cycles cannot be ordered, and a change set rejects a reference to an
 * operation that has not run yet. Those edges are therefore cut and returned
 * as `deferred` — binds the caller applies in a follow-up PATCH once both
 * records exist, which still lives inside the same atomic change set.
 */
function orderNodes(nodes) {
    const byKey = new Map(nodes.map((node) => [node.key, node]));
    const remaining = new Set(byKey.keys());
    const emitted = new Set();
    const order = [];

    const unmet = (node) => [...node.deps].filter((dep) => remaining.has(dep) && !emitted.has(dep));

    while (remaining.size) {
        const ready = [...remaining].filter((key) => unmet(byKey.get(key)).length === 0);
        if (ready.length) {
            for (const key of ready) {
                order.push(byKey.get(key));
                emitted.add(key);
                remaining.delete(key);
            }
            continue;
        }
        // Everything left is in a cycle. Break it at the node with the fewest
        // unmet dependencies and defer exactly those binds — the smallest cut
        // that lets the rest of the order stand.
        const stuck = [...remaining]
            .map((key) => byKey.get(key))
            .sort((a, b) => unmet(a).length - unmet(b).length)[0];
        for (const dep of unmet(stuck)) {
            for (const [bindKey, value] of stuck.binds) {
                if (value.nodeKey !== dep) continue;
                stuck.deferred.push({ bindKey, value });
                stuck.binds.delete(bindKey);
            }
            stuck.deps.delete(dep);
        }
        order.push(stuck);
        emitted.add(stuck.key);
        remaining.delete(stuck.key);
    }
    return order;
}

/**
 * Walks the source graph and produces a write plan.
 *
 * Every injected helper belongs to the calling tool, so this module stays free
 * of any policy about which columns are cloneable or how lookups are named.
 *
 * @param {object} ctx
 * @param {object} ctx.source                 Dataverse client for the source org
 * @param {object} ctx.target                 Dataverse client for the destination org
 * @param {{entity: string, id: string, record: object, metadata: object}} ctx.root
 * @param {(entity: string, client: object) => Promise<object>} ctx.metadataFor
 * @param {(record: object, entity: string) => Promise<object[]>} ctx.lookupsOf  lookups as {attrName, bindKey, targetEntity, id, label}
 * @param {(entity: string) => boolean} ctx.isIdentity   user/team tables, mapped by identity elsewhere
 * @param {(childEntity: string, attribute: string, parentEntity: string) => Promise<string>} [ctx.parentBindKey]
 *        the @odata.bind key for a child's parent lookup — the navigation
 *        property name, which is rarely the attribute's logical name
 * @param {Map<string, {rel: object, updateExisting: boolean}>} ctx.selected  keyed by {@link relPathKey}
 * @param {object} [ctx.options]
 * @param {boolean} [ctx.options.preserveIds=true]
 * @param {boolean} [ctx.options.backfillParents=true]   create N:1 targets missing from the target org
 * @param {boolean} [ctx.options.updateExistingRelated=false]
 * @param {boolean} [ctx.options.deleteOrphans=false]
 * @param {number}  [ctx.options.maxDepth=3]             1:N nesting levels below the root
 * @param {number}  [ctx.options.maxParentDepth=3]       N:1 backfill hops
 * @param {number}  [ctx.options.nodeCap=400]
 */
export async function buildClonePlan(ctx) {
    const {
        source, target, root, metadataFor, lookupsOf, isIdentity, selected,
        parentBindKey = async (_child, attribute) => `${attribute}@odata.bind`,
        options = {},
    } = ctx;
    const {
        preserveIds = true, backfillParents = true, updateExistingRelated = false,
        deleteOrphans = false, maxDepth = 3, maxParentDepth = 3, nodeCap = 400,
    } = options;

    const nodes = new Map();
    const deletes = [];
    const warnings = [];
    let capped = false;

    const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);

    // Existence is asked once per record and reused: a shared parent is
    // checked once no matter how many nodes reference it.
    const existsCache = new Map();
    async function existsInTarget(entity, entitySet, idAttr, id) {
        const key = nodeKey(entity, id);
        if (!existsCache.has(key)) {
            existsCache.set(key, (async () => {
                try {
                    await target.get(`/${entitySet}(${cleanGuid(id)})?$select=${idAttr}`);
                    return true;
                } catch (e) {
                    if (e.status === 404) return false;
                    throw e;
                }
            })());
        }
        return existsCache.get(key);
    }

    /** Registers a record as a node, or returns the existing one (dedupe). */
    async function intern(entity, record, id, kind, depth) {
        const key = nodeKey(entity, id);
        const found = nodes.get(key);
        if (found) return found;
        if (nodes.size >= nodeCap) { capped = true; return null; }

        const sourceMetadata = await metadataFor(entity, source);
        const targetMetadata = await metadataFor(entity, target);
        if (!targetMetadata) {
            warnings.push(`Table "${entity}" does not exist in the target — ${kind === 'parent' ? 'the reference was left empty' : 'those records were skipped'}.`);
            return null;
        }
        const idAttr = targetMetadata.PrimaryIdAttribute;
        const exists = await existsInTarget(entity, targetMetadata.EntitySetName, idAttr, id);

        const node = {
            key,
            entity,
            entitySet: targetMetadata.EntitySetName,
            metadata: targetMetadata,
            sourceMetadata,
            sourceId: cleanGuid(id),
            // A preserved id is what makes a config row addressable by the same
            // GUID in every environment; otherwise the id is still assigned
            // here, so that references resolve before anything is written.
            targetId: preserveIds ? cleanGuid(id) : newId(),
            record,
            kind,
            exists,
            depth,
            parentKey: null,
            rel: null,
            binds: new Map(),
            deferred: [],
            deps: new Set(),
            action: exists ? ACTIONS.SKIP : ACTIONS.CREATE,
        };
        nodes.set(key, node);
        return node;
    }

    const rootNode = await intern(root.entity, root.record, root.id, 'root', 0);
    if (!rootNode) throw new Error(`Table "${root.entity}" does not exist in the target environment.`);
    // The root is the thing the user asked for, so an existing one is updated
    // rather than skipped — that is the established cross-environment upsert.
    rootNode.action = rootNode.exists ? ACTIONS.UPDATE : ACTIONS.CREATE;

    const queue = [rootNode];

    while (queue.length) {
        const node = queue.shift();
        await resolveLookups(node);
        // A backfilled parent is created so a reference resolves — expanding
        // its own children would pull in an unbounded slice of the org.
        if (node.kind !== 'parent') await expandChildren(node);
    }

    /** N:1: bind to the target's record, or create the missing one. */
    async function resolveLookups(node) {
        for (const lookup of await lookupsOf(node.record, node.entity)) {
            // Users and teams are re-pointed by Entra identity, not by id, and
            // are never created here.
            if (isIdentity(lookup.targetEntity)) continue;

            const targetMetadata = await metadataFor(lookup.targetEntity, target);
            if (!targetMetadata) continue; // table absent in target; bind dropped

            const present = await existsInTarget(
                lookup.targetEntity, targetMetadata.EntitySetName,
                targetMetadata.PrimaryIdAttribute, lookup.id);

            if (present) {
                node.binds.set(lookup.bindKey, {
                    path: `/${targetMetadata.EntitySetName}(${cleanGuid(lookup.id)})`,
                    nodeKey: null,
                });
                continue;
            }
            if (!backfillParents || node.depth >= maxParentDepth) continue;

            const record = await readRecord(lookup.targetEntity, lookup.id);
            if (!record) continue;
            const parent = await intern(lookup.targetEntity, record, lookup.id, 'parent', node.depth + 1);
            if (!parent) continue;

            node.deps.add(parent.key);
            node.binds.set(lookup.bindKey, {
                path: `/${parent.entitySet}(${parent.targetId})`,
                nodeKey: parent.key,
            });
            if (parent.kind === 'parent' && !parent.queued) {
                parent.queued = true;
                queue.push(parent);
            }
        }
    }

    async function readRecord(entity, id) {
        const metadata = await metadataFor(entity, source);
        if (!metadata) return null;
        try {
            return await source.get(`/${metadata.EntitySetName}(${cleanGuid(id)})`,
                { Prefer: 'odata.include-annotations="*"' });
        } catch (e) {
            warnings.push(`Could not read ${entity} ${cleanGuid(id)} from the source: ${e.message}`);
            return null;
        }
    }

    /** 1:N: clone the selected child collections, one level per call. */
    async function expandChildren(node) {
        if (node.depth >= maxDepth) return;

        for (const [, entry] of selected) {
            const rel = entry.rel;
            // A relationship applies wherever its parent table turns up, so
            // selecting one at the root also expands it further down; depth is
            // what bounds that, not the selection.
            if (rel.ReferencedEntity !== node.entity) continue;

            const navProp = rel.ReferencedEntityNavigationPropertyName;
            let children;
            try {
                const data = await source.get(
                    `/${node.sourceMetadata.EntitySetName}(${node.sourceId})/${navProp}`,
                    { Prefer: 'odata.include-annotations="*"' });
                children = data.value ?? [];
            } catch (e) {
                warnings.push(`Could not read ${rel.ReferencingEntity} under ${node.entity}: ${e.message}`);
                continue;
            }

            const childIdAttr = (await metadataFor(rel.ReferencingEntity, source))?.PrimaryIdAttribute;
            if (!childIdAttr) continue;
            const sourceIds = new Set();

            for (const child of children) {
                const childId = cleanGuid(child[childIdAttr]);
                sourceIds.add(childId);
                const childNode = await intern(rel.ReferencingEntity, child, childId, 'child', node.depth + 1);
                if (!childNode) continue;

                // Reached twice (two parents, one child) — the containment
                // recorded first wins; the second is just a reference.
                if (!childNode.parentKey) {
                    childNode.parentKey = node.key;
                    childNode.rel = rel;
                    // The same key resolveLookups would derive for this very
                    // lookup. Constructing it from the attribute name instead
                    // would write a second, differently-spelled property for
                    // the one reference.
                    childNode.parentBind = await parentBindKey(
                        rel.ReferencingEntity, rel.ReferencingAttribute, node.entity);
                    childNode.binds.set(childNode.parentBind, {
                        path: `/${node.entitySet}(${node.targetId})`,
                        nodeKey: node.key,
                    });
                    // With a self-referential relationship the root can turn up
                    // again as a child of its own descendant. It is still the
                    // record the user asked to clone, so it keeps its action —
                    // the related-record rules do not get to demote it.
                    if (childNode.exists && childNode.kind !== 'root') {
                        const update = entry.updateExisting ?? updateExistingRelated;
                        childNode.action = update ? ACTIONS.UPDATE : ACTIONS.SKIP;
                    }
                }
                childNode.deps.add(node.key);
                if (!childNode.queued) {
                    childNode.queued = true;
                    queue.push(childNode);
                }
            }

            if (deleteOrphans && node.exists) {
                await collectOrphans(node, rel, childIdAttr, sourceIds);
            }
        }
    }

    /** Rows under this parent in the target that the source no longer has. */
    async function collectOrphans(node, rel, childIdAttr, sourceIds) {
        const childMetadata = await metadataFor(rel.ReferencingEntity, target);
        if (!childMetadata) return;
        try {
            const data = await target.get(
                `/${node.entitySet}(${node.targetId})/${rel.ReferencedEntityNavigationPropertyName}?$select=${childIdAttr}`,
                { Prefer: 'odata.include-annotations="*"' });
            for (const existing of data.value ?? []) {
                const id = cleanGuid(existing[childIdAttr]);
                if (sourceIds.has(id)) continue;
                deletes.push({
                    entity: rel.ReferencingEntity,
                    entitySet: childMetadata.EntitySetName,
                    id,
                    label: existing[childMetadata.PrimaryNameAttribute]
                        ?? existing[`${childMetadata.PrimaryNameAttribute}@OData.Community.Display.V1.FormattedValue`]
                        ?? id,
                    parentKey: node.key,
                    rel,
                });
            }
        } catch (e) {
            warnings.push(`Could not check ${rel.ReferencingEntity} for removed records: ${e.message}`);
        }
    }

    const all = [...nodes.values()];
    // A skipped node writes nothing, so nothing downstream can wait on it.
    for (const node of all) {
        if (node.action !== ACTIONS.SKIP) continue;
        for (const other of all) other.deps.delete(node.key);
    }
    const order = orderNodes(all).filter((node) => node.action !== ACTIONS.SKIP || node.deferred.length);

    // How many records point AT each node — its in-degree. This is what makes
    // a record "shared", and therefore what decides whether the graph can be
    // written as a nested payload at all: a node reached twice would have to
    // appear twice, and a deep insert creates every occurrence it is given.
    for (const node of all) node.referencedBy = new Set();
    for (const node of all) {
        for (const dep of node.deps) nodes.get(dep)?.referencedBy.add(node.key);
        for (const { value } of node.deferred) {
            if (value.nodeKey) nodes.get(value.nodeKey)?.referencedBy.add(node.key);
        }
    }

    if (capped) {
        warnings.push(`The graph was cut off at ${nodeCap} records. Narrow the selected relationships or reduce the nesting depth.`);
    }

    const stats = {
        create: all.filter((n) => n.action === ACTIONS.CREATE).length,
        update: all.filter((n) => n.action === ACTIONS.UPDATE).length,
        skip: all.filter((n) => n.action === ACTIONS.SKIP).length,
        delete: deletes.length,
        deferred: all.reduce((sum, n) => sum + n.deferred.length, 0),
    };

    return { root: rootNode, nodes: all, order, deletes, warnings, stats, capped };
}

/**
 * True when the whole plan can be written as ONE deep insert.
 *
 * Deep insert handles a great deal — 1:N collections, N:1 parents, nested to
 * any depth, all created atomically in a single request. What it cannot do is
 * anything that is not a tree of creates:
 *   • it only ever creates, so an update or a delete rules it out;
 *   • every nested object is created unconditionally, so a record referenced
 *     from two places would be created twice;
 *   • the payload is JSON, so a cycle cannot be expressed at all.
 * Those cases go through a change set instead.
 */
export function isSimpleTree(plan) {
    if (plan.deletes.length || plan.stats.update || plan.stats.skip || plan.stats.deferred) return false;
    if (plan.nodes.some((node) => node.action !== ACTIONS.CREATE)) return false;

    // Count, for every node, how many places would nest it. This mirrors the
    // nesting itself rather than reasoning about in-degree: a parent legally
    // "has" many children, so a plain edge count would reject the ordinary
    // root-with-children case that deep insert handles best.
    const byKey = new Map(plan.nodes.map((node) => [node.key, node]));
    const nesters = new Map(plan.nodes.map((node) => [node.key, 0]));
    const bump = (key) => nesters.set(key, nesters.get(key) + 1);

    for (const node of plan.nodes) {
        for (const [bindKey, value] of node.binds) {
            if (!value.nodeKey) continue; // bound to a record the target already has
            const referenced = byKey.get(value.nodeKey);
            if (!referenced) return false;
            // The link to its own container disappears into the nesting.
            if (value.nodeKey === node.parentKey && bindKey === node.parentBind) continue;
            // Anything else pointing at a record created in this same payload
            // can only be expressed as a bind, and a bind cannot resolve
            // against a record that does not exist yet.
            if (referenced.kind !== 'parent') return false;
            bump(referenced.key);
        }
        if (node !== plan.root && node.parentKey) bump(node.key);
    }
    // Exactly one home each, and the root belongs to no one.
    return plan.nodes.every((node) => nesters.get(node.key) === (node === plan.root ? 0 : 1));
}
