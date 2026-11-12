import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { migrateLegacy } from '../src/core/migrate.js';
import { tmpDir } from './support/tmp.mjs';

const mode = (p) => statSync(p).mode & 0o777;

test('legacy data is copied once, owner-only, without Chromium data', () => {
  const root = tmpDir('migrate');
  const oldDir = path.join(root, 'away-lock-js');
  const newDir = path.join(root, 'paseboon-js');
  mkdirSync(path.join(oldDir, 'intruder_photos'), { recursive: true });
  writeFileSync(path.join(oldDir, 'face_templates.json'), '[]');
  writeFileSync(path.join(oldDir, 'intruder_photos', 'a.jpg'), 'x');
  writeFileSync(path.join(oldDir, 'Cookies'), 'chromium');
  assert.deepEqual(migrateLegacy(newDir, oldDir).sort(), ['face_templates.json', 'intruder_photos']);
  assert.equal(readFileSync(path.join(newDir, 'face_templates.json'), 'utf8'), '[]');
  assert.equal(existsSync(path.join(newDir, 'Cookies')), false);
  if (process.platform !== 'win32') {
    assert.equal(mode(newDir), 0o700);
    assert.equal(mode(path.join(newDir, 'face_templates.json')), 0o600);
    assert.equal(mode(path.join(newDir, 'intruder_photos')), 0o700);
    assert.equal(mode(path.join(newDir, 'intruder_photos', 'a.jpg')), 0o600);
  }
  assert.ok(existsSync(oldDir), 'copied, not moved');
  writeFileSync(path.join(oldDir, 'settings.json'), '{}');
  assert.deepEqual(migrateLegacy(newDir, oldDir), [], 'second run is a no-op');
  assert.equal(existsSync(path.join(newDir, 'settings.json')), false);
});

test('no legacy folder: nothing created', () => {
  const root = tmpDir('migrate-none');
  assert.deepEqual(migrateLegacy(path.join(root, 'new'), path.join(root, 'old')), []);
  assert.equal(existsSync(path.join(root, 'new')), false);
});
