// PARITY GATE: the JS face pipeline must match the Python/OpenCV 4.14.0
// reference (scripts/parity/reference.py) on fixed public images:
// boxes/landmarks within a few px, embedding cosine >= 0.99.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { FaceEngine } from '../src/vision/engine.js';
import { bgrToRgba, rgbaToBgr } from '../src/vision/image.js';
import * as sface from '../src/vision/sface.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures');
const MODELS = path.join(ROOT, 'models');

// The JS detector runs at OpenCV's native padded size (see yunet.js /
// onnx-patch.js), so every fixture, including the >640 px ones that stand in
// for 720p camera frames, must match tightly. The requirement is <= a few px
// and cosine >= 0.99; we hold it to 0.05 px and 0.999.
const CASES = ['lena', 'messi5', 'box', 'lena_1024', 'messi_x2']
  .map((stem) => ({ stem, boxTol: 0.05, cosMin: 0.999 }));

let engine;
const report = [];

before(async () => { engine = await FaceEngine.create(MODELS); });
after(() => {
  console.log('\nPARITY (JS vs Python/OpenCV 4.14.0)');
  for (const r of report) console.log(`  ${r}`);
});

function cosine(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / Math.sqrt(na * nb);
}

for (const { stem, boxTol, cosMin } of CASES) {
  test(`parity: ${stem}`, async () => {
    const ref = JSON.parse(readFileSync(path.join(FIX, `${stem}.ref.json`), 'utf8'));
    const bgr = new Uint8Array(gunzipSync(readFileSync(path.join(FIX, `${stem}.bgr.gz`))));
    assert.equal(bgr.length, ref.width * ref.height * 3);
    // Go through the same RGBA -> BGR conversion camera frames take.
    const img = rgbaToBgr(bgrToRgba({ width: ref.width, height: ref.height, data: bgr }), ref.width, ref.height);
    assert.deepEqual(img.data, bgr);
    const rows = await engine.detectAll(img);
    assert.equal(rows.length, ref.faces.length, `face count for ${stem}`);
    if (rows.length === 0) {
      report.push(`${stem.padEnd(10)} ${ref.width}x${ref.height}  0 faces in both`);
      return;
    }
    for (let i = 0; i < rows.length; i += 1) {
      const want = ref.faces[i];
      let maxPx = 0;
      for (let k = 0; k < 14; k += 1) maxPx = Math.max(maxPx, Math.abs(rows[i][k] - want.row[k]));
      const scoreDiff = Math.abs(rows[i][14] - want.row[14]);

      const aligned = sface.alignCrop(img, rows[i]);
      const refAligned = Buffer.from(want.aligned_bgr_b64, 'base64');
      let maxDiff = 0; let sumDiff = 0;
      for (let k = 0; k < refAligned.length; k += 1) {
        const d = Math.abs(aligned.data[k] - refAligned[k]);
        maxDiff = Math.max(maxDiff, d);
        sumDiff += d;
      }
      const emb = await engine.embedding(img, rows[i]);
      const cos = cosine(emb, want.embedding);
      // Same aligned pixels through onnxruntime vs cv::dnn: isolates the runtime.
      const embFromRefCrop = await engine.rec.run({
        data: new (await import('onnxruntime-node')).default.Tensor('float32',
          sface.blob({ data: refAligned }), [1, 3, 112, 112]),
      });
      const cosRuntime = cosine(embFromRefCrop.fc1.data, want.embedding);

      report.push(`${stem.padEnd(10)} ${ref.width}x${ref.height}  box/landmark max diff ${maxPx.toFixed(3)} px, `
        + `score diff ${scoreDiff.toFixed(4)}, aligned crop max|mean diff ${maxDiff}|${(sumDiff / refAligned.length).toFixed(3)}, `
        + `embedding cosine ${cos.toFixed(5)} (runtime-only ${cosRuntime.toFixed(5)})`);
      assert.ok(maxPx <= boxTol, `${stem}: landmarks off by ${maxPx}px`);
      assert.ok(scoreDiff < 0.02, `${stem}: score diff ${scoreDiff}`);
      assert.ok(cos >= cosMin, `${stem}: embedding cosine ${cos}`);
      assert.ok(cosRuntime >= 0.999, `${stem}: runtime cosine ${cosRuntime}`);
    }
  });
}
