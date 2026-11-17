import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { db, recordEvent } from './db.js';
import { UPLOADS_DIR } from './paths.js';
import {
  MODELS,
  DEFAULT_MODEL,
  resolveModel,
  runClaude,
  callClaude,
  checkClaude,
  ClaudeError,
} from './claude.js';
import * as P from './prompts.js';
import {
  stripFences,
  extractTitle,
  extractThoughtQuestions,
  countMastery,
  allMasteryDone,
  autoCheckMastery,
  withProgressTable,
  indexSyllabus,
  revisionView,
  applySyllabusOps,
  tickedLines,
  describeOps,
  formatAnnotations,
  safeJson,
  clampText,
  openSSE,
  sendSSE,
} from './lib.js';

const MAX_SOURCE_CHARS = 400_000;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024 },
});

export const router = express.Router();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const getCourse = (id) =>
  db.prepare('SELECT * FROM courses WHERE id = ?').get(id);

const getSyllabus = (courseId) =>
  db.prepare('SELECT * FROM syllabi WHERE course_id = ?').get(courseId);

const getLesson = (courseId, number) =>
  db
    .prepare('SELECT * FROM lessons WHERE course_id = ? AND number = ?')
    .get(courseId, number);

const lessonAnnotations = (lessonId) =>
  db
    .prepare('SELECT * FROM annotations WHERE lesson_id = ? ORDER BY id')
    .all(lessonId);

function courseShape(course) {
  const syllabus = getSyllabus(course.id);
  const { done, total } = countMastery(syllabus?.content ?? '');
  const lessonCount = db
    .prepare('SELECT COUNT(*) AS n FROM lessons WHERE course_id = ?')
    .get(course.id).n;
  return {
    id: course.id,
    name: course.name,
    mode: course.mode,
    status: course.status,
    depth: course.depth,
    model: course.model,
    sourceName: course.source_name,
    createdAt: course.created_at,
    lessonCount,
    mastery: { done, total, progress: total ? done / total : 0 },
    hasSummary: Boolean(course.summary),
  };
}

/** Wrap an async handler so rejections become clean JSON errors. */
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Stream a generation to the client over SSE, then run `onDone` with the
 * finished text. Errors are delivered as an SSE `error` payload so the UI can
 * show them inline rather than the fetch just dying.
 */
async function streamGeneration(res, { system, prompt, model, onDone, preamble }) {
  openSSE(res);
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  try {
    // Runs after the headers are out, so it can emit its own SSE events
    // (used by the syllabus reviser, which must finish before the lesson).
    if (preamble) await preamble((payload) => sendSSE(res, payload), controller.signal);

    // The preamble can take seconds. If the learner hit Cancel during it, stop
    // here — otherwise we'd generate and save a lesson they already cancelled.
    if (controller.signal.aborted) return;

    const raw = await runClaude({
      // A function defers building the prompt until after the preamble, so it
      // can pick up a syllabus the preamble revised.
      system: typeof system === 'function' ? system() : system,
      prompt,
      model,
      signal: controller.signal,
      onDelta: (text) => sendSSE(res, { type: 'delta', text }),
    });
    const finished = stripFences(raw);
    const extra = (await onDone?.(finished)) ?? {};
    sendSSE(res, { type: 'done', content: finished, ...extra });
  } catch (err) {
    sendSSE(res, {
      type: 'error',
      kind: err instanceof ClaudeError ? err.kind : 'unknown',
      message: err.message || 'Generation failed.',
    });
  } finally {
    res.end();
  }
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

router.get('/models', (_req, res) => {
  res.json({ models: MODELS, default: DEFAULT_MODEL });
});

router.get(
  '/health',
  wrap(async (_req, res) => {
    res.json(await checkClaude());
  }),
);

// ---------------------------------------------------------------------------
// Courses
// ---------------------------------------------------------------------------

router.get('/courses', (_req, res) => {
  const rows = db.prepare('SELECT * FROM courses ORDER BY id DESC').all();
  res.json(rows.map(courseShape));
});

router.get('/courses/:id', (req, res) => {
  const course = getCourse(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });

  // `content` is needed for the mastery comment that feeds the Progress table.
  const lessons = db
    .prepare(
      `SELECT id, number, title, content, is_evaluation, is_source, file_name, created_at
         FROM lessons WHERE course_id = ? ORDER BY number`,
    )
    .all(course.id);

  res.json({
    ...courseShape(course),
    reference: course.reference,
    summary: course.summary,
    syllabus: withProgressTable(getSyllabus(course.id)?.content ?? '', lessons),
    lessons: lessons.map((l) => ({
      id: l.id,
      number: l.number,
      title: l.title,
      isEvaluation: Boolean(l.is_evaluation),
      isSource: Boolean(l.is_source),
      fileName: l.file_name,
      createdAt: l.created_at,
    })),
  });
});

router.delete('/courses/:id', (req, res) => {
  const info = db.prepare('DELETE FROM courses WHERE id = ?').run(req.params.id);
  if (info.changes === 0)
    return res.status(404).json({ error: 'Course not found' });
  res.json({ ok: true });
});

/**
 * Topic mode: generate a syllabus, then lesson 01. Both stream, one after the
 * other, over a single SSE connection so the UI can show progress throughout.
 */
router.post(
  '/courses',
  wrap(async (req, res) => {
    const name = (req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'A subject is required' });

    const depth = ['simple', 'standard', 'deep'].includes(req.body?.depth)
      ? req.body.depth
      : 'standard';
    const model = resolveModel(req.body?.model);
    const reference = (req.body?.reference ?? '').trim();

    const courseId = db
      .prepare(
        `INSERT INTO courses (name, mode, depth, model, reference)
         VALUES (?, 'topic', ?, ?, ?)`,
      )
      .run(name, depth, model, reference).lastInsertRowid;

    openSSE(res);
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    try {
      sendSSE(res, { type: 'stage', stage: 'syllabus', courseId });
      const syllabusRaw = await runClaude({
        system: P.SYLLABUS_PROMPT(depth, clampText(reference, 60_000)),
        prompt: `The subject I want to learn: ${name}`,
        model,
        signal: controller.signal,
        onDelta: (text) => sendSSE(res, { type: 'delta', channel: 'syllabus', text }),
      });
      const syllabus = stripFences(syllabusRaw);
      db.prepare('INSERT INTO syllabi (course_id, content) VALUES (?, ?)').run(
        courseId,
        syllabus,
      );
      sendSSE(res, { type: 'syllabus', content: syllabus });

      sendSSE(res, { type: 'stage', stage: 'lesson' });
      const lessonRaw = await runClaude({
        system: P.FIRST_LESSON_PROMPT(syllabus),
        prompt: `Write lesson 01 for: ${name}`,
        model,
        signal: controller.signal,
        onDelta: (text) => sendSSE(res, { type: 'delta', channel: 'lesson', text }),
      });
      const lesson = stripFences(lessonRaw);

      db.prepare(
        'INSERT INTO lessons (course_id, number, title, content) VALUES (?, 1, ?, ?)',
      ).run(courseId, extractTitle(lesson, 'Lesson 01'), lesson);

      const ticked = autoCheckMastery(syllabus, lesson);
      if (ticked !== syllabus) {
        db.prepare('UPDATE syllabi SET content = ? WHERE course_id = ?').run(
          ticked,
          courseId,
        );
      }
      recordEvent(courseId, 'lesson_created', 1);
      sendSSE(res, { type: 'done', courseId, lessonNumber: 1 });
    } catch (err) {
      // Roll the half-built course back so the dashboard stays clean.
      db.prepare('DELETE FROM courses WHERE id = ?').run(courseId);
      sendSSE(res, {
        type: 'error',
        kind: err instanceof ClaudeError ? err.kind : 'unknown',
        message: err.message || 'Could not create the course.',
      });
    } finally {
      res.end();
    }
  }),
);

/** Source mode: upload a PDF/TXT/MD, get a syllabus plus a reading lesson. */
router.post(
  '/courses/from-source',
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'A file is required' });

    const model = resolveModel(req.body?.model);
    const depth = ['simple', 'standard', 'deep'].includes(req.body?.depth)
      ? req.body.depth
      : 'standard';

    let text;
    try {
      text = await extractText(req.file);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!text.trim())
      return res
        .status(400)
        .json({ error: 'No readable text found in that file.' });

    const name = (req.body?.name ?? '').trim() || stripExt(req.file.originalname);
    const source = clampText(text, MAX_SOURCE_CHARS);

    const courseId = db
      .prepare(
        `INSERT INTO courses (name, mode, depth, model, source_name, source_content)
         VALUES (?, 'source', ?, ?, ?, ?)`,
      )
      .run(name, depth, model, req.file.originalname, source).lastInsertRowid;

    try {
      const syllabus = stripFences(
        await callClaude({
          system: P.SYLLABUS_PROMPT(depth, ''),
          prompt: `The subject is the document below. Build the syllabus from what this document actually covers.\n\nFilename: ${req.file.originalname}\n\n${clampText(source, 120_000)}`,
          model,
        }),
      );
      db.prepare('INSERT INTO syllabi (course_id, content) VALUES (?, ?)').run(
        courseId,
        syllabus,
      );

      // Lesson 01 is the source itself, rendered for highlighting.
      const stored = `${randomUUID()}${path.extname(req.file.originalname)}`;
      writeFileSync(path.join(UPLOADS_DIR, stored), req.file.buffer);

      const body = P.SOURCE_READING_LESSON(req.file.originalname) + source;
      db.prepare(
        `INSERT INTO lessons (course_id, number, title, content, is_source, file_name, file_path)
         VALUES (?, 1, ?, ?, 1, ?, ?)`,
      ).run(
        courseId,
        `Reading: ${req.file.originalname}`,
        body,
        req.file.originalname,
        stored,
      );

      recordEvent(courseId, 'lesson_created', 1);
      res.json({ courseId, lessonNumber: 1 });
    } catch (err) {
      db.prepare('DELETE FROM courses WHERE id = ?').run(courseId);
      res.status(502).json({
        error: err.message || 'Could not build a course from that file.',
        kind: err instanceof ClaudeError ? err.kind : 'unknown',
      });
    }
  }),
);

/** Project mode: each file becomes its own page. No syllabus, no next-lesson. */
router.post(
  '/courses/from-project',
  upload.array('files', 100),
  wrap(async (req, res) => {
    const files = req.files ?? [];
    if (files.length === 0)
      return res.status(400).json({ error: 'At least one file is required' });

    const model = resolveModel(req.body?.model);
    const name =
      (req.body?.name ?? '').trim() ||
      `Project · ${files.length} file${files.length === 1 ? '' : 's'}`;

    const courseId = db
      .prepare(
        `INSERT INTO courses (name, mode, depth, model) VALUES (?, 'project', 'standard', ?)`,
      )
      .run(name, model).lastInsertRowid;

    let number = 0;
    for (const file of files) {
      let text;
      try {
        text = await extractText(file);
      } catch {
        continue; // skip unreadable files rather than failing the whole upload
      }
      if (!text.trim()) continue;

      number += 1;
      const stored = `${randomUUID()}${path.extname(file.originalname)}`;
      writeFileSync(path.join(UPLOADS_DIR, stored), file.buffer);

      db.prepare(
        `INSERT INTO lessons (course_id, number, title, content, is_source, file_name, file_path)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        courseId,
        number,
        file.originalname,
        `# ${file.originalname}\n\n${clampText(text, MAX_SOURCE_CHARS)}`,
        file.originalname,
        stored,
      );
    }

    if (number === 0) {
      db.prepare('DELETE FROM courses WHERE id = ?').run(courseId);
      return res
        .status(400)
        .json({ error: 'None of those files had readable text.' });
    }

    recordEvent(courseId, 'lesson_created', 1);
    res.json({ courseId, lessonNumber: 1, fileCount: number });
  }),
);

router.put('/courses/:id/model', (req, res) => {
  const course = getCourse(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const model = resolveModel(req.body?.model);
  db.prepare('UPDATE courses SET model = ? WHERE id = ?').run(model, course.id);
  res.json({ model });
});

router.put('/courses/:id/syllabus', (req, res) => {
  const course = getCourse(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const content = req.body?.content ?? '';
  db.prepare(
    `INSERT INTO syllabi (course_id, content) VALUES (?, ?)
     ON CONFLICT(course_id) DO UPDATE SET content = excluded.content`,
  ).run(course.id, content);
  res.json({ content });
});

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

router.get('/courses/:id/lessons/:num', (req, res) => {
  const course = getCourse(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });

  const lesson = getLesson(course.id, req.params.num);
  if (!lesson) return res.status(404).json({ error: 'Lesson not found' });

  const fb = db
    .prepare('SELECT * FROM feedback WHERE lesson_id = ?')
    .get(lesson.id);

  res.json({
    id: lesson.id,
    number: lesson.number,
    title: lesson.title,
    content: lesson.content,
    isEvaluation: Boolean(lesson.is_evaluation),
    isSource: Boolean(lesson.is_source),
    fileName: lesson.file_name,
    hasFile: Boolean(lesson.file_path),
    createdAt: lesson.created_at,
    feedback: fb
      ? { content: fb.content, thoughtAnswers: fb.thought_answers }
      : { content: '', thoughtAnswers: '' },
    annotations: lessonAnnotations(lesson.id).map(annotationShape),
  });
});

router.get('/courses/:id/lessons/:num/file', (req, res) => {
  const lesson = getLesson(req.params.id, req.params.num);
  if (!lesson?.file_path)
    return res.status(404).json({ error: 'No file for this lesson' });

  const full = path.join(UPLOADS_DIR, path.basename(lesson.file_path));
  if (!existsSync(full))
    return res.status(404).json({ error: 'File is missing from disk' });

  const isPdf = (lesson.file_name ?? '').toLowerCase().endsWith('.pdf');
  res.setHeader(
    'Content-Type',
    isPdf ? 'application/pdf' : 'application/octet-stream',
  );
  res.send(readFileSync(full));
});

router.post('/courses/:id/lessons/:num/opened', (req, res) => {
  const lesson = getLesson(req.params.id, req.params.num);
  if (!lesson) return res.status(404).json({ error: 'Lesson not found' });
  recordEvent(Number(req.params.id), 'lesson_opened', lesson.number);
  res.json({ ok: true });
});

router.post('/courses/:id/lessons/:num/feedback', (req, res) => {
  const lesson = getLesson(req.params.id, req.params.num);
  if (!lesson) return res.status(404).json({ error: 'Lesson not found' });

  db.prepare(
    `INSERT INTO feedback (lesson_id, content, thought_answers) VALUES (?, ?, ?)
     ON CONFLICT(lesson_id) DO UPDATE
       SET content = excluded.content, thought_answers = excluded.thought_answers`,
  ).run(lesson.id, req.body?.content ?? '', req.body?.thoughtAnswers ?? '');

  recordEvent(Number(req.params.id), 'feedback_submitted', lesson.number);
  res.json({ ok: true });
});

/**
 * "Done reading" — generate whatever comes next: the next lesson, the final
 * assessment once every mastery item is ticked, or the course summary once the
 * assessment has been read.
 */
router.post(
  '/courses/:id/next',
  wrap(async (req, res) => {
    const course = getCourse(req.params.id);
    if (!course) return res.status(404).json({ error: 'Course not found' });
    if (course.mode === 'project')
      return res
        .status(400)
        .json({ error: 'Project courses do not generate lessons.' });

    const model = resolveModel(req.body?.model ?? course.model);
    const syllabus = getSyllabus(course.id)?.content ?? '';
    const lessons = db
      .prepare('SELECT * FROM lessons WHERE course_id = ? ORDER BY number')
      .all(course.id);
    const last = lessons[lessons.length - 1];
    if (!last) return res.status(400).json({ error: 'This course has no lessons.' });

    const fb = db
      .prepare('SELECT * FROM feedback WHERE lesson_id = ?')
      .get(last.id);
    const feedbackText = [
      fb?.content ? `Written feedback:\n${fb.content}` : '',
      fb?.thought_answers
        ? `Answers to the thinking questions:\n${fb.thought_answers}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const annotations = formatAnnotations(lessonAnnotations(last.id));

    // The assessment has been read → write the summary and close the course.
    if (last.is_evaluation) {
      const allLessons = lessons
        .map((l) => `### Lesson ${l.number}: ${l.title}\n\n${l.content}`)
        .join('\n\n---\n\n');
      return streamGeneration(res, {
        model,
        system: P.SUMMARY_PROMPT({
          syllabus,
          allLessons: clampText(allLessons, 300_000),
        }),
        prompt: `Write the summary for: ${course.name}`,
        onDone: (content) => {
          db.prepare(
            "UPDATE courses SET summary = ?, status = 'completed' WHERE id = ?",
          ).run(content, course.id);
          recordEvent(course.id, 'course_completed', last.number);
          return { kind: 'summary' };
        },
      });
    }

    const nextNumber = last.number + 1;
    const lastQuestions = extractThoughtQuestions(last.content);

    // Every mastery item ticked → the final assessment.
    if (allMasteryDone(syllabus)) {
      return streamGeneration(res, {
        model,
        system: P.EVAL_PROMPT({
          syllabus,
          lastLesson: clampText(last.content, 120_000),
          feedback: feedbackText,
          annotations,
          lastQuestions,
        }),
        prompt: `Write the final assessment for: ${course.name}`,
        onDone: (content) => {
          db.prepare(
            `INSERT INTO lessons (course_id, number, title, content, is_evaluation)
             VALUES (?, ?, ?, ?, 1)`,
          ).run(
            course.id,
            nextNumber,
            extractTitle(content, 'Final assessment'),
            content,
          );
          recordEvent(course.id, 'lesson_created', nextNumber);
          return { kind: 'evaluation', lessonNumber: nextNumber };
        },
      });
    }

    // The learner's feedback may mean the plan itself should change. That has
    // to happen BEFORE the lesson is written, otherwise the lesson is taught
    // from the old plan and the correction arrives one lesson late.
    // `syllabusNow` is what the lesson prompt ends up teaching from.
    let syllabusNow = syllabus;

    const preamble = async (emit, signal) => {
      if (!feedbackText.trim()) return; // nothing said, nothing to revise
      emit({ type: 'stage', stage: 'reviewing-plan' });
      const change = await reviseSyllabus({
        course,
        syllabus,
        feedbackText,
        annotations,
        signal,
      });
      if (!change) return;
      syllabusNow = change.text;
      emit({ type: 'syllabus_revised', reason: change.reason, changes: change.changes });
    };

    // Source mode's second lesson works from the full document.
    const buildSystem = () =>
      course.mode === 'source' && last.is_source
        ? P.SOURCE_LESSON_PROMPT({
            syllabus: syllabusNow,
            sourceName: course.source_name ?? '',
            sourceContent: clampText(course.source_content ?? '', 200_000),
            annotations,
            lessonNumber: nextNumber,
          })
        : P.NEXT_LESSON_PROMPT({
            syllabus: syllabusNow,
            previousLessons: clampText(
              lessons
                .map((l) => `### Lesson ${l.number}: ${l.title}\n\n${l.content}`)
                .join('\n\n---\n\n'),
              200_000,
            ),
            feedback: feedbackText,
            annotations,
            lastQuestions,
            lessonNumber: nextNumber,
          });

    return streamGeneration(res, {
      model,
      preamble,
      system: buildSystem, // deferred: picks up any revision the preamble made

      prompt: `Write lesson ${String(nextNumber).padStart(2, '0')} for: ${course.name}`,
      onDone: (content) => {
        db.prepare(
          'INSERT INTO lessons (course_id, number, title, content) VALUES (?, ?, ?, ?)',
        ).run(
          course.id,
          nextNumber,
          extractTitle(content, `Lesson ${nextNumber}`),
          content,
        );
        // Re-read rather than reusing the copy taken minutes ago, or a syllabus
        // revision (or a manual edit) made in the meantime would be reverted.
        const current = getSyllabus(course.id)?.content ?? syllabusNow;
        const ticked = autoCheckMastery(current, content);
        if (ticked !== current) {
          db.prepare('UPDATE syllabi SET content = ? WHERE course_id = ?').run(
            ticked,
            course.id,
          );
        }
        recordEvent(course.id, 'lesson_created', nextNumber);
        return { kind: 'lesson', lessonNumber: nextNumber };
      },
    });
  }),
);

/**
 * Ask a cheap model whether the learner's feedback means the plan should
 * change, then apply the result. Returns null when nothing changes.
 *
 * Deliberately runs on Haiku regardless of the course model: this is
 * classification plus a small structured edit, not teaching. It is also gated
 * on the learner actually having written something, so it doesn't fire on
 * every "Done reading".
 */
async function reviseSyllabus({ course, syllabus, feedbackText, annotations, signal }) {
  const idx = indexSyllabus(syllabus);
  if (idx.items.length === 0) return null;

  let parsed;
  try {
    const raw = await runClaude({
      system: P.SYLLABUS_REVISION_PROMPT({
        courseName: course.name,
        view: revisionView(idx),
        feedback: clampText(feedbackText, 8_000),
        annotations: clampText(annotations, 8_000),
      }),
      prompt: 'Does the plan need to change?',
      model: 'claude-haiku-5-5',
      signal,
    });
    const text = stripFences(raw);
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    parsed = safeJson(text.slice(start, end + 1), null);
  } catch (err) {
    // A failed revision must never block the lesson the learner asked for.
    console.warn('[bloom] syllabus revision failed:', err.message);
    return null;
  }

  if (!parsed || !Array.isArray(parsed.ops) || parsed.ops.length === 0) return null;

  // The Haiku call above took seconds. Another writer (a second window, or the
  // auto-tick at the end of a parallel "Done reading") may have touched the
  // syllabus meanwhile. The ops are keyed to line indices from the snapshot, so
  // applying them to changed text would edit the wrong items — and writing the
  // result would revert whatever that other writer just earned.
  const fresh = getSyllabus(course.id)?.content ?? syllabus;
  if (fresh !== syllabus) {
    console.warn('[bloom] syllabus changed while revising — revision discarded');
    return null;
  }

  const before = tickedLines(syllabus);
  const { text, applied, rejected } = applySyllabusOps(syllabus, parsed.ops);
  if (rejected.length) console.warn('[bloom] rejected syllabus ops:', rejected);
  if (applied.length === 0) return null;

  // Belt and braces on top of the structural guarantee: if the tick set moved
  // at all, throw the revision away rather than risk the learner's progress.
  const after = tickedLines(text);
  if (before.length !== after.length || before.some((l, i) => l !== after[i])) {
    console.error('[bloom] syllabus revision would have altered mastery state — discarded');
    return null;
  }

  db.prepare('UPDATE syllabi SET content = ? WHERE course_id = ?').run(text, course.id);
  recordEvent(course.id, 'syllabus_revised');

  return {
    text,
    reason: String(parsed.reason ?? '').slice(0, 400),
    changes: describeOps(applied, idx),
  };
}

// ---------------------------------------------------------------------------
// Highlight Q&A
// ---------------------------------------------------------------------------

function annotationShape(a) {
  return {
    id: a.id,
    quote: a.quote,
    question: a.question,
    answer: a.answer,
    messages: safeJson(a.messages, []),
    anchorTop: a.anchor_top,
    createdAt: a.created_at,
  };
}

/**
 * Multi-turn threads are flattened into one prompt rather than resumed as a
 * CLI session — the threads are short, and it keeps every call stateless.
 */
function threadToPrompt(messages) {
  return messages
    .map((m) => (m.role === 'user' ? `Learner: ${m.content}` : `You: ${m.content}`))
    .join('\n\n');
}

router.post(
  '/courses/:id/lessons/:num/annotations',
  wrap(async (req, res) => {
    const course = getCourse(req.params.id);
    const lesson = getLesson(req.params.id, req.params.num);
    if (!course || !lesson)
      return res.status(404).json({ error: 'Lesson not found' });

    const quote = (req.body?.quote ?? '').trim();
    const question = (req.body?.question ?? '').trim();
    if (!quote || !question)
      return res
        .status(400)
        .json({ error: 'Both the highlighted text and a question are required' });

    const model = resolveModel(req.body?.model ?? course.model);
    const anchorTop = Number(req.body?.anchorTop ?? 0) || 0;

    const id = db
      .prepare(
        `INSERT INTO annotations (lesson_id, quote, question, messages, anchor_top)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        lesson.id,
        quote,
        question,
        JSON.stringify([{ role: 'user', content: question }]),
        anchorTop,
      ).lastInsertRowid;

    recordEvent(course.id, 'annotation_added', lesson.number);

    return streamGeneration(res, {
      model,
      system: P.ANNOTATION_PROMPT({
        courseName: course.name,
        lessonContent: clampText(lesson.content, 150_000),
        quote,
      }),
      prompt: question,
      onDone: (answer) => {
        db.prepare('UPDATE annotations SET answer = ?, messages = ? WHERE id = ?').run(
          answer,
          JSON.stringify([
            { role: 'user', content: question },
            { role: 'assistant', content: answer },
          ]),
          id,
        );
        return { annotationId: id };
      },
    });
  }),
);

router.post(
  '/courses/:id/lessons/:num/annotations/:aid/messages',
  wrap(async (req, res) => {
    const course = getCourse(req.params.id);
    const lesson = getLesson(req.params.id, req.params.num);
    const annotation = db
      .prepare('SELECT * FROM annotations WHERE id = ?')
      .get(req.params.aid);
    if (!course || !lesson || !annotation)
      return res.status(404).json({ error: 'Annotation not found' });

    const question = (req.body?.question ?? '').trim();
    if (!question) return res.status(400).json({ error: 'A question is required' });

    const model = resolveModel(req.body?.model ?? course.model);
    const history = safeJson(annotation.messages, []);
    history.push({ role: 'user', content: question });

    return streamGeneration(res, {
      model,
      system: P.ANNOTATION_PROMPT({
        courseName: course.name,
        lessonContent: clampText(lesson.content, 150_000),
        quote: annotation.quote,
      }),
      prompt: `${threadToPrompt(history.slice(0, -1))}\n\nLearner: ${question}`.trim(),
      onDone: (answer) => {
        history.push({ role: 'assistant', content: answer });
        db.prepare('UPDATE annotations SET messages = ? WHERE id = ?').run(
          JSON.stringify(history),
          annotation.id,
        );
        return { annotationId: annotation.id };
      },
    });
  }),
);

router.delete('/courses/:id/lessons/:num/annotations/:aid', (req, res) => {
  const info = db
    .prepare('DELETE FROM annotations WHERE id = ?')
    .run(req.params.aid);
  if (info.changes === 0)
    return res.status(404).json({ error: 'Annotation not found' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Stats, calendar, recommendations
// ---------------------------------------------------------------------------

router.get('/stats', (_req, res) => {
  const courses = db.prepare('SELECT * FROM courses').all();
  const lessons = db.prepare('SELECT COUNT(*) AS n FROM lessons').get().n;
  const annotations = db.prepare('SELECT COUNT(*) AS n FROM annotations').get().n;

  const days = db
    .prepare(
      `SELECT date(created_at, 'localtime') AS day, COUNT(*) AS n
         FROM events GROUP BY day ORDER BY day`,
    )
    .all();

  // Streak: consecutive days with activity, counting back from today.
  const active = new Set(days.map((d) => d.day));
  let streak = 0;
  const cursor = new Date();
  for (;;) {
    const key = cursor.toLocaleDateString('en-CA'); // YYYY-MM-DD, local
    if (active.has(key)) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    } else if (streak === 0 && key === new Date().toLocaleDateString('en-CA')) {
      cursor.setDate(cursor.getDate() - 1); // today idle: allow yesterday to start it
    } else {
      break;
    }
  }

  res.json({
    courses: courses.length,
    completed: courses.filter((c) => c.status === 'completed').length,
    lessons,
    annotations,
    streak,
    activity: days,
  });
});

router.get('/calendar', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT date(e.created_at, 'localtime') AS day,
              e.kind, e.lesson_number, e.course_id, c.name AS course_name
         FROM events e LEFT JOIN courses c ON c.id = e.course_id
        ORDER BY e.created_at DESC`,
    )
    .all();

  const byDay = {};
  for (const r of rows) {
    (byDay[r.day] ??= []).push({
      kind: r.kind,
      lessonNumber: r.lesson_number,
      courseId: r.course_id,
      courseName: r.course_name,
    });
  }
  res.json({ days: byDay });
});

router.get('/recommendations', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT * FROM recommendations WHERE status IN ('suggested','saved')
        ORDER BY generation DESC, id DESC`,
    )
    .all();
  res.json(rows);
});

router.post(
  '/recommendations/generate',
  wrap(async (req, res) => {
    const model = resolveModel(req.body?.model);
    const courses = db
      .prepare('SELECT name, depth, status FROM courses ORDER BY id DESC LIMIT 25')
      .all();

    const history = courses
      .map((c) => `- ${c.name} (${c.depth} depth, ${c.status})`)
      .join('\n');

    try {
      const raw = await callClaude({
        system: P.RECOMMEND_PROMPT({ history }),
        prompt: 'Propose the three subjects.',
        model,
      });

      const json = stripFences(raw).replace(/^```json\s*/i, '').replace(/```\s*$/, '');
      const start = json.indexOf('[');
      const end = json.lastIndexOf(']');
      const items =
        start !== -1 && end !== -1
          ? safeJson(json.slice(start, end + 1), [])
          : [];
      if (!Array.isArray(items) || items.length === 0)
        return res
          .status(502)
          .json({ error: 'Could not read the suggestions Claude returned.' });

      const gen =
        (db.prepare('SELECT MAX(generation) AS g FROM recommendations').get().g ??
          0) + 1;
      db.prepare("UPDATE recommendations SET status = 'dismissed' WHERE status = 'suggested'").run();

      const insert = db.prepare(
        'INSERT INTO recommendations (title, rationale, bridge, generation) VALUES (?, ?, ?, ?)',
      );
      for (const item of items.slice(0, 3)) {
        insert.run(
          String(item.title ?? '').slice(0, 200),
          String(item.rationale ?? ''),
          String(item.bridge ?? ''),
          gen,
        );
      }

      res.json(
        db
          .prepare(
            "SELECT * FROM recommendations WHERE generation = ? AND status = 'suggested' ORDER BY id",
          )
          .all(gen),
      );
    } catch (err) {
      res.status(502).json({
        error: err.message || 'Could not generate suggestions.',
        kind: err instanceof ClaudeError ? err.kind : 'unknown',
      });
    }
  }),
);

router.put('/recommendations/:id', (req, res) => {
  const status = req.body?.status;
  if (!['suggested', 'saved', 'started', 'dismissed'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE recommendations SET status = ? WHERE id = ?').run(
    status,
    req.params.id,
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// File text extraction
// ---------------------------------------------------------------------------

function stripExt(name) {
  return (name ?? '').replace(/\.[^.]+$/, '');
}

async function extractText(file) {
  const ext = path.extname(file.originalname ?? '').toLowerCase();

  if (ext === '.pdf') {
    // pdf-parse is CommonJS and reads a sample file at import time in some
    // versions, so pull in the library entry point directly and lazily.
    const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
    try {
      const parsed = await pdfParse(file.buffer);
      return parsed.text ?? '';
    } catch {
      throw new Error(
        'Could not read that PDF. It may be encrypted or contain only scanned images.',
      );
    }
  }

  const text = file.buffer.toString('utf8');
  // A NUL byte in the first chunk means this was not really text.
  if (text.slice(0, 4096).includes('\u0000'))
    throw new Error(`${file.originalname} does not look like a text file.`);
  return text;
}
