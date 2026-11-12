/**
 * Paseboon JS — Electron main process.
 *
 * Tray/menu-bar app + settings window around the same watcher as the Python
 * paseboon: input idle -> short camera check -> OS lock, plus "is it you?"
 * checks while someone types.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BrowserWindow, Menu, Notification, Tray, app, dialog, ipcMain, net, powerMonitor, shell,
} from 'electron';

import { Agent, summarize } from '../core/agent.js';
import { AuthGate } from '../core/authgate.js';
import { createLogger } from '../core/logger.js';
import { LEGACY_DIR_NAME, migrateLegacy } from '../core/migrate.js';
import { Policy, Result, makeSettings } from '../core/policy.js';
import {
  SETTINGS_DEFAULTS, TemplateError, loadSettings, loadTemplates, saveSettings, saveTemplates, writePrivate,
} from '../core/storage.js';
import { createAuthenticator, helperPath } from '../platform/auth.js';
import { createPlatform } from '../platform/index.js';
import { deviceIds, deviceKey, deviceLabel, enumerateDevices } from '../usb/devices.js';
import { IntruderResponse, UsbGuard, UsbMonitor } from '../usb/guard.js';
import * as photos from '../usb/photos.js';
import {
  MAX_EVENTS, TrustedCache, clearEvents, loadEvents, loadTrusted, recordEvent, trust, untrust,
} from '../usb/trusted.js';
import { CheckSession, FaceEngine } from '../vision/engine.js';
import { bestMatch } from '../vision/sface.js';
import { cameraWindowIds, capture } from './camera.js';
import { trayIcon } from './icon.js';
import { protectRoutes } from './protect.js';
import { installSecurity } from './security.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SMOKE = process.env.PASEBOON_SMOKE === '1';
const CHECK_SECONDS = 3;
const ENROLL_SECONDS = 45;
const ENROLL_SAMPLES = 15;
const ENROLL_GAP_MS = 400;

// Own identity: never shares files or login items with the Python Paseboon.
app.setName('Paseboon JS');
// PASEBOON_JS_HOME relocates all app data (used by smoke tests and CI).
const HOME_DIR = process.env.PASEBOON_JS_HOME || path.join(app.getPath('appData'), 'paseboon-js');
// Renamed from "Away Lock JS": copy settings/templates/trusted list/photos once.
const MIGRATED = process.env.PASEBOON_JS_HOME
  ? [] : migrateLegacy(HOME_DIR, path.join(app.getPath('appData'), LEGACY_DIR_NAME));
app.setPath('userData', HOME_DIR);
app.setPath('sessionData', HOME_DIR);
app.setPath('crashDumps', path.join(HOME_DIR, 'crashes'));
app.enableSandbox();

const USER = app.getPath('userData');
const SETTINGS_FILE = path.join(USER, 'settings.json');
const TEMPLATES_FILE = path.join(USER, 'face_templates.json');
const TRUSTED_FILE = path.join(USER, 'trusted_usb.json');
const EVENTS_FILE = path.join(USER, 'usb_events.json');
const PHOTOS_DIR = path.join(USER, 'intruder_photos');
const AUTH_FILE = path.join(USER, 'auth_state.json');
const log = createLogger(path.join(USER, 'logs', 'agent.log'), { echo: !app.isPackaged || SMOKE });
if (MIGRATED.length) log.info(`copied data from the old Away Lock JS folder: ${MIGRATED.join(', ')}`);
const authHelperPath = () => helperPath({
  packaged: app.isPackaged, resourcesPath: process.resourcesPath, appRoot: path.join(HERE, '..', '..'),
});
const modelsDir = () => (app.isPackaged
  ? path.join(process.resourcesPath, 'models')
  : path.join(HERE, '..', '..', 'models'));

const state = {
  settings: { ...SETTINGS_DEFAULTS },
  warnings: [],
  templates: null,
  engine: null,
  platform: null,
  agent: null,
  eventLocked: null, // powerMonitor lock-screen/unlock-screen (darwin, win32)
  busy: '',
  lastCheck: null,
  pythonAppFound: false,
  lockPlatform: null, // platform with FFI + powerMonitor lock state
  usb: { monitor: null, response: null, photoCount: 0, lastEvent: null },
};
let tray = null;
let settingsWin = null;
let authenticator = null;
let gate = null;

// ── helpers ──────────────────────────────────────────────────────────────
function policyPart(s) {
  const { matchThreshold, detectionScore, cameraDeviceId, usbGuard, usbPhoto, ...rest } = s;
  return rest;
}

function notify(text) {
  if (Notification.isSupported()) new Notification({ title: 'Paseboon JS', body: text, silent: true }).show();
}

function pythonPaseboonInstalled() {
  const home = os.homedir();
  const candidates = {
    darwin: [path.join(home, 'Library', 'LaunchAgents', 'local.paseboon.plist')],
    linux: [path.join(home, '.config', 'systemd', 'user', 'paseboon.service')],
  }[process.platform] ?? [];
  return candidates.some((p) => existsSync(p));
}

function statusText() {
  if (state.busy) return state.busy;
  if (!state.engine) return 'Starting…';
  if (!state.templates) return 'Not watching: enroll your face first';
  if (state.agent?.paused) return 'Paused';
  const last = state.lastCheck;
  const tail = last ? ` · last: ${last.result}${last.bestMatch != null ? ` ${last.bestMatch.toFixed(2)}` : ''}` : '';
  return `Watching (${state.settings.mode})${tail}`;
}

function publicState() {
  return {
    status: statusText(),
    paused: Boolean(state.agent?.paused),
    settings: state.settings,
    defaults: SETTINGS_DEFAULTS,
    warnings: state.warnings,
    enrolled: state.templates ? state.templates.length : 0,
    lastCheck: state.lastCheck,
    loginItem: loginItemEnabled(),
    platform: process.platform,
    pythonAppFound: state.pythonAppFound,
    logFile: log.file,
    auth: gate ? gate.view() : null,
    usb: {
      running: Boolean(state.usb.monitor?.running),
      photoCount: state.usb.photoCount,
      timing: photos.PHOTO_TIMING,
    },
  };
}

function broadcast() {
  refreshTray();
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('state', publicState());
}

// ── watcher ──────────────────────────────────────────────────────────────
async function runCheck() {
  const session = new CheckSession(state.engine);
  const { error } = await capture({
    seconds: CHECK_SECONDS,
    deviceId: state.settings.cameraDeviceId,
    handleFrame: (img) => session.addFrame(img),
  });
  const outcome = session.finish(error);
  state.lastCheck = { result: outcome.result, bestMatch: outcome.bestMatch, at: Date.now() };
  queueMicrotask(broadcast);
  return outcome;
}

function applySettings(s) {
  state.settings = s;
  if (state.engine) {
    state.engine.matchThreshold = s.matchThreshold;
    state.engine.detectionScore = s.detectionScore;
  }
  if (state.agent) state.agent.policy = new Policy(makeSettings(policyPart(s)));
}

async function reloadTemplates() {
  try {
    state.templates = await loadTemplates(TEMPLATES_FILE);
  } catch (err) {
    state.templates = null;
    if (!(err instanceof TemplateError)) throw err;
    if (!/no face templates/.test(err.message)) state.warnings.push(err.message);
  }
  if (state.engine) state.engine.templates = state.templates;
  if (state.agent) state.agent.paused = state.agent.paused || !state.templates;
}

async function startAgent() {
  const base = state.platform;
  // Lock state: FFI first, powerMonitor events as a second signal where FFI can't tell.
  const platform = { ...base, isLocked: async () => (await base.isLocked()) ?? state.eventLocked };
  state.lockPlatform = platform;
  state.agent = new Agent(platform, new Policy(makeSettings(policyPart(state.settings))), runCheck, { log });
  state.agent.paused = !state.templates || state.pythonAppFound;
  state.agent.run().catch((err) => {
    log.error(`watcher stopped: ${err.message}`);
    notify('Paseboon JS stopped watching after repeated errors. See its log.');
    state.warnings.push(`Watcher stopped after repeated errors: ${err.message}`);
    broadcast();
  });
}

// ── settings protection (OS login) ──────────────────────────────────────
const authStore = {
  load() {
    let text;
    try {
      text = readFileSync(AUTH_FILE, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    return JSON.parse(text);
  },
  save: (s) => writePrivate(AUTH_FILE, JSON.stringify(s)),
};

function authMessage(r) {
  if (r.reason === 'delay') return `Try again in ${r.retryIn} s.`;
  if (r.reason === 'failed' && r.lock) return 'Too many failed attempts: the screen was locked.';
  if (r.reason === 'failed') return `Authentication failed. Try again in ${r.retryIn} s.`;
  return 'Authentication cancelled.';
}

/** Ensure an unlocked session; on the 3rd failure lock the screen (photo first if enabled). */
async function requireAuth(what) {
  const r = await gate.require();
  if (!r.ok) {
    log.warn(`protected action "${what}" denied: ${r.reason}${r.retryIn ? ` (retry in ${r.retryIn} s)` : ''}`);
    if (r.lock) await authLockout();
  }
  broadcast();
  return r;
}

async function authLockout() {
  const response = new IntruderResponse({
    isLocked: () => state.lockPlatform.isLocked(),
    lock: async () => {
      const result = await state.agent.lock(); // verify + fallback + notify
      state.agent.policy.lockAttempted(performance.now() / 1000);
      return result;
    },
    photo: state.settings.usbPhoto
      ? () => photos.takePhoto({ deviceKeys: ['auth-failed'], dir: PHOTOS_DIR, grab: grabPhotoFrame, log })
      : null,
    notify: () => {},
    log,
  });
  const event = await response.handle([]);
  log.warn(`settings: 3 failed authentications -> lock ${event.lock}${event.photo ? `, photo ${path.basename(event.photo)}` : ''}`);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  await refreshPhotoCount();
  notify('Three failed attempts to open Paseboon JS settings: the screen was locked.');
}

/** Tray actions that change settings run only after authentication. */
async function guarded(what, fn) {
  const r = await requireAuth(what);
  if (r.ok) return fn();
  if (!r.lock && r.reason !== 'cancelled') notify(authMessage(r));
  return null;
}

// ── user actions ─────────────────────────────────────────────────────────
async function confirm(message, detail) {
  const { response } = await dialog.showMessageBox({
    type: 'warning', buttons: ['Cancel', 'Lock now'], defaultId: 0, cancelId: 0, message, detail,
  });
  return response === 1;
}

async function lockNow(reason) {
  if (!(await confirm('Lock the screen now?', reason))) return { cancelled: true };
  const result = await state.agent.lock();
  state.agent.policy.lockAttempted(performance.now() / 1000);
  return {
    result: { true: 'locked and verified', null: 'lock issued, lock state unknown', false: 'FAILED: the screen did not lock' }[String(result)],
  };
}

async function withAgentPaused(label, fn) {
  const wasPaused = state.agent.paused;
  state.agent.paused = true;
  state.busy = label;
  broadcast();
  try {
    return await fn();
  } finally {
    state.busy = '';
    state.agent.paused = wasPaused;
    broadcast();
  }
}

async function enroll({ add = false } = {}) {
  return withAgentPaused('Enrolling…', async () => {
    const got = [];
    let last = 0;
    const send = (msg) => settingsWin?.webContents.send('enroll-progress', msg);
    send({ count: 0, total: ENROLL_SAMPLES, hint: 'Look at the camera and move your head slightly.' });
    const { error } = await capture({
      seconds: ENROLL_SECONDS,
      deviceId: state.settings.cameraDeviceId,
      handleFrame: async (img) => {
        const faces = await state.engine.faces(img);
        if (faces.length !== 1) {
          send({ count: got.length, total: ENROLL_SAMPLES, hint: `Need exactly one face (seeing ${faces.length}).` });
          return false;
        }
        if (performance.now() - last < ENROLL_GAP_MS) return false;
        got.push(await state.engine.embedding(img, faces[0]));
        last = performance.now();
        send({ count: got.length, total: ENROLL_SAMPLES, hint: '' });
        return got.length >= ENROLL_SAMPLES;
      },
    });
    if (error) return { error };
    if (got.length < Math.max(5, ENROLL_SAMPLES / 2)) {
      return { error: `Only ${got.length} usable samples. Try better light and look at the camera.` };
    }
    const unit = got.map((v) => {
      const n = Math.hypot(...v);
      return Float32Array.from(v, (x) => x / n);
    });
    const sims = [];
    for (let i = 0; i < unit.length; i += 1) {
      for (let j = i + 1; j < unit.length; j += 1) sims.push(bestMatch([unit[i]], unit[j]));
    }
    sims.sort((a, b) => a - b);
    const all = add && state.templates ? [...state.templates, ...unit] : unit;
    const count = await saveTemplates(TEMPLATES_FILE, all);
    await reloadTemplates();
    log.info(`enrolled ${unit.length} samples (total ${count}); self-similarity min ${sims[0].toFixed(3)} `
      + `median ${sims[Math.floor(sims.length / 2)].toFixed(3)}`);
    return {
      count,
      minSimilarity: sims[0],
      medianSimilarity: sims[Math.floor(sims.length / 2)],
      threshold: state.settings.matchThreshold,
    };
  });
}

async function testCamera() {
  if (!state.templates) return { error: 'Enroll your face first.' };
  return withAgentPaused('Testing camera…', async () => {
    const outcome = await runCheck();
    const present = outcome.result === Result.OWNER
      || (outcome.result === Result.STRANGER && state.settings.mode === 'presence');
    log.info(`test camera ${summarize(outcome)}`);
    return { summary: summarize(outcome), verdict: present ? 'PRESENT' : 'AWAY', mode: state.settings.mode };
  });
}

// ── USB guard + intruder photos ──────────────────────────────────────────
function usbStatusText() {
  if (!state.settings.usbGuard) return 'USB guard: off';
  if (!state.usb.monitor?.running) return 'USB guard: on (not running)';
  const photosText = state.settings.usbPhoto ? ` · photos on (${state.usb.photoCount})` : '';
  return `USB guard: on · ${loadTrusted(TRUSTED_FILE).devices.size} trusted${photosText}`;
}

async function refreshPhotoCount() {
  state.usb.photoCount = (await photos.listPhotos(PHOTOS_DIR)).length;
}

/** One frame from the shared camera queue, waiting briefly for an in-flight check. */
async function grabPhotoFrame() {
  const beforeLock = photos.PHOTO_TIMING === 'before_lock';
  const watch = new photos.ExposureWatch(); // wait for auto-exposure; the first frames are black
  const { error } = await capture({
    seconds: photos.SETTLE_SECONDS,
    warmup: 0,
    queueWaitSeconds: beforeLock ? photos.PRE_LOCK_CAMERA_WAIT : photos.CAMERA_WAIT_SECONDS,
    deviceId: state.settings.cameraDeviceId,
    handleFrame: async (img) => watch.offer(img),
  });
  if (!watch.frame) throw new Error(error || 'camera returned no frames');
  log.info(`intruder photo exposure: brightness ${Math.round(watch.mean)}/255 after ${watch.frames} frame(s)`
    + `${watch.settled ? '' : ' (not settled)'}`);
  return watch.frame;
}

function takeIntruderPhoto(devices) {
  return photos.takePhoto({ deviceKeys: devices.map(deviceKey), dir: PHOTOS_DIR, grab: grabPhotoFrame, log });
}

function applyUsb() {
  const want = state.settings.usbGuard && !state.pythonAppFound;
  if (state.usb.response) state.usb.response.photo = state.settings.usbPhoto ? takeIntruderPhoto : null;
  if (want && !state.usb.monitor) {
    const response = new IntruderResponse({
      isLocked: () => state.lockPlatform.isLocked(),
      lock: async () => {
        const result = await state.agent.lock(); // verify + fallback + notify
        state.agent.policy.lockAttempted(performance.now() / 1000);
        return result;
      },
      photo: state.settings.usbPhoto ? takeIntruderPhoto : null,
      notify,
      record: (event) => recordEvent(EVENTS_FILE, event),
      onEvent: async (event) => {
        state.usb.lastEvent = event;
        await refreshPhotoCount();
        broadcast();
      },
      log,
    });
    const cache = new TrustedCache(TRUSTED_FILE);
    const guard = new UsbGuard(enumerateDevices, () => cache.get(), (d) => response.handle(d), notify, log);
    state.usb.response = response;
    state.usb.monitor = new UsbMonitor(guard, { log });
    state.usb.monitor.start();
    log.info(`USB guard started (photo ${state.settings.usbPhoto ? `on, ${photos.PHOTO_TIMING}` : 'off'})`);
  } else if (!want && state.usb.monitor) {
    const monitor = state.usb.monitor;
    state.usb.monitor = null;
    state.usb.response = null;
    monitor.stop().catch(() => {});
    log.info('USB guard stopped');
  }
  if (state.settings.usbGuard && state.pythonAppFound) {
    const w = 'USB guard not started: the Python Paseboon is installed (only one guard may run).';
    if (!state.warnings.includes(w)) state.warnings.push(w);
  }
}

const deviceView = (d, trusted) => ({
  key: deviceKey(d), label: deviceLabel(d), name: d.name || 'Unknown USB device', ids: deviceIds(d),
  serial: Boolean(d.serial), trusted: trusted.isTrusted(d),
});

async function usbState() {
  const trusted = loadTrusted(TRUSTED_FILE);
  let connected = [];
  let connectedError = null;
  try {
    connected = (await enumerateDevices()).map((d) => deviceView(d, trusted));
  } catch (err) {
    connectedError = err.message;
  }
  await refreshPhotoCount();
  return {
    enabled: state.settings.usbGuard,
    running: Boolean(state.usb.monitor?.running),
    photo: state.settings.usbPhoto,
    timing: photos.PHOTO_TIMING,
    warning: trusted.warning,
    trusted: trusted.sorted().map((d) => deviceView(d, trusted)),
    connected,
    connectedError,
    eventsMax: MAX_EVENTS,
    events: loadEvents(EVENTS_FILE).reverse().map((e) => ({
      time: e.time, lock: e.lock, photo: e.photo ? path.basename(e.photo) : null,
      devices: e.devices.map((d) => deviceView(d, trusted)),
    })),
    photoCount: state.usb.photoCount,
    photosDir: PHOTOS_DIR,
  };
}

async function trustConnected() {
  const devices = await enumerateDevices();
  await trust(TRUSTED_FILE, devices);
  log.info(`trusted ${devices.length} connected USB device(s)`);
  broadcast();
  return usbState();
}

async function trustKey(key) {
  if (typeof key !== 'string' || key.length > 300) return { error: 'bad device' };
  const fromEvents = loadEvents(EVENTS_FILE).flatMap((e) => e.devices);
  let connected = [];
  try { connected = await enumerateDevices(); } catch { /* use events only */ }
  const device = [...connected, ...fromEvents].find((d) => deviceKey(d) === key);
  if (!device) return { error: 'That device is no longer known.' };
  await trust(TRUSTED_FILE, [device]);
  log.info(`trusted USB device ${deviceLabel(device)} [${key}]`);
  broadcast();
  return usbState();
}

async function untrustKey(key) {
  if (typeof key !== 'string') return { error: 'bad device' };
  await untrust(TRUSTED_FILE, key);
  log.info(`removed USB device [${key}] from the trusted list`);
  broadcast();
  return usbState();
}

async function deleteAllPhotos() {
  const count = (await photos.listPhotos(PHOTOS_DIR)).length;
  if (!count) return { deleted: 0 };
  const { response } = await dialog.showMessageBox({
    type: 'warning', buttons: ['Cancel', 'Delete all'], defaultId: 0, cancelId: 0,
    message: `Delete all ${count} intruder photos?`, detail: 'This cannot be undone.',
  });
  if (response !== 1) return { cancelled: true };
  const deleted = await photos.deleteAll(PHOTOS_DIR);
  log.info(`deleted ${deleted} intruder photos`);
  await refreshPhotoCount();
  broadcast();
  return { deleted };
}

async function openPhotosFolder() {
  await photos.ensurePhotoDir(PHOTOS_DIR);
  const error = await shell.openPath(PHOTOS_DIR);
  return error ? { error } : { ok: true };
}

// ── login item ───────────────────────────────────────────────────────────
const autostartFile = () => path.join(os.homedir(), '.config', 'autostart', 'paseboon-js.desktop');

function loginItemEnabled() {
  if (process.platform === 'linux') return existsSync(autostartFile());
  return app.getLoginItemSettings().openAtLogin;
}

async function setLoginItem(enabled) {
  if (enabled && state.pythonAppFound) {
    return { error: 'The Python Paseboon is installed. Uninstall it first so only one watcher runs.' };
  }
  if (process.platform === 'linux') {
    if (enabled) {
      const exec = process.env.APPIMAGE || process.execPath;
      await mkdir(path.dirname(autostartFile()), { recursive: true });
      await writeFile(autostartFile(), [
        '[Desktop Entry]', 'Type=Application', 'Name=Paseboon JS',
        `Exec="${exec.replace(/"/g, '\\"')}"`, 'X-GNOME-Autostart-enabled=true', '',
      ].join('\n'), { mode: 0o644 });
    } else {
      await rm(autostartFile(), { force: true });
    }
  } else {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
  }
  broadcast();
  return { enabled: loginItemEnabled() };
}

// ── UI ───────────────────────────────────────────────────────────────────
function refreshTray() {
  if (!tray) return;
  const paused = Boolean(state.agent?.paused);
  tray.setImage(trayIcon({ paused }));
  tray.setToolTip(`Paseboon JS — ${statusText()}`);
  const canWatch = Boolean(state.templates) && !state.busy;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: statusText(), enabled: false },
    ...(state.warnings.length ? [{ label: `⚠ ${state.warnings.at(-1).slice(0, 70)}`, enabled: false }] : []),
    { label: usbStatusText(), enabled: false },
    { type: 'separator' },
    {
      label: paused ? 'Resume watching' : 'Pause watching',
      enabled: canWatch,
      click: () => guarded('pause', () => setPaused(!paused)),
    },
    { label: 'Lock now…', enabled: Boolean(state.agent), click: () => lockNow('Requested from the menu.') },
    { label: 'Settings…', click: () => openSettingsGuarded() },
    { type: 'separator' },
    { label: 'Quit Paseboon JS', click: () => guarded('quit', () => app.quit()) },
  ]));
}

async function setPaused(paused) {
  if (!paused && !state.templates) return { error: 'Enroll your face first.' };
  if (!paused && state.pythonAppFound) {
    const { response } = await dialog.showMessageBox({
      type: 'warning', buttons: ['Cancel', 'Watch anyway'], defaultId: 0, cancelId: 0,
      message: 'The Python Paseboon is also installed.',
      detail: 'Two watchers would both use the camera and both lock the screen. Uninstall one of them.',
    });
    if (response !== 1) return { paused: true };
  }
  state.agent.paused = paused;
  log.info(paused ? 'paused by user' : 'resumed by user');
  broadcast();
  return { paused };
}

/** Opening Settings needs the OS login (an already open window is just shown). */
async function openSettingsGuarded() {
  if (settingsWin && !settingsWin.isDestroyed()) return openSettings();
  const r = await requireAuth('open-settings');
  if (r.ok) return openSettings();
  if (!r.lock && r.reason !== 'cancelled') notify(authMessage(r));
  return null;
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 720,
    title: 'Paseboon JS',
    show: false,
    resizable: true,
    webPreferences: {
      preload: path.join(HERE, '..', 'preload', 'settings-preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  settingsWin.removeMenu();
  settingsWin.once('ready-to-show', () => {
    settingsWin.show();
    if (process.platform === 'darwin') app.focus({ steal: true }); // menu-bar apps start in the background
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
    gate?.endSession(); // the next protected action prompts again
    refreshTray();
  });
  settingsWin.loadFile(path.join(HERE, '..', 'renderer', 'settings.html'));
}

function installIpc() {
  const fromSettings = (event) => settingsWin && event.sender === settingsWin.webContents;
  const handle = (channel, fn) => ipcMain.handle(channel, async (event, arg) => {
    if (!fromSettings(event)) throw new Error('not allowed');
    try {
      return await fn(arg);
    } catch (err) {
      return { error: err.message };
    }
  });
  const routes = {
    'get-state': () => publicState(),
    'usb-state': () => usbState(),
    'auth-unlock': async () => {
      const r = await requireAuth('unlock-settings');
      return r.ok ? { ok: true, unprotected: r.unprotected ?? null } : { authRequired: true, ...r };
    },
    'auth-touch': () => { gate.touch(); return { ok: true }; },
  };
  routes['save-settings'] = async (partial) => {
    if (!partial || typeof partial !== 'object') return { error: 'bad settings' };
    const saved = await saveSettings(SETTINGS_FILE, { ...state.settings, ...partial });
    state.warnings = state.warnings.filter((w) => !w.startsWith('Settings file') && !w.startsWith('Could not read settings'));
    applySettings(saved);
    applyUsb();
    log.info(`settings saved: ${JSON.stringify(policyPart(saved))} usbGuard=${saved.usbGuard} usbPhoto=${saved.usbPhoto}`);
    broadcast();
    return { ok: true };
  };
  Object.assign(routes, {
    enroll: (opts) => enroll({ add: Boolean(opts?.add) }),
    'test-camera': () => testCamera(),
    'test-lock': () => lockNow('Test: the watcher will verify the lock and fall back if needed.'),
    'set-login-item': (enabled) => setLoginItem(Boolean(enabled)),
    'set-paused': (paused) => setPaused(Boolean(paused)),
    'usb-trust-connected': () => trustConnected(),
    'usb-trust': (key) => trustKey(key),
    'usb-untrust': (key) => untrustKey(key),
    'usb-clear-events': async () => { await clearEvents(EVENTS_FILE); return usbState(); },
    'photos-delete-all': () => deleteAllPhotos(),
    'photos-open-folder': () => openPhotosFolder(),
  });
  for (const [channel, fn] of Object.entries(protectRoutes(routes, { requireAuth }))) handle(channel, fn);
}

// ── smoke mode: load everything, open nothing, exit ──────────────────────
async function smoke() {
  const report = { packaged: app.isPackaged, platform: process.platform, arch: process.arch };
  try {
    await net.fetch('https://example.com/');
    report.networkBlocked = false;
  } catch (err) {
    report.networkBlocked = true;
    report.networkError = String(err.message).slice(0, 80);
  }
  // Which frame APIs the sandboxed renderer offers (no camera is opened).
  const probe = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  // A file:// page of this app (secure context, like camera.html) without its
  // preload; its own script fails harmlessly. Nothing calls getUserMedia.
  await probe.loadFile(path.join(HERE, '..', 'renderer', 'settings.html')).catch(() => {});
  report.rendererApis = await probe.webContents.executeJavaScript(
    '({ secure: window.isSecureContext, mstp: typeof MediaStreamTrackProcessor, '
    + 'offscreenCanvas: typeof OffscreenCanvas, getUserMedia: typeof navigator.mediaDevices?.getUserMedia })',
  );
  probe.destroy();
  const blank = { width: 640, height: 480, data: new Uint8Array(640 * 480 * 3) };
  report.facesOnBlank = (await state.engine.detectAll(blank)).length;
  report.idleSeconds = await state.platform.idleSeconds();
  report.isLocked = await state.platform.isLocked();
  report.settingsWarning = state.warnings[0] ?? null;
  try {
    report.usbDevices = (await enumerateDevices()).length; // read-only
  } catch (err) {
    report.usbError = err.message;
  }
  // Intruder-photo encoder on a synthetic black frame, in memory only (no camera, no file).
  report.jpegBytes = (await photos.encodeJpeg({ width: 64, height: 48, data: new Uint8Array(64 * 48 * 3) })).length;
  report.modelsDir = modelsDir();
  report.authHelper = authenticator.name;
  report.authHelperPresent = process.platform !== 'darwin' || existsSync(authHelperPath());
  report.authCheck = await authenticator.check(); // never prompts
  console.log(`SMOKE ${JSON.stringify(report)}`);
  app.exit(report.networkBlocked && report.facesOnBlank === 0 && report.jpegBytes > 0 && report.authHelperPresent ? 0 : 1);
}

// ── startup ──────────────────────────────────────────────────────────────
if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openSettingsGuarded());
  app.on('window-all-closed', () => { /* keep running in the tray */ });

  app.whenReady().then(async () => {
    const security = installSecurity({
      appRoot: app.getAppPath(), isCameraWindow: (id) => cameraWindowIds.has(id), log,
    });
    if (process.platform === 'darwin' && !SMOKE) app.dock?.hide();
    // No app menu with Quit/Cmd+Q: quitting goes through the tray (protected).
    // OS shutdown/logout still quits: nothing ever blocks before-quit.
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: app.name, submenu: [{ role: 'hide' }] }, { role: 'editMenu' }, { role: 'windowMenu' },
      ]));
    }
    authenticator = createAuthenticator({ helper: authHelperPath() });
    gate = new AuthGate({ authenticate: () => authenticator.authenticate(), store: authStore, log }).load();
    if (gate.warning) state.warnings.push(gate.warning);

    const loaded = await loadSettings(SETTINGS_FILE);
    state.settings = loaded.settings;
    if (loaded.warning) {
      state.warnings.push(loaded.warning);
      log.warn(loaded.warning);
    }
    state.pythonAppFound = pythonPaseboonInstalled();
    if (state.pythonAppFound) state.warnings.push('The Python Paseboon is installed: starting paused so only one watcher runs.');

    try {
      state.engine = await FaceEngine.create(modelsDir(), {
        matchThreshold: state.settings.matchThreshold, detectionScore: state.settings.detectionScore,
      });
    } catch (err) {
      log.error(`face models failed to load: ${err.message}`);
      if (SMOKE) {
        console.log(`SMOKE_FAIL ${err.message}`);
        app.exit(1);
        return;
      }
      dialog.showErrorBox('Paseboon JS', `Face models failed verification:\n${err.message}`);
      app.quit();
      return;
    }
    state.platform = await createPlatform({
      idleSeconds: () => powerMonitor.getSystemIdleTime(), notify, log,
    });
    powerMonitor.on('lock-screen', () => { state.eventLocked = true; });
    powerMonitor.on('unlock-screen', () => { state.eventLocked = false; });
    await reloadTemplates();

    if (SMOKE) {
      await smoke();
      return;
    }
    log.info(`starting: platform=${process.platform} mode=${state.settings.mode} `
      + `templates=${state.templates?.length ?? 0} blocked_so_far=${security.blockedCount()}`);
    installIpc();
    await startAgent();
    await refreshPhotoCount();
    applyUsb();
    tray = new Tray(trayIcon({ paused: state.agent.paused }));
    refreshTray();
    if (!state.templates) openSettingsGuarded();
    else if (state.warnings.length) notify(`Paseboon JS needs attention: ${state.warnings.at(-1)}`);
    // An open Settings window re-locks after SESSION_IDLE_SECONDS without interaction.
    let wasUnlocked = false;
    setInterval(() => {
      const now = gate.unlocked;
      if (now !== wasUnlocked) broadcast();
      wasUnlocked = now;
    }, 5000).unref?.();
  });
}
