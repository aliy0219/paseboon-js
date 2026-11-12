/**
 * Minimal image helpers on interleaved 8-bit BGR buffers ({ width, height, data }).
 * Pure JS, no I/O: pixels only ever live in memory.
 */

/** RGBA (canvas ImageData layout) -> interleaved BGR. */
export function rgbaToBgr(rgba, width, height) {
  const out = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < width * height * 4; i += 4, j += 3) {
    out[j] = rgba[i + 2];
    out[j + 1] = rgba[i + 1];
    out[j + 2] = rgba[i];
  }
  return { width, height, data: out };
}

/** BGR -> RGBA, used by the parity test to feed fixtures through the camera conversion path. */
export function bgrToRgba(img) {
  const out = new Uint8ClampedArray(img.width * img.height * 4);
  for (let i = 0, j = 0; j < img.width * img.height * 3; i += 4, j += 3) {
    out[i] = img.data[j + 2];
    out[i + 1] = img.data[j + 1];
    out[i + 2] = img.data[j];
    out[i + 3] = 255;
  }
  return out;
}

/** Round half to even, like OpenCV's cvRound/saturate_cast on doubles. */
export function cvRound(v) {
  const r = Math.round(v);
  return Math.abs(v - Math.trunc(v)) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * cv::warpAffine(src, dst, M, (dw, dh), INTER_LINEAR, BORDER_CONSTANT, 0) for 8UC3,
 * following OpenCV's fixed-point path: the inverse map is evaluated in 1/1024
 * steps, quantised to 1/32 pixel, and interpolated with 15-bit integer weights.
 * M is the forward 2x3 matrix [a, b, c, d, e, f].
 */
export function warpAffineBGR(img, M, dw, dh) {
  const AB_BITS = 10;
  const AB_SCALE = 1 << AB_BITS;
  const INTER_BITS = 5;
  const TAB = 1 << INTER_BITS;
  const ROUND_DELTA = AB_SCALE / TAB / 2;
  const COEF_BITS = 15;

  const [a, b, c, d, e, f] = M;
  let D = a * e - b * d;
  D = D !== 0 ? 1 / D : 0;
  const m0 = e * D;
  const m1 = -b * D;
  const m3 = -d * D;
  const m4 = a * D;
  const m2 = -m0 * c - m1 * f;
  const m5 = -m3 * c - m4 * f;

  const { width: sw, height: sh, data: s } = img;
  const out = new Uint8Array(dw * dh * 3);
  const adelta = new Int32Array(dw);
  const bdelta = new Int32Array(dw);
  for (let x = 0; x < dw; x += 1) {
    adelta[x] = cvRound(m0 * x * AB_SCALE);
    bdelta[x] = cvRound(m3 * x * AB_SCALE);
  }
  const px = (x, y, ch) => (x >= 0 && y >= 0 && x < sw && y < sh ? s[(y * sw + x) * 3 + ch] : 0);

  for (let y = 0; y < dh; y += 1) {
    const X0 = cvRound((m1 * y + m2) * AB_SCALE) + ROUND_DELTA;
    const Y0 = cvRound((m4 * y + m5) * AB_SCALE) + ROUND_DELTA;
    for (let x = 0; x < dw; x += 1) {
      const X = (X0 + adelta[x]) >> (AB_BITS - INTER_BITS);
      const Y = (Y0 + bdelta[x]) >> (AB_BITS - INTER_BITS);
      const sx = X >> INTER_BITS;
      const sy = Y >> INTER_BITS;
      const fx = X & (TAB - 1);
      const fy = Y & (TAB - 1);
      const o = (y * dw + x) * 3;
      if (sx >= sw || sx + 1 < 0 || sy >= sh || sy + 1 < 0) continue; // fully outside: 0
      // Weights are exact integers: (32-f)*(32-g)*32 sums to 1 << 15.
      const w00 = (TAB - fx) * (TAB - fy) * 32;
      const w01 = fx * (TAB - fy) * 32;
      const w10 = (TAB - fx) * fy * 32;
      const w11 = fx * fy * 32;
      const inside = sx >= 0 && sy >= 0 && sx + 1 < sw && sy + 1 < sh;
      for (let ch = 0; ch < 3; ch += 1) {
        let v;
        if (inside) {
          const i0 = (sy * sw + sx) * 3 + ch;
          const i1 = i0 + sw * 3;
          v = s[i0] * w00 + s[i0 + 3] * w01 + s[i1] * w10 + s[i1 + 3] * w11;
        } else {
          v = px(sx, sy, ch) * w00 + px(sx + 1, sy, ch) * w01
            + px(sx, sy + 1, ch) * w10 + px(sx + 1, sy + 1, ch) * w11;
        }
        out[o + ch] = clamp8((v + (1 << (COEF_BITS - 1))) >> COEF_BITS);
      }
    }
  }
  return { width: dw, height: dh, data: out };
}
