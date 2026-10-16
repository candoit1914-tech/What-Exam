'use strict';
// ── The waiting room ────────────────────────────────────────────────────
// A free paper invites first and opens on request: nothing of it — no
// question, no countdown — reaches the student until entry. These tests hold
// the gate itself: what counts as entry, what happens to everything else, and
// the fact that the clock is armed by entry and by nothing else.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-entry-'));
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

const sent = [];
const originalText = wa.sendText;
wa.sendText = async (phone, text) => { sent.push(String(text)); return { messages: [{ id: 'mock' }] }; };
after(() => { wa.sendText = originalText; db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

/** A live free paper with one objective question, invited to one student. */
function fixture({ send = true } = {}) {
  const eid = db
    .prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Entry',30,'live')")
    .run().lastInsertRowid;
  const sid = db
    .prepare('INSERT INTO students(phone) VALUES (?)')
    .run('233entry' + eid).lastInsertRowid;
  db.prepare('INSERT INTO exam_recipients(exam_id,student_id) VALUES (?,?)').run(eid, sid);
  db.prepare(
    "INSERT INTO questions(exam_id,q_order,type,text,options,correct_answer) VALUES (?,1,'objective','Q1',?,'A')"
  ).run(eid, JSON.stringify([{ key: 'A', text: 'Yes' }, { key: 'B', text: 'No' }]));
  if (send) exam.sendExamToRecipients(eid);
  sent.length = 0;
  const student = db.prepare('SELECT * FROM students WHERE id=?').get(sid);
  return { eid, sid, student };
}
const startedAt = (eid) =>
  db.prepare('SELECT started_at FROM sessions WHERE exam_id=?').get(eid).started_at;

// ── what counts as entry ────────────────────────────────────────────────

test('the words that open a paper, and the sentences that do not', () => {
  for (const word of ['start', 'START', 'Start', 'begin', 'hi', 'hello', 'hey', 'exam', 'yes', 'ready', 'go', 'ok', 'sure', 'alright']) {
    assert.equal(exam.isEntryRequest(word), true, `"${word}" must open the paper`);
  }
  assert.equal(exam.isEntryRequest('yes I am ready'), true, 'a whole sentence asking to begin');
  assert.equal(exam.isEntryRequest("let's begin"), true);
  assert.equal(exam.isEntryRequest('Hi, good morning'), false, 'a greeting sentence is politeness, not entry — it must not arm the clock');
  assert.equal(exam.isEntryRequest('hello everyone, excited to start'), true, '…but a sentence that carries a word which only means begin still enters');
  assert.equal(exam.isEntryRequest('what exam is this?'), false, 'a question ABOUT the exam is not entry');
  assert.equal(exam.isEntryRequest(''), false, 'an empty tap');
  assert.equal(exam.isEntryRequest('A'), false, 'an answer to a question nobody has been shown');
  assert.equal(exam.isEntryRequest('2'), false);
  assert.equal(exam.isEntryRequest('thanks for the invite'), false);
  assert.equal(exam.isEntryRequest('A', { replyId: 'wamid.reply1' }), true, 'a tapped reply is a deliberate entry');
  assert.equal(exam.isEntryRequest('', { replyId: 'wamid.reply2' }), true, 'a tap carries its own intent');
});

// ── the gate ────────────────────────────────────────────────────────────

test('an invited student still sees nothing until they ask to come in', async () => {
  const { eid, student } = fixture();

  const res = await exam.handleInbound(student.phone, 'what exam is this?');

  assert.equal(res.reason, 'awaiting_entry');
  assert.ok(!sent.some((m) => m.includes('QUESTION 1')), 'a student who did not enter is shown no question');
  assert.match(sent.join('\n'), /Type \*START\*/, 'the reminder says exactly how to get in');
  assert.equal(startedAt(eid), null, 'the clock is not armed by the asking');
  assert.equal(
    db.prepare(`SELECT COUNT(*) c FROM answers a JOIN sessions s ON s.id=a.session_id WHERE s.exam_id=?`).get(eid).c,
    0,
    'and nothing is recorded as an answer'
  );
});

test('entry is what opens the paper: the confirmation, then question 1', async () => {
  const { eid, student } = fixture();

  const res = await exam.handleInbound(student.phone, 'START');

  assert.equal(res.reason, 'started');
  assert.ok(sent.some((m) => /You're in/.test(m)), 'the student is told they are in');
  assert.ok(sent.some((m) => m.includes('QUESTION 1')), 'and then the paper arrives');
  assert.ok(startedAt(eid), 'the clock arms on entry, and on entry only');
  assert.equal(
    db.prepare(`SELECT COUNT(*) c FROM answers a JOIN sessions s ON s.id=a.session_id WHERE s.exam_id=?`).get(eid).c,
    0,
    'entry is not an answer'
  );
});

test('every later reply is an answer, not another start', async () => {
  const { eid, student } = fixture();
  await exam.handleInbound(student.phone, 'hi');
  sent.length = 0;

  const res = await exam.handleInbound(student.phone, 'A');

  assert.equal(res.reason, 'answered', 'the answer is graded, not read as another entry');
  assert.ok(!sent.some((m) => /You're in/.test(m)), 'the entry moment is not replayed at them');
  assert.ok(!sent.some((m) => m.includes('QUESTION 1')), 'and question 1 is not pushed back over their answer');
});

test('the first message with no session behind it takes a seat, not a paper', async () => {
  const { eid, student } = fixture({ send: false }); // invited by nothing yet

  const seated = await exam.handleInbound(student.phone, 'is this maths?');

  assert.equal(seated.reason, 'awaiting_start', 'no session is created into an exam already running');
  assert.ok(sent.some((m) => m.includes('INSTRUCTIONS')), 'the invitation is what goes out');
  assert.ok(!sent.some((m) => m.includes('QUESTION 1')), 'with nothing of the paper behind it');
  assert.equal(startedAt(eid), null, 'and the clock stays off');

  sent.length = 0;
  const entered = await exam.handleInbound(student.phone, 'START');
  assert.equal(entered.reason, 'started');
  assert.ok(sent.some((m) => m.includes('QUESTION 1')), 'the entry is what finally opens the paper');
  assert.ok(startedAt(eid), 'the clock arms at that moment');
});
