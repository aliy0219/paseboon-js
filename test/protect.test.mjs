import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { createAuthenticator, AUTH_REASON, WINDOWS_SCRIPT } from '../src/platform/auth.js';
import { Result } from '../src/core/authgate.js';
import { OPEN_CHANNELS, PROTECTED_CHANNELS, protectRoutes } from '../src/main/protect.js';

const ROOT = path.join(import.meta.dirname, '..');
const MAIN = readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');

// ── IPC protection ────────────────────────────────────────────────────────
test('every protected IPC handler is rejected without a session (handler never runs)', async () => {
  const called = [];
  const routes = Object.fromEntries([...PROTECTED_CHANNELS, ...OPEN_CHANNELS]
    .map((c) => [c, async () => { called.push(c); return { ok: true }; }]));
  const denied = protectRoutes(routes, { requireAuth: async () => ({ ok: false, reason: 'cancelled' }) });
  for (const c of PROTECTED_CHANNELS) {
    assert.deepEqual(await denied[c]('x'), { authRequired: true, ok: false, reason: 'cancelled' }, c);
  }
  assert.deepEqual(called, []);
  for (const c of OPEN_CHANNELS) await denied[c]();
  assert.deepEqual(called, [...OPEN_CHANNELS], 'open channels never ask');
});

test('with a session, protected handlers run with their argument', async () => {
  const wrapped = protectRoutes({ 'save-settings': async (a) => ({ got: a }) }, { requireAuth: async () => ({ ok: true }) });
  assert.deepEqual(await wrapped['save-settings']({ usbGuard: false }), { got: { usbGuard: false } });
});

test('an unclassified channel is refused at startup', () => {
  assert.throws(() => protectRoutes({ 'new-thing': () => {} }, { requireAuth: async () => ({ ok: true }) }), /not classified/);
});

test('the required actions are protected; reading state and Lock now are not', () => {
  for (const c of ['save-settings', 'enroll', 'test-lock', 'set-login-item', 'set-paused', 'usb-trust',
    'usb-untrust', 'usb-trust-connected', 'usb-clear-events', 'photos-delete-all']) {
    assert.ok(PROTECTED_CHANNELS.includes(c), c);
  }
  for (const c of ['get-state', 'usb-state']) assert.ok(OPEN_CHANNELS.includes(c), c);
});

test('main.js registers every IPC handler through protectRoutes', () => {
  assert.match(MAIN, /protectRoutes\(routes, \{ requireAuth \}\)/);
  assert.doesNotMatch(MAIN, /handle\('[a-z-]+'/, 'no direct handle(\'channel\') registrations');
  for (const c of [...PROTECTED_CHANNELS, ...OPEN_CHANNELS]) {
    assert.ok(MAIN.includes(`'${c}'`) || MAIN.includes(` ${c}:`), `route ${c} exists in main.js`);
  }
});

test('tray: Settings, Pause and Quit are guarded; Lock now is never blocked', () => {
  assert.match(MAIN, /label: 'Settings…', click: \(\) => openSettingsGuarded\(\)/);
  assert.match(MAIN, /click: \(\) => guarded\('pause'/);
  assert.match(MAIN, /label: 'Quit Paseboon JS', click: \(\) => guarded\('quit', \(\) => app\.quit\(\)\)/);
  assert.match(MAIN, /label: 'Lock now…', enabled: Boolean\(state\.agent\), click: \(\) => lockNow\(/);
});

test('OS shutdown/logout is never blocked: no before-quit / will-quit veto', () => {
  assert.doesNotMatch(MAIN, /['"](before-quit|will-quit)['"]/);
  assert.doesNotMatch(MAIN, /preventDefault\(\)[^\n]*quit/i);
});

// ── OS authenticator ──────────────────────────────────────────────────────
function fakeExec(outcomes) {
  const calls = [];
  const fn = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    const o = outcomes.shift() ?? { code: 0 };
    if (o.code === 0) return cb(null, o.stdout ?? '');
    const err = Object.assign(new Error('exit'), { code: o.code, killed: o.killed });
    return cb(err, o.stdout ?? '');
  };
  return { fn, calls };
}

test('macOS: the helper gets exactly the fixed reason; exit codes map; --check never prompts', async () => {
  const ex = fakeExec([{ code: 0 }, { code: 1 }, { code: 2 }, { code: 3, stdout: 'unavailable: no passcode' },
    { code: 4 }, { code: null, killed: true }, { code: 0, stdout: 'available biometry=touchID' }]);
  const a = createAuthenticator({ platform: 'darwin', helper: '/x/paseboon-auth', execFile: ex.fn, exists: () => true });
  assert.equal((await a.authenticate()).result, Result.OK);
  assert.equal((await a.authenticate()).result, Result.FAILED);
  assert.equal((await a.authenticate()).result, Result.CANCELLED);
  assert.deepEqual(await a.authenticate(), { result: Result.UNAVAILABLE, detail: 'unavailable: no passcode' });
  assert.equal((await a.authenticate()).result, Result.CANCELLED, 'usage error denies');
  assert.equal((await a.authenticate()).result, Result.CANCELLED, 'timeout denies');
  assert.deepEqual(await a.check(), { available: true, detail: 'available biometry=touchID' });
  for (const c of ex.calls.slice(0, 6)) {
    assert.equal(c.file, '/x/paseboon-auth');
    assert.deepEqual(c.args, [AUTH_REASON]);
    assert.ok(c.opts.timeout > 0);
  }
  assert.deepEqual(ex.calls[6].args, ['--check']);
});

test('macOS: a missing helper means unavailable (with the reason), never a crash', async () => {
  const a = createAuthenticator({ platform: 'darwin', helper: '/nope', execFile: () => assert.fail('ran'), exists: () => false });
  const r = await a.authenticate();
  assert.equal(r.result, Result.UNAVAILABLE);
  assert.match(r.detail, /helper missing/);
  assert.equal((await a.check()).available, false);
});

test('Windows (untested on Windows): fixed PowerShell script, no shell, mode via env', async () => {
  const ex = fakeExec([{ code: 2 }]);
  const a = createAuthenticator({ platform: 'win32', execFile: ex.fn });
  assert.equal((await a.authenticate()).result, Result.CANCELLED);
  assert.equal(ex.calls[0].file, 'powershell.exe');
  assert.equal(ex.calls[0].args.at(-1), WINDOWS_SCRIPT);
  assert.equal(ex.calls[0].opts.env.PASEBOON_AUTH_MODE, 'prompt');
  assert.ok(WINDOWS_SCRIPT.includes(`'${AUTH_REASON}'`));
});

test('Linux (untested on Linux): pkexec codes map; missing pkexec is unavailable', async () => {
  const ex = fakeExec([{ code: 0 }, { code: 127 }, { code: 126 }]);
  const a = createAuthenticator({ platform: 'linux', execFile: ex.fn });
  assert.equal((await a.authenticate()).result, Result.OK);
  assert.equal((await a.authenticate()).result, Result.FAILED);
  assert.equal((await a.authenticate()).result, Result.CANCELLED);
  assert.deepEqual(ex.calls[0].args, ['/bin/true']);
  const missing = createAuthenticator({
    platform: 'linux', execFile: (f, a2, o, cb) => cb(Object.assign(new Error('x'), { code: 'ENOENT' })),
  });
  assert.equal((await missing.authenticate()).result, Result.UNAVAILABLE);
});

test('security: the helper runs via execFile with fixed args, never a shell', () => {
  const src = readFileSync(path.join(ROOT, 'src', 'platform', 'auth.js'), 'utf8');
  assert.match(src, /import \{ execFile as nodeExecFile \} from 'node:child_process'/);
  assert.doesNotMatch(src, /\bexec\(|execSync|spawn\(|shell:\s*true/);
  assert.match(src, /\[AUTH_REASON\]/);
  assert.match(src, /export const AUTH_REASON = 'Paseboon JS: change settings';/);
  // nothing else in the app spawns the helper
  assert.equal((MAIN.match(/paseboon-auth/g) || []).length, 0);
});
