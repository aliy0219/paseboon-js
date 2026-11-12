/**
 * In-memory ONNX shape relaxation for the YuNet model.
 *
 * The pinned YuNet ONNX declares a fixed 1x3x640x640 input. cv::dnn ignores
 * that and runs at any (32-aligned) size; onnxruntime enforces it. The graph
 * itself is size-agnostic (every Reshape uses -1, both Resizes use scale
 * factors), so we remove the declared shapes from the graph input/outputs and
 * drop the cached intermediate shapes (value_info). Weights and nodes are
 * copied byte-for-byte.
 *
 * Runs only on bytes whose SHA-256 was already verified against the pin, and
 * the result is checked against PATCHED_SHA256 so a bug here cannot load an
 * unexpected graph.
 */

// ── tiny protobuf wire-format reader/writer ──────────────────────────────
function readVarint(buf, p) {
  let result = 0n;
  let shift = 0n;
  let b;
  do {
    if (p >= buf.length) throw new Error('truncated varint');
    b = buf[p++];
    result |= BigInt(b & 0x7f) << shift;
    shift += 7n;
  } while (b & 0x80);
  return [result, p];
}

function encodeVarint(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return Buffer.from(out);
}

/** Yields { fn, wt, start, bodyStart, end } for each field of a message. */
function* fields(buf, start = 0, end = buf.length) {
  let p = start;
  while (p < end) {
    const fieldStart = p;
    let key;
    [key, p] = readVarint(buf, p);
    const fn = Number(key >> 3n);
    const wt = Number(key & 7n);
    let bodyStart = p;
    if (wt === 0) [, p] = readVarint(buf, p);
    else if (wt === 1) p += 8;
    else if (wt === 5) p += 4;
    else if (wt === 2) {
      let len;
      [len, p] = readVarint(buf, p);
      bodyStart = p;
      p += Number(len);
    } else throw new Error(`unsupported wire type ${wt}`);
    if (p > end) throw new Error('field overruns message');
    yield { fn, wt, start: fieldStart, bodyStart, end: p };
  }
}

function lengthDelimited(fn, body) {
  return Buffer.concat([encodeVarint((fn << 3) | 2), encodeVarint(body.length), body]);
}

/** Rebuild a message, replacing or dropping selected fields via `edit(field) -> Buffer|null|undefined`. */
function rewrite(buf, start, end, edit) {
  const parts = [];
  for (const f of fields(buf, start, end)) {
    const replaced = edit(f);
    if (replaced === undefined) parts.push(buf.subarray(f.start, f.end));
    else if (replaced !== null) parts.push(replaced);
  }
  return Buffer.concat(parts);
}

// ONNX field numbers
const MODEL_GRAPH = 7;
const GRAPH_INPUT = 11;
const GRAPH_OUTPUT = 12;
const GRAPH_VALUE_INFO = 13;
const VALUE_INFO_TYPE = 2;
const TYPE_TENSOR = 1;
const TENSOR_SHAPE = 2;

function stripShape(buf, vi) {
  return rewrite(buf, vi.bodyStart, vi.end, (f) => {
    if (f.fn !== VALUE_INFO_TYPE || f.wt !== 2) return undefined;
    const type = rewrite(buf, f.bodyStart, f.end, (t) => {
      if (t.fn !== TYPE_TENSOR || t.wt !== 2) return undefined;
      const tensor = rewrite(buf, t.bodyStart, t.end, (s) => (s.fn === TENSOR_SHAPE ? null : undefined));
      return lengthDelimited(TYPE_TENSOR, tensor);
    });
    return lengthDelimited(VALUE_INFO_TYPE, type);
  });
}

/** Returns a new model buffer with free input/output shapes and no value_info. */
export function relaxShapes(model) {
  const buf = Buffer.from(model);
  let sawGraph = false;
  const out = rewrite(buf, 0, buf.length, (f) => {
    if (f.fn !== MODEL_GRAPH || f.wt !== 2) return undefined;
    sawGraph = true;
    const graph = rewrite(buf, f.bodyStart, f.end, (g) => {
      if (g.fn === GRAPH_VALUE_INFO) return null;
      if ((g.fn === GRAPH_INPUT || g.fn === GRAPH_OUTPUT) && g.wt === 2) {
        return lengthDelimited(g.fn, stripShape(buf, g));
      }
      return undefined;
    });
    return lengthDelimited(MODEL_GRAPH, graph);
  });
  if (!sawGraph) throw new Error('not an ONNX model (no graph)');
  return out;
}
