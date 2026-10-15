// Shadow-DOM UI kit shared by all native tools.
//
// Everything renders inside one shadow root attached to <html>, so tool UI
// can never collide with host-page CSS (and vice versa). Fluent-flavored,
// light/dark aware.

import { icon } from './icons.js';

let shadowRoot = null;

const BASE_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .ppt {
        font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
        font-size: 14px;
        line-height: 1.5;
        color: var(--text);
        --text: #242424; --muted: #616161; --bg: #ffffff; --bg2: #f5f5f5;
        --border: #e0e0e0; --accent: #0f6cbd; --accent-hover: #115ea3;
        --danger: #d13438; --shadow: 0 8px 32px rgba(0,0,0,0.24);
    }
    @media (prefers-color-scheme: dark) {
        .ppt {
            --text: #e8e8e8; --muted: #9ca3af; --bg: #242424; --bg2: #2f2f2f;
            --border: #3a3a3a; --accent: #479ef5; --accent-hover: #62abf5;
            --danger: #f1707b; --shadow: 0 8px 32px rgba(0,0,0,0.6);
        }
    }
    .ppt-backdrop {
        position: fixed; inset: 0; background: rgba(0,0,0,0.4);
        z-index: 2147483000; display: flex; align-items: flex-start; justify-content: center;
        animation: ppt-fade 0.15s ease;
    }
    .ppt-dialog {
        background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
        box-shadow: var(--shadow); margin-top: 10vh; width: 480px; max-width: 92vw;
        max-height: 80vh; display: flex; flex-direction: column;
        animation: ppt-pop 0.15s ease;
    }
    .ppt-dialog-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 16px 20px 0;
    }
    .ppt-dialog-header h2 { margin: 0; font-size: 17px; font-weight: 600; }
    .ppt-dialog-body { padding: 16px 20px; overflow-y: auto; }
    .ppt-dialog-footer {
        display: flex; gap: 8px; justify-content: flex-end;
        padding: 0 20px 16px;
    }
    .ppt-btn {
        font: inherit; padding: 7px 16px; border-radius: 5px; cursor: pointer;
        border: 1px solid var(--border); background: var(--bg); color: var(--text);
        font-weight: 600; font-size: 13px;
    }
    .ppt-btn:hover { background: var(--bg2); }
    .ppt-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .ppt-btn.primary:hover { background: var(--accent-hover); }
    .ppt-btn.danger { color: var(--danger); }
    .ppt-icon-btn {
        background: transparent; border: none; cursor: pointer; color: var(--muted);
        font-size: 18px; line-height: 1; padding: 6px; border-radius: 4px;
    }
    .ppt-icon-btn:hover { background: var(--bg2); }
    .ppt-input, .ppt-select {
        font: inherit; width: 100%; padding: 8px 12px; border-radius: 5px;
        border: 1px solid var(--border); background: var(--bg); color: var(--text);
    }
    .ppt-input:focus, .ppt-select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
    .ppt-label {
        display: block; font-weight: 600; color: var(--muted); font-size: 11px;
        text-transform: uppercase; letter-spacing: 0.5px; margin: 12px 0 6px;
    }
    .ppt-note {
        padding: 10px 14px; background: var(--bg2); border-radius: 6px;
        font-size: 13px; color: var(--muted); margin-bottom: 8px; word-break: break-all;
    }
    /* Dismissing a toast only fades it out — the node stays mounted for reuse.
       Without pointer-events:none an invisible box would keep swallowing clicks
       in the bottom-right corner, right where panel footer buttons sit. */
    .ppt-toast {
        position: fixed; bottom: 24px; right: 24px; z-index: 2147483100;
        pointer-events: none;
        background: var(--bg); color: var(--text); border: 1px solid var(--border);
        border-radius: 8px; padding: 12px 16px; font-size: 13px; max-width: 340px;
        box-shadow: var(--shadow); opacity: 0; transform: translateY(8px);
        transition: opacity 0.2s ease, transform 0.2s ease; word-break: break-word;
    }
    .ppt-toast.visible { opacity: 1; transform: translateY(0); }
    .ppt-palette-list { max-height: 60vh; overflow-y: auto; margin-top: 8px; padding: 2px; }
    .ppt-palette-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; }
    .ppt-palette-card {
        display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
        min-height: 92px; padding: 12px 8px; border: 1px solid var(--border);
        border-top: 3px solid var(--tile, var(--border)); border-radius: 10px;
        background: none; color: var(--text); font: inherit; text-align: center; cursor: pointer;
        transition: background 0.1s, border-color 0.1s;
    }
    .ppt-palette-card:hover, .ppt-palette-card.active { background: var(--bg2); border-color: var(--tile, var(--accent)); }
    .ppt-palette-card .icon {
        width: 40px; height: 40px; border-radius: 10px; font-size: 22px; line-height: 1;
        display: flex; align-items: center; justify-content: center;
        background: color-mix(in srgb, var(--tile, var(--muted)) 18%, transparent);
        color: var(--tile, var(--text));
    }
    .ppt-palette-card .title {
        font-size: 12px; line-height: 1.25; font-weight: 500;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .ppt-palette-card .sub {
        font-size: 11px; color: var(--muted); max-width: 100%;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ppt-palette-rows { display: flex; flex-direction: column; gap: 2px; }
    .ppt-palette-item {
        display: flex; align-items: center; gap: 10px; width: 100%;
        padding: 7px 12px; border: none; background: none; color: var(--text);
        font: inherit; text-align: left; cursor: pointer; border-radius: 6px;
    }
    .ppt-palette-item:hover, .ppt-palette-item.active { background: var(--bg2); }
    .ppt-palette-item .icon {
        flex-shrink: 0; width: 28px; height: 28px; border-radius: 7px;
        display: flex; align-items: center; justify-content: center; font-size: 15px; line-height: 1;
        background: color-mix(in srgb, var(--tile, var(--muted)) 18%, transparent);
        color: var(--tile, var(--text));
    }
    .ppt-palette-item .text { min-width: 0; }
    .ppt-palette-item .title { font-weight: 500; }
    .ppt-palette-item .sub {
        color: var(--muted); font-size: 12px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ppt-palette-group {
        display: flex; align-items: center; gap: 6px;
        margin: 10px 12px 4px; font-size: 11px; font-weight: 600;
        text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted);
    }
    .ppt-palette-group::before {
        content: ''; width: 8px; height: 8px; border-radius: 50%;
        background: var(--tile, var(--muted));
    }
    .ppt-palette-group:first-child { margin-top: 2px; }
    /* The area colors are tuned for light; lift the glyph to keep contrast on dark. */
    @media (prefers-color-scheme: dark) {
        .ppt-palette-item .icon, .ppt-palette-card .icon { color: color-mix(in srgb, var(--tile, var(--text)) 60%, white); }
    }
    /* Suggestions under a text input (see suggest): a themed stand-in for
       <datalist>, whose popup is browser chrome and ignores the theme. */
    .ppt-ac-wrap { position: relative; }
    .ppt-ac {
        display: none; position: fixed; z-index: 2147483060; overflow-y: auto;
        background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
        box-shadow: var(--shadow); padding: 4px;
    }
    .ppt-ac-item {
        display: flex; flex-direction: column; gap: 1px; padding: 6px 10px;
        border-radius: 4px; cursor: pointer; font-size: 13px; color: var(--text);
    }
    .ppt-ac-item:hover, .ppt-ac-item.active { background: var(--bg2); }
    .ppt-ac-sub { font-size: 11px; color: var(--muted); font-family: Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ppt-ac-msg { padding: 8px 10px; font-size: 13px; color: var(--muted); }
    .ppt-ac-head {
        padding: 6px 10px 4px; font-size: 11px; font-weight: 600; color: var(--muted);
        text-transform: uppercase; letter-spacing: 0.5px;
    }
    .ppt-panel {
        position: fixed; z-index: 2147483000;
        background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
        box-shadow: var(--shadow); display: flex; flex-direction: column;
        max-height: 82vh; animation: ppt-pop 0.15s ease;
    }
    /* Panels leave scrolling to their content, so a long list scrolls inside
       its own box with the controls above it pinned — rather than the body and
       the list each growing a scrollbar. */
    .ppt-panel > .ppt-dialog-body {
        overflow: hidden; display: flex; flex-direction: column; min-height: 0;
    }
    @keyframes ppt-fade { from { opacity: 0; } }
    @keyframes ppt-pop { from { transform: scale(0.97); opacity: 0; } }
`;

// Every live shadow root, and the tool stylesheets added so far, so a surface
// created later still gets the styles a tool registered earlier.
const roots = new Set();
const styles = [];

const defaultParent = () => document.body ?? document.documentElement;

function newRoot(parent) {
    const host = document.createElement('ppt-ui');
    (parent ?? defaultParent()).appendChild(host);
    const shadow = host.attachShadow({ mode: 'closed' });
    const base = document.createElement('style');
    base.textContent = BASE_CSS;
    shadow.appendChild(base);
    for (const css of styles) {
        const style = document.createElement('style');
        style.textContent = css;
        shadow.appendChild(style);
    }
    shadow.addEventListener('keydown', restoreCancelledEditing);
    roots.add(shadow);
    return shadow;
}

/**
 * Editing keys inside our own text boxes, applied by hand when the page
 * cancelled them.
 *
 * Rich host pages cancel keys at the window level: Backspace to stop the
 * browser navigating back, Ctrl+A to select their own grid or canvas. A
 * cancelled keydown cancels the default action in EVERY focused box on the
 * page, ours included, so typing works but deleting or selecting all does
 * nothing. Which listener runs first is not ours to decide, so wait until
 * dispatch has finished and, only if the default was taken away, do the edit
 * here and announce it with the `input` event listeners expect.
 */
function restoreCancelledEditing(event) {
    const input = event.target;
    const typable = input?.tagName === 'TEXTAREA'
        || (input?.tagName === 'INPUT' && ['text', 'search', 'url', 'email', 'number', ''].includes(input.type));
    if (!typable || event.altKey) return;
    const mod = event.ctrlKey || event.metaKey;
    const selectAll = mod && event.key.toLowerCase() === 'a' && !event.shiftKey;
    const remove = !mod && (event.key === 'Backspace' || event.key === 'Delete');
    if (!selectAll && !remove) return;

    setTimeout(() => {
        if (!event.defaultPrevented || input.readOnly || input.disabled) return;
        if (selectAll) { input.select(); return; }
        if (input.type === 'number') return; // no selection API; leave it be
        const value = input.value ?? '';
        const start = input.selectionStart ?? value.length;
        const end = input.selectionEnd ?? start;
        const [from, to] = start !== end
            ? [start, end]
            : event.key === 'Backspace'
                ? [Math.max(0, start - 1), start]
                : [start, Math.min(value.length, start + 1)];
        if (from === to) return;
        input.value = value.slice(0, from) + value.slice(to);
        input.setSelectionRange(from, from);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }, 0);
}

function root() {
    if (shadowRoot?.host.isConnected) return shadowRoot;
    shadowRoot = newRoot(defaultParent());
    return shadowRoot;
}

/**
 * An independent shadow surface that can be re-parented.
 *
 * Mounting a toolbox surface *inside* a host-page popover is what stops that
 * popover treating our clicks as a click outside itself — containment and
 * focus-subtree checks both pass, whichever one it uses to decide to dismiss.
 * The shadow root still keeps our styles off the page and the page's off us.
 */
export function surface(parent) {
    const shadow = newRoot(parent);
    return {
        root: shadow,
        get host() { return shadow.host; },
        moveTo(next) {
            const target = next ?? defaultParent();
            if (shadow.host.parentElement !== target) target.appendChild(shadow.host);
        },
        destroy() {
            roots.delete(shadow);
            shadow.host.remove();
        },
    };
}

/** Tiny element builder: el('div', { className, textContent, onclick, ... }, children) */
export function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const child of children) node.append(child);
    return node;
}

let toastNode = null;
let toastTimer = null;
let toastSeq = 0;

export function toast(message, duration = 3000) {
    if (!toastNode?.isConnected) {
        toastNode = el('div', { className: 'ppt ppt-toast' });
        root().appendChild(toastNode);
    }
    clearTimeout(toastTimer);
    toastNode.textContent = message;
    // Start the hide timer only once the toast is shown. Background tabs hold
    // animation frames but not timers, so a toast raised there used to hide
    // first and then show on return, with nothing left to hide it again.
    const token = ++toastSeq;
    requestAnimationFrame(() => {
        if (token !== toastSeq) return;
        toastNode.classList.add('visible');
        toastTimer = setTimeout(() => toastNode.classList.remove('visible'), duration);
    });
}

// ── Escape handling ───────────────────────────────────────────────────────
//
// Every layer used to put its own Escape listener on the document, so a single
// keypress reached all of them: opening a dialog from a panel and pressing
// Escape closed the dialog *and* the panel it came from. Layers register here
// instead — the topmost one handles the key and nothing below it sees it.
//
// The listener is on the capture phase so it also runs ahead of the host
// page's own Escape handling, which has no business reacting while one of our
// modal layers is covering it.
const escapeStack = [];

function onDocumentEscape(event) {
    if (event.key !== 'Escape' || !escapeStack.length) return;
    event.preventDefault();
    event.stopPropagation();
    escapeStack[escapeStack.length - 1]();
}

/**
 * Run `handler` on Escape while this layer is the topmost one.
 * Returns a release function; call it when the layer closes.
 */
export function onEscape(handler) {
    if (!escapeStack.length) document.addEventListener('keydown', onDocumentEscape, true);
    escapeStack.push(handler);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const i = escapeStack.lastIndexOf(handler);
        if (i !== -1) escapeStack.splice(i, 1);
        if (!escapeStack.length) document.removeEventListener('keydown', onDocumentEscape, true);
    };
}

/**
 * suggest({ input, items, onPick, debounce?, minChars?, empty?, loading? })
 *   → { node, hide, isOpen, refresh }
 * Suggestions under a text input, in the toolbox's own theme — the stand-in
 * for <datalist>, whose popup is browser chrome. `items(text)` returns (or
 * resolves to) [{ label, sub?, ... }] or { items, header?, message? } — a
 * message alone shows as a note ("Select a table first"). `onPick(item)`
 * gets the chosen one and decides what the input shows. Arrow keys move,
 * Enter picks, and Escape closes the suggestions before the layer under them.
 *
 * The menu is placed in viewport coordinates, so a scrolling dialog body or
 * panel cannot clip it, and opens upward when there is no room below. Mount
 * `node` (the input inside a wrapper) where the input would have gone.
 */
export function suggest({ input, items, onPick, debounce = 0, minChars = 0, empty = null, loading = null }) {
    const menu = el('div', { className: 'ppt-ac' });
    const node = el('div', { className: 'ppt-ac-wrap' }, [input, menu]);
    input.autocomplete = 'off';
    input.spellcheck = false; // names and logical names, not prose
    let list = [];
    let active = -1;
    let timer = null;
    let seq = 0;
    let focused = false;
    let releaseEscape = null;

    const place = () => {
        const rect = input.getBoundingClientRect();
        const below = window.innerHeight - rect.bottom - 8;
        const above = rect.top - 8;
        const up = below < 160 && above > below;
        Object.assign(menu.style, {
            left: `${rect.left}px`,
            width: `${Math.max(rect.width, 220)}px`,
            maxHeight: `${Math.max(80, Math.min(260, up ? above : below))}px`,
            top: up ? 'auto' : `${rect.bottom + 2}px`,
            bottom: up ? `${window.innerHeight - rect.top + 2}px` : 'auto',
        });
    };
    const isOpen = () => menu.style.display === 'block';
    const hide = () => {
        menu.style.display = 'none';
        active = -1;
        releaseEscape?.();
        releaseEscape = null;
        // Scrolls inside the shadow root never reach the window; the root's
        // own capture listener sees them.
        input.getRootNode().removeEventListener('scroll', place, true);
        window.removeEventListener('resize', place);
    };
    const open = (children) => {
        menu.replaceChildren(...children);
        if (!children.length) { hide(); return; }
        if (!isOpen()) {
            menu.style.display = 'block';
            input.getRootNode().addEventListener('scroll', place, true);
            window.addEventListener('resize', place);
            releaseEscape ??= onEscape(hide);
        }
        place();
    };
    const message = (text) => el('div', { className: 'ppt-ac-msg', textContent: text });
    const highlight = (index) => {
        active = index;
        menu.querySelectorAll('.ppt-ac-item').forEach((child, i) => child.classList.toggle('active', i === index));
        menu.querySelectorAll('.ppt-ac-item')[index]?.scrollIntoView({ block: 'nearest' });
    };
    const show = async () => {
        const token = ++seq;
        const text = input.value.trim();
        list = [];
        active = -1;
        if (text.length < minChars) { hide(); return; }
        const pending = items(text);
        if (loading && pending instanceof Promise) open([message(loading)]);
        let result;
        try { result = await pending; } catch (e) { result = e; }
        if (token !== seq || !focused) return;
        if (result instanceof Error) { open([message(`Error: ${result.message}`)]); return; }
        const { items: found = [], header = null, message: note = null } = Array.isArray(result) ? { items: result } : (result ?? {});
        list = found;
        open([
            ...(header ? [el('div', { className: 'ppt-ac-head', textContent: header })] : []),
            ...(note ? [message(note)] : []),
            ...found.map((item) => el('div', { className: 'ppt-ac-item', title: item.title ?? '' }, [
                el('span', { textContent: item.label }),
                ...(item.sub ? [el('span', { className: 'ppt-ac-sub', textContent: item.sub })] : []),
            ])),
            ...(!found.length && !note && empty ? [message(empty)] : []),
        ]);
    };
    const pick = (index) => {
        const item = list[index];
        if (!item) return;
        hide();
        onPick(item);
    };

    input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(show, debounce);
    });
    input.addEventListener('focus', () => { focused = true; show(); });
    // Later than the menu's own mousedown, so a click on it still lands.
    input.addEventListener('blur', () => { focused = false; ++seq; setTimeout(hide, 150); });
    menu.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus in the input
        const item = e.target.closest('.ppt-ac-item');
        if (item) pick([...menu.querySelectorAll('.ppt-ac-item')].indexOf(item));
    });
    input.addEventListener('keydown', (e) => {
        if (!isOpen() || !list.length) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const step = e.key === 'ArrowDown' ? 1 : -1;
            highlight((active + step + list.length) % list.length);
        } else if (e.key === 'Enter' && active !== -1) {
            e.preventDefault();
            e.stopPropagation();
            pick(active);
        }
    });
    return { node, hide, isOpen, refresh: show };
}

/**
 * modal({ title, width?, render(body, close), buttons?, onClose? }) → close()
 * buttons: [{ label, primary?, danger?, onClick(close) }]
 */
export function modal({ title, width, render, buttons = [], onClose }) {
    const backdrop = el('div', { className: 'ppt ppt-backdrop' });
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        backdrop.remove();
        releaseEscape();
        onClose?.();
    };

    const body = el('div', { className: 'ppt-dialog-body' });
    const dialog = el('div', { className: 'ppt-dialog' }, [
        el('div', { className: 'ppt-dialog-header' }, [
            el('h2', { textContent: title }),
            el('button', { className: 'ppt-icon-btn', textContent: '✕', title: 'Close', onclick: close }),
        ]),
        body,
    ]);
    if (width) dialog.style.width = width;

    if (buttons.length) {
        dialog.appendChild(el('div', { className: 'ppt-dialog-footer' },
            buttons.map((button) => el('button', {
                className: `ppt-btn${button.primary ? ' primary' : ''}${button.danger ? ' danger' : ''}`,
                textContent: button.label,
                onclick: () => button.onClick(close),
            }))));
    }

    backdrop.appendChild(dialog);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
    const releaseEscape = onEscape(close);
    root().appendChild(backdrop);
    render?.(body, close);
    return close;
}

export function confirmDialog(message, { title = 'Confirm', okLabel = 'OK' } = {}) {
    return new Promise((resolve) => {
        modal({
            title,
            render: (body) => body.append(el('div', { textContent: message })),
            buttons: [
                { label: okLabel, primary: true, onClick: (close) => { close(); resolve(true); } },
                { label: 'Cancel', onClick: (close) => { close(); resolve(false); } },
            ],
        });
    });
}

/**
 * Command palette, in sections — cards in a grid, like the toolbar popup:
 * openPalette({ sections: [{ name, color, layout?, items }] })
 * item: { icon?, svg?, title, subtitle?, keywords?, color?, run }
 * `layout: 'list'` renders a section as plain rows (settings: rare and wordy).
 * `svg` names a core/icons.js icon, drawn in the item color; the `icon`
 * emoji is the fallback.
 *
 * Every item keeps a fixed place, for muscle memory: no usage-based ordering.
 * A query keeps the section headers, so a match still says its area. Arrow
 * keys move through the grid in all four directions.
 */
export function openPalette({ sections }) {
    modal({
        title: '🧰 Power Platform Toolbox',
        width: '760px',
        render: (body, close) => {
            const list = el('div', { className: 'ppt-palette-list' });
            const input = el('input', {
                className: 'ppt-input', placeholder: 'Search tools and commands…', type: 'text',
            });
            let visible = []; // [{ item, node }] in reading order
            let active = 0;

            const glyph = (item) => {
                const tile = el('span', { className: 'icon' }, [(item.svg && icon(item.svg)) || (item.icon ?? '⚡')]);
                if (item.color) tile.style.setProperty('--tile', item.color);
                return tile;
            };
            const run = (item) => { close(); item.run(); };
            const card = (item) => {
                const node = el('button', {
                    className: 'ppt-palette-card',
                    title: item.subtitle ? `${item.title}\n${item.subtitle}` : item.title,
                    onclick: () => run(item),
                }, [
                    glyph(item),
                    el('span', { className: 'title', textContent: item.title.replace(/^Open\s+/i, '') }),
                    ...(item.subtitle ? [el('span', { className: 'sub', textContent: item.subtitle })] : []),
                ]);
                if (item.color) node.style.setProperty('--tile', item.color);
                return node;
            };
            const row = (item) => el('button', { className: 'ppt-palette-item', onclick: () => run(item) }, [
                glyph(item),
                el('span', { className: 'text' }, [
                    el('div', { className: 'title', textContent: item.title }),
                    ...(item.subtitle ? [el('div', { className: 'sub', textContent: item.subtitle })] : []),
                ]),
            ]);

            const setActive = (index) => {
                visible[active]?.node.classList.remove('active');
                active = index;
                visible[active]?.node.classList.add('active');
                visible[active]?.node.scrollIntoView({ block: 'nearest' });
            };

            const render = () => {
                const query = input.value.trim().toLowerCase();
                visible = [];
                const nodes = [];
                for (const section of sections) {
                    const items = section.items.filter((item) => !query
                        || `${item.title} ${item.subtitle ?? ''} ${item.keywords ?? ''} ${section.name}`.toLowerCase().includes(query));
                    if (!items.length) continue;
                    const header = el('div', { className: 'ppt-palette-group', textContent: section.name });
                    if (section.color) header.style.setProperty('--tile', section.color);
                    const isList = section.layout === 'list';
                    const container = el('div', { className: isList ? 'ppt-palette-rows' : 'ppt-palette-grid' });
                    for (const item of items) {
                        const node = isList ? row(item) : card(item);
                        visible.push({ item, node });
                        container.append(node);
                    }
                    nodes.push(header, container);
                }
                list.replaceChildren(...(visible.length ? nodes
                    : [el('div', { className: 'ppt-note', textContent: 'No matching commands' })]));
                active = 0;
                setActive(0);
            };

            // The nearest item in a direction, by on-screen position, so it
            // follows the grid however many columns fit.
            const step = (dx, dy) => {
                const from = visible[active]?.node.getBoundingClientRect();
                if (!from) return;
                const cx = from.left + from.width / 2;
                const cy = from.top + from.height / 2;
                let best = -1;
                let bestScore = Infinity;
                visible.forEach(({ node }, index) => {
                    if (index === active) return;
                    const r = node.getBoundingClientRect();
                    const x = r.left + r.width / 2 - cx;
                    const y = r.top + r.height / 2 - cy;
                    const along = dx ? x * dx : y * dy;   // distance in the wanted direction
                    const across = Math.abs(dx ? y : x);  // drift sideways
                    if (along <= 1) return;
                    // Left/right stay on the same row; up/down prefer the same column.
                    const score = dx ? (across > from.height / 2 ? Infinity : along) : along + across * 2;
                    if (score < bestScore) { bestScore = score; best = index; }
                });
                if (best !== -1) setActive(best);
            };

            input.addEventListener('input', render);
            input.addEventListener('keydown', (e) => {
                const moves = { ArrowDown: [0, 1], ArrowUp: [0, -1], ArrowRight: [1, 0], ArrowLeft: [-1, 0] };
                // Left/right move the caret while there is text to move through.
                if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && input.value) return;
                if (moves[e.key]) { step(...moves[e.key]); e.preventDefault(); }
                else if (e.key === 'Enter' && visible[active]) run(visible[active].item);
            });

            body.append(input, list);
            render();
            setTimeout(() => input.focus(), 0);
        },
    });
}

/**
 * A floating, non-modal panel.
 *
 * Unlike {@link modal}, it has no backdrop and never takes focus, so a
 * light-dismiss popover in the host page — the flow designer's expression
 * flyout, say — stays open behind it instead of vanishing the moment the panel
 * appears. Keyboard input therefore never arrives by focus: pass `onKey` and
 * drive it from the document-level capture listener installed here.
 *
 * `mountInto` returns a host-page element to render inside. Pass the popover
 * the panel belongs to and its dismiss-on-outside-click leaves the panel alone.
 *
 * panel({ title, width?, anchor?, mountInto?, render(body, close), buttons?, onKey?, onClose? }) → close()
 */
export function panel({ title, width = 440, anchor, mountInto, render, buttons = [], onKey, onClose }) {
    const card = el('div', { className: 'ppt ppt-panel' });
    card.style.width = `${width}px`;

    const surf = surface(mountInto?.() ?? null);

    let closed = false;
    let releaseEscape = () => {};
    let placeFrame = 0;
    let resize = null;
    const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(watchdog);
        resize?.disconnect();
        cancelAnimationFrame(placeFrame);
        surf.destroy();
        releaseEscape();
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('scroll', replace, true);
        window.removeEventListener('resize', replace);
        onClose?.();
    };

    // Escape goes through the shared stack so a dialog opened over this panel
    // takes it first; everything else the caller wants is forwarded here.
    function onKeyDown(event) {
        // A panel rendered into host-page DOM can be unmounted by the page
        // without close() ever running. This listener would then outlive the
        // panel and swallow every keystroke on the page — so verify the card
        // is still there before consuming anything.
        if (!card.isConnected) { close(); return; }
        if (event.key === 'Escape') return;
        onKey?.(event);
    }

    // ...and do not wait for a keystroke to notice: nothing else would ever
    // release the listeners if the user simply carries on elsewhere.
    const watchdog = setInterval(() => { if (!card.isConnected) close(); }, 500);

    const body = el('div', { className: 'ppt-dialog-body' });
    card.append(
        el('div', { className: 'ppt-dialog-header' }, [
            el('h2', { textContent: title }),
            el('button', { className: 'ppt-icon-btn', textContent: '✕', title: 'Close', onclick: close }),
        ]),
        body,
    );
    if (buttons.length) {
        card.append(el('div', { className: 'ppt-dialog-footer' },
            buttons.map((button) => el('button', {
                className: `ppt-btn${button.primary ? ' primary' : ''}${button.danger ? ' danger' : ''}`,
                textContent: button.label,
                onclick: () => button.onClick(close),
            }))));
    }

    // Clicking anywhere in the panel must not pull focus out of the page field
    // the caller is writing into. Text boxes are the deliberate exception —
    // they cannot be typed in otherwise.
    card.addEventListener('mousedown', (event) => {
        const target = event.target;
        const typable = target?.tagName === 'TEXTAREA'
            || (target?.tagName === 'INPUT' && (target.type === 'text' || target.type === 'url'));
        if (!typable) event.preventDefault();
    });
    // ...and the page must not see those clicks at all, or a popover it has
    // open will treat them as a click outside itself and dismiss.
    shieldFromPage(card);


    /**
     * Where the panel lands, in viewport coordinates.
     *
     * `position: fixed` only means "fixed to the viewport" while nothing above
     * the card establishes a containing block — and a panel mounted inside a
     * host-page popover (see `mountInto`) often has one, because a `transform`,
     * `filter` or `contain` anywhere in that subtree makes THAT element the
     * origin instead. The coordinates below are then measured from the wrong
     * corner and the footer ends up below the fold, unreachable: the panel body
     * scrolls, the panel itself never does. So place the card, read back where
     * it actually landed, and correct by the difference.
     */
    function place() {
        const rect = anchor?.() ?? null;
        const w = card.offsetWidth || width;
        const h = card.offsetHeight || 420;
        let left;
        let top;
        if (rect) {
            // Beside the anchored field, on whichever side has room.
            left = rect.left - w - 12;
            if (left < 8) left = rect.right + 12;
            if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
            top = Math.min(Math.max(8, rect.top - 40), Math.max(8, window.innerHeight - h - 8));
        } else {
            left = Math.max(8, (window.innerWidth - w) / 2);
            top = window.innerHeight * 0.08;
        }
        card.style.left = `${left}px`;
        card.style.top = `${top}px`;

        // Sub-pixel differences are just rounding; anything larger is an
        // offset origin, and subtracting it puts the card where we asked.
        const actual = card.getBoundingClientRect();
        const dx = actual.left - left;
        const dy = actual.top - top;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            card.style.left = `${left - dx}px`;
            card.style.top = `${top - dy}px`;
        }
    }

    // Placing once is not enough: the card grows and shrinks with its content
    // — a tab switched, a list filtered — and the anchor moves whenever the
    // page scrolls. Either leaves the footer hanging past the bottom edge.
    // Coalesced into a frame, because a scroll listener that measures on every
    // event would fight the designer for the main thread.
    function replace() {
        if (placeFrame) return;
        placeFrame = requestAnimationFrame(() => {
            placeFrame = 0;
            if (!closed) place();
        });
    }

    surf.root.appendChild(card);
    render?.(body, close);
    place();
    resize = new ResizeObserver(replace);
    resize.observe(card);
    // Capture, because the scroller is somewhere in the page and scroll does
    // not bubble.
    document.addEventListener('scroll', replace, true);
    releaseEscape = onEscape(() => close());
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', replace);
    return close;
}

// Pointer events are composed, so they cross the shadow boundary and reach the
// host page's listeners retargeted to <ppt-ui>. A page with a light-dismiss
// popover open reads that as "the user clicked outside" and closes it.
const SHIELDED_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'touchstart'];

/**
 * Stops pointer activity inside a toolbox surface from reaching the page.
 *
 * Called on the surface itself, so our own handlers — which run at the target,
 * before the event bubbles this far — still fire; only the page's
 * document-level listeners are cut off. That is what keeps the flow designer's
 * expression flyout open while its field picker is being used.
 *
 * Note this only shields listeners in the bubble phase. A page listening in the
 * capture phase sees the event before it reaches us at all, and nothing short
 * of moving the UI into its own browsing context can prevent that.
 */
export function shieldFromPage(node) {
    for (const type of SHIELDED_EVENTS) {
        // Touch events are scroll-blocking unless declared passive, and Chrome
        // rightly complains about that. Passive only forbids preventDefault —
        // stopPropagation, which is all this does, still applies.
        node.addEventListener(type, (event) => event.stopPropagation(),
            type.startsWith('touch') ? { passive: true } : undefined);
    }
    return node;
}

/** Mount an element into the shared shadow root (for custom tool surfaces). */
export function mount(node) {
    root().appendChild(node);
    return node;
}

/** Add a tool-scoped stylesheet to every shadow surface (idempotent per id). */
const addedStyles = new Set();
export function addStyle(id, css) {
    if (addedStyles.has(id)) return;
    addedStyles.add(id);
    styles.push(css);
    root();
    for (const shadow of roots) shadow.appendChild(el('style', { textContent: css }));
}

/** Inject a page-level stylesheet (for tools that must style host-page elements). */
export function pageStyle(id, css) {
    if (document.getElementById(id)) return;
    document.documentElement.appendChild(el('style', { id, textContent: css }));
}
