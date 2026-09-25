// Relationship Opener (native).
// Adds "Manage Relationship" to the Advanced (…) context menu on the Power
// Apps Relationships page and opens the classic manage-relationship dialog in
// a modal iframe. Supports 1:n, n:1 and n:n relationships.
//
// The Dynamics org URL for the current environment is resolved from the
// Environment Indicator's shared hostname cache when available, otherwise the
// user is asked once and the answer is remembered per environment.

import { request } from '../core/http.js';
import { createStore } from '../core/storage.js';
import * as ui from '../core/ui.js';
import * as commands from '../core/commands.js';

const DIALOG_PATH = '/tools/systemcustomization/relationships/manageRelationship.aspx';
const REFERENCE_KEY = 'ShowDependencies';
const BUTTON_ID = 'ppt-manage-rel-item';
const ROUTE = /\/solutions\/[^/]+\/entities\/[^/]+\/relationships/;

export default {
    async init({ store }) {
        const envIndicatorStore = createStore('environment-indicator');
        let orgUrlCache = await store.get('orgUrlCache', {}); // envId -> org URL

        const currentEnvId = () =>
            location.pathname.match(/\/environments\/([a-f0-9-]+)/i)?.[1]?.toLowerCase() ?? null;

        // ── Org URL resolution ───────────────────────────────────────────
        async function resolveOrgUrl() {
            const envId = currentEnvId();
            if (envId && orgUrlCache[envId]) return orgUrlCache[envId];

            // Environment Indicator's hostname cache maps org host -> env id
            if (envId) {
                const hostCache = await envIndicatorStore.get('envIndicator_hostCache', {});
                const host = Object.entries(hostCache).find(([, id]) => id === envId)?.[0];
                if (host) {
                    orgUrlCache[envId] = `https://${host}`;
                    await store.set('orgUrlCache', orgUrlCache);
                    return orgUrlCache[envId];
                }
            }

            return promptForOrgUrl(envId);
        }

        function promptForOrgUrl(envId) {
            return new Promise((resolve) => {
                const input = ui.el('input', {
                    className: 'ppt-input',
                    type: 'url',
                    placeholder: 'https://yourorg.crm.dynamics.com',
                });
                let savedUrl = null;

                const close = ui.modal({
                    title: '🔗 Dynamics environment URL',
                    render: (body) => {
                        body.append(
                            ui.el('div', {
                                className: 'ppt-note',
                                textContent: 'Enter the Dynamics 365 URL of this environment. It is remembered locally for next time.',
                            }),
                            input,
                        );
                        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
                        setTimeout(() => input.focus(), 0);
                    },
                    buttons: [{ label: 'Save', primary: true, onClick: () => save() }],
                    onClose: () => resolve(savedUrl), // null when dismissed without saving
                });

                async function save() {
                    const raw = input.value.trim();
                    if (!raw.includes('dynamics.com')) { ui.toast('⚠️ Enter a *.dynamics.com URL'); return; }
                    const url = raw.replace(/\/$/, '').split('/main.aspx')[0];
                    if (envId) {
                        orgUrlCache[envId] = url;
                        await store.set('orgUrlCache', orgUrlCache);
                    }
                    savedUrl = url;
                    close();
                }
            });
        }

        commands.register({
            toolId: 'relationship-opener',
            title: 'Clear Dynamics URL cache',
            icon: '🔗',
            run: async () => {
                orgUrlCache = {};
                await store.remove('orgUrlCache');
                ui.toast('Dynamics URL cache cleared.');
            },
        });

        // ── Relationship lookup ──────────────────────────────────────────
        async function fetchRelationshipId(orgUrl, relType, entityId, schema) {
            try {
                const response = await request({
                    url: `${orgUrl}/api/data/v9.2/EntityDefinitions(${entityId})/${relType}`
                        + `?$select=MetadataId&$filter=SchemaName eq '${schema}'`,
                    headers: { 'Accept': 'application/json' },
                    credentials: true,
                });
                return response.json().value?.[0]?.MetadataId ?? null;
            } catch (e) {
                console.warn(`[Relationship Opener] ${relType} lookup failed:`, e);
                return null;
            }
        }

        function openDialogModal(orgUrl, relationshipId, entityId, solutionId, role) {
            const url = orgUrl + DIALOG_PATH
                + `?entityRole=${role}`
                + `&entityRelationshipId=${encodeURIComponent(relationshipId)}`
                + `&entityId=${encodeURIComponent(entityId)}`
                + `&appSolutionId=${encodeURIComponent(solutionId)}`;

            ui.modal({
                title: 'Manage Relationship',
                width: 'min(1200px, 92vw)',
                render: (body) => {
                    body.style.cssText = 'padding:0;height:75vh;display:flex;flex-direction:column';
                    const loading = ui.el('div', {
                        className: 'ppt-note',
                        textContent: 'Loading relationship editor…',
                        style: 'margin:16px 20px',
                    });
                    const iframe = ui.el('iframe', {
                        src: url,
                        style: 'flex:1;width:100%;border:none;display:none',
                    });
                    iframe.addEventListener('load', () => { loading.remove(); iframe.style.display = 'block'; });
                    body.append(loading, iframe);
                },
            });
        }

        async function onManageRelationship() {
            const selected = document.querySelector('.ms-DetailsRow.is-selected [data-automation-key="uniqueName"]');
            if (!selected) { ui.toast('⚠️ Select a relationship row first.'); return; }
            const schema = selected.textContent.trim();

            const parts = location.pathname.split('/');
            const solutionId = parts[4];
            const entityId = parts[6];

            const orgUrl = await resolveOrgUrl();
            if (!orgUrl) return;

            ui.toast('Looking up relationship…');
            // Try n:1, then 1:n, then n:n — the dialog role differs per type.
            const attempts = [
                ['ManyToOneRelationships', 'referencing'],
                ['OneToManyRelationships', 'referenced'],
                ['ManyToManyRelationships', 'referencing'],
            ];
            for (const [relType, role] of attempts) {
                const relationshipId = await fetchRelationshipId(orgUrl, relType, entityId, schema);
                if (relationshipId) {
                    openDialogModal(orgUrl, relationshipId, entityId, solutionId, role);
                    return;
                }
            }
            ui.toast(`❌ No 1:n, n:1 or n:n relationship found with schema name "${schema}".`, 4500);
        }

        // ── Context-menu button injection ────────────────────────────────
        function insertButton(menuList) {
            if (menuList.querySelector(`#${BUTTON_ID}`)) return;
            const refBtn = menuList.querySelector(`[data-test-key="${REFERENCE_KEY}"]`);
            if (!refBtn) return;

            const li = document.createElement('li');
            li.setAttribute('role', 'presentation');
            li.id = BUTTON_ID;
            li.className = refBtn.closest('li')?.className ?? '';

            const btn = document.createElement('button');
            for (const attr of refBtn.attributes) btn.setAttribute(attr.name, attr.value);
            btn.setAttribute('data-test-key', 'ManageRelationship');
            btn.innerHTML = refBtn.innerHTML
                .replace(/data-icon-name="[^"]*"/, 'data-icon-name="Relationship"')
                .replace(refBtn.querySelector('.ms-ContextualMenu-itemText')?.textContent ?? '', 'Manage Relationship');

            btn.addEventListener('click', () => {
                btn.closest('.ms-ContextualMenu')?.remove();
                document.querySelector('.ms-Layer--fixed')?.click(); // dismiss the menu layer
                onManageRelationship();
            });

            li.appendChild(btn);
            menuList.appendChild(li);
        }

        let observer = null;

        function onMutations(records) {
            for (const record of records) {
                for (const node of record.addedNodes) {
                    if (!(node instanceof HTMLElement)) continue;
                    const menu = node.querySelector('.ms-ContextualMenu-list');
                    if (menu?.querySelector(`[data-test-key="${REFERENCE_KEY}"]`)) insertButton(menu);
                }
            }
        }

        function checkRoute() {
            const onPage = ROUTE.test(location.pathname);
            if (onPage && !observer) {
                observer = new MutationObserver(onMutations);
                observer.observe(document.body, { childList: true, subtree: true });
            } else if (!onPage && observer) {
                observer.disconnect();
                observer = null;
                document.querySelectorAll(`#${BUTTON_ID}`).forEach((li) => li.remove());
            }
        }

        const start = () => {
            checkRoute();
            setInterval(checkRoute, 500); // SPA navigation detection
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
        else start();
    },
};
