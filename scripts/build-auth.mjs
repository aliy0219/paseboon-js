#!/usr/bin/env node
/**
 * Build the macOS authentication helper (Touch ID / account password via
 * LocalAuthentication) into build/native/paseboon-auth. No-op on other OSes,
 * where the app uses Windows Hello (PowerShell) or polkit (pkexec) instead.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'native', 'macos', 'paseboon-auth.swift');
const OUT = path.join(ROOT, 'build', 'native', 'paseboon-auth');

if (process.platform !== 'darwin') {
  console.log('build-auth: not macOS, nothing to build');
  process.exit(0);
}
mkdirSync(path.dirname(OUT), { recursive: true });
execFileSync('swiftc', ['-O', '-o', OUT, SRC], { stdio: 'inherit' });
const check = (() => {
  try {
    return execFileSync(OUT, ['--check'], { encoding: 'utf8' }).trim(); // never prompts
  } catch (err) {
    return `exit ${err.status}: ${String(err.stdout || '').trim()}`;
  }
})();
console.log(`build-auth: built ${path.relative(ROOT, OUT)} (--check: ${check})`);
