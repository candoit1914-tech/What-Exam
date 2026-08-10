'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const marking = require('../src/services/marking');
const config = require('../src/config');

test('answers table has the answer_image column', () => {
  const cols = db.prepare("PRAGMA table_info('answers')").all().map((c) => c.name);
  assert.ok(cols.includes('answer_image'), `expected answer_image in columns: ${cols.join(', ')}`);
});

const wa = require('../src/services/whatsapp');

test('parseWebhook returns an image event from an image message', () => {
  const body = {
    entry: [{ changes: [{ value: {
      messages: [{
        from: '233201234567', id: 'wamid.image.1', timestamp: '1750000000', type: 'image',
        image: { id: 'MEDIA_ID_1', caption: 'my written answer' },
      }],
    } }] }],
  };
  const ev = wa.parseWebhook(body).find((e) => e.type === 'message');
  assert.ok(ev, 'image message yields a message event');
  assert.equal(ev.mediaType, 'image');
  assert.equal(ev.mediaId, 'MEDIA_ID_1');
  assert.equal(ev.body, 'my written answer');
});

test('parseWebhook image event without caption has an empty body', () => {
  const body = {
    entry: [{ changes: [{ value: {
      messages: [{ from: '233201234567', id: 'wamid.image.2', timestamp: '1750000000', type: 'image',
        image: { id: 'MEDIA_ID_2' } }],
    } }] }],
  };
  const ev = wa.parseWebhook(body)[0];
  assert.equal(ev.mediaType, 'image');
  assert.equal(ev.body, '');
});

test('downloadMedia resolves buffer and mimeType through the Graph media URL', async () => {
  // Stub global.fetch: first call returns the media meta (an expiring URL),
  // second returns the bytes.
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ url: 'https://media.example.com/abc.jpg', mime_type: 'image/jpeg' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(Buffer.from([1, 2, 3, 4]), { status: 200 });
  };
  try {
    const out = await wa.downloadMedia('MEDIA_ID_1');
    assert.deepEqual([...out.buffer], [1, 2, 3, 4]);
    assert.equal(out.mimeType, 'image/jpeg');
    assert.match(calls[0].url, /\/MEDIA_ID_1$/);
    assert.ok(/Bearer /.test(calls[0].opts.headers.Authorization), 'token attached to the media request');
  } finally {
    global.fetch = original;
  }
});

test('markTheoryImageAnswer flags for manual review when vision is off', async () => {
  const wasVision = config.ai.vision;
  config.ai.vision = false;
  try {
    const out = await marking.markTheoryImageAnswer(
      { id: 1, text: 'Draw the water cycle.', marks: 4, passage: '' },
      '(photo answer)', 'nonexistent.png', { model_answer: '', key_points: [], rubric: [], presentation_marks: 0, grammar_marks: 0 }
    );
    assert.equal(out.needsReview, true);
    assert.equal(out.marksAwarded, 0);
  } finally {
    config.ai.vision = wasVision;
  }
});

test('markTheoryImageAnswer flags for manual review when the AI call fails', async () => {
  const wasVision = config.ai.vision;
  const wasRead = require('fs').readFileSync;
  config.ai.vision = true;
  require('fs').readFileSync = () => 'fake-base64';
  const ai = require('../src/services/ai');
  const orig = ai.markImageTheory;
  ai.markImageTheory = async () => { throw new Error('vision endpoint exploded'); };
  try {
    const out = await marking.markTheoryImageAnswer(
      { id: 1, text: 'Draw the water cycle.', marks: 4, passage: '' },
      '(photo answer)', 'f.png', {}
    );
    assert.equal(out.needsReview, true, 'AI failure falls back to manual review');
  } finally {
    config.ai.vision = wasVision;
    require('fs').readFileSync = wasRead;
    ai.markImageTheory = orig;
  }
});

const exam = require('../src/services/exam');

// Real 2x2 PNG so downloadMedia stubs survive @napi-rs/canvas loadImage
// (a hand-crafted 4-byte buffer would take the "cannot receive" error path).
const { createCanvas } = require('@napi-rs/canvas');
const photoCanvas = createCanvas(2, 2);
const photoCtx = photoCanvas.getContext('2d');
photoCtx.fillStyle = '#3366ff';
photoCtx.fillRect(0, 0, 2, 2);
const PHOTO_PNG = photoCanvas.toBuffer('image/png');

function waStub(overrides = {}) {
  const orig = {};
  const target = require('../src/services/whatsapp');
  for (const key of ['downloadMedia', 'sendText', 'sendImage', 'sendResultMessage']) {
    orig[key] = target[key];
    if (overrides[key]) target[key] = overrides[key];
  }
  const markingKey = 'markTheoryAnswer';
  orig[markingKey] = marking[markingKey];
  marking[markingKey] = async () => ({ marksAwarded: 0, maxMarks: 1, breakdown: [], feedback: 'stub', aiGenerated: false });
  return () => {
    for (const key of Object.keys(orig)) {
      if (key === 'markTheoryAnswer') marking[key] = orig[key];
      else target[key] = orig[key];
    }
  };
}

test('photo answer is recorded with answer_image and advances the session', async () => {
  db.exec('BEGIN');
  const restore = waStub({
    downloadMedia: async () => ({ buffer: PHOTO_PNG, mimeType: 'image/png' }),
    sendText: async () => {},
    sendImage: async () => {},
    sendResultMessage: async () => {},
  });
  require('../src/config').exam.sendCertificates = false;
  try {
    const examId = db.prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES (?,?,?,'live')")
      .run('__photo_exam__', 'Test', 30).lastInsertRowid;
    const studentId = db.prepare("INSERT INTO students (phone) VALUES (?)")
      .run('__photo_phone__' + Date.now()).lastInsertRowid;
    db.prepare("INSERT INTO questions (exam_id, q_order, type, text, marks) VALUES (?,1,'theory','Draw and label the water cycle.',4)")
      .run(examId);
    const sessionId = db.prepare(
      "INSERT INTO sessions (exam_id, student_id, status, current_q_order, started_at) VALUES (?,?,'in_progress',1,datetime('now'))"
    ).run(examId, studentId).lastInsertRowid;

    await exam.handleInbound(db.prepare('SELECT phone FROM students WHERE id = ?').get(studentId).phone, '', { mediaType: 'image', mediaId: 'M1' });

    const row = db.prepare('SELECT * FROM answers WHERE session_id = ? AND q_order = 1').get(sessionId);
    assert.ok(row, 'answer row created');
    assert.equal(row.answer_text, '(photo answer)');
    assert.match(row.answer_image, /^[\w-]+\.png$/, 'stored filename fits the attachment route regex');
  } finally {
    restore();
    db.exec('ROLLBACK');
  }
});

test('photo answer on an objective question is refused', async () => {
  db.exec('BEGIN');
  const sent = [];
  const restore = waStub({ sendText: async (phone, text) => { sent.push(text); } });
  try {
    const examId = db.prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES (?,?,?,'live')")
      .run('__photo_obj_exam__', 'Test', 30).lastInsertRowid;
    const studentId = db.prepare("INSERT INTO students (phone) VALUES (?)")
      .run('__photo_obj_phone__' + Date.now()).lastInsertRowid;
    db.prepare("INSERT INTO questions (exam_id, q_order, type, text, options, marks) VALUES (?,1,'objective','Pick A.',?,1)")
      .run(examId, JSON.stringify([{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }]));
    const sessionId = db.prepare(
      "INSERT INTO sessions (exam_id, student_id, status, current_q_order, started_at) VALUES (?,?,'in_progress',1,datetime('now'))"
    ).run(examId, studentId).lastInsertRowid;

    await exam.handleInbound(db.prepare('SELECT phone FROM students WHERE id = ?').get(studentId).phone, '', { mediaType: 'image', mediaId: 'M2' });

    assert.equal(sent.length, 1, 'one warning message');
    assert.match(sent[0], /letter/i);
    const row = db.prepare('SELECT * FROM answers WHERE session_id = ? AND q_order = 1').get(sessionId);
    assert.equal(row, undefined, 'no answer recorded for the objective question');
  } finally {
    restore();
    db.exec('ROLLBACK');
  }
});

test('markAllPendingTheory grades a photo answer via vision when available', async () => {
  db.exec('BEGIN');
  const wasVision = config.ai.vision;
  config.ai.vision = true;
  const orig = marking.markTheoryImageAnswer;
  const calls = [];
  marking.markTheoryImageAnswer = async (q, a, f, s) => {
    calls.push({ a, f });
    return { marksAwarded: 3, maxMarks: 4, needsReview: false, feedback: 'good drawing', aiGenerated: false };
  };
  try {
    const examId = db.prepare("INSERT INTO exams (title, subject, duration_minutes) VALUES (?,?,?)")
      .run('__photo_grade_exam__', 'Test', 30).lastInsertRowid;
    const studentId = db.prepare("INSERT INTO students (phone) VALUES (?)")
      .run('__photo_grade_phone__' + Date.now()).lastInsertRowid;
    const questionId = db.prepare("INSERT INTO questions (exam_id, q_order, type, text, marks) VALUES (?,1,'theory','Draw the water cycle.',4)")
      .run(examId).lastInsertRowid;
    const sessionId = db.prepare(
      "INSERT INTO sessions (exam_id, student_id, status, current_q_order, started_at) VALUES (?,?,'in_progress',1,datetime('now'))"
    ).run(examId, studentId).lastInsertRowid;
    db.prepare(
      `INSERT INTO answers (session_id, question_id, q_order, answer_text, answer_image, is_correct, marks_awarded, max_marks, marked_by, ai_feedback, needs_review)
       VALUES (?,?,1,'(photo answer)','s-1-1.png',NULL,0,4,'pending','',0)`
    ).run(sessionId, questionId);

    await exam.markAllPendingTheory(sessionId);

    const row = db.prepare('SELECT * FROM answers WHERE session_id = ? AND q_order = 1').get(sessionId);
    assert.equal(row.marks_awarded, 3);
    assert.equal(row.needs_review, 0);
    assert.equal(row.marked_by, 'ai');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].f, 's-1-1.png', 'image file passed to the vision marker');
  } finally {
    marking.markTheoryImageAnswer = orig;
    config.ai.vision = wasVision;
    db.exec('ROLLBACK');
  }
});

test('markAllPendingTheory flags a photo answer for manual review without vision', async () => {
  db.exec('BEGIN');
  const wasVision = config.ai.vision;
  config.ai.vision = false;
  try {
    const examId = db.prepare("INSERT INTO exams (title, subject, duration_minutes) VALUES (?,?,?)")
      .run('__photo_review_exam__', 'Test', 30).lastInsertRowid;
    const studentId = db.prepare("INSERT INTO students (phone) VALUES (?)")
      .run('__photo_review_phone__' + Date.now()).lastInsertRowid;
    const questionId = db.prepare("INSERT INTO questions (exam_id, q_order, type, text, marks) VALUES (?,1,'theory','Draw the water cycle.',4)")
      .run(examId).lastInsertRowid;
    const sessionId = db.prepare(
      "INSERT INTO sessions (exam_id, student_id, status, current_q_order, started_at) VALUES (?,?,'in_progress',1,datetime('now'))"
    ).run(examId, studentId).lastInsertRowid;
    db.prepare(
      `INSERT INTO answers (session_id, question_id, q_order, answer_text, answer_image, is_correct, marks_awarded, max_marks, marked_by, ai_feedback, needs_review)
       VALUES (?,?,1,'(photo answer)','s-1-1.png',NULL,0,4,'pending','',0)`
    ).run(sessionId, questionId);

    await exam.markAllPendingTheory(sessionId);

    const row = db.prepare('SELECT * FROM answers WHERE session_id = ? AND q_order = 1').get(sessionId);
    assert.equal(row.needs_review, 1, 'flagged for manual review');
    assert.equal(row.marked_by, 'pending');
    assert.match(row.ai_feedback, /awaiting manual review/i);
  } finally {
    config.ai.vision = wasVision;
    db.exec('ROLLBACK');
  }
});
