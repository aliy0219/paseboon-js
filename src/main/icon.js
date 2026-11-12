/**
 * Tray icon drawn in code (no binary assets): a small padlock, as a macOS
 * template image (black + alpha, recoloured by the system).
 */

import { nativeImage } from 'electron';

function padlock(size, open) {
  const buf = Buffer.alloc(size * size * 4); // BGRA
  const set = (x, y, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i + 3] = Math.max(buf[i + 3], a);
  };
  const s = size / 16;
  // body
  for (let y = Math.round(7 * s); y < Math.round(15 * s); y += 1) {
    for (let x = Math.round(3 * s); x < Math.round(13 * s); x += 1) set(x, y);
  }
  // keyhole
  for (let y = Math.round(9.5 * s); y < Math.round(12.5 * s); y += 1) {
    for (let x = Math.round(7.25 * s); x < Math.round(8.75 * s); x += 1) {
      buf[(y * size + x) * 4 + 3] = 0;
    }
  }
  // shackle: ring of radius ~3.5 above the body
  const cx = 8 * s;
  const cy = 6.5 * s;
  const r = 3.6 * s;
  const t = 1.2 * s;
  for (let y = 0; y < Math.round(7 * s); y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const onRing = Math.abs(d - r) <= t / 2 + 0.3;
      const leftLeg = x + 0.5 < cx - r + t / 2 + 0.5 && x + 0.5 > cx - r - t / 2 - 0.5;
      if (onRing && (y + 0.5 <= cy || leftLeg || !open)) set(x, y);
      if (open && y + 0.5 > cy && !leftLeg) buf[(y * size + x) * 4 + 3] = 0;
    }
  }
  return buf;
}

export function trayIcon({ paused = false } = {}) {
  // 32x32 raw BGRA drawn at scale factor 2 = a crisp 16pt menu-bar icon.
  const out = nativeImage.createFromBitmap(padlock(32, paused), { width: 32, height: 32, scaleFactor: 2 });
  if (process.platform === 'darwin') out.setTemplateImage(true);
  return out;
}
