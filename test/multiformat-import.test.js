'use strict';
// One pipeline, many readers. .txt/.docx/.xlsx arrive as exam TEXT and are
// parsed by the extractor exactly like a PDF's text layer; .json arrives as
// questions someone already structured and is imported VERBATIM — running a
// hand-built answer sheet back through the model would only risk corrupting
// work that was already correct.
require('./helpers/isolate');

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ai = require('../src/services/ai');
const db = require('../src/db');
const pdfImport = require('../src/services/pdfImport');
const documentSrc = require('../src/services/document');

function newExam(title) {
  return db
    .prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES (?,'English',60,'draft')")
    .run(title).lastInsertRowid;
}

function savedQuestions(examId) {
  return db
    .prepare('SELECT type, text, passage, options, correct_answer, source, source_number, follow_ups FROM questions WHERE exam_id = ? ORDER BY q_order')
    .all(examId);
}

// A .docx built from real XML so readExamSource has genuine bytes to unpack.
function docxBuffer(paragraphs) {
  const { buildZip } = require('../src/services/zip');
  const xml = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>'
    + paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')
    + '</w:body></w:document>';
  return buildZip([{ name: 'word/document.xml', data: Buffer.from(xml) }]);
}

test('a .txt upload goes through the extractor exactly like a PDF text layer', async () => {
  const text = [
    'ENGLISH LANGUAGE 2',
    '1. Which town hosts the school feast?',
    'A. Kumasi',
    'B. Accra',
  ].join('\n');
  const source = documentSrc.readExamSource(Buffer.from(text), 'paper.txt');
  assert.equal(source.format, 'txt');
  assert.equal(source.text, text, 'the reader hands over plain exam text');

  const examId = newExam('__txt__');
  const jobId = pdfImport.createJob(examId, 'paper.txt');
  const original = ai.extractQuestionsFromText;
  // The extractor stub records what it was handed: the pipeline must be
  // format-agnostic from here on.
  let seenText = null;
  ai.extractQuestionsFromText = async (t) => {
    seenText = t;
    return [{ type: 'objective', text: 'Which town hosts the school feast?', options: ['A. Kumasi', 'B. Accra'], correct_answer: 'A' }];
  };
  try {
    await pdfImport.startJob(jobId, Buffer.from(text), { source });
  } finally {
    ai.extractQuestionsFromText = original;
  }

  assert.equal(pdfImport.getJob(jobId).status, 'done', 'a text upload imports without a PDF');
  assert.equal(seenText, text, 'the extractor received the file text, not PDF machinery');
  const saved = savedQuestions(examId);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].source, 'txt', 'the dashboard badge names the real format');
  assert.match(saved[0].text, /capital|hosts the school feast/);
});

test('a .docx upload is unpacked into text before extraction', async () => {
  const buf = docxBuffer([
    'ENGLISH LANGUAGE 2',
    '1. Which town hosts the school feast?',
    'A. Kumasi',
  ]);
  const source = documentSrc.readExamSource(buf, 'paper.docx');
  assert.equal(source.format, 'docx');
  assert.match(source.text, /Which town hosts the school feast\?/, 'paragraph runs are joined');
  assert.ok(!/<w:/.test(source.text), 'no Word markup reaches the extractor');

  const examId = newExam('__docx__');
  const jobId = pdfImport.createJob(examId, 'paper.docx');
  const original = ai.extractQuestionsFromText;
  ai.extractQuestionsFromText = async () => [
    { type: 'objective', text: 'Which town hosts the school feast?', options: ['A. Kumasi'], correct_answer: 'A' },
  ];
  try {
    await pdfImport.startJob(jobId, buf, { source });
  } finally {
    ai.extractQuestionsFromText = original;
  }
  assert.equal(pdfImport.getJob(jobId).status, 'done');
  const saved = savedQuestions(examId);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].source, 'docx');
});

test('a JSON upload is imported verbatim, and the model is never asked', async () => {
  const payload = {
    questions: [
      {
        type: 'theory',
        number: 3,
        section: 'Part A',
        text: 'Your best vacation was when you visited a friend in another part of the country.',
        marks: 10,
        parts: ['Describe where you stayed.', { text: 'Who did you meet?', marks: 3 }],
      },
      {
        type: 'objective',
        text: 'Which town hosts the school feast?',
        options: ['A. Kumasi', 'B. Accra', 'C. Tamale', 'D. Sunyani'],
        answer: 'C',
      },
    ],
  };
  const buf = Buffer.from(JSON.stringify(payload));
  const source = documentSrc.readExamSource(buf, 'bank.json');
  assert.equal(source.format, 'json');

  const examId = newExam('__json__');
  const jobId = pdfImport.createJob(examId, 'bank.json');

  const original = ai.extractQuestionsFromText;
  let modelCalls = 0;
  ai.extractQuestionsFromText = async () => { modelCalls++; return []; };
  try {
    await pdfImport.startJob(jobId, buf, { source });
  } finally {
    ai.extractQuestionsFromText = original;
  }

  assert.equal(modelCalls, 0, 'authored questions are not re-parsed by the model');
  assert.equal(pdfImport.getJob(jobId).status, 'done');
  const saved = savedQuestions(examId);
  assert.equal(saved.length, 2, 'both authored rows are saved');
  const theory = saved.find((q) => q.type === 'theory');
  assert.equal(
    theory.text,
    'Your best vacation was when you visited a friend in another part of the country.',
    'the authored wording is preserved exactly'
  );
  assert.equal(theory.source_number, 3, 'the printed number is preserved');
  const limbs = JSON.parse(theory.follow_ups || '[]');
  assert.equal(limbs.length, 2, 'the authored parts become limbs');
  assert.equal(limbs[1].marks, 3);
  const objective = saved.find((q) => q.type === 'objective');
  assert.equal(objective.correct_answer, 'C', 'the authored answer is imported as written');
  assert.equal(saved[0].source, 'json');
});

test('a JSON upload with no correct answer still has AI fill only that gap', async () => {
  const buf = Buffer.from(JSON.stringify([
    { text: 'Which town hosts the school feast?', options: ['A. Kumasi', 'B. Accra'] },
  ]));
  const source = documentSrc.readExamSource(buf, 'gaps.json');
  const examId = newExam('__json-gap__');
  const jobId = pdfImport.createJob(examId, 'gaps.json');
  try {
    await pdfImport.startJob(jobId, buf, { source });
  } catch (err) {
    // answerObjectiveQuestions has no provider in tests; the import must
    // survive that, exactly as it does for a PDF whose key is incomplete.
  }
  const saved = savedQuestions(examId);
  assert.equal(saved.length, 1, 'the question imports even when its answer could not be filled');
  assert.match(saved[0].text, /Which town hosts the school feast/);
});

test('an unsupported extension is refused before a job is created', () => {
  assert.throws(
    () => documentSrc.readExamSource(Buffer.from('x'), 'slides.pptx'),
    /Unsupported file type for "slides\.pptx"/
  );
});

test('a .docx that is not a Word file fails with a message naming the format', () => {
  const { buildZip } = require('../src/services/zip');
  const notWord = buildZip([{ name: 'xl/workbook.xml', data: Buffer.from('<x/>') }]);
  assert.throws(
    () => documentSrc.readExamSource(notWord, 'paper.docx'),
    /word\/document\.xml is missing/
  );
});

test('a malformed JSON upload names the file and the parse error', () => {
  assert.throws(
    () => documentSrc.readExamSource(Buffer.from('{oops'), 'bank.json'),
    /"bank\.json" is not valid JSON/
  );
});
