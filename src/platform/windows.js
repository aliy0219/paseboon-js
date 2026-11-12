/**
 * Windows adapter (UNTESTED: written to the documented Win32 API, never run).
 *
 * lock():      user32 LockWorkStation
 * isLocked():  while locked, the input desktop is the secure Winlogon desktop, so
 *              OpenInputDesktop/SwitchDesktop fail. A well-known heuristic, not an
 *              official API. Electron's powerMonitor 'lock-screen'/'unlock-screen'
 *              events (darwin, win32) are used as a second signal by main.js.
 */

import koffi from 'koffi';

const DESKTOP_SWITCHDESKTOP = 0x0100;

let hdesk = null; // koffi named types must be registered once per process

export function createWindows({ idleSeconds, notify }) {
  hdesk ??= koffi.pointer('HDESK', koffi.opaque());
  const user32 = koffi.load('user32.dll');
  const LockWorkStation = user32.func('int __stdcall LockWorkStation()');
  const OpenInputDesktop = user32.func('HDESK __stdcall OpenInputDesktop(uint32_t flags, int inherit, uint32_t access)');
  const SwitchDesktop = user32.func('int __stdcall SwitchDesktop(HDESK desk)');
  const CloseDesktop = user32.func('int __stdcall CloseDesktop(HDESK desk)');

  return {
    name: 'windows',
    idleSeconds,
    notify,
    isLocked() {
      const desk = OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP);
      if (!desk) return true;
      try {
        return SwitchDesktop(desk) === 0;
      } finally {
        CloseDesktop(desk);
      }
    },
    lock() {
      return LockWorkStation() !== 0;
    },
    fallbackLock() {
      return false; // LockWorkStation is the only supported mechanism
    },
  };
}
