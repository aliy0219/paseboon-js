/**
 * USB guard: lock the screen when a NEWLY connected USB device is not trusted.
 * A port of the Python paseboon/usb.py (UsbGuard, IntruderResponse, UsbMonitor).
 *
 * Rules:
 *  - Unplugging never locks.
 *  - Devices already connected when the guard starts never lock (logged and
 *    notified once), so a restart with an untrusted device attached cannot loop.
 *  - Successive listings are compared as multisets, so a second identical
 *    device (same vid:pid, no serial) also counts as new.
 *  - A failed listing is notified once and retried; a device plugged in during
 *    the failure is still caught (we diff against the last GOOD listing).
 *  - A corrupt trusted list = nothing trusted (fail closed) + one warning.
 */

import { deviceKey, deviceLabel } from './devices.js';
import { PHOTO_TIMING } from './photos.js';

export const POLL_SECONDS = 0.5;

function counts(devices) {
  const m = new Map();
  for (const d of devices) m.set(deviceKey(d), (m.get(deviceKey(d)) ?? 0) + 1);
  return m;
}

export class UsbGuard {
  /**
   * @param {() => Promise<object[]>|object[]} enumerate
   * @param {() => import('./trusted.js').TrustedList} trusted
   * @param {(devices: object[]) => Promise<unknown>|unknown} onUntrusted
   * @param {(text: string) => void} notify
   */
  constructor(enumerate, trusted, onUntrusted, notify, log = console) {
    Object.assign(this, { enumerate, trusted, onUntrusted, notify, log });
    this.known = null;
    this.failing = false;
    this.trustWarning = null;
  }

  get baselineTaken() { return this.known !== null; }

  /** One poll. Resolves to the untrusted devices that triggered a response. */
  async poll() {
    let devices;
    try {
      devices = await this.enumerate();
    } catch (err) {
      if (!this.failing) {
        this.failing = true;
        this.log.error(`USB guard cannot list USB devices: ${err.message} (retrying)`);
        this.notify('USB guard cannot read USB devices; retrying. See the log.');
      }
      return [];
    }
    if (this.failing) {
      this.failing = false;
      this.log.info('USB guard: device listing works again');
    }
    const current = counts(devices);
    const byKey = new Map(devices.map((d) => [deviceKey(d), d]));
    if (this.known === null) {
      this.known = current;
      this._baseline(devices);
      return [];
    }
    const fresh = [];
    for (const [key, n] of current) {
      const extra = n - (this.known.get(key) ?? 0);
      for (let i = 0; i < extra; i += 1) fresh.push(byKey.get(key));
    }
    this.known = current;
    if (!fresh.length) return [];
    const trusted = this.trusted();
    this._warnTrust(trusted);
    const untrusted = [];
    for (const d of fresh) {
      if (trusted.isTrusted(d)) this.log.info(`trusted USB device connected: ${deviceLabel(d)} [${deviceKey(d)}]`);
      else untrusted.push(d);
    }
    if (untrusted.length) {
      this.log.warn(`UNTRUSTED USB device connected: ${untrusted.map((d) => `${deviceLabel(d)} [${deviceKey(d)}]`).join('; ')}`);
      await this.onUntrusted(untrusted);
    }
    return untrusted;
  }

  _baseline(devices) {
    const trusted = this.trusted();
    this._warnTrust(trusted);
    const untrusted = devices.filter((d) => !trusted.isTrusted(d));
    this.log.info(`USB guard started: ${devices.length} devices connected, ${untrusted.length} untrusted`);
    if (untrusted.length) {
      this.log.warn(`untrusted devices already connected (they will not lock): ${untrusted.map((d) => `${deviceLabel(d)} [${deviceKey(d)}]`).join('; ')}`);
      this.notify(`${untrusted.length} untrusted USB device(s) were already connected when the USB guard started. Trust or unplug them.`);
    }
  }

  _warnTrust(trusted) {
    if (trusted.warning && trusted.warning !== this.trustWarning) {
      this.log.error(trusted.warning);
      this.notify('Trusted USB list is invalid: every device is treated as untrusted.');
    }
    this.trustWarning = trusted.warning;
  }
}

const LOCK_STATES = { true: 'verified', null: 'unknown', false: 'failed' };

/** What happens for an untrusted device: lock (verify + fallback + notify), then an optional photo. */
export class IntruderResponse {
  constructor({ isLocked, lock, photo = null, notify, record = null, onEvent = null, timing = PHOTO_TIMING, log = console }) {
    Object.assign(this, { isLocked, lock, photo, notify, record, onEvent, timing, log });
  }

  async handle(devices) {
    let photo = null;
    if (this.photo && this.timing === 'before_lock') photo = await this._photo(devices);
    let lock;
    if ((await this.isLocked()) === true) {
      lock = 'already_locked';
      this.log.info('screen already locked; not locking again');
    } else {
      lock = LOCK_STATES[String(await this.lock())] ?? 'unknown';
    }
    if (this.photo && this.timing !== 'before_lock') photo = await this._photo(devices);
    const event = { devices, lock, photo };
    if (this.record) {
      try {
        await this.record(event);
      } catch (err) {
        this.log.error(`could not record USB event: ${err.message}`);
      }
    }
    this.notify(`Untrusted USB device connected: ${devices.map(deviceLabel).join(', ')}. Screen lock: ${lock}.`);
    if (this.onEvent) this.onEvent(event);
    return event;
  }

  async _photo(devices) {
    try {
      return await this.photo(devices);
    } catch (err) {
      this.log.error(`intruder photo failed: ${err.message}`); // a photo must never break the guard
      return null;
    }
  }
}

/** Polls every POLL_SECONDS until stop(); never dies on a failing poll. */
export class UsbMonitor {
  constructor(guard, { intervalSeconds = POLL_SECONDS, sleep = (s) => new Promise((r) => setTimeout(r, s * 1000)), log = console } = {}) {
    Object.assign(this, { guard, intervalSeconds, sleep, log });
    this.running = false;
    this.done = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.done = (async () => {
      while (this.running) {
        try {
          await this.guard.poll();
        } catch (err) {
          this.log.error(`USB guard poll failed: ${err?.stack ?? err}`);
        }
        if (!this.running) break;
        await this.sleep(this.intervalSeconds);
      }
    })();
  }

  async stop() {
    this.running = false;
    await this.done;
  }
}
