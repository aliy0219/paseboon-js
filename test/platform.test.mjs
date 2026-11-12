// Platform adapters: read-only probes only. Never locks the screen.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const isMac = process.platform === 'darwin';

test('macOS: private lock symbol RESOLVES (it is never called here)', { skip: !isMac }, async () => {
  const { resolveLockSymbol } = await import('../src/platform/macos.js');
  assert.equal(typeof resolveLockSymbol(), 'function');
});

test('macOS: lock-state probe answers false while this test runs unlocked', { skip: !isMac }, async () => {
  const { createMacOS } = await import('../src/platform/macos.js');
  const p = createMacOS({ idleSeconds: () => 0, notify: () => {}, log: { warn() {}, error() {} } });
  assert.equal(p.isLocked(), false);
});

test('platform factory exposes the full adapter shape', { skip: !isMac }, async () => {
  const { createPlatform } = await import('../src/platform/index.js');
  const p = await createPlatform({ idleSeconds: () => 3, notify: () => {}, log: { warn() {}, error() {} } });
  for (const k of ['idleSeconds', 'isLocked', 'lock', 'fallbackLock', 'notify']) assert.equal(typeof p[k], 'function', k);
  assert.equal(p.idleSeconds(), 3);
});

test('linux session lookup prefers XDG_SESSION_ID', { skip: process.platform !== 'linux' }, async () => {
  const { findSession } = await import('../src/platform/linux.js');
  process.env.XDG_SESSION_ID = '42';
  assert.equal(await findSession(), '42');
});
