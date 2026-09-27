'use strict';
require('./helpers/isolate');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PDFDocument = require('pdfkit');

const config = require('../src/config');
const ai = require('../src/services/ai');
const db = require('../src/db');
const pdfImport = require('../src/services/pdfImport');

const ROOT = path.join(__dirname, '..');

function makePdf(lines) {
  return new Promise((resolve) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.fontSize(11);
    for (const line of lines) doc.text(line);
    doc.end();
  });
}

// isolate() replaces global.fetch with a thrower. Point it back at a loopback
// stub provider (node:http, no extra deps) so the real network/timeout path runs.
function loopbackFetch() {
  global.fetch = (url, opts = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(url, { method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            headers: { get: (h) => res.headers[h.toLowerCase()] ?? null },
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
      });
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
}

// A short, realistic exam paper. Enough to produce several extraction blocks.
const PAPER = [
  'MATHEMATICS PAPER 1',
  'Answer all the questions.',
  ...Array.from({ length: 40 }, (_, i) => {
    const n = i + 1;
    return `Question ${n}\nCalculate the value of ${n} + ${n * 2}.\nA. ${n}\nB. ${n * 3}\nC. ${n * 4}\nD. ${n * 5}`;
  }),
].join('\n\n');

// Small enough to be a single extraction block, so provider call counts are
// attributable to one block.
const SMALL_PAPER = [
  'MATHEMATICS PAPER 1',
  'Answer all the questions.',
  'Question 1\nCalculate 1 + 1.\nA. 1\nB. 2\nC. 3\nD. 4',
  'Question 2\nCalculate 2 + 2.\nA. 2\nB. 3\nC. 4\nD. 5',
].join('\n\n');

let server;
let baseUrl;

before(async () => {
  // A provider that is always slower than the block budget: exactly the
  // condition measured in production (28s-89s against a 90s hard limit).
  server = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] }));
    }, 400);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});

after(() => server && server.close());

test('block timeout is configurable via AI_BLOCK_TIMEOUT_MS', () => {
  const out = execFileSync(process.execPath, ['-e', 'console.log(require("./src/config").ai.blockTimeoutMs)'], {
    cwd: ROOT,
    env: { ...process.env, AI_BLOCK_TIMEOUT_MS: '12345', DB_PATH: path.join(ROOT, 'data', 'unused.db') },
    encoding: 'utf8',
  });
  assert.equal(Number(out.trim()), 12345);
});

test('default block timeout leaves headroom above measured provider latency', () => {
  // Measured: the slowest single block took 88.7s. A 90s ceiling turned a slow
  // provider into silent question loss, so the default must clear it widely.
  assert.ok(
    config.ai.blockTimeoutMs >= 180000,
    `default block timeout ${config.ai.blockTimeoutMs}ms is too tight for a provider that needs ~89s`
  );
});

test('a block slower than the configured budget is reported, not silently dropped', async () => {
  config.ai.baseUrl = baseUrl;
  config.ai.apiKey = 'test-key';
  config.ai.blockTimeoutMs = 50; // far below the stub's 400ms

  // Point fetch at the slow stub server so the real timeout path (not a stub
  // error) is what fails.
  loopbackFetch();

  const warnings = [];
  const started = Date.now();
  const parsed = await ai.extractQuestionsFromText(PAPER, null, (w) => warnings.push(w));
  const elapsed = Date.now() - started;

  assert.deepEqual(parsed, [], 'nothing should be parsed when every block times out');
  assert.ok(
    warnings.some((w) => /could not be parsed/i.test(w)),
    `a fully timed-out extraction must warn the user, got warnings: ${JSON.stringify(warnings)}`
  );
  assert.ok(elapsed < 10000, `honouring the configured budget should fail fast, took ${elapsed}ms`);
});

test('a failing block is retried, but only a few times', async () => {
  // Regression guard: the extraction used to make up to 6 provider calls per
  // block (3 in the parallel wave, then 3 more serially). Multiplied by block
  // count, and with two providers racing, that is what caused 429 storms and
  // multi-minute imports. One block must now cost a small, bounded number.
  let hits = 0;
  const counter = http.createServer((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    // Always empty: treated as a failed block, so every pass retries.
    res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] }));
  });
  await new Promise((r) => counter.listen(0, '127.0.0.1', r));

  config.ai.baseUrl = `http://127.0.0.1:${counter.address().port}/v1`;
  config.ai.apiKey = 'test-key';
  config.ai.blockTimeoutMs = 5000;
  loopbackFetch();

  try {
    const parsed = await ai.extractQuestionsFromText(SMALL_PAPER, null, () => {});
    assert.deepEqual(parsed, []);
    assert.ok(hits >= 2, `a failed block should still be retried, got ${hits} call(s)`);
    assert.ok(
      hits <= 3,
      `a single failing block must not be retried into a request storm, got ${hits} provider calls`
    );
  } finally {
    counter.close();
  }
});

test('"no questions parsed" explains that blocks timed out', async () => {
  config.ai.baseUrl = baseUrl;
  config.ai.apiKey = 'test-key';
  config.ai.blockTimeoutMs = 50;

  const buffer = await makePdf(PAPER.split('\n\n'));
  const examId = db
    .prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES ('__timeout__','Math',60,'draft')")
    .run().lastInsertRowid;
  const jobId = pdfImport.createJob(examId, 'paper.pdf');

  const original = ai.extractQuestionsFromText;
  ai.extractQuestionsFromText = async (_text, _p, onWarning) => {
    onWarning && onWarning('2 question block(s) could not be parsed — some questions may be missing.');
    return [];
  };
  try {
    await pdfImport.startJob(jobId, buffer, {});
  } finally {
    ai.extractQuestionsFromText = original;
  }

  // startJob records the failure on the job row, which is exactly what the
  // dashboard shows. It must explain WHY, not just "no questions".
  const job = pdfImport.getJob(jobId);
  assert.equal(job.status, 'error');
  assert.match(job.error, /could not be parsed/i);
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(examId).c,
    0,
    'a failed import must not leave questions behind'
  );
});
