'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-bulkdel-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.DOTENV_CONFIG_PATH = path.join(tmp, '.env');
process.env.SEED_ON_BOOT = 'false';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const students = require('../src/services/students');
after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const TABLES = ['students', 'exam_recipients', 'sessions', 'answers'];
const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;

// Every test file shares one database, so absolute row counts are meaningless
// once the first test has run. Each seed records what was there beforehand and
// assertions compare against that baseline instead.
let seq = 0;
function seed(studentCount = 3) {
  const before = Object.fromEntries(TABLES.map((t) => [t, count(t)]));
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Bulk',30,'live')").run().lastInsertRowid;
  db.prepare("INSERT INTO questions(exam_id,q_order,type,text,correct_answer) VALUES (?,1,'objective','Q1','A')").run(eid);
  const ids = [];
  for (let i = 0; i < studentCount; i++) {
    const sid = db.prepare('INSERT INTO students(phone) VALUES (?)').run('233bulkdel' + (seq++)).lastInsertRowid;
    db.prepare('INSERT INTO exam_recipients(exam_id,student_id) VALUES (?,?)').run(eid, sid);
    const sess = db.prepare("INSERT INTO sessions(exam_id,student_id,started_at) VALUES (?,?,datetime('now'))").run(eid, sid).lastInsertRowid;
    const q = db.prepare('SELECT id FROM questions WHERE exam_id=?').get(eid);
    db.prepare("INSERT INTO answers(session_id,question_id,q_order,answer_text) VALUES (?,?,1,'A')").run(sess, q.id);
    ids.push(sid);
  }
  return { eid, ids, before };
}

test('bulk delete removes every selected student and their dependent rows', () => {
  const { ids, before } = seed();
  assert.equal(students.bulkDeleteStudents(ids), 3);
  for (const t of TABLES) assert.equal(count(t), before[t], `${t} should be back to its baseline`);
});

test('bulk delete leaves unselected students alone', () => {
  const { ids, before } = seed();
  students.bulkDeleteStudents([ids[0]]);
  assert.equal(count('students'), before.students + 2);
  assert.ok(db.prepare('SELECT * FROM students WHERE id=?').get(ids[1]));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions WHERE student_id=?').get(ids[1]).c, 1);
});

test('repeated ids are collapsed and unknown ids are silent no-ops', () => {
  const { ids, before } = seed();
  assert.equal(students.bulkDeleteStudents([ids[0], ids[0], 999999]), 1);
  assert.equal(count('students'), before.students + 2);
});

test('junk input deletes nothing instead of throwing', () => {
  const { ids, before } = seed();
  assert.equal(students.bulkDeleteStudents([null, undefined, 'abc', {}, -1, 0]), 0);
  assert.equal(students.bulkDeleteStudents('not-an-array'), 0);
  assert.equal(students.bulkDeleteStudents([]), 0);
  assert.equal(count('students'), before.students + 3);
  assert.ok(db.prepare('SELECT * FROM students WHERE id=?').get(ids[0]));
});

test('a student linked to another exam loses the link but the exam survives', () => {
  const { ids } = seed();
  const other = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Other',30,'live')").run().lastInsertRowid;
  db.prepare('INSERT INTO exam_recipients(exam_id,student_id) VALUES (?,?)').run(other, ids[0]);
  students.bulkDeleteStudents([ids[0]]);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM exam_recipients WHERE exam_id=?').get(other).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM exams WHERE id=?').get(other).c, 1);
});

test('bulk delete agrees with the single-student delete the dashboard already uses', () => {
  // Both paths must run the identical statement, so a student removed one at a
  // time leaves exactly the same rows behind as a student removed in bulk.
  const bulk = seed();
  const single = seed();
  const removedFromBulk = students.bulkDeleteStudents([bulk.ids[0]]);
  const removedFromSingle = db.prepare('DELETE FROM students WHERE id = ?').run(single.ids[0]).changes;
  assert.equal(removedFromBulk, removedFromSingle);
  for (const t of TABLES) {
    // Two seeds add six rows of each kind, the two deletes remove two.
    assert.equal(count(t), bulk.before[t] + 4, `${t} should be identical after either route`);
  }
});
