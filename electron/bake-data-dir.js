/**
 * Build step: record the absolute path of this checkout's data directory so a
 * packaged Bloom.app keeps using the same database as `npm start`, wherever
 * the bundle is later moved to.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '..', 'data');

mkdirSync(dataDir, { recursive: true });
writeFileSync(
  path.join(here, 'data-dir.json'),
  `${JSON.stringify({ dataDir }, null, 2)}\n`,
);

console.log(`[bloom] baked data directory: ${dataDir}`);
