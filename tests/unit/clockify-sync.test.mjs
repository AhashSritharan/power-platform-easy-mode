/**
 * Clockify → Dynamics 365 Sync (extension/src/tools/clockify-sync.js): how
 * Clockify time entries become CRM time entries — same description on the
 * same day merged into one, durations imported as they are or rounded to
 * blocks the way the user's company books time.
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
const { mergeTimeEntries, roundDuration, normalizeRounding, durationLabel } = await import(pathToFileURL(join(ROOT, 'extension/src/tools/clockify-sync.js')));

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

test('durations are imported unrounded by default', () => {
    assert.equal(roundDuration(4), 4, 'short entries are kept, not rounded to nothing');
    assert.equal(roundDuration(83), 83);
    assert.equal(roundDuration(83, { block: 0, roundUpFrom: 1 }), 83);
    assert.equal(roundDuration(83, { block: 7, roundUpFrom: 1 }), 83, 'a block size it does not offer does not round');
});

test('rounds up to the next block from the chosen minute, and down below it', () => {
    const tenFromFour = (minutes) => roundDuration(minutes, { block: 10, roundUpFrom: 4 });
    assert.equal(tenFromFour(4), 10);
    assert.equal(tenFromFour(3), 0);
    assert.equal(tenFromFour(13), 10);
    assert.equal(tenFromFour(14), 20);
    assert.equal(tenFromFour(20), 20, 'a whole block stays as it is');
});

test('rounding up from 1 minute rounds every started block up', () => {
    const quarterFromOne = (minutes) => roundDuration(minutes, { block: 15, roundUpFrom: 1 });
    assert.equal(quarterFromOne(1), 15);
    assert.equal(quarterFromOne(15), 15);
    assert.equal(quarterFromOne(16), 30);
});

test('15-minute blocks rounding up from 5 minutes', () => {
    const quarterFromFive = (minutes) => roundDuration(minutes, { block: 15, roundUpFrom: 5 });
    assert.equal(quarterFromFive(18), 15);
    assert.equal(quarterFromFive(20), 30);
    assert.equal(quarterFromFive(83), 90);
    assert.equal(quarterFromFive(4), 0);
});

test('a saved or typed setting is brought into range', () => {
    assert.deepEqual(normalizeRounding({ block: 10, roundUpFrom: 4 }), { block: 10, roundUpFrom: 4 });
    assert.deepEqual(normalizeRounding({ block: '15', roundUpFrom: '5' }), { block: 15, roundUpFrom: 5 }, 'form values are strings');
    assert.deepEqual(normalizeRounding({ block: 10, roundUpFrom: 0 }), { block: 10, roundUpFrom: 1 });
    assert.deepEqual(normalizeRounding({ block: 10, roundUpFrom: 25 }), { block: 10, roundUpFrom: 10 }, 'at most the block: then it only rounds down');
    assert.deepEqual(normalizeRounding({ block: 10, roundUpFrom: 'abc' }), { block: 10, roundUpFrom: 1 });
    assert.deepEqual(normalizeRounding({ block: 7, roundUpFrom: 3 }), { block: 0, roundUpFrom: 1 }, 'unknown block size: no rounding');
    assert.deepEqual(normalizeRounding(undefined), { block: 0, roundUpFrom: 1 });
});

test('the import list shows the duration CRM gets when rounding changes it', () => {
    const min = (m) => m * 60000;
    const tenFromFour = { block: 10, roundUpFrom: 4 };
    assert.equal(durationLabel([min(63)]), '1h 3m', 'no rounding: just the tracked time');
    assert.equal(durationLabel([min(60)], tenFromFour), '1h 0m', 'rounding that leaves it as it is');
    assert.equal(durationLabel([min(63)], tenFromFour), '1h 3m → 1h 0m in CRM', 'rounded down shows too');
    assert.equal(durationLabel([min(64)], tenFromFour), '1h 4m → 1h 10m in CRM');
    assert.equal(durationLabel([min(4) + 20000], tenFromFour), '0h 4m → 0h 10m in CRM', 'seconds round to the minute first');
});

test('several entries are rounded one by one, as they are imported', () => {
    const min = (m) => m * 60000;
    // 2 × 14 min: 28 min tracked, but each entry imports as 20.
    assert.equal(durationLabel([min(14), min(14)], { block: 10, roundUpFrom: 4 }), '0h 28m → 0h 40m in CRM');
});
