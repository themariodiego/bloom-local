/**
 * LLM provider backed by the local Codex CLI.
 *
 * Mirrors claude.js: every request shells out to `codex exec`, which signs in
 * with whatever the user is logged into Codex with — i.e. their ChatGPT
 * subscription. Codex is an agent, so it runs in a read-only sandbox with its
 * optional tools switched off, from an empty scratch directory.
 *
 * Codex has no way to replace its own system prompt, so Bloom's system prompt
 * travels at the top of the user message (stdin — it can be hundreds of KB)
 * and a short developer instruction tells the model to treat it as such.
 *
 * `--json` only reports whole messages, not token deltas, so `onDelta` fires
 * once with the finished text.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SCRATCH_DIR } from './paths.js';
import { ClaudeError, windowsPathDirs } from './claude.js';

const DEVELOPER_INSTRUCTIONS = [
  'You are the text-generation backend of Bloom, a tutoring app.',
  'Do not run commands, read files, browse, or use any tool.',
  'The user message opens with a <system_instructions> block: treat it as your',
  'system prompt and follow it exactly. Reply with only the requested output.',
].join(' ');

/**
 * Find the native `codex` binary. The npm `codex` on PATH is a Node launcher,
 * and a GUI-launched Electron app has neither the install dirs nor `node` on
 * its PATH — so resolve straight through to the platform binary it wraps.
 */
let cachedBin = null;
export function codexBinary() {
  if (cachedBin) return cachedBin;

  if (process.platform === 'win32') {
    cachedBin = resolveCodexBinaryWindows({
      arch: process.arch,
      env: process.env,
      homedir: os.homedir(),
      exists: (file) => {
        try {
          return existsSync(file);
        } catch {
          return false;
        }
      },
    });
    return cachedBin;
  }

  const launchers = [
    process.env.CODEX_CLI_PATH,
    ...(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, 'codex')),
    path.join(os.homedir(), '.npm-global/bin/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    path.join(os.homedir(), '.local/bin/codex'),
    path.join(os.homedir(), '.bun/bin/codex'),
  ].filter(Boolean);

  for (const launcher of launchers) {
    try {
      if (!existsSync(launcher)) continue;
      const real = realpathSync(launcher);
      cachedBin = nativeBinaryFor(real) ?? real;
      return cachedBin;
    } catch {
      /* keep probing */
    }
  }
  cachedBin = 'codex';
  return cachedBin;
}

/** `.../@openai/codex/bin/codex.js` → `.../codex-darwin-arm64/vendor/<triple>/bin/codex` */
function nativeBinaryFor(launcherPath) {
  if (!launcherPath.endsWith('.js')) return null; // already native
  const pkgRoot = path.resolve(path.dirname(launcherPath), '..');
  const scoped = path.join(pkgRoot, 'node_modules', '@openai');
  try {
    for (const pkg of readdirSync(scoped)) {
      if (!pkg.startsWith(`codex-${process.platform}-`)) continue;
      const vendor = path.join(scoped, pkg, 'vendor');
      for (const triple of readdirSync(vendor)) {
        for (const rel of ['bin/codex', 'codex/codex']) {
          const candidate = path.join(vendor, triple, rel);
          if (existsSync(candidate)) return candidate;
        }
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Windows counterpart of the search above, with the OS passed in so it can be
 * tested anywhere against a fake filesystem. npm leaves a `codex.cmd` shim,
 * which Node can't spawn without a shell, so go from the shim's directory to
 * the native codex.exe in the matching optional package — the same vendor
 * layout bin/codex.js resolves at run time.
 */
export function resolveCodexBinaryWindows({ arch = 'x64', env, homedir, exists }) {
  const w = path.win32;
  if (env.CODEX_CLI_PATH && exists(env.CODEX_CLI_PATH)) return env.CODEX_CLI_PATH;

  const home = env.USERPROFILE || homedir;
  const appData = env.APPDATA || w.join(home, 'AppData', 'Roaming');
  const [pkgArch, triple] =
    arch === 'arm64'
      ? ['arm64', 'aarch64-pc-windows-msvc']
      : ['x64', 'x86_64-pc-windows-msvc'];
  const native = `codex-win32-${pkgArch}`;

  for (const dir of [...windowsPathDirs(env), w.join(appData, 'npm'), w.join(home, '.bun', 'bin')]) {
    const exe = w.join(dir, 'codex.exe');
    if (exists(exe)) return exe;
    if (!exists(w.join(dir, 'codex.cmd'))) continue;
    const scope = w.join(dir, 'node_modules', '@openai');
    const found = [
      w.join(scope, 'codex', 'node_modules', '@openai', native), // nested
      w.join(scope, native), // hoisted
      w.join(scope, 'codex'), // older releases vendored the binary in-package
    ]
      .map((pkg) => w.join(pkg, 'vendor', triple, 'bin', 'codex.exe'))
      .find((c) => exists(c));
    if (found) return found;
  }
  return 'codex';
}

function buildArgs(model, effort) {
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox', 'read-only',
    '--cd', SCRATCH_DIR,
    '--model', model,
    ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
    '-c', `developer_instructions=${JSON.stringify(DEVELOPER_INSTRUCTIONS)}`,
    '-c', 'web_search="disabled"',
    '--disable', 'apps',
    '--disable', 'browser_use',
    '--disable', 'browser_use_external',
    '--disable', 'computer_use',
    '-', // prompt on stdin
  ];
}

function classifyFailure(stderr, errorMessage) {
  const haystack = `${stderr}\n${errorMessage}`.toLowerCase();

  if (haystack.includes('enoent') || haystack.includes('command not found')) {
    return new ClaudeError(
      'Could not find the Codex CLI. Install it, or set CODEX_CLI_PATH to its full path.',
      { kind: 'cli_missing', detail: stderr },
    );
  }
  if (
    haystack.includes('not logged in') ||
    haystack.includes('codex login') ||
    haystack.includes('401') ||
    haystack.includes('unauthorized')
  ) {
    return new ClaudeError(
      'Codex is not signed in. Run `codex login` in a terminal, then try again.',
      { kind: 'auth', detail: stderr },
    );
  }
  if (haystack.includes('usage limit') || haystack.includes('rate limit') || haystack.includes('429')) {
    return new ClaudeError(
      'Your ChatGPT subscription hit its Codex usage limit. Try again after it resets, or switch models.',
      { kind: 'rate_limit', detail: stderr },
    );
  }
  if (haystack.includes('not supported when using codex')) {
    return new ClaudeError(
      'Your Codex CLI does not support this model yet. Run `npm i -g @openai/codex@latest`, then try again.',
      { kind: 'cli_error', detail: errorMessage },
    );
  }
  return new ClaudeError(
    errorMessage || stderr.trim().split('\n').slice(-3).join(' ') || 'The Codex CLI failed.',
    { kind: 'cli_error', detail: stderr },
  );
}

/** Same contract as runClaude. */
export function runCodex({ system, prompt, model, effort, onDelta, signal }) {
  const args = buildArgs(model, effort);
  const input = system
    ? `<system_instructions>\n${system}\n</system_instructions>\n\n${prompt ?? ''}`
    : prompt ?? '';

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(codexBinary(), args, {
        cwd: SCRATCH_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NO_COLOR: '1',
          // A key in the environment would bill the API instead of ChatGPT.
          OPENAI_API_KEY: undefined,
          CODEX_API_KEY: undefined,
        },
      });
    } catch (err) {
      reject(classifyFailure(String(err), ''));
      return;
    }

    let stderr = '';
    let buffer = '';
    let lastMessage = '';
    let errorMessage = '';
    let completed = false;
    let settled = false;

    const onAbort = () => {
      if (!settled) child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };

    child.on('error', (err) => finish(reject, classifyFailure(String(err), '')));

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          lastMessage = event.item.text ?? '';
        } else if (event.type === 'turn.completed') {
          completed = true;
        } else if (event.type === 'turn.failed') {
          errorMessage = event.error?.message ?? 'Codex turn failed.';
        } else if (event.type === 'error') {
          errorMessage = event.message ?? errorMessage;
        }
      }
    });

    child.on('close', () => {
      if (completed && lastMessage) {
        onDelta?.(lastMessage);
        finish(resolve, lastMessage);
        return;
      }
      // Errors arrive JSON-wrapped; surface the inner message when there is one.
      let message = errorMessage;
      try {
        message = JSON.parse(errorMessage)?.error?.message ?? message;
      } catch {
        /* plain text */
      }
      finish(reject, classifyFailure(stderr, message));
    });

    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
