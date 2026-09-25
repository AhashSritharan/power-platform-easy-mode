// Writing into the page's own inputs, where the user left their cursor.
//
// Tool UI necessarily takes focus away from the field the user was editing, so
// "insert this at my cursor" only works if the cursor was remembered before
// the dialog opened. This module keeps track of the last editable the user was
// actually in — anything inside the toolbox's own shadow root is ignored,
// which is what makes the remembered position survive a whole dialog chain.
//
// Insertion goes through the events a framework-controlled field expects: the
// native value setter plus an `input` event for <input>/<textarea>, and
// execCommand for contenteditable editors, which is still the only insertion
// path the rich editors in the maker portals reliably observe.
//
// The chip at the bottom is the trigger that pairs with all this: a button
// that follows the focused field and cancels its own mousedown, so opening a
// tool from it never moves the caret in the first place.

import * as ui from './ui.js';

const UI_HOST_TAG = 'PPT-UI';

let tracked = null; // { element, kind, start, end, range }
let watching = false;
const listeners = new Set();

const isOurUi = (node) => node?.tagName === UI_HOST_TAG;

const isTextField = (element) =>
    (element instanceof HTMLTextAreaElement)
    || (element instanceof HTMLInputElement
        && /^(?:text|search|url|tel|email|number|password|)$/i.test(element.type));

function capture(element) {
    if (!element || isOurUi(element)) return;

    if (isTextField(element)) {
        tracked = {
            element, kind: 'field',
            start: element.selectionStart ?? element.value.length,
            end: element.selectionEnd ?? element.value.length,
        };
    } else if (element.isContentEditable) {
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
        // Without a range there is no insertion point — keep whatever was
        // tracked before rather than replacing it with something unusable.
        if (!range) return;
        tracked = { element, kind: 'editable', range };
    } else {
        return;
    }

    for (const listener of listeners) listener(describeTarget());
}

/** Starts remembering where the caret is. Safe to call from several tools. */
export function watchCaret() {
    if (watching) return;
    watching = true;

    document.addEventListener('focusin', (event) => capture(event.target), true);
    document.addEventListener('mouseup', (event) => capture(event.target), true);
    document.addEventListener('keyup', (event) => capture(event.target), true);
    document.addEventListener('selectionchange', () => {
        // Only while the tracked element still holds focus: once a dialog is
        // open, activeElement is the shadow host and the page selection must
        // be left exactly as the user left it.
        const active = document.activeElement;
        if (active && !isOurUi(active) && active === tracked?.element) capture(active);
    });
}

/**
 * What sort of field is being written into: 'textarea', 'input', 'editable'
 * (contenteditable), or null. Callers use it to decide how a value should be
 * formatted — a plain textarea and a rich token editor rarely want the same
 * thing — without this module needing to know anything about the host page.
 */
export function targetKind() {
    const element = caretElement();
    if (!element) return null;
    if (element instanceof HTMLTextAreaElement) return 'textarea';
    if (element instanceof HTMLInputElement) return 'input';
    return 'editable';
}

/** A short human name for the remembered field, or null when there is none. */
export function describeTarget() {
    const element = tracked?.element;
    if (!element?.isConnected) return null;

    const attribute = ['aria-label', 'placeholder', 'name', 'title']
        .map((name) => element.getAttribute?.(name))
        .find((value) => value?.trim());
    if (attribute) return attribute.trim().slice(0, 60);

    const labelledBy = element.getAttribute?.('aria-labelledby');
    if (labelledBy) {
        const text = labelledBy.split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ').trim();
        if (text) return text.slice(0, 60);
    }
    return tracked.kind === 'editable' ? 'editor' : element.tagName.toLowerCase();
}

/** Whatever text the element currently holds, for before/after comparison. */
const contentSnapshot = (element) =>
    (element.value !== undefined ? element.value : element.textContent);

/**
 * Offers `text` to the element as a paste.
 *
 * The token editors in the maker portals turn pasted "@{…}" into a real
 * dynamic-content pill, but treat programmatic insertText as someone typing
 * literal characters — which is why an inserted expression used to sit there
 * as plain text until the user cut and re-pasted it by hand. Handing the
 * editor a paste event lets its own parser do the conversion.
 *
 * Returns whether the editor took it: either it cancelled the event, or the
 * content changed. Both are checked because an editor that inserts without
 * cancelling would otherwise get the text a second time from the fallback.
 */
function tryPaste(element, text) {
    if (typeof DataTransfer !== 'function' || typeof ClipboardEvent !== 'function') return false;

    let clipboardData;
    try {
        clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', text);
    } catch {
        return false; // no synthetic clipboard available — fall back
    }

    const before = contentSnapshot(element);
    const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
    const notCancelled = element.dispatchEvent(event);
    return !notCancelled || contentSnapshot(element) !== before;
}

function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
}

function insertIntoField(text) {
    const { element, start, end } = tracked;
    const value = element.value ?? '';
    const from = Math.min(start, value.length);
    const to = Math.min(Math.max(end, from), value.length);

    element.focus();
    // Put the selection back before offering the paste, so the editor replaces
    // what the user had selected rather than appending at its own idea of the end.
    element.setSelectionRange?.(from, to);
    if (tryPaste(element, text)) return true;

    setNativeValue(element, value.slice(0, from) + text + value.slice(to));
    element.dispatchEvent(new Event('input', { bubbles: true }));

    const caret = from + text.length;
    element.setSelectionRange?.(caret, caret);
    return true;
}

function insertIntoEditable(text) {
    const { element, range } = tracked;
    element.focus();

    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    if (tryPaste(element, text)) return true;
    if (document.execCommand('insertText', false, text)) return true;

    // Editors that refuse execCommand still see a manual splice plus the
    // input event they listen for.
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    return true;
}

/**
 * Writes `text` where the user last had their cursor.
 * Returns false when there is nowhere to write it — no remembered field, or
 * one the page has since torn down — so callers can fall back to the clipboard.
 */
export function insertAtCaret(text) {
    if (!tracked?.element?.isConnected) return false;
    try {
        return tracked.kind === 'field' ? insertIntoField(text) : insertIntoEditable(text);
    } catch (e) {
        console.warn('[Power Platform Toolbox] caret insert failed:', e);
        return false;
    }
}

/** Calls cb(description) whenever the remembered field changes. Returns unsubscribe. */
export function onCaretChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

// ── The chip ──────────────────────────────────────────────────────────────

const CHIP_SIZE = 26;
const CHIP_GAP = 6;
const PROBE_STEPS = 4;

const CHIP_CSS = `
    .ppt-caret-chip {
        position: fixed; width: ${CHIP_SIZE}px; height: ${CHIP_SIZE}px;
        display: none; align-items: center; justify-content: center;
        padding: 0; font-size: 14px; line-height: 1; cursor: pointer;
        border: 1px solid var(--border); border-radius: 6px;
        background: var(--bg); color: var(--text);
        box-shadow: 0 2px 8px rgba(0,0,0,0.18);
        /* Below the dialog backdrop, so opening a panel covers the chip
           instead of leaving it floating over the overlay. */
        z-index: 2147482000;
    }
    .ppt-caret-chip:hover { border-color: var(--accent); color: var(--accent); }
    /* Docked into a host-page toolbar: ordinary flow, sized like its siblings,
       so there is no positioning to get wrong and nothing to keep in sync. */
    .ppt-caret-chip.docked {
        position: static; width: 32px; height: 32px;
        border: none; background: transparent; box-shadow: none;
    }
`;

/**
 * The field an insert would go to, while it is still on the page.
 *
 * Deliberately NOT "while it still has focus": the rich editors in the maker
 * portals hand focus to a wrapper of their own once they initialise, so the
 * caret stays visibly in the field while document.activeElement moves off it.
 * Tying the chip to activeElement made it flash up and vanish a moment later.
 */
export function caretElement() {
    const element = tracked?.element;
    return element?.isConnected ? element : null;
}

/**
 * Is (x, y) covered by something clickable that is not ours? Used to place the
 * chip clear of the controls a host page already parks against its inputs —
 * the designer's own dynamic-content and fx buttons sit exactly where the
 * obvious spot is. Probing beats hard-coded offsets, which would need
 * re-tuning every time the portal moves a button.
 */
function blocked(x, y, target) {
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
    const element = document.elementFromPoint(x, y);
    if (!element || element.tagName === UI_HOST_TAG) return false;
    if (element === target || target?.contains?.(element)) return true;
    return !!element.closest?.('button, a, [role="button"], [role="menuitem"], [role="tab"]');
}

let chip = null;

/**
 * A button that opens `onActivate` for the focused field.
 *
 * `dock` (optional) returns a host-page toolbar to sit inside. That is much the
 * better home when one exists: the chip becomes an ordinary child in normal
 * flow — no positioning to compute — and, being inside the surface, clicking it
 * cannot read as a click outside a popover that is watching for one. Without a
 * dock it floats beside the field instead.
 *
 * `when` (optional) gates it to the pages a tool is useful on.
 * Returns a function that removes it.
 */
export function showCaretChip({ label = '⚡', title = '', when, dock, onActivate }) {
    hideCaretChip();
    watchCaret();
    ui.addStyle('ppt-caret', CHIP_CSS);

    const button = ui.el('button', { className: 'ppt ppt-caret-chip', textContent: label, title });
    // The whole point of the chip: cancelling mousedown means the field never
    // blurs, so the caret is still exactly where the user left it.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => { event.preventDefault(); onActivate(); });
    // And the page must not see the click either — a popover open against the
    // field counts any click outside itself as a reason to close.
    ui.shieldFromPage(button);

    const surf = ui.surface(null);
    surf.root.appendChild(button);

    const hide = () => { button.style.display = 'none'; };

    const reposition = () => {
        // A re-render can swap the tracked node out from under us while the
        // user is still typing in its replacement; pick the new one back up
        // rather than going quiet until they click again.
        if (!caretElement()) capture(document.activeElement);

        const target = caretElement();
        if (!target || (when && !when())) { hide(); return; }

        // Docked: the toolbar lays it out, so there is nothing to position.
        const toolbar = dock?.() ?? null;
        if (toolbar) {
            surf.moveTo(toolbar);
            button.classList.add('docked');
            button.style.display = 'flex';
            return;
        }
        surf.moveTo(null);
        button.classList.remove('docked');

        // A field inside a MODAL surface — the "Run flow" panel on a flow's
        // details page, say — is not a designer input, and floating a field
        // picker over it is noise. Deliberately not plain [role="dialog"]:
        // the designer's own action pane is one of those, and suppressing the
        // chip there removes it from the very fields it exists for.
        if (target.closest?.('[aria-modal="true"]')) { hide(); return; }

        const rect = target.getBoundingClientRect();
        if (!rect.width && !rect.height) { hide(); return; }
        // Scrolled away, or hidden behind a collapsed panel — following it
        // there would leave the chip floating over unrelated content.
        if (rect.bottom < 0 || rect.top > window.innerHeight
            || rect.right < 0 || rect.left > window.innerWidth) { hide(); return; }

        const top = Math.max(4, Math.min(
            rect.top + (rect.height - CHIP_SIZE) / 2,
            window.innerHeight - CHIP_SIZE - 4));

        // Probe outward from the field's right edge, past whatever the page
        // has already put there. Our own chip must not be part of the answer.
        button.style.visibility = 'hidden';
        const isClear = (x) => !blocked(x + CHIP_SIZE / 2, top + CHIP_SIZE / 2, target);

        let left = null;
        for (let step = 0, x = rect.right + CHIP_GAP; step < PROBE_STEPS; step++, x += CHIP_SIZE + CHIP_GAP) {
            if (x + CHIP_SIZE > window.innerWidth - 4) break;
            if (isClear(x)) { left = x; break; }
        }
        // Nothing free to the right — the space left of the field usually is.
        if (left === null) {
            const x = rect.left - CHIP_SIZE - CHIP_GAP;
            if (x >= 4 && isClear(x)) left = x;
        }
        button.style.visibility = '';

        // Sitting on top of a control the page needs is worse than not being
        // there at all: it swallows the click meant for that control.
        if (left === null) { hide(); return; }
        button.style.top = `${top}px`;
        button.style.left = `${left}px`;
        button.style.display = 'flex';
    };

    // Fields move for reasons no event reports — React re-renders, panels
    // sliding open — so a light poll backs up the scroll/resize listeners.
    const timer = setInterval(reposition, 200);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    const release = onCaretChange(reposition);
    reposition();

    chip = () => {
        clearInterval(timer);
        window.removeEventListener('scroll', reposition, true);
        window.removeEventListener('resize', reposition);
        release();
        surf.destroy();
        chip = null;
    };
    return hideCaretChip;
}

export function hideCaretChip() {
    chip?.();
}
