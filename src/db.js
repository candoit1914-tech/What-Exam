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
  ended_at        TEXT,
  max_attempts    INTEGER NOT NULL DEFAULT 0     -- attempts allowed per student; 0 = unlimited
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
  is_compulsory INTEGER NOT NULL DEFAULT 1,           -- 0 = goes in the selectable pool
  section_key   TEXT    NOT NULL DEFAULT '',          -- '' = implicit single section
  source_number INTEGER NOT NULL DEFAULT 0,           -- printed number on the paper; 0 = unknown
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
  started_at      TEXT,
  last_active_at  TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at        TEXT,
  final_score     REAL DEFAULT 0,
  final_percentage REAL DEFAULT 0,
  passed          INTEGER DEFAULT 0,
  attempt_no      INTEGER NOT NULL DEFAULT 1,
  -- ''|'selecting'. No 'locked' value: whether a section is already chosen is
  -- derived from the committed session_questions rows, because one column cannot
  -- represent two selective sections in the same paper.
  selection_state   TEXT NOT NULL DEFAULT '',
  selection_section TEXT NOT NULL DEFAULT '',
  -- Provisional ticks as a JSON array of session q_orders. is_selected is the
  -- committed answer and is written only by a commit, so a student who taps two
  -- questions and goes quiet has silently deselected nothing.
  selection_tentative TEXT NOT NULL DEFAULT '',
  paper_total       REAL NOT NULL DEFAULT 0            -- compulsory + selected marks
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
  is_compulsory      INTEGER NOT NULL DEFAULT 1,      -- mirrors questions.is_compulsory
  section_key        TEXT    NOT NULL DEFAULT '',      -- mirrors questions.section_key
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which question a session actually received at each step (q_order is the
-- per-attempt order, not the template order).
CREATE TABLE IF NOT EXISTS session_questions (
  session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES question_pool(id) ON DELETE CASCADE,
  q_order     INTEGER NOT NULL,
  is_selected INTEGER NOT NULL DEFAULT 1,               -- 0 = in the pool, not chosen
  section_key TEXT    NOT NULL DEFAULT '',              -- copied from the pool row at draw time
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

CREATE TABLE IF NOT EXISTS message_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL DEFAULT 0,
  q_order INTEGER,
  kind TEXT NOT NULL,
  recipient TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  updated_at TEXT,
  UNIQUE(session_id, question_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_outbox_state ON message_outbox(state);

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
-- Per-question image bubbles (math expressions or extra figures), delivered
-- in position order above the question text on WhatsApp. A single question
-- can need several expression bubbles (e.g. fractions inside a stem).
CREATE TABLE IF NOT EXISTS question_images (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL DEFAULT 0,
  image       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'math',   -- math|figure
  UNIQUE(question_id, position)
);
CREATE INDEX IF NOT EXISTS idx_question_images_question ON question_images(question_id, position);

-- "Answer any N of M" rules. One row per paper section that carries a quota;
-- answer_count = 0 means the section is answered in full and never prompts.
CREATE TABLE IF NOT EXISTS exam_sections (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id      INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  section_key  TEXT    NOT NULL,        -- stable slug matching questions.section_key
  title        TEXT    DEFAULT '',     -- "SECTION B"
  instructions TEXT    DEFAULT '',     -- the paper's verbatim line, shown to the student
  position     INTEGER NOT NULL DEFAULT 0,
  answer_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(exam_id, section_key)
);
CREATE INDEX IF NOT EXISTS idx_exam_sections_exam ON exam_sections(exam_id, position);
CREATE INDEX IF NOT EXISTS idx_sessions_exam ON sessions(exam_id);
-- One live attempt per (exam, student); finished attempts accumulate freely.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_active ON sessions(exam_id, student_id) WHERE status = 'in_progress';
CREATE INDEX IF NOT EXISTS idx_answers_session ON answers(session_id, q_order);
CREATE UNIQUE INDEX IF NOT EXISTS idx_answers_session_question ON answers(session_id, question_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_schemes_question ON marking_schemes(question_id);
-- Global history of all AI-generated questions. Used to prevent repeat questions
-- across exams and generation runs. subject+topic indexed for fast lookups.
CREATE TABLE IF NOT EXISTS generated_questions_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  subject       TEXT NOT NULL DEFAULT '',
  topics        TEXT DEFAULT '',
  question_text TEXT NOT NULL,
  type          TEXT NOT NULL,                          -- objective|theory
  difficulty    TEXT DEFAULT 'medium',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gqh_subject ON generated_questions_history(subject);
CREATE INDEX IF NOT EXISTS idx_gqh_subject_topics ON generated_questions_history(subject, topics);

-- Performance indexes for 80-100 concurrent students
CREATE INDEX IF NOT EXISTS idx_sessions_exam_student ON sessions(exam_id, student_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_pool_exam ON question_pool(exam_id);
CREATE INDEX IF NOT EXISTS idx_recipients_exam ON exam_recipients(exam_id);
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
ensureColumn('questions', 'image', "TEXT DEFAULT ''");
ensureColumn('question_pool', 'image', "TEXT DEFAULT ''");
ensureColumn('answers', 'ai_detected', "INTEGER NOT NULL DEFAULT 0");
ensureColumn('answers', 'answer_image', "TEXT DEFAULT ''");
ensureColumn('jobs', 'warning', "TEXT DEFAULT ''");
ensureColumn('questions', 'follow_ups', "TEXT DEFAULT '[]'");
ensureColumn('question_pool', 'follow_ups', "TEXT DEFAULT '[]'");
ensureColumn('sessions', 'retry_count', "INTEGER NOT NULL DEFAULT 0");
ensureColumn('sessions', 'attempt_no', 'INTEGER NOT NULL DEFAULT 1');
// exams has no settings blob, so the per-exam attempt cap is a plain column.
ensureColumn('exams', 'max_attempts', 'INTEGER NOT NULL DEFAULT 0');

// "Answer any N of M" selection. is_compulsory and is_selected default to 1 so
// every existing question is compulsory and every existing exam behaves exactly
// as it does today -- that default is what makes the feature opt-in with no data
// migration of the question set.
ensureColumn('questions', 'is_compulsory', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('questions', 'section_key', "TEXT NOT NULL DEFAULT ''");
// The paper's own question number. Import assigns q_order by insertion order, so
// q_order silently diverges from the printed number the moment a block is dropped
// or merged. PDF rule reconciliation must match on this instead.
ensureColumn('questions', 'source_number', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('question_pool', 'is_compulsory', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('question_pool', 'section_key', "TEXT NOT NULL DEFAULT ''");
ensureColumn('sessions', 'selection_state', "TEXT NOT NULL DEFAULT ''");
ensureColumn('sessions', 'selection_section', "TEXT NOT NULL DEFAULT ''");
ensureColumn('sessions', 'selection_tentative', "TEXT NOT NULL DEFAULT ''");
ensureColumn('sessions', 'paper_total', 'REAL NOT NULL DEFAULT 0');
ensureColumn('session_questions', 'is_selected', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('session_questions', 'section_key', "TEXT NOT NULL DEFAULT ''");

// Migration: the table-level UNIQUE(exam_id, student_id) made a second attempt
// impossible. The constraint lives in the CREATE TABLE and cannot be dropped in
// place, so the table is rebuilt. Mirrors the answers rebuild below, and keeps
// every existing column so no history is lost.
const sessionsDdl = db
  .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'")
  .get();
if (sessionsDdl && /UNIQUE\s*\(\s*exam_id\s*,\s*student_id\s*\)/i.test(sessionsDdl.sql)) {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`
      BEGIN;
      CREATE TABLE sessions_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        exam_id         INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
        student_id      INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        current_q_order INTEGER NOT NULL DEFAULT 1,
        status          TEXT NOT NULL DEFAULT 'in_progress',
        started_at      TEXT,
        last_active_at  TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at        TEXT,
        final_score     REAL DEFAULT 0,
        final_percentage REAL DEFAULT 0,
        passed          INTEGER DEFAULT 0,
        retry_count     INTEGER NOT NULL DEFAULT 0,
        attempt_no      INTEGER NOT NULL DEFAULT 1,
        selection_state   TEXT NOT NULL DEFAULT '',
        selection_section TEXT NOT NULL DEFAULT '',
        selection_tentative TEXT NOT NULL DEFAULT '',
        paper_total       REAL NOT NULL DEFAULT 0
      );
      INSERT INTO sessions_new
        (id, exam_id, student_id, current_q_order, status, started_at, last_active_at,
         ended_at, final_score, final_percentage, passed, retry_count, attempt_no,
         selection_state, selection_section, selection_tentative, paper_total)
      SELECT
        id, exam_id, student_id, current_q_order, status, started_at, last_active_at,
        ended_at, final_score, final_percentage, passed, COALESCE(retry_count, 0), 1,
        '', '', '', 0
      FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;
      COMMIT;
    `);
    // DROP TABLE took every sessions index with it, and they are not part of the
    // CREATE TABLE above, so they have to be put back here. Without this the
    // table silently loses idx_sessions_exam / _exam_student / _status and every
    // attempt and cleanup query degrades to a full scan. The later started_at
    // rebuild re-creates them, but only on databases that still carry the old
    // NOT NULL started_at — a database that only had the UNIQUE constraint kept
    // none of them.
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_exam ON sessions(exam_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_exam_student ON sessions(exam_id, student_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)');
    console.log('Migrated sessions table (removed unique exam/student constraint for attempts).');
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Migration: started_at was NOT NULL DEFAULT (datetime('now')), so the write
// that parks an invited-but-unstarted session (started_at = NULL) always threw.
// A session that exists without a start time is the normal state between
// "invite sent" and "student replied", so the column has to allow it. SQLite
// cannot relax NOT NULL in place, so the table is rebuilt. This must stay
// before the attempt_no backfill and the idx_sessions_active creation below, so
// both operate on the rebuilt table.
const sessionsStartedDdl = db
  .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'")
  .get();
if (sessionsStartedDdl && /started_at\s+TEXT\s+NOT\s+NULL/i.test(sessionsStartedDdl.sql)) {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`
      BEGIN;
      CREATE TABLE sessions_nullable_start (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        exam_id         INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
        student_id      INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        current_q_order INTEGER NOT NULL DEFAULT 1,
        status          TEXT NOT NULL DEFAULT 'in_progress',
        started_at      TEXT,
        last_active_at  TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at        TEXT,
        final_score     REAL DEFAULT 0,
        final_percentage REAL DEFAULT 0,
        passed          INTEGER DEFAULT 0,
        retry_count     INTEGER NOT NULL DEFAULT 0,
        attempt_no      INTEGER NOT NULL DEFAULT 1,
        selection_state   TEXT NOT NULL DEFAULT '',
        selection_section TEXT NOT NULL DEFAULT '',
        selection_tentative TEXT NOT NULL DEFAULT '',
        paper_total       REAL NOT NULL DEFAULT 0
      );
      INSERT INTO sessions_nullable_start
        (id, exam_id, student_id, current_q_order, status, started_at, last_active_at,
         ended_at, final_score, final_percentage, passed, retry_count, attempt_no,
         selection_state, selection_section, selection_tentative, paper_total)
      SELECT
        id, exam_id, student_id, current_q_order, status, started_at, last_active_at,
        ended_at, final_score, final_percentage, passed, COALESCE(retry_count, 0), attempt_no,
        selection_state, selection_section, selection_tentative, paper_total
      FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_nullable_start RENAME TO sessions;
      COMMIT;
    `);
    // Re-created because the DROP above took them with it. idx_sessions_active
    // is not listed here because it is created further down, after this
    // migration has run.
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_exam ON sessions(exam_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_exam_student ON sessions(exam_id, student_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)');
    console.log('Migrated sessions: started_at is now nullable.');
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Number historical attempts oldest-first so a resumed exam continues the
// sequence instead of restarting it at 1.
db.exec(`
  UPDATE sessions SET attempt_no = (
    SELECT COUNT(*) FROM sessions s2
     WHERE s2.exam_id = sessions.exam_id
       AND s2.student_id = sessions.student_id
       AND s2.id <= sessions.id
  )
`);

// The partial unique index can only be created once at most one live attempt
// remains per (exam, student); retire any older duplicates first.
db.exec(`
  UPDATE sessions SET status = 'abandoned'
   WHERE status = 'in_progress'
     AND id NOT IN (
       SELECT MAX(id) FROM sessions WHERE status = 'in_progress' GROUP BY exam_id, student_id
     )
`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_active
  ON sessions(exam_id, student_id) WHERE status = 'in_progress'`);

// Migration: add unique constraint on answers(session_id, question_id) to prevent
// duplicate answers from race conditions. SQLite doesn't support ADD CONSTRAINT
// directly, so we check if the index exists and create it if not.
try {
  const idxCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_answers_session_question'").get();
  if (!idxCheck) {
    // Remove duplicate answers first (keep the earliest one per session+question)
    db.exec(`
      DELETE FROM answers WHERE id NOT IN (
        SELECT MIN(id) FROM answers GROUP BY session_id, question_id
      )
    `);
    db.exec('CREATE UNIQUE INDEX idx_answers_session_question ON answers(session_id, question_id)');
    console.log('Migrated answers: added unique constraint on (session_id, question_id).');
  }
} catch (e) {
  // If the index creation fails (e.g. duplicates exist), log and continue —
  // the exam will still function but duplicate answers are possible.
  console.warn('Could not add unique constraint on answers:', e.message);
}

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
      answer_image  TEXT DEFAULT '',
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
      (id, session_id, question_id, q_order, answer_text, answer_image, is_correct, marks_awarded,
       max_marks, marked_by, ai_feedback, needs_review, reviewed, ai_detected, received_at, marked_at)
    SELECT
      id, session_id, question_id, q_order, answer_text, answer_image, is_correct, marks_awarded,
      max_marks, marked_by, ai_feedback, needs_review, reviewed, 0, received_at, marked_at
    FROM answers_legacy;
    DROP TABLE answers_legacy;
    COMMIT;
  `);
  db.exec('PRAGMA foreign_keys = ON');
  console.log('Migrated answers table (removed question FK for pool variants).');
}

module.exports = db;
