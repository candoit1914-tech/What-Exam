'use strict';
// MUST precede every require of src/db — src/config.js reads DB_PATH at
// require time and src/db.js opens the file at require time.
const os = require('os');
const path = require('path');
process.env.DB_PATH = path.join(os.tmpdir(), `la-exam-dedupe-${process.pid}.db`);
process.env.SEED_ON_BOOT = 'false';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const exam = require('../src/services/exam');

// One row per input format. Every Ghanaian number must normalise to the same
// 12 digits no matter how it was typed; that identity is the whole point.
const NORMALIZE_CASES = [
  // Ghana, local with trunk 0
  ['0242004542', '233242004542'],
  ['0201234567', '233201234567'],
  // Ghana, already international
  ['233242004542', '233242004542'],
  ['+233 24 200 4542', '233242004542'],
  ['00233 24 200 4542', '233242004542'],
  // International with a stray national 0 after the country code
  ['2330242004542', '233242004542'],
  // THE REGRESSION: 9 digits beginning with 1 used to be treated as NANP
  ['123456789', '233123456789'],
  ['124567890', '233124567890'],
  // NANP stays untouched
  ['+1 202 555 0143', '12025550143'],
  ['12025550143', '12025550143'],
  // Nigeria
  ['08012345678', '2348012345678'],
  // Ten digits starting 2 is kept verbatim
  ['2025550143', '2025550143'],
  // Unmappable input yields empty string, never a guess
  ['abc', ''],
  ['123', ''],
  ['12345678901234567', ''],
  ['', ''],
  [null, ''],
];

test('normalizePhone maps every accepted format to one canonical number', () => {
  for (const [input, expected] of NORMALIZE_CASES) {
    assert.equal(
      exam.normalizePhone(input),
      expected,
      `normalizePhone(${JSON.stringify(input)}) should be ${JSON.stringify(expected)}`,
    );
  }
});

test('the five spellings of one Ghanaian number are indistinguishable', () => {
  const spellings = ['0242004542', '233242004542', '+233 24 200 4542', '00233242004542', '2330242004542'];
  const results = new Set(spellings.map((s) => exam.normalizePhone(s)));
  assert.equal(results.size, 1, `expected 1 canonical value, got ${[...results].join(', ')}`);
});

test('splitRecipients breaks a pasted list on every common separator', () => {
  assert.deepEqual(
    exam.splitRecipients('0242004542, 0244004542\n0246004542'),
    ['0242004542', '0244004542', '0246004542'],
  );
  assert.deepEqual(
    exam.splitRecipients('0242004542;0244004542\t0246004542'),
    ['0242004542', '0244004542', '0246004542'],
  );
  assert.deepEqual(
    exam.splitRecipients('0242004542\r\n0244004542\r\n'),
    ['0242004542', '0244004542'],
  );
  assert.deepEqual(exam.splitRecipients('0242004542,,,;  \n'), ['0242004542']);
  assert.deepEqual(exam.splitRecipients(''), []);
  assert.deepEqual(exam.splitRecipients(null), []);
});

test('splitRecipients does not merge a name that follows its number', () => {
  // A pasted "number name" pair keeps both tokens; the name is a separate
  // field supplied by the UI, not something the tokenizer should discard.
  assert.deepEqual(
    exam.splitRecipients('0242004542 Ama Serwaa'),
    ['0242004542', 'Ama', 'Serwaa'],
  );
});

const db = require('../src/db');

function makeExam(title) {
  return db
    .prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES (?,?,?,'published')")
    .run(title, 'Test', 60).lastInsertRowid;
}

function recipientCount(examId) {
  return db
    .prepare('SELECT COUNT(*) c FROM exam_recipients WHERE exam_id = ?')
    .get(examId).c;
}

test('addRecipients links a new student and reports it as added', () => {
  const examId = makeExam('__dedupe_new__');
  const r = exam.addRecipients(examId, [{ phone: '0242004542', name: 'Ama Serwaa' }]);
  assert.equal(r.added.length, 1);
  assert.equal(r.merged, 0);
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.added[0].phone, '233242004542');
  assert.equal(r.added[0].name, 'Ama Serwaa');
  assert.equal(recipientCount(examId), 1);
});

test('addRecipients collapses five spellings of one number into one recipient', () => {
  // A number unique to this test: students are global, so reusing 0242004542
  // here would find the row created by the test above and report a merge.
  const examId = makeExam('__dedupe_spellings__');
  const r = exam.addRecipients(examId, [
    { phone: '0244004542' },
    { phone: '233244004542' },
    { phone: '+233 24 400 4542' },
    { phone: '00233244004542' },
    { phone: '0244004542' },
  ]);
  assert.equal(r.added.length, 1, 'only the first spelling creates a student');
  assert.equal(r.merged, 4, 'the other four are reported as merged, not added');
  assert.equal(recipientCount(examId), 1);
});

test('addRecipients counts a repeat against an existing recipient as merged', () => {
  const examId = makeExam('__dedupe_repeat__');
  exam.addRecipients(examId, [{ phone: '0242004542', name: 'Ama Serwaa' }]);
  const second = exam.addRecipients(examId, [{ phone: '0242004542', name: 'Ama Serwaa' }]);
  assert.equal(second.added.length, 0);
  assert.equal(second.merged, 1);
  assert.equal(recipientCount(examId), 1, 're-adding must not create a second recipient row');
});

test('addRecipients reports a name conflict and never renames the student', () => {
  const examId = makeExam('__dedupe_conflict__');
  exam.addRecipients(examId, [{ phone: '0242004542', name: 'Ama Serwaa' }]);
  const r = exam.addRecipients(examId, [{ phone: '233242004542', name: 'Ama Serwea' }]);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].phone, '233242004542');
  assert.equal(r.conflicts[0].existingName, 'Ama Serwaa');
  assert.equal(r.conflicts[0].incomingName, 'Ama Serwea');
  const student = db.prepare('SELECT name FROM students WHERE phone = ?').get('233242004542');
  assert.equal(student.name, 'Ama Serwaa', 'existing name must win');
});

test('a name-only re-add does not raise a conflict', () => {
  const examId = makeExam('__dedupe_noname__');
  exam.addRecipients(examId, [{ phone: '0242004542', name: 'Ama Serwaa' }]);
  const r = exam.addRecipients(examId, [{ phone: '0242004542' }]);
  assert.deepEqual(r.conflicts, [], 'an absent name is not a disagreement');
  assert.equal(r.merged, 1);
});

test('a blank incoming name never clears an existing name', () => {
  const examId = makeExam('__dedupe_blank__');
  exam.addRecipients(examId, [{ phone: '0242004542', name: 'Ama Serwaa' }]);
  exam.addRecipients(examId, [{ phone: '0242004542', name: '   ' }]);
  const student = db.prepare('SELECT name FROM students WHERE phone = ?').get('233242004542');
  assert.equal(student.name, 'Ama Serwaa');
});

test('addRecipients reports invalid input with the original text and a reason', () => {
  const examId = makeExam('__dedupe_invalid__');
  const r = exam.addRecipients(examId, [
    { phone: '0246004542', name: 'Ama' },
    { phone: 'abc', name: 'Broken' },
    { phone: '123', name: 'Too short' },
  ]);
  assert.equal(r.added.length, 1);
  assert.equal(r.invalid.length, 2);
  assert.equal(r.invalid[0].input, 'abc');
  assert.match(r.invalid[0].reason, /number/i);
  assert.equal(r.invalid[1].input, '123');
});

test('addRecipients links an already-known student who is new to this exam', () => {
  const examId = makeExam('__dedupe_existing_student__');
  const studentId = db
    .prepare("INSERT INTO students (phone, name) VALUES ('233990001111','Kofi Mensah')")
    .run().lastInsertRowid;
  const r = exam.addRecipients(examId, [{ phone: '0990001111' }]);
  assert.equal(r.merged, 1, 'a known student is a merge, not a creation');
  assert.equal(r.added.length, 0);
  const link = db
    .prepare('SELECT student_id FROM exam_recipients WHERE exam_id = ?')
    .get(examId);
  assert.equal(link.student_id, studentId, 'the existing student row is reused');
  assert.deepEqual(r.conflicts, []);
});

test('addRecipients rolls the whole import back when a link fails', () => {
  // exam_recipients.exam_id is a foreign key and src/db.js:10 turns
  // PRAGMA foreign_keys ON, so linking to a non-existent exam throws AFTER the
  // student row has been inserted. That is exactly the window a missing
  // transaction would leak.
  const before = db.prepare('SELECT COUNT(*) c FROM students').get().c;
  assert.throws(() => exam.addRecipients(99999999, [{ phone: '0242004542' }]));
  const after = db.prepare('SELECT COUNT(*) c FROM students').get().c;
  assert.equal(after, before, 'a thrown error must roll the whole import back');
});

test('addRecipients reports a blank or null phone as invalid rather than throwing', () => {
  const examId = makeExam('__dedupe_blank_phone__');
  const r = exam.addRecipients(examId, [{ phone: '0248004542' }, { phone: null }, { phone: '  ' }]);
  assert.equal(r.added.length, 1);
  assert.equal(r.invalid.length, 2);
  assert.equal(recipientCount(examId), 1);
});
