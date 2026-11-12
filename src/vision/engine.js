/**
 * Face engine: YuNet detection + SFace embeddings on onnxruntime-node, and the
 * per-check classification (OWNER / STRANGER / ABSENT), mirroring
 * paseboon/vision.py. Frames are plain in-memory buffers; nothing here
 * writes, encodes or sends pixels.
 */

import ort from 'onnxruntime-node';

import { Result } from '../core/policy.js';
import { DETECTOR, RECOGNIZER, loadVerified, sha256 } from './models.js';
import { relaxShapes } from './onnx-patch.js';
import * as sface from './sface.js';
import * as yunet from './yunet.js';

// Operating points published with the OpenCV Zoo models (same as the Python app).
export const DETECTION_SCORE = 0.8;
export const MATCH_THRESHOLD = 0.363;
export const MIN_FACE_PX = 60; // ignore tiny faces (someone far behind you)
export const NMS_THRESHOLD = 0.3;
export const TOP_K = 50;
/** SHA-256 of the YuNet model after relaxShapes(): pins the patch output too. */
export const YUNET_RELAXED_SHA256 = '53f776ae55acb7c0f8d46775f6a3262ae5758cc7efc9de56c1ac4f40a285bcef';

export async function loadDetectorBytes(modelsDir) {
  const relaxed = relaxShapes(await loadVerified(DETECTOR, modelsDir));
  const digest = sha256(relaxed);
  if (digest !== YUNET_RELAXED_SHA256) {
    throw new Error(`relaxed YuNet graph has unexpected SHA-256 ${digest.slice(0, 16)}...`);
  }
  return relaxed;
}

export class FaceEngine {
  static async create(modelsDir, opts = {}) {
    const sessOpts = { logSeverityLevel: 3, executionProviders: ['cpu'] };
    const [det, rec] = await Promise.all([
      loadDetectorBytes(modelsDir).then((b) => ort.InferenceSession.create(b, sessOpts)),
      loadVerified(RECOGNIZER, modelsDir).then((b) => ort.InferenceSession.create(b, sessOpts)),
    ]);
    return new FaceEngine(det, rec, opts);
  }

  constructor(detSession, recSession, {
    detectionScore = DETECTION_SCORE, matchThreshold = MATCH_THRESHOLD, minFacePx = MIN_FACE_PX,
    templates = null,
  } = {}) {
    this.det = detSession;
    this.rec = recSession;
    this.detectionScore = detectionScore;
    this.matchThreshold = matchThreshold;
    this.minFacePx = minFacePx;
    this.templates = templates; // array of unit Float32Array(128), null while enrolling
  }

  /** All YuNet rows in original-image coordinates (no size filter). */
  async detectAll(img) {
    const { blob, padW, padH } = yunet.prepare(img);
    const input = new ort.Tensor('float32', blob, [1, 3, padH, padW]);
    const out = await this.det.run({ input });
    const outputs = Object.fromEntries(Object.entries(out).map(([k, t]) => [k, t.data]));
    return yunet.decode(outputs, padW, padH, {
      scoreThreshold: this.detectionScore, nmsThreshold: NMS_THRESHOLD, topK: TOP_K,
    });
  }

  /** Faces big enough to be someone at the keyboard. */
  async faces(img) {
    const rows = await this.detectAll(img);
    return rows.filter((r) => r[2] >= this.minFacePx && r[3] >= this.minFacePx);
  }

  async embedding(img, row) {
    const aligned = sface.alignCrop(img, row);
    const data = new ort.Tensor('float32', sface.blob(aligned), [1, 3, sface.SIZE, sface.SIZE]);
    const out = await this.rec.run({ data });
    return Float32Array.from(out.fc1.data);
  }
}

/**
 * Accumulates one camera check across frames, like vision.check() in Python:
 * OWNER as soon as a face matches; STRANGER if faces were seen but never
 * matched; ABSENT if no face; CAMERA_ERROR if no frame arrived.
 */
export class CheckSession {
  constructor(engine) {
    if (!engine.templates || engine.templates.length === 0) {
      throw new Error('a camera check needs enrolled templates');
    }
    this.engine = engine;
    this.started = performance.now();
    this.outcome = { result: Result.ABSENT, frames: 0, faces: 0, bestDetection: 0, bestMatch: null, seconds: 0, note: '' };
  }

  /** Feed one BGR frame; resolves true when the check is decided (owner seen). */
  async addFrame(img) {
    const o = this.outcome;
    o.frames += 1;
    const faces = await this.engine.faces(img);
    o.faces = Math.max(o.faces, faces.length);
    for (const face of faces) {
      o.bestDetection = Math.max(o.bestDetection, face[14]);
      const score = sface.bestMatch(this.engine.templates, await this.engine.embedding(img, face));
      o.bestMatch = o.bestMatch == null ? score : Math.max(o.bestMatch, score);
      if (score >= this.engine.matchThreshold) {
        o.result = Result.OWNER;
        return true;
      }
    }
    return false;
  }

  finish(error = null) {
    const o = this.outcome;
    if (error) {
      o.result = Result.CAMERA_ERROR;
      o.note = String(error).split('\n')[0].slice(0, 200);
    } else if (o.result === Result.ABSENT) {
      if (o.frames === 0) {
        o.result = Result.CAMERA_ERROR;
        o.note = 'camera returned no frames';
      } else if (o.faces) {
        o.result = Result.STRANGER;
      }
    }
    o.seconds = (performance.now() - this.started) / 1000;
    return o;
  }
}
