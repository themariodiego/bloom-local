/** Text utilities shared by the routes. */

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
  for (const line of (content ?? '').split('\n')) {
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

/** Read the `<!-- mastery: item; item -->` comment a lesson ends with. */
export function extractMasteryClaims(lessonContent) {
  const m = (lessonContent ?? '').match(/<!--\s*mastery:\s*(.+?)\s*-->/s);
  if (!m) return [];
  return m[1]
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

const escapePipes = (s) => String(s).replace(/\|/g, '\\|').replace(/\n+/g, ' ');

/**
 * Rebuild the syllabus "## Progress" table from the course's lessons.
 *
 * The syllabus template ships this table with headers only, and nothing was
 * ever writing rows into it. Deriving it from the lessons on read means it is
 * always accurate and backfills courses that predate this.
 */
export function withProgressTable(syllabus, lessons) {
  const rows = (lessons ?? []).map((l) => {
    const items = extractMasteryClaims(l.content);
    const covered = items.length
      ? items.map(escapePipes).join('; ')
      : l.is_evaluation
        ? 'Final assessment — no new items'
        : '—';
    return `| ${String(l.number).padStart(2, '0')} · ${escapePipes(l.title || 'Untitled')} | ${covered} | ${(l.created_at ?? '').slice(0, 10)} |`;
  });

  const table = [
    '| Lesson | Mastery items covered | Date |',
    '|--------|----------------------|------|',
    ...(rows.length ? rows : ['| — | Nothing yet | — |']),
  ].join('\n');

  const lines = (syllabus ?? '').split('\n');
  const start = lines.findIndex((l) => /^##\s+Progress\s*$/i.test(l));

  if (start === -1) {
    if (!syllabus) return syllabus;
    return `${syllabus.trimEnd()}\n\n## Progress\n\n${table}\n`;
  }

  // Replace everything between the heading and the next `## ` heading.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start + 1), '', table, '', ...lines.slice(end)].join('\n');
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

  return (syllabus ?? '')
    .split('\n')
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

/** Index a syllabus into its modules and checkbox items, in document order. */
export function indexSyllabus(text) {
  const lines = (text ?? '').split('\n');
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
  return (text ?? '')
    .split('\n')
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
      const t = String(raw.text ?? '').trim();
      if (t.length < 12 || t.length > 400) {
        rejected.push('item text out of range');
        continue;
      }
      if (/^(understand|be familiar|know about|learn about|get comfortable)\b/i.test(t)) {
        rejected.push('not a verifiable behaviour');
        continue;
      }
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
