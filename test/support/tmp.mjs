// Test temp dirs live inside the project (test/.tmp, gitignored), never in the OS temp dir.
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '.tmp');

export function tmpDir(prefix = 't-') {
  mkdirSync(ROOT, { recursive: true });
  return mkdtempSync(path.join(ROOT, prefix));
}
