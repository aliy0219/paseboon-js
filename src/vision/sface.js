/**
 * SFace alignment + embedding input: a port of OpenCV 4.14.0
 * objdetect/src/face_recognize.cpp (alignCrop, getSimilarityTransformMatrix, feature).
 */

import { warpAffineBGR } from './image.js';

export const SIZE = 112;
// OpenCV's reference landmarks for the 112x112 aligned face, and the mean it uses.
const DST = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];
const DST_MEAN = [56.0262, 71.9008];
const f32 = Math.fround;

/**
 * Umeyama similarity transform (rotation + uniform scale + translation) from
 * the 5 detected landmarks to DST. OpenCV computes it with a 2x2 SVD; for a
 * 2x2 cross-covariance A the optimal proper rotation and trace(S*D) have a
 * closed form, identical to the SVD result whenever A has rank 2:
 *   angle = atan2(A10 - A01, A00 + A11), trace = hypot(A00 + A11, A10 - A01).
 * Returns the forward 2x3 matrix [a, b, c, d, e, f].
 */
export function similarityTransform(row) {
  const src = [0, 1, 2, 3, 4].map((i) => [row[4 + 2 * i], row[5 + 2 * i]]);
  const mean = [0, 1].map((k) => f32(src.reduce((acc, p) => f32(acc + p[k]), 0) / 5));
  const sd = src.map((p) => [f32(p[0] - mean[0]), f32(p[1] - mean[1])]);
  const dd = DST.map((p) => [f32(p[0] - DST_MEAN[0]), f32(p[1] - DST_MEAN[1])]);
  let A00 = 0; let A01 = 0; let A10 = 0; let A11 = 0;
  for (let i = 0; i < 5; i += 1) {
    A00 += dd[i][0] * sd[i][0];
    A01 += dd[i][0] * sd[i][1];
    A10 += dd[i][1] * sd[i][0];
    A11 += dd[i][1] * sd[i][1];
  }
  A00 /= 5; A01 /= 5; A10 /= 5; A11 /= 5;
  const angle = Math.atan2(A10 - A01, A00 + A11);
  const traceSD = Math.hypot(A00 + A11, A10 - A01);
  const varSrc = sd.reduce((acc, p) => acc + p[0] * p[0] + p[1] * p[1], 0) / 5;
  const scale = varSrc > 0 ? traceSD / varSrc : 0;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const tx = DST_MEAN[0] - scale * (cos * mean[0] - sin * mean[1]);
  const ty = DST_MEAN[1] - scale * (sin * mean[0] + cos * mean[1]);
  return [scale * cos, -scale * sin, tx, scale * sin, scale * cos, ty];
}

/** recognizer.alignCrop(img, faceRow) -> 112x112 BGR. */
export function alignCrop(img, row) {
  return warpAffineBGR(img, similarityTransform(row), SIZE, SIZE);
}

/** blobFromImage(aligned, 1, (112,112), 0, swapRB=true): 1x3x112x112 float RGB. */
export function blob(aligned) {
  const plane = SIZE * SIZE;
  const out = new Float32Array(3 * plane);
  const { data } = aligned;
  for (let i = 0; i < plane; i += 1) {
    out[i] = data[i * 3 + 2];
    out[plane + i] = data[i * 3 + 1];
    out[2 * plane + i] = data[i * 3];
  }
  return out;
}

export function normalize(vec) {
  let n = 0;
  for (const v of vec) n += v * v;
  n = Math.sqrt(n);
  if (!Number.isFinite(n) || n === 0) throw new Error('embedding with zero or non-finite length');
  return Float32Array.from(vec, (v) => v / n);
}

/** Highest cosine similarity between one embedding and the templates (all unit length). */
export function bestMatch(templates, embedding) {
  const e = normalize(embedding);
  let best = -Infinity;
  for (const t of templates) {
    let dot = 0;
    for (let i = 0; i < e.length; i += 1) dot += t[i] * e[i];
    if (dot > best) best = dot;
  }
  return best;
}
