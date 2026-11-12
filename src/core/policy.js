/**
 * Pure decision logic: no camera, no OS calls, no clock of its own.
 * A 1:1 port of paseboon/policy.py (Python reference implementation).
 *
 * Every input arrives as an argument (`now`, input idle seconds, session lock
 * state, camera check result), so the whole behaviour is unit-testable and the
 * agent loop only executes what this module returns.
 *
 * Two kinds of camera check:
 *
 *   IDLE check   (no keyboard/mouse for `idleThreshold`): is the user still here?
 *       presence mode: any face            -> still here
 *       owner mode:    only YOUR face      -> still here
 *       otherwise `absentChecksToLock` misses in a row -> LOCK
 *       camera broken -> plain idle lock once idle >= cameraFailIdle
 *
 *   ACTIVE check (someone is typing; every `activeCheckEvery`): is it you?
 *       a face that is not yours `strangerChecksToLock` times in a row -> LOCK
 *       (both modes). No face or a broken camera never locks an active session.
 *
 * After any LOCK attempt the policy waits until the user is back, then stays
 * quiet for `unlockGrace` seconds.
 */

export const Action = Object.freeze({ NONE: 'none', CHECK: 'check', LOCK: 'lock' });

export const Result = Object.freeze({
  OWNER: 'owner', // an enrolled face matched
  STRANGER: 'stranger', // face(s) seen, none matched
  ABSENT: 'absent', // no face
  CAMERA_ERROR: 'camera_error',
});

export const CheckKind = Object.freeze({ IDLE: 'idle', ACTIVE: 'active' });

export const MODES = Object.freeze(['presence', 'owner']);
/** Input within this many seconds after a lock attempt means "the user is back". */
export const RETURN_IDLE_SECONDS = 5.0;
/** With neither idle time nor lock state available, stop waiting after this long. */
export const BLIND_RETURN_SECONDS = 60.0;

export const DEFAULT_SETTINGS = Object.freeze({
  mode: 'presence',
  idleThreshold: 10.0, // no keyboard/mouse for this long -> look (user's choice: 10 s)
  recheckEvery: 30.0, // while idle and present, look again this often
  absentChecksToLock: 2, // consecutive misses before locking
  absentRecheckEvery: 5.0, // gap between those checks
  cameraFailIdle: 300.0, // camera unusable -> plain idle lock after this
  unlockGrace: 15.0, // quiet period after you come back
  activeCheckEvery: 120.0, // while typing, verify it is you (0 = off)
  strangerChecksToLock: 2, // consecutive "not you" checks before locking
  strangerRecheckEvery: 5.0,
});

/** Returns a frozen settings object; throws Error on invalid values. */
export function makeSettings(overrides = {}) {
  const s = Object.freeze({ ...DEFAULT_SETTINGS, ...overrides });
  validateSettings(s);
  return s;
}

export function validateSettings(s) {
  const num = (k) => {
    if (typeof s[k] !== 'number' || !Number.isFinite(s[k])) throw new Error(`${k} must be a finite number`);
    return s[k];
  };
  if (!MODES.includes(s.mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
  if (num('idleThreshold') <= 0 || num('recheckEvery') <= 0) {
    throw new Error('idleThreshold and recheckEvery must be > 0');
  }
  for (const k of ['absentChecksToLock', 'strangerChecksToLock']) {
    if (!Number.isInteger(s[k]) || s[k] < 1) throw new Error(`${k} must be an integer >= 1`);
  }
  if (num('absentRecheckEvery') <= 0 || num('strangerRecheckEvery') <= 0) {
    throw new Error('*RecheckEvery must be > 0');
  }
  if (num('unlockGrace') < 0 || num('activeCheckEvery') < 0) {
    throw new Error('unlockGrace and activeCheckEvery must be >= 0');
  }
  if (num('cameraFailIdle') < s.idleThreshold) {
    throw new Error('cameraFailIdle must be >= idleThreshold');
  }
}

export class Policy {
  constructor(settings = makeSettings()) {
    validateSettings(settings);
    this.s = settings;
    this._pending = null;
    // idle checks
    this._lastCheck = null;
    this._absentStreak = 0;
    this._cameraBroken = false;
    // active checks
    this._lastActiveCheck = null;
    this._strangerStreak = 0;
    // after a lock attempt
    this._awaitingReturn = false;
    this._lockAttemptAt = 0.0;
    this._graceUntil = -Infinity;
  }

  // ── read-only views, for logging and tests ──────────────────────────────
  get absentStreak() { return this._absentStreak; }
  get strangerStreak() { return this._strangerStreak; }
  get awaitingReturn() { return this._awaitingReturn; }
  get pending() { return this._pending; }

  // ── inputs ──────────────────────────────────────────────────────────────
  /**
   * @param {number} now
   * @param {number|null} idle  seconds since the last keyboard/mouse input, null if unknown
   * @param {boolean|null} locked  true/false if the OS reports it, null if it cannot tell
   */
  nextAction(now, idle, locked) {
    if (locked === true) {
      // Locked by us, by the user, or by the OS: nothing to watch.
      this._enterAwaiting(now);
      return Action.NONE;
    }

    if (this._awaitingReturn) {
      if (!this._userIsBack(now, idle, locked)) return Action.NONE;
      this._awaitingReturn = false;
      this._graceUntil = now + this.s.unlockGrace;
      this._lastActiveCheck = now; // you just authenticated
    }

    if (now < this._graceUntil) return Action.NONE;

    // Unknown idle time (some Linux desktops): rely on the camera alone.
    const effectiveIdle = idle == null ? Infinity : idle;
    if (effectiveIdle < this.s.idleThreshold) {
      this._resetIdle();
      return this._activeAction(now);
    }
    return this._idleAction(now, idle);
  }

  /** Feed the result of the CHECK just requested; returns LOCK or NONE. */
  record(now, result) {
    const kind = this._pending ?? CheckKind.IDLE;
    this._pending = null;
    if (result === Result.OWNER) this._strangerStreak = 0;
    if (kind === CheckKind.ACTIVE) return this._recordActive(now, result);
    return this._recordIdle(now, result);
  }

  /** Call after every lock attempt, verified or not, so we never loop. */
  lockAttempted(now) {
    this._enterAwaiting(now);
  }

  // ── idle checks ─────────────────────────────────────────────────────────
  _idleAction(now, idle) {
    if (this._cameraBroken && idle != null && idle >= this.s.cameraFailIdle) return Action.LOCK;
    if (this._lastCheck !== null) {
      const wait = this._absentStreak ? this.s.absentRecheckEvery : this.s.recheckEvery;
      if (now - this._lastCheck < wait) return Action.NONE;
    }
    this._pending = CheckKind.IDLE;
    return Action.CHECK;
  }

  _recordIdle(now, result) {
    this._lastCheck = now;
    if (result === Result.CAMERA_ERROR) {
      this._cameraBroken = true;
      return Action.NONE;
    }
    this._cameraBroken = false;
    const present = result === Result.OWNER
      || (result === Result.STRANGER && this.s.mode === 'presence');
    if (present) {
      this._absentStreak = 0;
      return Action.NONE;
    }
    this._absentStreak += 1;
    return this._absentStreak >= this.s.absentChecksToLock ? Action.LOCK : Action.NONE;
  }

  // ── active checks ───────────────────────────────────────────────────────
  _activeAction(now) {
    if (this.s.activeCheckEvery <= 0) return Action.NONE;
    if (this._lastActiveCheck === null) {
      this._lastActiveCheck = now; // first sight of activity: start the clock
      return Action.NONE;
    }
    const wait = this._strangerStreak ? this.s.strangerRecheckEvery : this.s.activeCheckEvery;
    if (now - this._lastActiveCheck < wait) return Action.NONE;
    this._pending = CheckKind.ACTIVE;
    return Action.CHECK;
  }

  _recordActive(now, result) {
    this._lastActiveCheck = now;
    if (result !== Result.STRANGER) return Action.NONE; // you, nobody visible, or camera trouble
    this._strangerStreak += 1;
    return this._strangerStreak >= this.s.strangerChecksToLock ? Action.LOCK : Action.NONE;
  }

  // ── internals ───────────────────────────────────────────────────────────
  _enterAwaiting(now) {
    if (!this._awaitingReturn) this._lockAttemptAt = now;
    this._awaitingReturn = true;
    this._pending = null;
    this._resetIdle();
    this._lastActiveCheck = null;
    this._strangerStreak = 0;
  }

  _userIsBack(now, idle, locked) {
    if (idle != null) return idle < RETURN_IDLE_SECONDS;
    if (locked === false) return true;
    return now - this._lockAttemptAt >= BLIND_RETURN_SECONDS;
  }

  _resetIdle() {
    this._lastCheck = null;
    this._absentStreak = 0;
    this._cameraBroken = false;
  }
}
