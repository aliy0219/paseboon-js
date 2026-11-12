/**
 * YuNet face detector: a port of OpenCV 4.14.0 objdetect/src/face_detect.cpp
 * (FaceDetectorYNImpl::detect + postProcess) and dnn NMSBoxes, run on
 * onnxruntime instead of cv::dnn.
 *
 * Like OpenCV, the image is zero-padded on the right/bottom to a multiple of
 * 32 and run at that size (the model's fixed 640x640 declaration is relaxed
 * in memory, see onnx-patch.js), so results match cv::FaceDetectorYN.
 *
 * Output rows match OpenCV: [x, y, w, h, re_x, re_y, le_x, le_y, nt_x, nt_y,
 * rcm_x, rcm_y, lcm_x, lcm_y, score].
 */

const STRIDES = [8, 16, 32];
const DIVISOR = 32;
const f32 = Math.fround;

export const padded = (n) => Math.trunc((n - 1) / DIVISOR + 1) * DIVISOR;

/** padWithDivisor + blobFromImage(pad): 1x3xpadHxpadW float BGR, no scaling, no swap. */
export function prepare(img) {
  const padW = padded(img.width);
  const padH = padded(img.height);
  const plane = padW * padH;
  const blob = new Float32Array(3 * plane);
  const { width: w, height: h, data } = img;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 3;
      const o = y * padW + x;
      blob[o] = data[i];
      blob[plane + o] = data[i + 1];
      blob[2 * plane + o] = data[i + 2];
    }
  }
  return { blob, padW, padH };
}

/** postProcess(): decode all strides, then NMS. outputs maps name -> Float32Array. */
export function decode(outputs, padW, padH, { scoreThreshold = 0.8, nmsThreshold = 0.3, topK = 50 } = {}) {
  const faces = [];
  STRIDES.forEach((stride) => {
    const cols = Math.trunc(padW / stride);
    const rows = Math.trunc(padH / stride);
    const cls = outputs[`cls_${stride}`];
    const obj = outputs[`obj_${stride}`];
    const bbox = outputs[`bbox_${stride}`];
    const kps = outputs[`kps_${stride}`];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const idx = r * cols + c;
        const clsScore = Math.max(Math.min(cls[idx], 1), 0);
        const objScore = Math.max(Math.min(obj[idx], 1), 0);
        const score = f32(Math.sqrt(f32(clsScore * objScore)));
        if (score < scoreThreshold) continue;
        const cx = f32((c + bbox[idx * 4]) * stride);
        const cy = f32((r + bbox[idx * 4 + 1]) * stride);
        const w = f32(Math.exp(bbox[idx * 4 + 2]) * stride);
        const h = f32(Math.exp(bbox[idx * 4 + 3]) * stride);
        const row = new Float32Array(15);
        row[0] = cx - w / 2;
        row[1] = cy - h / 2;
        row[2] = w;
        row[3] = h;
        for (let n = 0; n < 5; n += 1) {
          row[4 + 2 * n] = (kps[idx * 10 + 2 * n] + c) * stride;
          row[5 + 2 * n] = (kps[idx * 10 + 2 * n + 1] + r) * stride;
        }
        row[14] = score;
        faces.push(row);
      }
    }
  });
  if (faces.length <= 1) return faces;
  const boxes = faces.map((f) => [Math.trunc(f[0]), Math.trunc(f[1]), Math.trunc(f[2]), Math.trunc(f[3])]);
  const keep = nmsBoxes(boxes, faces.map((f) => f[14]), scoreThreshold, nmsThreshold, topK);
  return keep.map((i) => faces[i]);
}

/** cv::dnn::NMSBoxes for integer Rects, eta = 1 (top_k truncates before suppression). */
export function nmsBoxes(boxes, scores, scoreThreshold, nmsThreshold, topK) {
  let order = [];
  scores.forEach((s, i) => { if (s > scoreThreshold) order.push(i); });
  order.sort((i, j) => scores[j] - scores[i] || i - j); // stable, descending
  if (topK > 0 && topK < order.length) order = order.slice(0, topK);
  const kept = [];
  for (const idx of order) {
    let keep = true;
    for (let k = 0; k < kept.length && keep; k += 1) {
      keep = rectOverlap(boxes[idx], boxes[kept[k]]) <= nmsThreshold;
    }
    if (keep) kept.push(idx);
  }
  return kept;
}

/** 1 - jaccardDistance(a, b) for cv::Rect (integer x, y, w, h). */
export function rectOverlap(a, b) {
  const areaA = a[2] * a[3];
  const areaB = b[2] * b[3];
  if (areaA + areaB <= 0) return 1;
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = x2 > x1 && y2 > y1 ? (x2 - x1) * (y2 - y1) : 0;
  return f32(inter / (areaA + areaB - inter));
}
