/**
 * OS adapters, all with the same shape (sync or async methods):
 *   idleSeconds() -> number|null, isLocked() -> boolean|null, lock() -> boolean,
 *   fallbackLock() -> boolean, notify(text)
 * idleSeconds/notify are injected (Electron powerMonitor / Notification) so the
 * adapters stay testable without Electron.
 */

export async function createPlatform(deps) {
  if (process.platform === 'darwin') return (await import('./macos.js')).createMacOS(deps);
  if (process.platform === 'win32') return (await import('./windows.js')).createWindows(deps);
  if (process.platform === 'linux') return (await import('./linux.js')).createLinux(deps);
  throw new Error(`unsupported platform: ${process.platform}`);
}
