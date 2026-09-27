'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-attempts-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.DOTENV_CONFIG_PATH = path.join(tmp, '.env');
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.SEED_ON_BOOT = 'false';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const exam = require('../src/services/exam');
after(() => { db.close(); fs.rmSync(tmp, {recursive:true,force:true}); });
function fixture() {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Attempts',30,'live')").run().lastInsertRowid;
  const sid = db.prepare('INSERT INTO students(phone) VALUES (?)').run('233test' + eid).lastInsertRowid;
  db.prepare("INSERT INTO questions(exam_id,q_order,type,text,correct_answer) VALUES (?,1,'objective','Test','A')").run(eid);
  return exam.createSession(eid, sid);
}
test('restart creates a new attempt and preserves historical answers and score', () => {
  const first = fixture();
  const q = exam.getSessionQuestion(first.id, 1);
  db.prepare("INSERT INTO answers(session_id,question_id,q_order,answer_text,marks_awarded) VALUES (?,?,1,'A',1)").run(first.id,q.id);
  db.prepare("UPDATE sessions SET status='completed',final_score=1 WHERE id=?").run(first.id);
  const next = exam.restartSession(first);
  assert.notEqual(next.id, first.id);
  assert.equal(next.attempt_no, 2);
  assert.equal(db.prepare('SELECT final_score FROM sessions WHERE id=?').get(first.id).final_score,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM answers WHERE session_id=?').get(first.id).n,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM answers WHERE session_id=?').get(next.id).n,0);
  assert.equal(exam.getSessionQuestionCount(next.id),1);
});
test('attempt cap is per student and leaves existing attempts intact on failure', () => {
  const first = fixture();
  db.prepare('UPDATE exams SET max_attempts=1 WHERE id=?').run(first.exam_id);
  assert.throws(() => exam.restartSession(first), /attempt limit/i);
  assert.equal(db.prepare('SELECT status FROM sessions WHERE id=?').get(first.id).status,'in_progress');
  const sid = db.prepare("INSERT INTO students(phone) VALUES ('233other')").run().lastInsertRowid;
  assert.equal(exam.createSession(first.exam_id,sid).attempt_no,1);
});
test('only one active attempt is allowed and creation resumes it', () => {
  const first = fixture();
  assert.equal(exam.createSession(first.exam_id,first.student_id).id, first.id);
  assert.throws(() => db.prepare('INSERT INTO sessions(exam_id,student_id,attempt_no) VALUES (?,?,2)').run(first.exam_id,first.student_id), /UNIQUE/);
});
