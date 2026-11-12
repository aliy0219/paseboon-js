/**
 * The agent loop: ask the policy what to do, do it, report back. No decisions here.
 * A port of paseboon/agent.py; platform calls and camera checks are async.
 */

import { Action, Result } from './policy.js';

export const TICK_SECONDS = 1.0;
export const VERIFY_SECONDS = 3.0;
export const MAX_CONSECUTIVE_ERRORS = 10; // then throw, so the app can surface it

const realClock = () => performance.now() / 1000;
const realSleep = (s) => new Promise((resolve) => setTimeout(resolve, s * 1000));

/** One-line, numbers-only summary of a camera check (never pixels). */
export function summarize(outcome) {
  const match = outcome.bestMatch == null ? '-' : outcome.bestMatch.toFixed(3);
  return `result=${outcome.result} frames=${outcome.frames ?? 0} faces=${outcome.faces ?? 0} `
    + `best_det=${(outcome.bestDetection ?? 0).toFixed(2)} best_match=${match} `
    + `took=${(outcome.seconds ?? 0).toFixed(1)}s${outcome.note ? ` note=${outcome.note}` : ''}`;
}

export class Agent {
  /**
   * @param {object} platform  { idleSeconds, isLocked, lock, fallbackLock, notify } (sync or async)
   * @param {import('./policy.js').Policy} policy
   * @param {() => Promise<object>} check  resolves to a CheckOutcome-like object
   */
  constructor(platform, policy, check, { clock = realClock, sleep = realSleep, log = console } = {}) {
    this.platform = platform;
    this.policy = policy;
    this.check = check;
    this.clock = clock;
    this.sleep = sleep;
    this.log = log;
    this.paused = false;
    this.lastOutcome = null;
    this._cameraWarned = false;
    this._running = false;
  }

  async tick() {
    if (this.paused) return Action.NONE;
    const now = this.clock();
    const idle = await this.platform.idleSeconds();
    const locked = await this.platform.isLocked();
    let action = this.policy.nextAction(now, idle, locked);

    if (action === Action.CHECK) {
      const outcome = await this.check();
      this.lastOutcome = outcome;
      action = this.policy.record(this.clock(), outcome.result);
      this.log.info(`check ${summarize(outcome)} idle=${fmt(idle)} `
        + `absent_streak=${this.policy.absentStreak} stranger_streak=${this.policy.strangerStreak}`);
      this._warnCamera(outcome);
      if (action === Action.LOCK) this.log.info('absence or stranger confirmed -> locking');
    } else if (action === Action.LOCK) {
      this.log.warn(`camera unavailable and idle ${fmt(idle)} -> idle-only lock`);
    }

    if (action === Action.LOCK) {
      await this.lock();
      this.policy.lockAttempted(this.clock());
    }
    return action;
  }

  /** Lock, verify, fall back. Resolves to the final verified state (true/false/null). */
  async lock() {
    const issued = await this.platform.lock();
    let state = await this._waitForLock();
    if (state === true) {
      this.log.info('locked (verified)');
      return true;
    }
    if (state === null) {
      // Cannot verify on this system: also fire the fallback to be safe.
      this.log.warn(`lock issued=${issued} but lock state is unknown; firing fallback too`);
      await this.platform.fallbackLock();
      return null;
    }
    this.log.error(`lock did not stick (issued=${issued}); trying fallback`);
    await this.platform.fallbackLock();
    state = await this._waitForLock();
    if (state === true) {
      this.log.info('locked by fallback (verified)');
      return true;
    }
    this.log.error(`could NOT lock the screen (state=${state})`);
    await this.platform.notify('Paseboon JS could not lock your screen. Check its log.');
    return state;
  }

  async _waitForLock() {
    const deadline = this.clock() + VERIFY_SECONDS;
    let state = await this.platform.isLocked();
    while (state !== true && this.clock() < deadline) {
      await this.sleep(0.25);
      state = await this.platform.isLocked();
    }
    return state;
  }

  _warnCamera(outcome) {
    if (outcome.result === Result.CAMERA_ERROR && !this._cameraWarned) {
      this._cameraWarned = true;
      const mins = this.policy.s.cameraFailIdle / 60;
      Promise.resolve()
        .then(() => this.platform.notify(`Camera unavailable. Locking after ${mins.toFixed(0)} min idle instead.`))
        .catch(() => {});
    } else if (outcome.result !== Result.CAMERA_ERROR) {
      this._cameraWarned = false;
    }
  }

  /** Runs until stop() is called. Throws after MAX_CONSECUTIVE_ERRORS failing ticks. */
  async run() {
    this._running = true;
    let errors = 0;
    while (this._running) {
      try {
        await this.tick();
        errors = 0;
      } catch (err) {
        errors += 1;
        this.log.error(`tick failed (${errors} in a row): ${err?.stack ?? err}`);
        if (errors >= MAX_CONSECUTIVE_ERRORS) {
          this._running = false;
          throw err;
        }
      }
      await this.sleep(TICK_SECONDS);
    }
  }

  stop() {
    this._running = false;
  }
}

function fmt(idle) {
  return idle == null ? 'unknown' : `${idle.toFixed(0)}s`;
}
