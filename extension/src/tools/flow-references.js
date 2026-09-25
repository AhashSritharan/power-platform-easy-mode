// Find All References for Power Automate.
//
// The designer will happily let you rename or delete a step that half the flow
// is reading from, and tells you nothing until a run fails. There is no "who
// uses this?" anywhere in the product — so answering it means opening every
// downstream action and squinting at its expressions.
//
// A plain substring search over the definition ("which actions mention this
// name?") almost works, and it is what this started out as. It falls over on
// three things:
//
//   • Names are written differently in expressions than in the definition —
//     "Get a row" is the key, body('Get_a_row') is the reference.
//   • Substrings collide. Searching for "Compose" hits every body('Compose_2').
//   • It cannot tell a data reference from a runAfter edge from a stray mention
//     in an email body — and those mean completely different things when you
//     are deciding whether a step is safe to change.
//
// So the definition is parsed instead, and every reference is resolved to the
// symbol it actually points at: expression reads (body/outputs/items/…), the
// runAfter graph, and variable reads and writes. The loose text search survives
// as a clearly-labelled extra section, because it is the only thing that finds
// a name hardcoded into a string — with a word-boundary check to keep the
// Compose_2 problem out of it.
//
// Symbols are actions, the trigger, and variables. Both directions are shown:
// what references this (Find All References) and what this references (Go to
// Definition, roughly).

import * as ui from '../core/ui.js';
import * as commands from '../core/commands.js';
import {
    describeLookupFailure,
    expressionName,
    flowContextFromUrl,
    parseFlowDefinitionJson,
    resolveFlowDefinition,
    resolveOrgUrl,
} from './shared/flow-source.js';

const STYLE = `
    .fr-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
    .fr-scroll { flex: 1; min-height: 120px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; }
    .fr-group-title {
        font-size: 10px; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase;
        color: var(--muted); padding: 10px 12px 4px; background: var(--bg2);
    }
    .fr-sym {
        display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
        font: inherit; cursor: pointer; padding: 8px 12px; border: none;
        border-bottom: 1px solid var(--border); background: none; color: var(--text);
    }
    .fr-sym:hover { background: var(--bg2); }
    .fr-sym .f { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
    .fr-sym .n { font-size: 13px; font-weight: 600; }
    .fr-sym .p { font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fr-count {
        flex-shrink: 0; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 10px;
        background: var(--bg2); color: var(--muted); border: 1px solid var(--border);
    }
    .fr-count.has { background: var(--accent); border-color: var(--accent); color: #fff; }
    .fr-count.none { color: #8a6d00; border-color: #f7b955; }
    @media (prefers-color-scheme: dark) { .fr-count.none { color: #f5d78b; border-color: #6b5410; } }

    .fr-head { display: flex; align-items: flex-start; gap: 8px; }
    .fr-head .f { flex: 1; min-width: 0; }
    .fr-head .n { font-size: 15px; font-weight: 600; word-break: break-word; }
    .fr-head .p { font-size: 11px; color: var(--muted); word-break: break-word; }
    .fr-back {
        font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; padding: 4px 8px;
        border: 1px solid var(--border); border-radius: 5px; background: var(--bg); color: var(--text);
        flex-shrink: 0;
    }
    .fr-back:hover { background: var(--bg2); }

    .fr-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); }
    .fr-tab {
        font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; padding: 7px 12px;
        border: none; background: none; color: var(--muted); border-bottom: 2px solid transparent;
    }
    .fr-tab.on { color: var(--accent); border-bottom-color: var(--accent); }

    .fr-from { display: flex; align-items: center; gap: 6px; padding: 8px 12px 6px; background: var(--bg2); border-top: 1px solid var(--border); }
    .fr-from:first-child { border-top: none; }
    .fr-from .name {
        font: inherit; font-size: 13px; font-weight: 600; text-align: left; flex: 1; min-width: 0;
        border: none; background: none; color: var(--accent); cursor: pointer; padding: 0;
    }
    .fr-from .name:hover { text-decoration: underline; }
    .fr-from .name .p { display: block; font-size: 11px; font-weight: 400; color: var(--muted); }
    .fr-from .name.broken { color: var(--danger); cursor: default; }
    .fr-from .name.broken:hover { text-decoration: none; }
    .fr-from .name.broken .fr-missing { display: block; font-weight: 400; }
    .fr-reveal {
        font: inherit; font-size: 12px; cursor: pointer; flex-shrink: 0; padding: 2px 7px;
        border: 1px solid var(--border); border-radius: 5px; background: var(--bg); color: var(--text);
    }
    .fr-reveal:hover { border-color: var(--accent); }

    .fr-ref { padding: 6px 12px 8px; border-top: 1px dotted var(--border); }
    .fr-ref .meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .fr-badge {
        font-family: Consolas, monospace; font-size: 10px; font-weight: 700; padding: 1px 6px;
        border-radius: 3px; background: var(--accent); color: #fff; flex-shrink: 0;
    }
    .fr-badge.control { background: #8764b8; }
    .fr-badge.write { background: #ca5010; }
    .fr-badge.loose { background: var(--muted); }
    .fr-ref .where { font-family: Consolas, monospace; font-size: 11px; color: var(--muted); word-break: break-all; }
    .fr-missing { font-size: 11px; font-weight: 600; color: var(--danger); }
    .fr-snip { font-family: Consolas, monospace; font-size: 11px; margin-top: 4px; word-break: break-all; }
    .fr-snip mark { background: #fff4ce; color: #6b4b00; border-radius: 2px; padding: 0 1px; }
    @media (prefers-color-scheme: dark) { .fr-snip mark { background: #4a3c10; color: #f5d78b; } }
    .fr-snip .dim { color: var(--muted); }
    .fr-empty { padding: 24px 16px; text-align: center; color: var(--muted); font-size: 13px; }
    .fr-json {
        width: 100%; height: 280px; padding: 12px; box-sizing: border-box;
        font-family: Consolas, monospace; font-size: 12px; resize: vertical;
        border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--text);
    }
`;

// ── Reference model ───────────────────────────────────────────────────────

// Expression functions that name another step. items()/iterationIndexes() name
// a loop and result() a scope — all of them are action references.
const ACTION_FUNCTIONS = ['body', 'outputs', 'actions', 'actionBody', 'actionOutputs', 'result', 'items', 'iterationIndexes'];
const TRIGGER_FUNCTIONS = ['triggerBody', 'triggerOutputs', 'triggerFormDataValue', 'triggerFormDataMultiValues', 'triggerMultipartBody', 'trigger'];
const VARIABLE_FUNCTIONS = ['variables'];

// One pass finds every call: fn('Name') and the argument-less trigger forms.
const REFERENCE_PATTERN = new RegExp(
    `\\b(${[...ACTION_FUNCTIONS, ...TRIGGER_FUNCTIONS, ...VARIABLE_FUNCTIONS].join('|')})\\s*\\(\\s*(?:'([^']*)'\\s*)?\\)`,
    'gi');

function functionKind(fn) {
    const lower = fn.toLowerCase();
    if (VARIABLE_FUNCTIONS.some((name) => name.toLowerCase() === lower)) return 'variable';
    if (TRIGGER_FUNCTIONS.some((name) => name.toLowerCase() === lower)) return 'trigger';
    return 'action';
}

// The action types that write to a variable, and the word to describe it with.
// InitializeVariable is the declaration; the rest name their target in
// inputs.name, which no expression scan would ever see.
const VARIABLE_WRITERS = {
    initializevariable: 'declares',
    setvariable: 'sets',
    incrementvariable: 'increments',
    decrementvariable: 'decrements',
    appendtoarrayvariable: 'appends',
    appendtostringvariable: 'appends',
};

/**
 * Every action, the trigger, and every variable, flattened out of the nested
 * scopes. `path` is the container chain an action sits in; `json` is the raw
 * node, kept so references can be scanned out of it.
 */
function collectSymbols(definition) {
    const symbols = [];

    for (const [name, trigger] of Object.entries(definition?.triggers ?? {})) {
        symbols.push({ kind: 'trigger', name, type: trigger?.type ?? '', path: name, json: trigger });
    }

    const visit = (container, path) => {
        for (const [name, action] of Object.entries(container ?? {})) {
            const here = path ? `${path} / ${name}` : name;
            symbols.push({ kind: 'action', name, type: action?.type ?? '', path: here, json: action });
            visit(action?.actions, here);
            visit(action?.else?.actions, here);
            visit(action?.default?.actions, here);
            for (const [caseName, branch] of Object.entries(action?.cases ?? {})) {
                visit(branch?.actions, `${here} / ${caseName}`);
            }
        }
    };
    visit(definition?.actions, '');

    // Variables are declared inside an action rather than at the top of the
    // definition, so their declaration site is that action.
    for (const symbol of [...symbols]) {
        if ((symbol.type ?? '').toLowerCase() !== 'initializevariable') continue;
        for (const variable of symbol.json?.inputs?.variables ?? []) {
            if (!variable?.name) continue;
            symbols.push({
                kind: 'variable',
                name: variable.name,
                type: variable.type ?? '',
                path: `declared in ${symbol.name}`,
                json: null,
                declaredIn: symbol,
            });
        }
    }

    return symbols;
}

/**
 * An action's own properties: everything except the steps nested inside it and
 * its runAfter, both of which are accounted for separately. A switch's `case`
 * values stay, because they can hold expressions; the actions under them go.
 */
function ownProperties(node) {
    const own = {};
    for (const [key, value] of Object.entries(node ?? {})) {
        if (key === 'actions' || key === 'else' || key === 'default' || key === 'runAfter') continue;
        if (key === 'cases') {
            own.cases = Object.fromEntries(Object.entries(value ?? {}).map(([name, branch]) => {
                const { actions, ...rest } = branch ?? {};
                return [name, rest];
            }));
            continue;
        }
        own[key] = value;
    }
    return own;
}

/** Calls back with every string in a JSON value, and the dotted path to it. */
function eachString(value, path, visit) {
    if (typeof value === 'string') { visit(value, path); return; }
    if (Array.isArray(value)) {
        value.forEach((item, index) => eachString(item, `${path}[${index}]`, visit));
        return;
    }
    if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
            eachString(child, path ? `${path}.${key}` : key, visit);
        }
    }
}

/**
 * Resolves a name as written in an expression back to a symbol.
 *
 * Spaces become underscores in expressions, so both spellings are tried, then
 * case-insensitively — a reference whose case is wrong is still a reference to
 * that step, and one of the more useful things to be shown.
 */
function resolveSymbol(symbols, kind, name) {
    const candidates = symbols.filter((symbol) => symbol.kind === kind);
    if (kind === 'trigger' && !name) return candidates[0] ?? null;
    return candidates.find((symbol) => symbol.name === name || expressionName(symbol.name) === name)
        ?? candidates.find((symbol) => symbol.name.toLowerCase() === name.toLowerCase()
            || expressionName(symbol.name).toLowerCase() === name.toLowerCase())
        ?? null;
}

/**
 * The whole reference graph in one pass over the definition.
 *
 * Every edge records where in the JSON it was found and where inside that
 * string the match sits, so results can be shown the way an IDE shows them —
 * the location, and the match highlighted in its line.
 */
export function buildIndex(definition) {
    const symbols = collectSymbols(definition);
    const edges = [];

    for (const from of symbols) {
        if (from.kind === 'variable') continue;

        // Control flow: "runs after X" is a dependency on X even when nothing
        // in this step reads X's output.
        for (const [name, statuses] of Object.entries(from.json?.runAfter ?? {})) {
            edges.push({
                from, kind: 'runAfter', label: 'runAfter',
                toName: name, toKind: 'action',
                to: resolveSymbol(symbols, 'action', name),
                where: 'runAfter',
                text: `runAfter ${name} → ${(statuses ?? []).join(', ') || 'Succeeded'}`,
                start: 'runAfter '.length, length: name.length,
            });
        }

        // Variable writes name their target in a plain string rather than an
        // expression, so nothing below would find them.
        const writer = VARIABLE_WRITERS[(from.type ?? '').toLowerCase()];
        if (writer) {
            const targets = writer === 'declares'
                ? (from.json?.inputs?.variables ?? []).map((variable, index) => [variable?.name, `inputs.variables[${index}].name`])
                : [[from.json?.inputs?.name, 'inputs.name']];
            for (const [name, where] of targets) {
                if (!name) continue;
                edges.push({
                    from, kind: 'write', label: writer,
                    toName: name, toKind: 'variable',
                    to: resolveSymbol(symbols, 'variable', name),
                    where, text: name, start: 0, length: name.length,
                });
            }
        }

        eachString(ownProperties(from.json), '', (text, where) => {
            REFERENCE_PATTERN.lastIndex = 0;
            let match;
            while ((match = REFERENCE_PATTERN.exec(text)) !== null) {
                const toName = match[2] ?? '';
                const toKind = functionKind(match[1]);
                const to = resolveSymbol(symbols, toKind, toName);
                // A nameless call to something that does not exist (there is no
                // trigger at all, say) points at nothing worth reporting.
                if (!to && !toName) continue;
                edges.push({
                    from, kind: 'expression', label: `${match[1]}()`,
                    toName: toName || to?.name || '', toKind, to,
                    where: where || 'inputs',
                    text, start: match.index, length: match[0].length,
                });
            }
        });
    }

    const incoming = new Map();
    for (const edge of edges) {
        if (!edge.to) continue;
        const list = incoming.get(edge.to) ?? [];
        list.push(edge);
        incoming.set(edge.to, list);
    }

    return { symbols, edges, incoming };
}

const isWordCharacter = (character) => character !== undefined && /[A-Za-z0-9_]/.test(character);

// Structural properties, skipped by the loose scan only. An action named
// "Compose" otherwise matches the `type: "Compose"` of every Compose in the
// flow — noise that would bury the hardcoded mentions the scan is there for.
const STRUCTURAL_KEYS = new Set(['type', 'kind']);
const isStructural = (path) => STRUCTURAL_KEYS.has(path.split('.').pop());

/**
 * The loose half: occurrences of the name in a string that no parsed reference
 * accounts for — a step name hardcoded into an email body, a trackedProperty,
 * a description. Word boundaries keep "Compose" from matching Compose_2, and
 * anything already reported as a real reference is filtered out.
 *
 * Computed on demand rather than up front: it is a scan of the whole flow per
 * symbol, and most symbols are never opened.
 */
export function findTextMentions(index, target) {
    const needles = [...new Set([target.name, expressionName(target.name)])].filter(Boolean);
    const parsed = index.edges.filter((edge) => edge.kind === 'expression');
    const mentions = [];

    for (const from of index.symbols) {
        if (from.kind === 'variable' || from === target || from === target.declaredIn) continue;

        eachString(ownProperties(from.json), '', (text, path) => {
            if (isStructural(path)) return;
            const where = path || 'inputs';
            for (const needle of needles) {
                for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
                    if (isWordCharacter(text[at - 1]) || isWordCharacter(text[at + needle.length])) continue;
                    const insideParsedReference = parsed.some((edge) =>
                        edge.from === from && edge.where === where
                        && at >= edge.start && at < edge.start + edge.length);
                    if (insideParsedReference) continue;
                    mentions.push({
                        from, kind: 'text', label: 'text',
                        toName: target.name, toKind: target.kind, to: target,
                        where, text, start: at, length: needle.length,
                    });
                }
            }
        });
    }
    return mentions;
}

// ── Designer canvas ───────────────────────────────────────────────────────
//
// The canvas is a react-flow graph whose node ids are the action names from the
// definition — the same names this tool indexes. Nothing here is a contract
// the designer owes us, so both of these are best-effort and every caller
// copes with being told no.

const canvasNodes = () => [...document.querySelectorAll('.react-flow__node')];

/** The action the user has selected in the designer, if one is. */
function selectedActionName() {
    const selected = document.querySelector('.react-flow__node.selected')
        ?? canvasNodes().find((node) => node.getAttribute('aria-selected') === 'true');
    return selected?.dataset?.id ?? null;
}

/** Selects an action on the canvas. False when it could not be found. */
function revealInDesigner(name) {
    const node = canvasNodes().find((candidate) => candidate.dataset?.id === name);
    if (!node) return false;
    node.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'smooth' });
    (node.querySelector('[role="button"]') ?? node.firstElementChild ?? node).click();
    return true;
}

// ── Rendering ─────────────────────────────────────────────────────────────

const KIND_ICON = { trigger: '⚡', action: '▸', variable: '🅥' };
const KIND_TITLE = { trigger: 'Trigger', action: 'Actions', variable: 'Variables' };
const BADGE_CLASS = { runAfter: 'control', write: 'write', text: 'loose' };

/** A one-line preview of the string a reference sits in, match highlighted. */
function snippetNodes(text, start, length, radius = 44) {
    const from = Math.max(0, start - radius);
    const to = Math.min(text.length, start + length + radius);
    const tidy = (slice) => slice.replace(/\s+/g, ' ');
    const nodes = [];
    if (from > 0) nodes.push(ui.el('span', { className: 'dim', textContent: '…' }));
    nodes.push(document.createTextNode(tidy(text.slice(from, start))));
    nodes.push(ui.el('mark', { textContent: tidy(text.slice(start, start + length)) }));
    nodes.push(document.createTextNode(tidy(text.slice(start + length, to))));
    if (to < text.length) nodes.push(ui.el('span', { className: 'dim', textContent: '…' }));
    return nodes;
}

function referenceRow(reference) {
    return ui.el('div', { className: 'fr-ref' }, [
        ui.el('div', { className: 'meta' }, [
            ui.el('span', { className: `fr-badge ${BADGE_CLASS[reference.kind] ?? ''}`, textContent: reference.label }),
            ui.el('span', { className: 'where', textContent: reference.where }),
        ]),
        ui.el('div', { className: 'fr-snip' }, snippetNodes(reference.text, reference.start, reference.length)),
    ]);
}

// Which end of the edge a list is grouped under: the step a reference was
// found in when listing what points here, the referenced symbol when listing
// what this points at. Either way one header, then its references beneath it.
const GROUP_BY_SOURCE = (reference) => ({ symbol: reference.from, name: reference.from.name, path: reference.from.path });
const GROUP_BY_TARGET = (reference) => ({
    symbol: reference.to,
    name: reference.to?.name ?? reference.toName,
    path: reference.to?.path ?? null,
});

/** Groups references by one end, keeping the definition's own order. */
function groupReferences(index, references, pick) {
    const order = new Map(index.symbols.map((symbol, position) => [symbol, position]));
    const groups = new Map();
    for (const reference of references) {
        const head = pick(reference);
        const key = head.symbol ?? head.name;
        const group = groups.get(key) ?? { ...head, list: [] };
        group.list.push(reference);
        groups.set(key, group);
    }
    // Unresolved targets have no place in the flow, so they sort to the end.
    const position = (group) => order.get(group.symbol) ?? Number.MAX_SAFE_INTEGER;
    return [...groups.values()].sort((a, b) => position(a) - position(b));
}

function revealOrCopy(name) {
    if (revealInDesigner(name)) return;
    navigator.clipboard.writeText(name)
        .then(() => ui.toast(`Not on the canvas right now — "${name}" copied instead.`, 4500));
}

function renderReferenceList(container, state, references, { emptyText, pick = GROUP_BY_SOURCE }) {
    container.replaceChildren();
    if (!references.length) {
        container.append(ui.el('div', { className: 'fr-empty', textContent: emptyText }));
        return;
    }
    for (const group of groupReferences(state.index, references, pick)) {
        const header = ui.el('div', { className: 'fr-from' });
        if (group.symbol) {
            const name = ui.el('button', { className: 'name', title: 'Show references for this symbol' });
            name.addEventListener('click', () => openSymbol(state, group.symbol));
            name.append(
                document.createTextNode(`${KIND_ICON[group.symbol.kind] ?? '▸'} ${group.name}`),
                ui.el('span', { className: 'p', textContent: group.path }),
            );
            header.append(name);
            if (group.symbol.kind === 'action') {
                header.append(ui.el('button', {
                    className: 'fr-reveal', textContent: '⌖',
                    title: 'Select this step on the canvas',
                    onclick: () => revealOrCopy(group.symbol.name),
                }));
            }
        } else {
            // A reference to something that is not in the flow at all — a step
            // that was renamed or deleted with the expressions left behind.
            header.append(ui.el('span', { className: 'name broken' }, [
                document.createTextNode(`⚠ ${group.name}`),
                ui.el('span', { className: 'fr-missing', textContent: 'does not exist in this flow' }),
            ]));
        }
        container.append(header, ...group.list.map(referenceRow));
    }
}

/** The symbol list: everything in the flow, with its incoming reference count. */
function renderList(body, state) {
    body.replaceChildren();
    const search = ui.el('input', { className: 'ppt-input', type: 'text', placeholder: 'Filter steps and variables…', value: state.filter });
    const list = ui.el('div', { className: 'fr-scroll' });

    const refresh = () => {
        state.filter = search.value;
        const query = search.value.trim().toLowerCase();
        const matching = state.index.symbols.filter((symbol) =>
            !query || `${symbol.name} ${symbol.path} ${symbol.type}`.toLowerCase().includes(query));

        list.replaceChildren();
        for (const kind of ['trigger', 'action', 'variable']) {
            const group = matching.filter((symbol) => symbol.kind === kind);
            if (!group.length) continue;
            list.append(ui.el('div', { className: 'fr-group-title', textContent: `${KIND_TITLE[kind]} (${group.length})` }));
            for (const symbol of group) {
                const count = state.index.incoming.get(symbol)?.length ?? 0;
                const button = ui.el('button', { className: 'fr-sym', title: symbol.path });
                button.addEventListener('click', () => openSymbol(state, symbol));
                button.append(
                    ui.el('span', { className: 'f' }, [
                        ui.el('span', { className: 'n', textContent: `${KIND_ICON[symbol.kind]} ${symbol.name}` }),
                        ui.el('span', { className: 'p', textContent: symbol.path }),
                    ]),
                    ui.el('span', {
                        className: `fr-count ${count ? 'has' : 'none'}`,
                        textContent: count ? `${count} ref${count > 1 ? 's' : ''}` : '0 refs',
                        title: count ? 'Parsed references to this symbol' : 'Nothing in the saved definition reads this',
                    }),
                );
                list.append(button);
            }
        }
        if (!list.children.length) list.append(ui.el('div', { className: 'fr-empty', textContent: 'Nothing matches' }));
    };

    search.addEventListener('input', refresh);
    body.append(ui.el('div', { className: 'fr-wrap' }, [
        ui.el('div', { className: 'ppt-note', textContent: 'Pick a step to see everything that references it. Read from the saved definition — changes you have not saved are not in here.' }),
        search,
        list,
    ]));
    refresh();
    setTimeout(() => search.focus(), 0);
}

/** One symbol: what references it, and what it references. */
function renderDetail(body, state) {
    body.replaceChildren();
    const { symbol } = state;
    const incoming = state.index.incoming.get(symbol) ?? [];
    const mentions = findTextMentions(state.index, symbol);
    const outgoing = state.index.edges.filter((edge) => edge.from === symbol);

    const head = ui.el('div', { className: 'fr-head' }, [
        ui.el('span', { className: 'f' }, [
            ui.el('div', { className: 'n', textContent: `${KIND_ICON[symbol.kind]} ${symbol.name}` }),
            ui.el('div', { className: 'p', textContent: `${symbol.type || symbol.kind} · ${symbol.path}` }),
        ]),
    ]);
    if (symbol.kind === 'action') {
        head.append(ui.el('button', {
            className: 'fr-back', textContent: '⌖ Canvas',
            title: 'Select this step on the canvas',
            onclick: () => revealOrCopy(symbol.name),
        }));
    }
    head.append(ui.el('button', {
        className: 'fr-back', textContent: '◀ All steps',
        onclick: () => { state.symbol = null; render(state); },
    }));

    const results = ui.el('div', { className: 'fr-scroll' });
    const tabs = [
        {
            label: `Referenced by (${incoming.length + mentions.length})`,
            render: () => renderReferenceList(results, state, [...incoming, ...mentions], {
                emptyText: `Nothing in the saved definition references ${symbol.name}.`,
            }),
        },
        {
            label: `References (${outgoing.length})`,
            render: () => renderReferenceList(results, state, outgoing, {
                emptyText: `${symbol.name} does not reference anything else.`,
                pick: GROUP_BY_TARGET,
            }),
        },
    ];

    const bar = ui.el('div', { className: 'fr-tabs' });
    const buttons = tabs.map((tab, index) => ui.el('button', {
        className: `fr-tab${index === state.tab ? ' on' : ''}`,
        textContent: tab.label,
        onclick: () => {
            state.tab = index;
            buttons.forEach((button, position) => button.classList.toggle('on', position === index));
            tab.render();
        },
    }));
    bar.append(...buttons);

    body.append(ui.el('div', { className: 'fr-wrap' }, [
        head,
        bar,
        results,
        ui.el('button', {
            className: 'ppt-btn', style: 'align-self:flex-start', textContent: '📋 Copy report',
            onclick: () => navigator.clipboard
                .writeText(textReport(symbol, incoming, mentions, outgoing))
                .then(() => ui.toast('📋 Reference report copied')),
        }),
    ]));
    tabs[state.tab].render();
}

function openSymbol(state, symbol) {
    state.symbol = symbol;
    state.tab = 0;
    render(state);
}

function render(state) {
    if (state.symbol) renderDetail(state.body, state);
    else renderList(state.body, state);
}

function textReport(symbol, incoming, mentions, outgoing) {
    const line = (reference) =>
        `  [${reference.label}] ${reference.from.name}  ·  ${reference.where}\n`
        + `      ${reference.text.replace(/\s+/g, ' ').trim().slice(0, 220)}`;

    let report = `=== REFERENCES TO ${symbol.kind.toUpperCase()} "${symbol.name}" ===\n`;
    report += `Location: ${symbol.path}\n\n`;
    report += `REFERENCED BY (${incoming.length})\n`;
    report += incoming.length ? `${incoming.map(line).join('\n')}\n` : '  (nothing)\n';
    if (mentions.length) {
        report += `\nLOOSE TEXT MENTIONS (${mentions.length}) — the name appears in a string that is not an expression\n`;
        report += `${mentions.map(line).join('\n')}\n`;
    }
    report += `\nREFERENCES (${outgoing.length})\n`;
    report += outgoing.length
        ? `${outgoing.map((reference) => `  [${reference.label}] → ${reference.toName}${reference.to ? '' : '  ⚠ does not exist'}  ·  ${reference.where}`).join('\n')}\n`
        : '  (nothing)\n';
    return report;
}

// ── Shell ─────────────────────────────────────────────────────────────────

let openPanel = null;

/**
 * A panel rather than a modal: a backdrop would put the designer canvas out of
 * reach, and jumping from a reference to the step it lives in is half the point.
 */
function show(index, preselected) {
    openPanel?.();
    const state = { index, symbol: preselected ?? null, tab: 0, filter: '', body: null };
    openPanel = ui.panel({
        title: '🔗 Find All References',
        width: 560,
        render: (body) => { state.body = body; render(state); },
        buttons: [
            { label: '↻ Reload', onClick: (close) => { close(); cached = null; run(); } },
            { label: 'Close', onClick: (close) => close() },
        ],
        onClose: () => { openPanel = null; },
    });
}

function showPasteDialog(onDefinition, { orgUrl, error } = {}) {
    const textarea = ui.el('textarea', {
        className: 'fr-json',
        placeholder: 'Paste flow definition JSON here…\n\nAccepts a solution export, an API response with clientdata, or a bare definition.',
    });
    const why = orgUrl ? `${describeLookupFailure(orgUrl, error)} ` : 'The saved definition could not be read for this flow. ';
    ui.modal({
        title: '🔗 Paste flow definition',
        width: 'min(700px, 92vw)',
        render: (body) => {
            body.append(
                ui.el('div', { className: 'ppt-note', textContent: `${why}Paste it to index its references.` }),
                textarea,
            );
            setTimeout(() => textarea.focus(), 0);
        },
        buttons: [
            { label: 'Cancel', onClick: (close) => close() },
            {
                label: 'Index references', primary: true,
                onClick: (close) => {
                    try {
                        const definition = parseFlowDefinitionJson(textarea.value);
                        close();
                        onDefinition(definition);
                    } catch (e) {
                        ui.toast(`❌ ${e.message}`, 4500);
                    }
                },
            },
        ],
    });
}

// The definition only changes when the user saves, and this is a tool you open
// over and over while reading a flow — so it is fetched once per flow and the
// Reload button covers the save.
let cached = null;

async function run() {
    const { flowId, envId } = flowContextFromUrl();

    const start = (definition) => {
        const index = buildIndex(definition);
        if (!index.symbols.length) { ui.toast('This definition has no trigger and no actions.'); return; }
        cached = { flowId, definition };
        const selected = selectedActionName();
        show(index, index.symbols.find((symbol) => symbol.kind === 'action' && symbol.name === selected));
    };

    if (cached?.flowId === flowId && cached.definition) { start(cached.definition); return; }
    if (!flowId) { showPasteDialog(start); return; }

    const orgUrl = await resolveOrgUrl(envId, { detail: `Flow ID: ${flowId}` });
    if (!orgUrl) { showPasteDialog(start); return; }

    ui.toast('Reading the flow definition…');
    try {
        const found = await resolveFlowDefinition(orgUrl, { flowId });
        if (found) start(found.definition);
        else showPasteDialog(start, { orgUrl });
    } catch (e) {
        console.warn('[Find All References] definition fetch failed:', e);
        showPasteDialog(start, { orgUrl, error: e });
    }
}

export default {
    init() {
        ui.addStyle('fr', STYLE);
        commands.register({
            toolId: 'flow-references',
            title: 'Find All References',
            subtitle: 'Shift+F12 — what reads this step, and what it reads',
            icon: '🔗',
            run,
        });
        // The binding every IDE uses for this, and one the browser leaves alone.
        document.addEventListener('keydown', (event) => {
            if (event.key === 'F12' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
                event.preventDefault();
                run();
            }
        });
    },
};
