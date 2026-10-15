// Jira Clockify Timer (native).
// One-click start/stop of a Clockify timer from any Jira Cloud issue, with an
// optional per-site Clockify project and an optional per-site Jira status to
// move the issue into when the timer starts. The Clockify API key is stored
// locally and only ever sent to api.clockify.me; Jira is called same-origin on
// the user's own session cookies — the tool never holds a Jira token.

import { request, HttpError } from '../core/http.js';
import * as ui from '../core/ui.js';
import * as commands from '../core/commands.js';

const API = 'https://api.clockify.me/api/v1';

// ── Status routing ──────────────────────────────────────────────────────────
// At module scope, and free of the DOM, so scripts/jira-status-route-test.mjs
// can walk workflows that are tedious to set up by hand in a real project.

export const MAX_HOPS = 3;

// Status ids are stable per site, names are what the user recognises — match
// on either so a renamed status still resolves.
export const isTargetStatus = (status, target) => !!status && !!target && (
    status.id === target.id
    || status.name?.toLowerCase() === target.name?.toLowerCase()
);

export const routeKeyOf = (issueKey, fromId, targetId) => `${issueKey.split('-')[0]}/${fromId}>${targetId}`;

/**
 * Move an issue to `target`, one transition at a time.
 *
 * Jira lists only the transitions out of the status an issue is in right now,
 * and the workflow-graph endpoints need admin rights, so a route such as
 * Backlog → Ready → In Progress cannot be planned up front — it has to be
 * walked. Steps already known from `routes` are taken silently; anything else
 * goes to `chooseHop`, whose answer the caller can persist so the next start
 * asks nothing.
 *
 * Resolves { outcome, from, at, walked, route } where outcome is one of
 * 'already' (nothing to do), 'moved', 'stopped' (the hop was declined) or
 * 'exhausted' (MAX_HOPS spent without arriving). `at` is where the issue ended
 * up, so callers can say so honestly.
 */
export async function walkToStatus({ key, target, routes = {}, getStatus, getTransitions, transition, chooseHop }) {
    const from = await getStatus(key);
    if (isTargetStatus(from, target)) return { outcome: 'already', from, at: from, walked: [] };

    const remembered = from?.id ? routes[routeKeyOf(key, from.id, target.id)] : null;
    const walked = [];
    let at = from;

    for (let hop = 0; hop < MAX_HOPS; hop++) {
        const transitions = await getTransitions(key);

        const direct = transitions.find((t) => isTargetStatus(t.to, target));
        if (direct) {
            await transition(key, direct);
            return {
                outcome: 'moved',
                from,
                at: direct.to ?? target,
                walked,
                // Only a route that took a detour is worth remembering.
                route: walked.length && from?.id
                    ? { key: routeKeyOf(key, from.id, target.id), hops: walked.map((status) => status.id) }
                    : null,
            };
        }

        const nextId = remembered?.[hop];
        const next = (nextId && transitions.find((t) => t.to?.id === nextId))
            || await chooseHop({ key, at, target, transitions });
        if (!next) return { outcome: 'stopped', from, at, walked };

        await transition(key, next);
        at = next.to;
        walked.push(at);
    }

    return { outcome: 'exhausted', from, at, walked };
}

export default {
    async init({ store }) {
        const config = {
            apiKey: await store.get('clockify_api_key', ''),
            workspaceId: await store.get('clockify_workspace_id', ''),
            userId: await store.get('clockify_user_id', ''),
            projectMappings: await store.get('clockify_project_mappings', {}),
            statusMappings: await store.get('jira_status_mappings', {}),
            statusRoutes: await store.get('jira_status_routes', {}),
        };

        const subdomain = location.hostname.match(/^([^.]+)\.atlassian\.net$/)?.[1] ?? null;
        const projectForSite = () => (subdomain && config.projectMappings[subdomain]) || null;
        const statusForSite = () => {
            const saved = subdomain && config.statusMappings[subdomain];
            return saved?.id ? saved : null;
        };
        // `false` is stored for "leave it alone", so a declined prompt is
        // remembered as a decision rather than asked again on the next start.
        const statusDecided = () => !!subdomain && subdomain in config.statusMappings;

        // ── Clockify API ─────────────────────────────────────────────────
        async function api(method, endpoint, body) {
            try {
                const response = await request({
                    url: API + endpoint,
                    method,
                    headers: { 'X-Api-Key': config.apiKey, 'Content-Type': 'application/json' },
                    body: body ? JSON.stringify(body) : null,
                });
                return response.json();
            } catch (e) {
                if (e instanceof HttpError) {
                    let message;
                    try { message = JSON.parse(e.body)?.message; } catch { /* not json */ }
                    const err = new Error(message ?? e.message);
                    err.status = e.status;
                    throw err;
                }
                throw e;
            }
        }

        async function ensureUserId() {
            if (!config.userId) {
                config.userId = (await api('GET', '/user')).id;
                await store.set('clockify_user_id', config.userId);
            }
            return config.userId;
        }

        async function getRunningTimer() {
            const userId = await ensureUserId();
            const entries = await api('GET',
                `/workspaces/${config.workspaceId}/user/${userId}/time-entries?in-progress=true`);
            return entries?.[0] ?? null;
        }

        function startTimer(description) {
            const body = { start: new Date().toISOString(), description, billable: true };
            const project = projectForSite();
            if (project) body.projectId = project.id;
            return api('POST', `/workspaces/${config.workspaceId}/time-entries`, body);
        }

        async function stopTimer() {
            const userId = await ensureUserId();
            return api('PATCH', `/workspaces/${config.workspaceId}/user/${userId}/time-entries`,
                { end: new Date().toISOString() });
        }

        // ── Jira API ─────────────────────────────────────────────────────
        // Same-origin: the call rides the session cookies the user already has
        // on this Jira site, so there is no Jira token to store or leak.
        async function jira(method, endpoint, body) {
            try {
                const response = await request({
                    url: endpoint,
                    method,
                    headers: {
                        Accept: 'application/json',
                        'Content-Type': 'application/json',
                        // Jira rejects cookie-authenticated writes without it.
                        'X-Atlassian-Token': 'no-check',
                    },
                    body: body ? JSON.stringify(body) : null,
                });
                return response.json();
            } catch (e) {
                if (e instanceof HttpError) {
                    let message;
                    try {
                        const parsed = JSON.parse(e.body);
                        message = parsed?.errorMessages?.join(' ')
                            || Object.values(parsed?.errors ?? {}).join(' ')
                            || undefined;
                    } catch { /* not json */ }
                    const err = new Error(message ?? e.message);
                    err.status = e.status;
                    throw err;
                }
                throw e;
            }
        }

        const getCurrentStatus = (key) =>
            jira('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=status`)
                .then((issue) => issue?.fields?.status ?? null);

        // Both checks come off one read — asking for two fields costs no more
        // than asking for one.
        const getIssueState = (key) =>
            jira('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=status,assignee`)
                .then((issue) => ({
                    status: issue?.fields?.status ?? null,
                    assignee: issue?.fields?.assignee ?? null,
                }));

        // Whoever the browser session is on this site — the "me" in "assign to
        // me". Cached as the promise so parallel callers share one request, and
        // dropped on failure so a flaky call is not remembered as the answer.
        let myselfPromise = null;
        const getMyself = () => {
            myselfPromise ??= jira('GET', '/rest/api/3/myself')
                .catch((e) => { myselfPromise = null; throw e; });
            return myselfPromise;
        };

        const assignToMe = (key, accountId) =>
            jira('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, { accountId });

        const getTransitions = (key) =>
            jira('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`)
                .then((data) => data?.transitions ?? []);

        const projectKey = (key) => key.split('-')[0];

        // Every status in the project, not just the ones reachable in one step —
        // otherwise a Backlog issue could never be pointed at In Progress.
        const getProjectStatuses = (key) =>
            jira('GET', `/rest/api/3/project/${encodeURIComponent(projectKey(key))}/statuses`)
                .then((types) => (types ?? []).flatMap((type) => type.statuses ?? []));

        // statusCategory.colorName names the category, not a literal colour —
        // Jira reports "yellow" for In Progress and then paints that lozenge
        // blue — so these follow what Jira renders, in mid-tones that stay
        // legible against both the light and dark dialog backgrounds.
        const STATUS_COLORS = {
            'blue-gray': '#7A869A',   // To Do
            'medium-gray': '#7A869A', // no category
            yellow: '#2684FF',        // In Progress
            green: '#22A06B',         // Done
            brown: '#B65C02',
        };
        const statusColor = (colorName) => STATUS_COLORS[colorName] ?? '#7A869A';
        const statusDot = (colorName, className) => ui.el('span', {
            className: className ?? '',
            textContent: '●',
            style: `color:${statusColor(colorName)}`,
        });

        const applyTransition = (key, transition) =>
            jira('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
                { transition: { id: String(transition.id) } });

        // Resolves with the transition to take, or null to stop where we are.
        function chooseHop({ key, at, target, transitions }) {
            return new Promise((resolve) => {
                let picked = null;
                ui.modal({
                    title: `Route to ${target.name}`,
                    onClose: () => resolve(picked),
                    render: (body, close) => {
                        body.append(ui.el('div', { className: 'ppt-note' }, [
                            document.createTextNode(`${key} is at `),
                            statusDot(at?.statusCategory?.colorName),
                            document.createTextNode(` ${at?.name ?? 'an unknown status'}, and ${target.name} is not reachable from there in one step. Pick the status to go through — the route is remembered, so this is asked once.`),
                        ]));

                        const seen = new Set();
                        const items = [];
                        for (const transition of transitions) {
                            if (!transition.to?.id || seen.has(transition.to.id)) continue;
                            if (isTargetStatus(transition.to, at)) continue; // goes nowhere
                            seen.add(transition.to.id);
                            items.push(ui.el('button', {
                                className: 'ppt-palette-item',
                                onclick: () => { picked = transition; close(); },
                            }, [
                                statusDot(transition.to.statusCategory?.colorName, 'icon'),
                                ui.el('span', { textContent: transition.to.name }),
                            ]));
                        }

                        body.append(
                            ui.el('div', { className: 'ppt-palette-list' }, items.length ? items : [
                                ui.el('div', { className: 'ppt-note', textContent: `No transitions available from ${at?.name ?? 'here'}.` }),
                            ]),
                            ui.el('button', {
                                className: 'ppt-btn danger', style: 'margin-top:10px',
                                textContent: `Stay at ${at?.name ?? 'the current status'}`,
                                onclick: close,
                            }),
                        );
                    },
                });
            });
        }

        // Jira renders the status lozenge and the assignee from the SPA's own
        // cache, which a REST write never touches — both keep showing the old
        // value until the issue is re-fetched, so a reload is what makes the
        // change visible.
        // Skipped while the user is typing: a half-written comment is worth more
        // than a fresh lozenge, and the toast already said what happened.
        function reloadIssue(key) {
            const editing = () => {
                const node = document.activeElement;
                return !!node && (node.isContentEditable || node.tagName === 'INPUT' || node.tagName === 'TEXTAREA');
            };
            if (editing()) return;
            // Long enough for the toast to be read, short enough to feel like
            // part of the same action.
            setTimeout(() => {
                if (editing() || getIssueKey() !== key) return;
                location.reload();
            }, 1500);
        }

        const NOTHING = { status: false, assignee: false };

        // One dialog for everything a start should line up in Jira. It lists only
        // what is actually off, pre-ticked, and resolves to what the user agreed
        // to — dismissing it agrees to nothing.
        function confirmStartActions({ key, state, target, me }) {
            return new Promise((resolve) => {
                const rows = [];
                const row = (title, subtitle) => {
                    const box = ui.el('input', { type: 'checkbox', checked: true });
                    rows.push(ui.el('label', { className: 'ppt-palette-item', style: 'cursor:pointer' }, [
                        box,
                        ui.el('span', {}, [
                            ui.el('div', {}, title),
                            ui.el('div', { className: 'sub', textContent: subtitle }),
                        ]),
                    ]));
                    return box;
                };

                const statusBox = target && row(
                    [document.createTextNode('Move to '), statusDot(target.colorName), document.createTextNode(` ${target.name}`)],
                    `Currently ${state.status?.name ?? 'an unknown status'}`,
                );
                const assigneeBox = me && row(
                    [document.createTextNode(`Assign to me${me.displayName ? ` (${me.displayName})` : ''}`)],
                    state.assignee ? `Currently ${state.assignee.displayName ?? 'someone else'}` : 'Currently unassigned',
                );

                let answered = false;
                const answer = (close, apply) => {
                    answered = true;
                    close();
                    resolve(apply
                        ? { status: !!statusBox?.checked, assignee: !!assigneeBox?.checked }
                        : NOTHING);
                };

                ui.modal({
                    title: `Timer started · ${key}`,
                    onClose: () => { if (!answered) resolve(NOTHING); },
                    render: (body) => body.append(
                        ui.el('div', {
                            className: 'ppt-note',
                            textContent: 'The timer is running. Jira is not lined up with it yet — pick what to change.',
                        }),
                        ui.el('div', { className: 'ppt-palette-list' }, rows),
                    ),
                    buttons: [
                        { label: 'Apply', primary: true, onClick: (close) => answer(close, true) },
                        { label: 'Not now', onClick: (close) => answer(close, false) },
                    ],
                });
            });
        }

        // Reports what happened rather than toasting, so a status move and an
        // assignment land in one message instead of overwriting each other.
        async function applyStatusChange(key, target) {
            const walk = await walkToStatus({
                key,
                target,
                routes: config.statusRoutes,
                getStatus: getCurrentStatus,
                getTransitions,
                transition: applyTransition,
                chooseHop,
            });

            if (walk.route) {
                config.statusRoutes[walk.route.key] = walk.route.hops;
                await store.set('jira_status_routes', config.statusRoutes);
            }

            const via = walk.walked.length ? ` (via ${walk.walked.map((status) => status.name).join(' → ')})` : '';
            if (walk.outcome === 'moved') return { changed: true, note: `→ ${walk.at?.name ?? target.name}${via}` };
            if (walk.outcome === 'stopped') return { changed: !!walk.walked.length, note: `stays at ${walk.at?.name ?? 'its current status'}` };
            if (walk.outcome === 'exhausted') return { changed: true, note: `got as far as ${walk.at?.name}, not ${target.name}` };
            return { changed: false, note: null };
        }

        // Best-effort: a failed Jira update must never look like a failed timer,
        // so this reports through its own toast and swallows the error.
        async function applyOnStart(key) {
            if (!key) return;
            try {
                const target = statusForSite();
                const [state, me] = await Promise.all([
                    getIssueState(key),
                    // Without a "me" there is nothing to compare an assignee to;
                    // the status half of the check still stands on its own.
                    getMyself().catch(() => null),
                ]);

                const statusOff = !!target && !isTargetStatus(state.status, target);
                const assigneeOff = !!me?.accountId && state.assignee?.accountId !== me.accountId;
                // Whatever is already right is never mentioned, and when both are
                // right the start passes in silence.
                if (!statusOff && !assigneeOff) return;

                const choice = await confirmStartActions({
                    key,
                    state,
                    target: statusOff ? target : null,
                    me: assigneeOff ? me : null,
                });

                const notes = [];
                let changed = false;
                if (choice.assignee) {
                    await assignToMe(key, me.accountId);
                    notes.push('assigned to you');
                    changed = true;
                }
                if (choice.status) {
                    const result = await applyStatusChange(key, target);
                    if (result.note) notes.push(result.note);
                    changed = changed || result.changed;
                }

                if (notes.length) ui.toast(`🔀 ${key} ${notes.join(' · ')}`, 4000);
                if (changed) reloadIssue(key);
            } catch (e) {
                console.error('[Clockify Timer] start actions failed:', e);
                ui.toast(`⚠️ Timer started, but the Jira update failed: ${e.message}`, 4000);
            }
        }

        // ── Jira page helpers ────────────────────────────────────────────
        const STATUS_FIELD = '[data-testid="issue.views.issue-base.foundation.status.status-field-wrapper"]';

        // The status Jira is showing right now, read straight off the lozenge the
        // timer button sits next to — no REST round-trip, and it is exactly what
        // the user is looking at.
        function pageStatusName() {
            return document.querySelector(STATUS_FIELD)?.textContent?.replace(/\s+/g, ' ').trim() || null;
        }

        function getIssueKey() {
            return location.pathname.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/)?.[1]
                ?? location.href.match(/selectedIssue=([A-Z][A-Z0-9]+-\d+)/)?.[1]
                ?? document.querySelector('[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]')?.textContent.trim()
                ?? null;
        }

        function getIssueSummary() {
            const heading = document.querySelector('[data-testid="issue.views.issue-base.foundation.summary.heading"]');
            if (heading) return heading.textContent.trim();
            return document.title.replace(/- Jira$/, '').replace(/^\[.*?\]\s*/, '').trim();
        }

        function buildDescription() {
            const key = getIssueKey();
            const summary = getIssueSummary();
            if (key && summary) return `${key} ${summary}`;
            return key ?? summary ?? 'Jira task';
        }

        // ── Configuration UIs ────────────────────────────────────────────
        function openSettings() {
            const keyInput = ui.el('input', { className: 'ppt-input', type: 'password', value: config.apiKey, placeholder: 'From Clockify → Profile → API' });
            const wsInput = ui.el('input', { className: 'ppt-input', type: 'text', value: config.workspaceId, placeholder: 'From the workspace URL' });
            ui.modal({
                title: '🕐 Clockify Settings',
                render: (body) => {
                    body.append(
                        ui.el('div', { className: 'ppt-note', textContent: 'Stored only in your browser and sent only to api.clockify.me.' }),
                        ui.el('label', { className: 'ppt-label', textContent: 'API key' }),
                        keyInput,
                        ui.el('label', { className: 'ppt-label', textContent: 'Workspace ID' }),
                        wsInput,
                    );
                },
                buttons: [{
                    label: 'Save', primary: true,
                    onClick: async (close) => {
                        config.apiKey = keyInput.value.trim();
                        config.workspaceId = wsInput.value.trim();
                        await store.set('clockify_api_key', config.apiKey);
                        await store.set('clockify_workspace_id', config.workspaceId);
                        close();
                        ui.toast('✅ Clockify settings saved');
                        updateButtonState();
                    },
                }],
            });
        }

        function openProjectPicker() {
            if (!subdomain) { ui.toast('Could not detect the Atlassian subdomain.'); return; }
            if (!config.apiKey || !config.workspaceId) { ui.toast('⚠️ Set your API key and workspace ID first.'); openSettings(); return; }

            ui.modal({
                title: `Project for ${subdomain}`,
                render: (body, close) => {
                    const current = config.projectMappings[subdomain];
                    if (current) body.append(ui.el('div', { className: 'ppt-note', textContent: `Current: ${current.name}` }));

                    const input = ui.el('input', { className: 'ppt-input', placeholder: 'Type to search projects…' });
                    const results = ui.el('div', { className: 'ppt-palette-list' });

                    const saveMapping = async (project) => {
                        if (project) config.projectMappings[subdomain] = project;
                        else delete config.projectMappings[subdomain];
                        await store.set('clockify_project_mappings', config.projectMappings);
                        close();
                        ui.toast(project ? `✅ Project set: ${project.name}` : `✕ Project mapping removed for ${subdomain}`);
                        updateButtonState();
                    };

                    let searchTimer = null;
                    const search = async () => {
                        results.replaceChildren(ui.el('div', { className: 'ppt-note', textContent: 'Searching…' }));
                        const filter = input.value.trim() ? `&name=${encodeURIComponent(input.value.trim())}` : '';
                        try {
                            const projects = await api('GET',
                                `/workspaces/${config.workspaceId}/projects?page-size=20&archived=false${filter}`);
                            results.replaceChildren(...(projects ?? []).map((project) => ui.el('button', {
                                className: 'ppt-palette-item',
                                onclick: () => saveMapping({ id: project.id, name: project.name }),
                            }, [
                                ui.el('span', { className: 'icon', textContent: '●' }),
                                ui.el('span', { textContent: project.name }),
                            ])));
                            if (!projects?.length) results.replaceChildren(ui.el('div', { className: 'ppt-note', textContent: 'No projects found' }));
                        } catch (e) {
                            results.replaceChildren(ui.el('div', { className: 'ppt-note', textContent: `Error: ${e.message}` }));
                        }
                    };

                    input.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(search, 300); });
                    body.append(input, results);
                    if (current) {
                        body.append(ui.el('button', {
                            className: 'ppt-btn danger', textContent: 'Remove mapping', style: 'margin-top:10px',
                            onclick: () => saveMapping(null),
                        }));
                    }
                    search();
                    setTimeout(() => input.focus(), 0);
                },
            });
        }

        // Resolves once the user has answered (or dismissed), so the timer
        // button can wait for the answer before it starts its first timer.
        function openStatusPicker({ firstRun = false } = {}) {
            if (!subdomain) { ui.toast('Could not detect the Atlassian subdomain.'); return Promise.resolve(); }
            const key = getIssueKey();
            if (!key) { ui.toast('Open a Jira issue first — the list comes from its available transitions.'); return Promise.resolve(); }

            return new Promise((resolve) => ui.modal({
                title: `Status on timer start · ${subdomain}`,
                onClose: resolve,
                render: (body, close) => {
                    const current = statusForSite();
                    body.append(current
                        ? ui.el('div', { className: 'ppt-note' }, [
                            document.createTextNode(`Timer start moves issues on ${subdomain} to `),
                            statusDot(current.colorName),
                            document.createTextNode(` ${current.name}.`),
                        ])
                        : ui.el('div', {
                            className: 'ppt-note',
                            textContent: firstRun
                                ? `One-time setup for ${subdomain}: pick the status a timer start should move issues into. The timer starts either way.`
                                : 'Starting a timer leaves the issue status untouched.',
                        }));

                    // What the issue sits at right now, so "leave the status
                    // alone" names the status it would be left at.
                    const liveNote = ui.el('div', { className: 'ppt-note', textContent: `Checking ${key}…` });
                    const results = ui.el('div', { className: 'ppt-palette-list' }, [
                        ui.el('div', { className: 'ppt-note', textContent: `Loading transitions for ${key}…` }),
                    ]);
                    const leaveAlone = ui.el('button', {
                        className: 'ppt-btn danger', textContent: 'Leave the status alone', style: 'margin-top:10px',
                        onclick: () => saveMapping(null),
                    });

                    const saveMapping = async (status) => {
                        config.statusMappings[subdomain] = status ?? false;
                        await store.set('jira_status_mappings', config.statusMappings);
                        close();
                        ui.toast(status ? `✅ Timer start will set: ${status.name}` : `✕ Timer start will leave the status alone on ${subdomain}`);
                        updateButtonState();
                    };

                    (async () => {
                        try {
                            // The status is a nicety; a failure there must not cost
                            // the user the transition list, which is the point of the dialog.
                            const [live, transitions, projectStatuses] = await Promise.all([
                                getCurrentStatus(key).catch(() => null),
                                getTransitions(key),
                                getProjectStatuses(key).catch(() => []),
                            ]);

                            if (live) {
                                liveNote.replaceChildren(
                                    document.createTextNode(`${key} is at `),
                                    statusDot(live.statusCategory?.colorName),
                                    document.createTextNode(` ${live.name} right now.`),
                                );
                                leaveAlone.textContent = `Leave it at ${live.name}`;
                            } else {
                                liveNote.remove();
                            }

                            // One-step targets first, then the rest of the project's
                            // statuses — reaching those is the router's problem, not
                            // a reason to hide them from the person choosing.
                            const seen = new Set();
                            const items = [];
                            for (const status of [...transitions.map((t) => t.to), ...projectStatuses]) {
                                if (!status?.id || seen.has(status.id)) continue;
                                seen.add(status.id);
                                const colorName = status.statusCategory?.colorName;
                                items.push(ui.el('button', {
                                    className: 'ppt-palette-item',
                                    onclick: () => saveMapping({ id: status.id, name: status.name, colorName }),
                                }, [
                                    statusDot(colorName, 'icon'),
                                    ui.el('span', { textContent: isTargetStatus(status, live) ? `${status.name} — where it already is` : status.name }),
                                ]));
                            }
                            results.replaceChildren(...(items.length ? items : [
                                ui.el('div', { className: 'ppt-note', textContent: `No statuses found for ${key}.` }),
                            ]));
                        } catch (e) {
                            liveNote.remove();
                            results.replaceChildren(ui.el('div', { className: 'ppt-note', textContent: `Error: ${e.message}` }));
                        }
                    })();

                    body.append(liveNote, results, leaveAlone);
                },
            }));
        }

        // One entry rather than three: the pickers are one-time setup, not part of
        // the daily loop, and each one's current answer is worth more next to it
        // than spelled out in a popup tile.
        function openTimerSettings() {
            const status = statusForSite();
            const project = projectForSite();
            ui.modal({
                title: `🕐 Clockify timer · ${subdomain ?? 'this site'}`,
                render: (body, close) => {
                    const item = (icon, title, subtitle, run) => ui.el('button', {
                        className: 'ppt-palette-item',
                        onclick: () => { close(); run(); },
                    }, [
                        ui.el('span', { className: 'icon', textContent: icon }),
                        ui.el('span', {}, [
                            ui.el('div', { textContent: title }),
                            ui.el('div', { className: 'sub', textContent: subtitle }),
                        ]),
                    ]);

                    body.append(ui.el('div', { className: 'ppt-palette-list' }, [
                        item('🔀', 'Status on timer start',
                            statusDecided()
                                ? (status ? `Now: ${status.name}` : 'Now: the status is left alone')
                                : 'Not chosen yet',
                            () => openStatusPicker()),
                        item('📁', 'Clockify project for this site',
                            project ? `Now: ${project.name}` : 'Not set — entries land in no project',
                            openProjectPicker),
                        item('🕐', 'API key and workspace',
                            config.apiKey && config.workspaceId ? 'Saved' : 'Missing — the timer cannot start without these',
                            openSettings),
                    ]));
                },
            });
        }

        commands.register({
            toolId: 'jira-clockify-timer', title: 'Clockify timer settings', icon: '🕐', svg: 'timer', kind: 'setting', run: openTimerSettings,
        });

        // ── Timer button ─────────────────────────────────────────────────
        ui.pageStyle('ppt-clockify-style', `
            @keyframes ppt-clockify-pulse { 0%,100% { opacity:1 } 50% { opacity:.5 } }
            #ppt-clockify-wrapper { display:flex; align-items:center; flex-shrink:0; visibility:hidden; opacity:0; transition:opacity .15s ease; }
            #ppt-clockify-wrapper.ready { visibility:visible; opacity:1; }
            #ppt-clockify-btn {
                display:inline-flex; align-items:center; gap:6px; padding:4px 12px; border:none; border-radius:3px;
                cursor:pointer; font-size:14px; font-weight:500; white-space:nowrap; line-height:2.28571em;
                height:2.28571em; box-sizing:border-box; vertical-align:middle;
                font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
            }
            #ppt-clockify-btn.idle { background:#0F6CBD; color:#fff; }
            #ppt-clockify-btn.idle:hover { background:#115EA3; }
            #ppt-clockify-btn.running { background:#C4314B; color:#fff; }
            #ppt-clockify-btn.running:hover { background:#A4262C; }
            #ppt-clockify-btn .dot { width:7px; height:7px; border-radius:50%; background:#fff; flex-shrink:0; }
            #ppt-clockify-btn.running .dot { animation:ppt-clockify-pulse 1.5s ease-in-out infinite; }
            #ppt-clockify-btn .elapsed { font-variant-numeric:tabular-nums; }
        `);

        let runningEntry = null;
        let elapsedInterval = null;
        let injected = false;
        let initDone = false;
        let busy = false;

        const button = () => document.getElementById('ppt-clockify-btn');
        const label = () => document.getElementById('ppt-clockify-label');

        function timerMatchesPage() {
            const key = getIssueKey();
            return !!(runningEntry?.description && key && runningEntry.description.startsWith(key));
        }

        function updateButtonState() {
            const btn = button();
            if (!btn) return;
            clearInterval(elapsedInterval);
            const running = runningEntry && timerMatchesPage();
            btn.className = running ? 'running' : 'idle';
            if (running) {
                updateElapsed();
                elapsedInterval = setInterval(updateElapsed, 1000);
            } else {
                renderIdleLabel();
            }
        }

        // Only worth advertising a move the issue has not already made — and the
        // status can change under us (in Jira, or from another tab), so this is
        // re-read rather than baked in when the button is injected.
        function renderIdleLabel() {
            if (!label()) return;
            const project = projectForSite();
            const target = statusForSite();
            const here = pageStatusName();
            const pending = target && !(here && isTargetStatus({ name: here }, target)) ? target : null;
            label().textContent = 'Start Timer'
                + (project ? ` · ${project.name}` : '')
                + (pending ? ` → ${pending.name}` : '');
        }

        function updateElapsed() {
            const start = runningEntry?.timeInterval?.start;
            if (!label() || !start) return;
            const diff = Math.floor((Date.now() - new Date(start).getTime()) / 1000);
            const pad = (n) => String(n).padStart(2, '0');
            const elapsed = `${pad(Math.floor(diff / 3600))}:${pad(Math.floor((diff % 3600) / 60))}:${pad(diff % 60)}`;
            label().replaceChildren(
                ui.el('span', { className: 'elapsed', textContent: elapsed }),
                document.createTextNode(' · Stop'),
            );
        }

        async function handleClick() {
            if (!config.apiKey || !config.workspaceId) { openSettings(); return; }
            if (busy) return;
            busy = true;
            button().style.opacity = '0.7';

            try {
                if (runningEntry && timerMatchesPage()) {
                    await stopTimer();
                    runningEntry = null;
                    ui.toast('⏹️ Timer stopped.');
                } else {
                    // First start on this site opens the picker, so the setting is
                    // reachable from the button instead of only the palette. Dismissing
                    // it decides nothing and starts the timer anyway; the explicit
                    // "leave the status alone" answer is what stops the asking.
                    if (getIssueKey() && !statusDecided()) await openStatusPicker({ firstRun: true });

                    const switching = !!runningEntry;
                    if (switching) await stopTimer();
                    const description = buildDescription();
                    runningEntry = await startTimer(description);
                    const project = projectForSite();
                    ui.toast(`${switching ? '🔄 Switched to' : '▶️ Timer started'}: ${description}${project ? ` [${project.name}]` : ''}`);
                    // Deliberately not awaited: the button settles as soon as the
                    // timer runs, whatever Jira is asked to do afterwards.
                    applyOnStart(getIssueKey());
                }
                updateButtonState();
            } catch (e) {
                console.error('[Clockify Timer]', e);
                ui.toast(`❌ ${e.message}`, 4000);
            } finally {
                busy = false;
                const btn = button();
                if (btn) btn.style.opacity = '';
            }
        }

        function injectButton() {
            if (injected && button()) return true;
            document.getElementById('ppt-clockify-wrapper')?.remove();

            const statusEl = document.querySelector(STATUS_FIELD);
            const target = statusEl?.parentElement;
            if (!target) return false;

            const wrapper = ui.el('div', { id: 'ppt-clockify-wrapper' }, [
                ui.el('button', { id: 'ppt-clockify-btn', className: 'idle', onclick: handleClick }, [
                    ui.el('span', { className: 'dot' }),
                    ui.el('span', { id: 'ppt-clockify-label', textContent: 'Start Timer' }),
                ]),
            ]);
            target.appendChild(wrapper);
            injected = true;
            updateButtonState();
            if (initDone) wrapper.classList.add('ready');
            return true;
        }

        function reveal() {
            initDone = true;
            document.getElementById('ppt-clockify-wrapper')?.classList.add('ready');
        }

        function tryInject() {
            if (injectButton()) return;
            const observer = new MutationObserver(() => { if (injectButton()) observer.disconnect(); });
            observer.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => observer.disconnect(), 30000);
        }

        // SPA navigation + re-render recovery
        let lastUrl = location.href;
        setInterval(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                injected = false;
                setTimeout(() => { tryInject(); updateButtonState(); }, 800);
            }
            if (injected && !button()) { injected = false; tryInject(); }
            else if (injected && !(runningEntry && timerMatchesPage())) renderIdleLabel();
        }, 1000);

        setTimeout(async () => {
            tryInject();
            if (!config.apiKey || !config.workspaceId) { reveal(); return; }
            try {
                runningEntry = await getRunningTimer();
                updateButtonState();
                if (runningEntry && timerMatchesPage()) {
                    ui.toast(`⏱️ Timer running: ${runningEntry.description || 'No description'}`, 4000);
                }
            } catch (e) {
                // 401/403 = the saved API key is invalid or expired — a routine
                // user-state for a passive load-time probe, not an extension fault.
                if (e.status !== 401 && e.status !== 403) {
                    console.error('[Clockify Timer] failed to check running timer:', e);
                }
            }
            reveal();
        }, 1500);
    },
};
