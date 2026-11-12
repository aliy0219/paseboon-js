import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AuthGate, DELAYS, FAILS_TO_LOCK, Result, SESSION_IDLE_SECONDS, delayFor, mapExitCode,
} from '../src/core/authgate.js';

const quiet = { info() {}, warn() {}, error() {} };

function setup({ results = [], stored = null, loadThrows = null } = {}) {
  let t = 1_000_000;
  const saved = [];
  const queue = [...results];
  let prompts = 0;
  const store = {
    load() { if (loadThrows) throw loadThrows; return stored; },
    async save(s) { saved.push(s); stored = s; },
  };
  const gate = new AuthGate({
    authenticate: async () => { prompts += 1; return queue.shift() ?? { result: Result.CANCELLED }; },
    store, now: () => t, log: quiet,
  }).load();
  return {
    gate, saved, prompts: () => prompts, advance: (s) => { t += s * 1000; },
    push: (...r) => queue.push(...r), stored: () => stored,
  };
}

const OK = { result: Result.OK };
const FAIL = { result: Result.FAILED };
const CANCEL = { result: Result.CANCELLED };

test('exit codes: only an explicit "unavailable" opens; errors and unknown codes deny', () => {
  assert.equal(mapExitCode(0), Result.OK);
  assert.equal(mapExitCode(1), Result.FAILED);
  assert.equal(mapExitCode(2), Result.CANCELLED);
  assert.equal(mapExitCode(3), Result.UNAVAILABLE);
  for (const c of [4, 5, 99, -1, null, undefined]) assert.equal(mapExitCode(c), Result.CANCELLED, String(c));
});

test('delays: 0, 5, 15, 30, 60 s and capped', () => {
  assert.deepEqual(DELAYS, [0, 5, 15, 30, 60]);
  assert.equal(delayFor(0), 0);
  assert.equal(delayFor(2), 15);
  assert.equal(delayFor(50), 60);
});

test('locked by default; a success unlocks and resets failures', async () => {
  const s = setup({ results: [OK] });
  assert.equal(s.gate.unlocked, false);
  assert.deepEqual(await s.gate.require(), { ok: true });
  assert.equal(s.gate.unlocked, true);
  assert.equal(s.gate.failures, 0);
  assert.deepEqual(await s.gate.require(), { ok: true, unprotected: null }, 'no second prompt');
  assert.equal(s.prompts(), 1);
});

test(`the session ends after ${SESSION_IDLE_SECONDS} s without interaction, or when the window closes`, async () => {
  const s = setup({ results: [OK, OK] });
  await s.gate.require();
  s.advance(SESSION_IDLE_SECONDS - 1);
  s.gate.touch();
  s.advance(SESSION_IDLE_SECONDS - 1);
  assert.equal(s.gate.unlocked, true, 'touch kept it alive');
  s.advance(2);
  assert.equal(s.gate.unlocked, false, 'expired');
  await s.gate.require();
  assert.equal(s.prompts(), 2, 'expired session prompts again');
  s.gate.endSession();
  assert.equal(s.gate.unlocked, false);
});

test('touch never unlocks a locked gate', () => {
  const s = setup();
  s.gate.touch();
  assert.equal(s.gate.unlocked, false);
});

test('a cancel denies and is not counted', async () => {
  const s = setup({ results: [CANCEL] });
  assert.deepEqual(await s.gate.require(), { ok: false, reason: 'cancelled' });
  assert.equal(s.gate.failures, 0);
  assert.equal(s.gate.retryInSeconds(), 0);
});

test('failures: delay without a prompt, then lock at 3 and reset', async () => {
  const s = setup({ results: [FAIL, FAIL, FAIL] });
  assert.deepEqual(await s.gate.require(), { ok: false, reason: 'failed', retryIn: 5, lock: false });
  const early = await s.gate.require();
  assert.equal(early.reason, 'delay');
  assert.ok(early.retryIn > 0 && early.retryIn <= 5);
  assert.equal(s.prompts(), 1, 'no prompt during the delay');
  s.advance(5);
  assert.deepEqual(await s.gate.require(), { ok: false, reason: 'failed', retryIn: 15, lock: false });
  s.advance(15);
  assert.deepEqual(await s.gate.require(), { ok: false, reason: 'failed', retryIn: 0, lock: true });
  assert.equal(FAILS_TO_LOCK, 3);
  assert.equal(s.gate.failures, 0, 'reset after the lock');
  assert.deepEqual(s.stored(), { failures: 0, lastFailureAt: 0 });
});

test('a success after failures resets the counter', async () => {
  const s = setup({ results: [FAIL, OK] });
  await s.gate.require();
  s.advance(5);
  assert.equal((await s.gate.require()).ok, true);
  assert.equal(s.gate.failures, 0);
  assert.deepEqual(s.stored(), { failures: 0, lastFailureAt: 0 });
});

test('failures survive a restart (delay still applies)', async () => {
  const s = setup({ results: [FAIL, FAIL] });
  await s.gate.require();
  s.advance(5);
  await s.gate.require();
  const stored = s.stored();
  assert.equal(stored.failures, 2);
  const again = setup({ stored, results: [FAIL] });
  again.advance(0);
  // same clock base: the restart happened right after the 2nd failure
  assert.equal(again.gate.failures, 2);
  assert.equal((await again.gate.require()).reason, 'delay');
});

test('corrupt or invalid stored state: 0 failures plus a warning', () => {
  const bad = setup({ loadThrows: new SyntaxError('Unexpected token') });
  assert.equal(bad.gate.failures, 0);
  assert.match(bad.gate.warning, /unreadable/);
  for (const stored of [{ failures: -1, lastFailureAt: 0 }, { failures: 'x' }, { failures: 1.5, lastFailureAt: 0 }, []]) {
    const s = setup({ stored });
    assert.equal(s.gate.failures, 0);
    assert.match(s.gate.warning, /invalid/);
  }
});

test('unavailable: access allowed (never lock the owner out) with a visible reason', async () => {
  const s = setup({ results: [{ result: Result.UNAVAILABLE, detail: 'no password set' }] });
  assert.deepEqual(await s.gate.require(), { ok: true, unprotected: 'no password set' });
  assert.equal(s.gate.view().unprotected, 'no password set');
  assert.equal(s.gate.unlocked, true);
});

test('a helper error or unexpected result denies (never fails open)', async () => {
  const throwing = new AuthGate({
    authenticate: async () => { throw new Error('spawn EACCES'); },
    store: { load: () => null, save: async () => {} }, log: quiet,
  });
  assert.deepEqual(await throwing.require(), { ok: false, reason: 'cancelled' });
  assert.equal(throwing.unprotected, null);
  const odd = setup({ results: [{ result: 'banana' }] });
  assert.deepEqual(await odd.gate.require(), { ok: false, reason: 'cancelled' });
  assert.equal(odd.gate.unlocked, false);
});

test('concurrent requests share one prompt', async () => {
  let release;
  let prompts = 0;
  const gate = new AuthGate({
    authenticate: () => { prompts += 1; return new Promise((r) => { release = r; }); },
    store: { load: () => null, save: async () => {} }, log: quiet,
  });
  const a = gate.require();
  const b = gate.require();
  release(OK);
  assert.deepEqual(await a, { ok: true });
  assert.deepEqual(await b, { ok: true });
  assert.equal(prompts, 1);
});

test('a failing state save does not break authentication', async () => {
  const gate = new AuthGate({
    authenticate: async () => OK,
    store: { load: () => null, save: async () => { throw new Error('disk full'); } }, log: quiet,
  });
  assert.equal((await gate.require()).ok, true);
});
