import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, streamPost } from '../api.js';
import { Icon, ModelPicker, Notice, Markdown } from '../components/ui.jsx';

const SUGGESTIONS = [
  'How sourdough starters actually work',
  'Why the Roman Republic collapsed',
  'Transformers, from attention to output',
  'How the immune system decides what to attack',
  'Music theory for people who already play',
];

const DEPTHS = [
  { id: 'simple', label: 'Simple', hint: 'Trunk only — the fastest route to useful.' },
  { id: 'standard', label: 'Standard', hint: 'Core concepts, applications, common traps.' },
  { id: 'deep', label: 'Deep', hint: 'First principles, mechanisms, edge cases.' },
];

export default function Home({ models, model, setModel, courses, reloadCourses }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState('topic');
  const [topic, setTopic] = useState('');
  const [depth, setDepth] = useState('standard');
  const [reference, setReference] = useState('');
  const [showReference, setShowReference] = useState(false);
  const [files, setFiles] = useState([]);

  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [preview, setPreview] = useState('');
  const [error, setError] = useState(null);

  const [recs, setRecs] = useState([]);
  const [recsBusy, setRecsBusy] = useState(false);

  const abortRef = useRef(null);
  const textareaRef = useRef(null);
  const fileRef = useRef(null);
  const folderRef = useRef(null);

  useEffect(() => {
    api.recommendations().then(setRecs).catch(() => {});
  }, []);

  const grow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, []);

  useEffect(() => () => abortRef.current?.(), []);

  function createTopicCourse() {
    const name = topic.trim();
    if (!name || busy) return;

    setBusy(true);
    setError(null);
    setPreview('');
    setStage('syllabus');

    abortRef.current = streamPost(
      '/courses',
      { name, depth, model, reference: reference.trim() },
      (ev) => {
        if (ev.type === 'stage') {
          setStage(ev.stage);
          setPreview('');
        } else if (ev.type === 'delta') {
          setPreview((p) => p + ev.text);
        } else if (ev.type === 'syllabus') {
          setPreview('');
        } else if (ev.type === 'done') {
          setBusy(false);
          reloadCourses();
          navigate(`/course/${ev.courseId}/lesson/${ev.lessonNumber}`);
        } else if (ev.type === 'error') {
          setBusy(false);
          setError(ev);
        }
      },
    );
  }

  async function createFromFiles(list, kind) {
    if (list.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setStage(kind === 'source' ? 'reading' : 'importing');
    setPreview('');

    const form = new FormData();
    form.append('model', model);
    form.append('depth', depth);
    if (topic.trim()) form.append('name', topic.trim());

    try {
      let out;
      if (kind === 'source') {
        form.append('file', list[0]);
        out = await api.fromSource(form);
      } else {
        for (const f of list) form.append('files', f);
        out = await api.fromProject(form);
      }
      reloadCourses();
      navigate(`/course/${out.courseId}/lesson/${out.lessonNumber}`);
    } catch (err) {
      setError({ message: err.message, kind: err.kind });
    } finally {
      setBusy(false);
    }
  }

  async function refreshRecs() {
    setRecsBusy(true);
    try {
      setRecs(await api.generateRecommendations(model));
    } catch (err) {
      setError({ message: err.message, kind: err.kind });
    } finally {
      setRecsBusy(false);
    }
  }

  const stageLabel = {
    syllabus: 'Designing the syllabus',
    lesson: 'Writing lesson 01',
    reading: 'Reading your document',
    importing: 'Importing your files',
  }[stage];

  // ---- Generating view --------------------------------------------------
  if (busy) {
    return (
      <main className="main">
        <div className="main-drag" />
        <div className="page">
          <div style={{ paddingTop: 56 }}>
            <div className="eyebrow">Creating</div>
            <h1 className="display display-lg" style={{ marginTop: 8 }}>
              {topic.trim() || 'Your course'}
            </h1>
            <div className="row" style={{ marginTop: 16, color: 'var(--muted)' }}>
              <span className="spinner" />
              <span>{stageLabel}<span className="dots" /></span>
            </div>

            {preview && (
              <div
                className="card"
                style={{ marginTop: 26, maxHeight: '54vh', overflowY: 'auto' }}
              >
                <div className="article" style={{ padding: 0, fontSize: 15.5 }}>
                  <Markdown>{preview}</Markdown>
                  <span className="caret" />
                </div>
              </div>
            )}

            <button
              className="btn btn-ghost btn-sm"
              style={{ marginTop: 20 }}
              onClick={() => {
                abortRef.current?.();
                setBusy(false);
                setPreview('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </main>
    );
  }

  // ---- Composer ---------------------------------------------------------
  return (
    <main className="main">
      <div className="main-drag" />
      <div className="page">
        <div className="hero">
          <div className="hero-mark">✿</div>
          <h1 className="display display-xl">Learn anything</h1>
          <p className="lede">
            A private tutor that reads how you learn and writes the next lesson for you.
          </p>
        </div>

        {error && (
          <div style={{ maxWidth: 660, margin: '0 auto 18px' }}>
            <Notice kind="error">{error.message}</Notice>
          </div>
        )}

        <div className="composer">
          <div className="composer-row">
            <textarea
              ref={textareaRef}
              className="composer-input"
              rows={1}
              placeholder={
                mode === 'topic'
                  ? 'I want to learn…'
                  : 'Name this course (optional) — then pick files below'
              }
              value={topic}
              onChange={(e) => {
                setTopic(e.target.value);
                grow();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && mode === 'topic') {
                  e.preventDefault();
                  createTopicCourse();
                }
              }}
            />
            {mode === 'topic' && (
              <button
                className="composer-send"
                disabled={!topic.trim()}
                onClick={createTopicCourse}
                title="Create course"
              >
                <Icon name="arrow" size={17} />
              </button>
            )}
          </div>

          <div className="composer-tools">
            <div className="seg">
              {[
                ['topic', 'Topic'],
                ['source', 'Document'],
                ['project', 'Files'],
              ].map(([id, label]) => (
                <button
                  key={id}
                  className={mode === id ? 'on' : ''}
                  onClick={() => {
                    setMode(id);
                    setFiles([]); // staged files don't carry across modes
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            <ModelPicker models={models} value={model} onChange={setModel} />

            {mode !== 'project' && (
              <Popover3
                label={`Depth · ${DEPTHS.find((d) => d.id === depth).label}`}
                items={DEPTHS}
                value={depth}
                onChange={setDepth}
              />
            )}

            {mode === 'topic' && (
              <button
                className={`chip ${showReference ? 'on' : ''}`}
                onClick={() => setShowReference((v) => !v)}
              >
                <Icon name="file" size={13} />
                Reference
              </button>
            )}

            {mode === 'source' && (
              <button className="chip" onClick={() => fileRef.current?.click()}>
                <Icon name="file" size={13} />
                {files.length ? 'Choose a different file' : 'Choose a PDF, TXT or MD'}
              </button>
            )}

            {mode === 'project' && (
              <>
                <button className="chip" onClick={() => fileRef.current?.click()}>
                  <Icon name="file" size={13} />
                  Choose files
                </button>
                <button className="chip" onClick={() => folderRef.current?.click()}>
                  <Icon name="file" size={13} />
                  Choose a folder
                </button>
              </>
            )}
          </div>

          {showReference && mode === 'topic' && (
            <div style={{ padding: '0 16px 14px' }}>
              <textarea
                className="field"
                placeholder="Paste a textbook chapter, a paper, or your notes. Claude will ground the syllabus in it."
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
          )}

          {/*
            Attaching a file only stages it. Nothing is generated until the
            learner has set the name, model and depth and pressed Start.
          */}
          {files.length > 0 && (
            <div style={{ padding: '0 16px 14px' }}>
              <div className="row wrap" style={{ marginBottom: 10 }}>
                {files.slice(0, 6).map((f) => (
                  <span key={f.name} className="badge">
                    {f.name}
                    <button
                      onClick={() =>
                        setFiles((list) => list.filter((x) => x.name !== f.name))
                      }
                      title="Remove"
                      style={{ marginLeft: 6, opacity: 0.55, verticalAlign: -1 }}
                    >
                      <Icon name="close" size={10} />
                    </button>
                  </span>
                ))}
                {files.length > 6 && (
                  <span className="badge">+{files.length - 6} more</span>
                )}
              </div>
              <div className="row-between">
                <span className="small muted">
                  Ready when you are — set the name, model and depth above.
                </span>
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    createFromFiles(files, mode === 'source' ? 'source' : 'project')
                  }
                >
                  Start with {files.length} file{files.length === 1 ? '' : 's'}
                  <Icon name="arrow" size={14} />
                </button>
              </div>
            </div>
          )}
        </div>

        <input
          ref={fileRef}
          type="file"
          hidden
          multiple={mode === 'project'}
          accept={mode === 'source' ? '.pdf,.txt,.md,.markdown' : undefined}
          onChange={(e) => {
            // Stage only. Generation waits for an explicit Start.
            setFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <input
          ref={folderRef}
          type="file"
          hidden
          webkitdirectory=""
          directory=""
          multiple
          onChange={(e) => {
            setFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />

        {mode === 'topic' && topic.trim() === '' && (
          <div className="suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="suggestion" onClick={() => setTopic(s)}>
                {s}
              </button>
            ))}
          </div>
        )}

        {courses.length > 0 && (
          <>
            <hr className="divider" />
            <div className="row-between" style={{ marginBottom: 16 }}>
              <h2 className="display display-md">Your courses</h2>
              <span className="small muted">{courses.length} total</span>
            </div>
            <div className="grid">
              {courses.map((c) => (
                <CourseCard key={c.id} course={c} />
              ))}
            </div>
          </>
        )}

        <hr className="divider" />
        <div className="row-between" style={{ marginBottom: 16 }}>
          <h2 className="display display-md">What next</h2>
          <button className="btn btn-ghost btn-sm" onClick={refreshRecs} disabled={recsBusy}>
            {recsBusy ? <span className="spinner" /> : <Icon name="spark" size={14} />}
            {recs.length ? 'Suggest again' : 'Suggest topics'}
          </button>
        </div>
        {recs.length === 0 ? (
          <p className="muted small">
            Claude reads your whole learning history and proposes three subjects worth
            taking on next.
          </p>
        ) : (
          <div className="grid">
            {recs.map((r) => (
              <div key={r.id} className="card">
                <h3 className="card-title" style={{ fontSize: 17 }}>{r.title}</h3>
                <p className="small muted" style={{ margin: '0 0 10px' }}>{r.rationale}</p>
                {r.bridge && (
                  <p className="small" style={{ color: 'var(--terra)', margin: '0 0 14px' }}>
                    {r.bridge}
                  </p>
                )}
                <div className="row">
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      setTopic(r.title);
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                      textareaRef.current?.focus();
                    }}
                  >
                    Start this
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={async () => {
                      await api.setRecommendation(r.id, 'dismissed');
                      setRecs((list) => list.filter((x) => x.id !== r.id));
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function Popover3({ label, items, value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="pop" ref={ref}>
      <button className={`chip ${open ? 'on' : ''}`} onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      {open && (
        <div className="pop-menu down">
          <div className="pop-label">Learning depth</div>
          {items.map((it) => (
            <button
              key={it.id}
              className={`pop-item ${it.id === value ? 'on' : ''}`}
              onClick={() => {
                onChange(it.id);
                setOpen(false);
              }}
            >
              <div className="row">
                <span className="name grow">{it.label}</span>
                {it.id === value && <Icon name="check" size={13} />}
              </div>
              <div className="blurb">{it.hint}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CourseCard({ course }) {
  const pct = Math.round((course.mastery.progress ?? 0) * 100);
  return (
    <a href={`#/course/${course.id}`} className="card card-link">
      <h3 className="card-title">{course.name}</h3>
      <div className="card-meta">
        <span className="badge">{course.mode === 'topic' ? 'Topic' : course.mode === 'source' ? 'Document' : 'Files'}</span>
        {course.mode !== 'project' && <span className="badge">{course.depth}</span>}
        {course.status === 'completed' && <span className="badge done">Complete</span>}
        <span>{course.lessonCount} lesson{course.lessonCount === 1 ? '' : 's'}</span>
      </div>
      {course.mastery.total > 0 && (
        <>
          <div className="bar"><i style={{ width: `${pct}%` }} /></div>
          <div className="small muted" style={{ marginTop: 7 }}>
            {course.mastery.done} of {course.mastery.total} mastery items
          </div>
        </>
      )}
    </a>
  );
}
