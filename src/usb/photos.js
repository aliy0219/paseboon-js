/**
 * Intruder photos: the ONLY module allowed to encode or write an image (a test
 * enforces that).
 *
 * Taken only when an UNTRUSTED USB device is connected and the photo toggle is
 * on. Kept on this computer only: <userData>/intruder_photos (0700), files
 * 0600, newest MAX_PHOTOS kept, never uploaded (the app blocks all network).
 *
 * PHOTO_TIMING is the single switch for the order:
 *   'before_lock'  (default) grab a photo first, then lock. The lock waits at
 *                  most PRE_LOCK_MAX_SECONDS for the photo; if the camera is
 *                  slower, it locks anyway and keeps the photo if it arrives.
 *   'after_lock'   lock first, then take the photo. Does NOT work on macOS:
 *                  once the screen is locked the camera refuses to start
 *                  ("NotReadableError: Could not start video source", seen on
 *                  macOS 27.2.1).
 */

import { chmod, mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export const PHOTO_TIMING = 'before_lock';
export const TIMINGS = Object.freeze(['after_lock', 'before_lock']);
export const MAX_PHOTOS = 50;
export const CAMERA_WAIT_SECONDS = 5.0; // wait for an in-flight face check to free the camera
export const PRE_LOCK_CAMERA_WAIT = 0.3; // before_lock: never wait long for a busy camera
export const PRE_LOCK_MAX_SECONDS = 2.5; // before_lock: the lock never waits longer than this for the photo
// Webcams start dark and need ~0.5-1 s of auto-exposure. A fixed 2-frame warm-up
// gave black photos (brightness 0.9/255), so read frames until exposure settles.
export const SETTLE_SECONDS = 1.5; // read frames for at most this long
export const SETTLE_MIN_MEAN = 35; // a usable photo is at least this bright (0-255)
export const SETTLE_DELTA = 4; // brightness change between frames that counts as settled
export const JPEG_QUALITY = 85;

const POSIX = process.platform !== 'win32';

export async function ensurePhotoDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (POSIX) await chmod(dir, 0o700);
}

/** Photo files, oldest first. */
export async function listPhotos(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const n of names) {
    if (!n.endsWith('.jpg')) continue;
    const p = path.join(dir, n);
    try {
      const st = await stat(p);
      if (st.isFile()) files.push({ path: p, name: n, mtime: st.mtimeMs });
    } catch { /* vanished */ }
  }
  files.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  return files.map((f) => f.path);
}

export async function deleteAll(dir) {
  const files = await listPhotos(dir);
  for (const f of files) await rm(f, { force: true });
  return files.length;
}

export async function enforceRetention(dir, keep = MAX_PHOTOS) {
  const files = await listPhotos(dir);
  const extra = files.length > keep ? files.slice(0, files.length - keep) : [];
  for (const f of extra) await rm(f, { force: true });
  return extra.length;
}

export function photoStem(deviceKeys, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const ids = deviceKeys.join('+').replace(/[^0-9A-Za-z]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'usb';
  return `${stamp}-${ids}`;
}

/** O_EXCL create with mode 0600; never overwrites an existing photo. */
async function writeNew(bytes, dir, stem) {
  await ensurePhotoDir(dir);
  for (let n = 1; n < 100; n += 1) {
    const file = path.join(dir, n === 1 ? `${stem}.jpg` : `${stem}-${n}.jpg`);
    let fh;
    try {
      fh = await open(file, 'wx', 0o600);
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
    try {
      await fh.writeFile(bytes);
    } finally {
      await fh.close();
    }
    if (POSIX) await chmod(file, 0o600);
    return file;
  }
  throw new Error('too many photos with the same name');
}

/** Average brightness (0-255) of a BGR frame, sampled every `step` pixels. */
export function meanLuma(img, step = 16) {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      const i = (y * img.width + x) * 3;
      sum += 0.114 * img.data[i] + 0.587 * img.data[i + 1] + 0.299 * img.data[i + 2];
      n += 1;
    }
  }
  return n ? sum / n : 0;
}

/** Feed frames in order; says when auto-exposure has settled and keeps the best frame. */
export class ExposureWatch {
  constructor({ minMean = SETTLE_MIN_MEAN, delta = SETTLE_DELTA } = {}) {
    Object.assign(this, { minMean, delta, best: null, bestMean: -1, last: null, lastMean: null, settled: false, frames: 0 });
  }

  offer(img) {
    const m = meanLuma(img);
    this.frames += 1;
    if (m > this.bestMean) { this.best = img; this.bestMean = m; }
    if (this.lastMean !== null && m >= this.minMean && Math.abs(m - this.lastMean) <= this.delta) this.settled = true;
    this.last = img;
    this.lastMean = m;
    return this.settled;
  }

  get frame() { return this.settled ? this.last : this.best; }

  get mean() { return this.settled ? this.lastMean : this.bestMean; }
}

/** BGR frame -> JPEG bytes via Electron's built-in encoder (main process only). */
export async function encodeJpeg(img, quality = JPEG_QUALITY) {
  const { nativeImage } = await import('electron');
  const bgra = Buffer.alloc(img.width * img.height * 4);
  for (let i = 0, j = 0; j < img.data.length; i += 4, j += 3) {
    bgra[i] = img.data[j];
    bgra[i + 1] = img.data[j + 1];
    bgra[i + 2] = img.data[j + 2];
    bgra[i + 3] = 255;
  }
  const jpeg = nativeImage.createFromBitmap(bgra, { width: img.width, height: img.height }).toJPEG(quality);
  if (!jpeg?.length) throw new Error('could not encode the photo');
  return jpeg;
}

/**
 * Take one photo and save it.
 * @param {object} o
 * @param {string[]} o.deviceKeys  devices that triggered it (used in the file name)
 * @param {string} o.dir           photos directory
 * @param {() => Promise<object|null>} o.grab  one BGR frame from the shared camera queue
 * @param {(img: object) => Promise<Buffer>|Buffer} [o.encode]
 * @returns {Promise<string>} the new file path; throws if the camera gave nothing
 */
export async function takePhoto({ deviceKeys, dir, grab, encode = encodeJpeg, now = new Date(), log = console }) {
  let frame = await grab();
  if (!frame) throw new Error('camera returned no frames');
  let bytes = await encode(frame);
  frame = null;
  const file = await writeNew(bytes, dir, photoStem(deviceKeys, now));
  bytes = null;
  const removed = await enforceRetention(dir);
  log.warn(`intruder photo saved: ${path.basename(file)}${removed ? ` (${removed} old photo(s) removed)` : ''}`);
  return file;
}
