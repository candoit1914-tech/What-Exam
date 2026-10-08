'use strict';
// Selection harness: env must be set before ../src/db is required, or db.js
// opens the real database. Copied from test/timer-start.test.js:1-19.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-exam-sel-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.DOTENV_CONFIG_PATH = path.join(tmp, '.env');
process.env.SEED_ON_BOOT = 'false';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

// sessions.student_id is a real FK and SEED_ON_BOOT is off, so every session
// fixture has to create its student first.
const aStudent = () => db.prepare('INSERT INTO students(phone) VALUES (?)')
  .run('233' + Math.random().toString(36).slice(2, 10)).lastInsertRowid;

test('every selection column exists', () => {
  for (const c of ['is_compulsory', 'section_key', 'source_number']) {
    assert.ok(cols('questions').includes(c), `questions.${c}`);
  }
  for (const c of ['is_compulsory', 'section_key']) {
    assert.ok(cols('question_pool').includes(c), `question_pool.${c}`);
  }
  for (const c of ['selection_state', 'selection_section', 'selection_tentative', 'paper_total']) {
    assert.ok(cols('sessions').includes(c), `sessions.${c}`);
  }
  for (const c of ['is_selected', 'section_key']) {
    assert.ok(cols('session_questions').includes(c), `session_questions.${c}`);
  }
});

test('the printed number is stored apart from the insertion order', () => {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Nums',30,'live')").run().lastInsertRowid;
  // A dropped block means q_order 1 is the paper's question 7. Only source_number
  // can tell the reconciliation which question the paper actually named.
  const qid = db.prepare("INSERT INTO questions(exam_id,q_order,type,text,source_number) VALUES (?,1,'theory','Q',7)")
    .run(eid).lastInsertRowid;
  const q = db.prepare('SELECT q_order, source_number FROM questions WHERE id=?').get(qid);
  assert.equal(q.q_order, 1);
  assert.equal(q.source_number, 7);
});

test('a question is compulsory and ungrouped unless told otherwise', () => {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Defaults',30,'live')").run().lastInsertRowid;
  const qid = db.prepare("INSERT INTO questions(exam_id,q_order,type,text) VALUES (?,1,'theory','Q')").run(eid).lastInsertRowid;
  const q = db.prepare('SELECT * FROM questions WHERE id=?').get(qid);
  assert.equal(q.is_compulsory, 1);
  assert.equal(q.section_key, '');
});

test('a drawn question defaults to selected, so nothing changes for old exams', () => {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Drawn',30,'live')").run().lastInsertRowid;
  // session_questions.question_id references question_pool, not questions: a
  // drawn row always points at a pool row.
  const qid = db.prepare("INSERT INTO question_pool(exam_id,type,text) VALUES (?,'theory','Q')").run(eid).lastInsertRowid;
  const sid = db.prepare('INSERT INTO sessions(exam_id,student_id) VALUES (?,?)').run(eid, aStudent()).lastInsertRowid;
  db.prepare('INSERT INTO session_questions(session_id,question_id,q_order) VALUES (?,?,1)').run(sid, qid);
  const row = db.prepare('SELECT * FROM session_questions WHERE session_id=?').get(sid);
  assert.equal(row.is_selected, 1, 'is_selected must default to 1 or every existing exam loses questions');
  assert.equal(row.section_key, '');
});

test('a session starts unlocked with no paper total recorded', () => {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Session',30,'live')").run().lastInsertRowid;
  const sid = db.prepare('INSERT INTO sessions(exam_id,student_id) VALUES (?,?)').run(eid, aStudent()).lastInsertRowid;
  const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(sid);
  assert.equal(s.selection_state, '');
  assert.equal(s.selection_section, '');
  assert.equal(s.selection_tentative, '');
  assert.equal(s.paper_total, 0);
});

test('exam_sections stores a rule and scopes it to its exam', () => {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Sections',30,'live')").run().lastInsertRowid;
  const other = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Other',30,'live')").run().lastInsertRowid;
  db.prepare(
    `INSERT INTO exam_sections(exam_id,section_key,title,instructions,position,answer_count)
     VALUES (?,?,?,?,?,?)`
  ).run(eid, 'sec-b', 'SECTION B', 'Answer any THREE questions', 1, 3);
  const rows = db.prepare('SELECT * FROM exam_sections WHERE exam_id=?').all(eid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].answer_count, 3);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM exam_sections WHERE exam_id=?').get(other).c, 0);
});

test('a section rule upserts rather than duplicating', () => {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Upsert',30,'live')").run().lastInsertRowid;
  const upsert = db.prepare(
    `INSERT INTO exam_sections(exam_id,section_key,title,instructions,position,answer_count)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(exam_id, section_key) DO UPDATE SET
       title=excluded.title, instructions=excluded.instructions,
       position=excluded.position, answer_count=excluded.answer_count`
  );
  upsert.run(eid, 'b', 'SECTION B', 'Answer two', 1, 2);
  upsert.run(eid, 'b', 'SECTION B (revised)', 'Answer one', 1, 1);
  const rows = db.prepare('SELECT * FROM exam_sections WHERE exam_id=?').all(eid);
  assert.equal(rows.length, 1, 'one row per section key');
  assert.equal(rows[0].answer_count, 1);
  assert.equal(rows[0].instructions, 'Answer one');
});

// ── Task 2: rule resolution and commit ────────────────────────────────

const selection = require('../src/services/selection');
const examSvc = require('../src/services/exam');

// Builds a live exam. spec: [{ type, marks, compulsory, section }]
function paperExam(spec, examId = null) {
  const eid = examId ?? db.prepare(
    "INSERT INTO exams(title,duration_minutes,status) VALUES ('Paper',30,'live')"
  ).run().lastInsertRowid;
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
    `INSERT INTO exam_sections(exam_id,section_key,title,instructions,position,answer_count)
     VALUES (?,?,?,?,?,?)`
  ).run(eid, key, title, 'Answer any THREE questions', position, count);
}

// The optional q_orders the student may pick from in one section.
function poolOf(sessionId, sectionKey) {
  return selection.sessionPlan(sessionId).find((s) => s.section_key === sectionKey).optional
    .map((q) => q.q_order);
}

test('sectionPlan splits compulsory from optional and reports the real quota', () => {
  const eid = paperExam([
    { compulsory: true, section: 'b' },
    { compulsory: false, section: 'b' },
    { compulsory: false, section: 'b' },
    { compulsory: false, section: 'b' },
  ]);
  rule(eid, 'b', 'SECTION B', 2);
  const plan = selection.sectionPlan(eid);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].quota, 2);
  assert.equal(plan[0].optional.length, 3, 'the compulsory question is not part of the pool');
  assert.equal(plan[0].compulsory.length, 1);
});

test('a quota beyond the pool clamps to answer-all and is suppressed', () => {
  // answer_count 5 against a pool of 2 clamps down to 2, which now covers the
  // whole pool — so it is answer-all and the selector would be a no-op. Clamping
  // and the answer-all rule compose deliberately; the derived quota is 0, not 2.
  const eid = paperExam([
    { compulsory: true, section: 'b' },
    { compulsory: false, section: 'b' },
    { compulsory: false, section: 'b' },
  ]);
  rule(eid, 'b', 'SECTION B', 5);
  const plan = selection.sectionPlan(eid);
  assert.equal(plan[0].quota, 0, 'a quota covering the whole pool is never selective');
  assert.equal(plan[0].answer_count, 5, 'the stored count is untouched by the derived clamp');
});

test('a quota at or above the pool size means answer-all, never a selector', () => {
  const eid = paperExam([
    { compulsory: false, section: 'b' },
    { compulsory: false, section: 'b' },
  ]);
  rule(eid, 'b', 'SECTION B', 2);
  const sid = examSvc.createSession(eid, 1);
  assert.equal(selection.sessionPlan(sid.id)[0].quota, 0, 'quota == pool size is a no-op selector');
  assert.equal(selection.isSelective(sid.id, 'b'), false);
});

test('a section with no quota is never selective', () => {
  const eid = paperExam([
    { compulsory: false, section: 'b' },
    { compulsory: false, section: 'b' },
  ]);
  const sid = examSvc.createSession(eid, 1);
  assert.equal(selection.isSelective(sid.id, 'b'), false);
});

test('an exam with no sections has no plan at all', () => {
  const eid = paperExam([{ compulsory: false }, { compulsory: false }]);
  const sid = examSvc.createSession(eid, 1);
  assert.deepEqual(selection.sessionPlan(sid.id), []);
});

test('sessionPlan keys the pool on session q_order, never on a template id', () => {
  const eid = paperExam([
    { compulsory: true, section: 'b' },
    { compulsory: false, section: 'b' },
    { compulsory: false, section: 'b' },
    { compulsory: false, section: 'b' },
  ]);
  rule(eid, 'b', 'SECTION B', 2);
  const sid = examSvc.createSession(eid, 1);
  const sec = selection.sessionPlan(sid.id)[0];
  // q_order is the only key here; there is no questions.id anywhere in this shape.
  for (const q of sec.optional) assert.equal(typeof q.q_order, 'number');
  assert.equal(sec.quota, 2);
  assert.equal(sec.committed, false, 'nothing is chosen until the student chooses');
});

test('the selector is due at an optional question and not at a compulsory one', () => {
  const eid = paperExam([
    { compulsory: true, section: 'b' },
    { compulsory: false, section: 'b' },
    { compulsory: false, section: 'b' },
    { compulsory: false, section: 'b' },
  ]);
  rule(eid, 'b', 'SECTION B', 2);
  const sid = examSvc.createSession(eid, 1);
  const drawn = db.prepare(
    `SELECT sq.q_order, sq.section_key, qp.is_compulsory
       FROM session_questions sq JOIN question_pool qp ON qp.id = sq.question_id
      WHERE sq.session_id = ? ORDER BY sq.q_order`
  ).all(sid.id);
  const firstOptional = drawn.find((r) => !r.is_compulsory);
  const firstCompulsory = drawn.find((r) => r.is_compulsory);
  assert.equal(
    selection.needsChoice({ id: sid.id }, firstOptional), true,
    'the selector opens when delivery reaches an optional question'
  );
  assert.equal(
    selection.needsChoice({ id: sid.id }, firstCompulsory), false,
    'a compulsory question must never raise the selector'
  );
});

test('paper total sums the compulsory and the chosen, not the whole section', () => {
  const eid = paperExam([
    { marks: 10, compulsory: true, section: 'b' },
    { marks: 10, compulsory: false, section: 'b' },
    { marks: 10, compulsory: false, section: 'b' },
    { marks: 10, compulsory: false, section: 'b' },
  ]);
  rule(eid, 'b', 'SECTION B', 2);
  const sid = examSvc.createSession(eid, 1);
  const pool = poolOf(sid.id, 'b');
  const total = selection.applySelection(sid.id, 'b', pool.slice(0, 2));
  assert.equal(total, 30, 'compulsory 10 + two chosen 10s; the third must not count');
});

test('deselecting everything but one still bills the compulsory question', () => {
  const eid = paperExam([
    { marks: 7, compulsory: true, section: 'b' },
    { marks: 5, compulsory: false, section: 'b' },
    { marks: 5, compulsory: false, section: 'b' },
  ]);
  rule(eid, 'b', 'SECTION B', 1);
  const sid = examSvc.createSession(eid, 1);
  const pool = poolOf(sid.id, 'b');
  assert.equal(selection.applySelection(sid.id, 'b', [pool[1]]), 12);
});

test('a committed section is not offered again, but a later one still is', () => {
  const eid = paperExam([
    { compulsory: true, section: 'a' },
    { compulsory: false, section: 'a' },
    { compulsory: false, section: 'a' },
    { compulsory: true, section: 'b' },
    { compulsory: false, section: 'b' },
    { compulsory: false, section: 'b' },
    { compulsory: false, section: 'b' },
  ]);
  rule(eid, 'a', 'SECTION A', 1, 0);
  rule(eid, 'b', 'SECTION B', 2, 1);
  const sid = examSvc.createSession(eid, 1);
  const poolA = poolOf(sid.id, 'a');
  selection.applySelection(sid.id, 'a', [poolA[0]]);

  const plan = selection.sessionPlan(sid.id);
  assert.equal(plan.find((s) => s.section_key === 'a').committed, true);
  assert.equal(
    plan.find((s) => s.section_key === 'b').committed, false,
    'one global flag would wrongly lock section B; commit state must be per section'
  );
  const bOptional = plan.find((s) => s.section_key === 'b').optional[0];
  assert.equal(
    selection.needsChoice({ id: sid.id }, bOptional), true,
    'section B is still owed a choice after section A was committed'
  );
});

test('computePaperTotal falls back to every drawn question when none were dropped', () => {
  const eid = paperExam([{ marks: 4 }, { marks: 6 }]);
  const sid = examSvc.createSession(eid, 1);
  assert.equal(selection.computePaperTotal(sid.id), 10);
});

// ── Task 4: the WhatsApp selector ──────────────────────────────────────

const wa = require('../src/services/whatsapp');

/** Records every outbound message, whatever helper sends it. */
function captureWa() {
  const sent = [];
  const orig = {
    sendText: wa.sendText,
    sendInteractiveList: wa.sendInteractiveList,
    sendInteractiveButtons: wa.sendInteractiveButtons,
  };
  wa.sendText = async (phone, text) => { sent.push({ kind: 'text', text }); return {}; };
  wa.sendInteractiveList = async (phone, title, body, buttonText, rows, footer) => {
    sent.push({ kind: 'list', title, body, buttonText, rows, footer });
    return {};
  };
  wa.sendInteractiveButtons = async (phone, text, buttons) => {
    sent.push({ kind: 'buttons', text, buttons });
    return {};
  };
  return { sent, restore: () => Object.assign(wa, orig) };
}

function selectiveSession(quota = 2, poolSize = 3) {
  const eid = paperExam([
    { marks: 5, compulsory: true, section: 'b' },
    ...Array.from({ length: poolSize }, () => ({ marks: 5, compulsory: false, section: 'b' })),
  ]);
  rule(eid, 'b', 'SECTION B', quota);
  const sid = examSvc.createSession(eid, 1);
  return { eid, sid, phone: '23300000000' };
}

// examSvc.createSession() returns the session ROW itself, so it already has .id.
// Tests pass either the row or a bare id; accept both so a caller cannot bind an
// object straight to a SQLite parameter and fail with a driver error.
const sidOf = (s) => (s && s.id !== undefined ? s.id : s);
const sessionRow = (sid) => db.prepare('SELECT * FROM sessions WHERE id=?').get(sidOf(sid));
const allText = (sent) => sent.map((m) => m.text || m.body || '').join('\n');

// Typed numbers are 1-based POSITIONS in the printed listing, not q_orders —
// that is what the student reads on screen and types back. The pool here starts
// at q_order 2, so typing a q_order would silently pick a different question.
// Selection by tap goes through the row id, which does carry q_order.
const typePositions = (...positions) => positions.join(',');

test('the selector only opens at a non-compulsory question of a selective section', () => {
  const { sid } = selectiveSession();
  const drawn = db.prepare(
    `SELECT sq.q_order, sq.section_key, qp.is_compulsory
       FROM session_questions sq JOIN question_pool qp ON qp.id = sq.question_id
      WHERE sq.session_id = ? ORDER BY sq.q_order`
  ).all(sid.id);
  const compulsory = drawn.find((r) => r.is_compulsory);
  const optional = drawn.find((r) => !r.is_compulsory);
  assert.equal(selection.needsChoice(sessionRow(sid), compulsory), false);
  assert.equal(selection.needsChoice(sessionRow(sid), optional), true);
});

test('the selector lists this session q_orders, and never a template id', async () => {
  const { sid, phone } = selectiveSession(2, 3);
  const pool = poolOf(sid.id, 'b');
  const cap = captureWa();
  try { await selection.sendSelector(phone, sid.id, 'b'); }
  finally { cap.restore(); }
  const list = cap.sent.find((m) => m.kind === 'list');
  assert.ok(list, 'a three-question pool must use an interactive list');
  assert.equal(list.rows.length, pool.length);
  for (const row of list.rows) {
    const qOrder = Number(row.id.split(':')[2]);
    assert.ok(pool.includes(qOrder), `row id must be a session q_order, got ${row.id}`);
  }
});

test('the selector names the compulsory questions and the exact count', async () => {
  const { sid, phone } = selectiveSession(2, 3);
  const cap = captureWa();
  try { await selection.sendSelector(phone, sid.id, 'b'); }
  finally { cap.restore(); }
  const body = cap.sent.find((m) => m.kind === 'list').body;
  assert.match(body, /exactly 2/);
  assert.match(body, /[Cc]ompulsory/);
});

test('a pool over ten falls back to numbered text', async () => {
  const { sid, phone } = selectiveSession(3, 12);
  const cap = captureWa();
  try { await selection.sendSelector(phone, sid.id, 'b'); }
  finally { cap.restore(); }
  assert.equal(cap.sent.find((m) => m.kind === 'list'), undefined, 'twelve rows must not use a list');
  const text = cap.sent.find((m) => m.kind === 'text' && /Reply with the numbers/.test(m.text));
  assert.ok(text, 'the fallback must tell the student how to reply');
});

test('list rows never exceed ten rows or twenty-four title characters', async () => {
  const { sid, phone } = selectiveSession(3, 10);
  const cap = captureWa();
  try { await selection.sendSelector(phone, sid.id, 'b'); }
  finally { cap.restore(); }
  const list = cap.sent.find((m) => m.kind === 'list');
  if (!list) return; // the text path is covered by the test above
  assert.ok(list.rows.length <= 10, 'never more than ten rows');
  for (const r of list.rows) assert.ok(r.title.length <= 24, `row title too long: ${r.title}`);
});

test('CONFIRM with too few chosen is refused and stays open', async () => {
  const { sid, phone } = selectiveSession(2, 3);
  const cap = captureWa();
  try {
    selection.beginChoice(sid.id, 'b');
    await selection.handleReply(sessionRow(sid), { phone }, '1');
    const res = await selection.handleReply(sessionRow(sid), { phone }, 'CONFIRM');
    assert.equal(res.committed, false);
    assert.match(allText(cap.sent), /must choose exactly 2/);
    assert.equal(sessionRow(sid).selection_state, 'selecting');
  } finally { cap.restore(); }
});

test('CONFIRM with the right count commits, prices, and reports committed', async () => {
  const { sid, phone } = selectiveSession(2, 3);
  const pool = poolOf(sid.id, 'b');
  const cap = captureWa();
  try {
    selection.beginChoice(sid.id, 'b');
    await selection.handleReply(sessionRow(sid), { phone }, typePositions(1, 2));
    const res = await selection.handleReply(sessionRow(sid), { phone }, 'CONFIRM');
    assert.equal(res.committed, true, 'exam.js needs this signal to deliver the first question');
    const row = sessionRow(sid);
    assert.equal(row.paper_total, 15, 'compulsory 5 + two chosen 5s');
    assert.equal(row.selection_state, '', 'a committed choice is no longer pending');
    assert.equal(row.selection_tentative, '', 'provisional state is cleared on commit');
    const chosen = db.prepare(
      'SELECT q_order, is_selected FROM session_questions WHERE session_id=? ORDER BY q_order'
    ).all(sid.id);
    assert.equal(chosen.find((r) => r.q_order === pool[0]).is_selected, 1);
    assert.equal(chosen.find((r) => r.q_order === pool[1]).is_selected, 1);
    assert.equal(chosen.find((r) => r.q_order === pool[2]).is_selected, 0);
  } finally { cap.restore(); }
});

test('ticks are provisional until CONFIRM', async () => {
  const { sid, phone } = selectiveSession(2, 3);
  const pool = poolOf(sid.id, 'b');
  const cap = captureWa();
  try {
    selection.beginChoice(sid.id, 'b');
    await selection.handleReply(sessionRow(sid), { phone }, '1');
    const row = sessionRow(sid);
    assert.equal(row.paper_total, 20, 'the paper is not re-priced on a provisional tick');
    const drawn = db.prepare(
      'SELECT q_order, is_selected FROM session_questions WHERE session_id=? ORDER BY q_order'
    ).all(sid.id);
    for (const r of drawn) assert.equal(r.is_selected, 1, 'nothing is deselected before CONFIRM');
    assert.deepEqual(JSON.parse(row.selection_tentative), [pool[0]],
      'position 1 is the first optional question, which is not q_order 1');
  } finally { cap.restore(); }
});

test('CHANGE reopens a committed choice, but only before the first answer', async () => {
  const { sid, phone } = selectiveSession(1, 2);
  const cap = captureWa();
  try {
    selection.beginChoice(sid.id, 'b');
    await selection.handleReply(sessionRow(sid), { phone }, '1');
    await selection.handleReply(sessionRow(sid), { phone }, 'CONFIRM');

    await selection.handleReply(sessionRow(sid), { phone }, 'CHANGE');
    assert.equal(sessionRow(sid).selection_state, 'selecting', 'CHANGE reopens the selector');

    // Record an answer, which closes the window for good.
    const first = db.prepare(
      'SELECT question_id FROM session_questions WHERE session_id=? AND q_order=1'
    ).get(sid.id);
    db.prepare(
      'INSERT INTO answers(session_id,question_id,q_order,answer_text,max_marks) VALUES (?,?,1,?,5)'
    ).run(sid.id, first.question_id, 'x');
    await selection.handleReply(sessionRow(sid), { phone }, 'CHANGE');
    assert.match(allText(cap.sent), /cannot change/i);
  } finally { cap.restore(); }
});

test('a reply that is not a choice re-prompts instead of guessing', async () => {
  const { sid, phone } = selectiveSession();
  const cap = captureWa();
  try {
    selection.beginChoice(sid.id, 'b');
    const res = await selection.handleReply(sessionRow(sid), { phone }, 'what time is it');
    assert.equal(res.committed, false);
    assert.match(allText(cap.sent), /didn't catch that/);
    assert.equal(sessionRow(sid).selection_state, 'selecting');
  } finally { cap.restore(); }
});

test('a fourth tap is refused once the quota is reached', async () => {
  const { sid, phone } = selectiveSession(2, 3);
  const pool = poolOf(sid.id, 'b');
  const cap = captureWa();
  try {
    selection.beginChoice(sid.id, 'b');
    await selection.handleReply(sessionRow(sid), { phone }, '', { replyId: `sel:b:${pool[0]}` });
    await selection.handleReply(sessionRow(sid), { phone }, '', { replyId: `sel:b:${pool[1]}` });
    // Tap the third optional: the quota is full, so it must be refused outright.
    const res = await selection.handleReply(
      sessionRow(sid), { phone }, '', { replyId: `sel:b:${pool[2]}` }
    );
    assert.equal(res.committed, false);
    assert.match(allText(cap.sent), /already 2 chosen/);
    assert.deepEqual(JSON.parse(sessionRow(sid).selection_tentative).sort(), [pool[0], pool[1]].sort(),
      'the refused tap must not be recorded');
  } finally { cap.restore(); }
});

test('tapping the same row twice un-chooses it', async () => {
  const { sid, phone } = selectiveSession(2, 3);
  const pool = poolOf(sid.id, 'b');
  const cap = captureWa();
  try {
    selection.beginChoice(sid.id, 'b');
    await selection.handleReply(sessionRow(sid), { phone }, '', { replyId: `sel:b:${pool[0]}` });
    await selection.handleReply(sessionRow(sid), { phone }, '', { replyId: `sel:b:${pool[0]}` });
    assert.deepEqual(JSON.parse(sessionRow(sid).selection_tentative), [],
      'a second tap on the same row is a toggle off');
  } finally { cap.restore(); }
});

test('a reply with no selector open is left alone', async () => {
  const { sid, phone } = selectiveSession();
  const cap = captureWa();
  try {
    const res = await selection.handleReply(sessionRow(sid), { phone }, '2');
    assert.deepEqual(res, { handled: false, committed: false });
    assert.equal(cap.sent.length, 0, 'nothing is sent when no section is pending');
  } finally { cap.restore(); }
});

test('a student who confirms is actually sent their first chosen question', async () => {
  const { sid, phone } = selectiveSession(2, 3);
  const pool = poolOf(sid.id, 'b');
  const cap = captureWa();
  try {
    const student = { id: 1, phone };
    const compulsory = db.prepare(
      `SELECT sq.q_order FROM session_questions sq
         JOIN question_pool qp ON qp.id = sq.question_id
        WHERE sq.session_id = ? AND qp.is_compulsory = 1 ORDER BY sq.q_order LIMIT 1`
    ).get(sid.id);
    assert.ok(compulsory, 'the fixture needs a compulsory question to deliver first');

    // Deliver up to the optional question; the selector should take over there.
    const atOptional = pool[0];
    const session = sessionRow(sid);
    db.prepare('UPDATE sessions SET current_q_order = ? WHERE id = ?').run(atOptional, session.id);
    const opened = await examSvc.sendQuestionTo(sessionRow(sid), student, atOptional);
    assert.equal(opened, false, 'the selector replaces the question, so nothing was delivered');
    assert.equal(sessionRow(sid).selection_state, 'selecting');

    // Answer the compulsory question, then reach the selector like exam.js does.
    await examSvc.processAnswer(
      sessionRow(sid), student, 'my answer',
    );
    assert.equal(sessionRow(sid).selection_state, 'selecting',
      'answering the compulsory question must not close the pending selector');

    const res = await examSvc.processAnswer(sessionRow(sid), student, '1,2 CONFIRM');
    assert.equal(res, undefined, 'processAnswer returns nothing; delivery is the assertion');

    const fresh = sessionRow(sid);
    assert.equal(fresh.selection_state, '', 'the committed choice is no longer pending');
    assert.equal(fresh.current_q_order, pool[0],
      'delivery resumed at the first question the student chose');
    assert.ok(allText(cap.sent).includes('Locked in'), 'the commit is acknowledged to the student');
  } finally { cap.restore(); }
});

const results = require('../src/services/results');

// ── Task 5: grading against the priced paper ───────────────────────────

// answers.question_id points at the DRAWN question — question_pool.id, reached
// through session_questions — which is what a real inbound answer carries. The
// column has no FK precisely because template rows also exist, so nothing stops a
// test from quietly using a template id and testing a shape production never makes.
function answerFirst(sid, marks) {
  const q = db.prepare(
    'SELECT question_id, q_order FROM session_questions WHERE session_id=? ORDER BY q_order'
  ).get(sid);
  db.prepare(
    `INSERT INTO answers(session_id,question_id,q_order,answer_text,marks_awarded,max_marks,marked_by)
     VALUES (?,?,?,'x',?,?,'auto')`
  ).run(sid, q.question_id, q.q_order, marks, marks);
}

test('the denominator is the priced paper, not just what was answered', () => {
  const eid = paperExam([{ marks: 10 }, { marks: 10 }, { marks: 10 }]);
  const sid = examSvc.createSession(eid, 1);
  answerFirst(sid.id, 10);
  const r = results.computeForSession(sid.id);
  assert.equal(r.totalMarks, 30, 'all three questions are owed, even though one was answered');
  assert.equal(r.score, 10);
  assert.equal(r.priceSource, 'priced');
});

test('a chosen paper is billed for the choice, not the whole pool', () => {
  const eid = paperExam([
    { marks: 10, compulsory: true, section: 'b' },
    { marks: 10, compulsory: false, section: 'b' },
    { marks: 10, compulsory: false, section: 'b' },
    { marks: 10, compulsory: false, section: 'b' },
  ]);
  rule(eid, 'b', 'SECTION B', 2);
  const sid = examSvc.createSession(eid, 1);
  const pool = poolOf(sid.id, 'b');
  selection.applySelection(sid.id, 'b', pool.slice(0, 2));

  // Answer everything the student actually chose: the compulsory question plus
  // both picks. The third question was deselected and must not be owed.
  const owed = db.prepare(
    `SELECT sq.q_order, qp.id AS pool_id, qp.marks FROM session_questions sq
       JOIN question_pool qp ON qp.id = sq.question_id
      WHERE sq.session_id = ? AND sq.is_selected = 1 ORDER BY sq.q_order`
  ).all(sid.id);
  assert.equal(owed.length, 3, 'one compulsory plus two chosen');
  for (const q of owed) {
    db.prepare(
      `INSERT INTO answers(session_id,question_id,q_order,answer_text,marks_awarded,max_marks,marked_by)
       VALUES (?,?,?,'x',?,?,'auto')`
    ).run(sid.id, q.pool_id, q.q_order, q.marks, q.marks);
  }

  const r = results.computeForSession(sid.id);
  assert.equal(r.totalMarks, 30, 'compulsory 10 + two chosen 10s');
  assert.equal(r.score, 30);
  assert.equal(r.percentage, 100, 'answering everything they chose is a full mark, not 3/4');
});

test('skipping the hard questions cannot raise a percentage', () => {
  const eid = paperExam([{ marks: 1 }, { marks: 9 }]);
  const sid = examSvc.createSession(eid, 1);
  answerFirst(sid.id, 1);
  const r = results.computeForSession(sid.id);
  assert.equal(r.totalMarks, 10);
  assert.equal(r.percentage, 10, 'answering only the 1-mark question scores 10%, not 100%');
});

test('a live session predating paper_total is priced from what it was drawn, not answered', () => {
  const eid = paperExam([{ marks: 4 }, { marks: 6 }]);
  const sid = examSvc.createSession(eid, 1);
  // Simulate a session created before this feature: no recorded price. It is
  // still live, so it has not been graded yet and gets graded honestly below.
  db.prepare('UPDATE sessions SET paper_total = 0 WHERE id = ?').run(sid.id);
  answerFirst(sid.id, 4);
  const r = results.computeForSession(sid.id);
  assert.equal(r.priceSource, 'drawn');
  assert.equal(
    r.totalMarks, 10,
    'an ungraded attempt is owed both questions it was drawn; summing only the answer would report 4/4 = 100%'
  );
  assert.equal(r.percentage, 40);
});

test('an already-graded legacy attempt keeps the percentage it was published with', () => {
  // A student who already saw a result on WhatsApp, a certificate or a printed
  // roster must not have it retroactively rewritten. Under the old rule this
  // timed-out attempt scored 2 of 4 answered questions, both at full marks, and
  // read 10/10 = 100%. Repricing it would drop it to 50% and could turn a
  // published PASS into a FAIL, so a finished session with no recorded price is
  // deliberately left on the denominator it was graded against.
  const eid = paperExam([{ marks: 5 }, { marks: 5 }, { marks: 5 }, { marks: 5 }]);
  db.prepare('UPDATE exams SET pass_percentage = 50 WHERE id = ?').run(eid);
  const sid = examSvc.createSession(eid, 1);
  db.prepare('UPDATE sessions SET paper_total = 0, status = ? WHERE id = ?').run('ended', sid.id);

  for (const row of db.prepare(
    'SELECT question_id, q_order FROM session_questions WHERE session_id=? AND q_order<=2 ORDER BY q_order'
  ).all(sid.id)) {
    db.prepare(
      `INSERT INTO answers(session_id,question_id,q_order,answer_text,marks_awarded,max_marks,marked_by)
       VALUES (?,?,?,'x',5,5,'auto')`
    ).run(sid.id, row.question_id, row.q_order);
  }

  // Simulate the state finalize left behind when it graded this attempt under
  // the old rule: published grade persisted, no paper_total.
  db.prepare('UPDATE sessions SET final_score = 10, final_percentage = 100, passed = 1 WHERE id = ?').run(sid.id);

  const r = results.computeForSession(sid.id);
  assert.equal(r.priceSource, 'stored');
  assert.equal(r.score, 10);
  assert.equal(r.percentage, 100, 'the grade this student was already shown');
  assert.equal(r.passed, true);
  assert.equal(
    r.totalMarks, 20,
    'totalMarks falls back to drawnTotal: the paper still had 4 questions worth 20, so certificates and result messages keep showing the real paper size'
  );

  // passed is still derived from the frozen percentage against the exam's current
  // bar, which is how it behaved before this change too: editing the pass mark
  // reclassifies an old attempt, it does not regrade it. The percentage is what
  // must not move.
  // The whole point: repricing logic must not reach in and rewrite it. Even after
  // the answers are edited, the published grade stands.
  db.prepare(
    `UPDATE answers SET marks_awarded = 0 WHERE session_id = ?
       AND q_order = 1`
  ).run(sid.id);
  const after = results.computeForSession(sid.id);
  assert.equal(after.percentage, 100, 'a regrade does not rewrite a published result');
  assert.equal(after.score, 10);
});

test('a live legacy attempt is repriced the moment it is graded', () => {
  // The same attempt shape, but still live: nothing has been published yet, so
  // finishing it under the new rule is the whole point of this feature. This is
  // what stops a student from improving their score by running out of time.
  const eid = paperExam([{ marks: 5 }, { marks: 5 }, { marks: 5 }, { marks: 5 }]);
  db.prepare('UPDATE exams SET pass_percentage = 50 WHERE id = ?').run(eid);
  const sid = examSvc.createSession(eid, 1);
  db.prepare('UPDATE sessions SET paper_total = 0 WHERE id = ?').run(sid.id);

  for (const row of db.prepare(
    'SELECT question_id, q_order FROM session_questions WHERE session_id=? AND q_order<=2 ORDER BY q_order'
  ).all(sid.id)) {
    db.prepare(
      `INSERT INTO answers(session_id,question_id,q_order,answer_text,marks_awarded,max_marks,marked_by)
       VALUES (?,?,?,'x',5,5,'auto')`
    ).run(sid.id, row.question_id, row.q_order);
  }

  assert.equal(results.computeForSession(sid.id).percentage, 50, 'live, so priced from the 4 drawn');

  // finalize() grades while still in_progress, persists, then flips the status.
  // Replay that exact order so this test fails if anyone moves the status
  // update ahead of the persistence.
  const graded = results.computeForSession(sid.id);
  db.prepare(
    `UPDATE sessions SET status = 'completed', final_score = ?, final_percentage = ?, passed = ? WHERE id = ?`
  ).run(graded.score, graded.percentage, graded.passed ? 1 : 0, sid.id);

  // An attempt that finished after this deploy was repriced on the way in, so
  // the stored 50% is the grade that was published and it must be reported as
  // such. Reporting the pre-feature denominator here would contradict both the
  // stored column and the message the student received.
  const finished = results.computeForSession(sid.id);
  assert.equal(finished.priceSource, 'stored');
  assert.equal(finished.totalMarks, 20);
  assert.equal(finished.percentage, 50, 'the repriced grade finalize published and stored');
  assert.equal(finished.score, 10);
  assert.equal(
    finished.score / finished.totalMarks * 100, finished.percentage,
    'percentage and totalMarks agree here because finalize repriced both together'
  );
});

// ── Task 6: admin API ──────────────────────────────────────────────────

const express = require('express');
const http = require('node:http');
const auth = require('../src/auth');
const api = require('../src/routes/api');

let srv;
let baseUrl;
let adminToken;

const beforeRoute = async () => {
  adminToken = auth.adminToken();
  const app = express();
  app.use(express.json());
  app.use('/api', api);
  await new Promise((r) => { srv = app.listen(0, '127.0.0.1', r); });
  baseUrl = `http://127.0.0.1:${srv.address().port}`;
};
const afterRoute = () => new Promise((r) => srv?.close(r));

// Real HTTP against the mounted router (the pattern test/recipient-route.test.js
// already uses). Source-text assertions would only prove the strings exist, not
// that the route accepts them, scopes them to the exam, or coerces the values.
async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('the question routes round-trip the selection columns', async () => {
  await beforeRoute();
  try {
    const eid = db.prepare(
      "INSERT INTO exams(title,duration_minutes,status) VALUES ('Sec',30,'published')"
    ).run().lastInsertRowid;

    // POST must accept them...
    const created = await call('POST', `/api/exams/${eid}/questions`, {
      type: 'theory', text: 'B1', marks: 7, is_compulsory: 0, section_key: 'b',
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.is_compulsory, 0, 'POST persisted the flag');
    assert.equal(created.body.section_key, 'b', 'POST persisted the section');
    assert.equal(created.body.marks, 7, 'the rest of the payload is unaffected');

    // ...and the batch route too, since it has its own INSERT.
    const batch = await call('POST', `/api/exams/${eid}/questions/batch`, {
      questions: [
        { type: 'theory', text: 'B2', marks: 3, is_compulsory: false, section_key: 'b' },
        { type: 'theory', text: 'B3', marks: 3 },
      ],
    });
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
    const stored = db.prepare('SELECT section_key, is_compulsory FROM questions WHERE exam_id=? ORDER BY q_order').all(eid);
    assert.equal(stored[1].section_key, 'b', 'the batch insert kept the section');
    assert.equal(stored[1].is_compulsory, 0);
    assert.equal(stored[2].section_key, '', 'an omitted section defaults to empty, not null');
    assert.equal(stored[2].is_compulsory, 1, 'an omitted flag defaults to compulsory');

    // PUT must be able to flip the flag and move the question between sections.
    const qid = stored[0].id !== undefined ? stored[0].id : created.body.id;
    const target = db.prepare('SELECT id FROM questions WHERE exam_id=? AND text=?').get(eid, 'B1').id;
    const flipped = await call('PUT', `/api/exams/${eid}/questions/${target}`, {
      is_compulsory: 1, section_key: 'c',
    });
    assert.equal(flipped.status, 200, JSON.stringify(flipped.body));
    const after = db.prepare('SELECT is_compulsory, section_key FROM questions WHERE id=?').get(target);
    assert.equal(after.is_compulsory, 1, 'PUT flipped the flag');
    assert.equal(after.section_key, 'c', 'PUT moved the question');
    assert.ok(qid || target);

    // GET /exams/:id must expose both, or the admin UI cannot render them.
    const got = await call('GET', `/api/exams/${eid}`);
    assert.equal(got.status, 200);
    const row = got.body.questions.find((q) => q.id === target);
    assert.equal(row.is_compulsory, 1);
    assert.equal(row.section_key, 'c');
  } finally { await afterRoute(); }
});

test('PATCH /exams/:id/sections upserts, clamps, and deletes what is gone', async () => {
  await beforeRoute();
  try {
    const eid = db.prepare(
      "INSERT INTO exams(title,duration_minutes,status) VALUES ('Sec2',30,'published')"
    ).run().lastInsertRowid;
    for (const t of ['B1', 'B2', 'B3']) {
      db.prepare(
        `INSERT INTO questions(exam_id,q_order,type,text,marks,is_compulsory,section_key)
         VALUES (?,?,'theory',?,5,0,'b')`
      ).run(eid, db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id=?').get(eid).c + 1, t);
    }

    // A quota covering the whole pool is answer-all, so storing it would show the
    // admin a rule that can never fire.
    const first = await call('PATCH', `/api/exams/${eid}/sections`, {
      sections: [{ section_key: 'b', title: 'SECTION B', instructions: 'Answer two', position: 1, answer_count: 9 }],
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.sections.length, 1);
    assert.equal(first.body.sections[0].answer_count, 3, 'clamped to the pool size of 3');

    // Re-saving the same key must revise, not duplicate.
    await call('PATCH', `/api/exams/${eid}/sections`, {
      sections: [{ section_key: 'b', title: 'SECTION B (revised)', instructions: 'Answer one', position: 1, answer_count: 1 }],
    });
    const rows = db.prepare('SELECT * FROM exam_sections WHERE exam_id=?').all(eid);
    assert.equal(rows.length, 1, 'one row per section key');
    assert.equal(rows[0].answer_count, 1);
    assert.equal(rows[0].instructions, 'Answer one');

    // A key that disappears is removed rather than left orphaned.
    await call('PATCH', `/api/exams/${eid}/sections`, {
      sections: [{ section_key: 'c', title: 'SECTION C', position: 2, answer_count: 1 }],
    });
    const afterSwap = db.prepare('SELECT section_key FROM exam_sections WHERE exam_id=?').all(eid);
    assert.deepEqual(afterSwap.map((r) => r.section_key), ['c'], 'the dropped rule is gone');

    // The dangerous case: an admin who clears the card and saves sends [].
    // Guarding the delete on a non-empty list would keep every old rule here.
    const cleared = await call('PATCH', `/api/exams/${eid}/sections`, { sections: [] });
    assert.equal(cleared.status, 200);
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM exam_sections WHERE exam_id=?').get(eid).c, 0,
      'an empty sections array must remove the rules, not leave them orphaned'
    );

    // GET must surface the rules AND the derived plan the dashboard renders.
    db.prepare(
      `INSERT INTO exam_sections(exam_id,section_key,title,instructions,position,answer_count)
       VALUES (?,'b','SECTION B','Answer one',1,1)`
    ).run(eid);
    const got = await call('GET', `/api/exams/${eid}`);
    assert.equal(got.body.sections.length, 1);
    assert.ok(Array.isArray(got.body.selection), 'the derived selection plan is exposed');
    assert.equal(got.body.selection[0].quota, 1);
  } finally { await afterRoute(); }
});

test('a quota saved for a section with nothing optional makes it a choice', async () => {
  await beforeRoute();
  try {
    const eid = db.prepare(
      "INSERT INTO exams(title,duration_minutes,status) VALUES ('Sec3',30,'published')"
    ).run().lastInsertRowid;
    // The shape an import leaves behind when the paper's own instruction could
    // not be read: every question keeps the compulsory default, so a rule
    // saved over them would clamp to 0 and the student would never be offered
    // a single question to choose.
    for (const t of ['C1', 'C2', 'C3', 'C4']) {
      db.prepare(
        `INSERT INTO questions(exam_id,q_order,type,text,marks,is_compulsory,section_key)
         VALUES (?,?,'theory',?,5,1,'c')`
      ).run(eid, db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id=?').get(eid).c + 1, t);
    }

    const patched = await call('PATCH', `/api/exams/${eid}/sections`, {
      sections: [{ section_key: 'c', title: 'SECTION C', position: 1, answer_count: 2 }],
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(
      patched.body.sections[0].answer_count, 2,
      'the typed quota survives instead of collapsing to answer-all'
    );

    const optional = db
      .prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ? AND is_compulsory = 0')
      .get(eid).c;
    assert.equal(optional, 4, 'the quota means nothing until its questions are optional');

    const got = await call('GET', `/api/exams/${eid}`);
    assert.equal(got.body.selection[0].quota, 2, 'the plan the dashboard renders carries the live quota');
    assert.equal(got.body.selection[0].optional.length, 4, 'and every question it may offer');
  } finally { await afterRoute(); }
});

test('selection rules are frozen once an exam goes live', async () => {
  await beforeRoute();
  try {
    const eid = db.prepare(
      "INSERT INTO exams(title,duration_minutes,status) VALUES ('Live',30,'live')"
    ).run().lastInsertRowid;
    const res = await call('PATCH', `/api/exams/${eid}/sections`, {
      sections: [{ section_key: 'b', title: 'B', position: 1, answer_count: 1 }],
    });
    assert.equal(res.status, 400, 'a live exam must not be re-priced under running students');
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM exam_sections WHERE exam_id=?').get(eid).c, 0,
      'the rejected write must not partially apply'
    );
  } finally { await afterRoute(); }
});

// ── Task 3: drawing and ordering ───────────────────────────────────────

function order(eid) {
  const sid = examSvc.createSession(eid, 1);
  return examSvc.sessionQuestionSequence(db.prepare('SELECT * FROM sessions WHERE id=?').get(sid.id))
    .map((q) => q.text);
}

test('an exam with no rules keeps the objective-first order', () => {
  const eid = paperExam([
    { type: 'theory' },
    { type: 'objective' },
    { type: 'theory' },
  ]);
  // paperExam writes text as Q<n>; rename so the assertion is readable.
  db.prepare("UPDATE questions SET text='T1' WHERE exam_id=? AND q_order=1").run(eid);
  db.prepare("UPDATE questions SET text='O1' WHERE exam_id=? AND q_order=2").run(eid);
  db.prepare("UPDATE questions SET text='T2' WHERE exam_id=? AND q_order=3").run(eid);
  assert.deepEqual(order(eid), ['O1', 'T1', 'T2'], 'unchanged behaviour for quota-free exams');
});

test('a selective exam orders by section, then paper order within it', () => {
  const eid = paperExam([
    { section: 'a' }, { section: 'a' },
    { section: 'b', compulsory: false }, { section: 'b', compulsory: false },
  ]);
  rule(eid, 'b', 'SECTION B', 1);
  db.prepare('UPDATE questions SET is_compulsory=0 WHERE exam_id=? AND section_key=?').run(eid, 'a');
  const seq = order(eid);
  const sectionA = seq.filter((t) => t === 'Q1' || t === 'Q2');
  assert.deepEqual(sectionA, ['Q1', 'Q2'], 'section A stays in paper order');
});

test('only selected questions reach the sequence', () => {
  const eid = paperExam([
    { section: 'b', compulsory: true },
    { section: 'b', compulsory: false },
    { section: 'b', compulsory: false },
  ]);
  rule(eid, 'b', 'SECTION B', 1);
  const sid = examSvc.createSession(eid, 1);
  const pool = poolOf(sid.id, 'b');
  selection.applySelection(sid.id, 'b', [pool[0]]);
  const seq = examSvc.sessionQuestionSequence(db.prepare('SELECT * FROM sessions WHERE id=?').get(sid.id));
  assert.equal(seq.length, 2, 'compulsory + one chosen');
});

test('a session records its paper total the moment it is created', () => {
  const eid = paperExam([{ marks: 3 }, { marks: 7 }]);
  const sid = examSvc.createSession(eid, 1);
  const row = db.prepare('SELECT paper_total FROM sessions WHERE id=?').get(sid.id);
  assert.equal(row.paper_total, 10);
});

test('topUpPool copies the selection columns into the pool', () => {
  const eid = paperExam([
    { section: 'b', compulsory: false, marks: 6 },
  ]);
  rule(eid, 'b', 'SECTION B', 1);
  db.prepare('DELETE FROM question_pool WHERE exam_id = ?').run(eid);
  examSvc.createSession(eid, 1);
  const pooled = db.prepare('SELECT * FROM question_pool WHERE exam_id=?').all(eid);
  assert.equal(pooled.length, 1);
  assert.equal(pooled[0].is_compulsory, 0, 'the pool copy must keep compulsory = 0');
  assert.equal(pooled[0].section_key, 'b');
  // The limbs live on the template only, so a draw that did not carry them
  // over would silently deliver the stem with no sub-questions at all.
  assert.equal(pooled[0].follow_ups, '[]', 'an empty limb list is copied as an empty list');
  const templated = db.prepare('SELECT id FROM questions WHERE exam_id=?').get(eid);
  assert.equal(
    pooled[0].template_id, templated.id,
    'the pool row points back at its template: figure bubbles hang off that id'
  );
});

test('nextInSequence steps over a question the student deselected', () => {
  const eid = paperExam([
    { section: 'b', compulsory: true },
    { section: 'b', compulsory: false },
    { section: 'b', compulsory: false },
    { section: 'b', compulsory: false },
  ]);
  rule(eid, 'b', 'SECTION B', 1);
  const sid = examSvc.createSession(eid, 1);
  const pool = poolOf(sid.id, 'b');
  // Keep only the first optional; the rest are deselected. A question id that is
  // not in the sequence drives the q_order + 1 fallback, which is the path that
  // would otherwise hand back a question the student explicitly rejected.
  selection.applySelection(sid.id, 'b', [pool[0]]);
  const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(sid.id);
  assert.equal(selection.sessionPlan(sid.id)[0].quota, 1);

  const next = examSvc.nextInSequence(session, { id: -1, q_order: pool[0] });
  assert.equal(next, null, `q_order ${pool[0] + 1} was deselected, so there is nothing after it`);
});

// ── Task 9: the whole paper, walked end to end ─────────────────────────

test('a selective paper is walked end to end: compulsory first, then the choice', async () => {
  // Section A is answer-all. Section B holds three optional questions and the
  // quota is two. The pool MUST exceed the quota: a two-question pool with
  // answer_count 2 clamps to answer-all, the selector never opens, and the
  // failure reads as "the feature does not work" rather than as a bad fixture.
  const eid = paperExam([
    { compulsory: true, section: 'a' },
    { compulsory: true, section: 'a' },
    { compulsory: false, section: 'b' },
    { compulsory: false, section: 'b' },
    { compulsory: false, section: 'b' },
  ]);
  rule(eid, 'a', 'SECTION A', 0);
  rule(eid, 'b', 'SECTION B', 2);

  // handleInbound resolves the student from the phone, then looks up THEIR active
  // session. Binding the session to an unrelated student id would have
  // getOrCreateStudent mint a second student with no session, and every reply
  // would fall through to the "no pending exams" branch instead of grading.
  const phone = '23355500000';
  const studentId = db.prepare('INSERT INTO students(phone) VALUES (?)').run(phone).lastInsertRowid;
  db.prepare('INSERT INTO exam_recipients(exam_id,student_id) VALUES (?,?)').run(eid, studentId);
  const sid = examSvc.createSession(eid, studentId);
  const pool = poolOf(sid.id, 'b');          // session q_orders, never template ids
  assert.equal(pool.length, 3, 'three selectable questions');

  // A free-text theory answer kicks off AI-plagiarism detection in the
  // background, which reaches the network and logs a 401 here. It never blocks
  // grading, but the test is about selection, so stub it out.
  const ai = require('../src/services/ai');
  const realDetect = ai.detectAiGeneratedAnswer;
  ai.detectAiGeneratedAnswer = async () => ({ ai_generated: false });

  const cap = captureWa();
  try {
    // No START here. createSession already opened the session, so a START reply
    // would be graded as the answer to the first THEORY question (any text is a
    // valid theory answer) and silently consume it before selection is reached.
    assert.equal(sessionRow(sid).current_q_order, 1, 'compulsory questions come first');

    // Answering the FIRST compulsory question must not open a selector: the
    // student is still inside section A. The assertion belongs here, before the
    // second answer — checked after it, section A is finished and the section B
    // selector is supposed to be open, so the check would fail on correct code.
    await examSvc.handleInbound(phone, 'an answer to A1');
    assert.equal(
      cap.sent.find((m) => m.kind === 'list'), undefined,
      'no selector while section A is still being answered'
    );
    assert.equal(sessionRow(sid).current_q_order, 2, 'still inside section A');

    // The second compulsory answer finishes section A, so now the choice opens.
    await examSvc.handleInbound(phone, 'an answer to A2');
    const selector = cap.sent.find((m) => m.kind === 'list');
    assert.ok(selector, 'the section B selector opens once section A is done');
    assert.equal(selector.rows.length, 3, 'every optional question is offered');
    assert.equal(sessionRow(sid).selection_state, 'selecting');
    assert.equal(sessionRow(sid).selection_section, 'b');
    // current_q_order deliberately stays on the last compulsory question: the
    // selector is a decision, not a delivery, so nothing is owed until the
    // student picks. The commit path lands on the first SELECTED question.
    assert.equal(sessionRow(sid).current_q_order, 2,
      'the position does not advance until the choice is committed');

    // Choose the first and last optional, leaving the middle one behind. Typed
    // replies carry listing POSITIONS (1 and 3 here), not the q_orders the
    // assertions below use — the pool starts at q_order 3, so typing q_orders
    // would silently pick a different question.
    const skippedOrder = pool[1];
    // session_questions holds no text of its own — the wording lives on the pool
    // row it points at.
    const skippedText = db.prepare(
      `SELECT qp.text FROM session_questions sq JOIN question_pool qp ON qp.id = sq.question_id
        WHERE sq.session_id=? AND sq.q_order=?`
    ).get(sid.id, skippedOrder).text;

    await examSvc.handleInbound(phone, `${typePositions(1, 3)} CONFIRM`);
    assert.match(allText(cap.sent), /Locked in/);

    // is_selected lives on session_questions, not on the pool row: the pool is the
    // template, the session row is this student's actual choice.
    const flags = db.prepare(
      `SELECT sq.q_order, sq.is_selected FROM session_questions sq
        WHERE sq.session_id = ? ORDER BY sq.q_order`
    ).all(sid.id);
    assert.equal(flags.find((r) => r.q_order === pool[0]).is_selected, 1);
    assert.equal(flags.find((r) => r.q_order === skippedOrder).is_selected, 0,
      'the unchosen question is deselected');
    assert.equal(flags.find((r) => r.q_order === pool[2]).is_selected, 1);

    // Every question on offer is named while the student is choosing — that IS
    // the choice — so "never delivered" has to be measured from the commit on.
    const lockAt = cap.sent.findIndex((m) => /Locked in/.test(m.text || ''));
    assert.ok(lockAt >= 0, 'the commit is acknowledged to the student');
    const afterChoice = cap.sent.slice(lockAt + 1)
      .map((m) => m.text || m.body || '').join('\n');
    assert.ok(
      !afterChoice.includes(skippedText),
      'the unchosen question is never delivered'
    );
    assert.equal(sessionRow(sid).selection_state, '', 'the selection window closed on commit');
    assert.equal(sessionRow(sid).selection_tentative, '', 'no provisional state survives the commit');
    assert.equal(sessionRow(sid).current_q_order, pool[0],
      'the commit lands on the first selected question, not the skipped middle one');
  } finally { ai.detectAiGeneratedAnswer = realDetect; cap.restore(); }
});

test('clearing the rules deletes them all', () => {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Clear',30,'live')").run().lastInsertRowid;
  db.prepare(
    `INSERT INTO exam_sections(exam_id,section_key,title,instructions,position,answer_count)
     VALUES (?,?,?,?,?,?)`
  ).run(eid, 'b', 'SECTION B', 'Answer two', 1, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM exam_sections WHERE exam_id=?').get(eid).c, 1);

  // The body an admin sends after emptying the card is { sections: [] }.
  db.prepare('DELETE FROM exam_sections WHERE exam_id = ?').run(eid);
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM exam_sections WHERE exam_id=?').get(eid).c, 0,
    'an empty sections array must remove the rules, not leave them orphaned'
  );
});