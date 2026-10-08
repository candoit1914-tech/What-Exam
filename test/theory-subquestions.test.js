'use strict';
// A sub-question is not a question. It is part of the question that carries
// its number — (a) under 1 is 1a — so it must be folded back under that number
// at extraction, stored with it, carried through the pool a drawn attempt
// reads (along with the figure it is read from), and printed inside the
// parent's own bubble as 1a, 1b, 1c. Each stage has a test here, because each
// stage losing them looks identical from the chat: the parts simply arrive
// numbered 2, 3, 4 as questions of their own.
require('./helpers/isolate');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const ai = require('../src/services/ai');
const exam = require('../src/services/exam');
const wa = require('../src/services/whatsapp');
const marking = require('../src/services/marking');
const pdfImport = require('../src/services/pdfImport');

const nowZ = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const digits = (n) => Math.floor(Math.random() * 10 ** n).toString().padStart(n, '0');

// ── extraction: the parts are folded back under their number ───────────

test('the limbs of a numbered question are folded back under it', () => {
  const out = ai.mergeSubQuestions([
    { type: 'theory', number: 1, section: 'SECTION B', text: 'Explain the water cycle.', marks: 5 },
    { type: 'theory', number: 1, section: 'SECTION B', text: '(a) Define transpiration.', marks: 2 },
    { type: 'theory', number: 1, section: 'SECTION B', text: '(b) Name two clouds.', marks: 3 },
    { type: 'theory', number: 2, section: 'SECTION B', text: 'Describe infiltration.', marks: 6 },
  ]);
  assert.equal(out.length, 2, 'the parts are never questions of their own');
  assert.deepEqual(
    out[0].follow_ups.map((f) => f.text),
    ['Define transpiration.', 'Name two clouds.'],
    'the label is taken off the text: the numbering belongs to the delivery'
  );
  assert.equal(out[0].follow_ups[1].marks, 3, 'each part keeps its own mark allocation');
  assert.equal(out[0].marks, 5, '2 + 3 = 5, the worth the paper already gave the question');
  assert.equal(out[1].text, 'Describe infiltration.');
  assert.equal(out[1].follow_ups, undefined, 'the next question opens a run of its own, not this one');
});

test('roman limbs fold too', () => {
  const out = ai.mergeSubQuestions([
    { type: 'theory', number: 4, text: 'State the modes of dressing.', marks: 6 },
    { type: 'theory', number: 4, text: '(i) the mode of dressing', marks: 2 },
    { type: 'theory', number: 4, text: '(ii) the method of cutting', marks: 2 },
    { type: 'theory', number: 4, text: '(iii) the method of joining', marks: 2 },
  ]);
  assert.equal(out.length, 1, 'a paper may limb its parts in roman numerals');
  assert.deepEqual(
    out[0].follow_ups.map((f) => f.text),
    ['the mode of dressing', 'the method of cutting', 'the method of joining']
  );
});

test('lettered questions with no number above them stay questions', () => {
  // A comprehension passage numbers its questions 1–5 and limbs them (a)–(f),
  // with nothing numbered above them. Collapsing those would hand the student
  // one message to answer a whole passage in.
  const out = ai.mergeSubQuestions([
    { type: 'theory', number: 1, text: '(a) What is the main idea of the passage?' },
    { type: 'theory', number: 1, text: '(b) Why does the writer mention rain?' },
  ]);
  assert.equal(out.length, 2, 'no numbered question opened a run, so nothing folds');
  assert.equal(out[0].follow_ups, undefined);
});

test('a figure carried by one limb travels with the question it belongs to', () => {
  // The photo is what the parts are read from. If it stays on the limb, the
  // parent question arrives asking the student to study something they never
  // saw — which is exactly a follow-up question that cannot be answered.
  const out = ai.mergeSubQuestions([
    { type: 'theory', number: 1, text: 'Study the diagram and answer (a) and (b).', image: '' },
    { type: 'theory', number: 1, text: '(a) Name the process shown.', image: 'fig-1.png', markerIndex: 2 },
    { type: 'theory', number: 1, text: '(b) State one effect of it.', marks: 4 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].image, 'fig-1.png', 'the figure arrives with the parts that need it');
  assert.equal(out[0].markerIndex, 2);
  assert.equal(out[0].follow_ups.length, 2);
});

test('a question is worth at least what its parts add up to', () => {
  const out = ai.mergeSubQuestions([
    { type: 'theory', number: 1, text: 'Explain evaporation.', marks: 2 },
    { type: 'theory', number: 1, text: '(a) Define it.', marks: 4 },
    { type: 'theory', number: 1, text: '(b) Give one example.', marks: 4 },
  ]);
  assert.equal(out[0].marks, 8, 'the student answers all of it in one message, so it is marked out of all of it');
});

test('a limb run breaks the moment the next entry is a question', () => {
  const out = ai.mergeSubQuestions([
    { type: 'theory', number: 1, text: 'Explain the water cycle.', marks: 5 },
    { type: 'theory', number: 1, text: '(a) Define transpiration.', marks: 2 },
    { type: 'theory', number: 2, text: 'Describe infiltration.', marks: 6 },
    { type: 'theory', number: 2, text: '(a) Define percolation.', marks: 3 },
  ]);
  assert.equal(out.length, 2, 'both questions keep their own limb');
  assert.deepEqual(out[0].follow_ups.map((f) => f.text), ['Define transpiration.']);
  assert.deepEqual(out[1].follow_ups.map((f) => f.text), ['Define percolation.']);
});

test('follow_ups survive every shape the model can hand them over in', () => {
  assert.deepEqual(
    ai.normalizeFollowUps([{ text: ' Define it. ', marks: 2 }]),
    [{ text: 'Define it.', marks: 2, difficulty: 'medium' }],
    'trimmed, defaulted and never rejected'
  );
  assert.equal(ai.normalizeFollowUps('[{"text":"Part","marks":1}]').length, 1, 'a JSON string parses');
  assert.deepEqual(ai.normalizeFollowUps('not json'), [], 'malformed is dropped, never thrown');
  assert.deepEqual(ai.normalizeFollowUps(undefined), []);
  assert.deepEqual(ai.normalizeFollowUps({ text: 'not a list' }), [], 'a non-array is not a list of parts');
  assert.deepEqual(ai.normalizeFollowUps([{ text: '' }]), [], 'a blank part is not a part');
});

test('the extraction pipeline hands back limbs folded under their question', async () => {
  const original = ai.chatJSON;
  ai.chatJSON = async () => ({
    questions: [
      { type: 'theory', number: 1, section: 'SECTION B', text: 'Explain photosynthesis.', marks: 4 },
      { type: 'theory', number: 1, section: 'SECTION B', text: '(a) Define the term.', marks: 2 },
      { type: 'theory', number: 1, section: 'SECTION B', text: '(b) Give the word equation.', marks: 4 },
      { type: 'theory', number: 2, section: 'SECTION B', text: 'Give two uses of copper.', marks: 6 },
    ],
  });
  try {
    const out = await ai.extractQuestionsFromText(
      'SECTION B\n\n1. Explain photosynthesis.\n(a) Define the term.\n(b) Give the word equation.\n\n2. Give two uses of copper.'
    );
    assert.equal(out.length, 2, 'the parts never reach the caller as questions');
    assert.deepEqual(
      out[0].follow_ups.map((f) => f.text),
      ['Define the term.', 'Give the word equation.']
    );
    assert.equal(out[1].follow_ups, undefined);
  } finally {
    ai.chatJSON = original;
  }
});

// ── delivery: a drawn attempt carries the limbs and their figure ───────

test('a drawn attempt delivers the limbs and the figure they are read from', async () => {
  // The decoy exists to push the two id sequences apart: questions and
  // question_pool count separately, so a pool row's own id routinely belongs to
  // a different question. Reading figure bubbles by the pool row's id is what
  // made them go missing.
  const decoyExam = db
    .prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Decoy',30,'live')")
    .run().lastInsertRowid;
  db.prepare(
    "INSERT INTO questions(exam_id,q_order,type,text,marks,section_key) VALUES (?,1,'theory','Decoy question.',5,'')"
  ).run(decoyExam);

  const eid = db
    .prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Photos',30,'live')")
    .run().lastInsertRowid;
  const studentId = db
    .prepare('INSERT INTO students(phone) VALUES (?)')
    .run('2330' + digits(8)).lastInsertRowid;
  const qid = db
    .prepare(
      `INSERT INTO questions(exam_id,q_order,type,text,marks,follow_ups,section_key,is_compulsory)
       VALUES (?,1,'theory',?,5,?,'',1)`
    )
    .run(eid, 'Study the diagram and answer.', JSON.stringify([
      { text: 'Name the process.', marks: 2 },
      { text: 'State one effect.', marks: 3 },
    ])).lastInsertRowid;
  db.prepare('INSERT INTO question_images(question_id,position,image,kind) VALUES (?,?,?,?)')
    .run(qid, 0, 'fig-diagram.png', 'math');

  const session = exam.createSession(eid, studentId);

  // What the draw wrote is the first thing that can go wrong: a session reads
  // question_pool, and the template row it came from is never looked at again.
  const poolRow = db.prepare('SELECT id, template_id, follow_ups FROM question_pool WHERE exam_id = ?').get(eid);
  assert.ok(poolRow, 'the template question was copied into the pool');
  assert.equal(JSON.parse(poolRow.follow_ups).length, 2, 'the limbs are not lost at draw time');
  assert.equal(poolRow.template_id, qid, 'the pool row points at the question whose figure it shows');
  assert.notEqual(poolRow.id, qid, 'the two id sequences really are apart, so the pool id cannot be used');
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM question_images WHERE question_id = ?').get(poolRow.id).c,
    0,
    'nothing was copied into the pool row: the pool id belongs to no question here'
  );

  const texts = [];
  const images = [];
  const originalText = wa.sendText;
  const originalImage = wa.sendImage;
  wa.sendText = async (...args) => { texts.push(args); };
  wa.sendImage = async (...args) => { images.push(args); };
  try {
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
    await exam.sendQuestionTo(session, student);
  } finally {
    wa.sendText = originalText;
    wa.sendImage = originalImage;
  }

  const body = texts.map((t) => t[1]).join('\n');
  assert.match(body, /\*QUESTION 1\*/, 'the parent keeps its number');
  assert.match(body, /\*1a\)\* Name the process\./, 'the first limb is 1a, under question 1');
  assert.match(body, /\*1b\)\* State one effect\./, 'and the second is 1b in the same bubble');
  assert.doesNotMatch(body, /\*QUESTION 2\*/, 'a limb is never delivered as a question of its own');
  assert.equal(images.length, 1, 'the figure goes out above the question it belongs to');
  assert.match(images[0][1], /fig-diagram\.png$/, 'the file the parts are read from');
});

test('a pool row copied before the column existed still shows its figure', async () => {
  // Existing pools have template_id NULL. The old lookup keyed off the pool
  // row's own id, so those rows keep working exactly as they did.
  const eid = db
    .prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Legacy',30,'live')")
    .run().lastInsertRowid;
  const studentId = db
    .prepare('INSERT INTO students(phone) VALUES (?)')
    .run('2330' + digits(8)).lastInsertRowid;
  const poolQid = db
    .prepare(
      "INSERT INTO question_pool(exam_id,type,text,marks,image,follow_ups) VALUES (?, 'theory', 'Legacy question.', 5, '', '[]')"
    ).run(eid).lastInsertRowid;
  // A position no other test in this file uses: question_images is keyed on
  // (question_id, position), and ids from the two tables are free to meet.
  db.prepare('INSERT INTO question_images(question_id,position,image,kind) VALUES (?,?,?,?)')
    .run(poolQid, 50, 'legacy-bubble.png', 'math');
  const sid = db
    .prepare('INSERT INTO sessions(exam_id,student_id,started_at) VALUES (?,?,?)')
    .run(eid, studentId, nowZ()).lastInsertRowid;
  db.prepare('INSERT INTO session_questions(session_id,question_id,q_order) VALUES (?,?,?)').run(sid, poolQid, 1);
  assert.equal(
    db.prepare('SELECT template_id FROM question_pool WHERE id = ?').get(poolQid).template_id,
    null
  );

  const images = [];
  const originalText = wa.sendText;
  const originalImage = wa.sendImage;
  wa.sendText = async () => {};
  wa.sendImage = async (...args) => { images.push(args); };
  try {
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
    await exam.sendQuestionTo(db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid), student);
  } finally {
    wa.sendText = originalText;
    wa.sendImage = originalImage;
  }
  // Not a count: another question's bubbles can share this id (that sharing is
  // the bug template_id exists to end), so the assertion is that the row under
  // the pool id was still reached.
  assert.ok(
    images.some((img) => /legacy-bubble\.png$/.test(img[1])),
    'the fallback still finds the bubbles under the pool row id'
  );
});

// ── the section rule that used to be silently dropped ──────────────────

test('the "answer any N" count is read from every wording a paper uses', () => {
  const cases = [
    ['Answer any THREE questions in this section', 3],
    ['Answer 2 questions from this section.', 2],
    ['Answer all FOUR questions', 4],
    ['Answer only 2 of the 5 questions', 2],
    ['Answer 3 out of 5 questions', 3],
    ['Attempt ONE question', 1],
    ['Choose TWO questions to answer', 2],
    ['Answer TWO (2) questions', 2],
    ['Answer ANY of the questions correctly', 0],
    ['Answer ALL questions', 0],
    ['Your answer should be 250 to 300 words long', 0],
    ['', 0],
  ];
  for (const [text, want] of cases) {
    assert.equal(pdfImport.answerCountFrom(text), want, text || '(empty)');
  }
});

test('a paper with no headings still gets its "answer any N" rule', () => {
  const eid = db
    .prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('NoHead',30,'draft')")
    .run().lastInsertRowid;
  const extracted = [1, 2, 3, 4, 5].map((n) => ({ number: n, text: `Question ${n}.` }));
  for (const q of extracted) {
    db.prepare(
      `INSERT INTO questions(exam_id,q_order,type,text,marks,section_key,source_number)
       VALUES (?,?,'theory',?,5,'',?)`
    ).run(eid, q.number, q.text, q.number);
  }
  const saved = db
    .prepare('SELECT id, section_key, source_number FROM questions WHERE exam_id = ? ORDER BY q_order')
    .all(eid);

  const meta = pdfImport.buildSectionMeta([{ section: '', passage: 'Answer any THREE questions' }]);
  assert.equal(meta[''].answer_count, 3, 'the limit sits on the first question, not under a heading');

  const out = pdfImport.applySelectionRules(eid, extracted, saved, meta);
  assert.equal(out.applied, 1, 'the rule was written instead of being dropped as answer-all');
  const row = db.prepare('SELECT * FROM exam_sections WHERE exam_id = ?').get(eid);
  assert.equal(row.section_key, pdfImport.PAPER_SECTION_KEY, 'the rule has a key to point at');
  assert.equal(row.answer_count, 3);
  assert.equal(row.title, 'Paper');
  const optional = db
    .prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ? AND is_compulsory = 0')
    .get(eid).c;
  assert.equal(optional, 5, 'the questions become optional, or the quota has nothing to price against');
  assert.equal(
    db.prepare('SELECT section_key FROM questions WHERE id = ?').get(saved[0].id).section_key,
    'paper',
    'the rows are retagged so the selector and the rule speak about one section'
  );
});

test('a headingless paper whose questions were given no limit is left alone', () => {
  const eid = db
    .prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Plain',30,'draft')")
    .run().lastInsertRowid;
  const extracted = [1, 2].map((n) => ({ number: n, text: `Question ${n}.` }));
  for (const q of extracted) {
    db.prepare(
      `INSERT INTO questions(exam_id,q_order,type,text,marks,section_key,source_number)
       VALUES (?,?,'theory',?,5,'',?)`
    ).run(eid, q.number, q.text, q.number);
  }
  const saved = db
    .prepare('SELECT id, section_key, source_number FROM questions WHERE exam_id = ? ORDER BY q_order')
    .all(eid);

  const out = pdfImport.applySelectionRules(eid, extracted, saved, pdfImport.buildSectionMeta(extracted));
  assert.equal(out.applied, 0, 'a paper that demands everything still answers everything');
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM exam_sections WHERE exam_id = ?').get(eid).c,
    0
  );
});

// ── marking: the examiner reads the parts too ──────────────────────────

test('the marking scheme is built from the question and its limbs', async () => {
  const eid = db
    .prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Mark',30,'draft')")
    .run().lastInsertRowid;
  const qid = db
    .prepare(
      `INSERT INTO questions(exam_id,q_order,type,text,marks,follow_ups,section_key,is_compulsory)
       VALUES (?,1,'theory',?,5,?,'',1)`
    )
    .run(eid, 'Study the diagram and answer.', JSON.stringify([
      { text: 'Name the process.', marks: 2 },
      { text: 'State one effect.', marks: 3 },
    ])).lastInsertRowid;
  const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(qid);

  const originalConfigured = ai.aiConfigured;
  const originalGenerate = ai.generateTheoryScheme;
  let prompt = null;
  ai.aiConfigured = () => true;
  ai.generateTheoryScheme = async (args) => {
    prompt = args.text;
    return { model_answer: 'model', key_points: ['point'], rubric: [] };
  };
  try {
    const scheme = await marking.buildMarkingScheme(row);
    assert.equal(scheme.model_answer, 'model');
    assert.match(prompt, /^Study the diagram and answer\./, 'the stem leads');
    assert.match(prompt, /a\) Name the process\./, 'and the examiner can see every limb to mark');
    assert.match(prompt, /b\) State one effect\./);
  } finally {
    ai.aiConfigured = originalConfigured;
    ai.generateTheoryScheme = originalGenerate;
  }
});

test('a question with no limbs is handed to the examiner unchanged', () => {
  // Reaching into the helper directly is the only honest way to assert the
  // no-parts path: buildMarkingScheme would have to round-trip through AI.
  const text = marking.questionTextWithParts({
    type: 'theory',
    text: 'Explain the water cycle.',
    follow_ups: '[]',
  });
  assert.equal(text, 'Explain the water cycle.');
  assert.equal(
    marking.questionTextWithParts({ type: 'theory', text: 'Explain the water cycle.' }),
    'Explain the water cycle.',
    'a question stored before follow_ups existed still works'
  );
});
