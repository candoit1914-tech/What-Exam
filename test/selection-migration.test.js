'use strict';
// Migration rehearsal for the selection columns. The schema change adds nine
// columns and creates exam_sections, and two pre-existing sessions rebuilds now
// copy selection_state/section/tentative/paper_total. Every other selection test
// runs against a FRESH database, where CREATE TABLE alone satisfies it — they
// would all still pass if the migration path were missing or wrong entirely.
//
// src/db.js opens the database at require time, so a legacy database can only be
// exercised from a child process. Pattern borrowed from test/timer-start.test.js.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-exam-migrate-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const NEW_COLUMNS = {
  questions: ['is_compulsory', 'section_key', 'source_number'],
  question_pool: ['is_compulsory', 'section_key'],
  sessions: ['selection_state', 'selection_section', 'selection_tentative', 'paper_total'],
  session_questions: ['is_selected', 'section_key'],
};

/** Boots src/db.js against `dbFile` and reports the post-migration state. */
function boot(dbFile) {
  const script = `
    const db = require(${JSON.stringify(require.resolve('../src/db'))});
    const cols = (t) => db.prepare('PRAGMA table_info(' + t + ')').all().map((c) => c.name);
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='sessions'").get().sql;
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map((r) => r.name);
    const out = {
      columns: Object.fromEntries(${JSON.stringify(Object.keys(NEW_COLUMNS))}.map((t) => [t, cols(t)])),
      hasExamSections: !!db.prepare("SELECT sql FROM sqlite_master WHERE name='exam_sections'").get(),
      sessionsIndexes: indexes,
      rows: {
        exams: db.prepare('SELECT COUNT(*) c FROM exams').get().c,
        students: db.prepare('SELECT COUNT(*) c FROM students').get().c,
        recipients: db.prepare('SELECT COUNT(*) c FROM exam_recipients').get().c,
        questions: db.prepare('SELECT COUNT(*) c FROM questions').get().c,
        pool: db.prepare('SELECT COUNT(*) c FROM question_pool').get().c,
        sessionQuestions: db.prepare('SELECT COUNT(*) c FROM session_questions').get().c,
        sessions: db.prepare('SELECT COUNT(*) c FROM sessions').get().c,
        answers: db.prepare('SELECT COUNT(*) c FROM answers').get().c,
      },
      // Every pre-existing question must arrive compulsory and ungrouped, which is
      // what keeps an existing exam behaving exactly as it did before.
      legacyQuestions: db.prepare('SELECT is_compulsory, section_key FROM questions ORDER BY id').all(),
      legacySession: db.prepare(
        'SELECT selection_state, selection_section, selection_tentative, paper_total, started_at FROM sessions ORDER BY id LIMIT 1'
      ).get() || null,
      legacySessionQuestions: db.prepare('SELECT is_selected, section_key FROM session_questions ORDER BY session_id, q_order').all(),
      stillNotNull: /started_at\\s+TEXT\\s+NOT\\s+NULL/i.test(sql),
    };
    db.close();
    console.log(JSON.stringify(out));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, DB_PATH: dbFile, SEED_ON_BOOT: 'false', UPLOADS_DIR: path.join(tmp, 'uploads') },
  });
  return JSON.parse(out.split('\n').filter((l) => l.trim().startsWith('{')).pop());
}

/**
 * A pre-selection database. `sessionsVariant` picks which legacy shape to build,
 * because the two rebuilds are triggered by different DDL and must each survive
 * carrying the new columns through.
 */
function seedLegacy(dbFile, { sessionsVariant = 'unique' } = {}) {
  const seed = new DatabaseSync(dbFile);
  seed.exec('PRAGMA foreign_keys = OFF');
  seed.exec(`CREATE TABLE exams (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, duration_minutes INTEGER, status TEXT, pass_percentage REAL)`);
  seed.exec(`CREATE TABLE students (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, name TEXT)`);
  seed.exec(`CREATE TABLE questions (id INTEGER PRIMARY KEY AUTOINCREMENT, exam_id INTEGER, q_order INTEGER, type TEXT, text TEXT, marks REAL DEFAULT 1)`);
  seed.exec(`CREATE TABLE answers (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, question_id INTEGER, q_order INTEGER, answer_text TEXT)`);
  seed.exec(`CREATE TABLE exam_recipients (exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE, student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE)`);

  const cols = sessionsVariant === 'unique'
    ? `UNIQUE(exam_id, student_id)`
    : '';
  seed.exec(`CREATE TABLE sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id         INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    student_id      INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    current_q_order INTEGER NOT NULL DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'in_progress',
    started_at      TEXT NOT NULL DEFAULT (datetime('now')),
    last_active_at  TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at        TEXT,
    final_score     REAL DEFAULT 0,
    final_percentage REAL DEFAULT 0,
    passed          INTEGER DEFAULT 0,
    retry_count     INTEGER NOT NULL DEFAULT 0,
    attempt_no      INTEGER NOT NULL DEFAULT 1${cols ? ',' : ''}
    ${cols}
  )`);
  seed.exec(`CREATE TABLE question_pool (id INTEGER PRIMARY KEY AUTOINCREMENT, exam_id INTEGER, type TEXT, text TEXT, marks REAL DEFAULT 1)`);
  seed.exec(`CREATE TABLE session_questions (
    session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES question_pool(id) ON DELETE CASCADE,
    q_order     INTEGER NOT NULL,
    PRIMARY KEY (session_id, q_order),
    UNIQUE (session_id, question_id)
  )`);

  seed.exec("INSERT INTO exams(id,title,duration_minutes,status) VALUES (1,'Legacy',30,'live')");
  seed.exec("INSERT INTO students(id,phone,name) VALUES (1,'233legacy00','Legacy Student')");
  seed.exec('INSERT INTO exam_recipients(exam_id,student_id) VALUES (1,1)');
  seed.exec("INSERT INTO questions(id,exam_id,q_order,type,text,marks) VALUES (1,1,1,'objective','Q1',5)");
  seed.exec("INSERT INTO question_pool(id,exam_id,type,text,marks) VALUES (1,1,'objective','Q1',5)");
  seed.exec("INSERT INTO sessions(id,exam_id,student_id,started_at) VALUES (1,1,1,'2026-01-01 09:00:00')");
  seed.exec('INSERT INTO session_questions(session_id,question_id,q_order) VALUES (1,1,1)');
  seed.exec("INSERT INTO answers(session_id,question_id,q_order,answer_text) VALUES (1,1,1,'A')");
  seed.close();
}

test('a legacy database gains every selection column without losing a row', () => {
  const dbFile = path.join(tmp, 'unique.db');
  seedLegacy(dbFile, { sessionsVariant: 'unique' });

  const after = boot(dbFile);

  for (const [table, expected] of Object.entries(NEW_COLUMNS)) {
    for (const c of expected) {
      assert.ok(after.columns[table].includes(c), `${table}.${c} must be added by the migration`);
    }
  }
  assert.ok(after.hasExamSections, 'exam_sections must be created');
  assert.deepEqual(after.rows, {
    exams: 1, students: 1, recipients: 1, questions: 1, pool: 1,
    sessionQuestions: 1, sessions: 1, answers: 1,
  }, 'no row may be lost or duplicated');
});

test('an existing question arrives compulsory and ungrouped', () => {
  // The DEFAULT 1 is the whole opt-in guarantee: a pre-selection question must be
  // compulsory and in no section, so every existing paper behaves exactly as before.
  const dbFile = path.join(tmp, 'defaults.db');
  seedLegacy(dbFile);

  const after = boot(dbFile);

  assert.deepEqual(after.legacyQuestions, [{ is_compulsory: 1, section_key: '' }]);
  assert.deepEqual(after.legacySessionQuestions, [{ is_selected: 1, section_key: '' }],
    'a legacy session question stays selected and ungrouped');
  assert.deepEqual(after.legacySession, {
    selection_state: '', selection_section: '', selection_tentative: '',
    paper_total: 0, started_at: '2026-01-01 09:00:00',
  }, 'the new session columns default empty and the start time survives verbatim');
});

test('the sessions rebuilds carry the new columns through', () => {
  // Both rebuilds are keyed on legacy DDL and now INSERT..SELECT selection_state,
  // selection_section, selection_tentative and paper_total. ensureColumn must have
  // run first or those column references fail outright.
  for (const variant of ['unique', 'notnull']) {
    const dbFile = path.join(tmp, `rebuild-${variant}.db`);
    seedLegacy(dbFile, { sessionsVariant: variant });

    const after = boot(dbFile);

    assert.equal(after.stillNotNull, false, `${variant}: started_at must end up nullable`);
    assert.equal(after.rows.sessions, 1, `${variant}: the session survives the rebuild`);
    assert.equal(after.legacySession.started_at, '2026-01-01 09:00:00', `${variant}: start time preserved`);
    assert.equal(after.legacySession.selection_state, '', `${variant}: selection_state copied through`);
    assert.equal(after.legacySession.paper_total, 0, `${variant}: paper_total copied through`);
    assert.deepEqual(after.sessionsIndexes, [
      'idx_sessions_active', 'idx_sessions_exam', 'idx_sessions_exam_student', 'idx_sessions_status',
    ], `${variant}: every sessions index must be restored`);
  }
});

test('the migration is idempotent and does not duplicate rows', () => {
  const dbFile = path.join(tmp, 'idempotent.db');
  seedLegacy(dbFile);

  const first = boot(dbFile);
  const second = boot(dbFile);

  assert.deepEqual(second.rows, first.rows, 'a second boot must change no row counts');
  assert.equal(second.rows.sessions, 1, 'a second rebuild must not duplicate the session');
  assert.deepEqual(second.legacyQuestions, first.legacyQuestions);
  assert.deepEqual(second.legacySession, first.legacySession);
});