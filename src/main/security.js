/**
 * Process-wide lockdown, installed before any window exists:
 *  - every renderer sandboxed; no window.open, no navigation, no <webview>
 *  - ALL network requests cancelled (only this app's own files load)
 *  - permissions: only camera (video, no audio) for the hidden camera window
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, session } from 'electron';

export function isAllowedUrl(url, appRoot) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'devtools:') return true;
  if (u.protocol !== 'file:') return false; // http(s), ws(s), ftp, data, blob, ... all denied
  let file;
  try {
    file = path.resolve(fileURLToPath(u));   // throws for remote hosts, relative paths, etc.
  } catch {
    return false;                            // anything we cannot map to a local path is denied
  }
  const root = path.resolve(appRoot);
  return file === root || file.startsWith(root + path.sep);
}

export function installSecurity({ appRoot, isCameraWindow, log }) {
  const ses = session.defaultSession;
  let blocked = 0;

  ses.webRequest.onBeforeRequest((details, callback) => {
    const ok = isAllowedUrl(details.url, appRoot);
    if (!ok) {
      blocked += 1;
      log.warn(`blocked request to ${details.url.split('?')[0].slice(0, 120)}`);
    }
    callback({ cancel: !ok });
  });

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const media = permission === 'media'
      && Array.isArray(details?.mediaTypes)
      && details.mediaTypes.length > 0
      && details.mediaTypes.every((t) => t === 'video');
    callback(Boolean(media && webContents && isCameraWindow(webContents.id)));
  });
  ses.setPermissionCheckHandler((webContents, permission, _origin, details) => (
    permission === 'media' && details?.mediaType !== 'audio'
      && Boolean(webContents && isCameraWindow(webContents.id))));
  ses.setDevicePermissionHandler(() => false);

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (e) => e.preventDefault());
    contents.on('will-redirect', (e) => e.preventDefault());
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });

  return { blockedCount: () => blocked };
}
