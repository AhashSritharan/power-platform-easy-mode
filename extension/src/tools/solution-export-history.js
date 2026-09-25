// Solution Export History (native).
// Lists every solution export this environment still holds and re-downloads the
// zip, however long ago it was taken.
//
// The source is `exportsolutionupload` — an ordinary, user-owned table that
// Dataverse never documents as an export history, but that is exactly what it
// is. Measured against a live org on 2026-08-14:
//
//   • Its primary key IS the ExportJobId. Feeding `exportsolutionuploadid`
//     straight to DownloadSolutionExportData returns the zip, so no handle has
//     to be kept from export time — the id is sitting in the table.
//   • Rows are kept for years, not hours: 1448 rows reaching back 23 months,
//     with no purge and no gaps beyond weekends. This is unrelated to the
//     180-day msdyn_solutionhistory purge; these are plain rows with file
//     attachments and they count against File storage.
//   • Only ASYNC exports are recorded. A synchronous /ExportSolution writes no
//     row at all, which is why solution-deployer.js exports via
//     ExportSolutionAsync — see the note above its exportSolution().
//   • GET .../exportsolutionuploads(<id>)/solutionfile/$value answers 400
//     despite solutionfile being a populated File column, so the download goes
//     through DownloadSolutionExportData rather than streaming from the column.
//
// Unlike msdyn_solutionhistory (virtual, silently ignores $select/$filter),
// this is a standard table: server-side filtering and @odata.nextLink paging
// both work, so the filter bar means what it says.

import { Dataverse } from '../core/dataverse.js';
import * as ui from '../core/ui.js';
import * as commands from '../core/commands.js';

let dataverse; // created in init() — modules must stay side-effect free at load

const STYLE = `
    .seh-backdrop {
        position: fixed; inset: 0; background: rgba(0,0,0,0.3);
        z-index: 2147483000; animation: ppt-fade 0.15s ease;
    }
    .seh-panel {
        position: fixed; top: 0; right: 0; bottom: 0;
        width: 58vw; min-width: 460px; max-width: 960px;
        background: var(--bg); display: flex; flex-direction: column;
        box-shadow: -4px 0 24px rgba(0,0,0,0.18);
        animation: seh-slide 0.25s ease;
    }
    .seh-header, .seh-footer {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 24px; flex-shrink: 0;
    }
    .seh-header { border-bottom: 1px solid var(--border); }
    .seh-footer { border-top: 1px solid var(--border); background: var(--bg2); }
    .seh-header h2 { margin: 0; font-size: 17px; font-weight: 600; }
    .seh-content { flex: 1; overflow-y: auto; padding: 16px 24px; }
    .seh-section { margin: 0 0 12px; display: flex; align-items: center; gap: 8px; }
    .seh-filterbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
    .seh-filterbar .ppt-input, .seh-filterbar .ppt-select { width: auto; padding: 6px 10px; font-size: 13px; }
    .seh-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .seh-table th {
        text-align: left; padding: 8px 10px; font-weight: 600; color: var(--muted);
        font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px;
        border-bottom: 2px solid var(--border); background: var(--bg2);
        white-space: nowrap; position: sticky; top: 0;
    }
    .seh-table td { padding: 6px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
    .seh-table tr:hover td { background: var(--bg2); }
    .seh-badge {
        display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px;
        border-radius: 12px; font-size: 11px; font-weight: 600; white-space: nowrap;
        background: var(--bg2); color: var(--muted); border: 1px solid var(--border);
    }
    .seh-spinner {
        display: inline-block; width: 14px; height: 14px; flex-shrink: 0;
        border: 2px solid var(--border); border-top-color: var(--accent);
        border-radius: 50%; animation: seh-spin 0.7s linear infinite;
    }
    .seh-loadmore {
        display: flex; align-items: center; justify-content: space-between;
        gap: 12px; padding: 10px 2px 0;
    }
    .seh-file { font-family: Consolas, monospace; font-size: 11px; color: var(--muted); word-break: break-all; }
    .seh-dim { color: var(--muted); font-size: 12px; }
    @keyframes seh-slide { from { transform: translateX(100%); } }
    @keyframes seh-spin { to { transform: rotate(360deg); } }
`;

// ── Formatting ────────────────────────────────────────────────────────────

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const date = new Date(dateStr);
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (date.toDateString() === new Date().toDateString()) return `Today ${time}`;
    return `${date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })} ${time}`;
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── Data access ───────────────────────────────────────────────────────────

// The two creator lookups are selected for their formatted values, not their
// guids: the annotation carrying the name only comes back when the lookup
// itself is in the projection.
//
// Both are needed because `createdby` is "SYSTEM" on every row — exports run
// under impersonation, so the actor that matters sits in `createdonbehalfby`.
// That is also the field that tells a scheduled export apart from one somebody
// took by hand.
const FIELDS = 'exportsolutionuploadid,solutionuniquename,solutionfilename,createdon,'
    + '_createdby_value,_createdonbehalfby_value';
const PAGE_SIZE = 25;
const INCLUDE_FORMATTED = 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"';

const odataQuote = (value) => value.replace(/'/g, "''");

function fetchExports(filters, nextLink) {
    const headers = { Prefer: `${INCLUDE_FORMATTED},odata.maxpagesize=${PAGE_SIZE}` };
    if (nextLink) return dataverse.get(nextLink, headers);

    const conditions = [];
    const name = filters.name.trim();
    if (name) conditions.push(`contains(solutionuniquename,'${odataQuote(name)}')`);
    if (filters.from) conditions.push(`createdon ge ${new Date(`${filters.from}T00:00:00`).toISOString()}`);
    if (filters.to) conditions.push(`createdon le ${new Date(`${filters.to}T23:59:59.999`).toISOString()}`);
    const filter = conditions.length ? `&$filter=${conditions.join(' and ')}` : '';

    return dataverse.get(
        `/exportsolutionuploads?$select=${FIELDS}${filter}&$orderby=createdon desc&$count=true`,
        headers);
}

/** The exported zip, by way of the row id — which is the ExportJobId. */
async function downloadExport(exportJobId) {
    const result = await dataverse.send('POST', '/DownloadSolutionExportData', { ExportJobId: exportJobId });
    const base64 = result?.ExportSolutionFile;
    if (!base64) throw new Error('The environment returned no file for this export.');
    return base64;
}

// Kept off the main string: a multi-megabyte base64 blob decoded in one pass
// holds the string, a binary string and the byte array live at the same time.
function base64ToBlob(base64, type = 'application/zip') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type });
}

function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = ui.el('a', { href: url, download: filename });
    link.click();
    // Revoking immediately can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ── Rows ──────────────────────────────────────────────────────────────────

export function exportRow(record) {
    return {
        id: record.exportsolutionuploadid,
        solution: record.solutionuniquename || '—',
        file: record.solutionfilename || '',
        createdOn: record.createdon,
        // The delegate first: `createdby` reads "SYSTEM" on impersonated
        // exports, which is every export a scheduled job or an app registration
        // takes — so it names nobody useful whenever it is the only one read.
        createdBy: record['_createdonbehalfby_value@OData.Community.Display.V1.FormattedValue']
            || record['_createdby_value@OData.Community.Display.V1.FormattedValue']
            || '',
    };
}

/** The filename to save as — the stored one already carries a unique suffix. */
export function downloadName(row) {
    if (row.file) return row.file;
    const stamp = (row.createdOn ?? '').replace(/[-:]/g, '').replace(/\..*$/, '');
    return `${row.solution}_${stamp || 'export'}.zip`;
}

// ── Panel ─────────────────────────────────────────────────────────────────

let panelOpen = false;

function openPanel() {
    if (panelOpen) return;
    panelOpen = true;

    const state = {
        filters: { name: '', from: '', to: '' },
        rows: [],
        nextLink: null,
        total: null,
        loading: false,
        error: null,
        seq: 0, // discards out-of-order responses while typing
    };

    const backdrop = ui.mount(ui.el('div', { className: 'ppt seh-backdrop' }));
    let releaseEscape = () => {};
    const dispose = () => {
        panelOpen = false;
        backdrop.remove();
        releaseEscape();
    };
    releaseEscape = ui.onEscape(dispose);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) dispose(); });

    const countBadge = ui.el('span', { className: 'seh-badge', textContent: '…' });
    const listContainer = ui.el('div');

    // Built once so the inputs keep focus across re-renders.
    const nameInput = ui.el('input', {
        className: 'ppt-input', type: 'text', placeholder: '🔍 Solution name…',
        style: 'flex:1;min-width:150px',
    });
    const fromInput = ui.el('input', { className: 'ppt-input', type: 'date', title: 'Exported on or after' });
    const toInput = ui.el('input', { className: 'ppt-input', type: 'date', title: 'Exported on or before' });
    const clearButton = ui.el('button', {
        className: 'ppt-btn', textContent: 'Clear', title: 'Clear all filters',
        onclick: () => {
            nameInput.value = fromInput.value = toInput.value = '';
            state.filters = { name: '', from: '', to: '' };
            reload();
        },
    });
    const filterBar = ui.el('div', { className: 'seh-filterbar' }, [
        nameInput, fromInput,
        ui.el('span', { className: 'seh-dim', textContent: '–' }),
        toInput, clearButton,
    ]);

    function renderDownloadCell(row) {
        const cell = ui.el('td', { style: 'text-align:center;white-space:nowrap' });
        const status = ui.el('span', { className: 'seh-dim', style: 'margin-left:6px' });
        const button = ui.el('button', {
            className: 'ppt-btn', style: 'padding:3px 8px;font-size:11px',
            textContent: '⬇ Download',
        });
        button.addEventListener('click', async () => {
            button.disabled = true;
            button.textContent = 'Downloading…';
            status.textContent = '';
            try {
                const base64 = await downloadExport(row.id);
                const blob = base64ToBlob(base64);
                saveBlob(blob, downloadName(row));
                button.textContent = '⬇ Download';
                status.textContent = formatSize(blob.size);
            } catch (e) {
                button.textContent = '⬇ Retry';
                status.textContent = e.message;
                status.style.color = 'var(--danger)';
            } finally {
                button.disabled = false;
            }
        });
        cell.append(button, status);
        return cell;
    }

    function renderTable(rows) {
        const table = ui.el('table', { className: 'seh-table' });
        table.innerHTML = '<thead><tr><th>Solution</th><th>Exported</th><th>By</th><th>File</th>'
            + '<th style="text-align:center">Download</th></tr></thead>';
        const tbody = ui.el('tbody');
        for (const row of rows) {
            const tr = ui.el('tr');
            tr.append(
                ui.el('td', { style: 'font-weight:600', textContent: row.solution }),
                ui.el('td', { className: 'seh-dim', style: 'white-space:nowrap', textContent: formatDate(row.createdOn) }),
                ui.el('td', { className: 'seh-dim', textContent: row.createdBy || '—' }),
                ui.el('td', { className: 'seh-file', textContent: row.file || '—' }),
                renderDownloadCell(row),
            );
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        return ui.el('div', { style: 'border:1px solid var(--border);border-radius:6px;overflow:hidden' }, [table]);
    }

    function render() {
        listContainer.replaceChildren();

        if (state.error) {
            listContainer.appendChild(ui.el('div', {
                className: 'ppt-note', style: 'color:var(--danger)',
                textContent: `Could not load export history: ${state.error}`,
            }));
            countBadge.textContent = '—';
            return;
        }
        if (state.loading && !state.rows.length) {
            listContainer.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;gap:10px;padding:32px">'
                + '<div class="seh-spinner"></div><span class="seh-dim">Loading export history…</span></div>';
            return;
        }

        countBadge.textContent = state.total != null ? String(state.total) : String(state.rows.length);

        if (!state.rows.length) {
            listContainer.appendChild(ui.el('div', {
                className: 'ppt-note', style: 'text-align:center;padding:24px',
                textContent: '📭 No exports match these filters.',
            }));
        } else {
            listContainer.appendChild(renderTable(state.rows));
        }

        const shown = state.total != null
            ? `Showing ${state.rows.length} of ${state.total}`
            : `Showing ${state.rows.length}`;
        const footer = ui.el('div', { className: 'seh-loadmore' }, [
            ui.el('span', { className: 'seh-dim', textContent: shown }),
        ]);
        if (state.nextLink) {
            footer.appendChild(ui.el('button', {
                className: 'ppt-btn',
                textContent: state.loading ? 'Loading…' : `⬇ Load ${PAGE_SIZE} more`,
                disabled: state.loading,
                onclick: () => loadPage(),
            }));
        }
        listContainer.appendChild(footer);

        listContainer.appendChild(ui.el('div', {
            className: 'seh-dim', style: 'margin-top:10px',
            textContent: 'Only asynchronous exports are recorded here — a solution exported with the '
                + 'synchronous action leaves no row behind.',
        }));
    }

    async function loadPage({ initial = false } = {}) {
        const seq = ++state.seq;
        state.loading = true;
        state.error = null;
        render();

        try {
            const data = await fetchExports(state.filters, initial ? null : state.nextLink);
            if (seq !== state.seq || !panelOpen) return;
            state.rows.push(...(data.value ?? []).map(exportRow));
            state.nextLink = data['@odata.nextLink'] ?? null;
            if (data['@odata.count'] != null) state.total = data['@odata.count'];
        } catch (e) {
            if (seq !== state.seq || !panelOpen) return;
            state.error = e.message;
        } finally {
            if (seq === state.seq) {
                state.loading = false;
                render();
            }
        }
    }

    function reload() {
        state.rows = [];
        state.nextLink = null;
        state.total = null;
        loadPage({ initial: true });
    }

    let nameDebounce = null;
    nameInput.addEventListener('input', () => {
        state.filters.name = nameInput.value;
        clearTimeout(nameDebounce);
        nameDebounce = setTimeout(reload, 350);
    });
    for (const [input, key] of [[fromInput, 'from'], [toInput, 'to']]) {
        input.addEventListener('change', () => {
            state.filters[key] = input.value;
            reload();
        });
    }

    const panel = ui.el('div', { className: 'seh-panel' }, [
        ui.el('div', { className: 'seh-header' }, [
            ui.el('h2', { textContent: '📥 Solution Export History' }),
            ui.el('button', { className: 'ppt-icon-btn', textContent: '✕', title: 'Close', onclick: dispose }),
        ]),
        ui.el('div', { className: 'seh-content' }, [
            ui.el('div', { className: 'seh-section' }, [
                ui.el('span', { className: 'ppt-label', style: 'margin:0', textContent: 'Exports' }),
                countBadge,
            ]),
            filterBar,
            listContainer,
        ]),
        ui.el('div', { className: 'seh-footer' }, [
            ui.el('span', { className: 'seh-dim', textContent: 'Exports are kept by the environment for years.' }),
            ui.el('button', { className: 'ppt-btn', textContent: '🔄 Refresh', onclick: reload }),
        ]),
    ]);
    backdrop.appendChild(panel);

    reload();
}

export default {
    init() {
        dataverse = new Dataverse();
        ui.addStyle('seh', STYLE);
        commands.register({
            toolId: 'solution-export-history',
            title: 'Open Solution Export History',
            icon: '📥',
            run: openPanel,
        });
    },
};
