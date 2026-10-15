'use strict';
require('./helpers/isolate');

// A figure and its question are ONE delivery.
//
// Sending the question text first and the picture behind it hands the student a
// question they cannot answer — and a figure that lands minutes later is glued
// to whatever message happens to come next. This file pins the contract that
// stops both: the text is HELD while the picture is still owed, the pair goes
// out as [figure][question] when the gateway recovers, the hold is bounded
// (never a question that never arrives), and a picture that provably cannot
// arrive does not hold the question at all.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../src/config');
const db = require('../src/db');
const wa = require('../src/services/whatsapp');
const exam = require('../src/services/exam');

let seq = 0;
const phone = () => `233hold${++seq}${String(Date.now()).slice(-6)}`;

/** Run `fn` with the bot's chat stubbed out, restoring whatever it replaced. */
async function withChat(fn) {
  const originalText = wa.sendText;
  const originalImage = wa.sendImage;
  const calls = [];
  wa.sendText = async (p, text) => { calls.push({ type: 'text', text }); };
  wa.sendImage = async (p, file) => { calls.push({ type: 'image', file }); };
  try {
    await fn(calls);
  } finally {
    wa.sendText = originalText;
    wa.sendImage = originalImage;
  }
}

/** A live exam with `count` theory questions, a figure on the last one. */
function fixture(title, { figureOn = 1, count = 1 } = {}) {
  const eid = db
    .prepare("INSERT INTO exams(title,duration_minutes,status) VALUES (?,30,'live')")
    .run(title).lastInsertRowid;
  for (let i = 1; i <= count; i++) {
    const qid = db
      .prepare(
        `INSERT INTO questions(exam_id,q_order,type,text,marks,section_key)
         VALUES (?,?,'theory',?,5,'')`
      )
      .run(eid, i, `Study the diagram for question ${i}.`).lastInsertRowid;
    if (i === figureOn) {
      db.prepare("INSERT INTO question_images(question_id,position,image,kind) VALUES (?,0,?,'figure')")
        .run(qid, `hold-fig-${i}.png`);
    }
  }
  const studentId = db.prepare('INSERT INTO students(phone) VALUES (?)').run(phone()).lastInsertRowid;
  const session = exam.createSession(eid, studentId);
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
  return { eid, session, student };
}

const figureRow = (sid) =>
  db.prepare("SELECT * FROM message_outbox WHERE session_id = ? AND kind = 'figure'").get(sid);
const questionRows = (sid) =>
  db.prepare("SELECT * FROM message_outbox WHERE session_id = ? AND kind = 'question' ORDER BY id").all(sid);

test('a withheld question sends no question bubble at all, and the pair retry delivers figure then question', async () => {
  const { session, student } = fixture('HoldPair');
  const originalText = wa.sendText;
  const originalImage = wa.sendImage;
  const calls = [];
  try {
    wa.sendText = async (p, text) => { calls.push({ type: 'text', text }); };
    wa.sendImage = async () => { throw new Error('Media API refused the upload'); };
    assert.equal(await exam.sendQuestionTo(session, student), 'withheld');
  } finally {
    wa.sendText = originalText;
    wa.sendImage = originalImage;
  }

  assert.ok(
    !calls.some((c) => c.type === 'text' && /question 1/.test(c.text)),
    'nothing that is the question itself went out — the student was never asked a question they cannot see'
  );

  // The gateway recovers. The next message (or the timer) pays the pair.
  await withChat(async (retry) => {
    assert.equal(await exam.retryQuestionPair(session.id, 1), true, 'the pair is delivered');
    const imageAt = retry.findIndex((c) => c.type === 'image');
    const questionAt = retry.findIndex((c) => c.type === 'text' && /question 1/.test(c.text));
    assert.equal(imageAt, 0, 'the figure leads');
    assert.equal(questionAt, 1, 'its own question follows immediately, not a message later');
  });

  assert.equal(figureRow(session.id).state, 'sent', 'the figure debt is retired');
  const qRows = questionRows(session.id);
  assert.equal(qRows.length, 1, 'exactly one question record');
  assert.equal(qRows[0].state, 'sent', 'and it is retired with the figure, never replayed');
});

test('the hold is bounded: once the retry budget is spent the question goes out alone', async () => {
  const { session, student } = fixture('HoldBudget');
  const originalText = wa.sendText;
  const originalImage = wa.sendImage;
  const texts = [];
  try {
    wa.sendText = async (p, text) => { texts.push(text); };
    wa.sendImage = async () => { throw new Error('Media API refused the upload'); };

    assert.equal(await exam.sendQuestionTo(session, student), 'withheld', 'first attempt holds');
    assert.equal(await exam.retryQuestionPair(session.id, 1), false, 'still owed');
    assert.equal(
      await exam.retryQuestionPair(session.id, 1),
      true,
      'the attempt that exhausts the budget releases the question rather than withholding it forever'
    );
    assert.ok(
      texts.some((t) => /question 1/.test(t)),
      'the student finally gets the question — late, but never never'
    );
    assert.equal(figureRow(session.id).state, 'failed', 'and the figure is recorded as failed, not owed');
  } finally {
    wa.sendText = originalText;
    wa.sendImage = originalImage;
  }
});

test('a picture that cannot ever arrive does not hold the question', async () => {
  // A blank PNG is refused by the gateway BEFORE any network call, so the real
  // sendImage is used here: this is the one failure a retry cannot fix, and the
  // question must not wait a single attempt for it.
  const name = `blank-hold-${Date.now()}.png`;
  const file = path.join(config.uploadsDir, name);
  const sharp = require('sharp');
  fs.writeFileSync(file, await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer());

  const { session, student } = fixture('HoldBlank');
  db.prepare('UPDATE question_images SET image = ? WHERE question_id IN (SELECT id FROM questions WHERE exam_id = ?)')
    .run(name, session.exam_id);

  const calls = [];
  const originalText = wa.sendText;
  try {
    wa.sendText = async (p, text) => { calls.push({ type: 'text', text }); };
    assert.equal(await exam.sendQuestionTo(session, student), true, 'the question is released at once');
  } finally {
    wa.sendText = originalText;
  }

  assert.ok(calls.some((c) => /question 1/.test(c.text)), 'the question text went out on the first attempt');
  assert.equal(figureRow(session.id).state, 'failed', 'the blank figure is given up on immediately, not held for retries');
  try { fs.unlinkSync(file); } catch {}
});

test('a student who answers into a hold is advanced only when the pair actually lands', async () => {
  const { session, student } = fixture('HoldAdvance', { count: 2, figureOn: 2 });
  db.prepare("UPDATE sessions SET started_at = datetime('now') WHERE id = ?").run(session.id);

  const originalText = wa.sendText;
  const originalImage = wa.sendImage;
  const calls = [];
  try {
    wa.sendText = async (p, text) => { calls.push({ type: 'text', text }); };
    // Question 1 has no figure, so it delivers normally; question 2's figure
    // refuses, and the question behind it must not go out or advance.
    wa.sendImage = async () => { throw new Error('Media API refused the upload'); };
    await exam.handleInbound(student.phone, 'an answer to question 1');

    assert.equal(
      db.prepare('SELECT current_q_order FROM sessions WHERE id = ?').get(session.id).current_q_order,
      1,
      'the position has NOT moved — only a delivered send advances it, so the next answer still lands on question 1'
    );
    assert.ok(
      !calls.some((c) => /question 2/.test(c.text)),
      'and question 2 was not asked — the student would have answered a diagram they cannot see'
    );
  } finally {
    wa.sendText = originalText;
    wa.sendImage = originalImage;
  }

  await withChat(async (retry) => {
    assert.equal(await exam.retryQuestionPair(session.id, 2), true);
    const imageAt = retry.findIndex((c) => c.type === 'image');
    const questionAt = retry.findIndex((c) => c.type === 'text' && /question 2/.test(c.text));
    assert.ok(imageAt >= 0 && questionAt > imageAt, 'the held question arrives behind its figure, in that order');
  });
  assert.equal(
    db.prepare("SELECT state FROM message_outbox WHERE session_id = ? AND kind = 'figure' AND q_order = 2").get(session.id).state,
    'sent'
  );
  assert.equal(
    db.prepare('SELECT current_q_order FROM sessions WHERE id = ?').get(session.id).current_q_order,
    2,
    'and only now does the position follow it — the next answer is read against question 2'
  );
});

test('retryQuestionPair does not put a question in the chat twice when only its figure was owed', async () => {
  // The paid-paper start template carries question 1 as TEXT and records it as
  // delivered; its figure is owed because the 24-hour window was shut. Paying
  // that debt must send the picture only — the student already has the question.
  const { session, student } = fixture('HoldTemplate');
  const entry = db.prepare(
    `INSERT INTO message_outbox(session_id, question_id, q_order, kind, recipient, state)
     VALUES (?, (SELECT id FROM questions WHERE exam_id = ? AND q_order = 1), 1, 'question', ?, 'sent')`
  ).run(session.id, session.exam_id, student.phone);
  db.prepare(
    `INSERT INTO message_outbox(session_id, question_id, q_order, kind, recipient, state)
     VALUES (?, (SELECT id FROM questions WHERE exam_id = ? AND q_order = 1), 1, 'figure', ?, 'queued')`
  ).run(session.id, session.exam_id, student.phone);

  await withChat(async (calls) => {
    assert.equal(await exam.retryQuestionPair(session.id, 1), true);
    assert.deepEqual(
      calls.filter((c) => c.type === 'text' && /question 1/.test(c.text)).length,
      0,
      'the question text is not repeated — only its picture was owed'
    );
    assert.equal(calls.filter((c) => c.type === 'image').length, 1, 'the figure went out');
  });
  assert.equal(
    db.prepare('SELECT state FROM message_outbox WHERE id = ?').get(entry.lastInsertRowid).state,
    'sent'
  );
});

test('two deliveries of the same pair cannot overlap', async () => {
  // The retry timer and the student's next message can both reach a pending
  // pair. A second delivery while the first is in flight would put the figure
  // in the chat twice.
  const { session, student } = fixture('HoldRace');
  const originalText = wa.sendText;
  const originalImage = wa.sendImage;
  let inFlight = 0;
  let overlaps = 0;
  try {
    wa.sendText = async () => {};
    wa.sendImage = async () => {
      inFlight++;
      if (inFlight > 1) overlaps++;
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      throw new Error('Media API refused the upload');
    };
    await exam.sendQuestionTo(session, student);
    await Promise.all([
      exam.retryQuestionPair(session.id, 1),
      exam.retryQuestionPair(session.id, 1),
    ]);
  } finally {
    wa.sendText = originalText;
    wa.sendImage = originalImage;
  }
  assert.equal(overlaps, 0, 'only one delivery of a pair runs at a time');
});
