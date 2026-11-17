/**
 * Run a script under Electron's bundled Node (ELECTRON_RUN_AS_NODE=1).
 *
 * The server has to run inside Electron rather than plain Node because
 * better-sqlite3 is rebuilt against Electron's ABI in postinstall. The old
 * `ELECTRON_RUN_AS_NODE=1 electron …` script prefix is POSIX shell syntax that
 * cmd.exe — npm's script shell on Windows — can't parse, so set the variable
 * here instead, with no extra dependency.
 *
 *   node scripts/electron-node.js server/standalone.js [args…]
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
// The electron npm package's default export is the path to its binary.
import electron from 'electron';

const child = spawn(electron, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

// Ctrl-C and `kill` reach this wrapper; pass them on so the server shuts down
// instead of being orphaned.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}

child.on('error', (err) => {
  console.error(`[bloom] could not launch Electron (${electron}): ${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  // Mirror the child: its exit code, or the shell convention 128 + signum.
  if (signal) process.exit(128 + (os.constants.signals[signal] ?? 0));
  process.exit(code ?? 1);
});
