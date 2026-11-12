// Guards: no image is ever written/encoded/sent; network code only in the
// build-time model fetcher; renderer hardening flags present; CSP strict.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const sources = walk(SRC).filter((p) => /\.(m?js|cjs|html)$/.test(p));

// Image encoding/exporting/writing APIs. Only the intruder-photo module may use them.
const IMAGE_OUT = /toDataURL|toBlob|convertToBlob|imencode|toPNG|toJPEG|toBitmap|getBitmap|MediaRecorder|writeFile\w*\([^)]*(frame|pixel|image|img)/;
const PHOTO_MODULE = path.join('src', 'usb', 'photos.js');

test('image encoding/writing exists ONLY in the intruder-photo module', () => {
  const users = sources.filter((f) => IMAGE_OUT.test(readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
  assert.deepEqual(users, [PHOTO_MODULE]);
  // The rest of the app reaches it only through photos.takePhoto, from main.js.
  const callers = sources.filter((f) => /takePhoto\(/.test(readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
  assert.deepEqual(callers.sort(), [path.join('src', 'main', 'main.js'), PHOTO_MODULE].sort());
});

test('the photo module writes owner-only files with O_EXCL and keeps 50', () => {
  const src = readFileSync(path.join(ROOT, PHOTO_MODULE), 'utf8');
  assert.match(src, /open\(file, 'wx', 0o600\)/);
  assert.match(src, /MAX_PHOTOS = 50/);
  assert.match(src, /mode: 0o700/);
});

test('no network client code in the app (smoke test only probes that it is blocked)', () => {
  const net = /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|node:https?\b|node:net\b|node:dgram|require\(['"]https?['"]\)/;
  const offenders = sources.filter((f) => net.test(readFileSync(f, 'utf8'))
    && !f.endsWith(path.join('main', 'main.js')));
  assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), []);
  // main.js may only use net.fetch inside the smoke() self-test.
  const main = readFileSync(path.join(SRC, 'main', 'main.js'), 'utf8');
  const uses = main.match(/\bfetch\(/g) ?? [];
  assert.equal(uses.length, 1);
  assert.match(main, /async function smoke\(\)[\s\S]*net\.fetch\('https:\/\/example\.com\/'\)/);
});

test('every BrowserWindow is sandboxed with context isolation and no node integration', () => {
  for (const f of sources.filter((p) => p.endsWith('.js'))) {
    const text = readFileSync(f, 'utf8');
    const windows = text.split('new BrowserWindow(').slice(1);
    for (const w of windows) {
      const block = w.slice(0, 800);
      assert.match(block, /sandbox: true/, f);
      assert.match(block, /contextIsolation: true/, f);
      assert.match(block, /nodeIntegration: false/, f);
    }
  }
  assert.match(readFileSync(path.join(SRC, 'main', 'main.js'), 'utf8'), /app\.enableSandbox\(\)/);
});

test('every HTML page has a strict CSP with no network or inline script', () => {
  for (const f of sources.filter((p) => p.endsWith('.html'))) {
    const html = readFileSync(f, 'utf8');
    const csp = html.match(/Content-Security-Policy"\s+content="([^"]+)"/)?.[1];
    assert.ok(csp, `${f} has no CSP`);
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:|\*/);
    assert.doesNotMatch(html, /<script>(?!<\/script>)/, 'no inline scripts');
  }
});

test('URL allowlist: only this app\'s own files', async () => {
  // security.js imports electron; test the pure function via a light shim.
  const src = readFileSync(path.join(SRC, 'main', 'security.js'), 'utf8')
    .replace(/import \{ app, session \} from 'electron';/, 'const app = {}, session = {};');
  const mod = await import(`data:text/javascript,${encodeURIComponent(src)}`);
  const root = path.join(ROOT, 'src');
  const fileUrl = (p) => pathToFileURL(p).href;   // correct on Windows too (drive letters)
  assert.equal(mod.isAllowedUrl(fileUrl(path.join(root, 'renderer', 'settings.html')), root), true);
  for (const bad of ['https://example.com/', 'http://127.0.0.1:11434/api', 'wss://x', 'data:text/html,hi',
    'blob:file:///x', 'file://evil-host/share/x', fileUrl('/etc/passwd'), fileUrl(`${root}/../../secret`), 'not a url']) {
    assert.equal(mod.isAllowedUrl(bad, root), false, bad);
  }
});
