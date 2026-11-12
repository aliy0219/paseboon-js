// Port of the Python reference tests/test_policy.py — the spec for policy.js.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  Action, BLIND_RETURN_SECONDS, CheckKind, DEFAULT_SETTINGS as S, Policy, Result, makeSettings,
  validateSettings,
} from '../src/core/policy.js';

const policy = (kw = {}) => new Policy(makeSettings(kw));

function idleUntilCheck(p, t = 100.0) {
  assert.equal(p.nextAction(t, S.idleThreshold, false), Action.CHECK);
  assert.equal(p.pending, CheckKind.IDLE);
  return t;
}

describe('idle path', () => {
  test('active user never triggers idle check', () => {
    const p = policy({ activeCheckEvery: 0 });
    for (let t = 0; t < 600; t += 1) assert.equal(p.nextAction(t, 1.0, false), Action.NONE);
  });

  test('idle triggers check then owner rechecks after interval', () => {
    const p = policy();
    const t = idleUntilCheck(p);
    assert.equal(p.record(t, Result.OWNER), Action.NONE);
    assert.equal(p.nextAction(t + S.recheckEvery - 1, 90, false), Action.NONE);
    assert.equal(p.nextAction(t + S.recheckEvery, 90, false), Action.CHECK);
  });

  test('absent must be confirmed before lock', () => {
    const p = policy();
    const t = idleUntilCheck(p);
    assert.equal(p.record(t, Result.ABSENT), Action.NONE); // one miss: no lock
    assert.equal(p.nextAction(t + 1, 70, false), Action.NONE);
    assert.equal(p.nextAction(t + S.absentRecheckEvery, 70, false), Action.CHECK);
    assert.equal(p.record(t + 5, Result.ABSENT), Action.LOCK);
  });

  test('absence streak broken by owner', () => {
    const p = policy();
    const t = idleUntilCheck(p);
    p.record(t, Result.ABSENT);
    p.nextAction(t + 5, 70, false);
    assert.equal(p.record(t + 5, Result.OWNER), Action.NONE);
    assert.equal(p.absentStreak, 0);
  });

  for (const [mode, locks] of [['presence', false], ['owner', true]]) {
    test(`idle stranger counts as present only in presence mode (${mode})`, () => {
      const p = policy({ mode, absentChecksToLock: 1 });
      const t = idleUntilCheck(p);
      assert.equal(p.record(t, Result.STRANGER) === Action.LOCK, locks);
    });
  }

  test('activity resets absence streak', () => {
    const p = policy({ activeCheckEvery: 0 });
    const t = idleUntilCheck(p);
    p.record(t, Result.ABSENT);
    p.nextAction(t + 1, 0.5, false); // user touched the mouse
    assert.equal(p.absentStreak, 0);
  });

  test('camera error falls back to idle lock, not to never lock', () => {
    const p = policy({ cameraFailIdle: 300 });
    const t = idleUntilCheck(p);
    assert.equal(p.record(t, Result.CAMERA_ERROR), Action.NONE);
    assert.notEqual(p.nextAction(t + 1, 299, false), Action.LOCK);
    assert.equal(p.nextAction(t + 2, 300, false), Action.LOCK);
  });

  test('camera error retries camera meanwhile', () => {
    const p = policy();
    const t = idleUntilCheck(p);
    p.record(t, Result.CAMERA_ERROR);
    assert.equal(p.nextAction(t + S.recheckEvery, 90, false), Action.CHECK);
  });

  test('unknown idle relies on camera alone', () => {
    assert.equal(policy().nextAction(0, null, false), Action.CHECK);
  });

  test('unknown idle and broken camera cannot lock (documented limitation)', () => {
    const p = policy();
    p.nextAction(0, null, false);
    p.record(0, Result.CAMERA_ERROR);
    for (let t = 1; t < 1000; t += 7) {
      const a = p.nextAction(t, null, false);
      assert.notEqual(a, Action.LOCK);
      if (a === Action.CHECK) p.record(t, Result.CAMERA_ERROR);
    }
  });
});

describe('after a lock', () => {
  test('no lock loop when lock state is unverifiable', () => {
    const p = policy();
    const t = idleUntilCheck(p);
    p.record(t, Result.ABSENT);
    p.nextAction(t + 5, 70, false);
    assert.equal(p.record(t + 5, Result.ABSENT), Action.LOCK);
    p.lockAttempted(t + 5);
    // OS keeps saying "not locked" and the user is still away: stay quiet.
    for (let dt = 6; dt < 3600; dt += 3) assert.equal(p.nextAction(t + dt, 70 + dt, false), Action.NONE);
  });

  test('locked session is never checked', () => {
    const p = policy();
    for (let t = 0; t < 500; t += 5) assert.equal(p.nextAction(t, 999, true), Action.NONE);
  });

  test('grace after return then normal', () => {
    const p = policy({ unlockGrace: 15 });
    p.nextAction(0, 999, true); // locked
    assert.equal(p.nextAction(10, 1, false), Action.NONE); // back: grace starts
    assert.equal(p.nextAction(20, 99, false), Action.NONE);
    assert.equal(p.nextAction(26, 99, false), Action.CHECK);
  });

  test('blind platform waits fixed time after lock', () => {
    const p = policy();
    p.lockAttempted(0);
    assert.equal(p.nextAction(BLIND_RETURN_SECONDS - 1, null, null), Action.NONE);
    p.nextAction(BLIND_RETURN_SECONDS, null, null);
    assert.equal(p.awaitingReturn, false);
  });
});

describe('active path: someone else sits down', () => {
  function startActive(p, t = 0.0) {
    assert.equal(p.nextAction(t, 1, false), Action.NONE); // starts the clock
    return t;
  }

  for (const mode of ['presence', 'owner']) {
    test(`stranger typing is locked after confirmation (${mode})`, () => {
      const p = policy({ mode });
      let t = startActive(p);
      t += S.activeCheckEvery;
      assert.equal(p.nextAction(t, 1, false), Action.CHECK);
      assert.equal(p.pending, CheckKind.ACTIVE);
      assert.equal(p.record(t, Result.STRANGER), Action.NONE);
      assert.equal(p.nextAction(t + S.strangerRecheckEvery - 1, 1, false), Action.NONE);
      t += S.strangerRecheckEvery;
      assert.equal(p.nextAction(t, 1, false), Action.CHECK);
      assert.equal(p.record(t, Result.STRANGER), Action.LOCK);
    });
  }

  for (const result of [Result.OWNER, Result.ABSENT, Result.CAMERA_ERROR]) {
    test(`active check never locks on ${result}`, () => {
      const p = policy({ strangerChecksToLock: 1 });
      const t = startActive(p) + S.activeCheckEvery;
      assert.equal(p.nextAction(t, 1, false), Action.CHECK);
      assert.equal(p.record(t, result), Action.NONE);
    });
  }

  test('owner clears stranger streak', () => {
    const p = policy();
    let t = startActive(p) + S.activeCheckEvery;
    p.nextAction(t, 1, false);
    p.record(t, Result.STRANGER);
    t += 5;
    p.nextAction(t, 1, false);
    p.record(t, Result.OWNER);
    assert.equal(p.strangerStreak, 0);
  });

  test('stranger streak survives a pause in typing', () => {
    const p = policy({ mode: 'presence' });
    let t = startActive(p) + S.activeCheckEvery;
    p.nextAction(t, 1, false);
    p.record(t, Result.STRANGER);
    // stranger stops typing; presence-mode idle check sees "a face" -> present
    t += 60;
    assert.equal(p.nextAction(t, 60, false), Action.CHECK);
    p.record(t, Result.STRANGER);
    // types again: the stranger recheck is already due
    t += 1;
    assert.equal(p.nextAction(t, 1, false), Action.CHECK);
    assert.equal(p.record(t, Result.STRANGER), Action.LOCK);
  });

  test('active checks can be disabled', () => {
    const p = policy({ activeCheckEvery: 0 });
    for (let t = 0; t < 1000; t += 10) assert.equal(p.nextAction(t, 1, false), Action.NONE);
  });

  test('active clock restarts after unlock', () => {
    const p = policy({ unlockGrace: 0 });
    p.nextAction(0, 999, true);
    assert.equal(p.nextAction(1000, 1, false), Action.NONE); // just authenticated
    assert.equal(p.nextAction(1000 + S.activeCheckEvery - 1, 1, false), Action.NONE);
    assert.equal(p.nextAction(1000 + S.activeCheckEvery, 1, false), Action.CHECK);
  });
});

describe('settings', () => {
  test('default idle timer is 10 s (user choice)', () => assert.equal(S.idleThreshold, 10));

  for (const kw of [
    { mode: 'nobody' }, { idleThreshold: 0 }, { absentChecksToLock: 0 },
    { strangerChecksToLock: 0 }, { activeCheckEvery: -1 },
    { cameraFailIdle: 10, idleThreshold: 60 }, { idleThreshold: Number.NaN },
    { absentChecksToLock: 1.5 }, { idleThreshold: '10' },
  ]) {
    test(`invalid settings rejected: ${JSON.stringify(kw)}`, () => {
      assert.throws(() => validateSettings({ ...S, ...kw }));
    });
  }
});
