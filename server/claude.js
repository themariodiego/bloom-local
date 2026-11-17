/**
 * LLM provider backed by the local Claude Code CLI.
 *
 * Instead of an API key, every request shells out to `claude -p`, which
 * authenticates with whatever the user is already logged into Claude Code
 * with — i.e. their subscription. The init event reports
 * `apiKeySource: "none"` when this is working as intended.
 *
 * The CLI is invoked in its leanest possible configuration. Left at defaults
 * it ships the full Claude Code agent harness (tool schemas, MCP servers,
 * skills) as a ~61k-token system prompt on every call; the flags below strip
 * that down to just our own prompt, which is ~140 tokens of overhead.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SCRATCH_DIR } from './paths.js';
import { runCodex } from './codex.js';

/**
 * Models offered in the UI picker. `id` is passed straight to `--model` and
 * `effort` to `--effort`. Always use full ids — the CLI's aliases lag behind
 * new releases.
 */
export const MODELS = [
  {
    id: 'claude-opus-5-5',
    name: 'Opus 5.5',
    tagline: 'Deepest reasoning',
    blurb: 'Best for hard subjects and courses you want to go all the way down on.',
    tier: 'opus',
    effort: 'medium',
    default: true,
  },
  {
    id: 'claude-sonnet-5-5',
    name: 'Sonnet 5.5',
    tagline: 'Balanced',
    blurb: 'Near-Opus quality, noticeably faster. A good everyday choice.',
    tier: 'sonnet',
    effort: 'medium',
  },
  {
    id: 'claude-haiku-5-5',
    name: 'Haiku 5.5',
    tagline: 'Fastest',
    blurb: 'Quick and light. Good for skimming a topic or short source material.',
    tier: 'haiku',
    effort: 'medium',
  },
  // Served by the Codex CLI on the user's ChatGPT subscription (see codex.js).
  {
    id: 'gpt-6.1-sol',
    name: 'GPT-6.1 Sol',
    tagline: 'Codex · Extra High',
    blurb: "OpenAI's latest Sol, reasoning at extra-high effort. Slower, and the lesson appears all at once.",
    tier: 'sol',
    provider: 'codex',
    effort: 'xhigh',
  },
  {
    id: 'gpt-6-astra',
    name: 'GPT-6 Astra',
    tagline: 'Codex · Extra High',
    blurb: "OpenAI's latest Astra, reasoning at extra-high effort. Slower, and the lesson appears all at once.",
    tier: 'astra',
    provider: 'codex',
    effort: 'xhigh',
  },
];

/** Cheap model for background chores (health checks, syllabus revisions). */
export const FAST_MODEL = 'claude-haiku-5-5';

export const DEFAULT_MODEL =
  MODELS.find((m) => m.default)?.id ?? MODELS[0].id;

export function resolveModel(requested) {
  if (!requested) return DEFAULT_MODEL;
  return MODELS.some((m) => m.id === requested) ? requested : DEFAULT_MODEL;
}

/**
 * Find the `claude` binary. A GUI-launched Electron app inherits a minimal
 * PATH that usually omits the install locations, so probe them directly.
 */
let cachedBin = null;
export function claudeBinary() {
  if (cachedBin) return cachedBin;
  cachedBin = resolveClaudeBinary({
    platform: process.platform,
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

/**
 * The search behind claudeBinary(), with the OS passed in so the Windows
 * branch can be exercised anywhere against a fake filesystem. Returns the
 * first candidate that exists, else bare 'claude' for spawn to look up.
 */
export function resolveClaudeBinary({ platform, arch = 'x64', env, homedir, exists }) {
  if (platform !== 'win32') {
    const p = path.posix;
    const candidates = [
      env.CLAUDE_CLI_PATH,
      ...(env.PATH || '')
        .split(':')
        .filter(Boolean)
        .map((dir) => p.join(dir, 'claude')),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      p.join(homedir, '.local/bin/claude'),
      p.join(homedir, '.claude/local/claude'),
      p.join(homedir, '.bun/bin/claude'),
      p.join(homedir, '.npm-global/bin/claude'),
    ].filter(Boolean);
    return candidates.find((c) => exists(c)) ?? 'claude';
  }

  // Windows. Only a real .exe will do: Node refuses to spawn a .cmd without a
  // shell (EINVAL), and routing through cmd.exe can't carry arbitrary
  // arguments safely. npm installs give us exactly such a shim, so look
  // through it to the native binary the package ships.
  const w = path.win32;
  if (env.CLAUDE_CLI_PATH && exists(env.CLAUDE_CLI_PATH)) return env.CLAUDE_CLI_PATH;

  const home = env.USERPROFILE || homedir;
  const appData = env.APPDATA || w.join(home, 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA || w.join(home, 'AppData', 'Local');
  const dirs = [
    ...windowsPathDirs(env),
    w.join(home, '.local', 'bin'), // native installer
    w.join(appData, 'npm'), // npm global prefix
    w.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
    w.join(home, '.bun', 'bin'),
  ];

  for (const dir of dirs) {
    const exe = w.join(dir, 'claude.exe');
    if (exists(exe)) return exe;
    if (exists(w.join(dir, 'claude.cmd'))) {
      // npm's shim lives in the prefix, with the package under node_modules.
      // The per-platform optional dependency holds the real binary (nested,
      // or hoisted beside the package); bin/claude.exe is the copy the
      // postinstall drops over a placeholder, so it's only trusted last.
      const scope = w.join(dir, 'node_modules', '@anthropic-ai');
      const native = `claude-code-win32-${arch === 'arm64' ? 'arm64' : 'x64'}`;
      const found = [
        w.join(scope, 'claude-code', 'node_modules', '@anthropic-ai', native, 'claude.exe'),
        w.join(scope, native, 'claude.exe'),
        w.join(scope, 'claude-code', 'bin', 'claude.exe'),
      ].find((c) => exists(c));
      if (found) return found;
    }
  }
  return 'claude';
}

/** PATH entries on Windows: `;`-separated, sometimes quoted, key spelled `Path`. */
export function windowsPathDirs(env) {
  return (env.PATH ?? env.Path ?? '')
    .split(';')
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

function buildArgs(model) {
  const effort = MODELS.find((m) => m.id === model)?.effort;
  return [
    '-p',
    '--model', model,
    ...(effort ? ['--effort', effort] : []),
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    // Strip the agent harness: no tools, no MCP servers, no skills, no
    // user/project settings. This is a pure text-generation call.
    '--tools', '',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
}

export class ClaudeError extends Error {
  constructor(message, { kind = 'unknown', detail = '' } = {}) {
    super(message);
    this.name = 'ClaudeError';
    this.kind = kind;
    this.detail = detail;
  }
}

function classifyFailure(stderr, resultEvent) {
  const haystack = `${stderr}\n${resultEvent?.result ?? ''}`.toLowerCase();

  if (haystack.includes('enoent') || haystack.includes('command not found')) {
    return new ClaudeError(
      'Could not find the Claude Code CLI. Install it, or set CLAUDE_CLI_PATH to its full path.',
      { kind: 'cli_missing', detail: stderr },
    );
  }
  if (
    haystack.includes('not logged in') ||
    haystack.includes('please run /login') ||
    haystack.includes('authentication') ||
    haystack.includes('unauthorized')
  ) {
    return new ClaudeError(
      'Claude Code is not signed in. Run `claude` in a terminal and log in, then try again.',
      { kind: 'auth', detail: stderr },
    );
  }
  if (haystack.includes('rate limit') || haystack.includes('usage limit')) {
    return new ClaudeError(
      'Your Claude subscription hit its usage limit. Try again after it resets, or switch to a lighter model.',
      { kind: 'rate_limit', detail: stderr },
    );
  }
  return new ClaudeError(
    resultEvent?.result || stderr.trim().split('\n').slice(-3).join(' ') ||
      'The Claude Code CLI failed.',
    { kind: 'cli_error', detail: stderr },
  );
}

/**
 * Run one generation.
 *
 * @param {object}   opts
 * @param {string}   opts.system  System prompt.
 * @param {string}   opts.prompt  User message (sent on stdin — it can be large).
 * @param {string}   opts.model   Model id.
 * @param {(text: string) => void} [opts.onDelta] Called with each text chunk.
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<string>} the full response text
 */
export function runClaude({ system, prompt, model, onDelta, signal }) {
  const chosen = resolveModel(model);
  const entry = MODELS.find((m) => m.id === chosen);
  if (entry?.provider === 'codex') {
    return runCodex({ system, prompt, model: chosen, effort: entry.effort, onDelta, signal });
  }
  const args = buildArgs(chosen);

  // The system prompt goes in a temp file, not argv. Prompts that embed a
  // syllabus, earlier lessons or source material run to hundreds of KB, past
  // Windows' 32,767-character command line and Linux's 128 KB per-argument
  // cap. Doing it for every call, on every OS, keeps a single code path that
  // the health check exercises.
  let systemFile = null;
  const removeSystemFile = () => {
    if (!systemFile) return;
    try {
      rmSync(systemFile, { force: true });
      systemFile = null;
    } catch {
      /* still open on Windows — the close handler tries again */
    }
  };
  if (system) {
    try {
      systemFile = path.join(os.tmpdir(), `bloom-system-${randomUUID()}.md`);
      writeFileSync(systemFile, system, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (err) {
      return Promise.reject(
        new ClaudeError('Could not write the system prompt to a temporary file.', {
          kind: 'cli_error',
          detail: String(err),
        }),
      );
    }
    args.push('--system-prompt-file', systemFile);
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(claudeBinary(), args, {
        cwd: SCRATCH_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Keep the CLI from trying to render a TUI or ask anything.
          CI: '1',
          NO_COLOR: '1',
          // An API key in the environment outranks the OAuth login and would
          // silently bill the API instead of the subscription.
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
        },
      });
    } catch (err) {
      removeSystemFile();
      reject(
        new ClaudeError(
          'Could not launch the Claude Code CLI. Install it, or set CLAUDE_CLI_PATH.',
          { kind: 'cli_missing', detail: String(err) },
        ),
      );
      return;
    }

    let stderr = '';
    let buffer = '';
    let assembled = '';
    let resultEvent = null;
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

    child.on('error', (err) => {
      removeSystemFile();
      finish(
        reject,
        new ClaudeError(
          'Could not launch the Claude Code CLI. Install it, or set CLAUDE_CLI_PATH.',
          { kind: 'cli_missing', detail: String(err) },
        ),
      );
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      // stream-json emits one JSON object per line.
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // partial or non-JSON noise
        }

        if (event.type === 'stream_event') {
          const inner = event.event;
          if (
            inner?.type === 'content_block_delta' &&
            inner.delta?.type === 'text_delta' &&
            typeof inner.delta.text === 'string'
          ) {
            assembled += inner.delta.text;
            onDelta?.(inner.delta.text);
          }
        } else if (event.type === 'result') {
          resultEvent = event;
        }
      }
    });

    child.on('close', (code) => {
      removeSystemFile();
      if (resultEvent && resultEvent.is_error === false) {
        // Prefer the streamed text; fall back to the result field if no
        // partial messages came through.
        finish(resolve, assembled || resultEvent.result || '');
        return;
      }
      if (code === 0 && assembled) {
        finish(resolve, assembled);
        return;
      }
      finish(reject, classifyFailure(stderr, resultEvent));
    });

    // Large source documents blow past ARG_MAX, so the prompt goes on stdin.
    child.stdin.on('error', () => {});
    child.stdin.end(prompt ?? '');
  });
}

/** Non-streaming convenience wrapper. */
export async function callClaude({ system, prompt, model }) {
  return runClaude({ system, prompt, model });
}

/** Verify the CLI is present and signed in. Used by /api/health. */
export async function checkClaude() {
  try {
    const text = await runClaude({
      system: 'Reply with exactly: ok',
      prompt: 'ping',
      model: FAST_MODEL,
    });
    return { ok: true, reply: text.trim().slice(0, 40) };
  } catch (err) {
    return {
      ok: false,
      kind: err.kind ?? 'unknown',
      message: err.message,
    };
  }
}
