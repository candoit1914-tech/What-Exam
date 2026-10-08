'use strict';
require('./helpers/isolate');

// A question that is read against a figure is only answerable if the figure is
// there. This file pins the whole path: the extractor keeps EVERY figure the
// question names, the limbs hand theirs up, delivery puts them above the
// question text in reading order, the report prints them above the text too,
// and an admin who replaces or removes a figure takes the imported ones with
// it instead of leaving WhatsApp showing a diagram that no longer exists.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const db = require('../src/db');
const auth = require('../src/auth');
const ai = require('../src/services/ai');
const exam = require('../src/services/exam');
const wa = require('../src/services/whatsapp');
const results = require('../src/services/results');
const api = require('../src/routes/api');

let seq = 0;
const phone = () => `233fig${++seq}${String(Date.now()).slice(-6)}`;

/** Run `fn` with the bot's chat stubbed out, restoring whatever it replaced. */
async function withChat(fn) {
  const originalText = wa.sendText;
  const originalImage = wa.sendImage;
  // One ordered log: bubble order is the whole point, so text and image calls
  // have to be comparable against each other.
  const calls = [];
  wa.sendText = async (phone, text) => { calls.push({ type: 'text', phone, text }); };
  wa.sendImage = async (phone, file) => { calls.push({ type: 'image', phone, file }); };
  try {
    // Only the log is handed over: destructuring would evaluate a getter once,
    // at call time, before a single bubble has been sent.
    await fn(calls);
  } finally {
    wa.sendText = originalText;
    wa.sendImage = originalImage;
  }
}

// ── extraction ────────────────────────────────────────────────────────

test('a question that names two figures keeps both of them', async () => {
  const original = ai.chatJSON;
  ai.chatJSON = async () => ({
    questions: [
      { type: 'theory', number: 1, text: 'Study the map and the graph. [IMG:0] [IMG:1]' },
    ],
  });
  try {
    const qs = await ai.extractQuestionsFromText(
      '1. Study the map and the graph.\n[IMG:0]\n[IMG:1]\n',
      null, null,
      { markers: [{ idx: 0, page: 1 }, { idx: 1, page: 1 }] }
    );
    assert.equal(qs.length, 1);
    assert.deepEqual(qs[0].figureIndices, [0, 1], 'both figures belong to the question');
    assert.equal(qs[0].markerIndex, 0, 'the single field names the first, never overwrites it');
    assert.doesNotMatch(qs[0].text, /\[IMG:/, 'markers are stripped from what the student reads');
  } finally {
    ai.chatJSON = original;
  }
});

test('a limb hands its figures up to the question the parts are read from', () => {
  const out = ai.mergeSubQuestions([
    { type: 'theory', number: 1, text: 'Study the diagram and answer (a) and (b).' },
    { type: 'theory', number: 1, text: '(a) Name the process shown.', markerIndex: 2, figureIndices: [2] },
    { type: 'theory', number: 1, text: '(b) State one effect of it.', markerIndex: 5, figureIndices: [5] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].markerIndex, 2, 'the first figure still names the question');
  assert.deepEqual(out[0].figureIndices, [2, 5], 'and the second travels with it');
});

// ── delivery ──────────────────────────────────────────────────────────

test('every bubble a question carries is sent above its text, in reading order', async () => {
  const eid = db
    .prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('TwoFigures',30,'live')")
    .run().lastInsertRowid;
  const studentId = db.prepare('INSERT INTO students(phone) VALUES (?)').run(phone()).lastInsertRowid;
  const qid = db
    .prepare(
      `INSERT INTO questions(exam_id,q_order,type,text,marks,section_key)
       VALUES (?,1,'theory','Study the map and the graph.',5,'')`
    )
    .run(eid).lastInsertRowid;
  // Figures first, maths expressions behind them — one position sequence, the
  // order delivery walks.
  db.prepare("INSERT INTO question_images(question_id,position,image,kind) VALUES (?,?,?,'figure')").run(qid, 0, 'fig-map.png');
  db.prepare("INSERT INTO question_images(question_id,position,image,kind) VALUES (?,?,?,'figure')").run(qid, 1, 'fig-graph.png');
  db.prepare("INSERT INTO question_images(question_id,position,image,kind) VALUES (?,?,?,'math')").run(qid, 2, 'expr.png');

  const session = exam.createSession(eid, studentId);
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);

  await withChat(async (calls) => {
    await exam.sendQuestionTo(session, student);
    const images = calls.filter((c) => c.type === 'image');
    const texts = calls.filter((c) => c.type === 'text');
    assert.deepEqual(
      images.map((c) => path.basename(c.file)),
      ['fig-map.png', 'fig-graph.png', 'expr.png'],
      'all three bubbles go out, in position order'
    );
    const askAt = calls.findIndex((c) => c.type === 'text' && /Study the map and the graph\./.test(c.text));
    assert.ok(askAt >= 0, 'the question text went out');
    assert.ok(
      images.every((c) => calls.indexOf(c) < askAt),
      'every figure arrives above the question text'
    );
    assert.match(texts[texts.length - 1].text, /Study the map and the graph\./, 'and the question itself is last');
  });
});

test('a question with one figure still sends it, and only it', async () => {
  const eid = db
    .prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('OneFigure',30,'live')")
    .run().lastInsertRowid;
  const studentId = db.prepare('INSERT INTO students(phone) VALUES (?)').run(phone()).lastInsertRowid;
  db.prepare(
    `INSERT INTO questions(exam_id,q_order,type,text,marks,image,section_key)
     VALUES (?,1,'theory','What does the diagram show?',5,'only-fig.png','')`
  ).run(eid);

  const session = exam.createSession(eid, studentId);
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);

  await withChat(async (calls) => {
    await exam.sendQuestionTo(session, student);
    const images = calls.filter((c) => c.type === 'image');
    assert.equal(images.length, 1, 'the legacy single-image column still delivers');
    assert.match(images[0].file, /only-fig\.png$/);
  });
});

// ── report ────────────────────────────────────────────────────────────

test('the report prints every figure above the question it belongs to', () => {
  db.exec('BEGIN');
  try {
    const examId = db.prepare("INSERT INTO exams (title, duration_minutes) VALUES ('figreport', 1)").run().lastInsertRowid;
    db.prepare("INSERT INTO students (id, phone) VALUES (0, '+233000000001')").run();
    const sid = db
      .prepare("INSERT INTO sessions (exam_id, student_id, status) VALUES (?, 0, 'completed')")
      .run(examId).lastInsertRowid;
    const qid = db
      .prepare("INSERT INTO questions (exam_id, q_order, type, text, marks, image) VALUES (?,1,'theory','Study the figure.',5,'primary.png')")
      .run(examId).lastInsertRowid;
    db.prepare("INSERT INTO question_images (question_id, position, image, kind) VALUES (?,0,'primary.png','figure')").run(qid);
    db.prepare("INSERT INTO question_images (question_id, position, image, kind) VALUES (?,1,'second.png','figure')").run(qid);
    db.prepare(
      'INSERT INTO answers (session_id, question_id, q_order, answer_text, is_correct, marks_awarded, max_marks) VALUES (?,?,1,?,0,0,5)'
    ).run(sid, qid, 'a written answer');

    const html = results.reportHTML(sid).html;
    const textAt = html.indexOf('<p class="q-text">');
    const first = html.indexOf('file=primary.png');
    const second = html.indexOf('file=second.png');
    assert.ok(first >= 0, 'the primary figure is on the report');
    assert.ok(second >= 0, 'the second figure is on the report');
    assert.ok(first < textAt && second < textAt, 'both figures sit above the question text');
    assert.ok(first < second, 'and in the order the question carries them');
  } finally {
    db.exec('ROLLBACK');
  }
});

// ── admin surface ─────────────────────────────────────────────────────

let server;
let base;
let token;

async function bootApi() {
  if (server) return;
  token = auth.adminToken();
  const app = express();
  app.use(express.json());
  app.use('/api', api);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
}

function request(method, path_, body) {
  const payload = body == null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${path_}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('the exam payload hands the dashboard every figure a question carries', async () => {
  await bootApi();
  const eid = db
    .prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES ('figpayload','Math',30,'published')")
    .run().lastInsertRowid;
  const qid = db
    .prepare("INSERT INTO questions(exam_id,q_order,type,text,marks,image) VALUES (?,1,'theory','Study it.',5,'a.png')")
    .run(eid).lastInsertRowid;
  db.prepare("INSERT INTO question_images (question_id, position, image, kind) VALUES (?,0,'a.png','figure')").run(qid);
  db.prepare("INSERT INTO question_images (question_id, position, image, kind) VALUES (?,1,'b.png','figure')").run(qid);

  const res = await request('GET', `/api/exams/${eid}`);
  assert.equal(res.status, 200);
  const q = res.body.questions.find((row) => row.id === qid);
  assert.deepEqual(q.images, ['a.png', 'b.png'], 'in position order, ready to print above the text');
});

test('replacing or removing a figure takes the imported ones with it', async () => {
  await bootApi();
  const eid = db
    .prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES ('figreplace','Math',30,'published')")
    .run().lastInsertRowid;
  const qid = db
    .prepare("INSERT INTO questions(exam_id,q_order,type,text,marks,image) VALUES (?,1,'theory','Study it.',5,'old.png')")
    .run(eid).lastInsertRowid;
  db.prepare("INSERT INTO question_images (question_id, position, image, kind) VALUES (?,0,'old.png','figure')").run(qid);
  db.prepare("INSERT INTO question_images (question_id, position, image, kind) VALUES (?,1,'old2.png','figure')").run(qid);

  // WhatsApp sends the rows in preference to questions.image, so a row left
  // behind would keep showing a diagram the admin has just deleted.
  const removed = await request('PUT', `/api/exams/${eid}/questions/${qid}`, { remove_image: 1 });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const rows = db.prepare('SELECT image FROM question_images WHERE question_id = ?').all(qid);
  assert.deepEqual(rows, [], 'the stale bubbles are gone with the figure');
  assert.equal(db.prepare('SELECT image FROM questions WHERE id = ?').get(qid).image, '');
});

after(() => { try { server?.close(); } catch {} });
