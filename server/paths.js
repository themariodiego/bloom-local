/**
 * Everything the app writes lives in one directory — the database, uploaded
 * files, and the scratch cwd handed to the Claude CLI.
 *
 * By default that is `app/data/`, right next to the source. A packaged .app
 * can't write inside its own read-only bundle, so the Electron main process
 * sets BLOOM_DATA_DIR to a writable location before importing this module.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const APP_ROOT = path.resolve(here, '..');
export const DATA_DIR = process.env.BLOOM_DATA_DIR
  ? path.resolve(process.env.BLOOM_DATA_DIR)
  : path.join(APP_ROOT, 'data');

export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
/** Empty cwd for the Claude CLI, so it never picks up project context. */
export const SCRATCH_DIR = path.join(DATA_DIR, 'scratch');
export const DB_PATH = path.join(DATA_DIR, 'bloom.db');
export const WEB_DIST = path.join(APP_ROOT, 'web', 'dist');

for (const dir of [DATA_DIR, UPLOADS_DIR, SCRATCH_DIR]) {
  mkdirSync(dir, { recursive: true });
}
