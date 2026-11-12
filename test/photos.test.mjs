// Intruder photos (fake camera + fake encoder) and the shared camera queue.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { createExclusiveQueue } from '../src/core/queue.js';
import {
  MAX_PHOTOS, PHOTO_TIMING, TIMINGS, deleteAll, listPhotos, photoStem, takePhoto,
} from '../src/usb/photos.js';
import { tmpDir } from './support/tmp.mjs';

const POSIX = process.platform !== 'win32';
const quiet = { info() {}, warn() {}, error() {} };
const frame = { width: 2, height: 2, data: new Uint8Array(12) };
const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const opts = (dir, extra = {}) => ({
  deviceKeys: ['0781:5581:4C530001'], dir, grab: async () => frame, encode: () => fakeJpeg, log: quiet, ...extra,
});

test('the timing constant is valid and defaults to photo-first', () => {
  assert.ok(TIMINGS.includes(PHOTO_TIMING));
  assert.equal(PHOTO_TIMING, 'before_lock');
});

test('takePhoto writes a private JPEG named by timestamp + device', async () => {
  const dir = path.join(tmpDir('photos-'), 'intruder_photos');
  const file = await takePhoto(opts(dir, { now: new Date(2026, 10, 12, 9, 5, 7) }));
  assert.equal(path.basename(file), '20261112-090507-0781-5581-4C530001.jpg');
  assert.deepEqual(readFileSync(file), fakeJpeg);
  if (POSIX) {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  }
});

test('the same second never overwrites a photo', async () => {
  const dir = tmpDir('photos-');
  const now = new Date(2026, 0, 1);
  const a = await takePhoto(opts(dir, { now }));
  const b = await takePhoto(opts(dir, { now }));
  assert.notEqual(a, b);
  assert.equal((await listPhotos(dir)).length, 2);
});

test(`retention keeps the newest ${MAX_PHOTOS}`, async () => {
  const dir = tmpDir('photos-');
  for (let i = 0; i < MAX_PHOTOS + 5; i += 1) {
    const f = await takePhoto(opts(dir, { now: new Date(2026, 0, 1, 0, 0, i) }));
    const t = new Date(2026, 0, 1, 0, 0, i);
    utimesSync(f, t, t); // deterministic age
  }
  const left = await listPhotos(dir);
  assert.equal(left.length, MAX_PHOTOS);
  assert.ok(!left.some((f) => path.basename(f).startsWith('20260101-000000')), 'oldest removed');
  assert.ok(left.some((f) => path.basename(f).startsWith('20260101-000054')), 'newest kept');
});

test('delete all removes only photos', async () => {
  const dir = tmpDir('photos-');
  await takePhoto(opts(dir));
  await takePhoto(opts(dir));
  assert.equal(await deleteAll(dir), 2);
  assert.deepEqual(await listPhotos(dir), []);
  assert.equal(await deleteAll(path.join(dir, 'missing')), 0);
});

test('no frame -> error, nothing written', async () => {
  const dir = tmpDir('photos-');
  await assert.rejects(takePhoto(opts(dir, { grab: async () => null })), /no frames/);
  assert.deepEqual(readdirSync(dir), []);
});

test('photo stem sanitises device ids', () => {
  assert.equal(photoStem(['a/b\\..', ''], new Date(2026, 0, 2, 3, 4, 5)), '20260102-030405-a-b');
  assert.equal(photoStem([], new Date(2026, 0, 2, 3, 4, 5)), '20260102-030405-usb');
});

// ── camera queue: the photo waits briefly for an in-flight check ──────────
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('queue runs tasks one at a time, in order', async () => {
  const enqueue = createExclusiveQueue();
  const log = [];
  const task = (name, ms) => async () => { log.push(`${name}+`); await delay(ms); log.push(`${name}-`); return name; };
  const results = await Promise.all([enqueue(task('a', 20)), enqueue(task('b', 5)), enqueue(task('c', 1))]);
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.deepEqual(log, ['a+', 'a-', 'b+', 'b-', 'c+', 'c-']);
});

test('a photo waits for an in-flight check, then takes the camera', async () => {
  const enqueue = createExclusiveQueue();
  const order = [];
  const check = enqueue(async () => { await delay(30); order.push('check'); });
  const photo = enqueue(async () => { order.push('photo'); return 'frame'; }, { waitMs: 500, busyValue: 'busy' });
  assert.equal(await photo, 'frame');
  await check;
  assert.deepEqual(order, ['check', 'photo']);
});

test('a photo gives up when the camera stays busy, and never runs later', async () => {
  const enqueue = createExclusiveQueue();
  let ran = false;
  const check = enqueue(() => delay(80));
  const photo = await enqueue(async () => { ran = true; }, { waitMs: 10, busyValue: 'busy' });
  assert.equal(photo, 'busy');
  await check;
  await delay(5);
  assert.equal(ran, false);
  assert.equal(await enqueue(async () => 'next'), 'next'); // queue still healthy
});
