// Packaging guards (cheap text checks on electron-builder.yml).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.join(import.meta.dirname, '..');
const yml = readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');

test('every platform repeats the app file list (platform `files` replace the top-level list)', () => {
  // A platform list with only exclusions once shipped dist/, test/ and more (1.8 GB app).
  assert.equal(yml.match(/^\s*- src\/\*\*\/\*$/gm)?.length, 4);
  assert.equal(yml.match(/^\s*- package\.json$/gm)?.length, 4);
});

test('identity, native modules, models and camera text are configured', () => {
  assert.match(yml, /^appId: local\.paseboon-js$/m);
  assert.match(yml, /node_modules\/onnxruntime-node\/bin\/\*\*/);
  assert.match(yml, /node_modules\/@koromix\/\*\*/);
  assert.match(yml, /from: models/);
  assert.match(yml, /NSCameraUsageDescription/);
  assert.match(yml, /LSUIElement: true/);
  assert.match(readFileSync(path.join(ROOT, 'build', 'entitlements.mac.plist'), 'utf8'),
    /com\.apple\.security\.device\.camera/);
});

test('dependencies are pinned exactly', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const [name, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.match(v, /^\d+\.\d+\.\d+$/, `${name}@${v}`);
  }
});

test('CI actions are pinned to commit SHAs', () => {
  const wf = readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yml'), 'utf8');
  for (const m of wf.matchAll(/uses: ([^\s]+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, m[1]);
});
