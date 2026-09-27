'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-delivery-'));
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
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Delivery',30,'live')").run().lastInsertRowid;
  const sid = db.prepare('INSERT INTO students(phone) VALUES (?)').run('233' + Date.now() + eid).lastInsertRowid;
  db.prepare('INSERT INTO exam_recipients(exam_id,student_id) VALUES (?,?)').run(eid, sid);
  for (let i = 1; i <= 2; i++) db.prepare("INSERT INTO questions(exam_id,q_order,type,text,options,correct_answer) VALUES (?,?,'objective',?,?,'A')").run(eid, i, 'Question ' + i, JSON.stringify([{key:'A',text:'Yes'},{key:'B',text:'No'}]));
  const session = exam.createSession(eid, sid);
  const student = db.prepare('SELECT * FROM students WHERE id=?').get(sid);
  return { eid, session, student };
}

test('failed next-question send preserves position; recovery sends and advances once', async () => {
  const { session, student } = fixture();
  const first = exam.getSessionQuestion(session.id, 1);
  db.prepare("INSERT INTO answers(session_id,question_id,q_order,answer_text) VALUES (?,?,1,'A')").run(session.id, first.id);
  const original = wa.sendText;
  wa.sendText = async () => { throw new Error('simulated outage'); };
  try {
    await assert.rejects(exam.processAnswer(session, student, 'A'), /simulated outage/);
    assert.equal(db.prepare('SELECT current_q_order FROM sessions WHERE id=?').get(session.id).current_q_order, 1);
    const queued = db.prepare("SELECT * FROM message_outbox WHERE session_id=? AND kind='question'").get(session.id);
    assert.equal(queued.state, 'queued');
    assert.equal(queued.q_order, 2);
    let sends = 0;
    wa.sendText = async () => { sends++; return { messages: [{ id: 'mock-message' }] }; };
    await exam.recoverQueuedSends();
    assert.equal(db.prepare('SELECT current_q_order FROM sessions WHERE id=?').get(session.id).current_q_order, 2);
    assert.equal(db.prepare('SELECT state FROM message_outbox WHERE id=?').get(queued.id).state, 'sent');
    const count = sends;
    await exam.recoverQueuedSends();
    assert.equal(sends, count);
  } finally { wa.sendText = original; }
});

test('successful question delivery records recipient acceptance', async () => {
  const { eid, session, student } = fixture();
  const original = wa.sendText;
  wa.sendText = async () => ({ messages: [{id:'accepted'}] });
  try {
    assert.equal(await exam.sendQuestionTo(session, student), true);
    assert.ok(db.prepare('SELECT sent_at FROM exam_recipients WHERE exam_id=? AND student_id=?').get(eid, student.id).sent_at);
  } finally { wa.sendText = original; }
});

test('inactive exam sends are skipped rather than reported as successful', async () => {
  const { eid } = fixture();
  db.prepare("UPDATE exams SET status='ended' WHERE id=?").run(eid);
  const original = wa.sendText;
  wa.sendText = async () => ({ messages: [{ id: 'notice' }] });
  try {
    const report = await exam.sendExamToRecipients(eid);
    assert.equal(report.sent, 0);
    assert.equal(report.resumed, 0);
    assert.equal(report.skipped, 1);
  } finally { wa.sendText = original; }
});
