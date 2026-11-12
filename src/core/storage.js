/**
 * Owner-only file storage for settings and face templates.
 *
 * Templates are unit-length SFace embeddings (numbers, never images) in JSON,
 * written atomically with mode 0600 inside a 0700 directory. On Windows the
 * mode bits do little; the file is protected by the user profile's ACLs.
 */

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_SETTINGS, validateSettings } from './policy.js';

const POSIX = process.platform !== 'win32';
export const EMBEDDING_DIM = 128;

export class TemplateError extends Error {}

export async function ensurePrivateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (POSIX) await chmod(dir, 0o700);
}

/** Atomic write (temp file in the same dir + rename), mode 0600. */
export async function writePrivate(file, text) {
  await ensurePrivateDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

// ── templates ────────────────────────────────────────────────────────────
export function normalizeAll(vectors) {
  if (!Array.isArray(vectors) || vectors.length < 1) throw new TemplateError('need at least one embedding');
  return vectors.map((v) => {
    const arr = Array.from(v);
    if (arr.length !== EMBEDDING_DIM) throw new TemplateError(`expected ${EMBEDDING_DIM} values, got ${arr.length}`);
    if (!arr.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new TemplateError('non-finite value');
    const n = Math.hypot(...arr);
    if (!(n > 0)) throw new TemplateError('zero-length embedding');
    return Float32Array.from(arr, (x) => x / n);
  });
}

export async function saveTemplates(file, vectors) {
  const unit = normalizeAll(vectors);
  const doc = { version: 1, dim: EMBEDDING_DIM, embeddings: unit.map((v) => Array.from(v)) };
  await writePrivate(file, JSON.stringify(doc));
  return unit.length;
}

export async function loadTemplates(file) {
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new TemplateError('no face templates yet. Use "Enroll face" in Settings.');
  }
  if (POSIX && (info.mode & 0o077)) {
    throw new TemplateError(`${file} is readable by other users (mode ${(info.mode & 0o777).toString(8)}); `
      + `fix with: chmod 600 "${file}"`);
  }
  let doc;
  try {
    doc = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new TemplateError(`cannot read ${file}: ${err.message}`);
  }
  if (!doc || doc.version !== 1 || doc.dim !== EMBEDDING_DIM) throw new TemplateError('unknown template format');
  return normalizeAll(doc.embeddings);
}

// ── settings ─────────────────────────────────────────────────────────────
export const EXTRA_DEFAULTS = Object.freeze({
  matchThreshold: 0.363,
  detectionScore: 0.8,
  cameraDeviceId: '',
  usbGuard: false, // lock when an untrusted USB device is plugged in
  usbPhoto: false, // ...and take an intruder photo (needs usbGuard)
});

export const SETTINGS_DEFAULTS = Object.freeze({ ...DEFAULT_SETTINGS, ...EXTRA_DEFAULTS });

export function validateAll(s) {
  validateSettings(s);
  for (const k of ['matchThreshold', 'detectionScore']) {
    if (typeof s[k] !== 'number' || !(s[k] > 0 && s[k] < 1)) throw new Error(`${k} must be between 0 and 1`);
  }
  if (typeof s.cameraDeviceId !== 'string' || s.cameraDeviceId.length > 512) throw new Error('bad cameraDeviceId');
  for (const k of ['usbGuard', 'usbPhoto']) {
    if (typeof s[k] !== 'boolean') throw new Error(`${k} must be true or false`);
  }
}

/**
 * Load settings. A missing file gives defaults silently; an unreadable or
 * invalid file gives defaults PLUS a warning, so the app keeps protecting you
 * (it never falls back to "not watching") and tells you why.
 */
export async function loadSettings(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { settings: { ...SETTINGS_DEFAULTS }, warning: null };
    return { settings: { ...SETTINGS_DEFAULTS }, warning: `Could not read settings (${err.code}); using defaults.` };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    const known = Object.fromEntries(Object.keys(SETTINGS_DEFAULTS)
      .filter((k) => k in parsed).map((k) => [k, parsed[k]]));
    const merged = { ...SETTINGS_DEFAULTS, ...known };
    validateAll(merged);
    return { settings: merged, warning: null };
  } catch (err) {
    return { settings: { ...SETTINGS_DEFAULTS }, warning: `Settings file was invalid (${err.message}); using defaults.` };
  }
}

export async function saveSettings(file, settings) {
  const merged = { ...SETTINGS_DEFAULTS, ...settings };
  validateAll(merged);
  const clean = Object.fromEntries(Object.keys(SETTINGS_DEFAULTS).map((k) => [k, merged[k]]));
  await writePrivate(file, JSON.stringify(clean, null, 2));
  return clean;
}
