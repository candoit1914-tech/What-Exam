'use strict';
// Import-side selection reconciliation: env must be set before ../src/db loads,
// or db.js opens the real database. Same pattern as test/question-selection.test.js.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-exam-selrules-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.DOTENV_CONFIG_PATH = path.join(tmp, '.env');
process.env.SEED_ON_BOOT = 'false';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { applySelectionRules, slugOf, buildSectionMeta } = require('../src/services/pdfImport');
const selection = require('../src/services/selection');
// Pure classic script, no DB behind it — the browser slug must equal the importer's
// or a section key set on the dashboard never matches what an import wrote.
const selectionUi = require('../src/public/selection-ui');

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Mirrors what startJob persists: source_number keeps the printed number,
// section_key is the slug, is_compulsory defaults to 1 exactly as the schema does.
function examWith(spec) {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('PDF',30,'live')").run().lastInsertRowid;
  const saved = spec.map((q, i) => {
    const qid = db.prepare(
      `INSERT INTO questions(exam_id,q_order,type,text,section_key,source_number)
       VALUES (?,?,'theory',?,?,?)`
    ).run(eid, i + 1, `Q${i + 1}`, slugOf(q.section), q.source_number ?? i + 1).lastInsertRowid;
    return { id: qid, q_order: i + 1, section_key: slugOf(q.section), source_number: q.source_number ?? i + 1 };
  });
  return { eid, saved };
}

test('an extraction with no section data writes no rule at all', () => {
  const { eid, saved } = examWith([{}, {}]);
  const out = applySelectionRules(eid, [{ number: 1 }, { number: 2 }], saved);
  assert.equal(out.applied, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM exam_sections WHERE exam_id=?').get(eid).c, 0);
});

test('a selective section makes its non-forced questions selectable', () => {
  // Four questions, one compulsory, and a paper that demands two of them. The
  // count is stored exactly as the paper states it — two — because the
  // compulsory question is owed OUT of those two, leaving one to choose.
  const { eid, saved } = examWith([
    { section: 'SECTION B' }, { section: 'SECTION B' },
    { section: 'SECTION B' }, { section: 'SECTION B' },
  ]);
  const out = applySelectionRules(eid, [
    { number: 1, section: 'SECTION B', compulsory: true },
    { number: 2, section: 'SECTION B' },
    { number: 3, section: 'SECTION B' },
    { number: 4, section: 'SECTION B' },
  ], saved, { 'SECTION B': { title: 'SECTION B', instructions: 'Answer any TWO questions', answer_count: 2 } });
  assert.equal(out.applied, 1);

  const sec = db.prepare('SELECT * FROM exam_sections WHERE exam_id=?').get(eid);
  assert.equal(sec.answer_count, 2, 'the paper\u2019s own number, compulsory question included');

  // What the import writes and what the selector prices are the same rule:
  // two owed, one of them forced, so the student picks one of three.
  const plan = selection.sectionPlan(eid)[0];
  assert.equal(plan.toAnswer, 2, 'the section still owes what the paper demanded');
  assert.equal(plan.quota, 1, 'and offers the three questions it left to choose from');

  const rows = db.prepare('SELECT source_number, is_compulsory FROM questions WHERE exam_id=? ORDER BY q_order').all(eid);
  assert.equal(rows[0].is_compulsory, 1, 'question 1 stays compulsory');
  assert.equal(rows[1].is_compulsory, 0, 'question 2 becomes selectable — this is the write the earlier draft never made');
  assert.equal(rows[2].is_compulsory, 0, 'question 3 becomes selectable too');
  assert.equal(rows[3].is_compulsory, 0);
});

test('compulsory is matched on the printed number, not on q_order', () => {
  // A dropped block means q_order 2 is the paper's question 7. Matching
  // positionally would force the wrong question.
  const { eid, saved } = examWith([
    { section: 'SECTION B', source_number: 5 },
    { section: 'SECTION B', source_number: 7 },
    { section: 'SECTION B', source_number: 8 },
  ]);
  applySelectionRules(eid, [
    { number: 5, section: 'SECTION B' },
    { number: 7, section: 'SECTION B', compulsory: true },
    { number: 8, section: 'SECTION B' },
  ], saved, { 'SECTION B': { answer_count: 1 } });

  const rows = db.prepare('SELECT source_number, is_compulsory FROM questions WHERE exam_id=? ORDER BY source_number').all(eid);
  assert.deepEqual(
    rows.map((r) => [r.source_number, r.is_compulsory]),
    [[5, 0], [7, 1], [8, 0]],
    'only printed question 7 is compulsory'
  );
});

test('a compulsory claim for a question that was never extracted is dropped', () => {
  const { eid, saved } = examWith([
    { section: 'SECTION B', source_number: 1 }, { section: 'SECTION B', source_number: 2 },
  ]);
  const out = applySelectionRules(eid, [
    { number: 1, section: 'SECTION B' },
    { number: 2, section: 'SECTION B' },
    { number: 99, section: 'SECTION B', compulsory: true },
  ], saved, { 'SECTION B': { answer_count: 1 } });
  assert.ok(out.skipped.some((s) => /99/.test(s)), 'the phantom question must be reported, not guessed at');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id=? AND is_compulsory=1').get(eid).c, 0);
});

test('a rule that ends up meaning answer-all is not written', () => {
  const { eid, saved } = examWith([{ section: 'SECTION B' }, { section: 'SECTION B' }]);
  const out = applySelectionRules(eid, [
    { number: 1, section: 'SECTION B', compulsory: true },
    { number: 2, section: 'SECTION B', compulsory: true },
  ], saved, { 'SECTION B': { answer_count: 2 } });
  assert.equal(out.applied, 0, 'answer-all is not a rule');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM exam_sections WHERE exam_id=?').get(eid).c, 0);
});

test('a quota larger than the section collapses to answer-all, not a phantom rule', () => {
  // Three questions and a count of nine. Clamping lands on 3, which covers
  // every question, and a rule that covers every question can never fire — so
  // nothing is written and the reason is reported. Storing 3 would advertise a
  // choice the student does not get.
  const { eid, saved } = examWith([
    { section: 'SECTION B' }, { section: 'SECTION B' }, { section: 'SECTION B' },
  ]);
  const out = applySelectionRules(eid, [
    { number: 1, section: 'SECTION B' }, { number: 2, section: 'SECTION B' },
    { number: 3, section: 'SECTION B' },
  ], saved, { 'SECTION B': { answer_count: 9 } });
  assert.equal(out.applied, 0);
  assert.ok(out.skipped.some((s) => /answer-all/.test(s)));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM exam_sections WHERE exam_id=?').get(eid).c, 0);
});

test('a section whose questions were all dropped is skipped', () => {
  const { eid, saved } = examWith([{ section: 'SECTION B' }]);
  const out = applySelectionRules(eid, [{ number: 1, section: 'GHOST' }], saved, {
    GHOST: { answer_count: 1 },
  });
  assert.equal(out.applied, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM exam_sections WHERE exam_id=?').get(eid).c, 0);
});

test('the browser and the importer slug a heading identically', () => {
  // The dashboard's Section select stores section_key, and an imported paper
  // derives it from the heading. If the two disagree, an admin editing an
  // imported section creates a second, empty group instead of editing the real one.
  for (const heading of ['SECTION B', 'Part II', '  Section  C  ', 'Q.4', 'Section A']) {
    assert.equal(selectionUi.sectionSlug(heading), slugOf(heading), heading);
  }
  assert.equal(slugOf(''), '');
  assert.equal(slugOf(null), '');
});

test('the answer-N count is recovered from the instruction wording', () => {
  // The extractor keeps section instructions in `passage`, so that is where the
  // count has to be read from — it is never a separate structured field.
  const byDigit = buildSectionMeta([
    { section: 'SECTION B', passage: 'Answer 2 questions from this section.' },
    { section: 'SECTION C', passage: '' },
  ]);
  assert.equal(byDigit['SECTION B'].answer_count, 2);
  assert.equal(byDigit['SECTION C'].answer_count, 0, 'no instruction means no limit, i.e. answer-all');

  // Numbered words are the common phrasing on real papers, and a word count must
  // not be read as a digit.
  assert.equal(
    buildSectionMeta([{ section: 'SECTION B', passage: 'Answer any TWO questions' }])['SECTION B'].answer_count,
    2
  );
  assert.equal(
    buildSectionMeta([{ section: 'SECTION D', passage: 'Answer all FOUR questions' }])['SECTION D'].answer_count,
    4,
    '"Answer all FOUR" still yields 4, which then clamps to answer-all downstream'
  );
  // "Answer ANY of the questions" must not parse "any" as a count.
  assert.equal(
    buildSectionMeta([{ section: 'SECTION E', passage: 'Answer ANY of the questions correctly' }])['SECTION E'].answer_count,
    0
  );
});