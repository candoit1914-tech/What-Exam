'use strict';
// The default theory rule: a paper that never states a choice still behaves
// like the exam it is. Question 1 is compulsory, the student picks the rest,
// and a 6-question block is answered as 4 questions (7 → 5). Both creation
// paths must write it — AI generation and paper upload — and it must never
// overwrite a rule or split someone already made.
require('./helpers/isolate');

const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');

const db = require('../src/db');
const ai = require('../src/services/ai');
const marking = require('../src/services/marking');
const pdfImport = require('../src/services/pdfImport');
const documentSrc = require('../src/services/document');
const selection = require('../src/services/selection');
const examSvc = require('../src/services/exam');

function newExam(title, status = 'draft') {
  return db
    .prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES (?,'Math',30,?)")
    .run(title, status).lastInsertRowid;
}

/** `n` untouched theory questions — exactly what generation and import write. */
function theoryExam(n, title) {
  const eid = newExam(title);
  for (let i = 1; i <= n; i++) {
    db.prepare(
      "INSERT INTO questions (exam_id, q_order, type, text, marks) VALUES (?,?,'theory',?,5)"
    ).run(eid, i, `Theory ${i}`);
  }
  return eid;
}

const rulesOf = (eid) => db.prepare('SELECT * FROM exam_sections WHERE exam_id = ? ORDER BY position').all(eid);
const flagsOf = (eid) => db
  .prepare('SELECT q_order, source_number, is_compulsory, section_key FROM questions WHERE exam_id = ? ORDER BY q_order')
  .all(eid);

// ── the rule itself ───────────────────────────────────────────────────

test('a six-question theory block answers 4: question 1 plus three chosen', () => {
  const eid = theoryExam(6, '__six__');
  assert.equal(selection.applyDefaultTheoryRule(eid), 1);

  const [rule] = rulesOf(eid);
  assert.equal(rule.section_key, 'theory');
  assert.equal(rule.answer_count, 4, 'the paper owes 4 questions, compulsory included');

  const flags = flagsOf(eid);
  assert.equal(flags[0].is_compulsory, 1, 'question 1 is always compulsory');
  assert.ok(flags.slice(1).every((q) => q.is_compulsory === 0), 'the rest go in the choice');
  assert.ok(flags.every((q) => q.section_key === 'theory'));

  const plan = selection.sectionPlan(eid)[0];
  assert.equal(plan.toAnswer, 4);
  assert.equal(plan.quota, 3, 'the student chooses 3 of the 5 remaining');
});

test('a seven-question theory block answers 5: question 1 plus four chosen', () => {
  const eid = theoryExam(7, '__seven__');
  selection.applyDefaultTheoryRule(eid);
  assert.equal(rulesOf(eid)[0].answer_count, 5);
  assert.equal(selection.sectionPlan(eid)[0].quota, 4);
});

test('the printed question number picks the compulsory question, not insertion order', () => {
  const eid = newExam('__printed__');
  // The paper's question 1 is printed last in the file (extraction order can
  // drift); only source_number can say which question the paper forced.
  const nums = [5, 6, 7, 1, 8];
  nums.forEach((n, i) => {
    db.prepare(
      "INSERT INTO questions (exam_id, q_order, type, text, marks, source_number) VALUES (?,?,'theory',?,5,?)"
    ).run(eid, i + 1, `Theory ${n}`, n);
  });
  selection.applyDefaultTheoryRule(eid);
  const flags = flagsOf(eid);
  assert.deepEqual(flags.map((q) => q.is_compulsory), [0, 0, 0, 1, 0], 'printed question 1 is the compulsory one');
});

test('a block too short or too long is left exactly as it is', () => {
  for (const n of [4, 9]) {
    const eid = theoryExam(n, `__size_${n}__`);
    assert.equal(selection.applyDefaultTheoryRule(eid), 0, `${n} questions is not "about six or seven"`);
    assert.equal(rulesOf(eid).length, 0);
    assert.ok(flagsOf(eid).every((q) => q.is_compulsory === 1 && q.section_key === ''), 'nothing was touched');
  }
});

test('a block with a rule already, or a split already, is never overwritten', () => {
  // Ruled: the paper said "answer any 2", and the default must keep that.
  const ruled = theoryExam(6, '__ruled__');
  db.prepare(
    "INSERT INTO exam_sections (exam_id, section_key, title, instructions, position, answer_count) VALUES (?, 'theory','THEORY','',0,2)"
  ).run(ruled);
  assert.equal(selection.applyDefaultTheoryRule(ruled), 0);
  assert.equal(rulesOf(ruled)[0].answer_count, 2, 'the paper’s own rule survives');

  // Split: an import already marked questions 1 AND 2 compulsory. The default
  // may fill in a missing count, but it must not un-force a question.
  const split = theoryExam(6, '__split__');
  db.prepare('UPDATE questions SET is_compulsory = 0 WHERE exam_id = ? AND q_order > 2').run(split);
  assert.equal(selection.applyDefaultTheoryRule(split), 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ? AND is_compulsory = 1').get(split).c, 2);
});

test('objectives are never pulled into the theory block', () => {
  const eid = newExam('__mixed__');
  for (let i = 1; i <= 3; i++) {
    db.prepare(
      "INSERT INTO questions (exam_id, q_order, type, text, marks) VALUES (?,?,'objective',?,1)"
    ).run(eid, i, `Objective ${i}`);
  }
  for (let i = 1; i <= 6; i++) {
    db.prepare(
      "INSERT INTO questions (exam_id, q_order, type, text, marks) VALUES (?,?,'theory',?,5)"
    ).run(eid, i + 3, `Theory ${i}`);
  }
  selection.applyDefaultTheoryRule(eid);

  const objectives = db.prepare("SELECT * FROM questions WHERE exam_id = ? AND type = 'objective'").all(eid);
  assert.ok(objectives.every((q) => q.is_compulsory === 1 && q.section_key === ''), 'objectives answer everything, unsectioned');
  assert.equal(rulesOf(eid).length, 1, 'one rule, for the theory block only');
});

// ── AI generation ─────────────────────────────────────────────────────

const http = require('node:http');
const express = require('express');
const auth = require('../src/auth');
const api = require('../src/routes/api');

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

const objective = (i) => ({
  type: 'objective', text: `Gen objective ${i} about the harvest`, options: ['A', 'B'], correct_index: 0, marks: 1,
});
const theory = (i) => ({ type: 'theory', text: `Gen theory ${i} about the harvest`, marks: 5 });

before(async () => {
  token = auth.adminToken();
  const app = express();
  app.use(express.json());
  app.use('/api', api);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); });

test('an AI-generated exam gets the rule without anyone typing an instruction', async () => {
  const eid = newExam('__gen_route__', 'published');
  const real = ai.generateQuestions;
  ai.generateQuestions = async () => [
    objective(0), objective(1),
    ...Array.from({ length: 6 }, (_, i) => theory(i)),
  ];
  try {
    const res = await request('POST', `/api/exams/${eid}/generate`, {
      types: ['objective', 'theory'], objectiveCount: 2, theoryCount: 6,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  } finally {
    ai.generateQuestions = real;
  }

  const [rule] = rulesOf(eid);
  assert.equal(rule.section_key, 'theory');
  assert.equal(rule.answer_count, 4, '6 theory questions → question 1 + 3 chosen');
  const theoryRows = db.prepare("SELECT * FROM questions WHERE exam_id = ? AND type = 'theory' ORDER BY q_order").all(eid);
  assert.equal(theoryRows[0].is_compulsory, 1);
  assert.ok(theoryRows.slice(1).every((q) => q.is_compulsory === 0 && q.section_key === 'theory'));
});

test('pool variants join the block as options, never as compulsory questions', async () => {
  const eid = newExam('__gen_pool__', 'published');
  const real = ai.generateQuestions;
  ai.generateQuestions = async () => [
    ...Array.from({ length: 6 }, (_, i) => theory(i)),
    theory(90), theory(91), // the overflow: pool-only variants
  ];
  try {
    const res = await request('POST', `/api/exams/${eid}/generate`, {
      types: ['theory'], objectiveCount: 0, theoryCount: 6, pool: true, poolMultiplier: 2,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  } finally {
    ai.generateQuestions = real;
  }
  const pooled = db.prepare("SELECT * FROM question_pool WHERE exam_id = ? AND type = 'theory'").all(eid);
  assert.equal(pooled.length, 2, 'the two overflow questions went to the pool');
  assert.ok(pooled.every((q) => q.section_key === 'theory' && q.is_compulsory === 0),
    'a variant must never arrive compulsory — the paper never numbered it');
});

test('the one-click endpoint applies the rule to an exam made before it existed', async () => {
  const eid = theoryExam(7, '__existing__');
  db.prepare("UPDATE exams SET status = 'published' WHERE id = ?").run(eid);

  const applied = await request('POST', `/api/exams/${eid}/selection-default`);
  assert.equal(applied.status, 200);
  assert.equal(applied.body.applied, 1);
  assert.equal(applied.body.sections[0].answer_count, 5);
  assert.equal(applied.body.selection[0].quota, 4, 'the response carries the resolved plan for the card');

  // A live paper's rules are frozen — the students already in it are priced.
  db.prepare("UPDATE exams SET status = 'live' WHERE id = ?").run(eid);
  const refused = await request('POST', `/api/exams/${eid}/selection-default`);
  assert.equal(refused.status, 400);
});

// ── paper upload ──────────────────────────────────────────────────────

test('an upload whose paper never states a choice still gets the rule', async () => {
  const examId = newExam('__upload_no_rule__');
  const jobId = pdfImport.createJob(examId, 'paper.txt');
  const originalExtract = ai.extractQuestionsFromText;
  const originalScheme = marking.buildMarkingScheme;
  ai.extractQuestionsFromText = async () =>
    Array.from({ length: 7 }, (_, i) => ({ type: 'theory', number: i + 1, text: `Uploaded theory ${i + 1}`, marks: 5 }));
  marking.buildMarkingScheme = async () => ({ type: 'theory', model_answer: '', key_points: [] });
  try {
    await pdfImport.startJob(jobId, Buffer.from('unused'), {
      source: documentSrc.readExamSource(Buffer.from('unused'), 'paper.txt'),
    });
  } finally {
    ai.extractQuestionsFromText = originalExtract;
    marking.buildMarkingScheme = originalScheme;
  }
  assert.equal(pdfImport.getJob(jobId).status, 'done');

  const [rule] = rulesOf(examId);
  assert.equal(rule.section_key, 'paper-ii', 'a paper with no headings becomes one Paper II theory block');
  assert.equal(rule.title, 'PAPER II', 'and it is listed as the whole of Paper II');
  assert.equal(rule.answer_count, 5, '7 questions → question 1 + 4 chosen');
  const flags = flagsOf(examId);
  assert.equal(flags[0].is_compulsory, 1);
  assert.ok(flags.slice(1).every((q) => q.is_compulsory === 0 && q.section_key === 'paper-ii'));
});

test('an upload whose rules were read keeps the paper’s own instruction', async () => {
  const examId = newExam('__upload_with_rule__');
  const jobId = pdfImport.createJob(examId, 'paper.txt');
  const originalExtract = ai.extractQuestionsFromText;
  const originalScheme = marking.buildMarkingScheme;
  ai.extractQuestionsFromText = async () =>
    Array.from({ length: 6 }, (_, i) => ({
      type: 'theory', number: i + 1, section: 'SECTION B', text: `Essay ${i + 1}`, marks: 5,
      compulsory: i === 0,
      instructions: i === 0 ? 'Answer any THREE questions from this section.' : '',
    }));
  marking.buildMarkingScheme = async () => ({ type: 'theory', model_answer: '', key_points: [] });
  try {
    await pdfImport.startJob(jobId, Buffer.from('unused'), {
      source: documentSrc.readExamSource(Buffer.from('unused'), 'paper.txt'),
    });
  } finally {
    ai.extractQuestionsFromText = originalExtract;
    marking.buildMarkingScheme = originalScheme;
  }

  const [rule] = rulesOf(examId);
  assert.equal(rule.section_key, 'paper-ii-section-b', 'Paper II under the heading the paper printed');
  assert.equal(rule.title, 'PAPER II — SECTION B');
  assert.equal(rule.answer_count, 3, 'the paper’s own count wins over the default');
});

// ── what the student actually gets ────────────────────────────────────

test('the chat delivers objectives, then compulsory question 1, then the choice', async () => {
  const eid = newExam('__chat__', 'live');
  for (let i = 1; i <= 2; i++) {
    db.prepare(
      "INSERT INTO questions (exam_id, q_order, type, text, marks) VALUES (?,?,'objective',?,1)"
    ).run(eid, i, `Objective ${i}`);
  }
  for (let i = 1; i <= 6; i++) {
    db.prepare(
      "INSERT INTO questions (exam_id, q_order, type, text, marks) VALUES (?,?,'theory',?,5)"
    ).run(eid, i + 2, `Theory ${i}`);
  }
  selection.applyDefaultTheoryRule(eid);

  const studentId = db.prepare("INSERT INTO students (phone, name) VALUES ('233000000001','Ama')").run().lastInsertRowid;
  const session = examSvc.createSession(eid, studentId);
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
  const seq = examSvc.sessionQuestionSequence(row);

  // Objectives first (unchanged), then the theory block with its compulsory
  // question leading — the selector opens only at the first optional one.
  assert.deepEqual(
    seq.slice(0, 2).map((q) => q.type), ['objective', 'objective'],
    'objectives still come first'
  );
  const theorySeq = seq.slice(2);
  assert.equal(theorySeq.length, 6, 'every drawn question is still on offer until the student chooses');
  assert.equal(theorySeq[0].is_compulsory, 1, 'compulsory question 1 leads the block');
  assert.equal(
    selection.needsChoice(row, theorySeq[0]), false,
    'the compulsory question never raises the selector'
  );
  assert.equal(selection.needsChoice(row, theorySeq[1]), true, 'the first optional one does');

  // Choose three, confirm, and the paper is exactly what was owed.
  const optional = theorySeq.filter((q) => Number(q.is_compulsory) === 0).map((q) => q.q_order);
  selection.beginChoice(session.id, 'theory');
  selection.applySelection(session.id, 'theory', optional.slice(0, 3));
  const after = examSvc.sessionQuestionSequence(db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id));
  assert.equal(after.length, 6, '2 objectives + question 1 + the 3 chosen');
  assert.equal(
    db.prepare('SELECT paper_total FROM sessions WHERE id = ?').get(session.id).paper_total,
    2 * 1 + 4 * 5,
    'priced at the compulsory question plus the chosen ones — not the whole block'
  );
  assert.equal(selection.answerableCount(eid), 6, 'the invite promises 6 questions, and 6 arrive');
});
