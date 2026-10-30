// Floating launcher: a small tab docked to the right edge of the page that
// opens the command palette, so Easy Mode is one click away without going
// through the browser's extension menu or knowing the shortcut.
//
// It stays out of the way: just the switch icon, half transparent, until hovered,
// below every Easy Mode panel and dialog, draggable up and down to
// wherever the page has nothing under it (the spot is remembered), and it can
// be hidden from its own × or from the options page.

import { addStyle, el, mount } from './ui.js';
import { settings } from './storage.js';

// The icon sits at the edge and never moves; the label and × unfold to its
// left on hover. A tab that slid out instead put the × right under the cursor
// that had just come to rest on the icon, one click away from hiding itself.
const STYLE = `
    .ppt-launcher {
        position: fixed; right: 0; z-index: 2147482000;
        display: flex; flex-direction: row-reverse; align-items: center;
        height: 34px; padding: 0 7px;
        background: var(--bg); color: var(--text);
        border: 1px solid var(--border); border-right: none;
        border-radius: 8px 0 0 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.14);
        cursor: pointer; user-select: none; touch-action: none;
        opacity: 0.55; transition: opacity 0.18s ease;
    }
    .ppt-launcher:hover, .ppt-launcher:focus-visible, .ppt-launcher.dragging { opacity: 1; }
    .ppt-launcher:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .ppt-launcher.dragging { cursor: grabbing; }
    /* The product icon in miniature: a purple switch, flipped on (ahash.dev brand accent). */
    .ppt-launcher .icon {
        position: relative; flex: none; width: 22px; height: 12px;
        border-radius: 6px; background: #9b29ff;
    }
    .ppt-launcher .icon::after {
        content: ''; position: absolute; top: 2px; right: 2px;
        width: 8px; height: 8px; border-radius: 50%; background: #fff;
    }
    .ppt-launcher .label, .ppt-launcher .hide {
        max-width: 0; opacity: 0; overflow: hidden; white-space: nowrap;
        transition: max-width 0.18s ease, opacity 0.18s ease, margin 0.18s ease;
    }
    .ppt-launcher .label { font-size: 12px; font-weight: 600; }
    .ppt-launcher .hide {
        border: none; background: none; color: var(--muted); cursor: pointer;
        font-size: 12px; line-height: 1; padding: 2px 0; border-radius: 4px;
    }
    .ppt-launcher:hover .label, .ppt-launcher:focus-visible .label { max-width: 80px; opacity: 1; margin-right: 6px; }
    .ppt-launcher:hover .hide, .ppt-launcher:focus-visible .hide { max-width: 24px; opacity: 1; margin-right: 6px; padding: 2px 4px; }
    .ppt-launcher.dragging .label, .ppt-launcher.dragging .hide { max-width: 0; opacity: 0; margin: 0; padding: 2px 0; }
    .ppt-launcher .hide:hover { background: var(--bg2); color: var(--text); }
`;

const DRAG_THRESHOLD_PX = 4;
const EDGE_MARGIN_PX = 56; // keep clear of the very top and bottom of the window
// Default spot, as a fraction of the window height: level with a Dynamics
// form's header, clear of the command bar above and the form fields below.
const DEFAULT_TOP = 0.175;

/** Shows the launcher unless the user hid it. `onOpen` opens the palette. */
export async function showLauncher(onOpen) {
    const prefs = await settings.getLauncher();
    if (prefs.hidden) return;

    addStyle('launcher', STYLE);
    const button = el('div', {
        className: 'ppt ppt-launcher', role: 'button', tabIndex: 0,
        title: 'Power Platform Easy Mode (Alt+Shift+P) — drag to move',
    }, [
        el('span', { className: 'icon' }),
        el('span', { className: 'label', textContent: 'Easy Mode' }),
    ]);
    const hide = el('button', { className: 'hide', textContent: '✕', title: 'Hide the launcher (turn it back on in the options)' });
    button.appendChild(hide);
    mount(button);
    // Some pages rebuild <body> wholesale; put the launcher back if it went with it.
    const watchdog = setInterval(() => { if (!button.isConnected) { mount(button); place(); } }, 2000);

    // Stored as a fraction of the window height, so it lands in the same
    // place on a smaller or larger window.
    let fraction = typeof prefs.top === 'number' ? prefs.top : DEFAULT_TOP;
    const place = () => {
        const max = window.innerHeight - EDGE_MARGIN_PX - button.offsetHeight;
        const top = Math.round(Math.min(Math.max(fraction * window.innerHeight, EDGE_MARGIN_PX), Math.max(max, EDGE_MARGIN_PX)));
        button.style.top = `${top}px`;
    };
    place();
    window.addEventListener('resize', place);

    // The drag is followed on the window, not by pointer capture: capture on an
    // element in our closed shadow root did not hold on the maker portal, so
    // the moves went to the page as soon as the pointer left the 34px tab.
    let drag = null; // { startY, startTop, moved }
    const onMove = (event) => {
        const dy = event.clientY - drag.startY;
        if (!drag.moved && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        drag.moved = true;
        button.classList.add('dragging');
        fraction = (drag.startTop + dy) / window.innerHeight;
        place();
        event.preventDefault(); // no text selection on the page underneath
    };
    const endDrag = (event) => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', endDrag, true);
        window.removeEventListener('pointercancel', endDrag, true);
        const { moved } = drag;
        drag = null;
        button.classList.remove('dragging');
        if (moved) settings.setLauncher({ top: fraction });
        else if (event.type === 'pointerup') onOpen();
    };
    button.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || event.target === hide || drag) return;
        event.preventDefault();
        drag = { startY: event.clientY, startTop: button.getBoundingClientRect().top, moved: false };
        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', endDrag, true);
        window.addEventListener('pointercancel', endDrag, true);
    });
    button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(); }
    });

    hide.addEventListener('click', (event) => {
        event.stopPropagation();
        clearInterval(watchdog);
        button.remove();
        window.removeEventListener('resize', place);
        settings.setLauncher({ hidden: true });
    });
}
