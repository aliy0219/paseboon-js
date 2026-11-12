/**
 * Trusted USB list + recent USB events, owner-only JSON with atomic writes.
 *
 * A corrupt trusted file means an EMPTY list plus a warning: the guard keeps
 * running and fails closed (every device is untrusted until you trust again).
 */

import { readFileSync, statSync } from 'node:fs';

import { writePrivate } from '../core/storage.js';
import { deviceFromJson, deviceKey, deviceToJson } from './devices.js';

export const MAX_EVENTS = 20;

export class TrustedList {
  constructor(devices = new Map(), warning = null) {
    this.devices = devices; // key -> device
    this.warning = warning;
  }

  isTrusted(device) {
    return this.devices.has(deviceKey(device));
  }

  sorted() {
    return [...this.devices.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      || deviceKey(a).localeCompare(deviceKey(b)));
  }
}

/** Never throws for a bad file: empty list (fail closed) + warning. */
export function loadTrusted(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return new TrustedList();
    return new TrustedList(new Map(), `Trusted USB list could not be read (${err.code}). Every device is treated as untrusted.`);
  }
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || !Array.isArray(data.devices)) throw new Error('expected {"devices": [...]}');
    const devices = data.devices.map(deviceFromJson);
    return new TrustedList(new Map(devices.map((d) => [deviceKey(d), d])));
  } catch (err) {
    return new TrustedList(new Map(), `Trusted USB list is invalid (${err.message}). `
      + 'Every device is treated as untrusted until you trust devices again.');
  }
}

export async function saveTrusted(file, devices) {
  const unique = new Map([...devices].map((d) => [deviceKey(d), d]));
  await writePrivate(file, JSON.stringify({ version: 1, devices: [...unique.values()].map(deviceToJson) }, null, 2));
}

export async function trust(file, devices) {
  const merged = new Map(loadTrusted(file).devices);
  for (const d of devices) merged.set(deviceKey(d), d);
  await saveTrusted(file, merged.values());
  return new TrustedList(merged);
}

export async function untrust(file, key) {
  const current = loadTrusted(file);
  if (!current.devices.has(key)) return false;
  await saveTrusted(file, [...current.devices].filter(([k]) => k !== key).map(([, d]) => d));
  return true;
}

/** Re-reads the file only when it changes (the settings window edits it). */
export class TrustedCache {
  constructor(file) {
    this.file = file;
    this.stamp = undefined;
    this.value = new TrustedList();
  }

  get() {
    let stamp = null;
    try {
      const st = statSync(this.file);
      stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch { /* missing */ }
    if (stamp !== this.stamp || stamp === null) {
      this.value = loadTrusted(this.file);
      this.stamp = stamp;
    }
    return this.value;
  }
}

// ── events: so the device that caused a lock can be trusted afterwards ───
export function loadEvents(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const e of data) {
    try {
      out.push({
        time: String(e.time), devices: e.devices.map(deviceFromJson),
        lock: String(e.lock ?? ''), photo: typeof e.photo === 'string' ? e.photo : null,
      });
    } catch { /* skip bad entries */ }
  }
  return out;
}

export async function recordEvent(file, { devices, lock, photo }, now = new Date()) {
  const events = [...loadEvents(file), { time: now.toISOString(), devices, lock, photo: photo ?? null }]
    .slice(-MAX_EVENTS);
  await writePrivate(file, JSON.stringify(events.map((e) => ({ ...e, devices: e.devices.map(deviceToJson) })), null, 2));
}
