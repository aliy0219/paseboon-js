/**
 * Camera access for the main process.
 *
 * Each capture opens a hidden, sandboxed BrowserWindow (renderer/camera.html)
 * that calls getUserMedia and pulls frames with MediaStreamTrackProcessor (no
 * <video> element, so window visibility does not matter). Each frame's RGBA
 * pixels go to this process over IPC, one at a time (the renderer waits for
 * our answer before reading the next frame), and are analysed in memory. When
 * the capture ends the window is destroyed, which also stops the camera.
 *
 * Only one capture runs at a time (watcher checks, enrolment, "Test camera"
 * and intruder photos share this queue), so the camera is never held twice.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserWindow, ipcMain, systemPreferences } from 'electron';

import { createExclusiveQueue } from '../core/queue.js';
import { rgbaToBgr } from '../vision/image.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(HERE, '..', 'preload', 'camera-preload.cjs');
const PAGE = path.join(HERE, '..', 'renderer', 'camera.html');
const WARMUP_FRAMES = 5; // first frames are dark while auto-exposure settles
const MAX_W = 1920;
const MAX_H = 1080;

const enqueue = createExclusiveQueue();
const active = new Map(); // webContents id -> capture session
let installed = false;

export const cameraWindowIds = new Set(); // read by the permission handlers in main.js

function installIpc() {
  if (installed) return;
  installed = true;
  ipcMain.handle('camera:frame', async (event, frame) => {
    const cap = active.get(event.sender.id);
    if (!cap) return { more: false };
    return cap.onFrame(frame);
  });
  ipcMain.on('camera:done', (event, error) => {
    const cap = active.get(event.sender.id);
    if (cap) cap.finish(typeof error === 'string' ? error : null);
  });
}

/** Ask macOS for camera permission when needed. Resolves to an error string or null. */
export async function ensureCameraPermission() {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return null;
  const status = systemPreferences.getMediaAccessStatus('camera');
  if (status === 'granted') return null;
  if (status === 'not-determined' && process.platform === 'darwin') {
    const ok = await systemPreferences.askForMediaAccess('camera');
    return ok ? null : 'camera permission denied';
  }
  return `camera permission ${status}`;
}

/**
 * Run one capture. `handleFrame(bgrImage)` resolves true to stop early.
 * Resolves to { frames, error } once the camera is closed.
 */
export function capture({ seconds, deviceId = '', handleFrame, warmup = WARMUP_FRAMES, queueWaitSeconds = Infinity }) {
  return enqueue(() => captureNow({ seconds, deviceId, handleFrame, warmup }), {
    waitMs: queueWaitSeconds * 1000,
    busyValue: { frames: 0, error: 'camera busy' },
  });
}

async function captureNow({ seconds, deviceId, handleFrame, warmup }) {
  installIpc();
  const permissionError = await ensureCameraPermission();
  if (permissionError) return { frames: 0, error: permissionError };

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      webPreferences: {
        preload: PRELOAD,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false, // hidden window must keep running timers
        spellcheck: false,
      },
    });
    const id = win.webContents.id;
    cameraWindowIds.add(id);
    let frames = 0;
    let done = false;
    let busy = false;
    let deadline = null; // starts at the first analysed frame (after camera start-up + warm-up), like Python
    // Hard stop: renderer stuck or permission prompt never answered.
    const timer = setTimeout(() => cap.finish('camera timed out'), (seconds + 10) * 1000);

    const cap = {
      async onFrame(frame) {
        if (done || busy) return { more: false };
        if (!frame || !Number.isInteger(frame.width) || !Number.isInteger(frame.height)
          || frame.width < 1 || frame.height < 1 || frame.width > MAX_W || frame.height > MAX_H
          || !(frame.data instanceof Uint8Array || frame.data instanceof Uint8ClampedArray)
          || frame.data.length !== frame.width * frame.height * 4) {
          return { more: false };
        }
        busy = true;
        deadline ??= Date.now() + seconds * 1000;
        try {
          frames += 1;
          const stop = await handleFrame(rgbaToBgr(frame.data, frame.width, frame.height));
          return { more: !stop && Date.now() < deadline };
        } finally {
          busy = false;
        }
      },
      finish(error) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        active.delete(id);
        cameraWindowIds.delete(id);
        if (!win.isDestroyed()) win.destroy(); // closes the page, which stops the camera
        resolve({ frames, error: error || null });
      },
    };
    active.set(id, cap);
    win.on('closed', () => cap.finish(frames ? null : 'camera window closed'));
    win.webContents.on('render-process-gone', () => cap.finish('camera renderer crashed'));
    win.loadFile(PAGE, {
      query: { seconds: String(seconds), warmup: String(warmup), deviceId, maxW: String(MAX_W), maxH: String(MAX_H) },
    }).catch((err) => cap.finish(`camera page failed: ${err.message}`));
  });
}
