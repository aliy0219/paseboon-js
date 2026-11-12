import assert from 'node:assert/strict';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  SETTINGS_DEFAULTS, TemplateError, loadSettings, loadTemplates, saveSettings, saveTemplates,
} from '../src/core/storage.js';
import { DETECTOR, ModelError, RECOGNIZER, ZOO_COMMIT, loadVerified } from '../src/vision/models.js';
import { relaxShapes } from '../src/vision/onnx-patch.js';
import { YUNET_RELAXED_SHA256, loadDetectorBytes } from '../src/vision/engine.js';
import { tmpDir } from './support/tmp.mjs';

const POSIX = process.platform !== 'win32';
const tmp = async () => tmpDir('storage-');
const rand = (n = 4) => Array.from({ length: n }, (_, i) => Array.from({ length: 128 }, (_, j) => Math.sin(i * 7 + j)));

// ── templates ─────────────────────────────────────────────────────────────
test('templates roundtrip is normalized', async () => {
  const f = path.join(await tmp(), 'sub', 't.json');
  assert.equal(await saveTemplates(f, rand()), 4);
  const got = await loadTemplates(f);
  assert.equal(got.length, 4);
  for (const v of got) assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-5);
});

test('template file is owner-only and its dir is 0700', { skip: !POSIX }, async () => {
  const dir = path.join(await tmp(), 'data');
  const f = path.join(dir, 't.json');
  await saveTemplates(f, rand());
  assert.equal((await stat(f)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
});

test('world-readable templates are refused', { skip: !POSIX }, async () => {
  const f = path.join(await tmp(), 't.json');
  await saveTemplates(f, rand());
  await chmod(f, 0o644);
  await assert.rejects(loadTemplates(f), /readable by other users/);
});

test('bad embeddings rejected', async () => {
  const f = path.join(await tmp(), 't.json');
  for (const bad of [[], [Array(64).fill(1)], [Array(128).fill(Number.NaN)], [Array(128).fill(0)], 'x']) {
    await assert.rejects(saveTemplates(f, bad), TemplateError);
  }
});

test('missing / malformed template files give TemplateError', async () => {
  const dir = await tmp();
  await assert.rejects(loadTemplates(path.join(dir, 'none.json')), /no face templates/);
  const f = path.join(dir, 'bad.json');
  await writeFile(f, '{"version":1,"dim":128,"embeddings":[["__proto__"]]}', { mode: 0o600 });
  await assert.rejects(loadTemplates(f), TemplateError);
});

// ── settings ──────────────────────────────────────────────────────────────
test('missing settings -> defaults, no warning', async () => {
  const r = await loadSettings(path.join(await tmp(), 'nope.json'));
  assert.deepEqual(r.settings, SETTINGS_DEFAULTS);
  assert.equal(r.warning, null);
});

test('corrupt settings -> defaults WITH a visible warning (still watching)', async () => {
  const f = path.join(await tmp(), 's.json');
  for (const body of ['{not json', '[]', '{"idleThreshold": -5}', '{"mode": "nobody"}', 'null']) {
    await writeFile(f, body);
    const r = await loadSettings(f);
    assert.deepEqual(r.settings, SETTINGS_DEFAULTS, body);
    assert.match(r.warning, /using defaults/, body);
  }
});

test('settings save/load roundtrip, unknown keys dropped, file 0600', async () => {
  const f = path.join(await tmp(), 's.json');
  await saveSettings(f, { ...SETTINGS_DEFAULTS, idleThreshold: 25, mode: 'owner', evil: 1 });
  const r = await loadSettings(f);
  assert.equal(r.settings.idleThreshold, 25);
  assert.equal(r.settings.mode, 'owner');
  assert.ok(!('evil' in JSON.parse(await readFile(f, 'utf8'))));
  if (POSIX) assert.equal((await stat(f)).mode & 0o777, 0o600);
});

test('invalid settings are not saved', async () => {
  const f = path.join(await tmp(), 's.json');
  await assert.rejects(saveSettings(f, { idleThreshold: 0 }));
  await assert.rejects(saveSettings(f, { matchThreshold: 2 }));
});

// ── models ────────────────────────────────────────────────────────────────
test('pinned models verify; pins are commit-pinned', async () => {
  const dir = path.join(import.meta.dirname, '..', 'models');
  for (const m of [DETECTOR, RECOGNIZER]) {
    assert.ok(m.url.includes(ZOO_COMMIT));
    assert.equal((await loadVerified(m, dir)).length, m.size);
  }
});

test('tampered or missing model is refused', async () => {
  const dir = await tmp();
  await assert.rejects(loadVerified(DETECTOR, dir), ModelError);
  await writeFile(path.join(dir, DETECTOR.filename), Buffer.alloc(DETECTOR.size, 1));
  await assert.rejects(loadVerified(DETECTOR, dir), /SHA-256 mismatch/);
  await writeFile(path.join(dir, DETECTOR.filename), Buffer.alloc(10));
  await assert.rejects(loadVerified(DETECTOR, dir), /expected/);
});

test('relaxed YuNet graph is deterministic and pinned', async () => {
  const bytes = await loadDetectorBytes(path.join(import.meta.dirname, '..', 'models'));
  assert.equal(bytes.length < DETECTOR.size, true);
  assert.ok(YUNET_RELAXED_SHA256.length === 64);
  assert.throws(() => relaxShapes(Buffer.from('not a model at all')));
});
