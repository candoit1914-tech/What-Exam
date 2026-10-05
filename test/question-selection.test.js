'use strict';
// Selection harness: env must be set before ../src/db is required, or db.js
// opens the real database. Copied from test/timer-start.test.js:1-19.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-exam-sel-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.DOTENV_CONFIG_PATH = path.join(tmp, '.env');
process.env.SEED_ON_BOOT = 'false';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

// sessions.student_id is a real FK and SEED_ON_BOOT is off, so every session
// fixture has to create its student first.
const aStudent = () => db.prepare('INSERT INTO students(phone) VALUES (?)')
  .run('233' + Math.random().toString(36).slice(2, 10)).lastInsertRowid;

test('every selection column exists', () => {
  for (const c of ['is_compulsory', 'section_key', 'source_number']) {
    assert.ok(cols('questions').includes(c), `questions.${c}`);
  }
  for (const c of ['is_compulsory', 'section_key']) {
    assert.ok(cols('question_pool').includes(c), `question_pool.${c}`);
  }
  for (const c of ['selection_state', 'selection_section', 'selection_tentative', 'paper_total']) {
    assert.ok(cols('sessions').includes(c), `sessions.${c}`);
  }
  for (const c of ['is_selected', 'section_key']) {
    assert.ok(cols('session_questions').includes(c), `session_questions.${c}`);
  }
});

test('the printed number is stored apart from the insertion order', () => {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Nums',30,'live')").run().lastInsertRowid;
  // A dropped block means q_order 1 is the paper's question 7. Only source_number
  // can tell the reconciliation which question the paper actually named.
  const qid = db.prepare("INSERT INTO questions(exam_id,q_order,type,text,source_number) VALUES (?,1,'theory','Q',7)")
    .run(eid).lastInsertRowid;
  const q = db.prepare('SELECT q_order, source_number FROM questions WHERE id=?').get(qid);
  assert.equal(q.q_order, 1);
  assert.equal(q.source_number, 7);
});

test('a question is compulsory and ungrouped unless told otherwise', () => {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Defaults',30,'live')").run().lastInsertRowid;
  const qid = db.prepare("INSERT INTO questions(exam_id,q_order,type,text) VALUES (?,1,'theory','Q')").run(eid).lastInsertRowid;
  const q = db.prepare('SELECT * FROM questions WHERE id=?').get(qid);
  assert.equal(q.is_compulsory, 1);
  assert.equal(q.section_key, '');
});

test('a drawn question defaults to selected, so nothing changes for old exams', () => {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Drawn',30,'live')").run().lastInsertRowid;
  // session_questions.question_id references question_pool, not questions: a
  // drawn row always points at a pool row.
  const qid = db.prepare("INSERT INTO question_pool(exam_id,type,text) VALUES (?,'theory','Q')").run(eid).lastInsertRowid;
  const sid = db.prepare('INSERT INTO sessions(exam_id,student_id) VALUES (?,?)').run(eid, aStudent()).lastInsertRowid;
  db.prepare('INSERT INTO session_questions(session_id,question_id,q_order) VALUES (?,?,1)').run(sid, qid);
  const row = db.prepare('SELECT * FROM session_questions WHERE session_id=?').get(sid);
  assert.equal(row.is_selected, 1, 'is_selected must default to 1 or every existing exam loses questions');
  assert.equal(row.section_key, '');
});

test('a session starts unlocked with no paper total recorded', () => {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Session',30,'live')").run().lastInsertRowid;
  const sid = db.prepare('INSERT INTO sessions(exam_id,student_id) VALUES (?,?)').run(eid, aStudent()).lastInsertRowid;
  const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(sid);
  assert.equal(s.selection_state, '');
  assert.equal(s.selection_section, '');
  assert.equal(s.selection_tentative, '');
  assert.equal(s.paper_total, 0);
});

test('exam_sections stores a rule and scopes it to its exam', () => {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Sections',30,'live')").run().lastInsertRowid;
  const other = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Other',30,'live')").run().lastInsertRowid;
  db.prepare(
    `INSERT INTO exam_sections(exam_id,section_key,title,instructions,position,answer_count)
     VALUES (?,?,?,?,?,?)`
  ).run(eid, 'sec-b', 'SECTION B', 'Answer any THREE questions', 1, 3);
  const rows = db.prepare('SELECT * FROM exam_sections WHERE exam_id=?').all(eid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].answer_count, 3);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM exam_sections WHERE exam_id=?').get(other).c, 0);
});

test('a section rule upserts rather than duplicating', () => {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Upsert',30,'live')").run().lastInsertRowid;
  const upsert = db.prepare(
    `INSERT INTO exam_sections(exam_id,section_key,title,instructions,position,answer_count)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(exam_id, section_key) DO UPDATE SET
       title=excluded.title, instructions=excluded.instructions,
       position=excluded.position, answer_count=excluded.answer_count`
  );
  upsert.run(eid, 'b', 'SECTION B', 'Answer two', 1, 2);
  upsert.run(eid, 'b', 'SECTION B (revised)', 'Answer one', 1, 1);
  const rows = db.prepare('SELECT * FROM exam_sections WHERE exam_id=?').all(eid);
  assert.equal(rows.length, 1, 'one row per section key');
  assert.equal(rows[0].answer_count, 1);
  assert.equal(rows[0].instructions, 'Answer one');
});

test('clearing the rules deletes them all', () => {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Clear',30,'live')").run().lastInsertRowid;
  db.prepare(
    `INSERT INTO exam_sections(exam_id,section_key,title,instructions,position,answer_count)
     VALUES (?,?,?,?,?,?)`
  ).run(eid, 'b', 'SECTION B', 'Answer two', 1, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM exam_sections WHERE exam_id=?').get(eid).c, 1);

  // The body an admin sends after emptying the card is { sections: [] }.
  db.prepare('DELETE FROM exam_sections WHERE exam_id = ?').run(eid);
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM exam_sections WHERE exam_id=?').get(eid).c, 0,
    'an empty sections array must remove the rules, not leave them orphaned'
  );
});