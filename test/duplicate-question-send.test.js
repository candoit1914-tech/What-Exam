'use strict';
require('./helpers/isolate');

// The same question twice in a row.
//
// A WhatsApp webhook can arrive faster than a delivery completes: the student's
// reply, a second copy of that reply, and the pair-retry timer all read "this
// question has not gone out yet" at the same moment — and each one sent it.
// This file pins the other side of that race: however many callers ask for one
// question at the same instant, the chat gets that question once.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const db = require('../src/db');
const exam = require('../src/services/exam');
const wa = require('../src/services/whatsapp');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let seq = 0;
const phone = () => `233dup${++seq}${String(Date.now()).slice(-5)}`;

/**
 * A live objective paper, seated and already inside question 1: the invite is
 * sent, the clock is running and question 1 is recorded as delivered. Every
 * race below starts from the ordinary middle of a paper, not from its door.
 */
function seatedExam(title, { count = 3, figureOn = null } = {}) {
  const eid = db
    .prepare("INSERT INTO exams(title,duration_minutes,status) VALUES (?,30,'live')")
    .run(title).lastInsertRowid;
  const options = JSON.stringify([{ key: 'A', text: 'Yes' }, { key: 'B', text: 'No' }]);
  for (let i = 1; i <= count; i++) {
    const qid = db
      .prepare(
        `INSERT INTO questions(exam_id,q_order,type,text,options,correct_answer,marks)
         VALUES (?,?,'objective',?,?,?,5)`
      )
      .run(eid, i, `Objective question ${i}?`, options, 'A').lastInsertRowid;
    if (i === figureOn) {
      db.prepare("INSERT INTO question_images(question_id,position,image,kind) VALUES (?,0,?,'figure')")
        .run(qid, `dup-fig-${i}.png`);
    }
  }
  const sid = db.prepare('INSERT INTO students(phone) VALUES (?)').run(phone()).lastInsertRowid;
  db.prepare('INSERT INTO exam_recipients(exam_id,student_id) VALUES (?,?)').run(eid, sid);
  const session = exam.createSession(eid, sid);
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(sid);
  db.prepare(
    `INSERT INTO message_outbox(session_id, question_id, q_order, kind, recipient, state)
     VALUES (?, 0, NULL, 'intro', ?, 'sent')`
  ).run(session.id, student.phone);
  db.prepare(
    `INSERT INTO message_outbox(session_id, question_id, q_order, kind, recipient, state)
     VALUES (?, (SELECT id FROM questions WHERE exam_id = ? AND q_order = 1), 1, 'question', ?, 'sent')`
  ).run(session.id, eid, student.phone);
  db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?').run(
    new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    session.id
  );
  return { eid, session: db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id), student };
}

/** Send stubs that take their time, so the race window the test needs is real. */
function slowChat(calls, ms) {
  const originalText = wa.sendText;
  const originalImage = wa.sendImage;
  wa.sendText = async (p, text) => { calls.push(String(text)); await sleep(ms); };
  wa.sendImage = async (p, file) => { calls.push(`image:${path.basename(String(file))}`); await sleep(ms); };
  return () => { wa.sendText = originalText; wa.sendImage = originalImage; };
}

test('two inbound messages that race each other ask question 2 once', async () => {
  // The student's reply and a duplicate of it (a webhook retry, a double tap)
  // land before the first delivery has finished. The second message used to
  // find question 2 still "queued", advance to it, and send it a second time —
  // two QUESTION 2 bubbles stacked in the chat.
  const { student } = seatedExam('DupInbound');
  const calls = [];
  const restore = slowChat(calls, 25);
  try {
    await Promise.all([
      exam.handleInbound(student.phone, 'A'),
      exam.handleInbound(student.phone, 'A'),
    ]);
  } finally {
    restore();
  }
  assert.equal(
    calls.filter((t) => /QUESTION 2/.test(t)).length,
    1,
    'question 2 is delivered exactly once, however many replies arrive while it is going out'
  );
});

test('a pair retry racing the delivery of the same question sends its text once', async () => {
  // Question 2 owes a figure. The retry timer (or the student's next message,
  // which runs the same delivery) can reach it while sendQuestionTo is already
  // mid-send: both used to send the question body, because only the retry path
  // knew to look for a delivery already in flight.
  const { session, student } = seatedExam('DupPair', { count: 2, figureOn: 2 });
  const calls = [];
  const restore = slowChat(calls, 20);
  try {
    await Promise.all([
      exam.sendQuestionTo(session, student, 2),
      exam.retryQuestionPair(session.id, 2),
    ]);
  } finally {
    restore();
  }
  assert.equal(
    calls.filter((t) => /QUESTION 2/.test(t)).length,
    1,
    'the question text goes out once even when the pair retry overlaps its delivery'
  );
  assert.equal(
    calls.filter((t) => t.startsWith('image:')).length,
    1,
    'and its figure goes out once with it'
  );
});
