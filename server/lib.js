/** Text utilities shared by the routes. */

/** Split on any line ending. A stray \r otherwise defeats every line regex. */
export const splitLines = (text) => String(text ?? '').split(/\r\n|\r|\n/);

const FENCE_OPEN = /^```(?:markdown|md)?\s*\n?/i;
const FENCE_CLOSE = /\n?```\s*$/;

/** Models often wrap the whole answer in a ```markdown fence. Peel it off. */
export function stripFences(text) {
  let out = (text ?? '').trim();
  if (FENCE_OPEN.test(out)) {
    out = out.replace(FENCE_OPEN, '').replace(FENCE_CLOSE, '');
  }
  return out.trim();
}

export function extractTitle(content, fallback = 'Untitled lesson') {
  for (const line of splitLines(content)) {
    const m = line.match(/^#\s+(.+)$/);
    if (m) return m[1].trim();
  }
  return fallback;
}

/**
 * Pull the "Questions to think about" block out of a lesson so it can be fed
 * back verbatim when generating the next one. Without this the model
 * paraphrases the questions and the review drifts off the originals.
 */
export function extractThoughtQuestions(content) {
  if (!content) return '';
  const m = content.match(
    /^##\s*Questions to think about\s*$\n([\s\S]*?)(?=^##\s|\Z)/m,
  );
  return m ? m[1].trim() : '';
}

/** Mastery checkboxes look like `- [ ] Able to …` / `- [x] Able to …`. */
export function countMastery(syllabus) {
  const text = syllabus ?? '';
  const total = (text.match(/^- \[[ xX]\]/gm) || []).length;
  const done = (text.match(/^- \[[xX]\]/gm) || []).length;
  return { done, total };
}

export function masteryProgress(syllabus) {
  const { done, total } = countMastery(syllabus);
  return total === 0 ? 0 : done / total;
}

export function allMasteryDone(syllabus) {
  const { done, total } = countMastery(syllabus);
  return total > 0 && done === total;
}

/**
 * Read the `<!-- mastery: item; item -->` comment a lesson ends with.
 *
 * Takes the LAST such comment, and forbids `-->` inside the captured span, so
 * a stray `<!-- mastery:` earlier in the prose can't swallow the whole body.
 */
export function extractMasteryClaims(lessonContent) {
  const all = [...String(lessonContent ?? '').matchAll(/<!--\s*mastery:\s*((?:(?!-->)[\s\S])*?)\s*-->/g)];
  if (all.length === 0) return [];
  return all[all.length - 1][1]
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Make arbitrary text safe inside a GFM table cell.
 * Backslashes first — escaping pipes first would turn a trailing `\` into
 * `\\|`, which GFM reads as an escaped backslash plus a live cell delimiter.
 * Comment markers are neutralised because the renderer strips HTML comments.
 */
const escapeCell = (s) =>
  String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/<!--/g, '&lt;!--')
    .replace(/-->/g, '--&gt;')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Rebuild the syllabus "## Progress" table from the course's lessons.
 *
 * The syllabus template ships this table with headers only, and nothing was
 * ever writing rows into it. Deriving it from the lessons on read means it is
 * always accurate and backfills courses that predate this.
 */
export function withProgressTable(syllabus, lessons) {
  const rows = (lessons ?? []).filter(Boolean).map((l) => {
    const items = extractMasteryClaims(l.content);
    const covered = items.length
      ? items.map(escapeCell).join('; ')
      : l.is_evaluation
        ? 'Final assessment — no new items'
        : '—';
    return `| ${String(l.number).padStart(2, '0')} · ${escapeCell(l.title || 'Untitled')} | ${covered} | ${String(l.created_at ?? '').slice(0, 10)} |`;
  });

  const table = [
    '| Lesson | Mastery items covered | Date |',
    '|--------|----------------------|------|',
    ...(rows.length ? rows : ['| — | Nothing yet | — |']),
  ].join('\n');

  const lines = splitLines(syllabus);

  // Find the heading, ignoring any that sits inside a fenced code block.
  let start = -1;
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
    else if (!inFence && /^##\s+Progress\s*$/i.test(lines[i])) {
      start = i;
      break;
    }
  }

  if (start === -1) {
    if (!syllabus) return syllabus;
    return `${syllabus.trimEnd()}\n\n## Progress\n\n${table}\n`;
  }

  // Replace ONLY the existing table — blank lines and rows starting with `|`.
  // Scanning to the next `## ` instead would swallow any h1/h3/prose that
  // happens to follow, taking its mastery checkboxes with it.
  let end = start + 1;
  while (end < lines.length && lines[end].trim() === '') end += 1;
  while (end < lines.length && /^\s*\|/.test(lines[end])) end += 1;

  const tail = lines.slice(end);
  // Keep exactly one blank line before whatever follows.
  while (tail.length && tail[0].trim() === '') tail.shift();

  return [
    ...lines.slice(0, start + 1),
    '',
    table,
    ...(tail.length ? ['', ...tail] : ['']),
  ].join('\n');
}

/**
 * Each lesson ends with `<!-- mastery: item; item -->`. Tick the matching
 * syllabus checkboxes so progress advances without the learner doing it.
 */
export function autoCheckMastery(syllabus, lessonContent) {
  const claimed = extractMasteryClaims(lessonContent);
  if (claimed.length === 0) return syllabus;

  const norm = (s) => s.toLowerCase().replace(/[\s.,;:!?…"'`]+/g, ' ').trim();
  const wanted = claimed.map(norm);

  return splitLines(syllabus)
    .map((line) => {
      const box = line.match(/^(\s*)- \[ \]\s+(.*)$/);
      if (!box) return line;
      const itemText = norm(box[2]);
      const hit = wanted.some(
        (w) => itemText === w || itemText.includes(w) || w.includes(itemText),
      );
      return hit ? `${box[1]}- [x] ${box[2]}` : line;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Syllabus revision
//
// Learner feedback can change the plan. The danger is that the mastery tick
// state lives inside the same markdown blob as the items themselves, so one
// bad regeneration would silently wipe the learner's progress.
//
// The defence is structural rather than behavioural: the model never sees or
// emits checkbox syntax. It sees a numbered view and returns operations keyed
// by integer id; every output line is either carried over byte-for-byte or
// rebuilt here. Losing a tick is therefore not possible, rather than unlikely.
// ---------------------------------------------------------------------------

const CHECKBOX_RE = /^(\s*)- \[([ xX])\]\s+(.*)$/;
const MODULE_RE = /^###\s+(.+)$/;

const normItem = (s) =>
  String(s).toLowerCase().replace(/[\s.,;:!?…"'`]+/g, ' ').trim();

/**
 * Flatten model-supplied item text to a single safe line.
 *
 * Without this, one `add` op whose text contains a newline injects extra
 * syllabus lines — and if those parse as checkboxes the item count silently
 * inflates. Collapsing all whitespace makes that structurally impossible.
 */
function sanitizeItemText(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim();
}

/** Index a syllabus into its modules and checkbox items, in document order. */
export function indexSyllabus(text) {
  const lines = splitLines(text);
  const items = [];
  const modules = [];
  let mid = 0;

  lines.forEach((line, i) => {
    const mod = line.match(MODULE_RE);
    if (mod) {
      mid += 1;
      modules.push({ mid, lineNo: i, name: mod[1].trim(), lastItemLine: i });
      return;
    }
    const box = line.match(CHECKBOX_RE);
    if (box) {
      items.push({
        id: items.length + 1,
        lineNo: i,
        done: box[2] !== ' ',
        indent: box[1],
        text: box[3].trim(),
        mid,
      });
      if (modules.length) modules[modules.length - 1].lastItemLine = i;
    }
  });

  return { lines, items, modules };
}

/** The only representation of the syllabus the reviser model ever sees. */
export function revisionView(idx) {
  const out = [];
  for (const m of idx.modules) {
    out.push(`[M${m.mid}] ${m.name}`);
    for (const it of idx.items.filter((x) => x.mid === m.mid)) {
      out.push(`  [${it.id}] (${it.done ? 'already taught' : 'planned'}) ${it.text}`);
    }
  }
  // Items before any module heading still need to be offered.
  for (const it of idx.items.filter((x) => x.mid === 0)) {
    out.push(`  [${it.id}] (${it.done ? 'already taught' : 'planned'}) ${it.text}`);
  }
  return out.join('\n');
}

/** The exact set of ticked lines — the invariant that must survive a revision. */
export function tickedLines(text) {
  return splitLines(text)
    .filter((l) => /^\s*- \[[xX]\]/.test(l))
    .map((l) => l.trim());
}

/**
 * Apply a validated op patch to a syllabus.
 * Returns { text, applied, rejected } — `rejected` carries human-readable
 * reasons so a bad patch fails loudly in the log rather than silently.
 */
export function applySyllabusOps(syllabus, ops) {
  const idx = indexSyllabus(syllabus);
  const byId = new Map(idx.items.map((i) => [i.id, i]));
  const applied = [];
  const rejected = [];
  // Running set of item texts, used to catch substring clashes that would make
  // autoCheckMastery's bidirectional match tick the wrong rows later.
  const live = idx.items.map((i) => ({ id: i.id, n: normItem(i.text) }));

  for (const raw of Array.isArray(ops) ? ops.slice(0, 4) : []) {
    const op = raw?.op;
    if (!['add', 'drop', 'reword'].includes(op)) {
      rejected.push(`unknown op: ${op}`);
      continue;
    }

    if (op === 'drop' || op === 'reword') {
      const it = byId.get(Number(raw.id));
      if (!it) {
        rejected.push(`unknown item id: ${raw.id}`);
        continue;
      }
      // Taught items are frozen, not merely preserved.
      if (it.done) {
        rejected.push(`refused to ${op} an already-taught item (${raw.id})`);
        continue;
      }
    }

    if (op === 'add' || op === 'reword') {
      const t = sanitizeItemText(raw.text);
      if (t.length < 12 || t.length > 400) {
        rejected.push('item text out of range');
        continue;
      }
      // Markdown or comment syntax inside an item would change the document's
      // structure rather than its content.
      if (/[-*+]\s*\[[ xX]?\]/.test(t)) {
        rejected.push('item text contains checkbox syntax');
        continue;
      }
      if (/<!--|-->/.test(t)) {
        rejected.push('item text contains an HTML comment');
        continue;
      }
      if (/^#{1,6}\s/.test(t)) {
        rejected.push('item text is a heading');
        continue;
      }
      if (/^(understand|be familiar|know about|learn about|get comfortable)\b/i.test(t)) {
        rejected.push('not a verifiable behaviour');
        continue;
      }
      // Carry the cleaned text forward — the raw value is never used again.
      raw.text = t;
      const n = normItem(t);
      const clash = live.some((e) =>
        op === 'reword' && e.id === Number(raw.id)
          ? false
          : e.n === n || e.n.includes(n) || n.includes(e.n),
      );
      if (clash) {
        rejected.push('would overlap an existing item and corrupt auto-ticking');
        continue;
      }
      if (op === 'reword') {
        const entry = live.find((x) => x.id === Number(raw.id));
        if (entry) entry.n = n;
      } else {
        live.push({ id: null, n });
      }
    }

    applied.push(raw);
  }

  const lines = idx.lines.slice();
  const dropped = new Set();
  const insertAfter = new Map();

  for (const o of applied) {
    if (o.op === 'drop') {
      dropped.add(byId.get(Number(o.id)).lineNo);
    } else if (o.op === 'reword') {
      const it = byId.get(Number(o.id));
      // Rebuilt here, always unticked — model text never becomes a raw line.
      lines[it.lineNo] = `${it.indent}- [ ] ${String(o.text).trim()}`;
    } else {
      const anchor = byId.get(Number(o.after));
      const mod = idx.modules.find(
        (m) => m.mid === Number(String(o.module ?? '').replace(/^M/i, '')),
      );
      const at = anchor
        ? anchor.lineNo
        : mod
          ? mod.lastItemLine
          : (idx.items.at(-1)?.lineNo ?? lines.length - 1);
      if (!insertAfter.has(at)) insertAfter.set(at, []);
      insertAfter.get(at).push(String(o.text).trim());
    }
  }

  const out = [];
  lines.forEach((line, i) => {
    if (!dropped.has(i)) out.push(line);
    // Column 0 — countMastery anchors on ^- \[ and would not see an indent.
    for (const t of insertAfter.get(i) ?? []) out.push(`- [ ] ${t}`);
  });

  return { text: out.join('\n'), applied, rejected };
}

/** Plain-English description of what a revision did, for the reader UI. */
export function describeOps(applied, idx) {
  const byId = new Map(idx.items.map((i) => [i.id, i]));
  return applied.map((o) => {
    if (o.op === 'add') return `Added: ${o.text}`;
    if (o.op === 'drop') return `Removed: ${byId.get(Number(o.id))?.text ?? o.id}`;
    return `Reworded: ${byId.get(Number(o.id))?.text ?? o.id} → ${o.text}`;
  });
}

export function formatAnnotations(rows) {
  if (!rows || rows.length === 0) return '';
  return rows
    .map((a, i) => {
      const thread = safeJson(a.messages, []);
      const followUps = thread
        .slice(2) // the first user/assistant pair is question + answer
        .map((m) => `  ${m.role === 'user' ? 'Follow-up' : 'Answer'}: ${m.content}`)
        .join('\n');
      return [
        `${i + 1}. Highlighted: "${a.quote}"`,
        `   Asked: ${a.question}`,
        a.answer ? `   Answered: ${a.answer}` : '',
        followUps,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

export function safeJson(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

/** Trim oversized source text so a single call cannot blow the context window. */
export function clampText(text, maxChars) {
  const t = text ?? '';
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars)}\n\n…[source truncated at ${maxChars.toLocaleString()} characters]`;
}

// ---------------------------------------------------------------------------
// Server-sent events
// ---------------------------------------------------------------------------

export function openSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

export function sendSSE(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
