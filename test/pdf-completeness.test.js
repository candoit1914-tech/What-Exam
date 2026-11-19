'use strict';
require('./helpers/isolate');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const ai = require('../src/services/ai');
const pdfImport = require('../src/services/pdfImport');

test('an import with a detected missing question is rejected before any rows are saved', async () => {
  const examId = db.prepare("INSERT INTO exams (title, subject, duration_minutes) VALUES ('Incomplete paper', 'Math', 60)").run().lastInsertRowid;
  const jobId = pdfImport.createJob(examId, 'paper.txt');
  const realExtract = ai.extractQuestionsFromText;
  ai.extractQuestionsFromText = async () => [
    { type: 'theory', number: 1, text: 'What is one plus one?', marks: 1 },
    { type: 'theory', number: 2, text: 'What is two plus two?', marks: 1 },
  ];

  try {
    await pdfImport.startJob(jobId, Buffer.from('source is supplied below'), {
      source: {
        format: 'txt',
        text: '1. What is one plus one?\n2. What is two plus two?\n3. What is three plus three?',
      },
    });

    const job = pdfImport.getJob(jobId);
    assert.equal(job.status, 'error');
    assert.match(job.error, /Extracted 2 questions.*~3/);
    assert.match(job.error, /incomplete question set was not saved/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM questions WHERE exam_id=?').get(examId).n, 0);
  } finally {
    ai.extractQuestionsFromText = realExtract;
  }
});
