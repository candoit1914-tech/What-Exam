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
  passage       TEXT DEFAULT '',                      -- reading passage/context the question is based on
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
  -- question_id points at questions() for template questions OR question_pool()
  -- for pool-variant questions, so it deliberately has no FK constraint.
  question_id   INTEGER NOT NULL,
  q_order       INTEGER NOT NULL,
  answer_text   TEXT NOT NULL,
  is_correct    INTEGER,
  marks_awarded REAL DEFAULT 0,
  max_marks     REAL DEFAULT 0,
  marked_by     TEXT DEFAULT 'auto',                  -- auto|ai|manual|pending
  ai_feedback   TEXT DEFAULT '',
  needs_review  INTEGER NOT NULL DEFAULT 0,
  reviewed      INTEGER NOT NULL DEFAULT 0,
  ai_detected   INTEGER NOT NULL DEFAULT 0,           -- 1 = theory answer flagged as AI-copied (cheating)
  received_at   TEXT NOT NULL DEFAULT (datetime('now')),
  marked_at     TEXT
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL DEFAULT 'inbound',
  payload     TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- AI-generated variant questions. Exams that use "fresh questions per
-- attempt" draw each session's question set from here instead of reusing
-- the same template questions over and over.
CREATE TABLE IF NOT EXISTS question_pool (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id            INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  type               TEXT NOT NULL,                      -- objective|theory
  text               TEXT NOT NULL,
  passage            TEXT DEFAULT '',                    -- reading passage/context the question is based on
  options            TEXT,                               -- JSON [{key,text}]
  correct_answer     TEXT,
  marks              REAL NOT NULL DEFAULT 1,
  difficulty         TEXT NOT NULL DEFAULT 'medium',
  learning_objective TEXT DEFAULT '',
  explanation        TEXT DEFAULT '',
  scheme_json        TEXT DEFAULT '',                     -- full marking scheme JSON
  source             TEXT NOT NULL DEFAULT 'ai',
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which question a session actually received at each step (q_order is the
-- per-attempt order, not the template order).
CREATE TABLE IF NOT EXISTS session_questions (
  session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES question_pool(id) ON DELETE CASCADE,
  q_order     INTEGER NOT NULL,
  PRIMARY KEY (session_id, q_order),
  UNIQUE (session_id, question_id)
);

CREATE TABLE IF NOT EXISTS outbound_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient   TEXT NOT NULL,
  message_id  TEXT,
  type        TEXT DEFAULT 'text',                   -- text|interactive|template
  status      TEXT DEFAULT 'sent',                   -- sent|delivered|read|failed
  error       TEXT DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbound_message_id ON outbound_messages(message_id);
CREATE INDEX IF NOT EXISTS idx_outbound_recipient ON outbound_messages(recipient);

-- Background jobs (e.g. PDF question import). Long-running AI work runs here
-- so the HTTP request returns instantly instead of blocking on slow models.
CREATE TABLE IF NOT EXISTS jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL DEFAULT 'pdf_import',   -- pdf_import
  exam_id    INTEGER NOT NULL,
  filename   TEXT DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending',      -- pending|running|done|error
  stage      TEXT DEFAULT '',
  progress   INTEGER NOT NULL DEFAULT 0,           -- 0-100
  count      INTEGER DEFAULT 0,
  error      TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_exam ON jobs(exam_id);

CREATE INDEX IF NOT EXISTS idx_questions_exam ON questions(exam_id, q_order);
CREATE INDEX IF NOT EXISTS idx_sessions_exam ON sessions(exam_id);
CREATE INDEX IF NOT EXISTS idx_answers_session ON answers(session_id, q_order);
CREATE UNIQUE INDEX IF NOT EXISTS idx_schemes_question ON marking_schemes(question_id);
`;

db.exec(SCHEMA);

// Lightweight column migration for existing databases: CREATE TABLE IF NOT
// EXISTS never alters a table that already exists, so add the passage column
// (introduced for reading-comprehension papers) when it is missing.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    console.log(`Migrated ${table}: added column ${column}.`);
  }
}
ensureColumn('questions', 'passage', "TEXT DEFAULT ''");
ensureColumn('question_pool', 'passage', "TEXT DEFAULT ''");
ensureColumn('answers', 'ai_detected', "INTEGER NOT NULL DEFAULT 0");
ensureColumn('jobs', 'warning', "TEXT DEFAULT ''");

// Migration: answers.question_id used to be FK-constrained to questions().
// Attempts may now answer pool-variant questions, so the constraint must go.
// Rebuild the table when the old definition is present.
const answersDdl = db
  .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='answers'")
  .get();
if (answersDdl && /REFERENCES\s+questions/i.test(answersDdl.sql)) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    BEGIN;
    ALTER TABLE answers RENAME TO answers_legacy;
    CREATE TABLE answers (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      question_id   INTEGER NOT NULL,
      q_order       INTEGER NOT NULL,
      answer_text   TEXT NOT NULL,
      is_correct    INTEGER,
      marks_awarded REAL DEFAULT 0,
      max_marks     REAL DEFAULT 0,
      marked_by     TEXT DEFAULT 'auto',
      ai_feedback   TEXT DEFAULT '',
      needs_review  INTEGER NOT NULL DEFAULT 0,
      reviewed      INTEGER NOT NULL DEFAULT 0,
      ai_detected   INTEGER NOT NULL DEFAULT 0,
      received_at   TEXT NOT NULL DEFAULT (datetime('now')),
      marked_at     TEXT
    );
    INSERT INTO answers
      (id, session_id, question_id, q_order, answer_text, is_correct, marks_awarded,
       max_marks, marked_by, ai_feedback, needs_review, reviewed, ai_detected, received_at, marked_at)
    SELECT
      id, session_id, question_id, q_order, answer_text, is_correct, marks_awarded,
      max_marks, marked_by, ai_feedback, needs_review, reviewed, 0, received_at, marked_at
    FROM answers_legacy;
    DROP TABLE answers_legacy;
    COMMIT;
  `);
  db.exec('PRAGMA foreign_keys = ON');
  console.log('Migrated answers table (removed question FK for pool variants).');
}

module.exports = db;
