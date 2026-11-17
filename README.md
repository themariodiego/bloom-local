# Bloom — a local AI tutor for macOS and Windows

[![CI](https://github.com/themariodiego/bloom-local/actions/workflows/ci.yml/badge.svg)](https://github.com/themariodiego/bloom-local/actions/workflows/ci.yml)

A local version of [Bloom](https://github.com/Li-Evan/Bloom), the AI tutor built on
Bloom's 2-Sigma research: it writes you a syllabus, teaches one lesson at a time,
reads your annotations and feedback, and tailors the next lesson to what you
actually understood.

It's a port of the original to a desktop app that runs entirely on your own
machine. Three things are different from upstream:

- **It runs on your Claude Code subscription, not an API key.** Every generation
  shells out to the `claude` CLI you're already logged into.
- **You pick the model** — per course, and changeable at any time from the reader.
- **GPT models are optional extras.** If you also have the Codex CLI signed in to
  a ChatGPT subscription, its models show up in the same picker.

---

## Install on macOS

1. **Install Node.js 22 or newer** from <https://nodejs.org> (the LTS installer is
   fine). Check it in Terminal:

   ```bash
   node --version
   ```

2. **Install Git**, if you don't have it. Typing `git --version` in Terminal will
   offer to install Apple's command line tools, which include it. Or skip Git
   entirely: on the GitHub page, click **Code → Download ZIP** and unzip it.

3. **Install Claude Code and sign in.** You need a paid Claude plan (Pro, Max,
   Team or Enterprise); the free plan doesn't include Claude Code.

   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   ```

   Then run `claude` once and log in when it asks. Afterwards this should print a
   version number:

   ```bash
   claude --version
   ```

4. **Get the code:**

   ```bash
   git clone https://github.com/themariodiego/bloom-local.git
   cd bloom-local
   ```

   (If you downloaded the ZIP, `cd` into the unzipped folder instead.)

5. **Install and run:**

   ```bash
   npm install
   npm start
   ```

   `npm install` fetches the dependencies and the SQLite native module built for
   Electron. `npm start` builds the frontend and opens the Bloom window.

From then on, `npm start` in that folder is all you need. To get a proper
`Bloom.app` you can launch from Spotlight, see
[Building an installed app](#building-an-installed-app).

---

## Install on Windows

Bloom was built on macOS. On Windows, installing, building and starting the
server are checked automatically on every push (see the CI badge); the app
window itself has had less hands-on testing — please open an issue if something
misbehaves.

The commands below work in PowerShell or Command Prompt.

1. **Install Node.js 22 or newer** from <https://nodejs.org> (the LTS installer is
   fine). Open a new terminal and check it:

   ```powershell
   node --version
   ```

2. **Install Git** from <https://git-scm.com/download/win>, or skip it: on the
   GitHub page, click **Code → Download ZIP** and extract it.

3. **Install Claude Code and sign in.** You need a paid Claude plan (Pro, Max,
   Team or Enterprise); the free plan doesn't include Claude Code. In PowerShell:

   ```powershell
   irm https://claude.ai/install.ps1 | iex
   ```

   Alternatives: `winget install Anthropic.ClaudeCode`, or
   `npm install -g @anthropic-ai/claude-code`. Git for Windows is optional for
   Claude Code.

   Open a new terminal so it's on your `PATH`, run `claude` once and log in when
   it asks. Afterwards this should print a version number:

   ```powershell
   claude --version
   ```

4. **Get the code:**

   ```powershell
   git clone https://github.com/themariodiego/bloom-local.git
   cd bloom-local
   ```

   (If you downloaded the ZIP, `cd` into the extracted folder instead.)

5. **Install and run:**

   ```powershell
   npm install
   npm start
   ```

   `npm install` fetches the dependencies and the SQLite native module built for
   Electron. `npm start` builds the frontend and opens the Bloom window.

Windows notes:

- **If `npm install` fails while building `better-sqlite3`**, install the
  "Desktop development with C++" workload of
  [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
  and run `npm install` again. Normally a prebuilt binary is downloaded and no
  compiler is needed.
- **SmartScreen or Windows Firewall may ask about Electron** the first time. It's
  safe to allow: the server only binds to `127.0.0.1` and isn't reachable from
  the network.

---

## Optional: GPT models via Codex

If you have a ChatGPT subscription, install the Codex CLI and sign in:

```bash
npm install -g @openai/codex
codex login
```

Restart Bloom and the GPT models appear in the model picker. Bloom works fine
without it — the Claude models don't need Codex at all.

---

## How it works

Three ways to start a course:

| Mode | What it does |
|------|--------------|
| **Topic** | Type a subject. Claude writes a syllabus, then lesson 01. Optionally paste reference material to ground it in. |
| **Document** | Upload a PDF, TXT, or Markdown file. The syllabus comes from the document; lesson 01 *is* the document, ready to highlight. |
| **Files** | Upload files or a folder. Each becomes its own page. No syllabus, no generated lessons — just read and ask. |

Uploading a file only *stages* it. Nothing is generated until you've set the
name, model and depth and pressed Start.

Then the loop:

```
read the lesson
  → highlight anything and ask about it (answers stream in, threads keep context)
  → write feedback + answer the thinking questions
  → "Done reading"
      → your feedback is checked against the plan, and the syllabus is revised
        if what you said warrants it
      → the next lesson opens by grading your answers question by question,
        resolving every annotation, then teaching new material
  → repeat until every mastery item is ticked
      → final assessment → course summary
```

Mastery items tick themselves: each lesson ends with a hidden
`<!-- mastery: … -->` comment naming what it covered, the syllabus checkboxes
update to match, and the syllabus **Progress** table gains a row.

### Feedback can change the plan

If you say a course is too advanced, or ask for something the syllabus doesn't
cover, the plan itself is revised before the next lesson is written — so the
correction lands immediately rather than a lesson late. You'll see a note at the
top of the new lesson saying what changed and why.

Your progress is protected structurally, not by trusting the model. The reviser
never sees or emits checkbox syntax: it gets a numbered view of the plan and
returns operations keyed by integer id, and every output line is either carried
over byte-for-byte or rebuilt locally. On top of that:

- Items you've already been taught are **frozen** — an operation touching one is refused.
- New items that overlap an existing one are refused, since that would corrupt auto-ticking.
- Vague items ("Understand X") are refused.
- If the set of ticked items changes at all, the whole revision is discarded.

Revision runs on Haiku regardless of the course model (it's classification plus a
small structured edit, not teaching) and only when you've actually written
feedback.

---

## Choosing a model

The picker sits in the composer on the home screen and in the reader's top bar.
Your choice is saved per course, so a hard subject can run on Opus while a light
one runs on Haiku.

| Model | Runs on | When |
|-------|---------|------|
| **Opus 5.5** | Claude Code | Default — deepest reasoning, for hard subjects and deep courses |
| **Sonnet 5.5** | Claude Code | Near-Opus quality, noticeably faster |
| **Haiku 5.5** | Claude Code | Skimming a topic, short source material |
| **GPT-6.1 Sol** | Codex (optional) | OpenAI's Sol at extra-high reasoning effort |
| **GPT-6 Astra** | Codex (optional) | OpenAI's Astra at extra-high reasoning effort |

The Claude models stream lessons in as they're written. The GPT models are
slower and the lesson arrives all at once, because the Codex CLI only reports
finished messages.

Generation counts against your normal subscription limits. If you hit the cap,
Bloom says so and you can switch to a lighter model or wait for the reset.

**On efficiency:** the CLI is invoked with its agent harness stripped out — no
tools, no MCP servers, no skills, no user settings. Left at defaults that
scaffolding costs about 61,000 tokens of system prompt on *every* call; without
it, overhead is roughly 140 tokens. Worth knowing if you ever edit
`server/claude.js`.

---

## Scripts

| Command | What |
|---------|------|
| `npm start` | Build and open the app |
| `npm run dev` | Backend + Vite with hot reload, on :5319 |
| `npm run serve` | Browser mode on <http://localhost:4317> |
| `npm run dist` | Build an unpacked app for the current platform into `release/` |
| `npm run dist:dmg` | Build a macOS `.dmg` installer |
| `npm run dist:win` | Build a Windows installer (`.exe`, NSIS) |
| `npm run smoke` | Start the server against a temporary data directory and check it responds (what CI runs) |

Prefer a browser tab to the app window? `npm run serve`, then open
<http://localhost:4317>.

---

## Building an installed app

`npm start` works fine day to day, but you can also build a standalone app.

**macOS:**

```bash
npm run dist && ditto release/mac-arm64/Bloom.app /Applications/Bloom.app
```

On an Intel Mac the folder is `release/mac/` instead of `release/mac-arm64/`.
Once it's in `/Applications` it shows up when you search "Bloom" in Spotlight or
Launchpad. Re-run the same line after changing anything. Use `ditto` rather than
`cp -R` — it preserves the extended attributes and bundle signature that `cp`
can mangle.

**Windows:**

```powershell
npm run dist:win
```

The installer (`Bloom Setup <version>.exe`) appears in `release/`. Run it, and
Bloom gets a Start menu entry.

Either way, the installed app keeps using the same database as `npm start`, so
your courses follow you.

These builds are **unsigned**. That's fine on the machine you built them on, but
if you copy a build to another computer, macOS Gatekeeper and Windows SmartScreen
will warn that it's from an unidentified developer. Building on the machine
you'll run it on avoids that.

---

## Spelling

Right-click a red-squiggled word for corrections, or to add it to your
dictionary. The menu also carries the usual edit commands, and on macOS the
Substitutions submenu (smart quotes, dashes, text replacement).

On macOS, *autocorrect-as-you-type* does not exist here and no flag enables it —
Chromium draws its own text fields, so the system setting never reaches them.
What you get is squiggles plus right-click corrections.

## The app icon

Source artwork is `build/icon.svg`. To change it on macOS, edit the SVG and
re-run:

```bash
cd build && sips -s format png icon.svg --out icon.png
```

then regenerate `icon.icns` with the `sips`/`iconutil` pipeline and `npm run dist`.
macOS caches icons aggressively — `touch /Applications/Bloom.app && killall Dock`
if the old one lingers. (`sips` and `iconutil` are macOS-only; on Windows, export
the PNG with any SVG editor.)

## Where your data lives

Running from source, everything stays in `data/` inside your checkout:

```
data/
├── bloom.db     courses, lessons, annotations, feedback, activity
├── uploads/     the files you uploaded, byte-for-byte
└── scratch/     empty working directory handed to the CLI
```

A packaged app reuses the checkout's `data/` folder, recorded when you built it.
If that folder is gone (you moved or deleted the checkout), it falls back to:

- **macOS:** a `Bloom Data` folder beside `Bloom.app`
- **Windows:** `%APPDATA%\bloom-local\data`

Nothing leaves your machine except the prompts sent to Claude (or Codex, if you
pick a GPT model). The server binds to `127.0.0.1` and is not reachable from the
network.

To start over, delete `data/` — it rebuilds itself on next launch. To put the
data somewhere else, set `BLOOM_DATA_DIR`, which overrides everything above.

macOS (bash or zsh):

```bash
BLOOM_DATA_DIR="$HOME/Documents/Bloom Data" npm start
```

Windows (PowerShell):

```powershell
$env:BLOOM_DATA_DIR = "$HOME\Documents\Bloom Data"
npm start
```

---

## Notes on the port

The upstream backend is Python/FastAPI. This version is Node/Express so the whole
app is one runtime and one process inside Electron — no Python environment to
manage, and the backend runs inside the Electron main process rather than as a
separate server.

The upstream prompts are Chinese-only; they've been translated to English here,
with the pedagogy and output structure unchanged.

`better-sqlite3` is a native module and is compiled against Electron's ABI, which
is why `npm run serve` also runs through Electron (`ELECTRON_RUN_AS_NODE=1`)
rather than plain `node`. `npm install` handles the rebuild automatically.

---

## Credits

The original design, pedagogy and prompts are from
[Li-Evan/Bloom](https://github.com/Li-Evan/Bloom), MIT licensed. This repository
is a port of that work.

Bloom local is MIT licensed — see [LICENSE](LICENSE).
