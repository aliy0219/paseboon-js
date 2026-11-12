// Build-time only: download the pinned face models into ./models and verify
// size + SHA-256. Existing files that already match are left alone. The app
// itself never downloads anything.
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL, ModelError, loadVerified, sha256 } from '../src/vision/models.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models');
await mkdir(DIR, { recursive: true });

for (const model of ALL) {
  try {
    await loadVerified(model, DIR);
    console.log(`ok        ${model.filename}`);
    continue;
  } catch (err) {
    if (!(err instanceof ModelError)) throw err;
  }
  console.log(`download  ${model.filename} (${(model.size / 1048576).toFixed(1)} MB)`);
  const res = await fetch(model.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${model.filename}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length !== model.size || sha256(bytes) !== model.sha256) {
    throw new Error(`${model.filename}: download does not match the pinned size/SHA-256 (${bytes.length} bytes)`);
  }
  const dest = path.join(DIR, model.filename);
  const tmp = `${dest}.part`;
  await writeFile(tmp, bytes);
  await rename(tmp, dest).catch(async (err) => { await rm(tmp, { force: true }); throw err; });
  console.log(`verified  ${model.filename}`);
}
