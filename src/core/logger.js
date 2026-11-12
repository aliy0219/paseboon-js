/**
 * Tiny rotating text logger (numbers and states only; never pixels).
 */

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 1_000_000;
const KEEP = 3;

export function createLogger(file, { echo = true } = {}) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const rotate = () => {
    try {
      if (statSync(file).size < MAX_BYTES) return;
    } catch {
      return;
    }
    rmSync(`${file}.${KEEP}`, { force: true });
    for (let i = KEEP - 1; i >= 1; i -= 1) {
      try { renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch { /* missing */ }
    }
    renameSync(file, `${file}.1`);
  };
  const write = (level) => (msg) => {
    const line = `${new Date().toISOString()} ${level} ${msg}\n`;
    try {
      rotate();
      appendFileSync(file, line, { mode: 0o600 });
    } catch { /* logging must never break the watcher */ }
    if (echo) process.stderr.write(line);
  };
  return { info: write('INFO'), warn: write('WARN'), error: write('ERROR'), file };
}
