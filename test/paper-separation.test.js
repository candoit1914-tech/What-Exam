'use strict';
// Paper I and Paper II are separate papers, never one mixed pool.
//
//   Paper I  — the objectives: every question is answered, no choice, ever.
//   Paper II — the theory questions under the heading the PDF printed; the ONLY
//              place a student picks questions.
//
// These tests pin the whole shape end to end: an upload puts objectives under
// `paper-i` (compulsory, unruled) and theory under `paper-ii-*` (where the rule
// lives); the API refuses a quota aimed at Paper I; and the boot migration
// un-mixes exams imported before the two papers were separated.
require('./helpers/isolate');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const db = require('../src/db');
const ai = require('../src/services/ai');
const marking = require('../src/services/marking');
const pdfImport = require('../src/services/pdfImport');
const documentSrc = require('../src/services/document');
const selection = require('../src/services/selection');
const paper = require('../src/services/paper');

function newExam(title) {
  return db
    .prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES (?,'Math',30,'draft')")
    .run(title).lastInsertRowid;
}

const rulesOf = (eid) =>
  db.prepare('SELECT * FROM exam_sections WHERE exam_id = ? ORDER BY position, id').all(eid);
const rowsOf = (eid) =>
  db.prepare('SELECT type, text, is_compulsory, section_key FROM questions WHERE exam_id = ? ORDER BY q_order').all(eid);

/** The two papers as an exam paper prints them: objectives first, then theory. */
function paperQuestions() {
  return [
    ...Array.from({ length: 3 }, (_, i) => ({
      type: 'objective',
      number: i + 1,
      section: 'SECTION A',
      text: `What is ${i + 1} plus ${i + 1}?`,
      options: ['A. 2', 'B. 3'],
      correct_answer: 'A',
      marks: 1,
    })),
    ...Array.from({ length: 6 }, (_, i) => ({
      type: 'theory',
      number: i + 1,
      section: 'SECTION B',
      // The paper's own limit, printed on the first question of the section.
      instructions: i === 0 ? 'Answer any THREE questions in this section.' : '',
      text: `Explain in detail why point ${i + 1} matters.`,
      marks: 5,
    })),
  ];
}

async function importPaper(examId, questions) {
  const jobId = pdfImport.createJob(examId, 'paper.txt');
  const originalExtract = ai.extractQuestionsFromText;
  const originalScheme = marking.buildMarkingScheme;
  ai.extractQuestionsFromText = async () => questions;
  marking.buildMarkingScheme = async () => ({ type: 'theory', model_answer: '', key_points: [] });
  try {
    await pdfImport.startJob(jobId, Buffer.from('unused'), {
      source: documentSrc.readExamSource(Buffer.from('unused'), 'paper.txt'),
    });
  } finally {
    ai.extractQuestionsFromText = originalExtract;
    marking.buildMarkingScheme = originalScheme;
  }
  return pdfImport.getJob(jobId);
}

// ── upload: two papers, two sections ───────────────────────────────────

test('an upload stores objectives under Paper I and theory under Paper II', async () => {
  const eid = newExam('__papers__');
  const job = await importPaper(eid, paperQuestions());
  assert.equal(job.status, 'done', job.error || '');

  const rows = rowsOf(eid);
  assert.equal(rows.length, 9, 'every question of the paper is saved');

  const objectives = rows.filter((q) => q.type === 'objective');
  const theory = rows.filter((q) => q.type === 'theory');
  assert.equal(objectives.length, 3);
  assert.equal(theory.length, 6);

  // The heading the objectives sat under is thrown away: the multiple-choice
  // part IS Paper I, however the PDF labels it.
  assert.ok(
    objectives.every((q) => q.section_key === paper.PAPER_I_KEY),
    'every objective joins Paper I, never its printed heading: ' +
      JSON.stringify(objectives.map((q) => q.section_key))
  );
  assert.ok(
    objectives.every((q) => q.is_compulsory === 1),
    'Paper I is answered in full, so its questions arrive compulsory'
  );

  assert.ok(
    theory.every((q) => q.section_key === 'paper-ii-section-b'),
    'theory keeps its printed heading under the Paper II prefix: ' +
      JSON.stringify(theory.map((q) => q.section_key))
  );
  assert.ok(
    theory.some((q) => q.is_compulsory === 0),
    'the theory block is where the choice lives, so it has optionals'
  );

  // Paper I has no rule row — answer-all is not a rule — while Paper II has the
  // default choice rule under its own name.
  const rules = rulesOf(eid);
  assert.ok(
    rules.every((r) => r.section_key !== paper.PAPER_I_KEY),
    'Paper I never gets an exam_sections row: ' + JSON.stringify(rules.map((r) => r.section_key))
  );
  const [rule] = rules;
  assert.equal(rule.section_key, 'paper-ii-section-b');
  assert.match(rule.title, /^PAPER II/, 'the rule is listed as Paper II');
  assert.equal(rule.answer_count, 3, "the paper's own count — answer any THREE — is the rule");

  // The plan the student is priced from carries the choice, and only there.
  const plan = selection.sectionPlan(eid);
  assert.equal(plan.length, 1, 'only the Paper II section is ruled');
  assert.equal(plan[0].section_key, 'paper-ii-section-b');
  assert.ok(plan[0].quota > 0, 'the theory block offers a choice');
});

// ── the compulsory question is owed ON TOP of the stated count ─────────
//
// A paper that prints "answer about FOUR questions" and marks one of them
// compulsory is asking for FOUR to CHOOSE plus the compulsory one — five of
// its six, not four. The importer reads the stated count as the choice and
// adds the compulsory questions to it.

test('a paper that asks for 4 and forces 1 owes 5 of its 6', async () => {
  const eid = newExam('__owed_on_top__');
  const job = await importPaper(eid, Array.from({ length: 6 }, (_, i) => ({
    type: 'theory',
    number: i + 1,
    section: 'SECTION B',
    // The paper's own words: four to choose, question 1 owed on top of them.
    instructions: i === 0 ? 'Answer any FOUR questions from this section.' : '',
    compulsory: i === 0,
    text: `Essay ${i + 1}`,
    marks: 5,
  })));
  assert.equal(job.status, 'done', job.error || '');

  const [rule] = rulesOf(eid);
  assert.equal(rule.answer_count, 5, 'the stated four plus the compulsory one owed on top');

  const plan = selection.sectionPlan(eid);
  assert.equal(plan.length, 1, 'the theory block is ruled');
  assert.equal(plan[0].toAnswer, 5, 'five of the six questions are owed in all');
  assert.equal(plan[0].quota, 4, 'one of them is forced, so the student picks the other four');

  const rows = rowsOf(eid);
  assert.equal(rows[0].is_compulsory, 1, 'question 1 stays compulsory');
  assert.ok(rows.slice(1).every((q) => q.is_compulsory === 0), 'the rest are the pool to choose from');
});

test('an objectives count never prices the theory block, even with no headings', async () => {
  const eid = newExam('__count_isolation__');
  const job = await importPaper(eid, [
    // Headingless Paper I: both papers state their limit on the first
    // question, and the objectives' "all 10" must never become the theory's
    // quota (nor let the theory's four price Paper I).
    ...Array.from({ length: 10 }, (_, i) => ({
      type: 'objective',
      number: i + 1,
      passage: i === 0 ? 'Answer all 10 questions.' : '',
      text: `What is ${i + 1} plus ${i + 1}?`,
      options: ['A. 2', 'B. 3'],
      correct_answer: 'A',
      marks: 1,
    })),
    ...Array.from({ length: 6 }, (_, i) => ({
      type: 'theory',
      number: i + 1,
      instructions: i === 0 ? 'Answer any FOUR questions.' : '',
      compulsory: i === 0,
      text: `Essay ${i + 1}`,
      marks: 5,
    })),
  ]);
  assert.equal(job.status, 'done', job.error || '');

  const rules = rulesOf(eid);
  assert.ok(
    rules.every((r) => r.section_key !== paper.PAPER_I_KEY),
    'Paper I still gets no rule: ' + JSON.stringify(rules.map((r) => r.section_key))
  );
  const [rule] = rules;
  assert.equal(rule.section_key, 'paper-ii', 'the headingless theory block owns the rule');
  assert.equal(
    rule.answer_count, 5,
    'the stated four plus the compulsory one — never the objectives’ 10, never the default 4'
  );

  const plan = selection.sectionPlan(eid);
  assert.equal(plan[0].toAnswer, 5);
  assert.equal(plan[0].quota, 4);

  const objectives = rowsOf(eid).filter((q) => q.type === 'objective');
  assert.ok(objectives.every((q) => q.is_compulsory === 1), 'Paper I is still answered in full');
});

test('one heading holding both papers keeps their counts apart', async () => {
  const eid = newExam('__shared_heading__');
  const job = await importPaper(eid, [
    ...Array.from({ length: 3 }, (_, i) => ({
      type: 'objective',
      number: i + 1,
      section: 'SECTION A',
      passage: i === 0 ? 'Answer all 3 questions.' : '',
      text: `What is ${i + 1} plus ${i + 1}?`,
      options: ['A. 2', 'B. 3'],
      correct_answer: 'A',
      marks: 1,
    })),
    ...Array.from({ length: 6 }, (_, i) => ({
      type: 'theory',
      number: i + 1,
      section: 'SECTION A',
      instructions: i === 0 ? 'Answer any FOUR questions.' : '',
      compulsory: i === 0,
      text: `Essay ${i + 1}`,
      marks: 5,
    })),
  ]);
  assert.equal(job.status, 'done', job.error || '');

  const rules = rulesOf(eid);
  assert.ok(
    rules.every((r) => r.section_key !== paper.PAPER_I_KEY),
    'the shared heading never gives Paper I a rule: ' + JSON.stringify(rules.map((r) => r.section_key))
  );
  const [rule] = rules;
  assert.equal(rule.section_key, 'paper-ii-section-a');
  // Both papers print their instruction under the SAME heading, so a rule
  // reading the verbatim heading would pick the objectives' "all 3" up: the
  // paper-scoped facts are what the theory block must be priced from.
  assert.equal(rule.answer_count, 5, 'the theory’s stated four plus its compulsory one');
});

test('Paper I is never a choice, whatever an old row claims', () => {
  const eid = newExam('__no_choice__');
  db.prepare(
    "INSERT INTO questions (exam_id, q_order, type, text, section_key, is_compulsory) VALUES (?,1,'objective','Capital of Ghana?','paper-i',1)"
  ).run(eid);
  db.prepare(
    "INSERT INTO questions (exam_id, q_order, type, text, section_key, is_compulsory) VALUES (?,2,'objective','Capital of Burkina Faso?','paper-i',0)"
  ).run(eid);

  const [, optional] = rowsOf(eid);
  assert.equal(
    selection.needsChoice({ id: -1 }, optional),
    false,
    'an objective is never offered the selector, even flagged optional'
  );
  assert.ok(
    selection.sectionPlan(eid).every((s) => s.section_key !== paper.PAPER_I_KEY) ||
      selection.sectionPlan(eid).every((s) => s.quota <= 0),
    'a plan over Paper I can never resolve to a choice'
  );
});

// ── the API refuses a Paper I quota ────────────────────────────────────

const http = require('node:http');
const express = require('express');
const auth = require('../src/auth');
const api = require('../src/routes/api');

let server;
let base;
let token;

function request(method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      `${base}${reqPath}`,
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

before(async () => {
  token = auth.adminToken();
  const app = express();
  app.use(express.json());
  app.use('/api', api);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); });

test('a quota aimed at Paper I is refused, not silently stored', async () => {
  const eid = newExam('__paper_i_quota__');
  for (let i = 1; i <= 3; i++) {
    db.prepare(
      "INSERT INTO questions (exam_id, q_order, type, text, section_key) VALUES (?,?,'objective',?,'paper-i')"
    ).run(eid, i, `Objective ${i}`);
  }

  const refused = await request('PATCH', `/api/exams/${eid}/sections`, {
    sections: [{ section_key: 'paper-i', title: 'PAPER I', answer_count: 2 }],
  });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(refused.body.error, /answer-all/i, 'the refusal says Paper I is answered in full');
  assert.equal(rulesOf(eid).length, 0, 'nothing was written');

  // A legacy section that still mixes both papers is refused for the same
  // reason: the objectives inside it take no choice.
  const mixed = newExam('__mixed_quota__');
  db.prepare(
    "INSERT INTO questions (exam_id, q_order, type, text, section_key) VALUES (?,1,'objective','Objective 1','paper')"
  ).run(mixed);
  db.prepare(
    "INSERT INTO questions (exam_id, q_order, type, text, section_key) VALUES (?,2,'theory','Theory 1','paper')"
  ).run(mixed);
  const mixedRefused = await request('PATCH', `/api/exams/${mixed}/sections`, {
    sections: [{ section_key: 'paper', title: 'Mixed', answer_count: 1 }],
  });
  assert.equal(mixedRefused.status, 400, JSON.stringify(mixedRefused.body));
  assert.equal(rulesOf(mixed).length, 0, 'the mixed section keeps no rule either');
});

test('saving the card never writes a Paper I row', async () => {
  const eid = newExam('__paper_i_card__');
  db.prepare(
    "INSERT INTO questions (exam_id, q_order, type, text, section_key) VALUES (?,1,'objective','Objective 1','paper-i')"
  ).run(eid);
  db.prepare(
    "INSERT INTO questions (exam_id, q_order, type, text, section_key) VALUES (?,2,'theory','Theory 1','paper-ii')"
  ).run(eid);

  const saved = await request('PATCH', `/api/exams/${eid}/sections`, {
    sections: [
      { section_key: 'paper-i', title: 'PAPER I', answer_count: 0 },
      { section_key: 'paper-ii', title: 'PAPER II', answer_count: 1 },
    ],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const rules = rulesOf(eid);
  assert.deepEqual(rules.map((r) => r.section_key), ['paper-ii'], 'only Paper II carries a rule');
});

// ── boot migration: an exam imported before the split ──────────────────
//
// src/db.js runs its migrations at require time, so a database holding legacy
// keys can only be exercised from a child process (the pattern the selection
// column migration test uses).

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-exam-papers-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Boot src/db.js against `dbFile`, run `body`, print its JSON report. */
function boot(dbFile, body) {
  const script = `
    const db = require(${JSON.stringify(require.resolve('../src/db'))});
    const out = (${body})();
    db.close();
    console.log(JSON.stringify(out));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DB_PATH: dbFile,
      SEED_ON_BOOT: 'false',
      UPLOADS_DIR: path.join(tmp, 'uploads'),
    },
  });
  return JSON.parse(out.split('\n').filter((l) => l.trim().startsWith('{')).pop());
}

const REPORT = `() => ({
  questions: db.prepare(
    'SELECT type, section_key, is_compulsory FROM questions ORDER BY id'
  ).all(),
  pool: db.prepare(
    "SELECT type, section_key, is_compulsory FROM question_pool ORDER BY id"
  ).all(),
  sections: db.prepare(
    'SELECT section_key, title, answer_count FROM exam_sections ORDER BY id'
  ).all(),
  drawn: db.prepare(
    'SELECT section_key FROM session_questions ORDER BY session_id, q_order'
  ).all(),
  selecting: db.prepare(
    'SELECT selection_section FROM sessions ORDER BY id'
  ).all()
})`;

/** A modern schema, an exam imported under the OLD keys, and its drawn session. */
function seedLegacyExam(dbFile) {
  boot(dbFile, '() => ({ booted: true })'); // create the schema once

  const s = new DatabaseSync(dbFile);
  s.exec('PRAGMA foreign_keys = OFF');
  s.exec("INSERT INTO exams (id, title, subject, duration_minutes, status) VALUES (1,'Legacy paper','Math',30,'draft')");
  s.exec("INSERT INTO students (id, phone) VALUES (1,'233papers00')");
  // One heading held BOTH papers — the shape the importer used to write.
  for (let i = 1; i <= 3; i++) {
    s.exec(
      `INSERT INTO questions (id, exam_id, q_order, type, text, marks, is_compulsory, section_key)
       VALUES (${i},1,${i},'objective','Objective ${i}',1,0,'paper')`
    );
  }
  for (let i = 4; i <= 7; i++) {
    s.exec(
      `INSERT INTO questions (id, exam_id, q_order, type, text, marks, is_compulsory, section_key)
       VALUES (${i},1,${i},'theory','Theory ${i}',5,1,'paper')`
    );
  }
  s.exec(
    "INSERT INTO questions (id, exam_id, q_order, type, text, marks, section_key) VALUES (8,1,8,'theory','Under section B',5,'section-b')"
  );
  // Objectives grouped under their own printed heading, with a quota typed over
  // them — the rule Paper I must never have.
  s.exec(
    "INSERT INTO questions (id, exam_id, q_order, type, text, marks, section_key) VALUES (9,1,9,'objective','Objective under C',1,'section-c')"
  );
  // Untouched by the migration: never grouped, and the default theory block.
  s.exec(
    "INSERT INTO questions (id, exam_id, q_order, type, text, marks, section_key) VALUES (10,1,10,'theory','Ungrouped theory',5,'')"
  );
  s.exec(
    "INSERT INTO questions (id, exam_id, q_order, type, text, marks, section_key) VALUES (11,1,11,'theory','Default block theory',5,'theory')"
  );

  const poolShape = [
    ['objective', 'paper'], ['objective', 'paper'], ['objective', 'paper'],
    ['theory', 'paper'], ['theory', 'paper'], ['theory', 'paper'], ['theory', 'paper'],
    ['theory', 'section-b'], ['objective', 'section-c'],
    ['theory', ''], ['theory', 'theory'],
  ];
  poolShape.forEach(([type, key], idx) => {
    s.exec(
      `INSERT INTO question_pool (id, exam_id, type, text, marks, section_key) VALUES (${idx + 1},1,'${type}','Q${idx + 1}',1,'${key}')`
    );
  });

  s.exec(
    "INSERT INTO exam_sections (exam_id, section_key, title, instructions, position, answer_count) VALUES (1,'paper','SECTION A','',0,3)"
  );
  s.exec(
    "INSERT INTO exam_sections (exam_id, section_key, title, instructions, position, answer_count) VALUES (1,'section-c','SECTION C','',1,1)"
  );
  s.exec(
    "INSERT INTO exam_sections (exam_id, section_key, title, instructions, position, answer_count) VALUES (1,'theory','THEORY','',2,2)"
  );
  s.exec('INSERT INTO sessions (id, exam_id, student_id, selection_section, selection_state) VALUES (1,1,1,\'paper\',\'selecting\')');
  for (let i = 1; i <= 5; i++) {
    s.exec(`INSERT INTO session_questions (session_id, question_id, q_order, section_key) VALUES (1,${i},${i},'paper')`);
  }
  s.exec("INSERT INTO session_questions (session_id, question_id, q_order, section_key) VALUES (1,8,6,'section-b')");
  s.close();
}

test('the boot migration un-mixes an exam imported before the two papers', () => {
  const dbFile = path.join(tmp, 'legacy-papers.db');
  seedLegacyExam(dbFile);

  const first = boot(dbFile, REPORT);
  const objectives = first.questions.filter((q) => q.type === 'objective');
  const theory = first.questions.filter((q) => q.type === 'theory');
  assert.equal(objectives.length, 4);
  assert.equal(theory.length, 7, 'and the ungrouped / default-block keys are left exactly as they were');

  assert.ok(
    objectives.every((q) => q.section_key === paper.PAPER_I_KEY),
    'every objective joins Paper I: ' + JSON.stringify(objectives.map((q) => q.section_key))
  );
  assert.ok(
    objectives.every((q) => q.is_compulsory === 1),
    'objectives arrive compulsory again — Paper I answers everything'
  );

  assert.deepEqual(
    theory.map((q) => q.section_key),
    ['paper-ii', 'paper-ii', 'paper-ii', 'paper-ii', 'paper-ii-section-b', '', 'theory'],
    'theory keeps its headings under Paper II, and the untouched keys stay untouched'
  );

  assert.deepEqual(
    first.pool.map((q) => q.section_key),
    ['paper-i', 'paper-i', 'paper-i', 'paper-ii', 'paper-ii', 'paper-ii', 'paper-ii',
      'paper-ii-section-b', 'paper-i', '', 'theory'],
    'the pool follows the same mapping as the template'
  );

  assert.deepEqual(
    first.sections.map((s) => [s.section_key, s.answer_count]),
    [['paper-ii', 3], ['theory', 2]],
    "the mixed rule follows the theory it ruled; the objectives-only rule is deleted"
  );
  assert.equal(
    first.sections[0].title,
    'PAPER II — SECTION A',
    'and the rule is listed under the paper it belongs to'
  );

  assert.deepEqual(
    first.drawn.map((r) => r.section_key),
    ['paper-i', 'paper-i', 'paper-i', 'paper-ii', 'paper-ii', 'paper-ii-section-b'],
    'a drawn session keeps the section its questions were drawn under, paper by paper'
  );
  assert.deepEqual(first.selecting, [{ selection_section: 'paper-ii' }]);

  // Idempotent: a second boot changes nothing.
  const second = boot(dbFile, REPORT);
  assert.deepEqual(second, first, 'running the migration again is a no-op');
});

test('paper.js maps a legacy key the same way on both sides of the wire', () => {
  assert.equal(paper.legacySectionKey('paper', 'objective'), 'paper-i');
  assert.equal(paper.legacySectionKey('paper', 'theory'), 'paper-ii');
  assert.equal(paper.legacySectionKey('section-b', 'objective'), 'paper-i');
  assert.equal(paper.legacySectionKey('section-b', 'theory'), 'paper-ii-section-b');
  assert.equal(paper.legacySectionKey('', 'objective'), '', 'never-grouped stays ungrouped');
  assert.equal(paper.legacySectionKey('theory', 'theory'), 'theory', 'the default theory block stays');
  assert.equal(paper.legacySectionKey('paper-ii-section-b', 'theory'), 'paper-ii-section-b', 'already migrated');
  assert.ok(!paper.needsLegacyRemap('paper-i', 'objective'));
  assert.ok(paper.needsLegacyRemap('paper-i', 'theory'));
  assert.equal(paper.sectionKeyFor({ type: 'objective', section: 'SECTION B' }), 'paper-i');
  assert.equal(paper.sectionKeyFor({ type: 'theory', section: 'SECTION B' }), 'paper-ii-section-b');
  assert.equal(paper.sectionKeyFor({ type: 'theory' }), 'paper-ii');
});
