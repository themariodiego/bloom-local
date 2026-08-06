import Database from 'better-sqlite3';
import { DB_PATH } from './paths.js';

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS courses (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  mode           TEXT    NOT NULL DEFAULT 'topic'
                 CHECK (mode IN ('topic','source','project')),
  status         TEXT    NOT NULL DEFAULT 'learning'
                 CHECK (status IN ('learning','completed')),
  depth          TEXT    NOT NULL DEFAULT 'standard'
                 CHECK (depth IN ('simple','standard','deep')),
  model          TEXT    NOT NULL DEFAULT 'claude-sonnet-5',
  reference      TEXT    DEFAULT '',
  source_name    TEXT,
  source_content TEXT,
  summary        TEXT    DEFAULT '',
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS syllabi (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id  INTEGER NOT NULL UNIQUE REFERENCES courses(id) ON DELETE CASCADE,
  content    TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lessons (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id     INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  number        INTEGER NOT NULL,
  title         TEXT    NOT NULL DEFAULT '',
  content       TEXT    NOT NULL,
  is_evaluation INTEGER NOT NULL DEFAULT 0,
  is_source     INTEGER NOT NULL DEFAULT 0,
  file_name     TEXT,
  file_path     TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (course_id, number)
);

CREATE TABLE IF NOT EXISTS annotations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id    INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  quote        TEXT    NOT NULL,
  question     TEXT    NOT NULL,
  answer       TEXT    NOT NULL DEFAULT '',
  messages     TEXT    NOT NULL DEFAULT '[]',
  anchor_top   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS feedback (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id       INTEGER NOT NULL UNIQUE REFERENCES lessons(id) ON DELETE CASCADE,
  content         TEXT    NOT NULL DEFAULT '',
  thought_answers TEXT    NOT NULL DEFAULT '',
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id     INTEGER REFERENCES courses(id) ON DELETE CASCADE,
  lesson_number INTEGER,
  kind          TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recommendations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  rationale   TEXT    NOT NULL DEFAULT '',
  bridge      TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'suggested'
              CHECK (status IN ('suggested','saved','started','dismissed')),
  generation  INTEGER NOT NULL DEFAULT 1,
  course_id   INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lessons_course     ON lessons(course_id);
CREATE INDEX IF NOT EXISTS idx_annotations_lesson ON annotations(lesson_id);
CREATE INDEX IF NOT EXISTS idx_events_course      ON events(course_id);
CREATE INDEX IF NOT EXISTS idx_events_created     ON events(created_at);
`);

export function recordEvent(courseId, kind, lessonNumber = null) {
  db.prepare(
    'INSERT INTO events (course_id, lesson_number, kind) VALUES (?, ?, ?)',
  ).run(courseId, lessonNumber, kind);
}
