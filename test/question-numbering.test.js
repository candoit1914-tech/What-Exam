'use strict';
// The number printed on a question must mean the same thing everywhere the
// student meets it: the WhatsApp bubble, the selector that opens mid-paper,
// the result message and the report. The paper numbers its sections, not its
// draw — objectives count 1..N and theory starts again at 1 — so a theory
// question is "theory question 1", never "question 41" because forty
// objectives came first. And within theory the paper's COMPULSORY question
// always leads, so the one question the student cannot refuse is also the
// first one they meet.
//
// Every test draws its own session: three objectives in SECTION A ahead of a
// selective SECTION B of theory, which is the shape a paper with a choice has.
require('./helpers/isolate');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const config = require('../src/config');
const exam = require('../src/services/exam');
const selection = require('../src/services/selection');
const results = require('../src/services/results');
const wa = require('../src/services/whatsapp');

const aStudent = () =>
  db.prepare('INSERT INTO students(phone) VALUES (?)')
    .run('233' + Math.random().toString(36).slice(2, 10)).lastInsertRowid;

/** [text, is_compulsory] for SECTION B, in the order the paper prints them. */
const THEORY_DEFAULT = [
  ['Explain the water cycle.', 1],
  ['Describe the rock cycle.', 0],
  ['Why do seasons change?', 0],
  ['Give two uses of copper.', 0],
];

function paperFixture(theoryRows = THEORY_DEFAULT) {
  const eid = db
    .prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Numbers',30,'live')")
    .run().lastInsertRowid;
  const section = db.prepare(
    'INSERT INTO exam_sections(exam_id,section_key,title,instructions,position,answer_count) VALUES (?,?,?,?,?,?)'
  );
  section.run(eid, 'sec-a', 'SECTION A', 'Answer ALL questions.', 0, 0);
  // SECTION B owes three of its four questions: the compulsory one plus the two
  // the student picks. answer_count counts the compulsory question, so the rule
  // is 3 rather than the 2 that are actually chosen.
  section.run(eid, 'sec-b', 'SECTION B', 'Answer any THREE questions.', 1, 3);

  const pool = db.prepare(
    'INSERT INTO question_pool(exam_id,type,text,correct_answer,marks,is_compulsory,section_key) VALUES (?,?,?,?,?,?,?)'
  );
  const objectives = ['What is photosynthesis?', 'Name the capital of Ghana.', 'Define osmosis.']
    .map((text) => pool.run(eid, 'objective', text, 'A', 1, 1, 'sec-a').lastInsertRowid);
  const theory = theoryRows
    .map(([text, comp]) => pool.run(eid, 'theory', text, '', 5, comp, 'sec-b').lastInsertRowid);

  const sid = db
    .prepare('INSERT INTO sessions(exam_id,student_id) VALUES (?,?)')
    .run(eid, aStudent()).lastInsertRowid;
  const ins = db.prepare(
    'INSERT INTO session_questions(session_id,question_id,q_order,is_selected,section_key) VALUES (?,?,?,?,?)'
  );
  objectives.forEach((pid, i) => ins.run(sid, pid, i + 1, 1, 'sec-a'));
  theory.forEach((pid, i) => ins.run(sid, pid, objectives.length + i + 1, 1, 'sec-b'));

  const compulsoryTheory = theory[theoryRows.findIndex(([, comp]) => comp === 1)];
  return { eid, sid, objectives, theory, compulsoryTheory };
}

const answerFor = (sid, questionId, qOrder, answerText, correct, marks, max) =>
  db.prepare(
    `INSERT INTO answers(session_id,question_id,q_order,answer_text,is_correct,marks_awarded,max_marks)
     VALUES (?,?,?,?,?,?,?)`
  ).run(sid, questionId, qOrder, answerText, correct, marks, max);

/** Run one send* call with the WhatsApp layer captured instead of sent. */
async function capturing(which, fn) {
  const sent = [];
  const original = wa[which];
  wa[which] = async (...args) => { sent.push(args); };
  try {
    await fn();
  } finally {
    wa[which] = original;
  }
  return sent;
}

test('objectives count from 1 and theory counts from 1 again', () => {
  const { sid, objectives, theory } = paperFixture();
  const numbers = exam.questionDisplayNumbers(sid);

  objectives.forEach((id, i) => assert.equal(numbers.get(id), i + 1, `objective ${i + 1}`));
  theory.forEach((id, i) => assert.equal(numbers.get(id), i + 1, `theory ${i + 1}`));
  assert.notEqual(
    numbers.get(theory[0]),
    objectives.length + 1,
    'theory never continues where the objectives stopped'
  );
});

test('a question the student did not choose leaves no gap behind it', () => {
  const { sid, objectives } = paperFixture();
  db.prepare('UPDATE session_questions SET is_selected = 0 WHERE session_id = ? AND question_id = ?')
    .run(sid, objectives[1]);

  const numbers = exam.questionDisplayNumbers(sid);
  assert.equal(numbers.has(objectives[1]), false, 'a dropped question occupies no number');
  assert.equal(numbers.get(objectives[2]), 2, 'the next objective takes its place');
  assert.equal(numbers.get(objectives[0]), 1, 'nothing ahead of it moved');
});

test('the bubble a student receives carries the number the map promises', () => {
  const { sid, objectives, theory } = paperFixture();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  const seq = exam.sessionQuestionSequence(session);
  const numbers = exam.questionDisplayNumbers(sid);
  const bubbleFor = (q) =>
    exam.buildQuestionBubbles({ title: 'Numbers' }, q, seq, seq.indexOf(q), session).pop();

  assert.equal(seq.length, objectives.length + theory.length, 'every drawn question is presented');
  for (const q of seq) {
    assert.match(
      bubbleFor(q),
      new RegExp(`^\\*QUESTION ${numbers.get(q.id)}\\*\\n\\n`),
      `question id ${q.id} is numbered ${numbers.get(q.id)} on its bubble`
    );
  }
  assert.match(bubbleFor(seq[0]), /^\*QUESTION 1\*\n\nWhat is photosynthesis\?/, 'the first objective is QUESTION 1');
  const firstTheory = seq.find((q) => q.id === theory[0]);
  assert.match(bubbleFor(firstTheory), /^\*QUESTION 1\*\n\nExplain the water cycle\./, 'theory restarts at 1');
});

test('a template exam with no drawn pool numbers in presentation order', () => {
  const eid = db
    .prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Template',30,'live')")
    .run().lastInsertRowid;
  const insert = db.prepare('INSERT INTO questions(exam_id,q_order,type,text) VALUES (?,?,?,?)');
  const printedFirst = insert.run(eid, 1, 'theory', 'Th one').lastInsertRowid;
  const second = insert.run(eid, 2, 'objective', 'Ob one').lastInsertRowid;
  const third = insert.run(eid, 3, 'theory', 'Th two').lastInsertRowid;
  const fourth = insert.run(eid, 4, 'objective', 'Ob two').lastInsertRowid;
  const sid = db
    .prepare('INSERT INTO sessions(exam_id,student_id) VALUES (?,?)')
    .run(eid, aStudent()).lastInsertRowid;

  const numbers = exam.questionDisplayNumbers(sid);
  assert.equal(numbers.get(second), 1, 'objectives are delivered first, so they take 1');
  assert.equal(numbers.get(fourth), 2);
  assert.equal(numbers.get(printedFirst), 1, 'theory restarts even though it was printed first');
  assert.equal(numbers.get(third), 2);
});

test('the selector names the compulsory question by the number on its bubble', async () => {
  const { sid } = paperFixture();
  const sent = await capturing('sendInteractiveList', () =>
    selection.sendSelector('23300000001', sid, 'sec-b')
  );

  assert.equal(sent.length, 1, 'the selector was shown');
  const body = sent[0][2];
  assert.match(
    body,
    /Compulsory — you will answer Q1\./,
    'theory question 1, not draw position 4 — the student never sees 4'
  );
  assert.doesNotMatch(body, /\bQ4\b/, 'the raw draw position must not leak into the selector');
});

test('the compulsory question is theory question 1, whatever the paper printed it as', async () => {
  // The paper prints its compulsory question BEHIND two it lets the student
  // choose between. The rule is that the forced question leads its section, so
  // the student always meets it first: its number is fixed before any choice
  // can move anything behind it, which is what lets the selector NAME it
  // instead of quoting its text.
  const theoryRows = [
    ['Explain the water cycle.', 0],
    ['Describe the rock cycle.', 0],
    ['Why do seasons change?', 1],
    ['Give two uses of copper.', 0],
  ];
  const { sid, theory, objectives } = paperFixture(theoryRows);

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  const seq = exam.sessionQuestionSequence(session);
  const theorySeq = seq.filter((q) => q.type === 'theory');
  assert.equal(
    theorySeq[0].id, theory[2],
    'the compulsory question is presented first, after nothing but the objectives'
  );

  const numbers = exam.questionDisplayNumbers(sid);
  assert.equal(numbers.get(theory[2]), 1, 'so it carries theory question 1');
  assert.equal(numbers.get(theory[0]), 2, 'the printed first question moves back a place');
  assert.equal(numbers.get(objectives[0]), 1, 'the objectives keep their own count');

  const sent = await capturing('sendInteractiveList', () =>
    selection.sendSelector('23300000001', sid, 'sec-b')
  );

  const body = sent[0][2];
  assert.match(
    body,
    /Compulsory — you will answer Q1\./,
    'the number is promised because nothing the student replies can move it'
  );
  assert.doesNotMatch(body, /\bQ6\b/, 'the raw draw position must not leak into the selector');
});

test('a paid paper opens with the same choice the chat opens with', () => {
  // The approved start template has no button, so the picker travels as one
  // block of text. It must say exactly what the chat says — a student who paid
  // meets the same compulsory question and the same quota sentence as one who
  // did not, rather than a shortened copy that has already drifted from it.
  const { sid } = paperFixture();
  const text = selection.choiceText(sid, 'sec-b');
  assert.match(text, /Compulsory — you will answer Q1\./);
  assert.match(text, /You must choose exactly 2 of the 3 questions below\./);
  assert.match(text, /That is 3 questions in total here\./);
  assert.match(text, /☐ 1\. /, 'the card travels with it');
  assert.match(text, /Reply with the numbers you choose, e.g. 1,3 — then CONTINUE\./);
});

test('a section that owes no choice has no text to send', () => {
  const { sid } = paperFixture();
  assert.equal(
    selection.choiceText(sid, 'sec-a'), '',
    'SECTION A is answered in full, so there is nothing to ask about it'
  );
});

test('the result message marks theory by section, not by draw position', async () => {
  const { sid, objectives, theory } = paperFixture();
  answerFor(sid, objectives[0], 1, 'A', 1, 1, 1);
  answerFor(sid, theory[0], 4, 'Because rain.', 1, 5, 5);

  const originalKey = config.exam.sendAnswerKey;
  config.exam.sendAnswerKey = true;
  let sent;
  try {
    sent = await capturing('sendText', () => results.sendResultMessage(sid, '23300000001', 'completed'));
  } finally {
    config.exam.sendAnswerKey = originalKey;
  }

  assert.equal(sent.length, 1, 'the result goes out as one message');
  const msg = sent[0][1];
  assert.match(msg, /Q1\. 5\/5/, 'theory starts at Q1, not at the objective count');
  assert.doesNotMatch(msg, /Q4\./, 'the draw position never reaches the student');
  assert.match(msg, /^1\. ✅ A → A$/m, 'the answer key numbers objectives from 1 too');
});

test('the selector echoes the numbers the student typed, not the draw position', async () => {
  const { sid } = paperFixture();
  db.prepare("UPDATE sessions SET selection_section = 'sec-b', selection_state = 'selecting' WHERE id = ?")
    .run(sid);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(session.student_id);

  // The complete card goes out as the Continue button's message, an incomplete
  // one as plain text — capture both so the echo is asserted on whichever the
  // count produced, without a real gateway call in between.
  const sent = [];
  const originals = { sendText: wa.sendText, sendInteractiveButtons: wa.sendInteractiveButtons };
  wa.sendText = async (...args) => { sent.push(['text', ...args]); };
  wa.sendInteractiveButtons = async (...args) => { sent.push(['buttons', ...args]); };
  try {
    await selection.handleReply(session, student, '1,3', {});
  } finally {
    Object.assign(wa, originals);
  }

  assert.equal(sent.length, 1, 'the echo is one message');
  const echo = sent[0][2];
  assert.match(
    echo,
    /☑ 1\.[\s\S]*☑ 3\./,
    'the reply protocol speaks in listing numbers, so the echo does too'
  );
  assert.match(echo, /\*Selected: 2\/2\*/, 'and it carries the live count');
  assert.doesNotMatch(echo, /Q5|Q7/, 'a draw position the student never saw must not appear');
});

test('the report cards use the same numbers as the bubbles', () => {
  const { sid, objectives, theory } = paperFixture();
  answerFor(sid, objectives[0], 1, 'A', 1, 1, 1);
  answerFor(sid, theory[0], 4, 'Because rain.', 1, 5, 5);

  const { html } = results.reportHTML(sid);
  const shown = [...html.matchAll(/class="q-num">(\d+)</g)].map((m) => Number(m[1]));
  assert.deepEqual(shown, [1, 1], 'objective 1 and theory 1 — the report follows the paper');
});
