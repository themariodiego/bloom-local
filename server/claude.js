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
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SCRATCH_DIR } from './paths.js';

/** Models offered in the UI picker. `id` is passed straight to `--model`. */
export const MODELS = [
  {
    id: 'claude-opus-5',
    name: 'Opus 5',
    tagline: 'Deepest reasoning',
    blurb: 'Best for hard subjects and courses you want to go all the way down on.',
    tier: 'opus',
  },
  {
    id: 'claude-sonnet-5',
    name: 'Sonnet 5',
    tagline: 'Balanced',
    blurb: 'Near-Opus quality, noticeably faster. A good everyday default.',
    tier: 'sonnet',
    default: true,
  },
  {
    id: 'claude-opus-4-8',
    name: 'Opus 4.8',
    tagline: 'Previous Opus',
    blurb: 'The prior Opus generation — warm, clear writing.',
    tier: 'opus',
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Haiku 4.5',
    tagline: 'Fastest',
    blurb: 'Quick and light. Good for skimming a topic or short source material.',
    tier: 'haiku',
  },
];

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

  const candidates = [
    process.env.CLAUDE_CLI_PATH,
    ...(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, 'claude')),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(os.homedir(), '.local/bin/claude'),
    path.join(os.homedir(), '.claude/local/claude'),
    path.join(os.homedir(), '.bun/bin/claude'),
    path.join(os.homedir(), '.npm-global/bin/claude'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        cachedBin = candidate;
        return cachedBin;
      }
    } catch {
      /* keep probing */
    }
  }
  cachedBin = 'claude';
  return cachedBin;
}

function buildArgs(model) {
  return [
    '-p',
    '--model', model,
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
  const args = buildArgs(chosen);
  if (system) args.push('--system-prompt', system);

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
        },
      });
    } catch (err) {
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
      model: 'claude-haiku-4-5',
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
