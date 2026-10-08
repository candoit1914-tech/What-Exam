'use strict';
// How a theory paper reads in the chat. The number goes on top, the main
// question follows, and every sub-question sits in its own block with a blank
// line above it — the way the printed paper spreads them — never run together
// and never with stray double blank lines.
//
// The second half is about words that are not answers. The payment
// confirmation tells a student whose paper did not open to type "Hi" or
// "Exam", so that reply has to start the paper, not become their answer to
// question 1.
require('./helpers/isolate');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const exam = require('../src/services/exam');
const wa = require('../src/services/whatsapp');

const SUBS = [
  { text: 'Define evaporation.', marks: 2 },
  { text: 'Name two sources of water.', marks: 3 },
];

const nowZ = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const digits = (n) => Math.floor(Math.random() * 10 ** n).toString().padStart(n, '0');

/**
 * A section-less theory paper: no selector, no passages, no headings — what
 * lands in the chat is exactly what these functions compose.
 *
 * The invite and question 1 are already marked sent, so an inbound reply is
 * answered rather than treated as the reply that opens the paper.
 */
function theoryPaper({ count = 3, followUps = SUBS } = {}) {
  const eid = db
    .prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Weather',30,'live')")
    .run().lastInsertRowid;
  const phone = '2330' + digits(8);
  const studentId = db.prepare('INSERT INTO students(phone) VALUES (?)').run(phone).lastInsertRowid;
  const sid = db
    .prepare('INSERT INTO sessions(exam_id,student_id,started_at) VALUES (?,?,?)')
    .run(eid, studentId, nowZ()).lastInsertRowid;

  const stems = ['Explain the water cycle.', 'Describe the rock cycle.', 'Why do seasons change?'];
  const pool = db.prepare(
    'INSERT INTO question_pool(exam_id,type,text,correct_answer,marks,follow_ups) VALUES (?,?,?,?,?,?)'
  );
  const ins = db.prepare('INSERT INTO session_questions(session_id,question_id,q_order) VALUES (?,?,?)');
  const questions = [];
  stems.slice(0, count).forEach((text, i) => {
    const qid = pool
      .run(eid, 'theory', text, '', 5, JSON.stringify(i === 0 ? followUps : []))
      .lastInsertRowid;
    ins.run(sid, qid, i + 1);
    questions.push(qid);
  });

  const outbox = db.prepare(
    "INSERT INTO message_outbox(session_id,question_id,kind,recipient,state) VALUES (?,?,?,?,'sent')"
  );
  outbox.run(sid, 0, 'intro', phone);
  outbox.run(sid, questions[0], 'question', phone);

  return { eid, sid, studentId, phone, questions };
}

/** Run fn with wa.sendText captured instead of sent. */
async function capturing(fn) {
  const sent = [];
  const original = wa.sendText;
  wa.sendText = async (...args) => { sent.push(args); };
  try {
    await fn();
  } finally {
    wa.sendText = original;
  }
  return sent;
}

const answerCount = (sid) =>
  db.prepare('SELECT COUNT(*) c FROM answers WHERE session_id = ?').get(sid).c;

// ── layout ────────────────────────────────────────────────────────────

test('sub-questions are spread out under the main question', () => {
  assert.equal(
    exam.formatSubQuestions({ type: 'theory', follow_ups: JSON.stringify(SUBS) }),
    '*Sub-questions:*\n\n' +
      '*(a)* Define evaporation.\nMarks: 2\n\n' +
      '*(b)* Name two sources of water.\nMarks: 3',
    'each sub-question in its own block, one blank line above it'
  );
});

test('a question with no sub-questions produces nothing to insert', () => {
  assert.equal(exam.formatSubQuestions({ type: 'theory', follow_ups: '[]' }), '', 'empty list');
  assert.equal(exam.formatSubQuestions({ type: 'theory', follow_ups: 'not json' }), '', 'malformed list');
  assert.equal(exam.formatSubQuestions({ type: 'theory' }), '', 'never stored');
  assert.equal(
    exam.formatSubQuestions({ type: 'objective', follow_ups: JSON.stringify(SUBS) }),
    '',
    'an objective question has no sub-questions'
  );
  assert.equal(exam.formatSubQuestions(null), '');
});

test('sub-questions letter from (a) with no gaps and no undefined marks', () => {
  const out = exam.formatSubQuestions({
    type: 'theory',
    follow_ups: JSON.stringify([
      { text: '', marks: 1 },          // dropped: there is nothing to answer
      { text: 'Define condensation.' }, // no marks value on this row
      { text: 'Name a cloud form.', marks: 0 },
    ]),
  });

  assert.ok(out.includes('*(a)* Define condensation.'), 'the first real sub-question is (a)');
  assert.ok(out.includes('*(b)* Name a cloud form.'), 'the next is (b), not (c)');
  assert.doesNotMatch(out, /\*\(c\)\*/, 'the dropped entry leaves no gap behind it');
  assert.doesNotMatch(out, /Marks: undefined/, 'a missing mark value is never printed as undefined');
  assert.doesNotMatch(out, /Marks: 0/, 'a zero mark value is not shown either');
});

test('the question arrives numbered, spaced, with the timer last', async () => {
  const { sid, studentId, phone } = theoryPaper();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);

  const sent = await capturing(() => exam.sendQuestionTo(session, student));
  const message = sent[sent.length - 1][1];

  assert.match(message, /^\*QUESTION 1\*\n\nExplain the water cycle\./, 'the number leads the message');
  assert.ok(
    message.includes('Explain the water cycle.\n\n*Sub-questions:*\n\n'),
    'a blank line separates the main question from the first sub-question'
  );
  assert.ok(
    message.includes('*(a)* Define evaporation.\nMarks: 2\n\n*(b)* Name two sources of water.\nMarks: 3'),
    'the sub-questions are vertical, one block each'
  );
  assert.match(
    message,
    /Marks: 3\n\nTime remaining: \*[\d:]+\*$/,
    'the timer follows the last sub-question exactly one blank line away'
  );
  assert.doesNotMatch(message, /\n{3,}/, 'no run of blank lines anywhere in the message');
});

// ── greetings ─────────────────────────────────────────────────────────

test('a greeting never becomes an answer to question 1', async () => {
  const { sid, phone } = theoryPaper();

  for (const greeting of ['Hi', 'Exam', 'EXAM', 'hi']) {
    const sent = await capturing(() => exam.handleInbound(phone, greeting));

    assert.equal(answerCount(sid), 0, `"${greeting}" must not be recorded as an answer`);
    assert.ok(
      sent.some((m) => String(m[1]).includes('Explain the water cycle.')),
      `"${greeting}" puts the question back in front of them`
    );
  }
});

test('a real theory answer still lands', async () => {
  const { sid, phone } = theoryPaper();

  await capturing(() => exam.handleInbound(phone, 'Rain evaporates and falls again.'));

  const rows = db.prepare('SELECT answer_text FROM answers WHERE session_id = ?').all(sid);
  assert.equal(rows.length, 1, 'the answer is recorded');
  assert.equal(rows[0].answer_text, 'Rain evaporates and falls again.');
});

test('once an answer exists the paper is being answered, not greeted', async () => {
  // The guard covers the opening reply only: mid-paper a short word may be
  // what the student meant to write, and taking it from them would be worse
  // than being fooled by a greeting once.
  const { sid, phone, questions } = theoryPaper();
  db.prepare(
    `INSERT INTO answers (session_id,question_id,q_order,answer_text,max_marks,marked_by)
     VALUES (?,?,?,?,?,'pending')`
  ).run(sid, questions[0], 1, 'Rain evaporates and falls again.', 5);
  db.prepare('UPDATE sessions SET current_q_order = 2 WHERE id = ?').run(sid);

  await capturing(() => exam.handleInbound(phone, 'hi'));

  assert.equal(answerCount(sid), 2, 'the second reply is taken as an answer');
});
