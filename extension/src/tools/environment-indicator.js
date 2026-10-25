// Environment Indicator (native).
// Shows a colored DEV/TEST/UAT/STAGING/PROD badge near the navbar, lets the
// user label environments, and switches between environments — onto the same
// app, record, table, solution or flow when the target has it, and the nearest
// page it does have when not (shared/environment-switch.js).
//
// Environments are grouped into families ("Smart Workflows DEV/TEST/PROD" vs
// "Antrag Naturgefahren DEV/TEST/PROD"): the family you are in is listed first
// and expanded, the others collapse out of the way, because a switch nearly
// always stays inside one family. Names come from the org itself and the group
// follows the name, both overridable per environment — see shared/environments.js.
//
// The environment ID is resolved from the URL (maker portals / canvas player),
// a local hostname cache, or the Dataverse RetrieveCurrentOrganization API on
// Dynamics pages (replaces the old MAIN-world Xrm dependency). Mappings are
// also published to legacy tools via src/gm/gm-shim.js (PowerPlatformEnvironments).

import { HttpError, request } from '../core/http.js';
import { Dataverse } from '../core/dataverse.js';
import { envIdForUrl, envIdFromUrl } from '../core/context.js';
import * as ui from '../core/ui.js';
import * as commands from '../core/commands.js';
import {
    ENV_TYPES, backfillNames, deriveGroup, groupEnvironments, groupOfEnvId,
    loadEnvironments, normalizeRecord, removeEnvironment, resolveOrgName, updateEnvironment,
} from './shared/environments.js';
import { switchUrl } from './shared/environment-switch.js';

// Cross-environment OData read (relayed via the service worker): the JSON,
// or null when the row does not exist.
async function odata(host, path) {
    try {
        const response = await request({
            url: `https://${host}/api/data/v9.2/${path}`,
            headers: { 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'Accept': 'application/json' },
            credentials: true,
        });
        return response.json();
    } catch (e) {
        if (e instanceof HttpError && e.status === 404) return null;
        throw e;
    }
}

export default {
    async init({ store }) {
        let mappings = await store.get('envIndicator_mappings', {});
        let hostCache = await store.get('envIndicator_hostCache', {});
        store.watch('envIndicator_mappings', (v) => { mappings = v ?? {}; });

        // A record is either a legacy type string or { type, name, group }.
        const recordFor = (envId) => normalizeRecord(
            mappings[envId] ?? mappings[String(envId ?? '').toLowerCase()]);

        const hostname = location.hostname.toLowerCase();
        const isDynamics = hostname.endsWith('.dynamics.com');
        const isMakerPortal = hostname === 'make.powerapps.com' || hostname === 'make.powerautomate.com';
        let dynamicsEnvId = null;    // resolved once per Dynamics host
        let orgFriendlyName = null;

        async function saveHostCache(host, envId) {
            hostCache[host.toLowerCase()] = envId.toLowerCase();
            await store.set('envIndicator_hostCache', hostCache);
        }

        const hostForEnvId = (envId) =>
            Object.entries(hostCache).find(([, id]) => id === envId.toLowerCase())?.[0] ?? null;

        // ── Environment identity ─────────────────────────────────────────
        async function resolveDynamicsEnvId() {
            if (dynamicsEnvId) return dynamicsEnvId;
            if (hostCache[hostname]) return (dynamicsEnvId = hostCache[hostname]);
            try {
                const detail = await new Dataverse().retrieveCurrentOrganization();
                const envId = detail?.EnvironmentId?.replace(/[{}]/g, '').toLowerCase();
                orgFriendlyName = detail?.FriendlyName ?? detail?.UniqueName ?? null;
                if (envId) {
                    dynamicsEnvId = envId;
                    await saveHostCache(hostname, envId);
                }
            } catch (e) {
                console.warn('[Environment Indicator] could not resolve environment id:', e);
            }
            return dynamicsEnvId;
        }

        function currentEnvId() {
            return envIdFromUrl() ?? (isDynamics ? dynamicsEnvId : null);
        }

        function currentEnvType() {
            const envId = currentEnvId();
            const type = envId ? recordFor(envId).type : null;
            return type && ENV_TYPES[type] ? type : null;
        }

        function environmentName() {
            return document.querySelector('[data-test-id="EnvironmentTitle"]')?.textContent.trim()
                ?? orgFriendlyName;
        }

        // The name this page can see is worth keeping: it is what the grouping
        // is derived from, and pickers on other pages have no way to read it.
        // Written once per page, and never over a name the user typed.
        let nameCaptured = false;
        async function captureEnvironmentName() {
            const envId = currentEnvId();
            if (nameCaptured || !envId || !recordFor(envId).type) return;
            nameCaptured = true;
            // The portal's own title where there is one; otherwise ask the org,
            // which is same-origin here and is all a Dynamics page has. Note
            // `orgFriendlyName` is only filled when the host cache missed.
            const name = environmentName() ?? (isDynamics ? await resolveOrgName(hostname) : null);
            if (!name) return;
            orgFriendlyName ??= name;
            if (recordFor(envId).name === name) return;
            await updateEnvironment(envId, { name, nameSource: 'org' }, store);
        }

        // ── Environment switching ────────────────────────────────────────
        // The same page in the target, checked id by id against it — see
        // shared/environment-switch.js.
        async function switchToEnvironment(storedEnvId) {
            const targetHost = hostForEnvId(storedEnvId);
            if (targetHost) ui.toast('Opening the same page in the other environment…');
            const sourceEnvId = currentEnvId();
            const url = await switchUrl(location.href, {
                // Stored ids are lowercased; URLs want "Default-{guid}" as written.
                targetEnvId: envIdForUrl(storedEnvId),
                sourceHost: isDynamics ? hostname : (sourceEnvId ? hostForEnvId(sourceEnvId) : null),
                targetHost,
                get: odata,
            });
            location.href = url;
        }

        // ── Badge ────────────────────────────────────────────────────────
        let badge = null;

        function findHeaderReference() {
            const candidates = [
                document.getElementById('ppuxOfficeHeaderBranding_container'),
                document.querySelector('[data-id="appBreadCrumb"]')?.closest('[role="presentation"]')
                    ?? document.querySelector('[data-id="appBreadCrumb"]'),
                document.querySelector('[data-id="dynamics-button"]')?.parentElement,
                document.getElementById('shellHeaderBranding_container'),
                document.getElementById('O365_HeaderLeftRegion'),
                document.getElementById('topBar'),
            ];
            return candidates.find((element) => element && element.offsetParent !== null) ?? null;
        }

        function positionBadge() {
            const ref = findHeaderReference();
            if (!badge || !ref) return false;
            const rect = ref.getBoundingClientRect();
            badge.style.top = Math.max(0, Math.round(rect.top + rect.height / 2 - badge.offsetHeight / 2)) + 'px';
            badge.style.left = Math.round(rect.right + 12) + 'px';
            badge.style.visibility = 'visible';
            return true;
        }

        function renderBadge(envType) {
            if (badge?.isConnected && badge.dataset.envType === envType) { positionBadge(); return; }
            badge?.remove();
            const config = ENV_TYPES[envType];
            badge = ui.el('div', {
                className: 'ppt',
                title: `Environment: ${config.label}\nClick to change`,
                textContent: `${config.icon} ${config.label}`,
                onclick: openConfigDialog,
            });
            badge.dataset.envType = envType;
            badge.style.cssText = `
                position: fixed; top: 0; left: 0; z-index: 2147482000;
                display: inline-flex; align-items: center; gap: 5px; padding: 3px 12px;
                border-radius: 4px; font-size: 12px; font-weight: 700; letter-spacing: 0.5px;
                color: ${config.color}; background: ${config.bg}; border: 1.5px solid ${config.border};
                cursor: pointer; user-select: none; white-space: nowrap; visibility: hidden;
            `;
            // Lives in the host DOM (not the shadow root) so it can sit inside the header flow visually
            document.body.appendChild(badge);
            positionBadge();
        }

        function removeBadge() {
            badge?.remove();
            badge = null;
        }

        // ── Config dialog ────────────────────────────────────────────────
        ui.addStyle('env-indicator', `
            /* No overflow clipping here: the group box holds the edit row, whose
               suggestion menu hangs below it. The header rounds its own corners
               instead — all four of them when it is the only thing showing. */
            .env-group { border: 1px solid var(--border); border-radius: 6px; margin-bottom: 6px; }
            .env-group.env-dragging { opacity: 0.4; }
            .env-group.env-drop-before { box-shadow: inset 0 2px 0 var(--accent); }
            .env-group.env-drop-after { box-shadow: inset 0 -2px 0 var(--accent); }
            .env-group-head {
                display: flex; align-items: center; gap: 8px; padding: 6px 8px;
                background: var(--bg2); cursor: pointer; user-select: none;
                font-size: 12px; font-weight: 600; border-radius: 5px 5px 0 0;
            }
            .env-group > .env-group-head:only-child { border-radius: 5px; }
            .env-group-caret { color: var(--muted); font-size: 9px; width: 10px; flex-shrink: 0; }
            .env-group-count { color: var(--muted); font-weight: 400; font-size: 11px; }
            .env-group-here { margin-left: auto; color: var(--accent); font-size: 11px; font-weight: 600; }
            .env-group-rename { margin-left: auto; opacity: 0; font-size: 11px; }
            .env-group-here + .env-group-rename { margin-left: 0; }
            .env-group-head:hover .env-group-rename, .env-group-rename:focus { opacity: 1; }
            .env-group-body { padding: 2px 4px 4px; }
            .env-row { display: flex; align-items: center; gap: 8px; padding: 5px 6px; font-size: 12px; border-radius: 4px; }
            .env-row:hover { background: var(--bg2); }
            .env-id { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
            .env-name { display: block; color: var(--text); font-weight: 600; }
            .env-sub { display: block; font-size: 10px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; }
            .env-grip {
                cursor: grab; color: var(--muted); font-size: 14px; line-height: 1;
                user-select: none; opacity: 0.4; flex-shrink: 0;
            }
            .env-group:hover .env-grip { opacity: 0.9; }
            .env-grip:active { cursor: grabbing; }
            .env-edit { display: flex; flex-direction: column; gap: 6px; padding: 8px 6px; }
            .env-edit .ppt-input { font-size: 12px; }
            .env-field { display: flex; align-items: center; gap: 8px; }
            .env-field > span {
                flex: 0 0 44px; font-size: 11px; font-weight: 600;
                color: var(--muted); text-transform: uppercase; letter-spacing: 0.3px;
            }
            .env-field > .ppt-input, .env-field > .ppt-ac-wrap { flex: 1; min-width: 0; }
        `);

        function openConfigDialog() {
            const envId = currentEnvId();
            const envName = environmentName();

            const select = ui.el('select', { className: 'ppt-select' }, [
                ui.el('option', { value: '', textContent: '— Not set —' }),
                ...Object.entries(ENV_TYPES).map(([key, config]) => ui.el('option', {
                    value: key,
                    textContent: `${config.icon} ${config.label}`,
                    selected: envId ? recordFor(envId).type === key : false,
                })),
            ]);

            // Environments are rendered from a snapshot that the dialog owns, so
            // an edit, a delete or a name arriving late redraws the list in place
            // instead of closing and reopening the dialog.
            let environments = [];
            let editingId = null;
            let draggedGroup = null;
            let renamingGroup = null;
            const collapsed = new Set();
            let collapseSeeded = false;
            const listEl = ui.el('div');

            // The family this environment belongs to. There is no group box in
            // this dialog: the group is detected from names and hosts, the
            // pencil on a group renames it, and the pencil on a row moves one
            // environment for the rare case detection is wrong.
            const currentGroupName = () =>
                groupOfEnvId(environments, envId ?? '')
                || deriveGroup(recordFor(envId ?? '').name || envName);

            async function reload() {
                environments = await loadEnvironments({ currentEnvId: envId, store });
                renderList();
                // Names the registry never learned (environments labelled before
                // this existed, or only ever seen through a maker portal) are
                // fetched from each org and folded in as they land.
                // A redraw would take a half-typed edit or an in-flight drag
                // with it, so late names wait for those to finish.
                backfillNames(environments, {
                    store,
                    onUpdate: () => { if (!draggedGroup && editingId === null && renamingGroup === null) renderList(); },
                });
            }

            function renderList() {
                const groups = groupEnvironments(environments, { currentGroup: currentGroupName() });
                if (!collapseSeeded && groups.length) {
                    // Open the family you are in, fold the rest away.
                    for (const group of groups) if (!group.isCurrent) collapsed.add(group.group.toLowerCase());
                    collapseSeeded = true;
                }
                listEl.replaceChildren(...groups.map((group) => renderGroup(group, groups.length === 1)));
            }

            function renderGroup(group, onlyGroup) {
                // Nothing grouped yet (no names known): an "Ungrouped" header
                // would only be in the way, so the list stays flat.
                if (onlyGroup && !group.group) {
                    return ui.el('div', {},
                        group.envs.map((env) => (editingId === env.envId ? renderEditRow(env) : renderRow(env))));
                }
                const key = group.group.toLowerCase();
                const isOpen = !collapsed.has(key);
                const head = ui.el('div', { className: 'env-group-head' }, [
                    ...(group.isCurrent ? [] : [ui.el('span', {
                        className: 'env-grip', draggable: true, textContent: '⠿', title: 'Drag to reorder groups',
                    })]),
                    ui.el('span', { className: 'env-group-caret', textContent: isOpen ? '▼' : '▶' }),
                    renamingGroup === key && group.group ? renderGroupRename(group) : ui.el('span', { textContent: group.label }),
                    ui.el('span', { className: 'env-group-count', textContent: `(${group.envs.length})` }),
                    ...(group.isCurrent ? [ui.el('span', { className: 'env-group-here', textContent: '📍 you are here' })] : []),
                    ...(group.group && renamingGroup !== key ? [ui.el('button', {
                        className: 'ppt-icon-btn env-group-rename', textContent: '✏️', title: 'Rename group',
                        onclick: (e) => { e.stopPropagation(); renamingGroup = key; renderList(); },
                    })] : []),
                ]);
                head.addEventListener('click', (e) => {
                    if (e.target.classList.contains('env-grip') || e.target.closest('.env-group-rename-input')) return;
                    if (isOpen) collapsed.add(key); else collapsed.delete(key);
                    renderList();
                });

                const wrap = ui.el('div', { className: 'env-group' }, [
                    head,
                    ...(isOpen ? [ui.el('div', { className: 'env-group-body' },
                        group.envs.map((env) => (editingId === env.envId ? renderEditRow(env) : renderRow(env))))] : []),
                ]);
                wrap._envIds = group.envs.map((env) => env.envId);

                // Groups reorder by drag; the current one stays pinned to the top,
                // so it carries no grip and nothing can land in front of it.
                if (!group.isCurrent) {
                    const grip = head.querySelector('.env-grip');
                    grip.addEventListener('dragstart', (e) => {
                        draggedGroup = wrap;
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', group.group);
                        try { e.dataTransfer.setDragImage(wrap, 12, 12); } catch { /* optional */ }
                        requestAnimationFrame(() => wrap.classList.add('env-dragging'));
                    });
                    grip.addEventListener('dragend', () => { draggedGroup = null; clearMarks(); });
                    wrap.addEventListener('dragover', (e) => {
                        if (!draggedGroup || draggedGroup === wrap || group.isCurrent) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        const after = dropAfter(wrap, e.clientY);
                        wrap.classList.toggle('env-drop-after', after);
                        wrap.classList.toggle('env-drop-before', !after);
                    });
                    wrap.addEventListener('dragleave', () => wrap.classList.remove('env-drop-before', 'env-drop-after'));
                    wrap.addEventListener('drop', (e) => {
                        e.preventDefault();
                        if (!draggedGroup || draggedGroup === wrap) return;
                        if (dropAfter(wrap, e.clientY)) wrap.after(draggedGroup);
                        else wrap.before(draggedGroup);
                        clearMarks();
                        persistOrder();
                    });
                }
                return wrap;
            }

            // Renaming a group writes the new name as every member's explicit
            // group, so the family keeps it whatever their names say. Clearing
            // the box hands them back to detection.
            function renderGroupRename(group) {
                const input = ui.el('input', {
                    className: 'ppt-input env-group-rename-input', value: group.label,
                    style: 'padding:1px 6px;font-size:12px;min-width:0;flex:1',
                });
                const finish = async (commit) => {
                    renamingGroup = null;
                    if (!commit) { renderList(); return; }
                    const name = input.value.trim();
                    for (const env of group.envs) await updateEnvironment(env.envId, { group: name }, store);
                    // Keep the renamed group open, or closed, as it was.
                    if (collapsed.delete(group.group.toLowerCase()) && name) collapsed.add(name.toLowerCase());
                    await reload();
                };
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') finish(true);
                    if (e.key !== 'Escape') return;
                    e.stopPropagation();
                    finish(false);
                });
                input.addEventListener('blur', () => { if (renamingGroup !== null) finish(false); });
                requestAnimationFrame(() => { input.focus(); input.select(); });
                return input;
            }

            const clearMarks = () => {
                for (const node of listEl.children)
                    node.classList.remove('env-dragging', 'env-drop-before', 'env-drop-after');
            };
            const dropAfter = (node, clientY) => {
                const rect = node.getBoundingClientRect();
                return clientY > rect.top + rect.height / 2;
            };
            // The stored order is a flat list of env ids; a group's position is
            // where its first member sits, so writing the groups out in display
            // order is what makes the new arrangement stick.
            const persistOrder = async () => {
                const order = [...listEl.children].flatMap((node) => node._envIds ?? []);
                await store.set('envIndicator_order', order);
                // The drop moved DOM nodes; reload so the snapshot the next
                // render sorts from agrees with what is already on screen.
                await reload();
            };

            function renderRow(env) {
                const config = ENV_TYPES[env.type];
                return ui.el('div', { className: 'env-row' }, [
                    ui.el('span', {
                        textContent: config ? `${config.icon} ${config.label}` : (env.type ?? '🌐 ?'),
                        style: config
                            ? `color:${config.color};background:${config.bg};border:1px solid ${config.border};padding:1px 8px;border-radius:3px;font-weight:700;font-size:11px;flex-shrink:0`
                            : 'flex-shrink:0',
                    }),
                    ui.el('span', { className: 'env-id' }, env.name
                        ? [ui.el('span', { className: 'env-name', textContent: env.name }),
                            ui.el('span', { className: 'env-sub', textContent: env.host ?? env.envId })]
                        : [ui.el('code', { textContent: env.envId })]),
                    // On a maker portal, Switch moves the portal; the environment's
                    // Dynamics app opens next to it, so the portal tab stays put.
                    ...(isMakerPortal && env.host ? [ui.el('button', {
                        className: 'ppt-btn', textContent: 'Open', style: 'padding:2px 10px;font-size:11px',
                        title: `Open ${env.host} in a new tab`,
                        onclick: () => chrome.runtime.sendMessage({ type: 'open-tab', url: `https://${env.host}/`, active: true }),
                    })] : []),
                    env.isCurrent
                        ? ui.el('span', { textContent: 'current', style: 'color:var(--muted);font-size:11px' })
                        : ui.el('button', {
                            className: 'ppt-btn', textContent: 'Switch', style: 'padding:2px 10px;font-size:11px',
                            onclick: () => { closeDialog(); switchToEnvironment(env.envId); },
                        }),
                    ui.el('button', {
                        className: 'ppt-icon-btn', textContent: '✏️', title: 'Rename / regroup',
                        onclick: () => { editingId = env.envId; renderList(); },
                    }),
                    ui.el('button', {
                        className: 'ppt-icon-btn', textContent: '✕', title: 'Remove mapping',
                        onclick: async () => { await removeEnvironment(env.envId, store); await reload(); refresh(); },
                    }),
                ]);
            }

            // The group box suggests the groups already in use.
            function groupSuggest(input) {
                return ui.suggest({
                    input,
                    items: (text) => [...new Set(environments.map((e) => e.group).filter(Boolean))]
                        .filter((name) => name.toLowerCase() !== text.toLowerCase()
                            && (!text || name.toLowerCase().includes(text.toLowerCase())))
                        .sort((a, b) => a.localeCompare(b))
                        .map((name) => ({ label: name })),
                    onPick: (item) => { input.value = item.label; },
                });
            }

            function renderEditRow(env) {
                const nameInput = ui.el('input', { className: 'ppt-input', placeholder: 'Environment name', value: env.name });
                // Empty group = follow the name. Showing the derived value here
                // would read as two fields holding the same answer.
                const groupEdit = ui.el('input', {
                    className: 'ppt-input',
                    placeholder: env.derivedGroup ? `${env.derivedGroup} — detected` : 'Group',
                    value: env.explicitGroup,
                });
                const groupMenu = groupSuggest(groupEdit);
                const save = async () => {
                    const name = nameInput.value.trim();
                    await updateEnvironment(env.envId, {
                        name,
                        nameSource: name && name !== env.name ? 'user' : undefined,
                        group: groupEdit.value.trim(),
                    }, store);
                    editingId = null;
                    await reload();
                };
                for (const input of [nameInput, groupEdit]) {
                    input.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') { groupMenu.hide(); save(); }
                        if (e.key !== 'Escape') return;
                        // Escape closes the suggestions first, the editor second.
                        e.stopPropagation();
                        if (groupMenu.isOpen()) groupMenu.hide();
                        else { editingId = null; renderList(); }
                    });
                }
                const field = (label, input) => ui.el('div', { className: 'env-field' }, [
                    ui.el('span', { textContent: label }), input]);

                return ui.el('div', { className: 'env-edit' }, [
                    ui.el('code', { style: 'font-size:10px;color:var(--muted)', textContent: env.host ?? env.envId }),
                    field('Name', nameInput),
                    field('Group', groupMenu.node),
                    ui.el('div', { style: 'display:flex;gap:6px;justify-content:flex-end' }, [
                        ui.el('button', {
                            className: 'ppt-btn', textContent: 'Cancel', style: 'padding:2px 10px;font-size:11px',
                            onclick: () => { editingId = null; renderList(); },
                        }),
                        ui.el('button', {
                            className: 'ppt-btn primary', textContent: 'Save', style: 'padding:2px 10px;font-size:11px',
                            onclick: save,
                        }),
                    ]),
                ]);
            }

            let closeDialog = () => {};
            ui.modal({
                title: '🏷️ Environment Indicator',
                width: '520px',
                render: (body, close) => {
                    closeDialog = close;
                    if (envName || envId) {
                        body.append(ui.el('div', { className: 'ppt-note' }, [
                            ...(envName ? [ui.el('div', { textContent: `Environment: ${envName}` })] : []),
                            ...(envId ? [ui.el('div', { textContent: `ID: ${envId}` })] : []),
                        ]));
                    }

                    if (envId) {
                        body.append(
                            ui.el('label', { className: 'ppt-label', textContent: 'This environment is' }), select);
                    } else {
                        body.append(ui.el('div', {
                            className: 'ppt-note',
                            textContent: 'No environment detected on this page. Open a Power Platform environment to label it.',
                        }));
                    }

                    body.append(ui.el('label', { className: 'ppt-label', textContent: 'All saved environments' }), listEl);
                    // Labelling one environment at a time means visiting each;
                    // setup lists every one the user can access.
                    body.append(ui.el('button', {
                        className: 'ppt-btn', style: 'margin-top:10px',
                        textContent: '🔍 Find all my environments…',
                        title: 'List every environment you can access and label them in one go',
                        onclick: () => { close(); chrome.runtime.sendMessage({ type: 'open-setup', step: 'environments' }); },
                    }));
                    reload();
                },
                buttons: envId ? [{
                    label: 'Save', primary: true,
                    onClick: async (close) => {
                        if (select.value) {
                            await updateEnvironment(envId, {
                                type: select.value,
                                ...(envName ? { name: envName, nameSource: 'org' } : {}),
                            }, store);
                        } else {
                            await removeEnvironment(envId, store);
                        }
                        close();
                        refresh();
                    },
                }] : [],
            });
        }

        commands.register({
            toolId: 'environment-indicator',
            title: 'Configure Environment Indicator',
            icon: '🏷️', svg: 'tag',
            run: openConfigDialog,
        });

        // ── Lifecycle ────────────────────────────────────────────────────
        function refresh() {
            const envType = currentEnvType();
            if (envType) renderBadge(envType);
            else removeBadge();
            captureEnvironmentName();
        }

        const start = async () => {
            if (isDynamics) await resolveDynamicsEnvId();
            refresh();
            // One loop handles SPA navigation, header re-renders and repositioning.
            setInterval(refresh, 1500);
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
        else start();
    },
};
