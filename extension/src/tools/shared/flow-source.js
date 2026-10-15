// Getting at a cloud flow's definition from the maker portal.
//
// The Power Automate portal never puts the Dataverse host in the URL, and the
// flow definition it renders lives in a closed React app. Both flow tools
// therefore take the same route: read `workflows(<flowId>).clientdata` from
// the Dataverse Web API of the environment the flow lives in.
//
// That needs an org URL. It is answered from the Environment Indicator's host
// cache when possible, and otherwise asked once and remembered — in a store
// shared by every flow tool, so nobody is asked twice for the same
// environment.
//
// It also needs the flow's workflowid, and the id in the URL is only sometimes
// that: the solution explorer links a flow by its Dataverse workflowid, while
// "My flows" links the same flow by the Flow service's own id for it, which
// exists nowhere in Dataverse. Run Page Actions hit this too and resolved the
// workflowid from the run record; with no run to read, `resolveFlowDefinition`
// falls back to the flow's name and then to picking it from the environment.

import { createStore } from '../../core/storage.js';
import { HttpError, request } from '../../core/http.js';
import * as ui from '../../core/ui.js';

const store = createStore('org-url');
const envIndicatorStore = createStore('environment-indicator');
// url id → workflowid, for the flows whose two ids differ. See resolveFlowDefinition.
const flowIdStore = createStore('flow-source');

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * flowId + envId as they appear in a make.powerautomate.com URL.
 *
 * The environment id is taken as a whole segment rather than as hex: a default
 * environment is "Default-<tenant guid>", and a hex-only pattern silently
 * truncates that to "Defa" — which then keys the org-URL cache, so every
 * tenant's default environment would share one remembered Dynamics URL.
 */
export function flowContextFromUrl() {
    return {
        flowId: location.href.match(new RegExp(`/flows/(${GUID.source})`, 'i'))?.[1] ?? null,
        envId: location.href.match(/\/environments\/([^/?#]+)/i)?.[1]?.toLowerCase() ?? null,
    };
}

// The designer's own automation id for the editable flow-name heading — the
// same kind of hook as the token picker's, and the only stable one here: the
// classes beside it ("root-484", "editable-486") are generated per build, and
// the aria-label spells the name into a localized sentence.
const FLOW_NAME_LABEL = '[data-automation-id="action_heading_flow_name_label"]';

/** The flow's name from the designer heading, or null when it is not rendered. */
function flowNameFromHeading() {
    const label = document.querySelector(FLOW_NAME_LABEL);
    if (!label) return null;
    // The heading repeats the name in a hidden copy for screen readers and puts
    // a status annotation ("Published") beside it, so take the first leaf that
    // is neither — not the element's whole textContent, which is all three.
    const name = [...label.querySelectorAll('*')]
        .filter((node) => !node.children.length && !node.hasAttribute('hidden') && node.getAttribute('role') !== 'alert')
        .map((node) => node.textContent.trim())
        .find(Boolean);
    return name && name.length <= 200 ? name : null;
}

// A page title is "<something> | Power Automate", and the something is only
// sometimes the flow: the v3 designer titles every flow "Edit your flow". The
// list is what to disbelieve, because looking a placeholder up would either
// find nothing or, worse, find a flow actually named that.
const GENERIC_TITLES = /^(edit your flow|power automate|power apps|flows?|my flows|loading|home)$/i;

/** The flow's name from the heading, else from the page title, else null. */
export function flowNameFromPage() {
    const heading = flowNameFromHeading();
    if (heading) return heading;
    const name = (document.title ?? '').split(/[|–—]| - /)[0].trim();
    return !name || GENERIC_TITLES.test(name) ? null : name;
}

/**
 * The Dynamics 365 URL for an environment, or null if the user skips the
 * prompt. Cached per environment id, so this is asked once and then never
 * again for that environment.
 *
 * `purpose` finishes the prompt's "so …" sentence for callers that are not
 * after a flow definition.
 *
 * `anchor` / `mountInto` are handed to the panel: a caller working inside a
 * host-page popover passes them so this prompt does not dismiss it.
 */
export async function resolveOrgUrl(envId, { detail, anchor, mountInto, purpose = 'the flow definition can be read' } = {}) {
    const known = await knownOrgUrl(envId);
    if (known) return known;

    return new Promise((resolve) => {
        const input = ui.el('input', { className: 'ppt-input', type: 'url', placeholder: 'https://yourorg.crm.dynamics.com' });
        let saved = null;
        const close = ui.panel({
            title: '🔗 Dynamics 365 URL',
            width: 460,
            anchor,
            mountInto,
            render: (body) => {
                body.append(
                    ui.el('div', { className: 'ppt-note', textContent: `Enter the Dynamics 365 URL of this environment so ${purpose}. Remembered locally for next time.` }),
                    input,
                    ...(detail ? [ui.el('div', { className: 'ppt-note', style: 'margin-top:10px', textContent: detail })] : []),
                );
                input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
                setTimeout(() => input.focus(), 0);
            },
            buttons: [
                { label: 'Skip', onClick: (c) => c() },
                { label: 'Continue', primary: true, onClick: () => submit() },
            ],
            onClose: () => resolve(saved),
        });
        async function submit() {
            let url = input.value.trim();
            if (url && !url.startsWith('https://')) url = 'https://' + url;
            if (!/\.dynamics\.com/i.test(url)) { ui.toast('⚠️ Enter a *.dynamics.com URL'); return; }
            saved = url.replace(/\/$/, '').split('/main.aspx')[0];
            await rememberOrgUrl(envId, saved);
            close();
        }
    });
}

/** The Dynamics 365 URL already known for an environment, without asking; or null. */
export async function knownOrgUrl(envId) {
    if (!envId) return null;
    const cache = await store.get('orgUrlCache', {});
    if (cache[envId]) return cache[envId];

    const hostCache = await envIndicatorStore.get('envIndicator_hostCache', {});
    const host = Object.entries(hostCache).find(([, id]) => id === envId)?.[0];
    if (!host) return null;
    await rememberOrgUrl(envId, `https://${host}`);
    return `https://${host}`;
}

/** Remembers an environment's Dynamics 365 URL for every tool that asks for it. */
export async function rememberOrgUrl(envId, orgUrl) {
    if (!envId) return;
    const cache = await store.get('orgUrlCache', {});
    cache[envId] = orgUrl;
    await store.set('orgUrlCache', cache);
}

export async function clearOrgUrlCache() {
    await store.remove('orgUrlCache');
}

const ODATA_HEADERS = { 'Accept': 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' };

/** The `definition` object inside a workflow row's clientdata, or null. */
const definitionFromClientData = (clientdata) =>
    JSON.parse(clientdata || 'null')?.properties?.definition ?? null;

/** The `definition` object of a flow, or null when clientdata holds nothing usable. */
export async function fetchFlowDefinition(orgUrl, flowId) {
    const response = await request({
        url: `${orgUrl}/api/data/v9.2/workflows(${flowId})?$select=clientdata,name`,
        headers: ODATA_HEADERS,
        credentials: true,
    });
    return definitionFromClientData(response.json()?.clientdata);
}

// Cloud flows are workflow rows of category 5. Classic processes and desktop
// flows live in the same table and would only pad the picker.
const MODERN_FLOW = 'category eq 5';

/** A string literal for an OData filter: the only escape is a doubled quote. */
const odataString = (value) => String(value).replace(/'/g, "''");

async function queryFlows(orgUrl, filter, select) {
    const response = await request({
        url: `${orgUrl}/api/data/v9.2/workflows`
            + `?$select=${select}&$filter=${encodeURIComponent(filter)}&$orderby=name%20asc&$top=250`,
        headers: ODATA_HEADERS,
        credentials: true,
    });
    return response.json()?.value ?? [];
}

/** Flows with this exact name, definitions included — usually a single row. */
const flowsNamed = (orgUrl, name) =>
    queryFlows(orgUrl, `${MODERN_FLOW} and name eq '${odataString(name)}'`, 'workflowid,name,clientdata');

/** Every cloud flow in the environment, for the picker. Definitions follow the pick. */
const allFlows = (orgUrl) => queryFlows(orgUrl, MODERN_FLOW, 'workflowid,name');

const PICKER_STYLE = `
    .fs-flows { max-height: 320px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; margin-top: 8px; }
    .fs-flow {
        display: block; width: 100%; text-align: left; font: inherit; font-size: 13px;
        cursor: pointer; padding: 8px 12px; border: none; border-bottom: 1px solid var(--border);
        background: none; color: var(--text);
    }
    .fs-flow:last-child { border-bottom: none; }
    .fs-flow:hover { background: var(--bg2); }
`;

/**
 * Asks which flow to read, with a filter box because an environment can hold
 * hundreds. Resolves to the picked row, or null if the panel is dismissed.
 *
 * `anchor` / `mountInto` are handed to the panel for the same reason
 * `resolveOrgUrl` takes them: a caller inside the designer's token picker
 * cannot afford a panel that dismisses it.
 */
export function chooseFlowDialog(flows, { note, anchor, mountInto } = {}) {
    ui.addStyle('flow-source', PICKER_STYLE);
    return new Promise((resolve) => {
        let picked = null;
        const search = ui.el('input', { className: 'ppt-input', type: 'text', placeholder: 'Type to filter flows…' });
        const list = ui.el('div', { className: 'fs-flows' });

        ui.panel({
            title: '🔗 Which flow?',
            width: 460,
            anchor,
            mountInto,
            render: (body, close) => {
                const refresh = () => {
                    const term = search.value.trim().toLowerCase();
                    const shown = flows.filter((flow) => !term || flow.name.toLowerCase().includes(term));
                    list.replaceChildren(...shown.slice(0, 200).map((flow) => ui.el('button', {
                        className: 'fs-flow',
                        textContent: flow.name,
                        onclick: () => { picked = flow; close(); },
                    })));
                    if (!shown.length) {
                        list.replaceChildren(ui.el('div', { className: 'ppt-note', textContent: 'No matching flows' }));
                    }
                };
                body.append(ui.el('div', { className: 'ppt-note', textContent: note ?? '' }), search, list);
                search.addEventListener('input', refresh);
                refresh();
            },
            buttons: [{ label: 'Cancel', onClick: (close) => close() }],
            onClose: () => resolve(picked),
        });
    });
}

/**
 * The definition of the flow the page is on, resolved around the two id
 * namespaces: by the URL's id, then by the flow's name, then by asking.
 *
 * Returns { definition, name, workflowid, via } or null when nothing matched
 * and nothing was picked. Only a 404 falls through to the next step — no
 * session, no privilege and no network are worth reporting rather than
 * papering over with a picker, so those are thrown.
 */
// The Flow service id in the URL and the Dataverse workflowid are paired by
// whatever resolved the flow once — a name match or the user's pick — and the
// pairing is fixed for the life of the flow, so it is worth keeping. Without
// this the picker would come back on every insert into a "My flows" flow.
const learnedWorkflowId = async (urlId) =>
    (await flowIdStore.get('flowIdCache', {}))[urlId.toLowerCase()] ?? null;

async function learnWorkflowId(urlId, workflowId) {
    const cache = await flowIdStore.get('flowIdCache', {});
    if (workflowId) cache[urlId.toLowerCase()] = workflowId.toLowerCase();
    else delete cache[urlId.toLowerCase()];
    await flowIdStore.set('flowIdCache', cache);
}

export async function resolveFlowDefinition(orgUrl, { flowId, name = flowNameFromPage(), anchor, mountInto } = {}) {
    const definitionById = async (id) => {
        try {
            return await fetchFlowDefinition(orgUrl, id);
        } catch (e) {
            if (!(e instanceof HttpError) || e.status !== 404) throw e;
            return null;
        }
    };

    if (flowId) {
        const definition = await definitionById(flowId);
        if (definition) return { definition, name, workflowid: flowId, via: 'id' };

        // The pairing this page taught us last time. A flow that has since been
        // deleted 404s again, so a stale entry costs one request and is dropped.
        const learned = await learnedWorkflowId(flowId);
        if (learned) {
            const definition = await definitionById(learned);
            if (definition) return { definition, name, workflowid: learned, via: 'remembered' };
            await learnWorkflowId(flowId, null);
        }
    }

    const named = name ? await flowsNamed(orgUrl, name) : [];
    const picked = named.length === 1
        ? named[0]
        : await chooseFlowDialog(named.length ? named : await allFlows(orgUrl), {
            anchor,
            mountInto,
            note: named.length
                ? `Several flows in this environment are called "${name}" — pick the one you are editing.`
                : 'This flow could not be matched by the id in the URL. Pick it from the environment’s cloud flows.',
        });
    if (!picked) return null;

    // The name query carries clientdata; the picker's list deliberately does not.
    const definition = picked.clientdata === undefined
        ? await fetchFlowDefinition(orgUrl, picked.workflowid)
        : definitionFromClientData(picked.clientdata);
    if (!definition) return null;

    // Whatever it took to get here, the pairing is now known: remember it so the
    // designer's own id resolves straight away next time.
    if (flowId && flowId !== picked.workflowid) await learnWorkflowId(flowId, picked.workflowid);

    const via = named.length === 1 ? 'name' : 'picked';
    // Say so when the match was silent: the flow was found under a different id
    // than the URL carries, and a wrong guess here would be worth spotting.
    if (via === 'name') ui.toast(`Matched "${picked.name}" by name — the URL carries the Flow service id.`, 4500);
    return { definition, name: picked.name, workflowid: picked.workflowid, via };
}

/** One line on why a definition could not be read, for the paste dialogs. */
export function describeLookupFailure(orgUrl, error) {
    let host = orgUrl;
    try { host = new URL(orgUrl).hostname; } catch { /* keep whatever was passed */ }
    if (error instanceof HttpError) return `${host} answered HTTP ${error.status} for this flow.`;
    if (error) return `${host} could not be read: ${error.message}`;
    return `No matching flow was found in ${host}.`;
}

/**
 * Unwraps a definition from whatever the user pasted: a solution export, an
 * API response with `clientdata`, or a bare definition.
 * Throws when the result has neither triggers nor actions.
 */
export function parseFlowDefinitionJson(text) {
    let parsed = JSON.parse(text.trim());
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    if (parsed.clientdata) parsed = JSON.parse(parsed.clientdata);
    if (parsed.properties?.definition) parsed = parsed.properties.definition;
    if (parsed.definition) parsed = parsed.definition;
    if (!parsed.triggers && !parsed.actions) throw new Error('Invalid flow definition: missing triggers and actions');
    return parsed;
}

/**
 * Every action in a definition as a flat list, out of the nested
 * scopes/conditions/switches: [{ name, action, path }] where `path` is the
 * chain of containers it sits in.
 */
export function flattenActions(definition) {
    const found = [];

    const visit = (container, path) => {
        if (!container || typeof container !== 'object') return;
        for (const [name, action] of Object.entries(container)) {
            const here = path ? `${path} / ${name}` : name;
            found.push({ name, action, path: here });
            visit(action?.actions, here);
            visit(action?.else?.actions, here);
            visit(action?.default?.actions, here);
            for (const [caseName, caseObj] of Object.entries(action?.cases ?? {})) {
                visit(caseObj?.actions, `${here} / ${caseName}`);
            }
        }
    };

    visit(definition?.actions, '');
    return found;
}

/**
 * Every Dataverse read action in a definition.
 * Returns [{ name, operationId, table, select, expand, filter, path }].
 */
export function findDataverseReadActions(definition) {
    return flattenActions(definition)
        .filter(({ action }) => {
            const host = action?.inputs?.host;
            const isDataverse = /commondataservice/i.test(host?.apiId ?? '')
                || /commondataservice/i.test(host?.connectionName ?? '');
            return isDataverse && /^(ListRecords|GetItem)/.test(host?.operationId ?? '');
        })
        .map(({ name, action, path }) => {
            const parameters = action.inputs.parameters ?? {};
            return {
                name,
                path,
                operationId: action.inputs.host.operationId,
                table: parameters.entityName ?? '',
                select: parameters.$select ?? '',
                expand: parameters.$expand ?? '',
                filter: parameters.$filter ?? '',
            };
        });
}

/** How an action is written inside an expression: spaces become underscores. */
export const expressionName = (name) => name.replace(/ /g, '_');

/**
 * The argument of the first(...) call in an expression, or null.
 * Scanned rather than matched with a regex because the argument nests its own
 * parentheses — `first(body('X')?['value'])` — and a lazy `\(.*\)` would cut
 * it in the wrong place.
 */
function firstCallArgument(text) {
    const call = /\bfirst\s*\(/i.exec(text);
    if (!call) return null;

    const start = call.index + call[0].length;
    let depth = 1;
    let quote = null;
    for (let i = start; i < text.length; i++) {
        const char = text[i];
        if (quote) {
            if (char === quote) quote = null;
        } else if (char === "'" || char === '"') {
            quote = char;
        } else if (char === '(') {
            depth++;
        } else if (char === ')' && --depth === 0) {
            return text.slice(start, i);
        }
    }
    return null;
}

/** The action an expression reads from, e.g. { fn: 'body', action: 'List_rows' }. */
function actionReference(expression) {
    const match = /\b(body|outputs)\s*\(\s*'([^']+)'\s*\)/i.exec(expression);
    return match ? { fn: match[1].toLowerCase(), action: match[2] } : null;
}

/**
 * Compose actions whose input is a first(...) over something — the step people
 * add so that a "List rows" filtered down to a single row stops dragging an
 * Apply to each behind it.
 *
 * Returns [{ name, path, expression, inner, reference }], where `inner` is
 * what the first() unwraps and `reference` is the action that value comes from
 * (null when the expression reads from something else, e.g. a variable).
 */
export function findFirstComposeActions(definition) {
    return flattenActions(definition)
        .filter(({ action }) =>
            action?.type === 'Compose'
            && typeof action.inputs === 'string'
            // "starts with first()" in the forms the designer writes it:
            // a bare @expression, or one wrapped in @{ }.
            && /^@\{?\s*first\s*\(/i.test(action.inputs.trim()))
        .map(({ name, action, path }) => {
            const inner = firstCallArgument(action.inputs) ?? '';
            return {
                name,
                path,
                expression: action.inputs,
                inner,
                reference: actionReference(inner),
            };
        });
}

/** Matches a reference back to one of `actions`, tolerating spaces vs underscores. */
export function matchReferencedAction(reference, actions) {
    if (!reference) return null;
    return actions.find((a) => a.name === reference.action || expressionName(a.name) === reference.action) ?? null;
}
