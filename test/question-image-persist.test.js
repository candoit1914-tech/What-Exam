'use strict';
require('./helpers/isolate');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const db = require('../src/db');
const auth = require('../src/auth');
const ai = require('../src/services/ai');
const api = require('../src/routes/api');

// These exercise the real routes over HTTP. The plan's original test only
// proved the schema accepts an `image` column, which stays green whether or not
// the route ever binds it — the exact defect under test. Going through the
// router means a dropped column fails here.
let server;
let base;
let token;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      `${base}${path}`,
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

function newExam(title) {
  return db
    .prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES (?,'Math',30,'published')")
    .run(title).lastInsertRowid;
}

before(async () => {
  token = auth.adminToken();
  const app = express();
  app.use(express.json());
  app.use('/api', api);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); });

test('a batch-added question keeps the image it was created with', async () => {
  const eid = newExam('__batch_img__');
  const res = await request('POST', `/api/exams/${eid}/questions/batch`, {
    questions: [{
      type: 'objective',
      text: 'Which diagram is a circle?',
      options: ['A', 'B', 'C', 'D'],
      correct_answer: 'A',
      marks: 1,
      image: 'batch-diagram.png',
    }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = db.prepare('SELECT image FROM questions WHERE id = ?').get(res.body.questions[0]);
  assert.equal(row.image, 'batch-diagram.png', 'the image must survive the batch insert');
});

test('an AI-generated diagram survives the generate route', async () => {
  const eid = newExam('__gen_img__');
  const real = ai.generateQuestions;
  ai.generateQuestions = async () => ([
    {
      type: 'objective',
      text: 'Name this shape',
      options: ['Circle', 'Square'],
      correct_index: 0,
      marks: 1,
      image: 'generated-diagram.png',
    },
  ]);
  try {
    const res = await request('POST', `/api/exams/${eid}/generate`, {
      count: 1,
      types: ['objective'],
      objectiveCount: 1,
      theoryCount: 0,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = db.prepare('SELECT image FROM questions WHERE exam_id = ?').get(eid);
    assert.equal(row.image, 'generated-diagram.png', 'the generated diagram must be persisted');
  } finally {
    ai.generateQuestions = real;
  }
});

test('an AI-generated pool variant keeps its diagram', async () => {
  const eid = newExam('__pool_img__');
  const real = ai.generateQuestions;
  const withImage = (n, tag) => ({
    type: 'objective',
    text: `Pool question ${tag}`,
    options: ['A', 'B'],
    correct_index: 0,
    marks: 1,
    image: `pool-diagram-${tag}.png`,
    ...n,
  });
  // n=1 with poolMultiplier 2 means the second question overflows into the pool.
  ai.generateQuestions = async () => [withImage({}, 'a'), withImage({}, 'b')];
  try {
    const res = await request('POST', `/api/exams/${eid}/generate`, {
      count: 1,
      types: ['objective'],
      objectiveCount: 1,
      theoryCount: 0,
      pool: true,
      poolMultiplier: 2,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.poolCount, 1, 'one question overflowed into the pool');
    const row = db.prepare('SELECT image FROM question_pool WHERE exam_id = ?').get(eid);
    assert.equal(row.image, 'pool-diagram-b.png', 'the pool variant must keep its diagram');
  } finally {
    ai.generateQuestions = real;
  }
});

test('a question created without an image stores empty, matching the column default', async () => {
  const eid = newExam('__no_img__');
  const res = await request('POST', `/api/exams/${eid}/questions/batch`, {
    questions: [{ type: 'objective', text: 'Plain question', options: ['A', 'B'], correct_answer: 'A', marks: 1 }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = db.prepare('SELECT image FROM questions WHERE id = ?').get(res.body.questions[0]);
  // Every other writer (single create, topUpPool) stores '' when absent, and
  // ensureColumn defaults to ''. Pin it so writers cannot drift apart.
  assert.equal(row.image, '', 'no image field means no image');
});
