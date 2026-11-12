# Paseboon JS

Electron 45 · Node ≥ 22 · version 0.1.0 · see [CHANGELOG.md](CHANGELOG.md) · sister
project: `../../python/paseboon`.

**Features:** face-aware auto-lock (`presence` / `owner` modes) · "is it you?" checks
while typing · tray app with settings · USB guard with a trusted list · opt-in intruder
photo · start at login · builds for macOS, Windows and Linux (via CI).

| | macOS (arm64) | Linux (x64) | Windows (x64) |
|---|---|---|---|
| Build + installer | built locally and in CI | built in CI | built in CI |
| Test suite (123 tests, incl. face parity with Python, cosine 1.00000) | passes locally and in CI | passes in CI | passes in CI |
| Packaged app starts, loads models, blocks network (smoke test) | passes locally and in CI | passes in CI (under xvfb) | passes in CI |
| Camera, face check, real lock, USB plug-in on a real machine | not verified yet | not run | not run |

Installers for every OS are attached to each [GitHub Release](https://github.com/aliy0219/paseboon-js/releases).

**Quick start:** `npm ci && npm run models && npm test && npm start`.

An Electron rewrite of the Python **paseboon**. It locks your computer when you walk
away, and when someone else sits down. It runs as a tray/menu-bar app with a settings
window. App id `local.paseboon-js`, data in its own folder: it shares no files or
login item with the Python app. **Only run one of the two.** If the Python launch
agent or systemd unit is installed, this app starts paused and says why.

```
no keyboard/mouse for 10 s ─► camera on ≤3 s ─► face check ─► OS lock (after 2 empty checks)
someone typing ─► every 120 s: is it you? ─► not you twice ─► OS lock
```

| | presence | owner |
|---|---|---|
| idle: your face | stay unlocked | stay unlocked |
| idle: another face | stay unlocked | lock (2 checks) |
| idle: no face | lock (2 checks) | lock (2 checks) |
| typing: not your face | lock (2 checks) | lock (2 checks) |

Both modes need **Enroll face**. Your face is stored as 128 numbers per sample in
`face_templates.json` (mode 0600), never as a photo.

## USB guard and intruder photo (both off by default)

**USB guard** (Settings → USB guard):
- Every 0.5 s it compares the connected USB devices with the last listing. A
  **newly connected** device that isn't on your trusted list locks the screen at once,
  via the same lock → verify → fallback → notify path as the face watcher.
- Unplugging never locks.
- Devices already connected when the guard starts never lock. They're logged and
  notified once, so a restart with an untrusted device attached can't loop.
- A second identical device without a serial also counts as new.
- The trusted list is `trusted_usb.json`: owner-only (0600), atomic writes.
  - Manage it with *Trust devices connected now*, *Trust* on a connected device,
    *Trust this device* on a recent lock (the device that caused it), and *Remove*.
  - A corrupt file means **nothing is trusted** plus a visible warning. The guard
    keeps running (fails closed).
- If listing fails, you get one notification and it keeps retrying. A device plugged
  in during the failure is still caught.
- **Identity** is vendor ID + product ID + serial (when the device has one), else
  vendor + product. These come from the device itself: **a BadUSB device can fake
  them**, so a stick that copies your trusted keyboard's IDs is not caught.
- **Detection by OS:**
  - macOS: IOKit `IOUSBHostDevice` via koffi
  - Linux: `/sys/bus/usb/devices`, root hubs skipped (untested)
  - Windows: SetupAPI via koffi (untested)
  
  No new npm dependency. The `usb` package was not added: it would be another
  native module for every OS, and polling the OS directly is enough.

**Intruder photo** (needs the USB guard):
- Taken only for untrusted devices. The order is set by one constant,
  `PHOTO_TIMING` in `src/usb/photos.js`:
  - `'after_lock'` (default): lock first, then the photo, so the lock is never delayed.
  - `'before_lock'`: photo first with a 0.3 s camera wait.
  - **Whether the camera still works after the screen locks has to be tested on your Mac.**
- The photo uses the same camera queue as the face checks, so it waits up to 5 s for
  an in-flight check.
- JPEG via Electron's built-in `nativeImage`. Stored only in
  `<userData>/intruder_photos` (folder 0700, files 0600), named
  `YYYYMMDD-HHMMSS-<device id>.jpg`. The newest 50 are kept.
- *Open folder* and *Delete all* (with a confirm) are in Settings. Photos are never
  uploaded: all network is blocked.
- `src/usb/photos.js` is the **only** module allowed to encode or write an image. A
  test enforces this.
- The last 20 USB locks go to `usb_events.json` (owner-only), so you can trust the
  device afterwards.

## Settings protection (OS login)

Changing Paseboon needs **your computer login**: Touch ID or your account password on
macOS. The app never sees or stores the password; the OS checks it.

- **Protected:** opening Settings, Pause/Resume, Quit (tray), Start at login, Enroll, Test
  camera, Test lock, saving settings, every USB trust / remove / trust-connected, clearing the
  USB list, opening and deleting photos. Checked in the **main process**, so a compromised
  settings page cannot skip it.
- **Not protected:** Lock now, the tray status, and OS shutdown/logout (nothing ever blocks a
  system quit). The macOS app menu has no Quit item, so Cmd+Q does not bypass the tray.
- **Session:** one successful login unlocks Settings until the window closes or after 2 minutes
  without interaction; then the window shows "Settings are locked" with an Unlock button.
- **Wrong attempts:** a cancel is not counted. After a failed login you wait 5 s, then 15 s,
  before the next prompt (the window shows the countdown). The **3rd failure locks the screen**,
  taking an intruder photo first if the photo toggle is on. The counter survives restarts
  (`auth_state.json`, owner-only) and resets after the lock or a success.
- **Unavailable** (no Touch ID/password, helper missing, unsupported OS): you are never locked
  out. Settings open, with a red banner "Settings are not protected: <reason>". A crashed or
  timed-out helper denies; only an explicit "unavailable" opens.
- **How:** macOS uses a 60 KB Swift helper (`native/macos/paseboon-auth.swift`,
  LocalAuthentication `deviceOwnerAuthentication`), built by `npm run build:auth` and shipped in
  `Resources/`. Windows uses Windows Hello (`UserConsentVerifier` via PowerShell) and Linux uses
  `pkexec`, which asks for an **admin** password: both **written but untested**.
- **Limit:** someone at your unlocked computer can still kill the app (Activity Monitor) or
  edit its files. This stops quick changes in the app; the screen lock is the real protection.

## Run from source

```bash
npm ci            # exact versions from package-lock.json
npm run models    # download + SHA-256-verify the two face models (build time only)
npm test          # policy/agent spec, parity gate vs Python/OpenCV, security guards
npm start         # tray app; open Settings to enroll
```

Requires Node 22 or newer (developed on 26.13.1).

## Build installers

Native modules (`onnxruntime-node`, `koffi`) ship per-platform binaries, so **build
each OS on that OS**. `.github/workflows/build.yml` does this on macOS, Windows and
Ubuntu runners, then smoke-tests each packaged app.

| OS | command | output |
|---|---|---|
| macOS (Apple silicon) | `npm run dist:mac` | `dist/Paseboon JS-0.1.0-arm64.dmg`, `.zip` |
| Windows x64 | `npm run dist:win` | `dist/Paseboon JS Setup 0.1.0.exe` |
| Linux x64 | `npm run dist:linux` | `dist/Paseboon JS-0.1.0.AppImage`, `paseboon-js_0.1.0_amd64.deb` |

The smoke test loads models and native modules, checks that network requests are
blocked, and exits. It never opens the camera or locks the screen:
`PASEBOON_SMOKE=1 PASEBOON_JS_HOME=/tmp/x "<app binary>"`.

**Intel Macs are not supported.** `onnxruntime-node` 1.31.1 ships no darwin-x64 binary.

**Why not cross-build from a Mac?** It was tried on this Apple-silicon Mac:
- `--win`: packaging ran, then NSIS failed: `spawn makensis: Unknown system error -86`
  (an x86_64 tool, and Rosetta isn't installed).
- `--linux`: AppImage failed with the same error -86. Before the homepage/author
  metadata was added, deb failed on missing metadata.
- In both unpacked outputs, `node_modules/@koromix` held **koffi-darwin-arm64**. npm
  installs only the host's optional native package, so even a "successful" cross-build
  would crash on the target OS.

Use the CI matrix (or build on each OS).

Built and verified locally (macOS 27.2.1, arm64):
- `dist/Paseboon JS-0.1.0-arm64.dmg`: 169 MB, `hdiutil verify` VALID
- `dist/Paseboon JS-0.1.0-arm64-mac.zip`: 165 MB
- The `.app` is 341 MB. Ad-hoc signature, hardened runtime with camera +
  library-validation entitlements, `codesign --verify --deep --strict` OK.
- The packaged smoke test passes: native modules load from `app.asar.unpacked`, models
  verify from `Resources/models`, the network probe is blocked with
  `net::ERR_BLOCKED_BY_CLIENT`, and the renderer exposes `getUserMedia` +
  `MediaStreamTrackProcessor` + `OffscreenCanvas` in a secure context.

## Security and privacy model

- **No network at runtime.** Every request in the app's session is cancelled
  (`webRequest.onBeforeRequest`), except this app's own `file://` pages. Pages also
  carry `default-src 'none'` CSPs. The models are bundled at build time and checked
  against pinned size + SHA-256 on every start. The only network code is the build-time
  `scripts/fetch-models.mjs`.
- **Renderers:** `sandbox`, `contextIsolation`, no `nodeIntegration`, `app.enableSandbox()`.
  Small `contextBridge` preloads. `window.open`, navigation and `<webview>` are denied.
- **Permissions:** only "media / video" is granted, and only to the hidden camera
  window. Everything else is denied. On macOS the OS camera prompt names *Paseboon JS*.
- **Frames:** a hidden sandboxed window (`backgroundThrottling: false`) reads frames
  with `MediaStreamTrackProcessor`. That needs no `<video>` element, so window
  visibility doesn't matter. `ImageCapture` isn't available in Electron 45's renderer.
  The window passes the raw pixels to the main process over IPC, one at a time. They are
  analysed in memory and dropped. A test fails the build if code that writes, encodes
  or exports images appears.
- **Locking:**
  - macOS: `SACLockScreenImmediate` (private `login.framework`, via koffi), verified
    with `CGSSessionScreenIsLocked`, with a `pmset displaysleepnow` fallback.
  - Windows: `LockWorkStation`.
  - Linux: `loginctl lock-session <id>`.
  
  Every lock is verified. If it doesn't stick, the fallback fires once, then a
  notification appears. It never retries in a loop.

## Face pipeline (parity with the Python app)

OpenCV.js has no `FaceRecognizerSF` binding, so YuNet and SFace run on
**onnxruntime-node**, with OpenCV 4.14.0's post-processing ported line by line:
- YuNet decode + `NMSBoxes`
- SFace `alignCrop`: an Umeyama similarity transform plus OpenCV's fixed-point `warpAffine`

The pinned YuNet ONNX declares a fixed 640×640 input that onnxruntime enforces.
`src/vision/onnx-patch.js` drops those declared shapes in memory. The graph is
size-agnostic, and the patched bytes are themselves SHA-pinned. So detection runs at
OpenCV's native padded size.

`test/parity.test.mjs` compares against `scripts/parity/reference.py`, run with the
Python app's venv (OpenCV 4.14.0), on pinned OpenCV sample images:

| image | box/landmark diff | embedding cosine |
|---|---|---|
| lena 512×512 | 0.000 px | 1.00000 |
| messi5 548×342 | 0.000 px | 1.00000 |
| lena upscaled 1024×1024 | 0.000 px | 1.00000 |
| messi5 upscaled 1096×684 | 0.000 px | 1.00000 |
| box.png (no face) | 0 faces in both | — |

## Known limits

- **Linux and Windows code is written but has never run.** CI is the first place it
  will. Linux idle time depends on Electron's `powerMonitor` support for your
  compositor.
- No liveness check: a photo of you counts as you.
- The private macOS lock API could change in a macOS update. Use *Test lock* after updates.
- macOS builds are ad-hoc signed. Other Macs will show a Gatekeeper warning
  until the app is signed with a Developer ID and notarized.
- Windows: Python-app detection only checks macOS/Linux install locations.
- `onnxruntime-node` also ships two install-time-only dependencies, `adm-zip` and
  `global-agent` (plus their dependencies). They get packaged but are never loaded at
  runtime: its runtime `require`s are only `onnxruntime-common` and its binding.
- USB guard on macOS has been run read-only: IOKit enumeration works, and 0 devices
  were connected. Reading vendor/product/serial/name from a real device, the lock
  triggered by a real plug-in, and the intruder photo (camera after lock) have **not
  been run**.
- The camera flow (getUserMedia → frames → IPC), enrollment, the tray and settings UI,
  and a real lock from this app have **not been run**. Only the APIs' presence and the
  non-camera parts were checked.
- `npm audit` reports a moderate ReDoS advisory in `minimatch`, pulled in by
  `electron-builder`. It's a build-time tool only; nothing from it ships in the app.
