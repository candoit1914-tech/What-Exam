'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ai = require('../src/services/ai');
const marking = require('../src/services/marking');
const pdfImport = require('../src/services/pdfImport');
const exam = require('../src/services/exam');
const { stripSourceWatermarks } = require('../src/services/textClean');

// ── Bug 2 regression: reading passages must stay with the questions they belong to ──

function comprehensionPaper() {
  const passage1 = [
    'Read the following passage carefully and answer questions 1 to 5.',
    'The farmers of the valley rely on irrigation channels that carry water from the mountain.',
    'Every dry season the council dredges the channels so the fields stay productive.',
  ].join('\n');
  const passage2 = [
    'Read the following passage and answer questions 6 to 10.',
    'Port Klondike grew around a single deep-water jetty built in 1923.',
    'By 1950 the harbour handled more tonnage than any other port on the coast.',
  ].join('\n');
  const opts = ['A. Option one', 'B. Option two', 'C. Option three', 'D. Option four'];
  const qs = [];
  for (let i = 1; i <= 10; i++) {
    qs.push(`${i}. Question number ${i}?`);
    qs.push(...opts);
  }
  return `${passage1}\n\n${qs.slice(0, 25).join('\n')}\n\n${passage2}\n\n${qs.slice(25).join('\n')}`;
}

test('splitIntoBlocks keeps each passage with the questions that follow it', () => {
  const blocks = ai.splitIntoBlocks(comprehensionPaper(), 5);

  assert.equal(blocks.length, 2, 'paper with two passages splits into two blocks');
  assert.match(blocks[0], /irrigation channels/, 'block 0 carries passage 1');
  assert.match(blocks[0], /Question number 1/, 'block 0 starts with Q1');
  assert.match(blocks[0], /Question number 5/, 'block 0 ends with Q5');
  assert.match(blocks[0], /D\. Option four/, 'Q5 keeps its own options in block 0');
  assert.doesNotMatch(blocks[0], /Port Klondike/, 'passage 2 is NOT glued onto block 0');

  assert.match(blocks[1], /^\s*Read the following passage/, 'block 1 starts with the carried passage, not orphaned options');
  assert.match(blocks[1], /Port Klondike/, 'block 1 carries passage 2 as leading context');
  assert.doesNotMatch(blocks[1], /Question number 5/, 'block 1 does not repeat Q5');
  assert.match(blocks[1], /Question number 10/, 'block 1 ends with Q10');
});

test('trailingContext finds the non-question lines after the last question', () => {
  const lines = '1. A question?\nA. X\nB. Y\n\nExtra note.'.split(/\r?\n/);
  const trail = ai.trailingContext(lines);
  assert.deepEqual(trail, ['', 'Extra note.']);
});

test('splitIntoBlocks breaks at section instructions so they lead the next block', () => {
  const paper = [
    '1. One plus one?',
    'A. 1 B. 2 C. 3 D. 4',
    '2. Two plus two?',
    'A. 2 B. 3 C. 4 D. 5',
    'Section B: Essay Writing',
    'Answer ONE question in this section. Your answer should be between 250 and 300 words.',
    '3. Write an essay on discipline.',
    '4. Write a story ending with "the end".',
  ].join('\n');
  const blocks = ai.splitIntoBlocks(paper);

  assert.equal(blocks.length, 2, 'a new section starts a new block');
  assert.doesNotMatch(blocks[0], /Section B/, 'the previous block is not polluted by the new section');
  assert.match(blocks[0], /Question number|One plus one/);
  assert.match(blocks[1], /^Section B: Essay Writing/m, 'the new block leads with its section header');
  assert.match(blocks[1], /Answer ONE question in this section/, 'the section instruction leads the new block');
  assert.match(blocks[1], /3\. Write an essay/, 'theory questions stay in the section block');
});

// ── Bug 1 regression: stored correct answers that are NOT bare letters ──

const OPTIONS = [
  { key: 'A', text: 'Kumasi' },
  { key: 'B', text: 'Accra' },
  { key: 'C', text: 'Tamale' },
  { key: 'D', text: 'Cape Coast' },
];

test('resolveCorrectKey accepts bare letters and dot variants', () => {
  assert.equal(marking.resolveCorrectKey({ correct_answer: 'B', options: OPTIONS }), 'B');
  assert.equal(marking.resolveCorrectKey({ correct_answer: 'b.', options: OPTIONS }), 'B');
  assert.equal(marking.resolveCorrectKey({ correct_answer: 'C', options: OPTIONS }), 'C');
});

test('resolveCorrectKey reconciles letter+text values ("B. Accra") against options', () => {
  assert.equal(marking.resolveCorrectKey({ correct_answer: 'B. Accra', options: OPTIONS }), 'B');
  assert.equal(marking.sanitizeCorrectAnswer('B. Accra', OPTIONS), 'B');
});

test('resolveCorrectKey handles "Option X" and full option text', () => {
  assert.equal(marking.resolveCorrectKey({ correct_answer: 'Option C', options: OPTIONS }), 'C');
  assert.equal(marking.resolveCorrectKey({ correct_answer: 'Accra', options: OPTIONS }), 'B');
});

test('resolveCorrectKey returns null for unparseable answers', () => {
  assert.equal(marking.resolveCorrectKey({ correct_answer: '', options: OPTIONS }), null);
  assert.equal(marking.resolveCorrectKey({ correct_answer: null, options: OPTIONS }), null);
  assert.equal(marking.resolveCorrectKey({ correct_answer: 'Zebra', options: OPTIONS }), null);
});

test('markObjective marks the correct letter right even when the stored key is messy', () => {
  // Regression: the old code compared the student letter to the raw stored
  // value "B. Accra" → "B" !== "B. ACCRA" → marked wrong.
  const q = { correct_answer: 'B. Accra', options: OPTIONS, marks: 1 };
  assert.deepEqual(marking.markObjective(q, 'B'), { isCorrect: true, marksAwarded: 1, maxMarks: 1 });
  assert.deepEqual(marking.markObjective(q, 'b.'), { isCorrect: true, marksAwarded: 1, maxMarks: 1 });
  assert.equal(marking.markObjective(q, 'C').isCorrect, false);
});

test('markObjective matches a full option text answer', () => {
  const q = { correct_answer: 'B', options: OPTIONS, marks: 2 };
  assert.deepEqual(marking.markObjective(q, 'Accra'), { isCorrect: true, marksAwarded: 2, maxMarks: 2 });
});

// ── pdfImport helpers: option letters are preserved and answers resolved safely ──

test('buildOptions preserves the letters printed on the paper', () => {
  assert.deepEqual(
    pdfImport.buildOptions(['A. Kumasi', 'B. Accra', 'C. Tamale', 'D. Cape Coast']),
    [
      { key: 'A', text: 'Kumasi' },
      { key: 'B', text: 'Accra' },
      { key: 'C', text: 'Tamale' },
      { key: 'D', text: 'Cape Coast' },
    ]
  );
});

test('buildOptions falls back to positional A-D when letters are missing', () => {
  assert.deepEqual(
    pdfImport.buildOptions(['Kumasi', 'Accra', 'Tamale', 'Cape Coast']).map((o) => o.key),
    ['A', 'B', 'C', 'D']
  );
});

test('correctKeyFor prefers a validated correct_index (anchored to the returned array)', () => {
  const opts = pdfImport.buildOptions(['A. Kumasi', 'B. Accra', 'C. Tamale', 'D. Cape Coast']);
  assert.equal(pdfImport.correctKeyFor(opts, { correct_answer: 'B', correct_index: 1 }), 'B');
  // Index wins even when the letter would point at a different option.
  assert.equal(pdfImport.correctKeyFor(opts, { correct_answer: 'B', correct_index: 2 }), 'C');
});

test('correctKeyFor sanitizes messy answer-key letters', () => {
  const opts = pdfImport.buildOptions(['A. Kumasi', 'B. Accra', 'C. Tamale', 'D. Cape Coast']);
  assert.equal(pdfImport.correctKeyFor(opts, { correct_answer: 'B. Accra' }), 'B');
  assert.equal(pdfImport.correctKeyFor(opts, { correct_answer: 'Option D' }), 'D');
});

test('correctKeyFor yields null when nothing can be resolved', () => {
  const opts = pdfImport.buildOptions(['A. Kumasi', 'B. Accra', 'C. Tamale', 'D. Cape Coast']);
  assert.equal(pdfImport.correctKeyFor(opts, { correct_answer: '', correct_index: -1 }), null);
  assert.equal(pdfImport.correctKeyFor(opts, { correct_answer: 'Zebra' }), null);
});

// ── AI-integrity design: bold question-type headers, review-safe marking ──

test('formatQuestion renders a bold QUESTION header without the passage', () => {
  const q = { q_order: 1, type: 'objective', text: 'What is 2+2?', passage: 'Read the passage.' };
  assert.equal(exam.formatQuestion({ title: 'Test' }, q, 10), '*QUESTION 1*\n\nWhat is 2+2?');
});

test('formatQuestion drops the type suffix and never inlines the passage', () => {
  const q = { q_order: 2, type: 'theory', text: 'Explain photosynthesis.', passage: 'Read the passage.' };
  assert.equal(exam.formatQuestion({ title: 'Test' }, q, 10), '*QUESTION 2*\n\nExplain photosynthesis.');
});

test('markObjective is review-safe when no correct answer is stored', () => {
  // Regression: an objective question whose AI answer was never verified
  // (NULL correct_answer) must never be marked correct or crash the marker.
  const q = { correct_answer: null, options: OPTIONS, marks: 1 };
  const out = marking.markObjective(q, 'B');
  assert.equal(out.isCorrect, false);
  assert.equal(out.marksAwarded, 0);
  assert.equal(out.maxMarks, 1);
});

// ── PDF import resilience: truncated JSON repaired, null-index answers never guessed ──

test('parseJSON recovers a JSON payload truncated by the output-token cap', () => {
  const truncated =
    '{"questions":[{"type":"objective","text":"The oxen ___ in the field","options":["A. graze","B. grazes"],"correct_answer":"A","correct_index":0,';
  const parsed = ai.parseJSON(truncated);
  assert.ok(parsed && Array.isArray(parsed.questions), 'truncated payload is salvaged');
  assert.equal(parsed.questions.length, 1);
  assert.equal(parsed.questions[0].text, 'The oxen ___ in the field');
  assert.equal(parsed.questions[0].correct_answer, 'A');
});

test('parseJSON still rejects garbage that is not JSON', () => {
  assert.throws(() => ai.parseJSON('We need to extract every question from the document block...'), /not valid JSON/);
});

test('parseJSON strips a markdown code fence', () => {
  const wrapped = '```json\n{"questions":[]}\n```';
  assert.deepEqual(ai.parseJSON(wrapped), { questions: [] });
});

test('correctKeyFor ignores a null correct_index instead of guessing option A', () => {
  // Regression: Number(null) === 0, so an AI that honestly answers
  // "no key present" must not silently mark the first option correct.
  const opts = pdfImport.buildOptions(['A. Kumasi', 'B. Accra', 'C. Tamale', 'D. Cape Coast']);
  assert.equal(pdfImport.correctKeyFor(opts, { correct_answer: '', correct_index: null }), null);
  assert.equal(pdfImport.correctKeyFor(opts, { correct_answer: '', correct_index: undefined }), null);
});

test('stripPaperOnlyInstructions drops paper-only mechanics but keeps passages and useful instructions', () => {
  const input = [
    'Read the following passage carefully and answer questions 1 to 5.',
    'Ama lost her pencil on the way to school.',
    'Answer ALL questions in this section.',
    'Your answer should be between 250 and 300 words.',
    'Shade your answer with a pencil.',
    'Write your answers in the answer booklet.',
    'Do not write in the margin.',
  ].join('\n');
  const out = exam.stripPaperOnlyInstructions(input);
  assert.match(out, /Read the following passage/, 'passage-introducing instruction stays');
  assert.match(out, /Ama lost her pencil/, 'prose mention of pencil survives');
  assert.match(out, /Answer ALL questions/, '"Answer ALL" stays');
  assert.match(out, /250 and 300 words/, 'word limit stays');
  assert.doesNotMatch(out, /Shade your answer/, 'pencil-shading instruction dropped');
  assert.doesNotMatch(out, /answer booklet/, 'booklet instruction dropped');
  assert.doesNotMatch(out, /Do not write in the margin/, 'margin instruction dropped');
});

test('sessionQuestionSequence uses template order when no pool is drawn', () => {
  const session = { id: -999, exam_id: -999 };
  const seq = exam.sessionQuestionSequence(session);
  assert.ok(Array.isArray(seq), 'returns an array');
});

const SECTION_DIVIDER = '━━━━━━━━━━━━━━━━━━━━';

test('buildQuestionBubbles sends OBJECTIVE header once then each question', () => {
  const q1 = { id: 1, q_order: 1, type: 'objective', text: 'Q1', passage: '' };
  const q2 = { id: 2, q_order: 2, type: 'objective', text: 'Q2', passage: '' };
  const seq = [q1, q2];
  assert.deepEqual(exam.buildQuestionBubbles({}, q1, seq, 0), [`*OBJECTIVE*\n\n${SECTION_DIVIDER}`, '*QUESTION 1*\n\nQ1']);
  assert.deepEqual(exam.buildQuestionBubbles({}, q2, seq, 1), ['*QUESTION 2*\n\nQ2']);
});

test('buildQuestionBubbles sends THEORY header once before theory questions', () => {
  const q1 = { id: 1, q_order: 1, type: 'objective', text: 'Q1', passage: '' };
  const q2 = { id: 2, q_order: 2, type: 'theory', text: 'Q2', passage: '' };
  const q3 = { id: 3, q_order: 3, type: 'theory', text: 'Q3', passage: '' };
  const seq = [q1, q2, q3];
  assert.deepEqual(exam.buildQuestionBubbles({}, q2, seq, 1), [`*THEORY*\n\n${SECTION_DIVIDER}`, '*QUESTION 2*\n\nQ2']);
  assert.deepEqual(exam.buildQuestionBubbles({}, q3, seq, 2), ['*QUESTION 3*\n\nQ3']);
});

test('buildQuestionBubbles emits header, instructions, passage, then question', () => {
  const passage = 'Read the passage.\nAma lost her pencil on the way to school.';
  const q1 = { id: 1, q_order: 1, type: 'objective', text: 'Q1', passage };
  const q2 = { id: 2, q_order: 2, type: 'objective', text: 'Q2', passage };
  const seq = [q1, q2];
  assert.deepEqual(exam.buildQuestionBubbles({}, q1, seq, 0), [
    `*OBJECTIVE*\n\n${SECTION_DIVIDER}`,
    '*Instructions*\n\nRead the passage.',
    'Ama lost her pencil on the way to school.',
    '*QUESTION 1*\n\nQ1',
  ]);
  assert.deepEqual(exam.buildQuestionBubbles({}, q2, seq, 1), ['*QUESTION 2*\n\nQ2']);
});

test('buildQuestionBubbles treats an unknown index as the first question', () => {
  const q = { id: 7, q_order: 3, type: 'objective', text: 'Q3', passage: 'Read the passage.' };
  assert.deepEqual(exam.buildQuestionBubbles({}, q, [], -1), [
    `*OBJECTIVE*\n\n${SECTION_DIVIDER}`,
    '*Instructions*\n\nRead the passage.',
    '*QUESTION 3*\n\nQ3',
  ]);
});

test('sessionQuestionSequence resolves drawn pool order and ids match for wiring', () => {
  const db = require('../src/db');
  db.exec('BEGIN');
  try {
    const examId = db
      .prepare('INSERT INTO exams (title, subject, duration_minutes) VALUES (?,?,?)')
      .run('__seq_test_exam__', 'Test', 30).lastInsertRowid;
    const studentId = db
      .prepare('INSERT INTO students (phone) VALUES (?)')
      .run('__seq_test_phone__' + Date.now()).lastInsertRowid;
    const sessionId = db
      .prepare('INSERT INTO sessions (exam_id, student_id) VALUES (?,?)')
      .run(examId, studentId).lastInsertRowid;
    const p1 = db
      .prepare('INSERT INTO question_pool (exam_id, type, text) VALUES (?,?,?)')
      .run(examId, 'objective', 'pool Q1').lastInsertRowid;
    const p2 = db
      .prepare('INSERT INTO question_pool (exam_id, type, text) VALUES (?,?,?)')
      .run(examId, 'objective', 'pool Q2').lastInsertRowid;
    // Drawn order: Q2 first, Q1 second.
    db.prepare('INSERT INTO session_questions (session_id, question_id, q_order) VALUES (?,?,?)').run(sessionId, p2, 1);
    db.prepare('INSERT INTO session_questions (session_id, question_id, q_order) VALUES (?,?,?)').run(sessionId, p1, 2);

    const seq = exam.sessionQuestionSequence({ id: sessionId });
    assert.equal(seq.length, 2);
    assert.equal(seq[0].id, p2, 'drawn order: Q2 first');
    assert.equal(seq[1].id, p1, 'drawn order: Q1 second');
    assert.ok(seq[0]._pool, 'pool rows are flagged');

    const question = exam.getSessionQuestion(sessionId, 1);
    assert.equal(question.q_order, 1, 'session q_order is stamped onto the pool row');
    assert.equal(seq.findIndex((q) => q.id === question.id), 0, 'findIndex matches the pool row id the wiring relies on');
  } finally {
    db.exec('ROLLBACK');
  }
});

test('nextInSequence advances across a deleted-question gap in q_order', () => {
  const db = require('../src/db');
  db.exec('BEGIN');
  try {
    const examId = db
      .prepare('INSERT INTO exams (title, subject, duration_minutes) VALUES (?,?,?)')
      .run('__gap_exam__', 'Test', 30).lastInsertRowid;
    const q1 = db.prepare("INSERT INTO questions (exam_id, q_order, type, text, marks) VALUES (?,1,'objective','Q1',1)").run(examId).lastInsertRowid;
    db.prepare("INSERT INTO questions (exam_id, q_order, type, text, marks) VALUES (?,2,'objective','Q2',1)").run(examId);
    const q3 = db.prepare("INSERT INTO questions (exam_id, q_order, type, text, marks) VALUES (?,3,'objective','Q3',1)").run(examId).lastInsertRowid;
    db.prepare('DELETE FROM questions WHERE id = ?').run(
      db.prepare("SELECT id FROM questions WHERE exam_id = ? AND q_order = 2").get(examId).id
    );
    const studentId = db
      .prepare('INSERT INTO students (phone) VALUES (?)')
      .run('__gap_phone__' + Date.now()).lastInsertRowid;
    const sessionId = db
      .prepare('INSERT INTO sessions (exam_id, student_id) VALUES (?,?)')
      .run(examId, studentId).lastInsertRowid;

    const session = { id: sessionId };
    const first = exam.getSessionQuestion(sessionId, 1);
    assert.equal(first.q_order, 1, 'first question is Q1');
    const next = exam.nextInSequence(session, first);
    assert.ok(next, 'a next question exists despite the q_order=2 gap');
    assert.equal(next.id, q3, 'advances to Q3, not a missing Q2');
    assert.equal(exam.nextInSequence(session, next), null, 'final question has no successor');
  } finally {
    db.exec('ROLLBACK');
  }
});

test('drawSessionQuestions tops up a small pool with template questions to reach the exam count', () => {
  const db = require('../src/db');
  db.exec('BEGIN');
  try {
    const examId = db
      .prepare('INSERT INTO exams (title, subject, duration_minutes) VALUES (?,?,?)')
      .run('__topup_exam__', 'Test', 30).lastInsertRowid;
    for (let i = 1; i <= 5; i++) {
      db.prepare("INSERT INTO questions (exam_id, q_order, type, text, marks) VALUES (?,?,?,?,1)").run(examId, i, 'objective', 'T' + i);
    }
    db.prepare("INSERT INTO question_pool (exam_id, type, text) VALUES (?,?,?)").run(examId, 'objective', 'P1');
    db.prepare("INSERT INTO question_pool (exam_id, type, text) VALUES (?,?,?)").run(examId, 'objective', 'P2');
    const studentId = db
      .prepare('INSERT INTO students (phone) VALUES (?)')
      .run('__topup_phone__' + Date.now()).lastInsertRowid;
    const sessionId = db
      .prepare('INSERT INTO sessions (exam_id, student_id) VALUES (?,?)')
      .run(examId, studentId).lastInsertRowid;

    const drawn = exam.drawSessionQuestions(sessionId, examId);
    assert.equal(drawn, 5, 'session presents all 5 questions even though the pool started with 2');

    const rows = db.prepare('SELECT q_order, question_id FROM session_questions WHERE session_id = ? ORDER BY q_order').all(sessionId);
    assert.equal(rows.length, 5, 'five drawn rows are stored');
    const orders = rows.map((r) => r.q_order);
    assert.deepEqual(orders, [1, 2, 3, 4, 5], 'session order is contiguous');

    for (const r of rows) {
      const pooled = db.prepare('SELECT * FROM question_pool WHERE id = ?').get(r.question_id);
      assert.ok(pooled, 'every drawn question_id resolves to a question_pool row (FK-safe)');
    }
    const texts = rows.map((r) => db.prepare('SELECT text FROM question_pool WHERE id = ?').get(r.question_id).text);
    assert.ok(texts.includes('T3'), 'template question T3 was copied into the pool');
  } finally {
    db.exec('ROLLBACK');
  }
});

test('estimateQuestionCount counts question-numbered lines', () => {
  const text = [
    '1. One plus one?',
    'A. 1 B. 2',
    '2. Two plus two?',
    'A. 2 B. 4',
    'Section B',
    '3. Write an essay.',
    '4. Write a story.',
  ].join('\n');
  assert.equal(ai.estimateQuestionCount(text), 4);
});

test('completenessWarning is null when extraction is not far below the estimate and a message when it is', () => {
  const many = (n) => Array(n).fill({});
  assert.equal(ai.completenessWarning(60, many(35)), null, '35 of ~60 is more than half → no warning');
  assert.equal(ai.completenessWarning(10, many(10)), null, 'complete extraction never warns');
  assert.equal(ai.completenessWarning(2, many(0)), null, 'tiny estimates never warn');
  const msg = ai.completenessWarning(60, many(5));
  assert.match(msg, /Extracted 5 questions, but the document appears to contain ~60\./, 'warning message text');
});

test('stripSourceWatermarks removes watermark and source footer lines', () => {
  const input = [
    'Read the passage below.',
    'DOWNLOADED FROM SRONU',
    'papers.sronu.com',
    'www.example.edu.gh',
    'Source: https://papers.sronu.com',
    'Visit us at example.com for more.',
    'The farmers rely on irrigation.',
  ].join('\n');
  const out = stripSourceWatermarks(input);
  assert.doesNotMatch(out, /sronu/i, 'sronu line removed');
  assert.doesNotMatch(out, /www\./, 'bare URL line removed');
  assert.doesNotMatch(out, /Source:/i, 'source: line removed');
  assert.doesNotMatch(out, /Visit us at/i, 'visit-us-at line removed');
  assert.match(out, /Read the passage below\./, 'real content kept');
  assert.match(out, /The farmers rely on irrigation\./, 'real content kept');
});

test('stripSourceWatermarks collapses the vertically-arranged one-word-per-line watermark', () => {
  const input = 'Read the passage.\nDOWNLOADED\nFROM\nSRONU\npapers.sronu.com\n\n\n\nQuestion one?';
  const out = stripSourceWatermarks(input);
  assert.doesNotMatch(out, /DOWNLOADED/, 'first watermark word removed');
  assert.doesNotMatch(out, /FROM/, 'watermark middle word removed');
  assert.doesNotMatch(out, /sronu/i, 'site line removed');
  assert.doesNotMatch(out, /\n\n\n/, 'newline runs collapsed');
  assert.match(out, /Question one\?/, 'question text kept');
});

test('stripSourceWatermarks keeps legitimate prose that merely mentions a website', () => {
  const out = stripSourceWatermarks('The school website www.ghschools.gov.gh published the timetable for this term.');
  assert.match(out, /www\.ghschools\.gov\.gh/, 'mid-sentence URL survives');
});

test('stripSourceWatermarks never drops a line just for containing the word "papers"', () => {
  const out = stripSourceWatermarks('The examiner collects the papers after the exam.');
  assert.match(out, /papers/, '"papers" in prose survives');
});

test('buildQuestionBubbles strips watermark lines from a passage before sending', () => {
  const dirtyPassage = 'Read the passage below.\nDOWNLOADED FROM SRONU\npapers.sronu.com';
  const q1 = { id: 1, q_order: 1, type: 'objective', text: 'Q1', passage: dirtyPassage };
  const q2 = { id: 2, q_order: 2, type: 'objective', text: 'Q2', passage: dirtyPassage };
  const seq = [q1, q2];
  const bubbles = exam.buildQuestionBubbles({}, q1, seq, 0);
  const joined = bubbles.join('\n');
  assert.doesNotMatch(joined, /sronu/i, 'no watermark in any bubble');
  assert.match(joined, /Read the passage below\./, 'real passage content kept');
  assert.deepEqual(exam.buildQuestionBubbles({}, q2, seq, 1), ['*QUESTION 2*\n\nQ2'], 'passage-once: Q2 emits no passage bubble at all');
});

test('buildQuestionBubbles does not duplicate a shared instruction-laden passage', () => {
  const passage = 'Read the following passage and answer questions 1 to 5.\nThe farmers rely on irrigation.';
  const q1 = { id: 1, q_order: 1, type: 'theory', text: 'Q1', passage };
  const q2 = { id: 2, q_order: 2, type: 'theory', text: 'Q2', passage };
  const seq = [q1, q2];
  const out = [
    ...exam.buildQuestionBubbles({}, q1, seq, 0),
    ...exam.buildQuestionBubbles({}, q2, seq, 1),
  ];
  assert.equal(out.filter((b) => b === 'The farmers rely on irrigation.').length, 1, 'passage body emitted exactly once across both questions');
  assert.equal(out.filter((b) => b === '*Instructions*\n\nRead the following passage and answer questions 1 to 5.').length, 1, 'instructions emitted exactly once');
  assert.equal(out.filter((b) => b.startsWith('*THEORY*')).length, 1, 'header emitted exactly once');
});

test("buildQuestionBubbles keeps a later question's own instruction lines", () => {
  const q1 = { id: 1, q_order: 1, type: 'objective', text: 'Q1', passage: 'Read the first passage.\nAma went to the market.' };
  const q2 = { id: 2, q_order: 2, type: 'objective', text: 'Q2', passage: 'Read the second passage.\nKofi stayed home.' };
  const seq = [q1, q2];
  assert.deepEqual(exam.buildQuestionBubbles({}, q1, seq, 0), [
    `*OBJECTIVE*\n\n${SECTION_DIVIDER}`,
    '*Instructions*\n\nRead the first passage.',
    'Ama went to the market.',
    '*QUESTION 1*\n\nQ1',
  ]);
  assert.deepEqual(exam.buildQuestionBubbles({}, q2, seq, 1), [
    '*Instructions*\n\nRead the second passage.',
    'Kofi stayed home.',
    '*QUESTION 2*\n\nQ2',
  ]);
});

test('EXAMINER_PERSONA is a real persona and examinerPrompt prepends it', () => {
  assert.match(ai.EXAMINER_PERSONA, /40 years of experience/i, 'persona carries the examiner experience');
  const out = ai.examinerPrompt('BASE');
  assert.ok(out.startsWith(ai.EXAMINER_PERSONA), 'persona leads the prompt');
  assert.match(out, /BASE/, 'base content follows the persona');
});

test('resolveObjectiveAnswer exists and maps options to 0-based lines', async () => {
  assert.equal(typeof ai.resolveObjectiveAnswer, 'function');
  const result = await ai.resolveObjectiveAnswer({
    questionText: 'Capital of Ghana?',
    passage: '',
    options: [
      { key: 'A', text: 'Kumasi' },
      { key: 'B', text: 'Accra' },
      { key: 'C', text: 'Tamale' },
    ],
  });
  assert.ok(Number.isInteger(result.correct_index), 'correct_index is an integer');
  assert.ok(result.correct_index >= -1 && result.correct_index <= 2, 'correct_index in range');
  assert.equal(typeof result.explanation, 'string');
});

test('objective answer without a stored key is AI-resolved, persisted, and graded', async () => {
  const db = require('../src/db');
  db.exec('BEGIN');
  try {
    const examId = db
      .prepare('INSERT INTO exams (title, subject, duration_minutes) VALUES (?,?,?)')
      .run('__obj_ai_exam__', 'Test', 30).lastInsertRowid;
    const qid = db
      .prepare("INSERT INTO questions (exam_id, q_order, type, text, options, correct_answer, marks) VALUES (?,1,'objective',?,?,NULL,1)")
      .run(examId, 'Capital of Ghana?', JSON.stringify([{ key: 'A', text: 'Kumasi' }, { key: 'B', text: 'Accra' }])).lastInsertRowid;
    const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(qid);
    const studentId = db
      .prepare('INSERT INTO students (phone) VALUES (?)')
      .run('__obj_ai_phone__' + Date.now()).lastInsertRowid;
    const sessionId = db
      .prepare('INSERT INTO sessions (exam_id, student_id) VALUES (?,?)')
      .run(examId, studentId).lastInsertRowid;

    const real = ai.resolveObjectiveAnswer;
    ai.resolveObjectiveAnswer = async () => ({ correct_index: 1, explanation: 'Accra is the capital.' });
    try {
      await exam.handleAnswer(
        { pass_percentage: 50 },
        { id: sessionId, exam_id: examId, current_q_order: 1 },
        { id: studentId, phone: '__none__' },
        { ...q, _pool: false, q_order: 1 },
        'B'
      );
    } finally {
      ai.resolveObjectiveAnswer = real;
    }

    const row = db.prepare('SELECT * FROM answers WHERE session_id = ?').get(sessionId);
    assert.ok(row, 'an answer row exists');
    assert.equal(row.marked_by, 'ai', 'graded by the AI examiner');
    assert.equal(row.needs_review, 0, 'never flagged for admin review');
    assert.equal(row.is_correct, 1, 'student answered B which matches the resolved key');
    const persisted = db.prepare('SELECT correct_answer FROM questions WHERE id = ?').get(qid);
    assert.equal(persisted.correct_answer, 'B', 'resolved key persisted on the question');
  } finally {
    db.exec('ROLLBACK');
  }
});

test('objective answer stays graded at 0 when the AI cannot determine a key', async () => {
  const db = require('../src/db');
  db.exec('BEGIN');
  try {
    const examId = db
      .prepare('INSERT INTO exams (title, subject, duration_minutes) VALUES (?,?,?)')
      .run('__obj_ai_fail_exam__', 'Test', 30).lastInsertRowid;
    const qid = db
      .prepare("INSERT INTO questions (exam_id, q_order, type, text, options, correct_answer, marks) VALUES (?,1,'objective',?,?,NULL,1)")
      .run(examId, 'Tricky question?', JSON.stringify([{ key: 'A', text: 'X' }, { key: 'B', text: 'Y' }])).lastInsertRowid;
    const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(qid);
    const studentId = db
      .prepare('INSERT INTO students (phone) VALUES (?)')
      .run('__obj_ai_fail_phone__' + Date.now()).lastInsertRowid;
    const sessionId = db
      .prepare('INSERT INTO sessions (exam_id, student_id) VALUES (?,?)')
      .run(examId, studentId).lastInsertRowid;

    const real = ai.resolveObjectiveAnswer;
    ai.resolveObjectiveAnswer = async () => ({ correct_index: -1, explanation: 'ambiguous' });
    try {
      await exam.handleAnswer(
        { pass_percentage: 50 },
        { id: sessionId, exam_id: examId, current_q_order: 1 },
        { id: studentId, phone: '__none__' },
        { ...q, _pool: false, q_order: 1 },
        'A'
      );
    } finally {
      ai.resolveObjectiveAnswer = real;
    }

    const row = db.prepare('SELECT * FROM answers WHERE session_id = ?').get(sessionId);
    assert.equal(row.marked_by, 'ai', 'graded by AI even when unresolved');
    assert.equal(row.marks_awarded, 0, 'zero marks');
    assert.equal(row.needs_review, 0, 'never pending admin review');
    assert.match(row.ai_feedback, /examiner could not determine/i, 'neutral explanatory note');
  } finally {
    db.exec('ROLLBACK');
  }
});

test('processAnswer advances a pool-drawn session without throwing on the next question', async () => {
  const db = require('../src/db');
  const wa = require('../src/services/whatsapp');
  db.exec('BEGIN');
  try {
    const examId = db
      .prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES (?,?,?,'published')")
      .run('__advance_pool_exam__', 'Test', 30).lastInsertRowid;
    const opts = JSON.stringify([
      { key: 'A', text: 'Kumasi' },
      { key: 'B', text: 'Accra' },
      { key: 'C', text: 'Tamale' },
      { key: 'D', text: 'Cape Coast' },
    ]);
    db.prepare("INSERT INTO questions (exam_id, q_order, type, text, options, correct_answer, marks) VALUES (?,1,'objective','Q1?',?,?,1)").run(examId, opts, 'B');
    db.prepare("INSERT INTO questions (exam_id, q_order, type, text, options, correct_answer, marks) VALUES (?,2,'objective','Q2?',?,?,1)").run(examId, opts, 'C');

    const studentId = db
      .prepare('INSERT INTO students (phone) VALUES (?)')
      .run('__advance_pool_phone__' + Date.now()).lastInsertRowid;
    const session = exam.createSession(examId, studentId);

    const real = wa.sendText;
    wa.sendText = async () => ({ ok: true });
    try {
      // Regression: answering Q1 threw "Provided value cannot be bound to
      // SQLite parameter 1" because the next pool question had no q_order.
      await exam.processAnswer(session, { id: studentId, phone: '000' }, 'B', {});
      const updated = db.prepare('SELECT current_q_order FROM sessions WHERE id = ?').get(session.id);
      assert.equal(updated.current_q_order, 2, 'advances to question 2');
    } finally {
      wa.sendText = real;
    }
  } finally {
    db.exec('ROLLBACK');
  }
});

test('markAllPendingTheory records 0 marks, needs_review=0 after a final marking failure', async () => {
  const db = require('../src/db');
  db.exec('BEGIN');
  try {
    const examId = db
      .prepare('INSERT INTO exams (title, subject, duration_minutes) VALUES (?,?,?)')
      .run('__theory_fail_exam__', 'Test', 30).lastInsertRowid;
    const qid = db
      .prepare("INSERT INTO questions (exam_id, q_order, type, text, marks) VALUES (?,1,'theory','Explain.',5)")
      .run(examId).lastInsertRowid;
    const studentId = db
      .prepare('INSERT INTO students (phone) VALUES (?)')
      .run('__theory_fail_phone__' + Date.now()).lastInsertRowid;
    const sessionId = db
      .prepare('INSERT INTO sessions (exam_id, student_id) VALUES (?,?)')
      .run(examId, studentId).lastInsertRowid;
    db.prepare(
      `INSERT INTO answers (session_id, question_id, q_order, answer_text, marks_awarded, max_marks, marked_by, needs_review)
       VALUES (?,?,1,'Student explanation',0,5,'pending',0)`
    ).run(sessionId, qid);

    const real = marking.markTheoryAnswer;
    marking.markTheoryAnswer = async () => { throw new Error('examiner down'); };
    try {
      await exam.markAllPendingTheory(sessionId);
    } finally {
      marking.markTheoryAnswer = real;
    }

    const row = db.prepare('SELECT * FROM answers WHERE session_id = ?').get(sessionId);
    assert.equal(row.marked_by, 'ai', 'AI marked even on failure');
    assert.equal(row.marks_awarded, 0, 'zero marks on final failure');
    assert.equal(row.needs_review, 0, 'never pending admin review');
    assert.match(row.ai_feedback, /could not mark this answer/, 'explanatory note');
  } finally {
    db.exec('ROLLBACK');
  }
});

test('splitSectionMeta pulls leading instruction lines out of a passage', () => {
  const r = exam.splitSectionMeta(
    'Answer ONE question in this section.\n' +
    'Your answer should be between 250 and 300 words.\n' +
    'Write about the importance of education.'
  );
  assert.equal(
    r.instructions,
    'Answer ONE question in this section.\nYour answer should be between 250 and 300 words.\nWrite about the importance of education.'
  );
  assert.equal(r.passage, '');
});

test('splitSectionMeta keeps comprehension prose in passage, not instructions', () => {
  const r = exam.splitSectionMeta(
    'Read the following passage carefully and answer questions 1 to 5.\n' +
    'The farmers of the valley rely on irrigation channels that carry water from the mountain.\n' +
    'Every dry season the council dredges the channels so the fields stay productive.'
  );
  assert.match(r.instructions, /^Read the following passage carefully/);
  assert.match(r.passage, /^The farmers of the valley/);
  assert.match(r.passage, /fields stay productive/);
});

test('splitSectionMeta returns no instructions when none lead the text', () => {
  assert.deepEqual(exam.splitSectionMeta('What is the capital of Ghana?'), { instructions: '', passage: 'What is the capital of Ghana?' });
});

test('splitSectionMeta handles empty input', () => {
  assert.deepEqual(exam.splitSectionMeta(''), { instructions: '', passage: '' });
  assert.deepEqual(exam.splitSectionMeta('   '), { instructions: '', passage: '' });
});

test('drawSessionQuestions presents the pool in PDF (insertion) order, not shuffled', () => {
  const db = require('../src/db');
  db.exec('BEGIN');
  try {
    const examId = db
      .prepare("INSERT INTO exams (title, subject, duration_minutes) VALUES ('__order_exam__','Test',30)")
      .run().lastInsertRowid;
    for (let i = 1; i <= 3; i++) {
      db.prepare("INSERT INTO questions (exam_id, q_order, type, text, marks) VALUES (?,?,?,?,?)")
        .run(examId, i, 'objective', 'TQ' + i, 1);
    }
    const ids = [];
    for (let i = 1; i <= 3; i++) {
      ids.push(db.prepare("INSERT INTO question_pool (exam_id, type, text) VALUES (?,'objective',?)")
        .run(examId, 'PQ' + i).lastInsertRowid);
    }
    const studentId = db
      .prepare('INSERT INTO students (phone) VALUES (?)')
      .run('__order_phone__' + Date.now()).lastInsertRowid;
    const sessionId = db
      .prepare('INSERT INTO sessions (exam_id, student_id) VALUES (?,?)')
      .run(examId, studentId).lastInsertRowid;

    exam.drawSessionQuestions(sessionId, examId);
    const drawn = db
      .prepare('SELECT q_order, question_id FROM session_questions WHERE session_id = ? ORDER BY q_order')
      .all(sessionId);
    assert.deepEqual(drawn.map((d) => d.question_id), ids, 'presented in insertion (PDF) order');
  } finally {
    db.exec('ROLLBACK');
  }
});

const wa = require('../src/services/whatsapp');

test('splitTextChunks leaves short text as one chunk', () => {
  assert.deepEqual(wa.splitTextChunks('Hello world'), ['Hello world']);
});

test('splitTextChunks splits long text into capped chunks with continuation markers', () => {
  const chunks = wa.splitTextChunks('x'.repeat(9000), 4000);
  assert.ok(chunks.length >= 3, '9000 chars becomes at least 3 chunks');
  for (const c of chunks) assert.ok(c.length <= 4000, `chunk under cap (${c.length})`);
  assert.ok(chunks.slice(0, -1).every((c) => c.endsWith(' …')), 'non-final chunks carry the marker');
  assert.equal(chunks[chunks.length - 1].endsWith(' …'), false, 'final chunk has no marker');
});

test('splitTextChunks splits a single over-long line', () => {
  const chunks = wa.splitTextChunks('y'.repeat(8500), 4000);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= 4000);
});

test('extractQuestionsFromText serially retries a block that failed in the wave', async () => {
  const orig = ai.chatJSON;
  const calls = { n: 0 };
  ai.chatJSON = async () => {
    calls.n++;
    if (calls.n <= 4) throw new Error('fetch failed');
    return { questions: [{ type: 'objective', text: 'Retry Q', options: ['A. X', 'B. Y'], correct_answer: 'A', correct_index: 0 }] };
  };
  try {
    const out = await ai.extractQuestionsFromText('1. Retry Q?\nA. X\nB. Y');
    assert.equal(out.length, 1, 'question survives the failed wave via the serial re-run');
    assert.equal(out[0].text, 'Retry Q');
    assert.ok(calls.n >= 5, 'wave retries exhausted before the serial re-run succeeded');
  } finally {
    ai.chatJSON = orig;
  }
});

test('extractQuestionsFromText warns when a block still fails after the serial retry', async () => {
  const orig = ai.chatJSON;
  ai.chatJSON = async () => { throw new Error('fetch failed'); };
  const warnings = [];
  try {
    const out = await ai.extractQuestionsFromText('1. Retry Q?\nA. X\nB. Y', null, (w) => warnings.push(w));
    assert.equal(out.length, 0, 'no questions parsed');
    assert.equal(warnings.length, 1, 'warning fired once');
    assert.match(warnings[0], /could not be parsed/);
  } finally {
    ai.chatJSON = orig;
  }
});
