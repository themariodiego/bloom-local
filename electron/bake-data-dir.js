/**
 * Build step: tell the packaged app where to keep its data. The result is
 * written to electron/data-dir.json (git-ignored) and packed into the app.
 *
 *   node electron/bake-data-dir.js
 *     Local build. Record the absolute path of this checkout's data directory
 *     so a packaged Bloom.app keeps using the same database as `npm start`,
 *     wherever the bundle is later moved to.
 *
 *   node electron/bake-data-dir.js --release
 *     Distributed build (the downloadable installers). Record no path: the
 *     machine that builds the installer is not the one that runs it, so the
 *     app keeps its data in the per-user app-data folder instead.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(here, 'data-dir.json');
const release = process.argv.includes('--release');

let baked;
if (release) {
  baked = { dataDir: null, release: true };
  console.log('[bloom] release build: data will live in the per-user app-data folder');
} else {
  const dataDir = path.resolve(here, '..', 'data');
  mkdirSync(dataDir, { recursive: true });
  baked = { dataDir };
  console.log(`[bloom] baked data directory: ${dataDir}`);
}

writeFileSync(outFile, `${JSON.stringify(baked, null, 2)}\n`);
