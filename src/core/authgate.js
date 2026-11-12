/**
 * AuthGate: settings changes need the OS login (Touch ID / account password).
 *
 * Pure logic, no Electron: the OS prompt (`authenticate`), the clock and the
 * state store are injected, so every path is unit-tested.
 *
 *   session     a success unlocks settings until endSession() (window closed)
 *               or SESSION_IDLE_SECONDS without interaction (touch()).
 *   failures    only real authentication failures count (a cancel does not).
 *               Before the next prompt the user waits DELAYS[failures] seconds.
 *               At FAILS_TO_LOCK failures the result says lock: true, and the
 *               count resets (the owner unlocking the screen proves identity).
 *   unavailable no helper, no password set, unsupported OS: access is allowed
 *               (never lock the owner out) and `unprotected` carries the reason
 *               for a visible warning. Errors, crashes and timeouts DENY.
 *   persisted   failures + last failure time survive a restart; a corrupt
 *               state file counts as 0 failures plus a warning.
 */

export const DELAYS = Object.freeze([0, 5, 15, 30, 60]); // seconds, indexed by failure count, capped
export const FAILS_TO_LOCK = 3;
export const SESSION_IDLE_SECONDS = 120;

export const Result = Object.freeze({
  OK: 'ok', FAILED: 'failed', CANCELLED: 'cancelled', UNAVAILABLE: 'unavailable',
});

/**
 * Helper exit codes (macOS helper, Windows script) -> Result.
 * Only an explicit "unavailable" (3) opens access without a password; a crash,
 * timeout, usage error or unknown code DENIES (as a cancel: not counted), so a
 * broken helper can never fail open.
 */
export function mapExitCode(code) {
  switch (code) {
    case 0: return Result.OK;
    case 1: return Result.FAILED;
    case 3: return Result.UNAVAILABLE;
    default: return Result.CANCELLED; // 2 cancelled, 4 usage, signal, timeout, unknown
  }
}

export function delayFor(failures) {
  return DELAYS[Math.min(Math.max(0, failures), DELAYS.length - 1)];
}

export class AuthGate {
  /**
   * @param {object} o
   * @param {() => Promise<{result: string, detail?: string}>} o.authenticate shows the OS prompt
   * @param {{ load: () => object, save: (s: object) => Promise<void> }} o.store
   * @param {() => number} [o.now] milliseconds
   */
  constructor({ authenticate, store, now = () => Date.now(), log = console }) {
    Object.assign(this, { authenticate, store, now, log });
    this.failures = 0;
    this.lastFailureAt = 0;
    this.warning = null; // corrupt state file
    this.unprotected = null; // why authentication is not available
    this.sessionActiveAt = null; // last interaction time while unlocked
    this.inFlight = null;
  }

  load() {
    let s;
    try {
      s = this.store.load();
    } catch (err) {
      this.warning = `Authentication state was unreadable and was reset (${err.message}).`;
      this.log.warn(this.warning);
      return this;
    }
    if (s == null) return this; // first run
    const ok = Number.isInteger(s.failures) && s.failures >= 0 && s.failures < 100
      && Number.isFinite(s.lastFailureAt) && s.lastFailureAt >= 0;
    if (!ok) {
      this.warning = 'Authentication state was invalid and was reset.';
      this.log.warn(this.warning);
      return this;
    }
    this.failures = s.failures;
    this.lastFailureAt = s.lastFailureAt;
    return this;
  }

  get unlocked() {
    if (this.sessionActiveAt === null) return false;
    if (this.now() - this.sessionActiveAt > SESSION_IDLE_SECONDS * 1000) {
      this.sessionActiveAt = null;
      return false;
    }
    return true;
  }

  /** Interaction inside an unlocked session keeps it alive. */
  touch() {
    if (this.unlocked) this.sessionActiveAt = this.now();
  }

  /** The settings window closed: the next protected action prompts again. */
  endSession() {
    this.sessionActiveAt = null;
  }

  retryInSeconds() {
    if (!this.failures) return 0;
    const wait = delayFor(this.failures) * 1000 - (this.now() - this.lastFailureAt);
    return wait > 0 ? Math.ceil(wait / 1000) : 0;
  }

  view() {
    return {
      unlocked: this.unlocked, failures: this.failures, retryIn: this.retryInSeconds(),
      unprotected: this.unprotected, warning: this.warning,
    };
  }

  /**
   * Ensure an unlocked session, prompting if needed. Concurrent callers share
   * one prompt. Resolves to
   *   { ok: true, unprotected? }                          allowed
   *   { ok: false, reason: 'delay', retryIn }             too soon after a failure (no prompt shown)
   *   { ok: false, reason: 'cancelled' }                  the user dismissed the prompt
   *   { ok: false, reason: 'failed', retryIn, lock }      wrong; lock === true at FAILS_TO_LOCK
   */
  async require() {
    if (this.unlocked) {
      this.touch();
      return { ok: true, unprotected: this.unprotected };
    }
    if (this.inFlight) return this.inFlight;
    const retryIn = this.retryInSeconds();
    if (retryIn > 0) return { ok: false, reason: 'delay', retryIn };
    this.inFlight = this._prompt().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async _prompt() {
    let outcome;
    try {
      outcome = await this.authenticate();
    } catch (err) {
      this.log.error(`authentication helper error: ${err.message}`);
      return { ok: false, reason: 'cancelled' }; // never fail open on an error
    }
    const result = outcome?.result;
    if (result === Result.OK) {
      this.unprotected = null;
      await this._setFailures(0);
      this.sessionActiveAt = this.now();
      return { ok: true };
    }
    if (result === Result.CANCELLED) return { ok: false, reason: 'cancelled' };
    if (result === Result.FAILED) {
      const failures = this.failures + 1;
      if (failures >= FAILS_TO_LOCK) {
        this.log.warn(`authentication failed ${failures} times in a row -> lock`);
        await this._setFailures(0);
        return { ok: false, reason: 'failed', retryIn: 0, lock: true };
      }
      await this._setFailures(failures, this.now());
      this.log.warn(`authentication failed (${failures}/${FAILS_TO_LOCK})`);
      return { ok: false, reason: 'failed', retryIn: delayFor(failures), lock: false };
    }
    if (result !== Result.UNAVAILABLE) {
      this.log.error(`unexpected authentication result: ${String(result)}`);
      return { ok: false, reason: 'cancelled' };
    }
    // Explicitly unavailable (no helper, no password, unsupported OS): never lock the owner out.
    this.unprotected = outcome?.detail || 'authentication is not available on this system';
    this.log.warn(`settings are not protected: ${this.unprotected}`);
    this.sessionActiveAt = this.now();
    return { ok: true, unprotected: this.unprotected };
  }

  async _setFailures(failures, at = 0) {
    this.failures = failures;
    this.lastFailureAt = failures ? at : 0;
    try {
      await this.store.save({ failures: this.failures, lastFailureAt: this.lastFailureAt });
    } catch (err) {
      this.log.error(`could not save authentication state: ${err.message}`);
    }
  }
}
