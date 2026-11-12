# Changelog

Versions follow [Semantic Versioning](https://semver.org/). Each release is a git tag `vX.Y.Z`.

## [0.1.0] - 2026-11-12

First release. An Electron rewrite of the Python Paseboon, with the same behaviour.

Renamed before release from "Away Lock JS" to **Paseboon JS**: app ID `local.paseboon-js`, data
folder `paseboon-js`, env `PASEBOON_JS_HOME` / `PASEBOON_SMOKE`. On first start, settings, face
templates, the trusted USB list, events and photos are **copied** from the old `away-lock-js`
folder (never overwritten, old folder kept). macOS asks for camera permission again.

### Added
- Tray/menu-bar app with a Settings window: mode, timers (idle defaults to 10 s), Enroll
  face, Test camera, Test lock, and Start at login.
- The decision logic and watcher loop ported 1:1 from Python, with the Python tests
  ported as the spec.
- Face pipeline on onnxruntime-node, with OpenCV 4.14.0's YuNet decode, NMS and SFace
  `alignCrop` ported. It gives the same results as the Python/OpenCV reference: 0.000 px
  box difference and embedding cosine 1.00000.
- Models bundled at build time and checked against pinned size and SHA-256 on every start.
- Security: sandboxed renderers, context isolation, strict CSP, and all network blocked at
  runtime.
- **USB guard** (off by default): trusted list, Remove, Trust connected now, and Trust
  this device. Detection uses IOKit, sysfs or SetupAPI via koffi, with no new npm
  dependency.
- **Intruder photo** (off by default): untrusted devices only, taken after locking.
  Keeps the newest 50 in an owner-only folder, with Delete all.
- electron-builder targets (mac dmg/zip, win nsis, linux AppImage/deb) and a GitHub
  Actions build matrix.

### Known gaps
- The camera flow, the UI, a real lock from this app, a real USB plug-in, and Linux/Windows have not been run.
- Only the macOS arm64 build was produced locally. Windows and Linux builds need CI or a machine running that OS.
