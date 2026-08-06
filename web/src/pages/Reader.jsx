import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api, streamPost } from '../api.js';
import { Icon, Markdown, ModelPicker, Notice } from '../components/ui.jsx';

/**
 * Wrap each annotated quote in a <mark> so highlights survive re-render.
 * Runs against the DOM after paint because the body is markdown-rendered.
 */
function applyHighlights(root, annotations) {
  if (!root) return;

  root.querySelectorAll('mark.bloom-hl').forEach((m) => {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  });

  for (const a of annotations) {
    const needle = (a.quote ?? '').trim();
    if (needle.length < 4) continue;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const node of nodes) {
      if (node.parentElement?.closest('mark.bloom-hl')) continue;
      const idx = node.nodeValue.indexOf(needle);
      if (idx === -1) continue;

      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + needle.length);

      const mark = document.createElement('mark');
      mark.className = 'bloom-hl';
      mark.dataset.aid = String(a.id);
      try {
        range.surroundContents(mark);
      } catch {
        // Selection spanned element boundaries — leave it unmarked.
      }
      break; // first occurrence only
    }
  }
}

export default function Reader({ models, model: globalModel, reloadCourses }) {
  const { id, num } = useParams();
  const navigate = useNavigate();

  const [course, setCourse] = useState(null);
  const [lesson, setLesson] = useState(null);
  const [error, setError] = useState(null);

  const [feedback, setFeedback] = useState('');
  const [answers, setAnswers] = useState('');
  const [savedAt, setSavedAt] = useState(null);

  const [nextBusy, setNextBusy] = useState(false);
  const [nextText, setNextText] = useState('');
  const [nextError, setNextError] = useState(null);
  const [nextStage, setNextStage] = useState('');
  const [revision, setRevision] = useState(null);

  const [trigger, setTrigger] = useState(null); // {x, y, quote, anchorTop}
  const [panel, setPanel] = useState(null); // active thread
  // Open by default on a desktop-width window; closed on tablet, where it
  // floats over the text rather than sitting beside it.
  const [sideOpen, setSideOpen] = useState(
    () => !(window.matchMedia?.('(max-width: 900px)').matches ?? false),
  );
  // Collapsed by default so the dock doesn't cover the lesson while reading.
  const [dockOpen, setDockOpen] = useState(false);

  const articleRef = useRef(null);
  const mainRef = useRef(null);
  const abortRef = useRef(null);

  const model = course?.model ?? globalModel;

  const load = useCallback(async () => {
    try {
      const [c, l] = await Promise.all([api.course(id), api.lesson(id, num)]);
      setCourse(c);
      setLesson(l);
      setFeedback(l.feedback.content ?? '');
      setAnswers(l.feedback.thoughtAnswers ?? '');
      setError(null);
      api.markOpened(id, num).catch(() => {});
    } catch (e) {
      setError(e.message);
    }
  }, [id, num]);

  useEffect(() => {
    setPanel(null);
    setTrigger(null);
    setNextText('');
    setNextError(null);
    load();
    mainRef.current?.scrollTo({ top: 0 });
  }, [load]);

  useEffect(() => () => abortRef.current?.(), []);

  useLayoutEffect(() => {
    if (lesson) applyHighlights(articleRef.current, lesson.annotations);
  }, [lesson]);

  // --- Text selection → floating Ask button ------------------------------
  //
  // `selectionchange` rather than `mouseup`: iOS Safari fires no mouse events
  // for a long-press selection or a handle drag, so mouseup would never see a
  // touch selection at all. It does fire continuously mid-drag, hence the
  // debounce — the button should appear once the selection settles, not while
  // it is still being dragged.
  useEffect(() => {
    let timer;

    function readSelection() {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? '';
      if (!text || text.length < 4 || !articleRef.current) {
        setTrigger(null);
        return;
      }
      if (!articleRef.current.contains(sel.anchorNode)) {
        setTrigger(null);
        return;
      }

      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const articleRect = articleRef.current.getBoundingClientRect();
      const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
      setTrigger({
        x: Math.min(
          Math.max(rect.left + rect.width / 2, 90),
          window.innerWidth - 90,
        ),
        // Touch sits below the selection: iOS puts its own Copy / Look Up
        // callout directly above it, which would cover the button.
        y: coarse
          ? Math.min(rect.bottom + 12, window.innerHeight - 72)
          : Math.max(rect.top - 44, 60),
        quote: text.slice(0, 600),
        anchorTop: Math.round(rect.top - articleRect.top),
      });
    }

    function onSelectionChange() {
      clearTimeout(timer);
      timer = setTimeout(readSelection, 400);
    }

    // Reopening an existing highlight needs the event target, which
    // `selectionchange` doesn't carry — so that stays a pointer handler.
    function onPointerUp(e) {
      if (e.target.closest?.('.ask-panel, .ask-trigger')) return;

      const existing = e.target.closest?.('mark.bloom-hl');
      if (!existing) return;

      const found = lesson?.annotations.find(
        (a) => String(a.id) === existing.dataset.aid,
      );
      if (found) {
        clearTimeout(timer);
        setPanel({ ...found, streaming: false });
        setTrigger(null);
      }
    }

    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('pointerup', onPointerUp);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('pointerup', onPointerUp);
    };
  }, [lesson]);

  async function saveFeedback() {
    await api.saveFeedback(id, num, { content: feedback, thoughtAnswers: answers });
    setSavedAt(Date.now());
  }

  function doneReading() {
    if (nextBusy) return;
    setNextBusy(true);
    setNextText('');
    setNextError(null);
    setNextStage('');
    setRevision(null);

    saveFeedback()
      .catch(() => {})
      .finally(() => {
        abortRef.current = streamPost('/courses/' + id + '/next', { model }, (ev) => {
          if (ev.type === 'delta') setNextText((t) => t + ev.text);
          else if (ev.type === 'stage') setNextStage(ev.stage);
          else if (ev.type === 'syllabus_revised') setRevision(ev);
          else if (ev.type === 'done') {
            setNextBusy(false);
            reloadCourses();
            if (ev.kind === 'summary') navigate(`/course/${id}`);
            else navigate(`/course/${id}/lesson/${ev.lessonNumber}`);
          } else if (ev.type === 'error') {
            setNextBusy(false);
            setNextError(ev.message);
          }
        });
      });
  }

  if (error) {
    return (
      <main className="main"><div className="main-drag" />
        <div className="page"><Notice onRetry={load}>{error}</Notice></div>
      </main>
    );
  }
  if (!lesson || !course) {
    return (
      <main className="main"><div className="main-drag" />
        <div className="page"><p className="muted">Loading<span className="dots" /></p></div>
      </main>
    );
  }

  const isLast = lesson.number === (course.lessons.at(-1)?.number ?? 1);
  const allDone = course.mastery.total > 0 && course.mastery.done >= course.mastery.total;
  const nextLabel = lesson.isEvaluation
    ? 'Finish and write my summary'
    : allDone
      ? 'Done reading — start my assessment'
      : 'Done reading — write lesson ' +
        String(lesson.number + 1).padStart(2, '0');

  // --- Streaming the next lesson ----------------------------------------
  if (nextBusy) {
    return (
      <main className="main" ref={mainRef}>
        <div className="reader-bar">
          <span className="eyebrow grow">
            {lesson.isEvaluation ? 'Writing your summary' : 'Writing the next lesson'}
          </span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              abortRef.current?.();
              setNextBusy(false);
            }}
          >
            Cancel
          </button>
        </div>
        <article className="article">
          {revision && (
            <div
              className="notice notice-info"
              style={{ marginBottom: 26, fontFamily: 'var(--sans)' }}
            >
              <strong>Your feedback changed the plan.</strong>
              <div style={{ marginTop: 4 }}>{revision.reason}</div>
              <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                {(revision.changes ?? []).map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          {nextText ? (
            <>
              <Markdown>{nextText}</Markdown>
              <span className="caret" />
            </>
          ) : (
            <p className="muted">
              {nextStage === 'reviewing-plan'
                ? 'Checking whether your feedback changes the plan'
                : 'Reading your feedback and annotations'}
              <span className="dots" />
            </p>
          )}
        </article>
      </main>
    );
  }

  return (
    <div className="reader" style={{ flex: 1, minWidth: 0 }}>
      <main className="main reader-main" ref={mainRef}>
        <div className="reader-bar">
          <a className="btn btn-ghost btn-sm" href={`#/course/${course.id}`}>
            <Icon name="back" size={14} />
          </a>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="small muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {course.name}
            </div>
          </div>
          <ModelPicker
            models={models}
            value={model}
            compact
            align="down right"
            onChange={async (m) => {
              await api.setModel(course.id, m);
              setCourse((c) => ({ ...c, model: m }));
            }}
          />
          <button
            className={`chip ${sideOpen ? 'on' : ''}`}
            onClick={() => setSideOpen((v) => !v)}
          >
            Syllabus
          </button>
        </div>

        <article className="article" ref={articleRef}>
          {lesson.isSource ? (
            <>
              <h1>{lesson.title}</h1>
              <p className="muted" style={{ fontFamily: 'var(--sans)', fontSize: 14 }}>
                Highlight any passage to ask about it. Your questions shape the next lesson.
              </p>
              <div className="article-plain">{lesson.content.replace(/^#[^\n]*\n/, '')}</div>
            </>
          ) : (
            <Markdown>{lesson.content}</Markdown>
          )}

          {lesson.annotations.map((a) => (
            <button
              key={a.id}
              className="margin-dot"
              style={{ top: a.anchorTop || 0 }}
              title={a.question}
              onClick={() => setPanel({ ...a, streaming: false })}
            />
          ))}
        </article>

        {course.mode !== 'project' && isLast && (
          <div className="dock">
            <div className="dock-inner">
              {nextError && (
                <div style={{ marginBottom: 12 }}>
                  <Notice onRetry={doneReading}>{nextError}</Notice>
                </div>
              )}

              {dockOpen && (
                <>
                  <div className="eyebrow" style={{ marginBottom: 8 }}>Your feedback</div>
                  <textarea
                    className="field"
                    style={{ minHeight: 68 }}
                    placeholder="What clicked? What didn't? Where should the next lesson go?"
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    onBlur={saveFeedback}
                  />
                  <div className="eyebrow" style={{ margin: '14px 0 8px' }}>
                    Your answers to the thinking questions
                  </div>
                  <textarea
                    className="field"
                    style={{ minHeight: 68 }}
                    placeholder="Answer them here and the next lesson will grade you, question by question."
                    value={answers}
                    onChange={(e) => setAnswers(e.target.value)}
                    onBlur={saveFeedback}
                  />
                </>
              )}

              <div className="row-between" style={{ marginTop: dockOpen ? 14 : 0 }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setDockOpen((v) => !v)}
                >
                  <Icon name="chevron" size={13} />
                  {dockOpen
                    ? savedAt
                      ? 'Hide · saved'
                      : 'Hide notes'
                    : feedback || answers
                      ? 'Your notes · saved'
                      : 'Add feedback & answers'}
                </button>
                <button className="btn" onClick={doneReading}>
                  {nextLabel}
                  <Icon name="next" size={15} />
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      <aside className={`reader-side ${sideOpen ? '' : 'hidden'}`}>
        <div className="side-h">Lessons</div>
        {course.lessons.map((l) => (
          <a
            key={l.id}
            href={`#/course/${course.id}/lesson/${l.number}`}
            className={`side-lesson ${l.number === lesson.number ? 'active' : ''}`}
          >
            <span className="n">{String(l.number).padStart(2, '0')}</span>
            <span>{l.title}</span>
          </a>
        ))}

        {course.syllabus && (
          <>
            <div className="side-h" style={{ marginTop: 24 }}>
              Mastery · {course.mastery.done}/{course.mastery.total}
            </div>
            {course.syllabus
              .split('\n')
              .filter((l) => /^\s*- \[[ xX]\]/.test(l))
              .map((line, i) => {
                const on = /\[[xX]\]/.test(line);
                return (
                  <div key={i} className={`mastery-item ${on ? 'on' : ''}`}>
                    <span className="box">{on ? '✓' : '○'}</span>
                    <span>{line.replace(/^\s*- \[[ xX]\]\s*/, '')}</span>
                  </div>
                );
              })}
          </>
        )}

        {lesson.annotations.length > 0 && (
          <>
            <div className="side-h" style={{ marginTop: 24 }}>
              Your questions · {lesson.annotations.length}
            </div>
            {lesson.annotations.map((a) => (
              <button
                key={a.id}
                className="side-lesson"
                style={{ textAlign: 'left', width: '100%' }}
                onClick={() => setPanel({ ...a, streaming: false })}
              >
                <span>{a.question}</span>
              </button>
            ))}
          </>
        )}
      </aside>

      {trigger && !panel && (
        <button
          className="ask-trigger"
          style={{ left: trigger.x, top: trigger.y, transform: 'translateX(-50%)' }}
          onClick={() => {
            setPanel({
              id: null,
              quote: trigger.quote,
              anchorTop: trigger.anchorTop,
              messages: [],
              streaming: false,
            });
            setTrigger(null);
            window.getSelection()?.removeAllRanges();
          }}
        >
          <Icon name="ask" size={14} />
          Ask
        </button>
      )}

      {panel && (
        <AskPanel
          key={panel.id ?? 'new'}
          courseId={id}
          lessonNumber={num}
          model={model}
          initial={panel}
          onClose={() => setPanel(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}

/** Draggable highlight-question thread. */
function AskPanel({ courseId, lessonNumber, model, initial, onClose, onSaved }) {
  const [messages, setMessages] = useState(initial.messages ?? []);
  const [annotationId, setAnnotationId] = useState(initial.id);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState('');
  const [err, setErr] = useState(null);
  const [pos, setPos] = useState({
    x: Math.max(window.innerWidth - 430, 20),
    y: 120,
  });

  const drag = useRef(null);
  const bodyRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => () => abortRef.current?.(), []);
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, live]);

  useEffect(() => {
    function move(e) {
      if (!drag.current) return;
      setPos({
        x: Math.min(Math.max(e.clientX - drag.current.dx, 8), window.innerWidth - 396),
        y: Math.min(Math.max(e.clientY - drag.current.dy, 48), window.innerHeight - 120),
      });
    }
    function up() {
      drag.current = null;
    }
    // Pointer rather than mouse events so a stylus or trackpad on the iPad
    // drags too. Below the tablet breakpoint the panel is a fixed bottom
    // sheet, so `pos` is unused there and nothing can start a drag.
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    return () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };
  }, []);

  function ask(question) {
    const text = question.trim();
    if (!text || busy) return;

    setMessages((m) => [...m, { role: 'user', content: text }]);
    setDraft('');
    setBusy(true);
    setLive('');
    setErr(null);

    const path = annotationId
      ? `/courses/${courseId}/lessons/${lessonNumber}/annotations/${annotationId}/messages`
      : `/courses/${courseId}/lessons/${lessonNumber}/annotations`;

    const body = annotationId
      ? { question: text, model }
      : {
          quote: initial.quote,
          question: text,
          anchorTop: initial.anchorTop ?? 0,
          model,
        };

    abortRef.current = streamPost(path, body, (ev) => {
      if (ev.type === 'delta') setLive((t) => t + ev.text);
      else if (ev.type === 'done') {
        setMessages((m) => [...m, { role: 'assistant', content: ev.content }]);
        setLive('');
        setBusy(false);
        if (ev.annotationId) setAnnotationId(ev.annotationId);
        onSaved?.();
      } else if (ev.type === 'error') {
        setBusy(false);
        setLive('');
        setErr(ev.message);
      }
    });
  }

  return (
    <div className="ask-panel" style={{ left: pos.x, top: pos.y }}>
      <div
        className="ask-head"
        onPointerDown={(e) => {
          if (e.target.closest('button')) return;
          drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
        }}
      >
        <Icon name="ask" size={14} />
        <span className="ask-quote">“{initial.quote}”</span>
        <button onClick={onClose} title="Close">
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className="ask-body" ref={bodyRef}>
        {messages.length === 0 && !busy && (
          <p className="small muted" style={{ margin: 0 }}>
            Ask anything about the passage you highlighted.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`ask-msg ${m.role === 'user' ? 'user' : 'bot'}`}>
            {m.role === 'user' ? m.content : <Markdown>{m.content}</Markdown>}
          </div>
        ))}
        {live && (
          <div className="ask-msg bot">
            <Markdown>{live}</Markdown>
            <span className="caret" />
          </div>
        )}
        {busy && !live && (
          <div className="small muted">Thinking<span className="dots" /></div>
        )}
        {err && (
          <div className="notice notice-error small" style={{ marginTop: 8 }}>{err}</div>
        )}
      </div>

      <div className="ask-foot">
        <input
          className="field grow"
          placeholder={messages.length ? 'Follow up…' : 'What do you want to know?'}
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ask(draft)}
        />
        <button className="btn btn-sm" disabled={!draft.trim() || busy} onClick={() => ask(draft)}>
          <Icon name="arrow" size={14} />
        </button>
      </div>
    </div>
  );
}
