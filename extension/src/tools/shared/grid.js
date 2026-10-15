// The grid a model-driven view has — a side panel holding a table whose
// column headers open a sort-and-filter menu, chips for the active filters
// and sorts, and a column picker — shared by Add Existing Components and the
// Record Browser. What a column can be filtered on, and how that becomes a
// query, stays with each tool: only the surface is shared here.

import * as ui from '../../core/ui.js';

export const GRID_STYLE = `
    .grid-backdrop {
        position: fixed; inset: 0; background: rgba(0,0,0,0.3);
        z-index: 2147483000; animation: ppt-fade 0.15s ease;
    }
    .grid-panel {
        position: fixed; top: 0; right: 0; bottom: 0;
        width: 82vw; min-width: 560px; max-width: 1400px;
        background: var(--bg); display: flex; flex-direction: column;
        box-shadow: -4px 0 24px rgba(0,0,0,0.18); animation: grid-slide 0.25s ease;
    }
    .grid-header, .grid-footer {
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        padding: 12px 24px; flex-shrink: 0;
    }
    .grid-header { border-bottom: 1px solid var(--border); }
    .grid-footer { border-top: 1px solid var(--border); background: var(--bg2); }
    .grid-header h2 { margin: 0; font-size: 17px; font-weight: 600; }
    .grid-toolbar {
        display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
        padding: 12px 24px 0; flex-shrink: 0;
    }
    .grid-toolbar .ppt-input, .grid-toolbar .ppt-select, .grid-footer .ppt-select { width: auto; padding: 6px 10px; font-size: 13px; }
    .grid-field { display: flex; flex-direction: column; gap: 2px; }
    .grid-field > span { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.3px; }
    .grid-chips { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; padding: 10px 24px 0; min-height: 10px; flex-shrink: 0; }
    .grid-chip {
        display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 10px;
        border-radius: 12px; font-size: 12px; background: var(--bg2);
        border: 1px solid var(--border); color: var(--text);
    }
    .grid-chip.sort { border-color: var(--accent); }
    .grid-chip button {
        border: none; background: none; color: var(--muted); cursor: pointer;
        font-size: 13px; padding: 0 4px; border-radius: 8px;
    }
    .grid-chip button:hover { background: var(--border); }
    .grid-link { border: none; background: none; color: var(--accent); cursor: pointer; font: inherit; font-size: 12px; padding: 2px 4px; }
    .grid-content { flex: 1; overflow: auto; margin: 10px 24px 12px; border: 1px solid var(--border); border-radius: 6px; position: relative; }
    .grid-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .grid-table th {
        text-align: left; padding: 0; font-weight: 600; color: var(--muted);
        font-size: 12px; border-bottom: 2px solid var(--border); background: var(--bg2);
        white-space: nowrap; position: sticky; top: 0; z-index: 1;
    }
    .grid-th-btn {
        display: flex; align-items: center; gap: 4px; width: 100%;
        padding: 8px 10px; border: none; background: none; color: inherit;
        font: inherit; cursor: pointer; text-align: left;
    }
    .grid-th-btn:hover { background: var(--border); }
    .grid-th-btn .ind { color: var(--accent); font-size: 11px; }
    .grid-table td { padding: 6px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
    .grid-table td.check, .grid-table th.check { width: 34px; text-align: center; padding: 6px 0; }
    .grid-table tbody tr { cursor: pointer; }
    .grid-table tbody tr:hover td { background: var(--bg2); }
    .grid-table tbody tr.selected td { background: color-mix(in srgb, var(--accent) 12%, var(--bg)); }
    .grid-mono { font-family: Consolas, monospace; font-size: 12px; word-break: break-all; }
    .grid-badge {
        display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px;
        font-weight: 600; background: var(--bg2); border: 1px solid var(--border); color: var(--muted);
    }
    .grid-dim { color: var(--muted); font-size: 12px; }
    .grid-status { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 24px 10px; flex-shrink: 0; }
    .grid-spinner {
        display: inline-block; width: 14px; height: 14px; flex-shrink: 0;
        border: 2px solid var(--border); border-top-color: var(--accent);
        border-radius: 50%; animation: grid-spin 0.7s linear infinite;
    }
    .grid-menu {
        position: fixed; z-index: 2147483050; min-width: 220px; max-width: 320px;
        background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
        box-shadow: var(--shadow); padding: 6px; font-size: 13px;
    }
    .grid-menu-item {
        display: block; width: 100%; padding: 7px 10px; border: none; background: none;
        color: var(--text); font: inherit; text-align: left; cursor: pointer; border-radius: 5px;
    }
    .grid-menu-item:hover { background: var(--bg2); }
    .grid-menu hr { border: none; border-top: 1px solid var(--border); margin: 4px 0; }
    .grid-menu .ppt-input, .grid-menu .ppt-select { padding: 6px 8px; font-size: 13px; margin-bottom: 6px; }
    .grid-menu-title { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; padding: 4px 6px 6px; }
    .grid-colpick { max-height: 50vh; overflow-y: auto; }
    .grid-colpick label { display: flex; gap: 8px; align-items: center; padding: 5px 8px; border-radius: 5px; cursor: pointer; }
    .grid-colpick label:hover { background: var(--bg2); }
    .grid-footer label { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
    @keyframes grid-slide { from { transform: translateX(100%); } }
    @keyframes grid-spin { to { transform: rotate(360deg); } }
`;

export const installGridStyle = () => ui.addStyle('grid', GRID_STYLE);

/**
 * Click on a column's sort: a plain click makes it the only sort, shift-click
 * adds it as the next key (or flips it if it is already one).
 */
export function applySort(sort, column, dir, additive) {
    if (!additive) return [{ column, dir }];
    const existing = sort.findIndex((s) => s.column === column);
    if (existing === -1) return [...sort, { column, dir }];
    return sort.map((s, i) => (i === existing ? { column, dir } : s));
}

/**
 * Popover menus inside `container` (the panel's backdrop), one open at a
 * time. open(anchor, build(menu, close)) places the menu under its anchor —
 * or above it when there is no room below — and closes it on an outside
 * click or Escape.
 */
export function createMenus(container) {
    let closeCurrent = () => {};
    return {
        open(anchor, build) {
            closeCurrent();
            const menu = ui.el('div', { className: 'ppt grid-menu' });
            build(menu, () => closeCurrent());
            container.appendChild(menu);
            const rect = anchor.getBoundingClientRect();
            const left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8);
            const top = rect.bottom + menu.offsetHeight + 8 > window.innerHeight
                ? Math.max(8, rect.top - menu.offsetHeight - 4) : rect.bottom + 4;
            menu.style.left = `${Math.max(8, left)}px`;
            menu.style.top = `${top}px`;
            const onDown = (e) => { if (!e.composedPath().includes(menu) && !e.composedPath().includes(anchor)) closeCurrent(); };
            const releaseEscape = ui.onEscape(() => closeCurrent());
            setTimeout(() => container.addEventListener('mousedown', onDown, true), 0);
            closeCurrent = () => {
                menu.remove();
                container.removeEventListener('mousedown', onDown, true);
                releaseEscape();
                closeCurrent = () => {};
            };
            return menu;
        },
        close: () => closeCurrent(),
    };
}

export const menuItem = (label, onClick) => ui.el('button', { className: 'grid-menu-item', textContent: label, onclick: onClick });

/** A filter or sort chip with its ✕. */
export const chip = (text, onRemove, { sort = false, removeTitle = 'Remove' } = {}) =>
    ui.el('span', { className: `grid-chip${sort ? ' sort' : ''}` }, [
        ui.el('span', { textContent: text }),
        ui.el('button', { textContent: '✕', title: removeTitle, onclick: onRemove }),
    ]);

/** How a sort on `column` reads on a chip: "2. Name ↑". */
export function sortChipText(sort, index, label) {
    return `${sort.length > 1 ? `${index + 1}. ` : ''}${label} ${sort[index].dir === 'asc' ? '↑' : '↓'}`;
}

/** A column header: its label, sort arrow (numbered when several), filter mark. */
export function headerButton({ label, sort, column, filtered, onClick, title = 'Sort and filter' }) {
    const sortIndex = sort.findIndex((s) => s.column === column);
    const button = ui.el('button', { className: 'grid-th-btn', title }, [
        ui.el('span', { textContent: label }),
        ui.el('span', {
            className: 'ind',
            textContent: (sortIndex === -1 ? '' : `${sort[sortIndex].dir === 'asc' ? '↑' : '↓'}${sort.length > 1 ? sortIndex + 1 : ''}`)
                + (filtered ? ' ⏷' : ''),
        }),
        ui.el('span', { style: 'margin-left:auto;opacity:0.6', textContent: '⌄' }),
    ]);
    button.addEventListener('click', () => onClick(button));
    return button;
}

/** A centred spinner with a line of text, for a grid that is loading. */
export const loadingBlock = (text) => ui.el('div', {
    style: 'display:flex;align-items:center;justify-content:center;gap:10px;padding:32px',
}, [ui.el('div', { className: 'grid-spinner' }), ui.el('span', { className: 'grid-dim', textContent: text })]);

/** The Dataverse message out of an HttpError body, or the error's own text. */
export function errorMessage(e) {
    try { return JSON.parse(e.body)?.error?.message ?? e.message; } catch { return e.message; }
}
