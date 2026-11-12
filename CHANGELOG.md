# Changelog

Versions follow [Semantic Versioning](https://semver.org/). Each release is a git tag `vX.Y.Z`.

## [0.2.0] - 2026-11-12

### Added
- **Settings protection with your computer login** (Touch ID or account password on macOS).
  Opening Settings, Pause/Resume, Quit, Start at login, enroll, tests, saving settings, all USB
  trust/remove actions, clearing the USB list and opening/deleting photos need an unlocked
  session, enforced in the main process. A session lasts until the window closes or 2 minutes
  without interaction. Lock now and OS shutdown/logout are never blocked.
- Wrong attempts: cancels are not counted; failures wait 5 s, then 15 s; the 3rd failure locks
  the screen (intruder photo first when enabled). The counter is persisted in
  `auth_state.json` (0600). When authentication is unavailable, Settings open with a red
  "Settings are not protected" banner; helper errors and timeouts deny.
- macOS helper `native/macos/paseboon-auth.swift` (LocalAuthentication), built by
  `npm run build:auth` and shipped in the app's Resources. Windows (Windows Hello) and Linux
  (pkexec) are written but untested.

### Changed
- On macOS the app menu has no Quit item (quit from the tray, which is protected).
- At startup Settings only opens by itself when no face is enrolled; other warnings show as a
  notification.

## [0.1.5] - 2026-11-12

### Fixed
- **Intruder photos were black** (7-9 KB, average brightness 0.9/255). The photo was taken 2
  frames after the camera started, before auto-exposure had adjusted. The app now reads frames
  until the brightness is stable and bright enough (at most 1.5 s), keeping the brightest frame
  in a dark room, and logs the brightness it got. The lock now waits at most 2.5 s for the photo
  (was 1.5 s).

## [0.1.4] - 2026-11-12

### Fixed
- **Intruder photo was never saved on macOS.** The photo was taken after locking, and macOS
  refuses to start the camera once the screen is locked (`NotReadableError: Could not start
  video source`). The photo is now taken first and the lock follows. The lock waits at most
  1.5 s; with a slower camera it locks anyway and keeps the photo if it still arrives.
- **Recent USB locks** showed only the last 5 of the 20 kept entries, with no count. It now
  shows all kept entries, newest first, with a count ("N of the last 20 kept"), each row says
  whether a photo was taken, devices trusted since are tagged "trusted now", and a
  **Clear list** button empties it.

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
