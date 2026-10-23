'use strict';
require('./helpers/isolate');

// AI generation runs as a BACKGROUND JOB: POST /api/exams/:id/generate
// answers 202 + jobId instantly and the work happens in the jobs table
// (the dashboard polls GET /api/jobs/:id, like a PDF import). That is what
// makes long generations possible on Render, whose proxy drops any request
// that outlives ~100 seconds. These tests pin the contract: the request
// never waits on the AI, 'done' means the paper is saved, failures are loud
// with nothing saved, one job per exam, and boot fails anything interrupted.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const db = require('../src/db');
const auth = require('../src/auth');
const ai = require('../src/services/ai');
const pdfImport = require('../src/services/pdfImport');
const api = require('../src/routes/api');
const { generateAndAwait, waitForJob } = require('./helpers/generate');

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

const objective = (i) => ({
  type: 'objective',
  text: `Job objective ${i} about the harmattan dust`,
  options: ['A', 'B', 'C', 'D'],
  correct_index: 0,
  marks: 1,
});
const theory = (i) => ({ type: 'theory', text: `Job theory ${i} about the harmattan dust`, marks: 5 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  token = auth.adminToken();
  const app = express();
  app.use(express.json());
  app.use('/api', api);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); });

test('the POST answers before generation finishes — the request never blocks on the AI', async () => {
  const eid = newExam('__job_async__');
  const real = ai.generateQuestions;
  ai.generateQuestions = async () => {
    await sleep(800); // a slow provider: the old synchronous route held the HTTP request for this long
    return [objective(9), theory(9)];
  };
  try {
    const t0 = Date.now();
    const res = await request('POST', `/api/exams/${eid}/generate`, {
      count: 2, types: ['objective', 'theory'], objectiveCount: 1, theoryCount: 1,
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.ok(res.body.jobId, 'a job to poll is returned');
    assert.ok(elapsed < 600, `the POST must return without waiting for the AI (took ${elapsed}ms)`);

    // Nobody held the connection: the job still completes in the background.
    const job = await waitForJob(request, res.body.jobId, { timeoutMs: 5000 });
    assert.equal(job.status, 'done', job.error || JSON.stringify(job));
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(eid).c,
      2,
      'the paper landed after the response was already sent'
    );
  } finally {
    ai.generateQuestions = real;
  }
});

test("a finished job's paper carries exact counts, schemes and job.count", async () => {
  const eid = newExam('__job_done__');
  const real = ai.generateQuestions;
  ai.generateQuestions = async () => [objective(1), objective(2), theory(1)];
  try {
    const { res, job } = await generateAndAwait(request, eid, {
      count: 3, types: ['objective', 'theory'], objectiveCount: 2, theoryCount: 1,
    });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(job.status, 'done', job.error || JSON.stringify(job));
    assert.equal(job.type, 'ai_generate');
    assert.equal(job.count, 3, 'job.count reports what was saved');
    assert.equal(job.progress, 100);

    const rows = db.prepare('SELECT type FROM questions WHERE exam_id = ?').all(eid);
    assert.equal(rows.filter((r) => r.type === 'objective').length, 2);
    assert.equal(rows.filter((r) => r.type === 'theory').length, 1);
    const schemes = db
      .prepare(
        `SELECT COUNT(*) c FROM marking_schemes ms
         JOIN questions q ON q.id = ms.question_id WHERE q.exam_id = ?`
      )
      .get(eid).c;
    assert.equal(schemes, 3, 'every generated question has a marking scheme');
  } finally {
    ai.generateQuestions = real;
  }
});

test('a provider failure fails the job loudly with nothing saved', async () => {
  const eid = newExam('__job_fail__');
  const real = ai.generateQuestions;
  ai.generateQuestions = async () => { throw new Error('out of credit'); };
  try {
    const { res, job } = await generateAndAwait(request, eid, {
      count: 2, types: ['objective'], objectiveCount: 2, theoryCount: 0,
    });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(job.status, 'error');
    assert.match(job.error, /AI generation failed: out of credit/);
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(eid).c,
      0,
      'a failed generation saves nothing'
    );
  } finally {
    ai.generateQuestions = real;
  }
});

test('an empty provider response fails the job with billing advice', async () => {
  const eid = newExam('__job_empty__');
  const real = ai.generateQuestions;
  ai.generateQuestions = async () => [];
  try {
    const { res, job } = await generateAndAwait(request, eid, {
      count: 2, types: ['objective'], objectiveCount: 2, theoryCount: 0,
    });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(job.status, 'error');
    assert.match(job.error, /out of quota/);
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(eid).c,
      0,
      'an empty generation saves nothing'
    );
  } finally {
    ai.generateQuestions = real;
  }
});

test('a second generate while one is running is refused (no duplicate work)', async () => {
  const eid = newExam('__job_409__');
  const real = ai.generateQuestions;
  ai.generateQuestions = async () => {
    await sleep(400);
    return [objective(1), objective(2)];
  };
  try {
    const first = await request('POST', `/api/exams/${eid}/generate`, {
      count: 2, types: ['objective'], objectiveCount: 2, theoryCount: 0,
    });
    assert.equal(first.status, 202, JSON.stringify(first.body));

    const second = await request('POST', `/api/exams/${eid}/generate`, {
      count: 2, types: ['objective'], objectiveCount: 2, theoryCount: 0,
    });
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.match(second.body.error, /already running/);

    const job = await waitForJob(request, first.body.jobId, { timeoutMs: 5000 });
    assert.equal(job.status, 'done', job.error || JSON.stringify(job));
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(eid).c,
      2,
      'only the accepted generation produced questions'
    );
  } finally {
    ai.generateQuestions = real;
  }
});

test('a running PDF import also blocks a generate — one job per exam', async () => {
  const eid = newExam('__job_pdf_block__');
  const jobId = pdfImport.createJob(eid, 'paper.pdf');
  try {
    const res = await request('POST', `/api/exams/${eid}/generate`, {
      count: 1, types: ['objective'], objectiveCount: 1, theoryCount: 0,
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(res.body.error, /PDF import/);
  } finally {
    pdfImport.deleteJob(jobId);
  }
});

test('boot fails an interrupted generation so the dashboard never polls forever', () => {
  const eid = newExam('__job_stale__');
  const stale = pdfImport.createJob(eid, '', 'ai_generate');
  pdfImport.updateJob(stale, { status: 'running', stage: 'Writing questions with AI…', progress: 30 });
  const finished = pdfImport.createJob(eid, '', 'ai_generate');
  pdfImport.updateJob(finished, { status: 'done', count: 5, progress: 100 });
  try {
    pdfImport.recoverStaleJobs();
    const staleRow = pdfImport.getJob(stale);
    assert.equal(staleRow.status, 'error');
    assert.match(staleRow.error, /generation was interrupted/);
    assert.equal(pdfImport.getJob(finished).status, 'done', 'a finished job is untouched');
  } finally {
    pdfImport.deleteJob(stale);
    pdfImport.deleteJob(finished);
  }
});
