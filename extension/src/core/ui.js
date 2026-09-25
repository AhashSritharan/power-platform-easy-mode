// Shadow-DOM UI kit shared by all native tools.
//
// Everything renders inside one shadow root attached to <html>, so tool UI
// can never collide with host-page CSS (and vice versa). Fluent-flavored,
// light/dark aware.

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
    .ppt-palette-list { max-height: 50vh; overflow-y: auto; margin-top: 8px; }
    .ppt-palette-item {
        display: flex; align-items: center; gap: 10px; width: 100%;
        padding: 9px 12px; border: none; background: none; color: var(--text);
        font: inherit; text-align: left; cursor: pointer; border-radius: 6px;
    }
    .ppt-palette-item:hover, .ppt-palette-item.active { background: var(--bg2); }
    .ppt-palette-item .icon { flex-shrink: 0; width: 22px; text-align: center; }
    .ppt-palette-item .sub { color: var(--muted); font-size: 12px; }
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
    roots.add(shadow);
    return shadow;
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

export function toast(message, duration = 3000) {
    if (!toastNode?.isConnected) {
        toastNode = el('div', { className: 'ppt ppt-toast' });
        root().appendChild(toastNode);
    }
    clearTimeout(toastTimer);
    toastNode.textContent = message;
    requestAnimationFrame(() => toastNode.classList.add('visible'));
    toastTimer = setTimeout(() => toastNode.classList.remove('visible'), duration);
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
 * Command palette: searchable list of { icon?, title, subtitle?, run }.
 */
export function openPalette(items) {
    modal({
        title: '🧰 Power Platform Toolbox',
        width: '520px',
        render: (body, close) => {
            const list = el('div', { className: 'ppt-palette-list' });
            const input = el('input', {
                className: 'ppt-input', placeholder: 'Search tools and commands…', type: 'text',
            });
            let active = 0;

            const refresh = () => {
                const query = input.value.trim().toLowerCase();
                const visible = items.filter((item) =>
                    !query || `${item.title} ${item.subtitle ?? ''}`.toLowerCase().includes(query));
                list.replaceChildren(...visible.map((item, i) => el('button', {
                    className: `ppt-palette-item${i === active ? ' active' : ''}`,
                    onclick: () => { close(); item.run(); },
                }, [
                    el('span', { className: 'icon', textContent: item.icon ?? '⚡' }),
                    el('span', {}, [
                        el('div', { textContent: item.title }),
                        ...(item.subtitle ? [el('div', { className: 'sub', textContent: item.subtitle })] : []),
                    ]),
                ])));
                if (!visible.length) {
                    list.replaceChildren(el('div', { className: 'ppt-note', textContent: 'No matching commands' }));
                }
                return visible;
            };

            input.addEventListener('input', () => { active = 0; refresh(); });
            input.addEventListener('keydown', (e) => {
                const visible = refresh();
                if (e.key === 'ArrowDown') { active = Math.min(active + 1, visible.length - 1); refresh(); e.preventDefault(); }
                else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); refresh(); e.preventDefault(); }
                else if (e.key === 'Enter' && visible[active]) { close(); visible[active].run(); }
            });

            body.append(input, list);
            refresh();
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
     * Deletion inside our own text boxes, applied by hand.
     *
     * Rich editors cancel Backspace at the window level to stop the browser
     * navigating back, and a cancelled keydown cancels the deletion in EVERY
     * focused box on the page — ours included. Typing still works, so the
     * symptom is characters going in and nothing coming out. Rather than
     * depend on a default action something upstream has taken away, do the
     * edit here and announce it with the `input` event listeners expect.
     */
    card.addEventListener('keydown', (event) => {
        const input = event.target;
        if (input?.tagName !== 'INPUT' && input?.tagName !== 'TEXTAREA') return;
        if (event.key !== 'Backspace' && event.key !== 'Delete') return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;

        const value = input.value ?? '';
        const start = input.selectionStart ?? value.length;
        const end = input.selectionEnd ?? start;
        const [from, to] = start !== end
            ? [start, end]
            : event.key === 'Backspace'
                ? [Math.max(0, start - 1), start]
                : [start, Math.min(value.length, start + 1)];

        event.preventDefault();
        if (from === to) return;
        input.value = value.slice(0, from) + value.slice(to);
        input.setSelectionRange?.(from, from);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });

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
