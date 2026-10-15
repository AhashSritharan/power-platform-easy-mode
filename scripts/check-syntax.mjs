#!/usr/bin/env node
/**
 * `node --check` on every JavaScript file of the extension and the tests — the
 * extension has no build step, so a syntax error would otherwise first show up
 * in someone's browser.
 * Run: node scripts/check-syntax.mjs
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function* files(dir) {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules') continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) yield* files(path);
        else if (/\.(m?js)$/.test(name)) yield path;
    }
}

let failed = 0;
let count = 0;
for (const dir of ['extension', 'tests', 'scripts']) {
    for (const file of files(join(ROOT, dir))) {
        count++;
        try {
            execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
        } catch (e) {
            failed++;
            process.stderr.write(e.stderr.toString());
        }
    }
}
console.log(failed ? `check-syntax: ${failed} of ${count} files failed.` : `check-syntax: ${count} files OK.`);
process.exit(failed ? 1 : 0);
