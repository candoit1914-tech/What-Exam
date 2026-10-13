'use strict';
// A paper that carries both question types is worth 100 points: theory — the
// compulsory question plus the ones the student chose — is worth 60 of them and
// objectives 40, whatever marks the paper prints beside each question. The
// marks stay the paper's own currency everywhere per-question; the weighting
// only decides how the two halves become ONE number, which is what every
// surface (result message, certificate, report, roster) publishes.
//
// A paper with only ONE type is that type in full, so every existing
// single-type exam grades exactly as it did before this rule existed.
require('./helpers/isolate');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const config = require('../src/config');
const examSvc = require('../src/services/exam');
const selection = require('../src/services/selection');
const results = require('../src/services/results');
const wa = require('../src/services/whatsapp');

const studentId = db.prepare('INSERT INTO students(phone) VALUES (?)')
  .run('233000000099').lastInsertRowid;

/** spec: [{ type, marks, compulsory, section }] */
function paperExam(spec) {
  const eid = db
    .prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Weights',30,'live')")
    .run().lastInsertRowid;
  spec.forEach((q, i) => {
    db.prepare(
      `INSERT INTO questions(exam_id,q_order,type,text,marks,is_compulsory,section_key)
       VALUES (?,?,?,?,?,?,?)`
    ).run(eid, i + 1, q.type || 'theory', `Q${i + 1}`, q.marks ?? 5,
          q.compulsory === false ? 0 : 1, q.section || '');
  });
  return eid;
}

function rule(eid, key, title, count, position = 0) {
  db.prepare(
    'INSERT INTO exam_sections(exam_id,section_key,title,instructions,position,answer_count) VALUES (?,?,?,?,?,?)'
  ).run(eid, key, title, 'Answer any THREE questions', position, count);
}

/** Record an answer against a drawn question, by the number the student saw. */
function answerQ(sid, qOrder, awarded, max) {
  const row = db
    .prepare('SELECT question_id FROM session_questions WHERE session_id = ? AND q_order = ?')
    .get(sid, qOrder);
  db.prepare(
    `INSERT INTO answers(session_id,question_id,q_order,answer_text,marks_awarded,max_marks,marked_by)
     VALUES (?,?,?,'x',?,?,'auto')`
  ).run(sid, row.question_id, qOrder, awarded, max);
}

/** The type of each drawn question, keyed on session q_order. */
function typesOf(sid) {
  const out = new Map();
  for (const r of db.prepare(
    `SELECT sq.q_order, qp.type FROM session_questions sq
      JOIN question_pool qp ON qp.id = sq.question_id
     WHERE sq.session_id = ?`
  ).all(sid)) out.set(r.q_order, r.type);
  return out;
}

/** Every drawn question of one type, in paper order. */
function ordersOf(sid, type) {
  const types = typesOf(sid);
  return [...types.entries()].filter(([, t]) => t === type).map(([q]) => q);
}

async function capturing(fn) {
  const sent = [];
  const original = wa.sendText;
  wa.sendText = async (phone, text) => { sent.push(text); return {}; };
  try { await fn(); } finally { wa.sendText = original; }
  return sent;
}

test('a paper with both types is scored out of 100: theory 60, objectives 40', () => {
  // Theory 30 marks, objectives 20: the marks do NOT split 60/40, and they do
  // not have to — the weighting is what makes the halves add up to 100.
  const eid = paperExam([
    { type: 'theory', marks: 10 }, { type: 'theory', marks: 10 }, { type: 'theory', marks: 10 },
    { type: 'objective', marks: 10 }, { type: 'objective', marks: 10 },
  ]);
  const sid = examSvc.createSession(eid, studentId).id;
  for (const q of ordersOf(sid, 'theory')) answerQ(sid, q, 10, 10);
  for (const q of ordersOf(sid, 'objective')) answerQ(sid, q, 5, 10);

  const r = results.computeForSession(sid);
  assert.equal(r.weighting.theory.weight, 60, 'theory is worth 60 of the 100');
  assert.equal(r.weighting.objective.weight, 40, 'objectives are worth the other 40');
  assert.equal(r.weighting.theory.points, 60, 'a perfect theory half is the whole 60');
  assert.equal(r.weighting.objective.points, 20, 'half the objectives is half of 40');
  assert.equal(r.percentage, 80, '60 + 20');
  assert.equal(r.score, 80, 'score and percentage are the same number on a 100-point paper');
  assert.equal(r.totalMarks, 100, 'the exam is out of 100');
  assert.equal(r.score / r.totalMarks * 100, r.percentage, 'the two can never disagree');
});

test('a weak theory half cannot be rescued by a perfect objective half', () => {
  const eid = paperExam([
    { type: 'theory', marks: 10 }, { type: 'theory', marks: 10 },
    { type: 'objective', marks: 10 }, { type: 'objective', marks: 10 },
  ]);
  db.prepare('UPDATE exams SET pass_percentage = 50 WHERE id = ?').run(eid);
  const sid = examSvc.createSession(eid, studentId).id;
  for (const q of ordersOf(sid, 'theory')) answerQ(sid, q, 0, 10);
  for (const q of ordersOf(sid, 'objective')) answerQ(sid, q, 10, 10);

  const r = results.computeForSession(sid);
  assert.equal(r.percentage, 40, 'objectives can never be more than their 40 points');
  assert.equal(r.passed, false, 'a 40% paper fails a 50% bar even with every objective right');
});

test('a theory-only paper is its own percentage, exactly as before', () => {
  const eid = paperExam([{ marks: 5 }, { marks: 5 }, { marks: 5 }, { marks: 5 }]);
  const sid = examSvc.createSession(eid, studentId).id;
  answerQ(sid, 1, 5, 5);
  answerQ(sid, 2, 5, 5);

  const r = results.computeForSession(sid);
  assert.equal(r.weighting, null, 'there is no second half to share the points with');
  assert.equal(r.percentage, 50, '2 of 4 marks, unchanged by any weighting');
  assert.equal(r.score, 10, 'raw marks stay the currency of a single-type paper');
  assert.equal(r.totalMarks, 20);
});

test('an objective-only paper is its own percentage, exactly as before', () => {
  const eid = paperExam([
    { type: 'objective', marks: 5 }, { type: 'objective', marks: 5 },
    { type: 'objective', marks: 5 }, { type: 'objective', marks: 5 },
  ]);
  const sid = examSvc.createSession(eid, studentId).id;
  answerQ(sid, 1, 5, 5);
  answerQ(sid, 2, 0, 5);

  const r = results.computeForSession(sid);
  assert.equal(r.weighting, null);
  assert.equal(r.percentage, 25);
  assert.equal(r.score, 5);
  assert.equal(r.totalMarks, 20);
});

test('theory is marked on the compulsory question and the chosen ones, and nothing else', () => {
  // One compulsory theory question and three to choose one from: theory is
  // worth the compulsory 10 plus ONE pick, never all four.
  const eid = paperExam([
    { type: 'theory', marks: 10, compulsory: true, section: 'b' },
    { type: 'theory', marks: 10, compulsory: false, section: 'b' },
    { type: 'theory', marks: 10, compulsory: false, section: 'b' },
    { type: 'theory', marks: 10, compulsory: false, section: 'b' },
    { type: 'objective', marks: 10, section: 'a' },
    { type: 'objective', marks: 10, section: 'a' },
  ]);
  rule(eid, 'b', 'SECTION B', 2, 1);
  const sid = examSvc.createSession(eid, studentId).id;
  const optional = selection.sessionPlan(sid).find((s) => s.section_key === 'b').optional
    .map((q) => q.q_order);
  selection.applySelection(sid, 'b', [optional[0]]);

  const types = typesOf(sid);
  const owed = db
    .prepare(
      `SELECT sq.q_order FROM session_questions sq
         JOIN question_pool qp ON qp.id = sq.question_id
        WHERE sq.session_id = ? AND sq.is_selected = 1 AND qp.type = 'theory'
        ORDER BY sq.q_order`
    )
    .all(sid)
    .map((r) => r.q_order);
  assert.equal(owed.length, 2, 'the compulsory question plus the one pick');
  assert.ok(owed.every((q) => types.get(q) === 'theory'));

  // Answer everything owed, plus a question the student refused — which must
  // not be able to touch the score from outside the paper.
  for (const q of owed) answerQ(sid, q, 10, 10);
  answerQ(sid, optional[1], 10, 10);
  for (const q of ordersOf(sid, 'objective')) answerQ(sid, q, 10, 10);

  const r = results.computeForSession(sid);
  assert.equal(r.weighting.theory.total, 20, 'compulsory 10 + the chosen 10, not the pool of 40');
  assert.equal(r.weighting.theory.awarded, 20, 'the refused question is not part of this paper');
  assert.equal(r.percentage, 100, 'everything this student owes, answered');
});

test('the result message shows where the 100 points came from', async () => {
  const eid = paperExam([
    { type: 'theory', marks: 10 }, { type: 'theory', marks: 10 },
    { type: 'objective', marks: 10 }, { type: 'objective', marks: 10 },
  ]);
  db.prepare("UPDATE exams SET status = 'live' WHERE id = ?").run(eid);
  const sid = examSvc.createSession(eid, studentId).id;
  for (const q of ordersOf(sid, 'theory')) answerQ(sid, q, 5, 10);
  for (const q of ordersOf(sid, 'objective')) answerQ(sid, q, 10, 10);

  const sent = await capturing(() => results.sendResultMessage(sid, '233000000099', 'completed'));
  const msg = sent[0];
  assert.match(msg, /Score: \*70 \/ 100\*/, 'the paper the student is told they sat');
  assert.match(msg, /Percentage: \*70%\*/, '30 of the 60 theory points, all 40 objective points');
  assert.match(msg, /Theory: 10\/20 marks → \*30\/60\*/);
  assert.match(msg, /Objectives: 20\/20 marks → \*40\/40\*/);
});

test('the report states the split next to the total', () => {
  const eid = paperExam([
    { type: 'theory', marks: 10 }, { type: 'objective', marks: 10 },
  ]);
  const sid = examSvc.createSession(eid, studentId).id;
  answerQ(sid, ordersOf(sid, 'theory')[0], 10, 10);
  answerQ(sid, ordersOf(sid, 'objective')[0], 0, 10);

  const { html } = results.reportHTML(sid);
  assert.match(html, /this paper is out of 100/);
  assert.match(html, /theory is worth 60 points/);
  assert.match(html, /objectives\s+40/);
  assert.match(html, /theory is worth 60 points\s*\(10\/10 marks → 60\)/, 'the note shows the marks behind the points');
});

test('the intro promises the 60/40 split before the first question, and only for a mixed paper', () => {
  const mixed = paperExam([
    { type: 'theory', marks: 10 }, { type: 'objective', marks: 10 },
  ]);
  const mixedRow = db.prepare('SELECT * FROM exams WHERE id = ?').get(mixed);
  const intro = examSvc.formatExamIntro(mixedRow, 2);
  assert.match(intro, /theory questions are worth \*60 points\* and objectives \*40 points\*/);
  assert.match(intro, /add up to \*100\*/);

  const theoryOnly = paperExam([{ marks: 10 }, { marks: 10 }]);
  const theoryRow = db.prepare('SELECT * FROM exams WHERE id = ?').get(theoryOnly);
  assert.doesNotMatch(
    examSvc.formatExamIntro(theoryRow, 2),
    /theory questions are worth/,
    'a single-type paper never promises a split it does not have'
  );
});

test('the weights can be rebalanced without touching the marking', () => {
  const original = { ...config.exam };
  config.exam.theoryWeight = 0.7;
  config.exam.objectiveWeight = 0.3;
  try {
    const eid = paperExam([
      { type: 'theory', marks: 10 }, { type: 'objective', marks: 10 },
    ]);
    const sid = examSvc.createSession(eid, studentId).id;
    answerQ(sid, ordersOf(sid, 'theory')[0], 10, 10);
    answerQ(sid, ordersOf(sid, 'objective')[0], 0, 10);
    const r = results.computeForSession(sid);
    assert.equal(r.percentage, 70, 'a perfect theory half now carries 70 points');
    assert.equal(r.weighting.theory.points, 70);
    assert.equal(r.weighting.objective.points, 0);
  } finally {
    Object.assign(config.exam, original);
  }
});
