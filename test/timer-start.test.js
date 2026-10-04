'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-timer-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.DOTENV_CONFIG_PATH = path.join(tmp, '.env');
process.env.SEED_ON_BOOT = 'false';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const exam = require('../src/services/exam');
const wa = require('../src/services/whatsapp');
const config = require('../src/config');
config.exam.sendCertificates = false;
after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function fixture() {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Timer',30,'live')").run().lastInsertRowid;
  const sid = db.prepare('INSERT INTO students(phone) VALUES (?)').run('233timer' + eid).lastInsertRowid;
  db.prepare('INSERT INTO exam_recipients(exam_id,student_id) VALUES (?,?)').run(eid, sid);
  db.prepare("INSERT INTO questions(exam_id,q_order,type,text,options,correct_answer) VALUES (?,1,'objective','Q1',?,'A')")
    .run(eid, JSON.stringify([{ key: 'A', text: 'Yes' }, { key: 'B', text: 'No' }]));
  return { eid, sid, student: db.prepare('SELECT * FROM students WHERE id=?').get(sid) };
}

test('a new session has no start time, so the clock is not running yet', () => {
  const { eid, sid } = fixture();
  const session = exam.createSession(eid, sid);
  const row = db.prepare('SELECT started_at FROM sessions WHERE id=?').get(session.id);
  assert.equal(row.started_at, null);
});

test('an unstarted session has a far-future deadline, not an invalid one', () => {
  const { eid, sid } = fixture();
  const session = exam.createSession(eid, sid);
  const dl = exam.deadline(session);
  assert.ok(Number.isFinite(dl.getTime()), 'deadline must be a real date');
  assert.ok(dl.getTime() > Date.now() + 86400000, 'deadline must be far in the future');
});

test('cleanup never expires a session that has not started', async () => {
  const { eid, sid } = fixture();
  exam.createSession(eid, sid);
  const n = await exam.finalizeStaleSessions();
  const row = db.prepare('SELECT status FROM sessions WHERE exam_id=? AND student_id=?').get(eid, sid);
  assert.equal(n, 0);
  assert.equal(row.status, 'in_progress');
});

test('cleanup still expires a session that started long ago', async () => {
  const { eid, sid } = fixture();
  const session = exam.createSession(eid, sid);
  db.prepare("UPDATE sessions SET started_at=datetime('now','-50 minutes') WHERE id=?").run(session.id);
  const original = wa.sendText;
  wa.sendText = async () => ({ messages: [{ id: 'mock' }] });
  wa.sendImage = async () => {};
  try {
    const n = await exam.finalizeStaleSessions();
    assert.ok(n >= 1, 'the lapsed session must be finalized');
    assert.equal(db.prepare('SELECT status FROM sessions WHERE id=?').get(session.id).status, 'expired');
  } finally {
    wa.sendText = original;
  }
});

// Every test above runs against a freshly created database, so the new CREATE
// TABLE is enough to satisfy them and they would still pass if the migration
// for existing databases were missing entirely. The user's real exams.db was
// created before the column became nullable, so the rebuild has to be proven on
// a database that carries the old NOT NULL schema. src/db.js opens the database
// at require time, which means this needs a child process rather than another
// require in this file.
function runAgainstOldSchemaDb(dbFile) {
  const script = `
    const db = require(${JSON.stringify(require.resolve('../src/db'))});
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='sessions'").get().sql;
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map((r) => r.name);
    const counts = {
      students: db.prepare('SELECT COUNT(*) c FROM students').get().c,
      recipients: db.prepare('SELECT COUNT(*) c FROM exam_recipients').get().c,
      sessions: db.prepare('SELECT COUNT(*) c FROM sessions').get().c,
      answers: db.prepare('SELECT COUNT(*) c FROM answers').get().c,
    };
    const firstRow = db.prepare('SELECT started_at FROM sessions ORDER BY id LIMIT 1').get();
    const startedAt = firstRow ? firstRow.started_at : null;
    const update = db.prepare('UPDATE sessions SET started_at=NULL WHERE id=(SELECT MIN(id) FROM sessions)').run().changes;
    db.close();
    console.log(JSON.stringify({ stillNotNull: /started_at\\s+TEXT\\s+NOT\\s+NULL/i.test(sql), indexes, counts, startedAt, update }));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, DB_PATH: dbFile },
  });
  const line = out.split('\n').filter((l) => l.trim().startsWith('{')).pop();
  return JSON.parse(line);
}

// Builds a database that predates the nullable column. `seedRows` adds the rows
// the first test needs to prove nothing is lost; the idempotency test leaves the
// sessions table empty so a second rebuild has no row to duplicate.
function seedLegacyDb(dbFile, { withRows }) {
  const seed = new DatabaseSync(dbFile);
  seed.exec('PRAGMA foreign_keys = OFF');
  seed.exec(`CREATE TABLE exams (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, duration_minutes INTEGER, status TEXT)`);
  seed.exec(`CREATE TABLE students (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, name TEXT)`);
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
    attempt_no      INTEGER NOT NULL DEFAULT 1
  )`);
  seed.exec('CREATE TABLE questions (id INTEGER PRIMARY KEY AUTOINCREMENT, exam_id INTEGER, q_order INTEGER, type TEXT, text TEXT)');
  seed.exec(`CREATE TABLE answers (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, question_id INTEGER, q_order INTEGER, answer_text TEXT)`);
  seed.exec(`CREATE TABLE exam_recipients (exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE, student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE)`);
  seed.exec("INSERT INTO exams(id,title,duration_minutes,status) VALUES (1,'Legacy',30,'live')");
  seed.exec("INSERT INTO students(id,phone,name) VALUES (1,'233legacy00','Legacy Student')");
  seed.exec("INSERT INTO exam_recipients(exam_id,student_id) VALUES (1,1)");
  seed.exec("INSERT INTO questions(id,exam_id,q_order,type,text) VALUES (1,1,1,'objective','Q1')");
  if (withRows) {
    seed.exec("INSERT INTO sessions(id,exam_id,student_id,started_at) VALUES (1,1,1,'2026-01-01 09:00:00')");
    seed.exec("INSERT INTO answers(session_id,question_id,q_order,answer_text) VALUES (1,1,1,'A')");
  }
  seed.close();
}

test('an existing database is rebuilt so started_at can be null', () => {
  const old = path.join(tmp, 'existing.db');
  seedLegacyDb(old, { withRows: true });

  const result = runAgainstOldSchemaDb(old);

  assert.equal(result.stillNotNull, false, 'the rebuilt column must no longer be NOT NULL');
  assert.equal(result.update, 1, 'started_at must be writable as NULL after the rebuild');
  assert.deepEqual(result.counts, { students: 1, recipients: 1, sessions: 1, answers: 1 }, 'no row may be lost');
  assert.equal(result.startedAt, '2026-01-01 09:00:00', 'the existing start time must survive verbatim');
  assert.deepEqual(result.indexes, [
    'idx_sessions_active',
    'idx_sessions_exam',
    'idx_sessions_exam_student',
    'idx_sessions_status',
  ], 'every sessions index must exist after the rebuild');
});

test('the started_at migration does not run twice', () => {
  const old = path.join(tmp, 'idempotent.db');
  seedLegacyDb(old, { withRows: false });

  const first = runAgainstOldSchemaDb(old);
  const second = runAgainstOldSchemaDb(old);

  assert.equal(first.stillNotNull, false);
  assert.equal(second.stillNotNull, false);
  assert.deepEqual(second.indexes, first.indexes, 'the second run must not disturb the indexes');
  assert.equal(second.counts.sessions, 0, 'a second rebuild must not duplicate or drop rows');
});
