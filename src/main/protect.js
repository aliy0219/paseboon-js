/**
 * Which settings-window IPC channels need an unlocked AuthGate session.
 * Enforced in the main process: the renderer is untrusted.
 *
 * No Electron import, so the wrapping is unit-tested directly.
 */

export const PROTECTED_CHANNELS = Object.freeze([
  'save-settings', 'enroll', 'test-camera', 'test-lock', 'set-login-item', 'set-paused',
  'usb-trust-connected', 'usb-trust', 'usb-untrust', 'usb-clear-events',
  'photos-delete-all', 'photos-open-folder',
]);

// Reading state, asking to unlock, and keeping an unlocked session alive.
export const OPEN_CHANNELS = Object.freeze(['get-state', 'usb-state', 'auth-unlock', 'auth-touch']);

/**
 * Wrap route handlers: protected ones run only after `requireAuth()` resolves
 * { ok: true }; otherwise they return { authRequired: true, ...result } and the
 * handler is never called. Every channel must be classified (a new channel that
 * nobody classified throws at startup instead of silently being open).
 */
export function protectRoutes(routes, { requireAuth }) {
  const out = {};
  for (const [channel, fn] of Object.entries(routes)) {
    if (PROTECTED_CHANNELS.includes(channel)) {
      out[channel] = async (arg) => {
        const auth = await requireAuth(channel);
        if (!auth?.ok) return { authRequired: true, ...auth };
        return fn(arg);
      };
    } else if (OPEN_CHANNELS.includes(channel)) {
      out[channel] = fn;
    } else {
      throw new Error(`IPC channel "${channel}" is not classified as protected or open`);
    }
  }
  return out;
}
