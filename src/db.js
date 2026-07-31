const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
fs.mkdirSync(config.uploadsDir, { recursive: true });

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS exams (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  subject         TEXT DEFAULT '',
  description     TEXT DEFAULT '',
  duration_minutes INTEGER NOT NULL,
  pass_percentage REAL NOT NULL DEFAULT 50,
  status          TEXT NOT NULL DEFAULT 'draft',      -- draft|published|live|ended|archived
  generated_by    TEXT NOT NULL DEFAULT 'manual',     -- manual|ai|pdf
  total_marks     REAL NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  published_at    TEXT,
  ended_at        TEXT
);

CREATE TABLE IF NOT EXISTS questions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id       INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  q_order       INTEGER NOT NULL,
  type          TEXT NOT NULL,                        -- objective|theory
  text          TEXT NOT NULL,
  options       TEXT,                                 -- JSON [{key,text}] for objective
  correct_answer TEXT,                                -- letter for objective, null for theory
  marks         REAL NOT NULL DEFAULT 1,
  difficulty    TEXT NOT NULL DEFAULT 'medium',       -- easy|medium|hard
  learning_objective TEXT DEFAULT '',
  explanation   TEXT DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'manual',       -- manual|ai|pdf
  UNIQUE(exam_id, q_order)
);

CREATE TABLE IF NOT EXISTS marking_schemes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,                          -- objective|theory
  scheme      TEXT NOT NULL,                          -- JSON (rubric/model answer/key points)
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS students (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT NOT NULL UNIQUE,
  name       TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS exam_recipients (
  exam_id    INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  sent_at    TEXT,
  PRIMARY KEY (exam_id, student_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id         INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id      INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  current_q_order INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'in_progress', -- in_progress|completed|expired|abandoned
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at  TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at        TEXT,
  final_score     REAL DEFAULT 0,
  final_percentage REAL DEFAULT 0,
  passed          INTEGER DEFAULT 0,
  UNIQUE(exam_id, student_id)
);

CREATE TABLE IF NOT EXISTS answers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  question_id   INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  q_order       INTEGER NOT NULL,
  answer_text   TEXT NOT NULL,
  is_correct    INTEGER,
  marks_awarded REAL DEFAULT 0,
  max_marks     REAL DEFAULT 0,
  marked_by     TEXT DEFAULT 'auto',                  -- auto|ai|manual
  ai_feedback   TEXT DEFAULT '',
  needs_review  INTEGER NOT NULL DEFAULT 0,
  reviewed      INTEGER NOT NULL DEFAULT 0,
  received_at   TEXT NOT NULL DEFAULT (datetime('now')),
  marked_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_questions_exam ON questions(exam_id, q_order);
CREATE INDEX IF NOT EXISTS idx_sessions_exam ON sessions(exam_id);
CREATE INDEX IF NOT EXISTS idx_answers_session ON answers(session_id, q_order);
CREATE UNIQUE INDEX IF NOT EXISTS idx_schemes_question ON marking_schemes(question_id);
`;

db.exec(SCHEMA);

module.exports = db;
