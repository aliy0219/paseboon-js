/**
 * USB device identity + per-OS enumeration (no new dependency).
 *
 *   macOS    IOKit IOUSBHostDevice via koffi (usb/macos.js)   -- run read-only on macOS 27
 *   Linux    /sys/bus/usb/devices (here)                      -- UNTESTED on Linux
 *   Windows  SetupAPI via koffi (usb/windows.js)              -- UNTESTED
 *
 * Identity is vendor id + product id + serial (when the device reports one),
 * else vendor + product. These values come FROM the device: a BadUSB device
 * can fake them, so a stick that copies a trusted keyboard's exact IDs is NOT
 * caught.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const MAX_TEXT = 128;

export class UsbError extends Error {}

/** Printable, trimmed, bounded: device strings are attacker-controlled. */
export function clean(text) {
  if (typeof text !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').trim().slice(0, MAX_TEXT);
}

export function makeDevice(vendorId, productId, serial = null, name = '') {
  return Object.freeze({
    vendorId: vendorId & 0xffff,
    productId: productId & 0xffff,
    serial: clean(serial ?? '') || null,
    name: clean(name),
  });
}

const hex4 = (n) => n.toString(16).padStart(4, '0');
export const deviceIds = (d) => `${hex4(d.vendorId)}:${hex4(d.productId)}`;
export const deviceKey = (d) => (d.serial ? `${deviceIds(d)}:${d.serial}` : deviceIds(d));
export const deviceLabel = (d) => `${d.name || 'Unknown USB device'} (${deviceIds(d)})`;

/** On-disk form (same field names as the Python app). */
export const deviceToJson = (d) => ({
  vendor_id: d.vendorId, product_id: d.productId, serial: d.serial, name: d.name,
});

export function deviceFromJson(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('device entry must be an object');
  for (const k of ['vendor_id', 'product_id']) {
    const v = data[k];
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new Error('vendor_id/product_id must be integers 0..65535');
  }
  if (data.serial != null && typeof data.serial !== 'string') throw new Error('serial must be a string or null');
  return makeDevice(data.vendor_id, data.product_id, data.serial, data.name ?? '');
}

// ── Linux: sysfs (UNTESTED on a real Linux machine) ──────────────────────
const LINUX_DEVICE = /^\d+-\d+(\.\d+)*$/; // 1-1, 1-1.2; not usb1 (root hub) or 1-1:1.0

export function linuxDevices(root = '/sys/bus/usb/devices') {
  let names;
  try {
    if (!statSync(root).isDirectory()) throw new Error('not a directory');
    names = readdirSync(root).sort();
  } catch {
    throw new UsbError(`${root} not found`);
  }
  const read = (dir, file) => {
    try {
      return readFileSync(path.join(dir, file), 'utf8').trim();
    } catch {
      return '';
    }
  };
  const out = [];
  for (const n of names) {
    if (!LINUX_DEVICE.test(n)) continue;
    const dir = path.join(root, n);
    const vid = Number.parseInt(read(dir, 'idVendor'), 16);
    const pid = Number.parseInt(read(dir, 'idProduct'), 16);
    if (!Number.isInteger(vid) || !Number.isInteger(pid)) continue;
    out.push(makeDevice(vid, pid, read(dir, 'serial') || null, read(dir, 'product') || read(dir, 'manufacturer')));
  }
  return out;
}

// ── Windows instance ids (parser is pure and tested) ─────────────────────
const WIN_INSTANCE = /^USB\\VID_([0-9A-F]{4})&PID_([0-9A-F]{4})(?:&[^\\]*)?\\(.+)$/i;

/**
 * 'USB\VID_046D&PID_C52B\5&2A3B&0&2' -> { vendorId, productId, serial: null }.
 * The last part is the serial only when it contains no '&' (otherwise Windows
 * generated it from the port).
 */
export function parseWindowsInstanceId(id) {
  const m = WIN_INSTANCE.exec(id);
  if (!m) return null;
  const tail = m[3];
  return {
    vendorId: Number.parseInt(m[1], 16),
    productId: Number.parseInt(m[2], 16),
    serial: tail.includes('&') ? null : (clean(tail) || null),
  };
}

/** Connected USB devices. Throws UsbError when the OS cannot be queried. */
export async function enumerateDevices() {
  if (process.platform === 'darwin') return (await import('./macos.js')).macDevices();
  if (process.platform === 'win32') return (await import('./windows.js')).windowsDevices();
  if (process.platform === 'linux') return linuxDevices();
  throw new UsbError(`USB enumeration not supported on ${process.platform}`);
}
