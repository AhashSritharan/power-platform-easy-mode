/**
 * Clockify → Dynamics 365 Sync (extension/src/tools/clockify-sync.js): how
 * Clockify time entries become CRM time entries — same description on the
 * same day merged into one, durations rounded to 15-minute blocks.
 *
 * The tool writes msdyn_timeentry (Project Operations), which the developer
 * environment does not have, so this logic is pinned down here rather than in
 * a browser test.
 * Run: node --test tests/unit/clockify-sync.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
globalThis.chrome = { runtime: { id: 'test' }, storage: { local: {}, onChanged: { addListener() {} } } };
globalThis.document = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
globalThis.window = { addEventListener() {} };
globalThis.location = { href: 'https://contoso.crm4.dynamics.com/main.aspx', origin: 'https://contoso.crm4.dynamics.com', search: '' };
const { mergeTimeEntries, roundToBlocks } = await import(pathToFileURL(join(ROOT, 'extension/src/tools/clockify-sync.js')));

// Clockify's time-entry shape (description + timeInterval), trimmed.
const entry = (description, start, minutes) => ({
    id: `${description}-${start}`, description,
    timeInterval: { start, end: new Date(new Date(start).getTime() + minutes * 60000).toISOString() },
});

test('entries with the same description on the same day become one, durations summed', () => {
    const merged = mergeTimeEntries([
        entry('PROJ-12 Review', '2026-10-14T13:00:00.000Z', 30),
        entry('PROJ-12 Review ', '2026-10-14T09:00:00.000Z', 45), // trailing space: same task
        entry('PROJ-12 Review', '2026-10-15T09:00:00.000Z', 60), // another day
        entry('Standup', '2026-10-14T08:00:00.000Z', 15),
    ]);
    assert.equal(merged.length, 3);
    const review = merged.find((e) => e.description.trim() === 'PROJ-12 Review' && e.timeInterval.start.startsWith('2026-10-14'));
    assert.equal(review.timeInterval.start, '2026-10-14T09:00:00.000Z', 'starts at the earliest entry');
    assert.equal(review.timeInterval.end, '2026-10-14T10:15:00.000Z', 'and runs for the summed 75 minutes');
    assert.equal(review._count, 2);
});

test('durations round to 15-minute blocks, with up to 5 minutes rounded up', () => {
    assert.equal(roundToBlocks(15), 15);
    assert.equal(roundToBlocks(18), 15);
    assert.equal(roundToBlocks(20), 30);
    assert.equal(roundToBlocks(75), 75);
    assert.equal(roundToBlocks(83), 90);
    assert.equal(roundToBlocks(4), 0, 'today: under 5 minutes rounds to nothing');
});
