'use strict';
// An INSTRUCTION is not a question. A paper prints directives — "Answer all
// questions in this section", "INSTRUCTIONS: ..." — and the extractor can hand
// one back as if it were a question. stripPaperFurniture reduces such a
// directive to an EMPTY string, so without a guard that entry would be saved as
// a question with no text and sent to the student as an empty bubble. Only real
// questions (with a surviving stem, or limbs when the stem reads like an
// instruction) reach the exam.
require('./helpers/isolate');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { execFileSync } = require('node:child_process');

const config = require('../src/config');
const ai = require('../src/services/ai');
const db = require('../src/db');
const pdfImport = require('../src/services/pdfImport');

const ROOT = path.join(__dirname, '..');

// A tiny real PDF so startJob has bytes to read. The extractor is stubbed
// below, so the content only has to exist.
function makePdf(lines) {
  const PDFDocument = require('pdfkit');
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

async function importWith(parsedQuestions) {
  const buffer = await makePdf(['ENGLISH PAPER 2', '1. Write a letter.']);
  const examId = db
    .prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES ('__instr__','English',60,'draft')")
    .run().lastInsertRowid;
  const jobId = pdfImport.createJob(examId, 'paper.pdf');

  const original = ai.extractQuestionsFromText;
  ai.extractQuestionsFromText = async () => parsedQuestions;
  try {
    await pdfImport.startJob(jobId, buffer, {});
  } finally {
    ai.extractQuestionsFromText = original;
  }
  const job = pdfImport.getJob(jobId);
  const saved = db
    .prepare('SELECT type, text, passage, source_number, follow_ups FROM questions WHERE exam_id = ? ORDER BY q_order')
    .all(examId);
  return { job, saved, examId };
}

test('an instruction parsed as a question is dropped, not saved empty', async () => {
  const { job, saved } = await importWith([
    // Pure directives — stripPaperFurniture empties each of these.
    { type: 'theory', text: 'Answer all questions in this section.', marks: 5 },
    { type: 'theory', text: 'INSTRUCTIONS: Answer all questions in Part 1.', marks: 5 },
    // The real questions that must survive.
    { type: 'theory', text: 'Write a letter to your father asking for an extension of time.', marks: 10 },
    { type: 'objective', text: 'What is the capital of Ghana?', options: ['A. Accra', 'B. Kumasi'], correct_answer: 'A' },
  ]);

  assert.equal(job.status, 'done', 'the real questions still import');
  assert.equal(saved.length, 2, 'only the two real questions are saved');
  const texts = saved.map((q) => q.text);
  assert.ok(
    texts.every((t) => t && t.trim()),
    'no saved question has empty text: ' + JSON.stringify(texts)
  );
  assert.ok(texts.some((t) => /capital of Ghana/.test(t)), 'the objective survived');
  assert.ok(texts.some((t) => /Write a letter/.test(t)), 'the theory survived');
  assert.ok(
    texts.every((t) => !/^answer all questions/i.test(t.trim())),
    'no instruction line was saved as a question'
  );
});

test('a real question whose stem merely reads like an instruction still imports', async () => {
  // A question ASKS something, so it survives even when its wording is
  // imperative: "Write a letter to your father…" is the paper's task, not the
  // paper addressing the candidate. What must NOT survive is a stem that
  // hands the reader to questions printed somewhere else.
  const { saved } = await importWith([
    { type: 'theory', text: 'Write a letter to your father asking for an extension of time.', marks: 5 },
  ]);
  assert.equal(saved.length, 1, 'the imperative stem is a real question here');
  assert.match(saved[0].text, /Write a letter/);
});

test('a directive that stands alone is dropped even when the furniture pass keeps it', async () => {
  // stripPaperFurniture only removes the NARROWEST directive forms ("Answer
  // all…", "INSTRUCTIONS:"). These are the rest of what a paper prints where a
  // question would be — none of them can be answered, so none may be saved.
  const { job, saved } = await importWith([
    { type: 'theory', text: 'Read the passage and answer the question that follows.', marks: 5 },
    { type: 'theory', text: 'Attempt THREE questions from this section.', marks: 5 },
    { type: 'theory', text: 'Each question carries 20 marks.', marks: 5 },
    { type: 'theory', text: 'SECTION B', marks: 5 },
    { type: 'theory', text: 'Write your answers in the answer booklet provided.', marks: 5 },
    { type: 'theory', text: 'Define osmosis.', marks: 5 },
    { type: 'objective', text: 'What is the capital of Ghana?', options: ['A. Accra', 'B. Kumasi'], correct_answer: 'A' },
  ]);

  assert.equal(job.status, 'done', 'the real questions still import');
  assert.deepEqual(
    saved.map((q) => q.text.trim()),
    ['Define osmosis.', 'What is the capital of Ghana?'],
    'only the two answerable questions were saved'
  );
});

test('a dropped instruction keeps the passage it introduced', async () => {
  // On a reading paper the instruction line and the passage arrive together,
  // and the numbered questions follow them. Dropping the instruction must not
  // drop the passage with it — the student would be asked a comprehension
  // question they were never shown.
  const { saved } = await importWith([
    {
      type: 'theory',
      text: 'Read the following passage and answer questions 1 to 5.',
      passage: 'Ama lost her pencil on the way to school.',
      marks: 5,
    },
    { type: 'theory', text: 'Where did Ama lose her pencil?', marks: 2 },
  ]);
  assert.equal(saved.length, 1, 'the instruction entry itself is not saved as a question');
  assert.match(saved[0].text, /Where did Ama lose her pencil/);
  assert.match(
    String(saved[0].passage || ''),
    /Ama lost her pencil/,
    'the passage travels to the next real question instead of dying with the instruction'
  );
});

test('an instruction-only import fails loudly instead of saving an empty paper', async () => {
  const { job, saved } = await importWith([
    { type: 'theory', text: 'Answer all questions in this section.', marks: 5 },
    { type: 'theory', text: 'INSTRUCTIONS: Answer all questions in Part 1.', marks: 5 },
  ]);
  assert.equal(job.status, 'error', 'nothing real was extracted, so the import must fail');
  assert.match(job.error, /instruction/i, 'the error says why there were no questions');
  assert.equal(saved.length, 0, 'no empty questions are left behind');
});

test('a question with limbs but an instruction-like stem is kept', async () => {
  // The stem empties, but the parts are the real content — a comprehension
  // question whose heading reads like a directive. The limbs keep it alive.
  const { saved } = await importWith([
    {
      type: 'theory',
      text: 'Answer all questions in this section.',
      marks: 5,
      follow_ups: [
        { text: 'According to the passage, what could be the effect?', marks: 2 },
        { text: 'How do the younger ones tease their elders?', marks: 2 },
      ],
    },
  ]);
  assert.equal(saved.length, 1, 'a question with real limbs is not dropped');
  const limbs = JSON.parse(saved[0].follow_ups || '[]');
  assert.equal(limbs.length, 2, 'the limbs survived');
});
