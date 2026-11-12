/**
 * One-time copy of user data from the pre-rename "away-lock-js" folder.
 *
 * Runs only when the new folder does not exist yet, so it never overwrites
 * anything. Copies (does not move): the old folder stays until you delete it.
 * Chromium's own session data is not carried over.
 */

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const LEGACY_DIR_NAME = 'away-lock-js';
export const LEGACY_ITEMS = [
  'settings.json', 'face_templates.json', 'trusted_usb.json', 'usb_events.json', 'intruder_photos',
];

const isDir = (p) => existsSync(p) && statSync(p).isDirectory();

export function migrateLegacy(newDir, oldDir) {
  if (existsSync(newDir) || !isDir(oldDir)) return [];
  mkdirSync(newDir, { recursive: true, mode: 0o700 });
  chmodSync(newDir, 0o700);
  const copied = [];
  for (const name of LEGACY_ITEMS) {
    const src = path.join(oldDir, name);
    if (!existsSync(src)) continue;
    const dst = path.join(newDir, name);
    cpSync(src, dst, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    if (isDir(dst)) {
      chmodSync(dst, 0o700);
      // Only flat folders are migrated (intruder_photos holds plain files).
      for (const f of readdirSync(dst)) {
        const full = path.join(dst, f);
        if (!isDir(full)) chmodSync(full, 0o600);
      }
    } else {
      chmodSync(dst, 0o600);
    }
    copied.push(name);
  }
  return copied;
}
