// USB guard: diff logic, trusted list, events, response ordering, monitor,
// parsers. Port of the Python tests/test_usb.py. Fake enumerator / lock / camera.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  deviceFromJson, deviceKey, linuxDevices, makeDevice, parseWindowsInstanceId,
} from '../src/usb/devices.js';
import { IntruderResponse, UsbGuard, UsbMonitor } from '../src/usb/guard.js';
import { PHOTO_TIMING } from '../src/usb/photos.js';
import {
  MAX_EVENTS, TrustedCache, TrustedList, loadEvents, loadTrusted, recordEvent, saveTrusted, trust, untrust,
} from '../src/usb/trusted.js';
import { tmpDir } from './support/tmp.mjs';

const POSIX = process.platform !== 'win32';
const MOUSE = makeDevice(0x046d, 0xc52b, null, 'Receiver');
const KEYB = makeDevice(0x05ac, 0x024f, 'KB123', 'Keyboard');
const STICK = makeDevice(0x0781, 0x5581, '4C530001', 'Ultra');
const STICK2 = makeDevice(0x0781, 0x5581, '4C530002', 'Ultra');
const quiet = { info() {}, warn() {}, error() {} };
const listOf = (...ds) => new TrustedList(new Map(ds.map((d) => [deviceKey(d), d])));

class Bus {
  constructor(...devices) { this.devices = [...devices]; this.error = null; }
  enumerate = async () => {
    if (this.error) throw this.error;
    return [...this.devices];
  };
  remove(d) { this.devices.splice(this.devices.indexOf(d), 1); }
}

function harness(connected = [], { trusted = [], trustedList = null } = {}) {
  const h = { bus: new Bus(...connected), trusted: trustedList ?? listOf(...trusted), events: [], notes: [] };
  h.guard = new UsbGuard(h.bus.enumerate, () => h.trusted, (ds) => { h.events.push(ds); }, (n) => h.notes.push(n), quiet);
  return h;
}

// ── identity ──────────────────────────────────────────────────────────────
test('key uses the serial when present', () => {
  assert.equal(deviceKey(KEYB), '05ac:024f:KB123');
  assert.equal(deviceKey(MOUSE), '046d:c52b');
  assert.notEqual(deviceKey(STICK), deviceKey(STICK2));
});

test('fromJson validates and cleans device strings', () => {
  const d = deviceFromJson({ vendor_id: 1, product_id: 2, serial: 'a\u0000b\n', name: 'x'.repeat(500) });
  assert.equal(d.serial, 'ab');
  assert.equal(d.name.length, 128);
  for (const bad of [{ vendor_id: -1, product_id: 1 }, { vendor_id: 1, product_id: true },
    { vendor_id: 1, product_id: 70000 }, { vendor_id: 1, product_id: 1, serial: 5 }, 'x', null]) {
    assert.throws(() => deviceFromJson(bad));
  }
});

// ── guard ─────────────────────────────────────────────────────────────────
test('a new untrusted device triggers exactly once', async () => {
  const h = harness([MOUSE], { trusted: [MOUSE] });
  await h.guard.poll(); // baseline
  h.bus.devices.push(STICK);
  assert.deepEqual(await h.guard.poll(), [STICK]);
  for (let i = 0; i < 5; i += 1) await h.guard.poll(); // still plugged in: no repeat
  assert.deepEqual(h.events, [[STICK]]);
});

test('a trusted device never triggers', async () => {
  const h = harness([], { trusted: [KEYB] });
  await h.guard.poll();
  h.bus.devices.push(KEYB);
  await h.guard.poll();
  assert.deepEqual(h.events, []);
});

test('devices present at start never trigger but are reported once', async () => {
  const h = harness([STICK, MOUSE], { trusted: [MOUSE] });
  await h.guard.poll();
  await h.guard.poll();
  assert.deepEqual(h.events, []);
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0], /already connected/);
});

test('unplugging never triggers', async () => {
  const h = harness([MOUSE, STICK]);
  await h.guard.poll();
  h.bus.remove(STICK);
  await h.guard.poll();
  assert.deepEqual(h.events, []);
});

test('removed from the trusted list, then replugged -> triggers', async () => {
  const h = harness([KEYB], { trusted: [KEYB] });
  await h.guard.poll();
  h.bus.remove(KEYB);
  await h.guard.poll();
  h.trusted = new TrustedList(); // user pressed Remove
  h.bus.devices.push(KEYB);
  assert.deepEqual(await h.guard.poll(), [KEYB]);
});

test('a second identical device without a serial counts as new', async () => {
  const h = harness([MOUSE]);
  await h.guard.poll();
  h.bus.devices.push(MOUSE);
  assert.deepEqual(await h.guard.poll(), [MOUSE]);
});

test('two devices at once are one event', async () => {
  const h = harness();
  await h.guard.poll();
  h.bus.devices.push(STICK, STICK2);
  await h.guard.poll();
  assert.equal(h.events.length, 1);
  assert.deepEqual(new Set(h.events[0]), new Set([STICK, STICK2]));
});

test('enumeration errors notify once and never throw', async () => {
  const h = harness([MOUSE], { trusted: [MOUSE] });
  await h.guard.poll();
  h.bus.error = new Error('IOKit busy');
  for (let i = 0; i < 5; i += 1) assert.deepEqual(await h.guard.poll(), []);
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0], /cannot read USB/);
});

test('a device plugged in during an outage still triggers', async () => {
  const h = harness([MOUSE]);
  await h.guard.poll();
  h.bus.error = new Error('busy');
  await h.guard.poll();
  h.bus.devices.push(STICK);
  h.bus.error = null;
  assert.deepEqual(await h.guard.poll(), [STICK]);
});

test('an error before the baseline, then the baseline later', async () => {
  const h = harness([STICK]);
  h.bus.error = new Error('busy');
  await h.guard.poll();
  assert.equal(h.guard.baselineTaken, false);
  h.bus.error = null;
  await h.guard.poll();
  assert.equal(h.guard.baselineTaken, true);
  assert.deepEqual(h.events, []);
});

test('a corrupt trusted list fails closed and warns once', async () => {
  const h = harness([], { trustedList: new TrustedList(new Map(), 'Trusted USB list is invalid') });
  await h.guard.poll();
  h.bus.devices.push(KEYB);
  assert.deepEqual(await h.guard.poll(), [KEYB]); // nothing is trusted -> locks
  h.bus.devices.push(STICK);
  await h.guard.poll();
  assert.equal(h.notes.filter((n) => n.includes('invalid')).length, 1);
});

// ── trusted file + events ─────────────────────────────────────────────────
test('trust / untrust roundtrip', async () => {
  const f = path.join(tmpDir('usb-'), 'trusted_usb.json');
  await trust(f, [KEYB, MOUSE]);
  assert.deepEqual([...loadTrusted(f).devices.keys()].sort(), [deviceKey(MOUSE), deviceKey(KEYB)].sort());
  assert.equal(await untrust(f, deviceKey(KEYB)), true);
  assert.equal(await untrust(f, 'nope'), false);
  assert.deepEqual([...loadTrusted(f).devices.keys()], [deviceKey(MOUSE)]);
});

test('trusted file is owner-only JSON in a 0700 dir', { skip: !POSIX }, async () => {
  const dir = path.join(tmpDir('usb-'), 'data');
  const f = path.join(dir, 'trusted_usb.json');
  await saveTrusted(f, [KEYB]);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).devices[0].vendor_id, 0x05ac);
});

for (const content of ['{not json', '[]', '{"devices": "x"}', '{"devices": [{"vendor_id": -1, "product_id": 1}]}']) {
  test(`corrupt trusted file -> empty list + warning: ${content}`, () => {
    const f = path.join(tmpDir('usb-'), 'trusted_usb.json');
    writeFileSync(f, content);
    const t = loadTrusted(f);
    assert.equal(t.devices.size, 0);
    assert.match(t.warning, /invalid/);
    assert.equal(t.isTrusted(KEYB), false);
  });
}

test('missing trusted file -> empty list, no warning', () => {
  const t = loadTrusted(path.join(tmpDir('usb-'), 'none.json'));
  assert.equal(t.devices.size, 0);
  assert.equal(t.warning, null);
});

test('trusted cache picks up edits', async () => {
  const f = path.join(tmpDir('usb-'), 'trusted_usb.json');
  const cache = new TrustedCache(f);
  assert.equal(cache.get().isTrusted(KEYB), false);
  await trust(f, [KEYB]);
  assert.equal(cache.get().isTrusted(KEYB), true);
  await untrust(f, deviceKey(KEYB));
  assert.equal(cache.get().isTrusted(KEYB), false);
});

test(`events keep the last ${MAX_EVENTS}, owner-only`, async () => {
  const f = path.join(tmpDir('usb-'), 'usb_events.json');
  for (let i = 0; i < MAX_EVENTS + 5; i += 1) {
    await recordEvent(f, { devices: [makeDevice(1, i, null, `d${i}`)], lock: 'verified', photo: null });
  }
  const events = loadEvents(f);
  assert.equal(events.length, MAX_EVENTS);
  assert.equal(events.at(-1).devices[0].productId, MAX_EVENTS + 4);
  if (POSIX) assert.equal(statSync(f).mode & 0o777, 0o600);
});

// ── response: lock, then photo ────────────────────────────────────────────
function response({ photo = async () => 'p.jpg', locked = false, lockResult = true, timing } = {}) {
  const calls = [];
  const notes = [];
  const recorded = [];
  const r = new IntruderResponse({
    isLocked: async () => locked,
    lock: async () => { calls.push('lock'); return lockResult; },
    photo: photo && (async (ds) => { calls.push('photo'); return photo(ds); }),
    notify: (n) => notes.push(n),
    record: async (e) => recorded.push(e),
    timing,
    log: quiet,
  });
  return { r, calls, notes, recorded };
}

test('default timing is lock first, then photo', async () => {
  assert.equal(PHOTO_TIMING, 'after_lock');
  const { r, calls } = response();
  const event = await r.handle([STICK]);
  assert.deepEqual(calls, ['lock', 'photo']);
  assert.equal(event.lock, 'verified');
  assert.equal(event.photo, 'p.jpg');
});

test('"before_lock" timing is the one switch that reverses the order', async () => {
  const { r, calls } = response({ timing: 'before_lock' });
  await r.handle([STICK]);
  assert.deepEqual(calls, ['photo', 'lock']);
});

test('a failed photo does not affect the lock', async () => {
  const { r, calls, recorded } = response({ photo: async () => { throw new Error('camera busy'); } });
  const event = await r.handle([STICK]);
  assert.deepEqual(calls, ['lock', 'photo']);
  assert.equal(event.lock, 'verified');
  assert.equal(event.photo, null);
  assert.equal(recorded.length, 1);
});

test('no photo when the toggle is off', async () => {
  const { r, calls } = response({ photo: null });
  const event = await r.handle([STICK]);
  assert.deepEqual(calls, ['lock']);
  assert.equal(event.photo, null);
});

test('already locked: no second lock, photo still taken', async () => {
  const { r, calls } = response({ locked: true });
  const event = await r.handle([STICK]);
  assert.deepEqual(calls, ['photo']);
  assert.equal(event.lock, 'already_locked');
});

test('lock result states and notification', async () => {
  for (const [result, word] of [[true, 'verified'], [null, 'unknown'], [false, 'failed']]) {
    const { r, notes } = response({ lockResult: result, photo: null });
    assert.equal((await r.handle([STICK])).lock, word);
    assert.match(notes[0], new RegExp(`Ultra \\(0781:5581\\)\\. Screen lock: ${word}`));
  }
});

test('a recording failure does not stop the response', async () => {
  const r = new IntruderResponse({
    isLocked: async () => false, lock: async () => true, notify() {},
    record: async () => { throw new Error('disk full'); }, log: quiet,
  });
  assert.equal((await r.handle([STICK])).lock, 'verified');
});

test('end to end: guard -> response locks exactly once for an untrusted device, never for a trusted one', async () => {
  const bus = new Bus(MOUSE);
  let trusted = listOf(MOUSE, KEYB);
  const { r, calls } = response({ photo: null });
  const guard = new UsbGuard(bus.enumerate, () => trusted, (ds) => r.handle(ds), () => {}, quiet);
  await guard.poll();
  bus.devices.push(KEYB);
  await guard.poll();
  assert.deepEqual(calls, []);
  bus.devices.push(STICK);
  await guard.poll();
  await guard.poll();
  assert.deepEqual(calls, ['lock']);
  trusted = listOf(MOUSE); // KEYB removed from the list, replugged
  bus.remove(KEYB);
  await guard.poll();
  bus.devices.push(KEYB);
  await guard.poll();
  assert.deepEqual(calls, ['lock', 'lock']);
});

// ── monitor ───────────────────────────────────────────────────────────────
test('monitor polls repeatedly, survives a crashing poll, and stops', async () => {
  let polls = 0;
  const guard = { poll: async () => { polls += 1; if (polls === 2) throw new Error('boom'); } };
  const m = new UsbMonitor(guard, { sleep: () => new Promise((r) => setImmediate(r)), log: quiet });
  m.start();
  while (polls < 5) await new Promise((r) => setImmediate(r));
  await m.stop();
  const after = polls;
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(polls, after);
  assert.equal(m.running, false);
});

// ── parsers ───────────────────────────────────────────────────────────────
test('linux sysfs parsing skips root hubs and interfaces', () => {
  const root = tmpDir('sysfs-');
  const dev = (name, files) => {
    mkdirSync(path.join(root, name));
    for (const [k, v] of Object.entries(files)) writeFileSync(path.join(root, name, k), `${v}\n`);
  };
  dev('usb1', { idVendor: '1d6b', idProduct: '0002', product: 'Root hub' });
  dev('1-1', { idVendor: '0781', idProduct: '5581', serial: '4C530001', product: 'Ultra' });
  dev('1-1.2', { idVendor: '046d', idProduct: 'c52b', manufacturer: 'Logitech' });
  dev('1-1:1.0', { idVendor: 'ffff', idProduct: 'ffff' });
  dev('1-3', { idVendor: 'zz', idProduct: '1' });
  const got = linuxDevices(root);
  assert.deepEqual(got.map(deviceKey), ['0781:5581:4C530001', '046d:c52b']);
  assert.equal(got[1].name, 'Logitech');
  assert.throws(() => linuxDevices(path.join(root, 'missing')));
});

for (const [id, expected] of [
  ['USB\\VID_046D&PID_C52B\\5&2A3B&0&2', { vendorId: 0x046d, productId: 0xc52b, serial: null }],
  ['USB\\VID_0781&PID_5581\\4C530001', { vendorId: 0x0781, productId: 0x5581, serial: '4C530001' }],
  ['USB\\VID_0781&PID_5581&MI_00\\6&1&0', { vendorId: 0x0781, productId: 0x5581, serial: null }],
  ['HID\\VID_046D&PID_C52B\\x', null],
  ['garbage', null],
]) {
  test(`windows instance id: ${id}`, () => assert.deepEqual(parseWindowsInstanceId(id), expected));
}

test('macOS IOKit enumeration runs read-only', { skip: process.platform !== 'darwin' }, async () => {
  const { macDevices } = await import('../src/usb/macos.js');
  const devices = macDevices();
  assert.ok(Array.isArray(devices));
  for (const d of devices) assert.match(deviceKey(d), /^[0-9a-f]{4}:[0-9a-f]{4}/);
});
