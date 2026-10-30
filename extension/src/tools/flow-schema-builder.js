// Parse JSON Schema Builder.
//
// Fixes the dead end you hit when a flow needs a record together with its 1:N
// children: "Get row by ID" cannot $expand a collection, so the query has to
// be "List rows" filtered on the primary key — which returns an array, which
// makes the designer wrap everything downstream in an Apply to each. Unwrap it
// with first(...) in a Compose and the loop goes away, but so does all dynamic
// content, because a Compose output has no schema.
//
// Parse JSON is the way back: give it the same JSON and an explicit schema and
// the tokens return, named, with no loop over a single record. Writing that
// schema by hand for an expanded query is miserable, and the "generate from
// sample" button needs a run that has already happened.
//
// So this tool reads the List rows action out of the flow definition, reads
// the tables it touches from Dataverse metadata, and emits the schema — plus a
// copyable expression for every field, for the places a token still will not
// do.

import { Dataverse } from '../core/dataverse.js';
import {
    caretElement,
    describeTarget,
    hideCaretChip,
    insertAtCaret,
    onCaretChange,
    showCaretChip,
    targetKind,
    watchCaret,
} from '../core/caret.js';
import * as ui from '../core/ui.js';
import * as commands from '../core/commands.js';
import {
    describeLookupFailure,
    expressionName,
    findDataverseReadActions,
    findFirstComposeActions,
    flowContextFromUrl,
    matchReferencedAction,
    parseFlowDefinitionJson,
    resolveFlowDefinition,
    resolveOrgUrl,
} from './shared/flow-source.js';
import {
    MetadataCatalog,
    buildRecordSchema,
    escapeLeadingAt,
    expressionFor,
    labelFor,
    wrapAsListBody,
} from './shared/dataverse-schema.js';

const STYLE = `
    .fsb-actions { display: flex; flex-direction: column; gap: 6px; margin-bottom: 6px; }
    .fsb-action {
        display: block; width: 100%; text-align: left; font: inherit; cursor: pointer;
        padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px;
        background: var(--bg); color: var(--text);
    }
    .fsb-action:hover { background: var(--bg2); border-color: var(--accent); }
    .fsb-action .n { font-weight: 600; }
    .fsb-action .q { font-family: Consolas, monospace; font-size: 11px; color: var(--muted); word-break: break-all; margin-top: 3px; }
    .fsb-action .exp { color: var(--accent); }
    .fsb-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 12px; }
    .fsb-tab {
        font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; padding: 8px 14px;
        border: none; background: none; color: var(--muted); border-bottom: 2px solid transparent;
    }
    .fsb-tab.on { color: var(--accent); border-bottom-color: var(--accent); }
    .fsb-json {
        width: 100%; height: 320px; padding: 12px; box-sizing: border-box;
        font-family: Consolas, monospace; font-size: 12px; resize: vertical;
        border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--text);
    }
    .fsb-opts { display: flex; flex-wrap: wrap; gap: 14px; margin: 10px 0; font-size: 13px; }
    .fsb-opt { display: flex; align-items: center; gap: 6px; cursor: pointer; }
    .fsb-content { display: flex; align-items: center; gap: 10px; }
    .fsb-content .c { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
    .fsb-content .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; }
    .fsb-content .ex { font-family: Consolas, monospace; font-size: 12px; color: var(--text); word-break: break-all; }
    .fsb-content .ppt-btn { flex-shrink: 0; padding: 5px 9px; font-size: 13px; }
    .fsb-warn {
        border-left: 3px solid #f7b955; background: #fff4ce; color: #6b4b00;
        padding: 8px 12px; border-radius: 4px; font-size: 12px; margin-bottom: 8px;
    }
    @media (prefers-color-scheme: dark) { .fsb-warn { background: #3a2f10; color: #f5d78b; } }
    /* The tab body fills the panel; only the list itself scrolls. */
    .fsb-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .fsb-panel > .ppt-input, .fsb-panel > .fsb-settings, .fsb-panel > .fsb-scope, .fsb-tabs { flex-shrink: 0; }
    .fsb-scope { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 11px; color: var(--muted); }
    /* display:flex above would otherwise beat the [hidden] attribute. */
    .fsb-scope[hidden] { display: none; }
    .fsb-scope .chip {
        display: inline-flex; align-items: center; gap: 6px; min-width: 0;
        padding: 3px 4px 3px 10px; border-radius: 999px;
        background: var(--accent); color: #fff; font-weight: 600; font-size: 11px;
    }
    .fsb-scope .chip .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fsb-scope .chip .x {
        font: inherit; flex-shrink: 0; cursor: pointer; border: none; border-radius: 999px;
        background: rgba(255, 255, 255, 0.25); color: #fff; line-height: 1; padding: 2px 6px;
    }
    .fsb-scope .chip .x:hover { background: rgba(255, 255, 255, 0.45); }
    /* The schema tab has no inner list, so it scrolls as one ordinary block. */
    .fsb-panel.scroll { display: block; overflow-y: auto; }
    .fsb-fields { flex: 1; min-height: 120px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; }
    .fsb-field {
        display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
        font: inherit; cursor: pointer; padding: 7px 12px; border: none;
        border-bottom: 1px solid var(--border); background: none; color: var(--text);
    }
    .fsb-field:last-child { border-bottom: none; }
    .fsb-field:hover { background: var(--bg2); }
    .fsb-field.active { background: var(--bg2); box-shadow: inset 3px 0 0 var(--accent); }
    .fsb-field .f { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
    .fsb-field .lbl { font-size: 13px; }
    .fsb-field .ex { font-family: Consolas, monospace; font-size: 11px; color: var(--muted); word-break: break-all; }
    .fsb-field .t { font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--muted); flex-shrink: 0; }
    .fsb-field .loop {
        font-size: 10px; color: #8a6d00; flex-shrink: 0; cursor: pointer;
        padding: 2px 5px; border-radius: 3px;
    }
    .fsb-field .loop:hover { background: var(--accent); color: #fff; }
    @media (prefers-color-scheme: dark) { .fsb-field .loop { color: #f5d78b; } }
    .fsb-detected { color: var(--accent); font-weight: 600; }
    .fsb-settings > summary {
        cursor: pointer; list-style: none; display: flex; align-items: center; gap: 6px;
        padding: 6px 10px; margin: 8px 0; font-size: 12px; color: var(--muted);
        background: var(--bg2); border-radius: 6px; white-space: nowrap; overflow: hidden;
    }
    .fsb-settings > summary::-webkit-details-marker { display: none; }
    .fsb-settings > summary::before {
        content: '›'; display: inline-block; flex-shrink: 0; font-size: 14px;
        transition: transform 0.15s ease;
    }
    .fsb-settings[open] > summary::before { transform: rotate(90deg); }
    .fsb-settings > summary .src {
        font-family: Consolas, monospace; overflow: hidden; text-overflow: ellipsis; min-width: 0;
    }
    .fsb-settings > summary .sep { opacity: 0.45; flex-shrink: 0; }
    .fsb-settings .body { padding: 0 2px 6px; }
`;

const CONTENT_HINT = 'Parse JSON → Content';

// The chip is only worth showing where its output can go — a flow being edited.
const onDesignerPage = () => /\/flows\//i.test(location.href);

// The expression flyout dismisses on any click outside itself, and it opens
// over the very field being edited — so the picker has to live inside it.
// These are the designer's own automation ids: not styling, so far less prone
// to churn than the generated class names beside them.
const tokenPickerHeader = () => document.querySelector('[data-automation-id="flow-token-picker-header"]');
const tokenPickerRoot = () => document.querySelector('[data-automation-id="flow-token-picker"]');

let store;
// The last query the user built, so the chip can reopen the field list
// directly instead of walking the whole picker chain again.
let lastSession = null;

// ── Source selection ──────────────────────────────────────────────────────

/**
 * Every dialog in the picker chain, on the same terms as the results panel:
 * non-modal, never taking focus, and rendered inside the expression flyout.
 * A plain modal here dismisses the very editor the fields are destined for —
 * which is why picking a Compose used to close it, while the second attempt
 * (with the query already chosen, so no dialog) worked.
 */
function pickerPanel({ title, width = 460, render, buttons }) {
    return ui.panel({
        title,
        width,
        buttons,
        anchor: () => caretElement()?.getBoundingClientRect() ?? null,
        mountInto: tokenPickerRoot,
        // The panel body does not scroll, so give the content its own scroller.
        render: (body, close) => {
            const scroller = ui.el('div', { className: 'fsb-panel scroll' });
            body.append(scroller);
            render(scroller, close);
        },
    });
}

function showManualQueryDialog(defaults, onSubmit) {
    const table = ui.el('input', { className: 'ppt-input', type: 'text', placeholder: 'accounts', value: defaults.table ?? '' });
    const select = ui.el('input', { className: 'ppt-input', type: 'text', placeholder: 'name,accountnumber (blank = every column)', value: defaults.select ?? '' });
    const expand = ui.el('textarea', {
        className: 'fsb-json', style: 'height:90px',
        placeholder: "contact_customer_accounts($select=fullname,emailaddress1),primarycontactid($select=fullname)",
        value: defaults.expand ?? '',
    });

    pickerPanel({
        title: '🧬 Query to build a schema for',
        width: 560,
        render: (body) => {
            body.append(
                ui.el('div', { className: 'ppt-note', textContent: 'Paste the same values the List rows action uses. Table accepts the entity set name ("accounts") or the logical name ("account").' }),
                ui.el('label', { className: 'ppt-label', textContent: 'Table' }), table,
                ui.el('label', { className: 'ppt-label', textContent: 'Select columns ($select)' }), select,
                ui.el('label', { className: 'ppt-label', textContent: 'Expand query ($expand)' }), expand,
            );
        },
        buttons: [
            { label: 'Cancel', onClick: (close) => close() },
            {
                label: 'Build schema', primary: true,
                onClick: (close) => {
                    if (!table.value.trim()) { ui.toast('⚠️ Enter a table'); return; }
                    close();
                    onSubmit({ table: table.value.trim(), select: select.value.trim(), expand: expand.value.trim() });
                },
            },
        ],
    });
}

function showPasteDefinitionDialog(onDefinition, { orgUrl, error } = {}) {
    const textarea = ui.el('textarea', {
        className: 'fsb-json',
        placeholder: 'Paste flow definition JSON here…\n\nAccepts a solution export, an API response with clientdata, or a bare definition.',
    });
    const why = orgUrl ? `${describeLookupFailure(orgUrl, error)} ` : '';
    pickerPanel({
        title: '🧬 Paste flow definition',
        width: 560,
        render: (body) => {
            body.append(
                ui.el('div', { className: 'ppt-note', textContent: `${why}Paste the definition to pick a List rows action, or cancel and enter the query by hand.` }),
                textarea,
            );
        },
        buttons: [
            { label: 'Cancel', onClick: (close) => close() },
            {
                label: 'Continue', primary: true,
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

/**
 * The primary way in: the flow's own first(...) Compose actions. Picking one
 * fixes both halves of the answer at once — the query to describe (whatever
 * its first() unwraps) and the expression every field is read from.
 */
function showComposePicker(composes, onPick, onQueries, onManual) {
    pickerPanel({
        title: '🧬 Which Compose?',
        render: (body, close) => {
            body.append(ui.el('div', { className: 'ppt-note', textContent: 'Compose actions that unwrap a list with first(). Fields will be read from the one you pick.' }));

            const list = ui.el('div', { className: 'fsb-actions' });
            for (const compose of composes) {
                const button = ui.el('button', {
                    className: 'fsb-action',
                    title: compose.path,
                    onclick: () => { close(); onPick(compose); },
                });
                button.append(ui.el('div', { className: 'n', textContent: compose.name }));
                if (compose.query) {
                    button.append(ui.el('div', { className: 'q exp', textContent: `${compose.query.name} · ${compose.query.table}` }));
                }
                button.append(ui.el('div', { className: 'q', textContent: compose.inner || compose.expression }));
                list.append(button);
            }
            body.append(list);
        },
        buttons: [
            { label: 'Pick a query instead', onClick: (close) => { close(); onQueries(); } },
            { label: 'Enter query manually', onClick: (close) => { close(); onManual(); } },
        ],
    });
}

function showActionPicker(actions, onPick, onManual) {
    pickerPanel({
        title: '🧬 Which query?',
        render: (body, close) => {
            body.append(ui.el('div', { className: 'ppt-note', textContent: 'Dataverse read actions in the saved definition. Unsaved changes in the designer are not included.' }));

            const list = ui.el('div', { className: 'fsb-actions' });
            for (const action of actions) {
                // Action names are unique within a flow, so the containers it
                // sits in are noise in the list — they stay in the tooltip.
                const button = ui.el('button', {
                    className: 'fsb-action',
                    title: action.path,
                    onclick: () => { close(); onPick(action); },
                });
                button.append(
                    ui.el('div', { className: 'n', textContent: `${action.name}  ·  ${action.table}` }),
                    ui.el('div', { className: 'q', textContent: `$select=${action.select || '(all columns)'}` }),
                );
                if (action.expand) {
                    button.append(ui.el('div', { className: 'q exp', textContent: `$expand=${action.expand}` }));
                }
                list.append(button);
            }
            body.append(list);
        },
        buttons: [
            { label: 'Enter query manually', onClick: (close) => { close(); onManual(); } },
        ],
    });
}

// ── Results ───────────────────────────────────────────────────────────────

/**
 * The expression Parse JSON's Content must be set to for the schema as it is
 * currently shaped. Ticking "whole body" wraps the record schema in the
 * `{ value: [...] }` the query actually returned, so the record expression —
 * a first(...), or the Compose that unwraps one — stops matching it and the
 * list body takes over. Null where nothing named that list: a Get row has no
 * list body to parse, and a hand-entered query says nothing about where it ran.
 */
const contentExpressionFor = (state) =>
    (state.wholeBody ? state.listExpression ?? null : state.contentExpression);

/** Half of what gets pasted into Parse JSON, so it copies like the other half. */
function renderContentHint(state) {
    const expression = contentExpressionFor(state);
    if (!expression) {
        return ui.el('div', {
            className: 'ppt-note',
            textContent: `${CONTENT_HINT}: the body of the List rows action this query came from.`,
        });
    }

    return ui.el('div', { className: 'ppt-note fsb-content' }, [
        ui.el('div', { className: 'c' }, [
            ui.el('span', { className: 'lbl', textContent: CONTENT_HINT }),
            ui.el('span', { className: 'ex', textContent: expression }),
        ]),
        ui.el('button', {
            className: 'ppt-btn',
            textContent: '📋',
            title: 'Copy the Content expression',
            onclick: () => navigator.clipboard.writeText(expression)
                .then(() => ui.toast('📋 Content expression copied — paste it into Parse JSON → Content')),
        }),
    ]);
}

function renderSchemaTab(container, state) {
    container.replaceChildren();
    // This tab has no list of its own, so the whole tab is the scroller.
    container.className = 'fsb-panel scroll';
    state.releaseCaret?.();
    state.releaseCaret = null;

    for (const warning of state.warnings) {
        container.append(ui.el('div', { className: 'fsb-warn', textContent: `⚠️ ${warning}` }));
    }

    container.append(renderContentHint(state));

    const annotations = ui.el('input', { type: 'checkbox', checked: state.includeAnnotations });
    const wholeBody = ui.el('input', { type: 'checkbox', checked: state.wholeBody });
    container.append(ui.el('div', { className: 'fsb-opts' }, [
        ui.el('label', { className: 'fsb-opt' }, [annotations, ui.el('span', { textContent: 'Formatted values & lookup annotations' })]),
        ui.el('label', { className: 'fsb-opt' }, [wholeBody, ui.el('span', { textContent: 'Whole List rows body instead of one record' })]),
    ]));

    const json = ui.el('textarea', { className: 'fsb-json', spellcheck: false });
    // Escaped on the way out, not on the way in: the schema itself describes
    // real property names, and only the designer needs the doubled "@".
    json.value = JSON.stringify(
        escapeLeadingAt(state.wholeBody ? wrapAsListBody(state.recordSchema) : state.recordSchema), null, 2);
    container.append(json);
    container.append(ui.el('div', { className: 'ppt-note', style: 'margin-top:8px', textContent:
        '"@@odata.etag" is not a typo. A leading @ marks an expression in the designer, so it is escaped by '
        + 'doubling — Power Automate reads it back as "@odata.etag". Un-doubling it makes the flow refuse to publish.' }));
    container.append(ui.el('button', {
        className: 'ppt-btn primary', style: 'margin-top:10px',
        textContent: '📋 Copy schema',
        onclick: () => navigator.clipboard.writeText(json.value).then(() => ui.toast('📋 Schema copied — paste it into Parse JSON')),
    }));

    wholeBody.addEventListener('change', () => {
        state.wholeBody = wholeBody.checked;
        renderSchemaTab(container, state);
    });
    annotations.addEventListener('change', () => {
        state.includeAnnotations = annotations.checked;
        state.onRebuild();
    });
}

/** What actually gets written: a token the designer evaluates, or the raw expression. */
const insertionText = (expression, wrap) => (wrap ? `@{${expression}}` : expression);

/**
 * Whether to wrap in @{ }.
 *
 * The inline token editors need it — that is what turns the text into a
 * dynamic-content pill. The expression flyout does not: everything typed there
 * is already an expression, so braces would be part of the value. That flyout
 * is a plain <textarea> while the inline editors are contenteditable, which is
 * the difference this reads. `wrapToken` overrides it once the user decides.
 */
const effectiveWrap = (state) =>
    (state.wrapToken === 'auto' ? targetKind() !== 'textarea' : state.wrapToken);

function renderFieldsTab(container, state) {
    container.replaceChildren();
    // Filter and summary stay put; the list below them takes the leftover
    // height and is the only thing that scrolls.
    container.className = 'fsb-panel';
    state.releaseCaret?.();

    const source = ui.el('input', { className: 'ppt-input', type: 'text', value: state.sourceExpression });
    const search = ui.el('input', { className: 'ppt-input', type: 'text', placeholder: 'Type to filter fields…' });
    const scopeBar = ui.el('div', { className: 'fsb-scope', hidden: true });
    const list = ui.el('div', { className: 'fsb-fields' });
    const wrap = ui.el('input', { type: 'checkbox', checked: effectiveWrap(state) });

    // Everything that is not the field list collapses to one line: this panel
    // gets opened dozens of times a session, and the settings only change once.
    const settings = ui.el('details', { className: 'fsb-settings' });
    const summary = ui.el('summary');

    let visible = [];
    let active = 0;

    const insertRow = (row) => {
        if (!row) return;
        const text = insertionText(expressionFor(row, source.value.trim()), effectiveWrap(state));
        if (insertAtCaret(text)) { ui.toast(`⌖ ${labelFor(row)}`); return; }
        navigator.clipboard.writeText(text)
            .then(() => ui.toast(`📋 ${labelFor(row)} — copied, no field was focused`));
    };

    const showTarget = (name) => {
        const wrapping = effectiveWrap(state);
        wrap.checked = wrapping;
        summary.replaceChildren(
            name
                ? ui.el('span', { className: 'fsb-detected', textContent: `⌖ ${name}` })
                : ui.el('span', { textContent: '⌖ no field focused — copies instead' }),
            ui.el('span', { className: 'sep', textContent: '·' }),
            ui.el('span', { textContent: `${wrapping ? '@{ }' : 'raw'}${state.wrapToken === 'auto' ? ' (auto)' : ''}` }),
            ui.el('span', { className: 'sep', textContent: '·' }),
            ui.el('span', { className: 'src', textContent: state.sourceExpression }),
        );
    };

    /**
     * Sets the filter text, keeping the caret at the end.
     *
     * The value is written while the box is unfocused, which leaves its caret
     * at 0 — so if focus later lands in the box, a Backspace typed straight
     * into it would delete nothing at all.
     */
    const setFilter = (value) => {
        search.value = value;
        search.setSelectionRange?.(value.length, value.length);
    };

    /**
     * Everything a row can be found by: its display name, its logical path,
     * and the collections it sits under — both their display names and their
     * navigation properties. Without the last of those, a field inside an
     * expanded collection is only reachable by its own name, so the whole
     * group is unfindable by the name the list actually badges it with.
     */
    const haystack = (row) => [
        labelFor(row),
        row.path.join('.'),
        (row.arrayLabels ?? []).join(' '),
        (row.arrayPath ?? []).join('.'),
    ].join(' ').toLowerCase();

    /**
     * Whether a row sits under the pinned collection.
     *
     * Kept separate from the search text on purpose: the same column name
     * recurs across expanded tables, so narrowing to one of them has to leave
     * the whole filter box free to name the column. Matching is by navigation
     * path rather than by label, because two relationships can display the
     * same name. Anything nested below counts as inside, so the badge on a
     * deeper row is still there to narrow further.
     */
    const inScope = (row) => {
        if (!state.scopePath) return true;
        const path = (row.arrayPath ?? []).join('.');
        return path === state.scopePath || path.startsWith(state.scopePath + '.');
    };

    const renderScope = () => {
        scopeBar.hidden = !state.scopePath;
        search.placeholder = state.scopePath
            ? `Type to filter inside ${state.scopeLabels.at(-1)}…`
            : 'Type to filter fields…';
        if (!state.scopePath) { scopeBar.replaceChildren(); return; }

        const name = state.scopeLabels.join(' → ');
        scopeBar.replaceChildren(
            ui.el('span', { className: 'chip', title: `Showing only fields in ${name}` }, [
                ui.el('span', { className: 'n', textContent: `in ${name}` }),
                ui.el('button', {
                    className: 'x', textContent: '✕',
                    title: 'Show every field again (or Backspace on an empty filter)',
                    onclick: () => clearScope(),
                }),
            ]),
            ui.el('span', { textContent: 'the filter above searches inside it' }),
        );
    };

    const setScope = (row) => {
        state.scopePath = (row.arrayPath ?? []).join('.');
        state.scopeLabels = row.arrayLabels?.length ? [...row.arrayLabels] : [row.arrayLabel];
        active = 0;
        renderScope();
        refresh();
    };

    const clearScope = () => {
        state.scopePath = null;
        state.scopeLabels = [];
        active = 0;
        renderScope();
        refresh();
    };

    const refresh = () => {
        // Terms are ANDed, so several words all have to match.
        const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        visible = state.fields
            .filter((row) => {
                if (!inScope(row)) return false;
                if (!terms.length) return true;
                const hay = haystack(row);
                return terms.every((term) => hay.includes(term));
            })
            .slice(0, 500);
        active = Math.max(0, Math.min(active, visible.length - 1));

        list.replaceChildren(...visible.map((row, index) => {
            const text = insertionText(expressionFor(row, source.value.trim()), effectiveWrap(state));
            const button = ui.el('button', {
                className: `fsb-field${index === active ? ' active' : ''}`,
                title: text,
                onclick: () => insertRow(row),
            });
            button.append(ui.el('span', { className: 'f' }, [
                ui.el('span', { className: 'lbl', textContent: labelFor(row) }),
                ui.el('span', { className: 'ex', textContent: text }),
            ]));
            if (row.arrayLabel) {
                button.append(ui.el('span', {
                    className: 'loop',
                    textContent: `in ${row.arrayLabel}`,
                    title: `Show only fields in ${(row.arrayLabels ?? [row.arrayLabel]).join(' → ')}`,
                    onclick: (event) => {
                        // The row itself inserts on click, and this sits inside it.
                        event.stopPropagation();
                        setScope(row);
                    },
                }));
            }
            button.append(ui.el('span', { className: 't', textContent: row.type }));
            return button;
        }));
        if (!visible.length) {
            list.replaceChildren(ui.el('div', {
                className: 'ppt-note',
                textContent: state.scopePath
                    ? `No matching fields in ${state.scopeLabels.at(-1)}`
                    : 'No matching fields',
            }));
        }
        revealActive();
    };

    /**
     * Keeps the highlighted row in view by scrolling ONLY our own list.
     *
     * Deliberately not scrollIntoView: that scrolls every scrollable ancestor,
     * and this panel sits inside the designer's token picker — which dismisses
     * itself on scroll. Opening the panel was therefore telling the picker to
     * close, from inside our own render.
     */
    function revealActive() {
        const row = list.children[active];
        if (!row?.getBoundingClientRect) return;
        const rowBox = row.getBoundingClientRect();
        const listBox = list.getBoundingClientRect();
        if (rowBox.top < listBox.top) list.scrollTop -= listBox.top - rowBox.top;
        else if (rowBox.bottom > listBox.bottom) list.scrollTop += rowBox.bottom - listBox.bottom;
    }

    /**
     * The panel deliberately never takes focus, so keystrokes are read from a
     * document-level listener and swallowed before the page sees them — the
     * field being written into keeps its caret and its popover stays open.
     */
    state.handleKey = (event) => {
        // Unless the user has clicked into one of our own boxes, in which case
        // it behaves like an ordinary input. Asked of our own shadow root
        // rather than document.activeElement, which only ever names the host.
        if (search.getRootNode?.()?.activeElement) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;

        if (event.key === 'ArrowDown') active = Math.min(active + 1, visible.length - 1);
        else if (event.key === 'ArrowUp') active = Math.max(active - 1, 0);
        else if (event.key === 'Enter') { insertRow(visible[active]); event.preventDefault(); event.stopPropagation(); return; }
        else if (event.key === 'Backspace') {
            // The box empties first, then the pin — the order they were set in.
            if (!search.value && state.scopePath) {
                clearScope();
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            setFilter(search.value.slice(0, -1));
            active = 0;
        }
        else if (event.key.length === 1) { setFilter(search.value + event.key); active = 0; }
        else return;

        event.preventDefault();
        event.stopPropagation();
        refresh();
    };

    const body = ui.el('div', { className: 'body' });
    body.append(ui.el('div', { className: 'ppt-note', textContent: 'Click a field to drop it where your cursor is. Fields marked with a collection only resolve inside an Apply to each over it, so those use item(). Click that mark to pin the list to that collection — the filter box then searches inside it, so a column name that recurs across tables finds the one you want. Several words all have to match.' }));
    if (state.sourceNote) {
        const detected = ui.el('div', { className: 'ppt-note' });
        detected.append(ui.el('span', { className: 'fsb-detected', textContent: '✓ ' }), document.createTextNode(state.sourceNote));
        body.append(detected);
    }
    body.append(
        ui.el('div', { className: 'fsb-opts' }, [
            ui.el('label', { className: 'fsb-opt' }, [wrap, ui.el('span', { textContent: 'Insert as @{ } token' })]),
        ]),
        ui.el('label', { className: 'ppt-label', textContent: 'Source expression' }), source,
    );
    settings.append(summary, body);

    container.append(search, scopeBar, settings, list);

    source.addEventListener('input', () => {
        state.sourceExpression = source.value;
        showTarget(describeTarget());
        refresh();
    });
    search.addEventListener('input', () => { active = 0; refresh(); });
    wrap.addEventListener('change', () => {
        // An explicit choice replaces the automatic one for the rest of the session.
        state.wrapToken = wrap.checked;
        showTarget(describeTarget());
        refresh();
    });

    // Inserting focuses the page field again, so the indicator follows along
    // and consecutive picks land one after another.
    showTarget(describeTarget());
    state.releaseCaret = onCaretChange(showTarget);
    renderScope();
    refresh();
}

function showResults(state) {
    // A panel rather than a modal, and anchored beside the field: the
    // expression flyout is light-dismiss, so a backdrop or a stolen focus
    // would close the very thing the user is inserting into.
    // Kept so a rebuild (toggling annotations) replaces this panel instead of
    // opening a second one on top of it.
    state.close = ui.panel({
        title: `🧬 ${state.table.LogicalName} schema`,
        width: 460,
        anchor: () => caretElement()?.getBoundingClientRect() ?? null,
        mountInto: tokenPickerRoot,
        onKey: (event) => state.handleKey?.(event),
        render: (body) => {
            const panel = ui.el('div', { className: 'fsb-panel' });
            const tabs = [
                { label: `Fields (${state.fields.length})`, render: renderFieldsTab },
                { label: 'Parse JSON schema', render: renderSchemaTab },
            ];
            const bar = ui.el('div', { className: 'fsb-tabs' });
            const buttons = tabs.map((tab, index) => ui.el('button', {
                className: `fsb-tab${index === state.tab ? ' on' : ''}`,
                textContent: tab.label,
                onclick: () => {
                    state.tab = index;
                    buttons.forEach((b, i) => b.classList.toggle('on', i === index));
                    tabs[index].render(panel, state);
                },
            }));
            bar.append(...buttons);
            body.append(bar, panel);
            tabs[state.tab].render(panel, state);
        },
        buttons: [
            { label: 'Change query', onClick: (close) => { close(); lastSession = null; runBuilder(); } },
            { label: 'Close', onClick: (close) => close() },
        ],
        onClose: () => { state.releaseCaret?.(); state.releaseCaret = null; },
    });
}

// ── Entry point ───────────────────────────────────────────────────────────

async function buildAndShow(catalog, query, source) {
    const { contentExpression, listExpression = null, sourceExpression, sourceNote } = source;
    // 'auto' reads the target: a token for the inline editors, a bare
    // expression inside the fx flyout. See effectiveWrap.
    const { tab = 0, includeAnnotations = true, wholeBody = false, wrapToken = 'auto' } = source;
    const { scopePath = null, scopeLabels = [] } = source;

    ui.toast('Reading table metadata…');
    const { schema, table, warnings, fields } = await buildRecordSchema(catalog, { ...query, includeAnnotations });

    const state = {
        recordSchema: schema,
        table, warnings, fields,
        contentExpression, listExpression, sourceExpression, sourceNote,
        tab, includeAnnotations, wholeBody, wrapToken,
        scopePath, scopeLabels,
        onRebuild: () => {
            state.close?.();
            buildAndShow(catalog, query, {
                contentExpression, listExpression, sourceNote,
                sourceExpression: state.sourceExpression,
                tab: state.tab, includeAnnotations: state.includeAnnotations,
                wholeBody: state.wholeBody, wrapToken: state.wrapToken,
                scopePath: state.scopePath, scopeLabels: state.scopeLabels,
            }).catch((e) => ui.toast(`❌ ${e.message}`, 6000));
        },
    };
    showResults(state);
}

async function runBuilder() {
    const { flowId, envId } = flowContextFromUrl();

    // Metadata is the whole point of the tool, so the org URL is not optional.
    const orgUrl = await resolveOrgUrl(envId, {
        detail: flowId ? `Flow ID: ${flowId}` : undefined,
        anchor: () => caretElement()?.getBoundingClientRect() ?? null,
        mountInto: tokenPickerRoot,
    });
    if (!orgUrl) { ui.toast('Cancelled — a Dynamics 365 URL is needed to read table metadata.'); return; }

    const catalog = new MetadataCatalog(new Dataverse(orgUrl));

    const build = (query, source) => {
        lastSession = { catalog, query, source };
        buildAndShow(catalog, query, source).catch((e) => ui.toast(`❌ ${e.message}`, 6000));
    };

    const manual = async (source = {}) => {
        const last = await store.get('lastQuery', {});
        showManualQueryDialog(last, (query) => {
            store.set('lastQuery', query);
            build(query, {
                contentExpression: source.sourceExpression ?? "outputs('Compose')",
                sourceExpression: source.sourceExpression ?? "outputs('Compose')",
                sourceNote: source.sourceNote,
            });
        });
    };

    const queryOf = (action) => ({ table: action.table, select: action.select, expand: action.expand });

    // Picking a query on its own leaves the source expression a guess, because
    // nothing in the definition says which step will read it.
    const fromQuery = (actions) => {
        if (!actions.length) {
            ui.toast('No Dataverse List rows / Get row actions in the saved definition.');
            manual();
            return;
        }
        showActionPicker(actions, (action) => {
            const reference = `body('${expressionName(action.name)}')`;
            const isList = action.operationId.startsWith('ListRecords');
            build(queryOf(action), {
                contentExpression: isList ? `first(${reference}?['value'])` : reference,
                listExpression: isList ? reference : null,
                sourceExpression: "outputs('Compose')",
            });
        }, manual);
    };

    const fromDefinition = (definition) => {
        const actions = findDataverseReadActions(definition);
        const composes = findFirstComposeActions(definition).map((compose) => ({
            ...compose,
            query: matchReferencedAction(compose.reference, actions),
        }));

        if (!composes.length) {
            if (!actions.length) {
                ui.toast('No first() Compose and no Dataverse queries in the saved definition.');
                manual();
                return;
            }
            ui.toast('No Compose using first() found — pick the query instead.', 4500);
            fromQuery(actions);
            return;
        }

        showComposePicker(composes, (compose) => {
            // The picked Compose IS what downstream steps reference, so the
            // source expression is settled rather than inferred.
            const sourceExpression = `outputs('${expressionName(compose.name)}')`;
            if (!compose.query) {
                ui.toast(`"${compose.name}" does not unwrap a Dataverse query — describe it by hand.`, 5000);
                manual({ sourceExpression, sourceNote: `Fields are read from the Compose "${compose.name}".` });
                return;
            }
            build(queryOf(compose.query), {
                contentExpression: sourceExpression,
                // The Compose unwraps one record out of this query, so parsing
                // the whole body means going back to the query it unwrapped.
                listExpression: compose.query.operationId.startsWith('ListRecords')
                    ? `body('${expressionName(compose.query.name)}')`
                    : null,
                sourceExpression,
                sourceNote: `Fields are read from the Compose "${compose.name}", which unwraps "${compose.query.name}".`,
            });
        }, () => fromQuery(actions), manual);
    };

    // No id in the URL means this is not a saved flow (a brand new one, say),
    // so there is nothing to look up under any of its names.
    if (!flowId) { manual(); return; }

    ui.toast('Reading the flow definition…');
    try {
        const found = await resolveFlowDefinition(orgUrl, {
            flowId,
            anchor: () => caretElement()?.getBoundingClientRect() ?? null,
            mountInto: tokenPickerRoot,
        });
        if (found) fromDefinition(found.definition);
        else showPasteDefinitionDialog(fromDefinition, { orgUrl });
    } catch (e) {
        console.warn('[Schema Builder] definition fetch failed:', e);
        showPasteDefinitionDialog(fromDefinition, { orgUrl, error: e });
    }
}

/**
 * What the in-designer chip opens. Once a query has been built, it goes
 * straight back to the field list — walking the picker chain again for every
 * insert would defeat the point of having the chip at all.
 */
function openFieldPicker() {
    if (!lastSession) { runBuilder(); return; }
    const { catalog, query, source } = lastSession;
    buildAndShow(catalog, query, source).catch((e) => ui.toast(`❌ ${e.message}`, 6000));
}

// Off until asked for: a button that follows every input you touch is only
// welcome while you are actually inserting fields.
const CHIP_DEFAULT = false;

let chipCommand;

async function applyChipSetting() {
    const enabled = await store.get('showChip', CHIP_DEFAULT);
    if (chipCommand) chipCommand.title = `Field button in the designer: ${enabled ? 'on' : 'off'}`;

    if (enabled) {
        showCaretChip({
            label: '🧬',
            title: 'Insert a Dataverse field (Power Platform Easy Mode)',
            when: onDesignerPage,
            dock: tokenPickerHeader,
            onActivate: openFieldPicker,
        });
    } else {
        hideCaretChip();
    }
    return enabled;
}

export default {
    init({ store: toolStore }) {
        store = toolStore;
        ui.addStyle('fsb', STYLE);
        // Started up front, not when the dialog opens: by then the field the
        // user wants to write into has already lost focus.
        watchCaret();

        // One entry only: the switch. Everything else is reached from the
        // in-designer button, where the cursor already is.
        chipCommand = commands.register({
            toolId: 'flow-schema-builder',
            title: 'Field button in the designer: off',
            icon: '⌖', svg: 'toggleRight',
            kind: 'setting',
            run: async () => {
                await store.set('showChip', !(await store.get('showChip', CHIP_DEFAULT)));
                ui.toast(await applyChipSetting()
                    ? '⌖ Field button on — it will appear next to any input you click into.'
                    : '⌖ Field button off.', 4500);
            },
        });

        // After registering, so the command title reports the stored state.
        applyChipSetting();
    },
};
