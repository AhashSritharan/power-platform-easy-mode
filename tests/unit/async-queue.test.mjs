#!/usr/bin/env node
/**
 * The deploy tests' stall check (tests/e2e/support/async-queue.js): when a
 * deployment times out, was it because the environment's async queue never
 * handed its export or import job to a worker?
 *
 * The job shapes are copied from real asyncoperations rows — on a bad day an
 * export created at 09:51 was only started at 13:46.
 * Run: node --test tests/unit/async-queue.test.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { queueStall } = await import(pathToFileURL(join(ROOT, 'tests/e2e/support/async-queue.js')));

const LIMIT = 5 * 60_000;
const NOW = new Date('2026-10-27T10:00:00Z');
const job = (createdon, startedon = null) =>
    ({ name: 'ExportSolution', statecode: startedon ? 3 : 0, createdon, startedon });

test('a job no worker has picked up past the limit is a stall', () => {
    const stall = queueStall([job('2026-10-27T09:51:59Z')], { now: NOW, limitMs: LIMIT });
    assert.equal(stall?.name, 'ExportSolution');
    assert.equal(stall?.waitMs, 8 * 60_000 + 1000);
});

test('a job picked up late still counts the time it sat in the queue', () => {
    const stall = queueStall([job('2026-10-27T09:43:23Z', '2026-10-27T09:49:30Z')], { now: NOW, limitMs: LIMIT });
    assert.equal(stall?.waitMs, 6 * 60_000 + 7000);
});

test('a job picked up promptly is no stall, however long ago', () => {
    assert.equal(queueStall([job('2026-10-27T09:02:46Z', '2026-10-27T09:02:53Z')], { now: NOW, limitMs: LIMIT }), null);
});

test('a job queued for less than the limit is no stall yet', () => {
    assert.equal(queueStall([job('2026-10-27T09:59:00Z')], { now: NOW, limitMs: LIMIT }), null);
});

test('no jobs at all is no stall: the deployment never got that far', () => {
    assert.equal(queueStall([], { now: NOW, limitMs: LIMIT }), null);
});

test('the longest wait is the one reported', () => {
    const stall = queueStall([
        job('2026-10-27T09:40:00Z', '2026-10-27T09:46:00Z'),
        job('2026-10-27T09:45:00Z'),
    ], { now: NOW, limitMs: LIMIT });
    assert.equal(stall?.waitMs, 15 * 60_000);
});
