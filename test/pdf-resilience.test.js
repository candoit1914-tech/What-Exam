'use strict';
// ANY PDF must import. A page pdfjs cannot open, a diagram stream that refuses
// to be replayed, and a figure filter that throws are each a SKIP with a note
// the admin can read — never a dead import. Only a document with nothing
// readable at all fails, and then it fails in words that name the fix instead
// of pdfjs' raw exception vanishing into a toast.
require('./helpers/isolate');

const { test } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const ai = require('../src/services/ai');
const pdf = require('../src/services/pdf');
const pdfImport = require('../src/services/pdfImport');

// ── A fake pdfjs document ──────────────────────────────────────────────
// Pages fail the way real papers fail: the object itself is unreadable
// (getPage throws), or its content stream cannot be replayed
// (getOperatorList throws — the diagram half of the page only).

function goodPage(lines) {
  return {
    getViewport: () => ({ width: 612, height: 792 }),
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    getTextContent: async () => ({
      items: lines.map((line, i) => ({
        str: line,
        transform: [1, 0, 0, 1, 40, 750 - i * 14],
        width: 200,
        hasEOL: true,
      })),
    }),
  };
}

const PAGE_ONE = [
  '1. Explain the water cycle in your own words with two worked examples.',
  'Answer in not more than one page using complete sentences throughout.',
];
const PAGE_TWO = [
  '2. Describe the functions of the human heart and give one example.',
  'Use your own words and answer in not more than two pages of writing.',
];
const PAGE_THREE = [
  '3. State three reasons why examination malpractice should be punished.',
  'Support each reason with a suitable example from your own community.',
];

function newExam(title) {
  return db
    .prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES (?,'Biology',60,'draft')")
    .run(title).lastInsertRowid;
}

test('a page pdfjs cannot open is skipped — the rest of the paper imports', async () => {
  const doc = {
    numPages: 3,
    getPage: async (n) => {
      if (n === 2) throw new Error('XRef stream is broken');
      return goodPage(n === 1 ? PAGE_ONE : PAGE_THREE);
    },
  };
  const out = await pdf.analyzeDocumentWithDoc(doc, Buffer.from('unused'));

  assert.deepEqual(out.figureStats.failedPages, [2], 'the skipped page is reported');
  assert.equal(out.rowsByPage.length, 3, 'page numbering stays aligned across the gap');
  assert.deepEqual(out.rowsByPage[1], [], 'the failed page contributes no rows');
  const text = out.textLines.join('\n');
  assert.match(text, /water cycle/, 'page 1 still imports');
  assert.match(text, /examination malpractice/, 'page 3 still imports');
  assert.ok(!text.includes('XRef'), 'nothing of the broken page leaks into the text');
});

test('a diagram stream that will not read costs only the diagrams, never the page', async () => {
  const doc = {
    numPages: 2,
    getPage: async (n) => {
      const page = goodPage(n === 1 ? PAGE_ONE : PAGE_TWO);
      if (n === 1) {
        page.getOperatorList = async () => { throw new Error('unsupported filter / corrupt image data'); };
      }
      return page;
    },
  };
  const out = await pdf.analyzeDocumentWithDoc(doc, Buffer.from('unused'));

  assert.deepEqual(out.figureStats.failedPages, [], 'no page was skipped');
  assert.deepEqual(
    out.figureStats.figureScanFailedPages, [1],
    'the diagram failure is reported per page, apart from a skipped page'
  );
  const text = out.textLines.join('\n');
  assert.match(text, /water cycle/, 'the page keeps its own text');
  assert.match(text, /functions of the human heart/, 'the next page is untouched');
  assert.deepEqual(out.images, [], 'no half-read figures are invented');
});

test('a file that is not really a PDF fails with a message that names the fix', async () => {
  const examId = newExam('__unreadable__');
  const jobId = pdfImport.createJob(examId, 'broken.pdf');

  await pdfImport.startJob(jobId, Buffer.from('this is not a pdf'), {});

  const job = pdfImport.getJob(jobId);
  assert.equal(job.status, 'error', 'nothing readable means the import fails');
  assert.match(job.error, /could not be read/i, 'the message says what happened in words');
  assert.match(job.error, /password-protected|damaged/i, 'and names the likely causes');
  assert.match(job.error, /re-upload/i, 'and what to do about it');
});

test('page skips and diagram failures land in the job note the dashboard shows', async () => {
  const examId = newExam('__notes__');
  const jobId = pdfImport.createJob(examId, 'scan.pdf');

  const originalRead = pdf.textWithMarkers;
  const originalExtract = ai.extractQuestionsFromText;
  pdf.textWithMarkers = async () => ({
    text: '1. What is the capital of Ghana?',
    images: [],
    markers: [],
    mathExprs: [],
    rowsByPage: [],
    diagnostics: {
      figures: {
        pages: 3,
        failedPages: [2],
        figureScanFailedPages: [3],
        kept: 0,
        candidates: { raster: 0, vector: 0 },
        paths: { raster: 0, vector: 0 },
        dropped: {},
        keptByPage: [],
        rejections: [],
      },
    },
  });
  ai.extractQuestionsFromText = async () => ([
    {
      type: 'objective',
      number: 1,
      text: 'What is the capital of Ghana?',
      options: ['A. Accra', 'B. Kumasi'],
      correct_answer: 'A',
      marks: 1,
    },
  ]);
  try {
    await pdfImport.startJob(jobId, Buffer.from('unused'), {});
  } finally {
    pdf.textWithMarkers = originalRead;
    ai.extractQuestionsFromText = originalExtract;
  }

  const job = pdfImport.getJob(jobId);
  assert.equal(job.status, 'done', 'a skipped page never fails the import');
  assert.match(job.warning, /Page 2 could not be parsed and was skipped/, 'the admin reads which page is gone');
  assert.match(job.warning, /Diagram scanning failed on page 3/, 'and which page lost only its diagrams');
  const saved = db.prepare('SELECT text FROM questions WHERE exam_id = ?').all(examId);
  assert.equal(saved.length, 1, 'the question from the readable page was saved');
});
