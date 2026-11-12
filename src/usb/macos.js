/**
 * macOS USB enumeration: IOKit IOUSBHostDevice via koffi. Read-only.
 * Uses anonymous koffi pointer types so it never clashes with the named
 * CFTypeRef registered by platform/macos.js.
 */

import koffi from 'koffi';

import { UsbError, makeDevice } from './devices.js';

const IOKIT = '/System/Library/Frameworks/IOKit.framework/IOKit';
const CF = '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation';
const UTF8 = 0x08000100;
const kCFNumberSInt64Type = 4;
const KEYS = ['idVendor', 'idProduct', 'USB Serial Number', 'kUSBSerialNumberString',
  'USB Product Name', 'kUSBProductString'];

let api = null;

function load() {
  if (api) return api;
  const ref = koffi.pointer(koffi.opaque());
  const io = koffi.load(IOKIT);
  const cf = koffi.load(CF);
  const f = {
    IOServiceMatching: io.func('IOServiceMatching', ref, ['str']),
    IOServiceGetMatchingServices: io.func('IOServiceGetMatchingServices', 'int', ['uint32', ref, koffi.out(koffi.pointer('uint32'))]),
    IOIteratorNext: io.func('IOIteratorNext', 'uint32', ['uint32']),
    IOObjectRelease: io.func('IOObjectRelease', 'int', ['uint32']),
    IORegistryEntryCreateCFProperty: io.func('IORegistryEntryCreateCFProperty', ref, ['uint32', ref, ref, 'uint32']),
    CFStringCreateWithCString: cf.func('CFStringCreateWithCString', ref, [ref, 'str', 'uint32']),
    CFGetTypeID: cf.func('CFGetTypeID', 'uint64', [ref]),
    CFStringGetTypeID: cf.func('CFStringGetTypeID', 'uint64', []),
    CFNumberGetTypeID: cf.func('CFNumberGetTypeID', 'uint64', []),
    CFNumberGetValue: cf.func('CFNumberGetValue', 'bool', [ref, 'int', koffi.out(koffi.pointer('int64'))]),
    CFStringGetCString: cf.func('CFStringGetCString', 'bool', [ref, koffi.out(koffi.pointer('uint8')), 'long', 'uint32']),
    CFRelease: cf.func('CFRelease', 'void', [ref]),
  };
  // Created once, kept for the life of the process.
  const keys = Object.fromEntries(KEYS.map((k) => [k, f.CFStringCreateWithCString(null, k, UTF8)]));
  api = { f, keys, stringType: f.CFStringGetTypeID(), numberType: f.CFNumberGetTypeID() };
  return api;
}

function prop(a, entry, name) {
  const value = a.f.IORegistryEntryCreateCFProperty(entry, a.keys[name], null, 0);
  if (!value) return null;
  try {
    const type = a.f.CFGetTypeID(value);
    if (type === a.numberType) {
      const out = [0n];
      return a.f.CFNumberGetValue(value, kCFNumberSInt64Type, out) ? Number(out[0]) : null;
    }
    if (type === a.stringType) {
      const buf = Buffer.alloc(512);
      if (!a.f.CFStringGetCString(value, buf, buf.length, UTF8)) return null;
      const end = buf.indexOf(0);
      return buf.toString('utf8', 0, end < 0 ? buf.length : end);
    }
    return null;
  } finally {
    a.f.CFRelease(value);
  }
}

export function macDevices() {
  let a;
  try {
    a = load();
  } catch (err) {
    throw new UsbError(`IOKit unavailable: ${err.message}`);
  }
  const matching = a.f.IOServiceMatching('IOUSBHostDevice');
  if (!matching) throw new UsbError('IOServiceMatching failed');
  const iter = [0];
  // kIOMainPortDefault == 0; the matching dictionary is consumed by this call.
  const kr = a.f.IOServiceGetMatchingServices(0, matching, iter);
  if (kr !== 0) throw new UsbError(`IOServiceGetMatchingServices failed (${kr})`);
  const out = [];
  try {
    for (;;) {
      const entry = a.f.IOIteratorNext(iter[0]);
      if (!entry) break;
      try {
        const vid = prop(a, entry, 'idVendor');
        const pid = prop(a, entry, 'idProduct');
        if (!Number.isInteger(vid) || !Number.isInteger(pid)) continue;
        const serial = prop(a, entry, 'USB Serial Number') || prop(a, entry, 'kUSBSerialNumberString');
        const name = prop(a, entry, 'USB Product Name') || prop(a, entry, 'kUSBProductString') || '';
        out.push(makeDevice(vid, pid, serial, name));
      } finally {
        a.f.IOObjectRelease(entry);
      }
    }
  } finally {
    a.f.IOObjectRelease(iter[0]);
  }
  return out;
}
