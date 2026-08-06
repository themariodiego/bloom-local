import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Notice } from '../components/ui.jsx';

const DAY_MS = 86_400_000;
const localKey = (d) => d.toLocaleDateString('en-CA');

export default function Profile() {
  const [stats, setStats] = useState(null);
  const [calendar, setCalendar] = useState(null);
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState(null);

  useEffect(() => {
    Promise.all([api.stats(), api.calendar()])
      .then(([s, c]) => {
        setStats(s);
        setCalendar(c);
      })
      .catch((e) => setError(e.message));
  }, []);

  // 26 weeks of activity, oldest first, aligned so each column is a week.
  const cells = useMemo(() => {
    if (!stats) return [];
    const counts = Object.fromEntries(stats.activity.map((a) => [a.day, a.n]));
    const out = [];
    const today = new Date();
    const start = new Date(today.getTime() - 181 * DAY_MS);
    start.setDate(start.getDate() - start.getDay()); // back to Sunday

    for (let t = start.getTime(); t <= today.getTime(); t += DAY_MS) {
      const d = new Date(t);
      const key = localKey(d);
      const n = counts[key] ?? 0;
      out.push({
        key,
        n,
        level: n === 0 ? 0 : n < 3 ? 1 : n < 6 ? 2 : n < 12 ? 3 : 4,
      });
    }
    return out;
  }, [stats]);

  if (error) {
    return (
      <main className="main"><div className="main-drag" />
        <div className="page"><Notice>{error}</Notice></div>
      </main>
    );
  }
  if (!stats) {
    return (
      <main className="main"><div className="main-drag" />
        <div className="page"><p className="muted">Loading<span className="dots" /></p></div>
      </main>
    );
  }

  const dayDetail = picked ? (calendar?.days?.[picked] ?? []) : null;

  return (
    <main className="main">
      <div className="main-drag" />
      <div className="page">
        <div style={{ paddingTop: 30 }}>
          <div className="eyebrow">Progress</div>
          <h1 className="display display-lg" style={{ marginTop: 8 }}>
            How your learning is going
          </h1>
        </div>

        <div
          className="grid"
          style={{ marginTop: 30, gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}
        >
          {[
            [stats.courses, 'Courses started'],
            [stats.completed, 'Courses finished'],
            [stats.lessons, 'Lessons read'],
            [stats.annotations, 'Questions asked'],
            [stats.streak, stats.streak === 1 ? 'Day streak' : 'Day streak'],
          ].map(([n, label]) => (
            <div key={label} className="card stat">
              <div className="n">{n}</div>
              <div className="l">{label}</div>
            </div>
          ))}
        </div>

        <hr className="divider" />

        <h2 className="display display-md" style={{ marginBottom: 6 }}>Last six months</h2>
        <p className="small muted" style={{ marginTop: 0, marginBottom: 18 }}>
          Each square is a day. Click one to see what you studied.
        </p>

        <div className="card" style={{ overflowX: 'auto' }}>
          <div className="heat">
            {cells.map((c) => (
              <i
                key={c.key}
                data-l={c.level || undefined}
                title={`${c.key} · ${c.n} action${c.n === 1 ? '' : 's'}`}
                onClick={() => setPicked(c.n ? c.key : null)}
                style={{ cursor: c.n ? 'pointer' : 'default' }}
              />
            ))}
          </div>
          <div
            className="row"
            style={{ marginTop: 14, gap: 6, fontSize: 11.5, color: 'var(--muted)' }}
          >
            <span>Less</span>
            <span className="heat" style={{ gridAutoFlow: 'column', gridTemplateRows: '11px' }}>
              {[0, 1, 2, 3, 4].map((l) => (
                <i key={l} data-l={l || undefined} />
              ))}
            </span>
            <span>More</span>
          </div>
        </div>

        {picked && (
          <div className="card" style={{ marginTop: 14 }}>
            <div className="row-between" style={{ marginBottom: 10 }}>
              <strong style={{ fontFamily: 'var(--serif)', fontSize: 17 }}>{picked}</strong>
              <button className="btn btn-ghost btn-sm" onClick={() => setPicked(null)}>
                Close
              </button>
            </div>
            {dayDetail.length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>Nothing recorded.</p>
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                {dayDetail.map((d, i) => (
                  <div key={i} className="row small" style={{ gap: 10 }}>
                    <span className="badge">{d.kind.replace(/_/g, ' ')}</span>
                    <a href={`#/course/${d.courseId}`} style={{ color: 'var(--ink-soft)' }}>
                      {d.courseName ?? 'Deleted course'}
                    </a>
                    {d.lessonNumber != null && (
                      <span className="muted">lesson {d.lessonNumber}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
