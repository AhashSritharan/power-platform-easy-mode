// The API key and workspace part of the Clockify tools' settings dialogs.
//
// Like setup: Connect checks the key and lists the workspaces it can reach to
// choose from, rather than asking for a workspace id copied off a URL. A saved
// key connects by itself when the dialog opens.

import * as ui from '../../core/ui.js';
import { request, HttpError } from '../../core/http.js';
import { CLOCKIFY_API, preferredWorkspace } from './clockify-settings.js';

async function clockifyGet(path, apiKey) {
    try {
        return (await request({ url: CLOCKIFY_API + path, headers: { 'X-Api-Key': apiKey } })).json();
    } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        if (e.status === 401) throw new Error('Clockify did not accept that API key.');
        let message;
        try { message = JSON.parse(e.body)?.message; } catch { /* not json */ }
        throw new Error(message || `Clockify answered ${e.status}.`);
    }
}

/**
 * The fields for `settings` ({ apiKey, workspaceId }): append `nodes` to the
 * dialog, and save what `read()` returns — { apiKey, workspaceId } and, once
 * connected with that key, its userId.
 */
export function clockifyConnectionFields(settings, { keyLabel = 'Clockify API key' } = {}) {
    const keyInput = ui.el('input', {
        id: 'ppt-clockify-key', className: 'ppt-input', type: 'password', autocomplete: 'off',
        value: settings.apiKey, placeholder: 'From Clockify → Profile → API',
    });
    const connectButton = ui.el('button', { className: 'ppt-btn', type: 'button', textContent: 'Connect' });
    const status = ui.el('div', { className: 'ppt-note', role: 'status', hidden: true });
    const select = ui.el('select', { id: 'ppt-clockify-workspace', className: 'ppt-select', disabled: true });
    const placeholder = () => select.replaceChildren(ui.el('option', { value: '', textContent: 'Connect to choose a workspace' }));
    placeholder();

    let connected = null; // { apiKey, userId }
    let attempt = 0;
    const say = (text) => { status.textContent = text; status.hidden = !text; };

    async function connect() {
        const apiKey = keyInput.value.trim();
        if (!apiKey) { say('Enter your API key first.'); return; }
        const mine = ++attempt;
        say('Connecting…');
        try {
            const [user, workspaces] = await Promise.all([clockifyGet('/user', apiKey), clockifyGet('/workspaces', apiKey)]);
            if (mine !== attempt) return;
            connected = { apiKey, userId: user.id };
            // Connecting again keeps the workspace picked on screen.
            const chosen = select.value || settings.workspaceId;
            select.replaceChildren(...workspaces.map((ws) => ui.el('option', { value: ws.id, textContent: ws.name })));
            select.disabled = !workspaces.length;
            select.value = preferredWorkspace(workspaces, user, chosen);
            say(`✅ Connected as ${user.name}`);
        } catch (e) {
            if (mine !== attempt) return;
            say(`❌ ${e.message}`);
        }
    }
    connectButton.addEventListener('click', connect);
    // Another key may reach other workspaces: connect again to choose.
    keyInput.addEventListener('input', () => {
        if (!connected) return;
        connected = null;
        attempt++;
        select.disabled = true;
        placeholder();
        say('');
    });
    if (settings.apiKey) connect();

    return {
        nodes: [
            ui.el('label', { className: 'ppt-label', htmlFor: keyInput.id, textContent: keyLabel }),
            ui.el('div', { style: 'display:flex; gap:8px' }, [keyInput, connectButton]),
            status,
            ui.el('label', { className: 'ppt-label', htmlFor: select.id, textContent: 'Workspace' }),
            select,
        ],
        read() {
            const apiKey = keyInput.value.trim();
            return {
                apiKey,
                workspaceId: select.disabled ? settings.workspaceId : select.value,
                ...(connected?.apiKey === apiKey ? { userId: connected.userId } : {}),
            };
        },
    };
}
