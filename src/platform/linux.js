/**
 * Linux adapter (UNTESTED: written to the documented interfaces, never run).
 *
 * The app is not necessarily started inside your logind session (autostart
 * usually is, but not always), so the graphical session id is looked up with
 * `loginctl show-user <uid> -p Display` when XDG_SESSION_ID is missing.
 *
 * lock():         loginctl lock-session <id>
 * fallbackLock(): org.freedesktop.ScreenSaver.Lock over D-Bus, then xdg-screensaver
 * isLocked():     loginctl show-session <id> -p LockedHint
 * idle:           Electron powerMonitor (X11 and most Wayland compositors)
 */

import { execFile } from 'node:child_process';

function run(cmd, args, timeout = 3000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

export async function findSession() {
  if (process.env.XDG_SESSION_ID) return process.env.XDG_SESSION_ID;
  const out = await run('loginctl', ['show-user', String(process.getuid()), '-p', 'Display', '--value']);
  return out || null;
}

export async function createLinux({ idleSeconds, notify, log = console }) {
  const session = await findSession();
  if (!session) log.warn('no graphical logind session found; lock state unknown');

  return {
    name: 'linux',
    idleSeconds,
    notify,
    async isLocked() {
      if (!session) return null;
      const v = await run('loginctl', ['show-session', session, '-p', 'LockedHint', '--value']);
      if (v === 'yes') return true;
      if (v === 'no') return false;
      return null;
    },
    async lock() {
      if (!session) return false;
      return (await run('loginctl', ['lock-session', session])) !== null;
    },
    async fallbackLock() {
      const dbus = await run('gdbus', ['call', '--session', '--dest', 'org.freedesktop.ScreenSaver',
        '--object-path', '/org/freedesktop/ScreenSaver', '--method', 'org.freedesktop.ScreenSaver.Lock']);
      if (dbus !== null) return true;
      return (await run('xdg-screensaver', ['lock'])) !== null;
    },
  };
}
