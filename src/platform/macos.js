/**
 * macOS adapter (koffi FFI; same mechanisms as the Python app, which were
 * verified there: lock + CGSSessionScreenIsLocked 4/4 on macOS 27.2.1).
 *
 * lock():         SACLockScreenImmediate from the private login.framework. A real
 *                 session lock that needs no permission, but undocumented: every lock
 *                 is verified with isLocked() and falls back to display sleep.
 * isLocked():     CGSSessionScreenIsLocked in CGSessionCopyCurrentDictionary
 *                 (absent while unlocked).
 * fallbackLock(): pmset displaysleepnow (locks only if "require password
 *                 immediately" is set).
 */

import { execFile } from 'node:child_process';
import koffi from 'koffi';

const CG_PATH = '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics';
const CF_PATH = '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation';
export const LOGIN_PATH = '/System/Library/PrivateFrameworks/login.framework/login';
const kCFStringEncodingUTF8 = 0x08000100;
const kCFNumberSInt64Type = 4;

/** Resolve (never call) the private lock symbol. Exported for the resolve-only test. */
export function resolveLockSymbol() {
  return koffi.load(LOGIN_PATH).func('int SACLockScreenImmediate()');
}

let cfTypeRef = null; // koffi named types must be registered once per process

export function createMacOS({ idleSeconds, notify, log = console }) {
  cfTypeRef ??= koffi.pointer('CFTypeRef', koffi.opaque());
  const cg = koffi.load(CG_PATH);
  const cf = koffi.load(CF_PATH);
  const CGSessionCopyCurrentDictionary = cg.func('CFTypeRef CGSessionCopyCurrentDictionary()');
  const CFStringCreateWithCString = cf.func('CFTypeRef CFStringCreateWithCString(void *alloc, const char *s, uint32_t enc)');
  const CFDictionaryGetValue = cf.func('CFTypeRef CFDictionaryGetValue(CFTypeRef dict, CFTypeRef key)');
  const CFGetTypeID = cf.func('uint64_t CFGetTypeID(CFTypeRef cf)');
  const CFBooleanGetTypeID = cf.func('uint64_t CFBooleanGetTypeID()');
  const CFBooleanGetValue = cf.func('bool CFBooleanGetValue(CFTypeRef b)');
  const CFNumberGetTypeID = cf.func('uint64_t CFNumberGetTypeID()');
  const CFNumberGetValue = cf.func('bool CFNumberGetValue(CFTypeRef n, int type, _Out_ int64_t *out)');
  const CFRelease = cf.func('void CFRelease(CFTypeRef cf)');

  const lockedKey = CFStringCreateWithCString(null, 'CGSSessionScreenIsLocked', kCFStringEncodingUTF8);
  const boolType = CFBooleanGetTypeID();
  const numType = CFNumberGetTypeID();

  let sac = null;
  try {
    sac = resolveLockSymbol();
  } catch (err) {
    log.warn(`SACLockScreenImmediate unavailable (${err.message}); will use display sleep`);
  }

  return {
    name: 'macos',
    idleSeconds,
    notify,

    isLocked() {
      const session = CGSessionCopyCurrentDictionary();
      if (!session) return null; // not inside a GUI login session
      try {
        const value = CFDictionaryGetValue(session, lockedKey);
        if (!value) return false;
        const type = CFGetTypeID(value);
        if (type === boolType) return CFBooleanGetValue(value);
        if (type === numType) {
          const out = [0n];
          if (CFNumberGetValue(value, kCFNumberSInt64Type, out)) return Number(out[0]) !== 0;
        }
        return true; // key present with an unexpected type: assume locked
      } finally {
        CFRelease(session);
      }
    },

    lock() {
      if (!sac) return false;
      try {
        const rc = sac();
        if (rc !== 0) log.warn(`SACLockScreenImmediate returned ${rc}`);
        return true;
      } catch (err) {
        log.error(`SACLockScreenImmediate failed: ${err.message}`);
        return false;
      }
    },

    fallbackLock() {
      return new Promise((resolve) => {
        execFile('/usr/bin/pmset', ['displaysleepnow'], { timeout: 5000 }, (err) => resolve(!err));
      });
    },
  };
}
