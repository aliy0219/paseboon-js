// Hidden camera page: open the camera, hand frames to the main process one at a
// time, stop. Pixels are only copied into an in-memory buffer for IPC; they are
// never drawn to a visible surface, encoded, stored or sent anywhere else.

// Frames without rendering anything: MediaStreamTrackProcessor yields
// VideoFrames straight from the track, so window visibility does not matter.
// (Electron 45's sandboxed renderer exposes it on window; the smoke test
// checks that, and ImageCapture is NOT available there.)
async function* frames(track) {
  if (typeof MediaStreamTrackProcessor !== 'function') {
    throw new Error('MediaStreamTrackProcessor is not available in this renderer');
  }
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      try { yield value; } finally { value.close(); }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

(async () => {
  const api = window.paseboonCamera;
  const q = new URLSearchParams(location.search);
  const seconds = Number(q.get('seconds')) || 3;
  const warmup = Number(q.get('warmup')) || 0;
  const deviceId = q.get('deviceId') || '';
  const maxW = Number(q.get('maxW')) || 1920;
  const maxH = Number(q.get('maxH')) || 1080;
  let stream = null;
  let error = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 1280, max: maxW },
        height: { ideal: 720, max: maxH },
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });
    const [track] = stream.getVideoTracks();
    let canvas = null;
    let ctx = null;
    // Safety net only; the main process decides when to stop.
    const deadline = performance.now() + (seconds + 5) * 1000;
    let skipped = 0;
    for await (const frame of frames(track)) {
      if (performance.now() >= deadline) break;
      if (skipped < warmup) {
        skipped += 1;
        continue;
      }
      const w = frame.displayWidth ?? frame.width;
      const h = frame.displayHeight ?? frame.height;
      if (!canvas || canvas.width !== w || canvas.height !== h) {
        canvas = new OffscreenCanvas(w, h);
        ctx = canvas.getContext('2d', { willReadFrequently: true });
      }
      ctx.drawImage(frame, 0, 0);
      const { data } = ctx.getImageData(0, 0, w, h);
      const { more } = await api.frame(w, h, data);
      if (!more) break;
    }
  } catch (err) {
    error = `${err?.name || 'Error'}: ${err?.message || err}`;
  } finally {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    api.done(error);
  }
})();
