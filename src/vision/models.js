/**
 * Face models from the OpenCV Zoo, pinned by commit, size and SHA-256 (same
 * pins as the Python Paseboon). They are bundled into the app at build time
 * (scripts/fetch-models.mjs) and verified on every load. The app never
 * downloads anything at runtime.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const ZOO_COMMIT = '48b10fa505aeb51fbd127fc60a5c660040e823b7';
const BASE = `https://media.githubusercontent.com/media/opencv/opencv_zoo/${ZOO_COMMIT}/models`;

export const DETECTOR = Object.freeze({
  filename: 'face_detection_yunet_2023mar.onnx',
  url: `${BASE}/face_detection_yunet/face_detection_yunet_2023mar.onnx`,
  size: 232_589,
  sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
});

export const RECOGNIZER = Object.freeze({
  filename: 'face_recognition_sface_2021dec.onnx',
  url: `${BASE}/face_recognition_sface/face_recognition_sface_2021dec.onnx`,
  size: 38_696_353,
  sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
});

export const ALL = Object.freeze([DETECTOR, RECOGNIZER]);

export class ModelError extends Error {}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Read a model, check size + SHA-256, and return its bytes (never a path to a mutable file). */
export async function loadVerified(model, dir) {
  const file = path.join(dir, model.filename);
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new ModelError(`${model.filename} is missing from ${dir}`);
  }
  if (info.size !== model.size) {
    throw new ModelError(`${model.filename} is ${info.size} bytes, expected ${model.size}`);
  }
  const bytes = await readFile(file);
  const digest = sha256(bytes);
  if (digest !== model.sha256) {
    throw new ModelError(`${model.filename} SHA-256 mismatch (${digest.slice(0, 16)}...)`);
  }
  return bytes;
}
