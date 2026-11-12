# Changelog

Versions follow [Semantic Versioning](https://semver.org/). Each release is a git tag `vX.Y.Z`.

## [0.1.3] - 2026-11-12

### Added
- GitHub Releases: pushing a `v*` tag builds macOS, Windows and Linux, then publishes one
  release with every installer (`.dmg`, `.zip`, `Setup .exe`, `.AppImage`, `.deb`) and
  `SHA256SUMS.txt`. Release notes come from this changelog.

## [0.1.2] - 2026-11-12

### Fixed
- Windows: the network allowlist threw on file URLs it could not map to a local path instead
  of denying them. It now denies them (fail closed); tests build file URLs with
  `pathToFileURL` so drive letters are correct.
- Windows CI: the Linux sysfs parser test no longer creates a folder name with `:`.

## [0.1.1] - 2026-11-12

### Fixed
- Package metadata: GitHub account renamed to `aliy0219` (repository URL, homepage), and the
  author / Linux package maintainer email was missing its `@users` part.

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
