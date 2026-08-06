import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api } from '../api.js';
import { Icon, Markdown, ModelPicker, Notice } from '../components/ui.jsx';

export default function Course({ models, reloadCourses }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [course, setCourse] = useState(null);
  const [error, setError] = useState(null);
  const [showSyllabus, setShowSyllabus] = useState(true);

  const load = useCallback(() => {
    api.course(id).then(setCourse).catch((e) => setError(e.message));
  }, [id]);

  useEffect(load, [load]);

  if (error) {
    return (
      <main className="main">
        <div className="main-drag" />
        <div className="page"><Notice>{error}</Notice></div>
      </main>
    );
  }
  if (!course) {
    return (
      <main className="main">
        <div className="main-drag" />
        <div className="page"><p className="muted">Loading<span className="dots" /></p></div>
      </main>
    );
  }

  const pct = Math.round((course.mastery.progress ?? 0) * 100);

  return (
    <main className="main">
      <div className="main-drag" />
      <div className="page">
        <div style={{ paddingTop: 24 }}>
          <div className="row-between">
            <div className="row wrap" style={{ gap: 8 }}>
              <span className="badge">
                {course.mode === 'topic' ? 'Topic' : course.mode === 'source' ? 'Document' : 'Files'}
              </span>
              {course.mode !== 'project' && <span className="badge">{course.depth} depth</span>}
              {course.status === 'completed' && <span className="badge done">Complete</span>}
            </div>
            <div className="row">
              <ModelPicker
                models={models}
                value={course.model}
                align="down right"
                onChange={async (m) => {
                  await api.setModel(course.id, m);
                  setCourse((c) => ({ ...c, model: m }));
                }}
              />
              <button
                className="btn btn-ghost btn-sm"
                onClick={async () => {
                  if (!window.confirm(`Delete "${course.name}" and all its lessons?`)) return;
                  await api.deleteCourse(course.id);
                  reloadCourses();
                  navigate('/');
                }}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          </div>

          <h1 className="display display-lg" style={{ marginTop: 14 }}>{course.name}</h1>

          {course.mastery.total > 0 && (
            <div style={{ marginTop: 18, maxWidth: 420 }}>
              <div className="row-between small muted" style={{ marginBottom: 6 }}>
                <span>{course.mastery.done} of {course.mastery.total} mastery items</span>
                <span>{pct}%</span>
              </div>
              <div className="bar"><i style={{ width: `${pct}%` }} /></div>
            </div>
          )}
        </div>

        <hr className="divider" />

        <h2 className="display display-md" style={{ marginBottom: 14 }}>Lessons</h2>
        <div className="stack" style={{ gap: 8 }}>
          {course.lessons.map((l) => (
            <a
              key={l.id}
              href={`#/course/${course.id}/lesson/${l.number}`}
              className="card card-link"
              style={{ padding: '14px 18px' }}
            >
              <div className="row" style={{ gap: 14 }}>
                <span
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 12,
                    color: 'var(--faint)',
                    width: 22,
                  }}
                >
                  {String(l.number).padStart(2, '0')}
                </span>
                <span className="grow" style={{ fontFamily: 'var(--serif)', fontSize: 16.5 }}>
                  {l.title}
                </span>
                {l.isEvaluation && <span className="badge live">Assessment</span>}
                {l.isSource && <span className="badge">Source</span>}
                <Icon name="next" size={15} />
              </div>
            </a>
          ))}
        </div>

        {course.mode !== 'project' && (
          <div style={{ marginTop: 18 }}>
            <a
              className="btn"
              href={`#/course/${course.id}/lesson/${course.lessons.at(-1)?.number ?? 1}`}
            >
              Continue reading
              <Icon name="next" size={15} />
            </a>
          </div>
        )}

        {course.summary && (
          <>
            <hr className="divider" />
            <h2 className="display display-md" style={{ marginBottom: 14 }}>Summary</h2>
            <div className="card">
              <div className="article" style={{ padding: 0, fontSize: 16 }}>
                <Markdown>{course.summary}</Markdown>
              </div>
            </div>
          </>
        )}

        {course.syllabus && (
          <>
            <hr className="divider" />
            <div className="row-between" style={{ marginBottom: 14 }}>
              <h2 className="display display-md">Syllabus</h2>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setShowSyllabus((v) => !v)}
              >
                {showSyllabus ? 'Hide' : 'Show'}
              </button>
            </div>
            {showSyllabus && (
              <div className="card">
                <div className="article" style={{ padding: 0, fontSize: 16 }}>
                  <Markdown>{course.syllabus}</Markdown>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
