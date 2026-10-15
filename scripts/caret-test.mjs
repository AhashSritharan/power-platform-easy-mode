#!/usr/bin/env node
/**
 * Smoke test for caret insertion (src/core/caret.js) — the module that lets a
 * tool write into the page field the user had focused before the tool's own
 * dialog stole focus.
 *
 * Loads the real file against a simulated DOM and verifies the parts that are
 * easy to get wrong: the toolbox's own UI must never become the insert target,
 * offsets must splice (and replace selections) correctly, and a field the page
 * has torn down must fail cleanly so the caller can fall back to the clipboard.
 * Run: node scripts/caret-test.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── Simulated DOM ─────────────────────────────────────────────────────────
class FakeElement {
    constructor(tag, attributes = {}) {
        this.tagName = tag.toUpperCase();
        this.attributes = attributes;
        this.isConnected = true;
        this.isContentEditable = false;
        this.events = [];
        this.listeners = {};
        this.style = {};
        this.className = '';
        this.rect = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
        const names = () => this.className.split(/\s+/).filter(Boolean);
        this.classList = {
            add: (name) => { if (!names().includes(name)) this.className = [...names(), name].join(' '); },
            remove: (name) => { this.className = names().filter((n) => n !== name).join(' '); },
            contains: (name) => names().includes(name),
            toggle: (name, on) => (on ? this.classList.add(name) : this.classList.remove(name)),
        };
    }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    dispatchEvent(event) {
        this.events.push(event);
        event.target = this;
        for (const fn of this.listeners[event.type] ?? []) fn(event);
        return !event.defaultPrevented;
    }
    focus() { document.activeElement = this; }
    getBoundingClientRect() { return this.rect; }
    contains(other) { return other === this; }
    matches(selector) {
        return selector.split(',').map((part) => part.trim()).some((part) => {
            const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
            if (attribute) {
                const value = this.getAttribute(attribute[1]);
                return attribute[2] === undefined ? value !== null : value === attribute[2];
            }
            return this.tagName === part.toUpperCase();
        });
    }
    closest(selector) {
        for (let node = this; node; node = node.parentElement) {
            if (node.matches?.(selector)) return node;
        }
        return null;
    }
    remove() { this.isConnected = false; this.parentElement = null; }
    append() {}
}

class HTMLInputElement extends FakeElement {
    constructor(attributes) {
        super('input', attributes);
        this._value = '';
        this.type = 'text';
        this.selectionStart = 0;
        this.selectionEnd = 0;
    }
    get value() { return this._value; }
    set value(next) { this._value = String(next); }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
}

class HTMLTextAreaElement extends HTMLInputElement {
    constructor(attributes) { super(attributes); this.tagName = 'TEXTAREA'; }
}

class FakeRange {
    constructor() { this.spliced = false; }
    cloneRange() { return this; }
    deleteContents() { this.spliced = true; }
    insertNode() { this.spliced = true; }
    setStartAfter() {}
    collapse() {}
}

class FakeEvent {
    constructor(type, init = {}) { Object.assign(this, { type }, init); }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this.propagationStopped = true; }
}

class FakeShadowRoot {
    constructor(host) { this.host = host; this.children = []; this.listeners = {}; }
    appendChild(node) { this.children.push(node); return node; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
}

class FakeDataTransfer {
    constructor() { this.data = {}; }
    setData(type, value) { this.data[type] = value; }
    getData(type) { return this.data[type] ?? ''; }
}

class FakeClipboardEvent extends FakeEvent {
    constructor(type, init = {}) { super(type, init); }
}

const selection = {
    range: null,
    applied: null,
    get rangeCount() { return this.range ? 1 : 0; },
    getRangeAt() { return this.range; },
    removeAllRanges() { this.applied = null; },
    addRange(range) { this.applied = range; },
};

const document = {
    activeElement: null,
    listeners: {},
    execResult: true,
    lastExec: null,
    occupied: [], // bands that report a clickable element, i.e. the portal's own buttons
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    fire(type, event) { for (const fn of this.listeners[type] ?? []) fn(event); },
    getElementById: () => null,
    createTextNode: (data) => ({ nodeType: 3, data }),
    hosts: [], // every shadow surface ever created; each tool surface is its own
    createElement(tag) {
        const element = new FakeElement(tag);
        if (element.tagName === 'PPT-UI') this.hosts.push(element);
        return element;
    },
    execCommand(command, _showUi, text) {
        this.lastExec = { command, text };
        return this.execResult;
    },
    elementFromPoint(x, y) {
        const band = this.occupied.find((b) => x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2);
        return band?.element ?? null;
    },
};
document.documentElement = new FakeElement('html');
document.body = document.documentElement;

const window = {
    innerWidth: 1200,
    innerHeight: 800,
    listeners: {},
    getSelection: () => selection,
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) {
        this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
    },
    fire(type) { for (const fn of [...(this.listeners[type] ?? [])]) fn(); },
};

FakeElement.prototype.appendChild = function appendChild(node) {
    node.parentElement = this;
    return node;
};
window.getComputedStyle = (element) => ({
    position: 'static', transform: 'none', filter: 'none', contain: '', ...(element.computed ?? {}),
});
FakeElement.prototype.attachShadow = function attachShadow() {
    this.shadow = new FakeShadowRoot(this);
    return this.shadow;
};

Object.assign(globalThis, {
    document,
    window,
    HTMLInputElement,
    HTMLTextAreaElement,
    Event: FakeEvent,
    InputEvent: FakeEvent,
    ClipboardEvent: FakeClipboardEvent,
    DataTransfer: FakeDataTransfer,
});

const {
    watchCaret, insertAtCaret, describeTarget, onCaretChange, showCaretChip, hideCaretChip, targetKind,
} = await import(pathToFileURL(join(ROOT, 'extension/src/core/caret.js')));

watchCaret();
const focus = (element) => {
    document.activeElement = element;
    document.fire('focusin', { target: element });
};

// ── A plain input, cursor mid-value ───────────────────────────────────────
const input = new HTMLInputElement({ 'aria-label': 'Subject' });
input.value = 'Hello world';
input.selectionStart = input.selectionEnd = 5;
focus(input);

assert.equal(describeTarget(), 'Subject', 'target is named from aria-label');
assert.equal(insertAtCaret("@{outputs('C')}"), true);
assert.equal(input.value, "Hello@{outputs('C')} world", 'inserts at the caret, not the end');
assert.equal(input.events.filter((e) => e.type === 'input').length, 1, 'fires input so React sees it');
assert.equal(input.selectionStart, 20, 'caret lands after the inserted text');
console.log('inserts at the caret ok');

// ── Opening tool UI must not steal the target ─────────────────────────────
const uiHost = new FakeElement('ppt-ui');
focus(uiHost);
assert.equal(describeTarget(), 'Subject', 'the toolbox shadow host is never tracked');
assert.equal(insertAtCaret('X'), true);
assert.ok(input.value.includes('X'), 'still writes to the page field behind the dialog');
console.log('ignores the toolbox own UI ok');

// ── A selection is replaced, not spliced around ───────────────────────────
const replace = new HTMLInputElement({ placeholder: 'To' });
replace.value = 'keep DROP keep';
replace.selectionStart = 5;
replace.selectionEnd = 9;
focus(replace);
assert.equal(describeTarget(), 'To', 'falls back to placeholder for a name');
insertAtCaret('NEW');
assert.equal(replace.value, 'keep NEW keep');
console.log('replaces a selection ok');

// ── A textarea without a prototype value setter still works ───────────────
const area = new HTMLTextAreaElement({ name: 'Body' });
area.value = 'ab';
area.selectionStart = area.selectionEnd = 2;
focus(area);
insertAtCaret('!');
assert.equal(area.value, 'ab!');
console.log('textarea fallback path ok');

// ── contenteditable goes through execCommand ──────────────────────────────
const editor = new FakeElement('div', {});
editor.isContentEditable = true;
selection.range = new FakeRange();
focus(editor);
assert.equal(describeTarget(), 'editor');
assert.equal(insertAtCaret('@{x}'), true);
assert.deepEqual(document.lastExec, { command: 'insertText', text: '@{x}' });
assert.equal(selection.applied, selection.range, 'the saved range is restored before writing');
console.log('contenteditable via execCommand ok');

// ── ...and falls back when the editor refuses it ──────────────────────────
document.execResult = false;
const stubborn = new FakeElement('div', {});
stubborn.isContentEditable = true;
const range = new FakeRange();
selection.range = range;
focus(stubborn);
assert.equal(insertAtCaret('@{y}'), true);
assert.ok(range.spliced, 'splices the range by hand');
assert.equal(stubborn.events.at(-1).type, 'input', 'and still fires input');
document.execResult = true;
console.log('contenteditable fallback ok');

// ── A torn-down field fails cleanly so the caller can copy instead ────────
const gone = new HTMLInputElement({});
focus(gone);
gone.isConnected = false;
assert.equal(insertAtCaret('nope'), false, 'detached target reports failure');
assert.equal(describeTarget(), null);
console.log('detached target fails cleanly ok');

// ── Subscribers are told when the target changes ──────────────────────────
const seen = [];
const unsubscribe = onCaretChange((name) => seen.push(name));
focus(new HTMLInputElement({ 'aria-label': 'Later' }));
assert.deepEqual(seen, ['Later']);
unsubscribe();
focus(new HTMLInputElement({ 'aria-label': 'Ignored' }));
assert.deepEqual(seen, ['Later'], 'unsubscribe stops notifications');
console.log('caret change subscription ok');

// ── Token editors convert on paste, not on typing ─────────────────────────
// The designer turns a pasted "@{…}" into a dynamic-content pill but leaves
// programmatically typed text as a literal, so insertion offers a paste first.

// 1. An editor that handles the paste and cancels it.
const tokenEditor = new FakeElement('div', {});
tokenEditor.isContentEditable = true;
let pasted = null;
tokenEditor.addEventListener('paste', (event) => {
    pasted = event.clipboardData.getData('text/plain');
    event.preventDefault();
});
selection.range = new FakeRange();
document.lastExec = null;
focus(tokenEditor);
assert.equal(insertAtCaret('@{outputs(\'C\')?[\'name\']}'), true);
assert.equal(pasted, "@{outputs('C')?['name']}", 'the editor is offered the text as a paste');
assert.equal(document.lastExec, null, 'and insertText is never reached');
console.log('paste path drives token conversion ok');

// 2. An editor that inserts on paste but does not cancel — must not double up.
const sloppy = new FakeElement('div', {});
sloppy.isContentEditable = true;
sloppy.textContent = 'before ';
sloppy.addEventListener('paste', (event) => {
    sloppy.textContent += event.clipboardData.getData('text/plain');
});
selection.range = new FakeRange();
document.lastExec = null;
focus(sloppy);
assert.equal(insertAtCaret('@{x}'), true);
assert.equal(sloppy.textContent, 'before @{x}', 'inserted exactly once');
assert.equal(document.lastExec, null, 'a content change counts as handled');
console.log('no double insert when paste is not cancelled ok');

// 3. An editor that ignores paste entirely still gets the old behaviour.
const plainEditor = new FakeElement('div', {});
plainEditor.isContentEditable = true;
selection.range = new FakeRange();
document.lastExec = null;
focus(plainEditor);
assert.equal(insertAtCaret('@{y}'), true);
assert.deepEqual(document.lastExec, { command: 'insertText', text: '@{y}' }, 'falls back to insertText');
console.log('falls back when paste is ignored ok');

// 4. A plain input that ignores paste keeps splicing at the caret.
const plainInput = new HTMLInputElement({ 'aria-label': 'Plain' });
plainInput.value = 'ac';
plainInput.selectionStart = plainInput.selectionEnd = 1;
focus(plainInput);
assert.equal(insertAtCaret('b'), true);
assert.equal(plainInput.value, 'abc');
console.log('plain input still splices ok');

// ── The target's kind drives how callers format a value ───────────────────
// The fx flyout is a plain textarea and wants a bare expression; the inline
// token editors are contenteditable and want it wrapped in @{ }.
focus(new HTMLTextAreaElement({ 'aria-label': 'Expression' }));
assert.equal(targetKind(), 'textarea');
focus(new FakeElement('div', {}));
assert.equal(targetKind(), 'textarea', 'a non-editable does not change the target');
const inlineEditor = new FakeElement('div', {});
inlineEditor.isContentEditable = true;
selection.range = new FakeRange();
focus(inlineEditor);
assert.equal(targetKind(), 'editable');
focus(new HTMLInputElement({ 'aria-label': 'Plain box' }));
assert.equal(targetKind(), 'input');
console.log('target kind ok');

// ── The chip ──────────────────────────────────────────────────────────────
let activated = 0;
hideCaretChip();
showCaretChip({ label: '🧬', title: 'test', onActivate: () => { activated++; } });

// The chip lives in its own surface so it can be re-parented into a popover,
// so look for it across every surface still attached.
const findChip = () => document.hosts
    .filter((host) => host.isConnected)
    .flatMap((host) => host.shadow?.children ?? [])
    .find((node) => node.className?.includes('ppt-caret-chip'));
const chip = findChip();
assert.ok(chip, 'the chip is mounted into the toolbox shadow root');

const field = new HTMLInputElement({ 'aria-label': 'Select columns' });
field.rect = { top: 100, left: 200, right: 500, bottom: 132, width: 300, height: 32 };
focus(field);
window.fire('scroll');

// Nothing parked against the field: sits just off its right edge.
assert.equal(chip.style.display, 'flex');
assert.equal(chip.style.left, '506px');
assert.equal(chip.style.top, '103px', 'vertically centred on the field');
console.log('chip anchors to the focused field ok');

// The designer stacks its own dynamic-content and fx buttons exactly there,
// so the chip must probe past them rather than land on top.
const nativeButton = new FakeElement('button');
document.occupied = [
    { x1: 500, x2: 530, y1: 100, y2: 132, element: nativeButton },
    { x1: 530, x2: 562, y1: 100, y2: 132, element: nativeButton },
];
window.fire('scroll');
assert.equal(chip.style.left, '570px', 'steps clear of both native buttons');
console.log('chip avoids the native buttons ok');

// No room on the right — fall back to the empty space on the left.
field.rect = { top: 100, left: 200, right: 1195, bottom: 132, width: 995, height: 32 };
document.occupied = [];
window.fire('scroll');
assert.equal(chip.style.left, '168px', 'tucks to the left of the field instead');
console.log('chip falls back to the left ok');

// Clicking must not move the caret — that is the entire reason it exists.
const mousedown = new FakeEvent('mousedown');
chip.dispatchEvent(mousedown);
assert.equal(mousedown.defaultPrevented, true, 'mousedown is cancelled so the field keeps focus');
const chipClick = new FakeEvent('click');
chip.dispatchEvent(chipClick);
assert.equal(activated, 1, 'clicking opens the tool');
console.log('chip preserves focus on click ok');

// ...and the page must not see the click at all, or a popover open against the
// field reads it as a click outside itself and dismisses.
assert.equal(mousedown.propagationStopped, true, 'mousedown never reaches the page');
assert.equal(chipClick.propagationStopped, true, 'click never reaches the page');
for (const type of ['pointerdown', 'pointerup', 'mouseup', 'touchstart', 'dblclick']) {
    const event = new FakeEvent(type);
    chip.dispatchEvent(event);
    assert.equal(event.propagationStopped, true, `${type} never reaches the page`);
}
console.log('chip shields the page from its clicks ok');

// Docked into a host-page toolbar it becomes an ordinary child of that
// toolbar: laid out by it, and inside the surface whose dismiss logic would
// otherwise count the click as landing outside.
const toolbar = new FakeElement('div', { 'data-automation-id': 'token-picker-header' });
document.body.appendChild(toolbar);
const chipHost = document.hosts.find((host) => host.shadow?.children?.includes(chip));

hideCaretChip();
let dockTo = null;
showCaretChip({ label: '🧬', dock: () => dockTo, onActivate: () => {} });
const docked = findChip();
const dockedHost = document.hosts.find((host) => host.shadow?.children?.includes(docked));

const dockField = new HTMLInputElement({ 'aria-label': 'Expression' });
dockField.rect = { top: 100, left: 200, right: 500, bottom: 132, width: 300, height: 32 };
focus(dockField);
window.fire('scroll');
assert.equal(dockedHost.parentElement, document.body, 'floats when there is no toolbar');
assert.ok(!(docked.className ?? '').includes('docked'));

dockTo = toolbar;
window.fire('scroll');
assert.equal(dockedHost.parentElement, toolbar, 'moves into the toolbar when one appears');
assert.ok(docked.className.includes('docked'), 'and drops its own positioning');
assert.equal(docked.style.display, 'flex');

dockTo = null;
window.fire('scroll');
assert.equal(dockedHost.parentElement, document.body, 'and floats again when it closes');
assert.ok(!docked.className.includes('docked'));
hideCaretChip();
console.log('chip docks into a host toolbar ok');

// A field inside a modal surface is not a designer input. A plain
// role="dialog" must NOT be suppressed — the designer's action pane is one,
// and that is where the chip is most wanted.
hideCaretChip();
showCaretChip({ label: '🧬', onActivate: () => {} });
const guarded = findChip();
const runPanel = new FakeElement('div', { 'aria-modal': 'true' });
document.body.appendChild(runPanel);
const panelField = new HTMLInputElement({ 'aria-label': 'ContractNr' });
panelField.rect = { top: 100, left: 200, right: 500, bottom: 132, width: 300, height: 32 };
runPanel.appendChild(panelField);
focus(panelField);
window.fire('scroll');
assert.equal(guarded.style.display, 'none', 'suppressed inside a modal surface');

// The same field outside a dialog is fine.
document.body.appendChild(panelField);
window.fire('scroll');
assert.equal(guarded.style.display, 'flex');
// The designer's own action pane is role="dialog" but not modal.
const pane = new FakeElement('div', { role: 'dialog' });
document.body.appendChild(pane);
pane.appendChild(panelField);
window.fire('scroll');
assert.equal(guarded.style.display, 'flex', 'still shows in a non-modal dialog pane');
document.body.appendChild(panelField);
console.log('chip stays out of modal surfaces only ok');

// If every candidate position is taken, show nothing rather than sit on top of
// a control and swallow the click meant for it.
const blocker = new FakeElement('button');
document.occupied = [{ x1: 0, x2: 1200, y1: 0, y2: 800, element: blocker }];
window.fire('scroll');
assert.equal(guarded.style.display, 'none', 'hidden when nowhere is clear');
document.occupied = [];
window.fire('scroll');
assert.equal(guarded.style.display, 'flex', 'and back once space frees up');
hideCaretChip();
console.log('chip never covers a page control ok');

// Gated off pages it is useless on.
hideCaretChip();
showCaretChip({ label: '🧬', when: () => false, onActivate: () => {} });
const gated = findChip();
focus(field);
window.fire('scroll');
assert.equal(gated.style.display, 'none', 'the when() gate hides it');
console.log('chip respects the page gate ok');

hideCaretChip();
showCaretChip({ label: '🧬', onActivate: () => {} });
const last = findChip();
field.rect = { top: 100, left: 200, right: 500, bottom: 132, width: 300, height: 32 };
focus(field);
window.fire('scroll');
assert.equal(last.style.display, 'flex');

// The regression that made it flash and vanish: these editors hand focus to a
// wrapper of their own a moment after you click in, while the caret stays put.
// The chip must not be tied to document.activeElement.
document.activeElement = new FakeElement('div');
window.fire('scroll');
assert.equal(last.style.display, 'flex', 'survives the editor moving focus to its own wrapper');
console.log('chip survives an activeElement handoff ok');

// Scrolled out of view, though, it should go.
field.rect = { top: 900, left: 200, right: 500, bottom: 932, width: 300, height: 32 };
window.fire('scroll');
assert.equal(last.style.display, 'none', 'hidden once the field scrolls off screen');

// And a field the page has torn down takes it away too.
field.rect = { top: 100, left: 200, right: 500, bottom: 132, width: 300, height: 32 };
window.fire('scroll');
assert.equal(last.style.display, 'flex');
field.isConnected = false;
window.fire('scroll');
assert.equal(last.style.display, 'none', 'hidden once the field is detached');
hideCaretChip();
console.log('chip hides when the field goes away ok');

console.log('\ncaret smoke test passed');
