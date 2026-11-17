/**
 * CI smoke test: boot the real server and poke it over HTTP.
 *
 * Runs the backend exactly as `npm run serve` does — under Electron's Node,
 * so better-sqlite3 must load against Electron's ABI — on a random port with a
 * throwaway data directory, then checks that the API answers and the built
 * frontend is served. Needs no Claude or Codex CLI: it never touches
 * /api/health or anything that generates.
 *
 *   npm run build && npm run smoke
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_HTML = path.join(APP_ROOT, 'web', 'dist', 'index.html');
const TIMEOUT_MS = 60_000;

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'bloom-smoke-'));
let child = null;
let output = '';

function log(message) {
  console.log(`[smoke] ${message}`);
}

class SmokeFailure extends Error {}

function check(condition, message) {
  if (!condition) throw new SmokeFailure(message);
}

/** Start the server; resolve with the port it reports once it is listening. */
function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(electron, [path.join(APP_ROOT, 'server', 'standalone.js')], {
      cwd: APP_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        BLOOM_DATA_DIR: dataDir,
        PORT: '0', // let the OS pick, so a running Bloom can't collide
      },
    });

    const onData = (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text.replace(/^(?=.)/gm, '  │ '));
      const match = output.match(/http:\/\/[^\s:]+:(\d+)/);
      if (match) resolve(Number(match[1]));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => reject(new SmokeFailure(`could not launch Electron: ${err.message}`)));
    child.on('exit', (code, signal) =>
      reject(new SmokeFailure(`server exited before listening (code ${code}, signal ${signal})`)),
    );
  });
}

async function getJson(base, route) {
  const res = await fetch(`${base}${route}`);
  check(res.status === 200, `GET ${route} → HTTP ${res.status}`);
  check(
    (res.headers.get('content-type') ?? '').includes('application/json'),
    `GET ${route} → content-type ${res.headers.get('content-type')}, expected JSON`,
  );
  return res.json();
}

async function run() {
  log(`data dir ${dataDir}`);
  const port = await startServer();
  // Explicit IPv4: the server binds 127.0.0.1, and `localhost` may resolve to ::1.
  const base = `http://127.0.0.1:${port}`;
  log(`server listening on port ${port}`);

  const models = await getJson(base, '/api/models');
  check(Array.isArray(models.models) && models.models.length > 0, '/api/models: no models listed');
  check(
    models.models.every((m) => typeof m.id === 'string' && m.id),
    '/api/models: a model has no id',
  );
  check(
    models.models.some((m) => m.id === models.default),
    `/api/models: default "${models.default}" is not in the list`,
  );
  log(`/api/models ok (${models.models.length} models, default ${models.default})`);

  // Proves the native module loaded and the schema was created.
  const courses = await getJson(base, '/api/courses');
  check(Array.isArray(courses), '/api/courses: expected an array');
  check(existsSync(path.join(dataDir, 'bloom.db')), 'bloom.db was not created in BLOOM_DATA_DIR');
  log(`/api/courses ok (${courses.length} courses), database created`);

  if (existsSync(INDEX_HTML)) {
    const res = await fetch(`${base}/`);
    check(res.status === 200, `GET / → HTTP ${res.status}`);
    const body = await res.text();
    check(body === readFileSync(INDEX_HTML, 'utf8'), 'GET / did not serve web/dist/index.html');
    log('/ serves web/dist/index.html');
  } else {
    log('web/dist/index.html not built — skipped the frontend check (run `npm run build` first)');
  }
}

/** Kill the server and wait for it, so Windows releases the database file. */
async function stopServer() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

let failure = null;
const timer = setTimeout(() => {
  failure = new SmokeFailure(`timed out after ${TIMEOUT_MS / 1000}s`);
  // Unblock whatever is pending; cleanup below still runs.
  stopServer().finally(() => finish());
}, TIMEOUT_MS);

let finished = false;
async function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  await stopServer();
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.warn(`[smoke] could not remove ${dataDir}: ${err.message}`);
  }
  if (failure) {
    console.error(`\n[smoke] FAILED: ${failure.message}`);
    if (!(failure instanceof SmokeFailure)) console.error(failure.stack);
    process.exit(1);
  }
  log('PASSED');
  process.exit(0);
}

run()
  .catch((err) => {
    failure ??= err;
  })
  .finally(() => finish());
