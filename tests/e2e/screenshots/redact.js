// Keeps the developer environment's identity out of the README screenshots.
//
// Before every capture, each string that names the tenant, an org or the test
// user is replaced on the page — text, input values, titles, inside the
// toolbox's shadow roots and same-origin frames — by a placeholder. Then the
// page is read back, and the capture is refused if any of those strings, or
// anything shaped like an org host, is still there.
//
// The sensitive-data scan cannot read images, so this is the check that
// stands between a real page and a public PNG. Look at every image anyway.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../support/env.js';

// Shapes that identify an environment whatever their exact value.
const PATTERNS = [
    /\borg[0-9a-f]{8}\b/gi,                // org unique names and default-publisher suffixes
    /\b[a-z0-9-]+\.onmicrosoft\.com\b/gi,  // tenant domains
];

export class Redactor {
    constructor() {
        this.pairs = [];      // [real, placeholder], longest first
        this.exact = [];      // short tokens (initials) replaced only as a whole text node
        const denylist = join(ROOT, '.sensitive-denylist');
        if (existsSync(denylist)) {
            for (const line of readFileSync(denylist, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) this.add(line, 'Contoso');
        }
    }

    /** Replaces `real` (case-insensitive) with `placeholder` from now on. Ignores values too short to be safe to replace. */
    add(real, placeholder) {
        if (typeof real !== 'string' || real.trim().length < 4) return this;
        if (!this.pairs.some(([r]) => r.toLowerCase() === real.toLowerCase())) this.pairs.push([real, placeholder]);
        this.pairs.sort((a, b) => b[0].length - a[0].length);
        return this;
    }

    /** A short token such as the user's initials, replaced only where it is the whole text of an element. */
    addExact(real, placeholder) {
        if (real) this.exact.push([real, placeholder]);
        return this;
    }

    /** A host and its first label ("contoso-dev.crm4.dynamics.com" and "contoso-dev"). */
    addHost(host, placeholderHost) {
        this.add(host, placeholderHost);
        this.add(host.split('.')[0], placeholderHost.split('.')[0]);
        return this;
    }

    async apply(page) {
        for (const frame of page.frames()) {
            await frame.evaluate(rewrite, { pairs: this.pairs, exact: this.exact, patterns: PATTERNS.map((p) => p.source) }).catch((e) => {
                if (!frame.isDetached()) throw e;
            });
        }
    }

    /** Throws when anything sensitive is still readable on the page. */
    async verify(page) {
        const leaks = new Set();
        for (const frame of page.frames()) {
            // Where, never what: the message ends up in test output.
            for (const { where, text } of await frame.evaluate(readAll).catch(() => [])) {
                const lower = text.toLowerCase();
                for (const [real] of this.pairs) if (lower.includes(real.toLowerCase())) leaks.add(`a redacted value (${real.length} chars) in ${where}`);
                for (const p of PATTERNS) if (new RegExp(p.source, 'i').test(text)) leaks.add(`text matching ${p.source} in ${where}`);
            }
        }
        if (leaks.size) throw new Error(`Refusing to take the screenshot — still on the page: ${[...leaks].join(', ')}`);
    }

    /**
     * apply → verify → screenshot → verify again. Parts of the portals (the
     * account menu in the top bar) render their text again on their own, so a
     * capture that may have caught one of those is retaken, and it is only
     * kept when the page was clean before and after it.
     */
    async shot(page, target, options) {
        let last;
        for (let attempt = 0; attempt < 10; attempt++) {
            try {
                await this.apply(page);
                await this.verify(page);
                const image = await target.screenshot({ animations: 'disabled', ...options, path: undefined });
                await this.verify(page);
                if (options?.path) writeFileSync(options.path, image);
                return image;
            } catch (e) {
                if (!/^Refusing/.test(e.message)) throw e;
                last = e;
                await page.waitForTimeout(500);
            }
        }
        throw last;
    }
}

// ── In the page ───────────────────────────────────────────────────────────
// Both run inside the browser, so they are self-contained.

function rewrite({ pairs, exact, patterns }) {
    const res = patterns.map((p) => new RegExp(p, 'gi'));
    const fix = (s) => {
        if (!s) return s;
        let out = s;
        for (const [real, placeholder] of pairs) {
            const i = out.toLowerCase().indexOf(real.toLowerCase());
            if (i >= 0) out = out.split(new RegExp(real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join(placeholder);
        }
        for (const re of res) out = out.replace(re, 'contoso');
        return out;
    };
    const visit = (root) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
        for (let node = walker.currentNode; node; node = walker.nextNode()) {
            if (node.nodeType === Node.TEXT_NODE && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.parentNode?.nodeName)) continue;
            if (node.nodeType === Node.TEXT_NODE) {
                const fixed = fix(node.nodeValue);
                if (fixed !== node.nodeValue) node.nodeValue = fixed;
                const whole = node.nodeValue.trim();
                const short = exact.find(([real]) => real === whole);
                if (short) node.nodeValue = node.nodeValue.replace(whole, short[1]);
                continue;
            }
            for (const attr of ['title', 'aria-label', 'placeholder', 'alt']) {
                const v = node.getAttribute?.(attr);
                if (v && fix(v) !== v) node.setAttribute(attr, fix(v));
            }
            try {
                if ('value' in node && typeof node.value === 'string' && fix(node.value) !== node.value) node.value = fix(node.value);
            } catch { /* file inputs and the like refuse a value; they show none */ }
            if (node.shadowRoot) visit(node.shadowRoot);
        }
    };
    visit(document.documentElement);
}

function readAll() {
    const parts = [];
    const describe = (el) => {
        if (!el) return '?';
        const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        return `<${el.nodeName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls ? `.${cls}` : ''}>`;
    };
    const visit = (root) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
        for (let node = walker.currentNode; node; node = walker.nextNode()) {
            if (node.nodeType === Node.TEXT_NODE && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.parentNode?.nodeName)) continue;
            if (node.nodeType === Node.TEXT_NODE) { parts.push({ where: `the text of ${describe(node.parentElement)}`, text: node.nodeValue }); continue; }
            for (const attr of ['title', 'aria-label', 'placeholder', 'alt']) {
                const v = node.getAttribute?.(attr);
                if (v) parts.push({ where: `${attr} of ${describe(node)}`, text: v });
            }
            if ('value' in node && typeof node.value === 'string') parts.push({ where: `the value of ${describe(node)}`, text: node.value });
            if (node.shadowRoot) visit(node.shadowRoot);
        }
    };
    visit(document.documentElement);
    return parts;
}
