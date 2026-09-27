'use strict';
require('./helpers/isolate');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const db = require('../src/db');
const auth = require('../src/auth');
const api = require('../src/routes/api');

let server;
let base;
let token;

function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      `${base}${path}`,
      { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': payload.length } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function newExam() {
  return db
    .prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES ('__route__','Test',60,'published')")
    .run().lastInsertRowid;
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

test('the route reports honest counts for a tokenized multi-number paste', async () => {
  const examId = newExam();
  // Three spellings of one number plus one more, separated by a comma, a
  // semicolon and a space. The old route split only on newline/comma, so the
  // ";" and " " runs collapsed this into garbage tokens.
  const first = await post(`/api/exams/${examId}/recipients`, {
    phones: '0242004542, 233242004542;0244004542',
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.counts.added, 2, 'two distinct numbers were added');
  assert.equal(first.body.counts.merged, 1, 'the repeated spelling was merged');
  assert.deepEqual(first.body.invalid, []);
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM exam_recipients WHERE exam_id = ?').get(examId).c,
    2,
    'the duplicate spelling must not create a second recipient row',
  );
});

test('re-pasting the same numbers adds nothing and reports the merge', async () => {
  const examId = newExam();
  const payload = { phones: '0242004542, 233242004542;0244004542' };
  await post(`/api/exams/${examId}/recipients`, payload);
  const second = await post(`/api/exams/${examId}/recipients`, payload);
  assert.equal(second.body.counts.added, 0, 'a re-paste creates no new students');
  assert.equal(second.body.counts.merged, 3, 'all three lines were already known');
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM exam_recipients WHERE exam_id = ?').get(examId).c,
    2,
  );
});

test('a name conflict keeps the existing name and is reported, not silently applied', async () => {
  const examId = newExam();
  await post(`/api/exams/${examId}/recipients`, { students: [{ phone: '0246004542', name: 'Ama Serwaa' }] });
  const r = await post(`/api/exams/${examId}/recipients`, { students: [{ phone: '233246004542', name: 'Ama Serwea' }] });
  assert.equal(r.body.conflicts.length, 1);
  assert.equal(r.body.conflicts[0].existingName, 'Ama Serwaa');
  assert.equal(r.body.conflicts[0].incomingName, 'Ama Serwea');
  const student = db.prepare('SELECT name FROM students WHERE phone = ?').get('233246004542');
  assert.equal(student.name, 'Ama Serwaa', 'the original name must survive');
});

test('malformed input is reported with its original text instead of vanishing', async () => {
  const examId = newExam();
  const r = await post(`/api/exams/${examId}/recipients`, { phones: 'abc 123 0248004542' });
  assert.equal(r.body.counts.added, 1);
  assert.equal(r.body.invalid.length, 2, 'both malformed tokens are reported');
  assert.deepEqual(r.body.invalid.map((i) => i.input), ['abc', '123']);
});

test('added[] is a real student list, not one entry per pasted line', async () => {
  const examId = newExam();
  const r = await post(`/api/exams/${examId}/recipients`, { phones: '0250004542\n0250004542\n0252004542' });
  assert.equal(r.body.added.length, 2, 'three pasted lines produced two students');
  for (const a of r.body.added) {
    assert.ok(a.id && a.phone, 'each added entry carries the created student');
  }
});
