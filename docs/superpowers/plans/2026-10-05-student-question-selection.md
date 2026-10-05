# Student Question Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a student choose which questions to answer when an exam paper says "answer any N of M", with compulsory questions excluded from the choice, rules auto-detected from the uploaded PDF and overridable by the admin.

**Architecture:** A new `src/services/selection.js` owns everything quota-shaped (rule resolution, selector rendering, reply parsing, commit) and `exam.js` calls into it at four existing seams. All schema changes are additive; `session_questions.is_selected` defaults to `1`, which is what makes the feature opt-in with no data migration and no change to any existing exam.

**Tech Stack:** Node.js 22.5+ (`node:sqlite` `DatabaseSync`, no native builds), plain CommonJS, Express, `node --test`. WhatsApp Cloud API via the existing `whatsapp.js` helpers. No new dependencies.

**Spec:** `docs/plans/2026-10-05-student-question-selection-design.md`

## Global Constraints

- Test command is `node --test test/question-selection.test.js` (single file) or `node --test test/selection-rules.test.js`. Run from the repo root.
- Every test file sets `process.env.DB_PATH`, `UPLOADS_DIR`, `DOTENV_CONFIG_PATH`, `SEED_ON_BOOT='false'` **before** requiring `../src/db`, and registers `after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); })`. Copy `test/timer-start.test.js:1-19` verbatim.
- **No new npm dependencies.** `sendInteractiveList` and `sendInteractiveButtons` already exist in `src/services/whatsapp.js:216-252`.
- WhatsApp list rows cap at **10 rows per message**; row `title` caps at **24 characters**. Enforce both.
- WhatsApp buttons cap at **3 per message**.
- `question_pool` rows and `questions` rows must carry identical selection columns. Any `INSERT INTO question_pool` must list the new columns explicitly — see the existing warning at `src/services/exam.js:525` about column lists and placeholder counts drifting apart.
- All timestamps written to `started_at` use ISO-8601 with a `Z` suffix, never a SQLite `datetime('now')` value. See `src/services/exam.js:936`.
- Comments explain **why**, not what. Match the density and tone of the surrounding file.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/services/selection.js` | **New.** Owns rules + selector + reply parsing + commit. No knowledge of bubbles or question formatting. |
| `src/db.js` | Additive schema: `exam_sections` table, `is_compulsory`/`section_key` on `questions` and `question_pool`, `selection_state`/`selection_section`/`paper_total` on `sessions`, `is_selected`/`section_key` on `session_questions`. |
| `src/services/exam.js` | Four seams call `selection.*`; draw/sequence honour `is_selected`; `topUpPool` copies new columns; intro states the rule. |
| `src/services/results.js` | `computeForSession` divides by `sessions.paper_total`. |
| `src/services/ai.js` | Extraction prompt returns a structured `selection` array. |
| `src/services/pdfImport.js` | Reconcile the AI's rules against saved questions. |
| `src/routes/api.js` | `PATCH /exams/:id/sections`; `is_compulsory`/`section_key` on question POST/PUT/batch; expose both in `qWithScheme`. |
| `src/public/app.js` | Compulsory checkbox + section select on the question form; Selection-rules card; rule summary in `editExamMeta`. |

`selection.js` is deliberately the only new module. Its exported surface is fixed so `exam.js` seams stay one line each.

---

## Task 1: Schema and migration

Everything downstream reads these columns, so they land first and alone.

**Files:**
- Modify: `src/db.js` (inside the `SCHEMA` template string, after the `question_images` block; and after the `ensureColumn` calls near line 254)
- Test: `test/question-selection.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: columns `questions.is_compulsory`, `questions.section_key`, `questions.source_number`, `question_pool.is_compulsory`, `question_pool.section_key`, `sessions.selection_state`, `sessions.selection_section`, `sessions.selection_tentative`, `sessions.paper_total`, `session_questions.is_selected`, `session_questions.section_key`; table `exam_sections(exam_id, section_key, title, instructions, position, answer_count)`.

- [ ] **Step 1: Write the failing test**

Create `test/question-selection.test.js`:

```js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-selection-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.DOTENV_CONFIG_PATH = path.join(tmp, '.env');
process.env.SEED_ON_BOOT = 'false';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const cols = (table) =>
  db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

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
  const qid = db.prepare('INSERT INTO questions(exam_id,q_order,type,text,source_number) VALUES (?,1,\'theory\',\'Q\',7)')
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
  const qid = db.prepare("INSERT INTO questions(exam_id,q_order,type,text) VALUES (?,1,'theory','Q')").run(eid).lastInsertRowid;
  const sid = db.prepare('INSERT INTO sessions(exam_id,student_id) VALUES (?,1)').run(eid).lastInsertRowid;
  db.prepare('INSERT INTO session_questions(session_id,question_id,q_order) VALUES (?,?,1)').run(sid, qid);
  const row = db.prepare('SELECT * FROM session_questions WHERE session_id=?').get(sid);
  assert.equal(row.is_selected, 1, 'is_selected must default to 1 or every existing exam loses questions');
  assert.equal(row.section_key, '');
});

test('a session starts unlocked with no paper total recorded', () => {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Session',30,'live')").run().lastInsertRowid;
  const sid = db.prepare('INSERT INTO sessions(exam_id,student_id) VALUES (?,1)').run(eid).lastInsertRowid;
  const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(sid);
  assert.equal(s.selection_state, '');
  assert.equal(s.selection_section, '');
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/question-selection.test.js`
Expected: FAIL — `questions.is_compulsory` missing, and `INSERT INTO exam_sections` throws `no such table`.

- [ ] **Step 3: Add the table and indexes to the SCHEMA template**

In `src/db.js`, inside the `SCHEMA` backtick string, after the `question_images` table block (ends line 201), add:

```sql
-- "Answer any N of M" rules. One row per paper section that carries a quota;
-- answer_count = 0 means the section is answered in full and never prompts.
CREATE TABLE IF NOT EXISTS exam_sections (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id      INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  section_key  TEXT    NOT NULL,        -- stable slug matching questions.section_key
  title        TEXT    DEFAULT '',     -- "SECTION B"
  instructions TEXT    DEFAULT '',     -- the paper's verbatim line, shown to the student
  position     INTEGER NOT NULL DEFAULT 0,
  answer_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(exam_id, section_key)
);
CREATE INDEX IF NOT EXISTS idx_exam_sections_exam ON exam_sections(exam_id, position);
```

- [ ] **Step 4: Add the additive column migrations**

Immediately after the existing `ensureColumn` calls in `src/db.js` (the block ends with `ensureColumn('exams', 'max_attempts', ...)` at line 254), add:

```js
// "Answer any N of M" selection. is_compulsory defaults to 1 so every existing
// question is compulsory and every existing exam behaves exactly as before;
// is_selected defaults to 1 for the same reason on the per-session snapshot.
ensureColumn('questions', 'is_compulsory', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('questions', 'section_key', "TEXT NOT NULL DEFAULT ''");
// The paper's own question number. Import assigns q_order by insertion order,
// so q_order silently diverges from the printed number the moment a block is
// dropped or merged. PDF rule reconciliation must match on this instead.
ensureColumn('questions', 'source_number', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('question_pool', 'is_compulsory', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('question_pool', 'section_key', "TEXT NOT NULL DEFAULT ''");
ensureColumn('sessions', 'selection_state', "TEXT NOT NULL DEFAULT ''");
ensureColumn('sessions', 'selection_section', "TEXT NOT NULL DEFAULT ''");
// Provisional ticks live here, NOT in session_questions.is_selected, which is the
// committed answer. A student who taps two questions and then goes quiet must not
// have silently deselected anything.
ensureColumn('sessions', 'selection_tentative', "TEXT NOT NULL DEFAULT ''");
ensureColumn('sessions', 'paper_total', 'REAL NOT NULL DEFAULT 0');
ensureColumn('session_questions', 'is_selected', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('session_questions', 'section_key', "TEXT NOT NULL DEFAULT ''");
```

Then add the three new columns to the `CREATE TABLE` definitions so a fresh database gets them from the schema rather than by migration. In `questions` (after line 43, `source TEXT NOT NULL DEFAULT 'manual',`) add:

```sql
  is_compulsory    INTEGER NOT NULL DEFAULT 1,             -- 0 = goes in the selectable pool
  section_key      TEXT    NOT NULL DEFAULT '',            -- '' = implicit single section
  source_number    INTEGER NOT NULL DEFAULT 0,             -- printed number on the paper; 0 = unknown
```

In `question_pool` (after `source TEXT NOT NULL DEFAULT 'ai',`) add the same two lines with the same defaults (`source_number` is not needed here — pool rows are AI-written and carry no printed number). In `sessions` (after `attempt_no INTEGER NOT NULL DEFAULT 1`) add:

```sql
  selection_state   TEXT NOT NULL DEFAULT '',               -- ''|'selecting'
  selection_section TEXT NOT NULL DEFAULT '',
  selection_tentative TEXT NOT NULL DEFAULT '',            -- JSON array of provisional q_orders
  paper_total       REAL NOT NULL DEFAULT 0,
```

> `selection_state` deliberately has no `locked` value. "Is this section already
> chosen?" is derived from the committed `session_questions` rows for that section,
> not stored. A single state column cannot represent two selective sections, which
> is why the plan needs the derived check described in Task 2.

In `session_questions` (after `UNIQUE (session_id, question_id)`) add:

```sql
  is_selected  INTEGER NOT NULL DEFAULT 1,                 -- 0 = in the pool, not chosen
  section_key  TEXT    NOT NULL DEFAULT ''
```

> The two table-rebuild migrations further down `src/db.js` (`sessionsDdl`, `sessionsStartedDdl`) enumerate `sessions` columns explicitly. They are guarded by regexes that only fire on the old schemas, so they will not run here — but if you touch them, add the new columns to both `CREATE TABLE` and `INSERT ... SELECT` lists.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/question-selection.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 6: Confirm the legacy-schema migration tests still pass**

Run: `node --test test/regression.test.js`
Expected: PASS. This file contains the legacy `sessions`/`answers` rebuild fixtures; it is the canary for Task 1's migration edits.

- [ ] **Step 7: Commit**

```bash
git add src/db.js test/question-selection.test.js
git commit -m "feat(db): add section rules and per-question selection columns"
```

---

## Task 2: `selection.js` — rule resolution and commit

The module's pure half. No WhatsApp calls yet; those arrive in Task 4.

**Read this before writing a line.** There are two different id spaces in this
codebase and confusing them is the single easiest way to break this feature:

| Space | Table | Id | Contains |
|---|---|---|---|
| Template | `questions` | `questions.id` | every question written for an exam, including unused pool extras |
| Session | `session_questions` → `question_pool` | `session_questions.q_order` | only the questions THIS student was actually given |

`session_questions.question_id` points at `question_pool.id`, **not** at
`questions.id`. So a template `questions.id` is meaningless as a selection key —
it names a pool row that this student may never see. The student is shown
`*QUESTION 7*`, which is the session `q_order`. **Selection is therefore keyed on
session `q_order`, never on any question id.** Admin and PDF code work in template
space; everything the student touches works in session space. The two helpers
below exist so neither caller has to know that.

**Files:**
- Create: `src/services/selection.js`
- Test: `test/question-selection.test.js` (append)

**Interfaces:**
- Consumes: Task 1's schema.
- Produces:
  - `sectionsForExam(examId) -> Array<{id,section_key,title,instructions,position,answer_count}>` — template space, for the admin UI and PDF reconciliation
  - `sectionPlan(examId) -> Array<{section_key,title,instructions,position,answer_count,quota,compulsory,optional}>` — **template space**, keyed on `questions.id`. `quota` is already clamped, and a section whose clamped quota is `0` or `>= optional.length` is reported with `quota: 0`
  - `sessionPlan(sessionId) -> Array<{section_key,title,instructions,position,quota,compulsory,optional,committed}>` — **session space**, keyed on `session_questions.q_order`. `committed` is derived, not stored
  - `isSelective(sessionId, sectionKey) -> boolean` — session space
  - `needsChoice(session, question) -> boolean` — "is the selector due here?", derived from that question's own `q_order`/section and its section's `committed` flag
  - `applySelection(sessionId, sectionKey, chosenQOrders) -> number` — writes `is_selected` by `q_order`, recomputes `paper_total`, returns the new `paper_total`
  - `computePaperTotal(sessionId) -> number` — Σ marks over selected drawn questions

- [ ] **Step 1: Write the failing tests**

Append to `test/question-selection.test.js`:

```js
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

test('sectionPlan reports a quota clamped to the real pool size', () => {
  const eid = paperExam([
    { compulsory: true, section: 'b' },
    { compulsory: false, section: 'b' },
    { compulsory: false, section: 'b' },
  ]);
  rule(eid, 'b', 'SECTION B', 5);
  const plan = selection.sectionPlan(eid);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].quota, 2, 'quota must clamp to the pool size, not the paper');
  assert.equal(plan[0].optional.length, 2);
  assert.equal(plan[0].compulsory.length, 1);
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
```

> The earlier draft carried a `drawnOf()` fixture that inserted a session by hand
> with `question_id = 0`. It is deleted above: `createSession` already populates the
> pool and the snapshot correctly, and a hand-built row would have exercised the
> wrong id space.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/question-selection.test.js`
Expected: FAIL — `Cannot find module '../src/services/selection'`.

- [ ] **Step 3: Write the module**

Create `src/services/selection.js`:

```js
const db = require('../db');

// ── Rule resolution ────────────────────────────────────────────────────
//
// A section's behaviour is DERIVED, never stored: its exam_sections row gives
// the quota, its questions give the compulsory/optional split. Two derived
// facts decide everything downstream:
//
//   selective = a quota exists AND it is smaller than the optional pool.
//               A quota that covers the whole pool is a no-op selector, so it
//               is suppressed rather than shown to the student.
//   quota     = MIN(answer_count, optional.length)

/** Template space. Admin UI and PDF reconciliation only. */
function sectionsForExam(examId) {
  return db
    .prepare('SELECT * FROM exam_sections WHERE exam_id = ? ORDER BY position, id')
    .all(examId);
}

function questionsInSection(examId, sectionKey) {
  return db
    .prepare('SELECT * FROM questions WHERE exam_id = ? AND section_key = ? ORDER BY q_order')
    .all(examId, sectionKey);
}

/**
 * Template-space plan, keyed on questions.id. Use this for the admin screen and
 * for reconciling a freshly imported PDF against the saved questions. Do NOT use
 * it to drive the selector — a student is only ever shown what they were drawn.
 */
function sectionPlan(examId) {
  const plan = [];
  for (const section of sectionsForExam(examId)) {
    const all = questionsInSection(examId, section.section_key);
    const compulsory = all.filter((q) => q.is_compulsory);
    const optional = all.filter((q) => !q.is_compulsory);
    const quota = Math.min(Math.max(0, section.answer_count), optional.length);
    plan.push({
      section_key: section.section_key,
      title: section.title || '',
      instructions: section.instructions || '',
      position: section.position,
      answer_count: section.answer_count,
      quota: quota > 0 && quota < optional.length ? quota : 0,
      compulsory,
      optional,
    });
  }
  return plan;
}

// ── Session space ──────────────────────────────────────────────────────
//
// Everything from here down is keyed on session_questions.q_order, which is
// the number the student actually sees. session_questions.question_id refers to
// question_pool.id, so template ids cannot be used to select anything.

/**
 * The drawn questions of one section, in the order the student will meet them.
 * session_questions.section_key is copied from the pool row at draw time, so the
 * snapshot stays correct even if the template is edited mid-exam.
 */
function drawnInSection(sessionId, sectionKey) {
  return db
    .prepare(
      `SELECT sq.q_order, sq.question_id, sq.is_selected,
              qp.marks, qp.is_compulsory, qp.type, qp.text
         FROM session_questions sq
         JOIN question_pool qp ON qp.id = sq.question_id
        WHERE sq.session_id = ? AND sq.section_key = ?
        ORDER BY sq.q_order`
    )
    .all(sessionId, sectionKey);
}

/**
 * Has this section already been chosen for this session?
 *
 * Derived rather than stored, because a single sessions.selection_state cannot
 * represent two independent sections: committing section A would otherwise mark
 * section B as done too. A committed section is exactly one where at least one
 * optional question was dropped — which is guaranteed, because a section is only
 * selective when its quota is strictly smaller than its pool, so committing
 * always leaves at least one optional row at is_selected = 0.
 *
 * session_questions has no compulsory flag of its own, so the pool row joined
 * through question_id is the authority for which rows were optional.
 */
function sectionCommitted(sessionId, sectionKey) {
  return db
    .prepare(
      `SELECT COUNT(*) n
         FROM session_questions sq
         JOIN question_pool qp ON qp.id = sq.question_id
        WHERE sq.session_id = ? AND sq.section_key = ?
          AND qp.is_compulsory = 0 AND sq.is_selected = 0`
    )
    .get(sessionId, sectionKey).n > 0;
}

/** Session-space plan. This is what the selector renders and what commits act on. */
function sessionPlan(sessionId) {
  const session = db.prepare('SELECT exam_id FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return [];
  const out = [];
  for (const section of sectionsForExam(session.exam_id)) {
    const all = drawnInSection(sessionId, section.section_key);
    if (!all.length) continue;
    const compulsory = all.filter((q) => q.is_compulsory);
    const optional = all.filter((q) => !q.is_compulsory);
    const quota = Math.min(Math.max(0, section.answer_count), optional.length);
    out.push({
      section_key: section.section_key,
      title: section.title || '',
      instructions: section.instructions || '',
      position: section.position,
      answer_count: section.answer_count,
      quota: quota > 0 && quota < optional.length ? quota : 0,
      compulsory,
      optional,
      committed: sectionCommitted(sessionId, section.section_key),
    });
  }
  return out;
}

function isSelective(sessionId, sectionKey) {
  const found = sessionPlan(sessionId).find((s) => s.section_key === sectionKey);
  return !!found && found.quota > 0 && !found.committed;
}

/**
 * Is the selector due to be shown for the question delivery has just reached?
 *
 * True only at a non-compulsory question of a selective section that has not
 * been committed yet. After the student commits, committed flips and this stops
 * being true, so the selector can never interrupt a second time.
 */
function needsChoice(session, question) {
  if (!question || !question.section_key) return false;
  const sid = session && session.id != null ? session.id : session;
  const sec = sessionPlan(sid).find((s) => s.section_key === question.section_key);
  if (!sec || sec.quota <= 0 || sec.committed) return false;
  return question.is_compulsory === 0;
}

// ── Paper total ────────────────────────────────────────────────────────
//
// The denominator is a stored value, not a sum taken at report time. A student
// who chose 3 of 5 has a paper worth 3 + compulsory; if the admin later edits a
// question's marks that student's percentage must not move under them.

/** Marks of the questions this session will actually be graded on. */
function computePaperTotal(sessionId) {
  const drawn = db
    .prepare(
      `SELECT qp.marks AS marks, sq.is_selected AS is_selected
         FROM session_questions sq
         JOIN question_pool qp ON qp.id = sq.question_id
        WHERE sq.session_id = ?`
    )
    .all(sessionId);
  if (drawn.length) {
    // A pool-drawn exam: only the questions this attempt drew count, and only
    // the selected ones among them.
    return drawn
      .filter((r) => r.is_selected)
      .reduce((sum, r) => sum + Number(r.marks || 0), 0);
  }
  // Template-only exam (no pool draw): fall back to every question of the exam.
  const session = db.prepare('SELECT exam_id FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return 0;
  return db
    .prepare('SELECT COALESCE(SUM(marks),0) t FROM questions WHERE exam_id = ?')
    .get(session.exam_id).t;
}

/**
 * Commit the student's choice for one section and re-price the paper.
 *
 * `chosenQOrders` are session q_orders, matching what the selector displayed.
 * Compulsory questions are never deselected — the paper forced them. The write
 * happens before the first chosen question is sent, so a crash after this point
 * costs the student nothing but a re-send.
 */
function applySelection(sessionId, sectionKey, chosenQOrders) {
  const chosen = new Set((chosenQOrders || []).map(Number));
  const rows = drawnInSection(sessionId, sectionKey);
  const setSel = db.prepare(
    'UPDATE session_questions SET is_selected = ? WHERE session_id = ? AND q_order = ?'
  );
  for (const row of rows) {
    if (row.is_compulsory) continue; // forced by the paper
    setSel.run(chosen.has(row.q_order) ? 1 : 0, sessionId, row.q_order);
  }
  const total = computePaperTotal(sessionId);
  // Clear any provisional state; the choice is now committed.
  db.prepare(
    `UPDATE sessions SET paper_total = ?, selection_state = '', selection_section = '',
                        selection_tentative = ''
      WHERE id = ?`
  ).run(total, sessionId);
  return total;
}

module.exports = {
  sectionsForExam,
  sectionPlan,
  sessionPlan,
  isSelective,
  needsChoice,
  computePaperTotal,
  applySelection,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/question-selection.test.js`
Expected: PASS. `applySelection` reads `question_pool`, which Task 3 populates; if `computePaperTotal` returns 0, Task 3 is what is missing — do not paper over it here.

- [ ] **Step 5: Run the full suite to catch regressions**

Run: `npm test`
Expected: PASS. Any failure in `regression.test.js` around session drawing is a Task 3 regression leaking backwards — stop and diagnose.

- [ ] **Step 6: Commit**

```bash
git add src/services/selection.js test/question-selection.test.js
git commit -m "feat(selection): derive section quotas and price the paper"
```

---

## Task 3: Drawing and ordering

Make `is_selected` and `section_key` real in the session snapshot, and make
section ordering engage only when the exam actually has a quota.

**Files:**
- Modify: `src/services/exam.js` — `drawSessionQuestions` (line 267), `topUpPool` (line 298), `sessionQuestionSequence` (line 350), `nextInSequence` (line 387)
- Test: `test/question-selection.test.js` (append)

**Interfaces:**
- Consumes: Task 2's `selection.isSelective`, `selection.sectionPlan`, `selection.computePaperTotal`.
- Produces: unchanged public signatures, but `sessionQuestionSequence(session)` now returns only selected questions in section order, and every session row gets `paper_total` set at creation.

- [ ] **Step 1: Write the failing tests**

Append to `test/question-selection.test.js`:

```js
const examSvc = require('../src/services/exam');

function order(eid) {
  const exam = require('../src/services/exam');
  const sid = exam.createSession(eid, 1);
  return exam.sessionQuestionSequence(db.prepare('SELECT * FROM sessions WHERE id=?').get(sid.id))
    .map((q) => q.text);
}

test('an exam with no rules keeps the objective-first order', () => {
  const eid = paperExam([
    { type: 'theory', text: 'T1' },
    { type: 'objective', text: 'O1' },
    { type: 'theory', text: 'T2' },
  ]);
  // paperExam writes text as Q<n>; rewrite so the assertion is readable.
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
  const exam = require('../src/services/exam');
  const sid = exam.createSession(eid, 1);
  const row = db.prepare('SELECT paper_total FROM sessions WHERE id=?').get(sid.id);
  assert.equal(row.paper_total, 10);
});

test('topUpPool copies the selection columns into the pool', () => {
  const eid = paperExam([
    { section: 'b', compulsory: false, marks: 6 },
  ]);
  rule(eid, 'b', 'SECTION B', 1);
  db.prepare('DELETE FROM question_pool WHERE exam_id = ?').run(eid);
  const exam = require('../src/services/exam');
  exam.createSession(eid, 1);
  const pooled = db.prepare('SELECT * FROM question_pool WHERE exam_id=?').all(eid);
  assert.equal(pooled.length, 1);
  assert.equal(pooled[0].is_compulsory, 0, 'the pool copy must keep compulsory = 0');
  assert.equal(pooled[0].section_key, 'b');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/question-selection.test.js`
Expected: FAIL — the objective-first test passes but the section-order, only-selected, and paper-total tests fail.

- [ ] **Step 3: `topUpPool` must carry the new columns**

In `src/services/exam.js`, extend the `insertPool` statement (line 301) and its `insertPool.run(...)` call (lines 311-315):

```js
  const insertPool = db.prepare(
    `INSERT INTO question_pool (exam_id, type, text, passage, options, correct_answer, marks, difficulty, learning_objective, explanation, scheme_json, source, image, is_compulsory, section_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
```

```js
    insertPool.run(
      examId, t.type, t.text, t.passage || '', t.options || null, t.correct_answer || null,
      t.marks, t.difficulty || 'medium', t.learning_objective || '', t.explanation || '',
      scheme ? scheme.scheme : '', t.source || 'manual', t.image || '',
      t.is_compulsory == null ? 1 : t.is_compulsory, t.section_key || ''
    );
```

- [ ] **Step 4: `drawSessionQuestions` writes the snapshot columns and prices the paper**

Replace the `uniqueRows` / `chosen` / `ins` block in `drawSessionQuestions` (lines 275-294) so it reads `is_compulsory` and `section_key`, orders by section when the exam has a quota, and records the paper total:

```js
  const poolRows = db
    .prepare('SELECT id, type, text, is_compulsory, section_key FROM question_pool WHERE exam_id = ? ORDER BY id')
    .all(examId);
  const seenTexts = new Set();
  const uniqueRows = [];
  for (const row of poolRows) {
    const key = String(row.text || '').trim().toLowerCase();
    if (key && seenTexts.has(key)) continue;
    if (key) seenTexts.add(key);
    uniqueRows.push(row);
  }
  // Papers without a quota keep today's objective-first ordering verbatim.
  // Only a paper that actually asks the student to choose switches to
  // section order, because grouping by section is the whole point.
  const plan = selection.sectionPlan(examId);
  const position = new Map(plan.map((s) => [s.section_key, s.position]));
  const selective = plan.some((s) => s.quota > 0);
  if (selective) {
    uniqueRows.sort((a, b) => {
      const pa = position.has(a.section_key) ? position.get(a.section_key) : 9999;
      const pb = position.has(b.section_key) ? position.get(b.section_key) : 9999;
      return pa !== pb ? pa - pb : (a.id || 0) - (b.id || 0);
    });
  } else {
    uniqueRows.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'objective' ? -1 : 1;
      return (a.id || 0) - (b.id || 0);
    });
  }
  const chosen = uniqueRows.slice(0, n);
  const ins = db.prepare(
    'INSERT INTO session_questions (session_id, question_id, q_order, is_selected, section_key) VALUES (?,?,?,?,?)'
  );
  // Every drawn question starts selected, INCLUDING the optional ones the student
  // will get to pick from. They are only deselected once the student commits, in
  // applySelection. Writing 0 here would hide the whole section from
  // sessionQuestionSequence, which filters on is_selected, so the selector could
  // never open and the student would be delivered the section unasked.
  chosen.forEach((p, i) => {
    ins.run(sessionId, p.id, i + 1, 1, p.section_key || '');
  });
  db.prepare('UPDATE sessions SET paper_total = ? WHERE id = ?')
    .run(selection.computePaperTotal(sessionId), sessionId);
  return chosen.length;
```

Add the require at the top of `src/services/exam.js`, after `const outbox = require('./outbox');`:

```js
const selection = require('./selection');
```

> Circular import: `selection.js` requires only `../db`, so this is safe. Do not require `./exam` from `selection.js`.

- [ ] **Step 5: `sessionQuestionSequence` filters to selected and orders by section**

In `sessionQuestionSequence`, the pool branch builds its rows from a query
selecting only `q_order, question_id`. Extend that query to also select
`is_selected`, and attach it to each mapped row:

```js
    // is_selected lives on the snapshot, not on question_pool: it is this
    // student's private choice. Two students drawn the same pool row can
    // disagree about it, which is exactly why it cannot be a pool column.
    row.is_selected = m.is_selected;
```

Then replace the existing `questions.sort(...)` with:

```js
  // Same rule as drawSessionQuestions, and for the same reason: a quota-free
  // exam must come out byte-identical to how it behaved before this feature.
  const plan = selection.sectionPlan(s.exam_id);
  const position = new Map(plan.map((x) => [x.section_key, x.position]));
  if (plan.some((x) => x.quota > 0)) {
    questions.sort((a, b) => {
      const pa = position.has(a.section_key) ? position.get(a.section_key) : 9999;
      const pb = position.has(b.section_key) ? position.get(b.section_key) : 9999;
      return pa !== pb ? pa - pb : (a.q_order || 0) - (b.q_order || 0);
    });
  } else {
    questions.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'objective' ? -1 : 1;
      return (a.q_order || 0) - (b.q_order || 0);
    });
  }
  // is_selected defaults to 1, so an exam with no quota loses nothing here.
  return questions.filter((q) => q.is_selected !== 0);
```

The template-only branch (no `session_questions` rows) has no selection state and
keeps its current behaviour untouched.

- [ ] **Step 6: `nextInSequence` must not land on a deselected question**

`nextInSequence` finds the current question's index in the sequence and takes the
next entry. Its `i === -1` fallback reads `q_order + 1` straight off the
database, which can now be a question the student just deselected — the selector
would then offer them a question they explicitly did not pick.

In the `i === -1` branch, walk forward past any deselected row instead:

```js
  if (i === -1) {
    // q_order + 1 may be a question this student deselected. Step over those
    // rather than offering a question they said no to.
    let next = question.q_order + 1;
    for (;;) {
      const candidate = getSessionQuestion(session.id, next);
      if (!candidate) return null;
      if (candidate.is_selected !== 0) return candidate;
      next++;
    }
  }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test test/question-selection.test.js`
Expected: PASS.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS. `regression.test.js` is the important one — it covers `sendQuestionTo` and the objective-first ordering that this task touches.

- [ ] **Step 9: Commit**

```bash
git add src/services/exam.js test/question-selection.test.js
git commit -m "feat(exam): draw section order and honour per-session selection"
```

---

## Task 4: The WhatsApp selector

**Files:**
- Modify: `src/services/selection.js`
- Modify: `src/services/exam.js` — `advanceAndSend` (line 848), `processAnswer` (line 1073), `sendQuestionTo` (line 755), `maybeStartSession` (line 1000), `handleInbound` (line 933), `formatExamIntro` (line 646)
- Test: `test/question-selection.test.js` (append)

**Interfaces:**
- Consumes: Task 2's `applySelection(sessionId, sectionKey, chosenQOrders)`, `sessionPlan(sessionId)`, `needsChoice`; Task 3's ordered sequence.
- Produces from `selection.js`:
  - `hasSelections(examId) -> boolean`
  - `beginChoice(sessionId, sectionKey) -> void` — sets `selection_state='selecting'`
  - `sendSelector(phone, sessionId, sectionKey) -> Promise<void>` — **session space**: renders the questions this student was actually drawn
  - `handleReply(session, student, body, meta) -> Promise<{handled: boolean, committed: boolean}>` — `committed: true` tells `exam.js` to go deliver a question
- `needsChoice` is **not** redefined here. Task 2 owns it, because both the rule
  layer and the chat layer must agree on it exactly; two copies would drift.

**The CONFIRM contract.** `handleReply` never sends a question itself — it has no
view of the sequence, and routing delivery from there would fork `exam.js`. It
returns `{ committed: true }` and `processAnswer` carries on. Forgetting this is
what strands the student: the choice is saved, the paper is priced, and then
nothing is ever sent.

- [ ] **Step 1: Write the failing tests**

Append to `test/question-selection.test.js`:

```js
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
  wa.sendInteractiveList = async (phone, title, body, buttonText, rows) => {
    sent.push({ kind: 'list', title, body, rows });
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
    const pool = poolOf(sid.id, 'b');
    await selection.handleReply(sessionRow(sid), { phone }, `${pool[0]}`);
    const res = await selection.handleReply(sessionRow(sid), { phone }, 'CONFIRM');
    assert.equal(res.committed, false);
    assert.match(cap.sent.map((m) => m.text || '').join('\n'), /must choose exactly 2/);
    assert.equal(sessionRow(sid).selection_state, 'selecting');
  } finally { cap.restore(); }
});

test('CONFIRM with the right count commits, prices, and reports committed', async () => {
  const { sid, phone } = selectiveSession(2, 3);
  const pool = poolOf(sid.id, 'b');
  const cap = captureWa();
  try {
    selection.beginChoice(sid.id, 'b');
    await selection.handleReply(sessionRow(sid), { phone }, `${pool[0]},${pool[1]}`);
    const res = await selection.handleReply(sessionRow(sid), { phone }, 'CONFIRM');
    assert.equal(res.committed, true, 'exam.js needs this signal to deliver the first question');
    const row = sessionRow(sid);
    assert.equal(row.paper_total, 15, 'compulsory 5 + two chosen 5s');
    assert.equal(row.selection_state, '', 'a committed choice is no longer pending');
    assert.equal(row.selection_tentative, '', 'provisional state is cleared on commit');
  } finally { cap.restore(); }
});

test('ticks are provisional until CONFIRM', async () => {
  const { sid, phone } = selectiveSession(2, 3);
  const pool = poolOf(sid.id, 'b');
  const cap = captureWa();
  try {
    selection.beginChoice(sid.id, 'b');
    await selection.handleReply(sessionRow(sid), { phone }, `${pool[0]}`);
    const row = sessionRow(sid);
    assert.equal(row.paper_total, 20, 'the paper is not re-priced on a provisional tick');
    const drawn = db.prepare(
      'SELECT q_order, is_selected FROM session_questions WHERE session_id=? ORDER BY q_order'
    ).all(sid.id);
    for (const r of drawn) assert.equal(r.is_selected, 1, 'nothing is deselected before CONFIRM');
    assert.deepEqual(JSON.parse(row.selection_tentative), [pool[0]]);
  } finally { cap.restore(); }
});

test('CHANGE reopens a committed choice, but only before the first answer', async () => {
  const { sid, phone } = selectiveSession(1, 2);
  const pool = poolOf(sid.id, 'b');
  const cap = captureWa();
  try {
    selection.beginChoice(sid.id, 'b');
    await selection.handleReply(sessionRow(sid), { phone }, `${pool[0]}`);
    await selection.handleReply(sessionRow(sid), { phone }, 'CONFIRM');

    await selection.handleReply(sessionRow(sid), { phone }, 'CHANGE');
    assert.equal(sessionRow(sid).selection_state, 'selecting', 'CHANGE reopens the selector');

    // Record an answer, which closes the window for good.
    db.prepare(
      'INSERT INTO answers(session_id,question_id,q_order,answer_text,max_marks) VALUES (?,?,1,?,5)'
    ).run(sid.id, db.prepare('SELECT question_id FROM session_questions WHERE session_id=? AND q_order=1').get(sid.id).question_id, 'x');
    await selection.handleReply(sessionRow(sid), { phone }, 'CHANGE');
    assert.match(cap.sent.map((m) => m.text || '').join('\n'), /cannot change/i);
  } finally { cap.restore(); }
});

test('a reply that is not a choice re-prompts instead of guessing', async () => {
  const { sid, phone } = selectiveSession();
  const cap = captureWa();
  try {
    selection.beginChoice(sid.id, 'b');
    const res = await selection.handleReply(sessionRow(sid), { phone }, 'what time is it');
    assert.equal(res.committed, false);
    assert.match(cap.sent.map((m) => m.text || '').join('\n'), /didn't catch that/);
    assert.equal(sessionRow(sid).selection_state, 'selecting');
  } finally { cap.restore(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/question-selection.test.js`
Expected: FAIL — `selection.beginChoice is not a function`.

- [ ] **Step 3: Add the chat half to `selection.js`**

Append above `module.exports` in `src/services/selection.js`:

```js
const wa = require('./whatsapp');

// ── Selector ───────────────────────────────────────────────────────────
//
// WhatsApp list messages cap at ten rows and row titles at 24 characters, so
// a bigger pool has to arrive as numbered text. Both paths speak the same
// protocol (taps, "2,4,5", CONFIRM) so nothing downstream branches on which
// one was used.
//
// Every key below is a session q_order. The student is told "QUESTION 7", taps
// row `sel:b:7`, and types "7" — so q_order is the only identifier that means
// the same thing to all three.

const LIST_ROW_CAP = 10;
const ROW_TITLE_CAP = 24;
const CONFIRM_WORDS = new Set(['confirm', 'done', 'ok', 'okay', 'yes', 'submit']);
const CHANGE_WORDS = new Set(['change', 'edit', 'switch', 'back']);

function hasSelections(examId) {
  return sectionPlan(examId).some((s) => s.quota > 0);
}

function beginChoice(sessionId, sectionKey) {
  db.prepare("UPDATE sessions SET selection_state='selecting', selection_section=? WHERE id=?")
    .run(sectionKey, sessionId);
}

function stem(q) {
  return String(q.text || '').replace(/\s+/g, ' ').trim();
}

function rowTitle(q, n) {
  return (`${n}. ${stem(q)}`).slice(0, ROW_TITLE_CAP);
}

/** The numbered listing used by both the big-pool and the error paths. */
function listing(plan) {
  return plan.optional.map((q, i) => `${i + 1}. ${stem(q).slice(0, 90)}`).join('\n');
}

function selectorBody(plan) {
  const lines = [];
  if (plan.title) lines.push(`*${plan.title}*`, '');
  if (plan.instructions) lines.push(`${plan.instructions}`, '');
  const locked = plan.compulsory.map((q) => `Q${q.q_order}`);
  if (locked.length) {
    lines.push(`🔒 Compulsory — you will answer ${locked.join(', ')}.`);
  }
  lines.push(`You must choose exactly ${plan.quota} of the ${plan.optional.length} questions below.`);
  return lines.join('\n');
}

async function sendSelector(phone, sessionId, sectionKey) {
  const plan = sessionPlan(sessionId).find((s) => s.section_key === sectionKey);
  if (!plan || plan.quota <= 0) return;
  const body = selectorBody(plan);

  if (plan.optional.length > LIST_ROW_CAP) {
    await wa.sendText(
      phone,
      `${body}\n\n${listing(plan)}\n\nReply with the numbers you choose, e.g. 1,3 — then CONFIRM.`
    );
    return;
  }

  await wa.sendText(phone, body);
  const rows = plan.optional.map((q, i) => ({
    id: `sel:${sectionKey}:${q.q_order}`,
    title: rowTitle(q, i + 1),
  }));
  try {
    await wa.sendInteractiveList(
      phone, plan.title || 'Choose', body, 'Choose questions', rows,
      `Tap to toggle · choose ${plan.quota}`
    );
  } catch (err) {
    // An interactive message can be rejected outright; the numbered-text path
    // always works, so fall back rather than stranding the student.
    console.error('[selection] list message failed, using text:', err.message);
    await wa.sendText(
      phone,
      `${listing(plan)}\n\nReply with the numbers you choose, e.g. 1,3 — then CONFIRM.`
    );
    return;
  }
  await wa.sendInteractiveButtons(phone, `You have chosen 0 of ${plan.quota}.`, [
    { type: 'reply', reply: { id: 'sel:confirm', title: 'Confirm selection' } },
  ]);
}

/**
 * The q_orders a student means, from a typed reply or a list row id.
 * Returns { toggles: [q_order] } for a tap, or { set: [q_order] } for typed
 * numbers.
 */
function parseChoice(text, meta, plan) {
  const byRowId = new Map(plan.optional.map((q) => [`sel:${plan.section_key}:${q.q_order}`, q.q_order]));
  const tapped = byRowId.get(meta.replyId || meta.selectedId || '');
  if (tapped != null) return { toggles: [tapped] };

  const pool = plan.optional.map((q) => q.q_order);
  const digits = (String(text || '').match(/\d+/g) || []).map((d) => parseInt(d, 10));
  // A typed number is read first as a position in the printed listing, because
  // that is what the student just read. It is only then read as a q_order, so a
  // student who types the question number they were shown still gets it right.
  const byIndex = digits.filter((n) => n >= 1 && n <= pool.length).map((n) => pool[n - 1]);
  if (byIndex.length) return { set: [...new Set(byIndex)] };
  const byOrder = digits.filter((n) => pool.includes(n));
  if (byOrder.length) return { set: [...new Set(byOrder)] };
  return null;
}

/** q_orders the student has provisionally ticked, without committing anything. */
function currentChoice(sessionId, sectionKey) {
  const plan = sessionPlan(sessionId).find((s) => s.section_key === sectionKey);
  if (!plan) return [];
  const pending = db.prepare('SELECT selection_tentative FROM sessions WHERE id = ?').get(sessionId);
  let ids = [];
  if (pending && pending.selection_tentative) {
    try { ids = JSON.parse(pending.selection_tentative); } catch { ids = []; }
  }
  const pool = new Set(plan.optional.map((q) => q.q_order));
  return ids.filter((id) => pool.has(Number(id)));
}

/** Ticks are provisional; only applySelection commits them. */
function persistChoice(sessionId, sectionKey, chosen) {
  db.prepare('UPDATE sessions SET selection_tentative = ? WHERE id = ?')
    .run(JSON.stringify(chosen), sessionId);
}

/**
 * Handle one reply while a selector is open.
 *
 * Returns { handled, committed }. `committed: true` means exam.js must now
 * deliver the first selected question — the selector never sends it itself.
 */
async function handleReply(session, student, body, meta = {}) {
  const phone = student.phone;
  const sectionKey = session.selection_section;
  const plan = sessionPlan(session.id).find((s) => s.section_key === sectionKey);
  if (!plan || plan.quota <= 0) return { handled: false, committed: false };

  const raw = String(body || '').trim().toLowerCase();

  // CHANGE reopens a committed choice, but only while nothing has been
  // answered — the first answer is what closes the window.
  if (CHANGE_WORDS.has(raw)) {
    const answered = db
      .prepare('SELECT COUNT(*) c FROM answers WHERE session_id = ?')
      .get(session.id).c;
    if (answered > 0) {
      await wa.sendText(phone, 'Your question choice is locked now that you have answered. You cannot change it.');
      return { handled: true, committed: false };
    }
    // Undo the previous commit so the section reads as unchosen again.
    db.prepare(
      'UPDATE session_questions SET is_selected = 1 WHERE session_id = ? AND section_key = ?'
    ).run(session.id, sectionKey);
    db.prepare('UPDATE sessions SET selection_tentative = ? WHERE id = ?')
      .run(JSON.stringify(currentChoice(session.id, sectionKey)), session.id);
    beginChoice(session.id, sectionKey);
    await sendSelector(phone, session.id, sectionKey);
    return { handled: true, committed: false };
  }

  const chosen = new Set(currentChoice(session.id, sectionKey));

  if (meta.replyId === 'sel:confirm' || CONFIRM_WORDS.has(raw)) {
    if (chosen.size !== plan.quota) {
      await wa.sendText(
        phone,
        `You must choose exactly ${plan.quota} question${plan.quota === 1 ? '' : 's'}. ` +
        `You have chosen ${chosen.size}. Reply with the numbers, e.g. 1,3, then CONFIRM.`
      );
      await sendSelector(phone, session.id, sectionKey);
      return { handled: true, committed: false };
    }
    applySelection(session.id, sectionKey, [...chosen]);
    await wa.sendText(
      phone,
      `✅ Locked in. Answering ${chosen.size} question${chosen.size === 1 ? '' : 's'} from this section.`
    );
    return { handled: true, committed: true };
  }

  const parsed = parseChoice(body, meta, plan);
  if (!parsed) {
    await wa.sendText(
      phone,
      `I didn't catch that. Tap the questions you want, or reply with their numbers like *1,3*, then send CONFIRM.`
    );
    await sendSelector(phone, session.id, sectionKey);
    return { handled: true, committed: false };
  }

  if (parsed.set) {
    if (parsed.set.length > plan.quota) {
      await wa.sendText(
        phone,
        `You chose ${parsed.set.length} but this section needs exactly ${plan.quota}. ` +
        `Pick ${plan.quota}, e.g. *1,3*, then CONFIRM.`
      );
      return { handled: true, committed: false };
    }
    chosen.clear();
    parsed.set.forEach((q) => chosen.add(q));
  } else {
    for (const q of parsed.toggles) {
      if (chosen.has(q)) chosen.delete(q);
      else if (chosen.size < plan.quota) chosen.add(q);
      else {
        await wa.sendText(phone, `That is already ${plan.quota} chosen — remove one first, or reply CONFIRM.`);
        return { handled: true, committed: false };
      }
    }
  }

  persistChoice(session.id, sectionKey, [...chosen]);
  await wa.sendText(
    phone,
    chosen.size
      ? `✓ Chosen: ${[...chosen].map((q) => `Q${q}`).join(', ')} — ${chosen.size} of ${plan.quota}. Reply CONFIRM to lock it in.`
      : `Cleared. Choose ${plan.quota} question${plan.quota === 1 ? '' : 's'}.`
  );
  return { handled: true, committed: false };
}
```

Extend `module.exports` with `hasSelections`, `beginChoice`, `sendSelector`, and
`handleReply`. `needsChoice` is already exported from Task 2 — do not re-export a
second copy.

- [ ] **Step 4: Run the selector tests**

Run: `node --test test/question-selection.test.js`
Expected: PASS. If `selection_tentative` errors, Task 1's column list is incomplete — add it there, not via a second migration.

- [ ] **Step 5: Wire the `exam.js` seams**

All four seams are in `src/services/exam.js`. Add the require after
`const outbox = require('./outbox');`:

```js
const selection = require('./selection');
```

> Circular import: `selection.js` requires only `../db` and `./whatsapp`, so this
> is safe. Do not require `./exam` from `selection.js`.

**5a. `advanceAndSend` (line 848), before `outbox.enqueue`:**

```js
  if (selection.needsChoice(session, nextQ)) {
    selection.beginChoice(session.id, nextQ.section_key);
    await selection.sendSelector(student.phone, session.id, nextQ.section_key);
    // current_q_order is deliberately left where it is. The commit path re-reads
    // the sequence and lands on the first SELECTED question, which is often not
    // nextQ at all.
    return;
  }
```

**5b. `processAnswer` (line 1073), as the first statement of the function, before
any question lookup:**

```js
  // A student replying while a selector is open is choosing, not answering.
  if (session.selection_state === 'selecting') {
    const res = await selection.handleReply(session, student, body, meta);
    if (res && res.committed) {
      // The choice is committed and priced. Find where we now are and deliver.
      const fresh = getActiveSession(student.id) || session;
      const nextQ = firstUnansweredSelected(fresh);
      if (nextQ) {
        db.prepare('UPDATE sessions SET current_q_order = ? WHERE id = ?').run(nextQ.q_order, fresh.id);
        await sendQuestionTo(fresh, student, nextQ.q_order);
      } else {
        await finalize(fresh, student, 'completed');
      }
    }
    return;
  }
```

**5c. Add `firstUnansweredSelected` above `advanceAndSend`:**

```js
/**
 * The next question this student should see: the first selected question in
 * delivery order that has no answer yet. Used after a selection is committed,
 * where the answer to "where now?" depends on what the student just picked.
 */
function firstUnansweredSelected(session) {
  const answered = new Set(
    db.prepare('SELECT q_order FROM answers WHERE session_id = ?').all(session.id).map((r) => Number(r.q_order))
  );
  const seq = sessionQuestionSequence(session);
  return seq.find((q) => !answered.has(Number(q.q_order))) || null;
}
```

**5d. `sendQuestionTo` (line 755), after the `question` lookup:**

```js
  if (selection.needsChoice(session, question)) {
    selection.beginChoice(session.id, question.section_key);
    await selection.sendSelector(student.phone, session.id, question.section_key);
    return false;
  }
```

**5e. `handleInbound` (line 947) — do not restart the timer mid-selection:**

`handleInbound` resets `started_at` whenever the session has no answers yet. A
student deliberating over their choice has no answers yet, so without this guard
every tap would reset their clock and the selection would cost them no time at
all. Add the condition:

```js
  // A student still choosing has no answers yet, but their clock is already
  // running — restarting it on every tap would make the selection free.
  if (sessionHasNoAnswers(session.id) && session.selection_state !== 'selecting') {
```

**5f. `maybeStartSession` (line 1005), in the `resumed` branch — and the
`handleInbound` first-engagement branch at line 933:**

```js
    // A restart can leave a selector pending with no question sent; re-render it
    // rather than pushing a question the student never chose.
    if (session.selection_state === 'selecting') {
      await selection.sendSelector(student.phone, session.id, session.selection_section);
      return { started: true, ok: true, reason: 'reselecting' };
    }
```

**5g. `formatExamIntro` (line 646), after the `Number of questions:` line:**

```js
  const ruleLines = selection
    .sectionPlan(exam.id)
    .filter((s) => s.quota > 0)
    .map((s) => `${s.title || s.section_key}: answer any ${s.quota} of the ${s.optional.length} questions.`);
  if (ruleLines.length) lines.splice(lines.length, 0, ruleLines.join('\n'));
```

- [ ] **Step 6: Add the end-to-end flow test**

This is the test that catches the CONFIRM stall, so it goes in the plan rather
than being left to the reviewer:

```js
test('a student who confirms is actually sent their first chosen question', async () => {
  const { sid, phone } = selectiveSession(2, 3);
  const pool = poolOf(sid.id, 'b');
  const cap = captureWa();
  try {
    const student = { id: 1, phone };
    const first = db.prepare(
      `SELECT sq.q_order, qp.is_compulsory FROM session_questions sq
         JOIN question_pool qp ON qp.id = sq.question_id
        WHERE sq.session_id = ? ORDER BY sq.q_order LIMIT 1`
    ).get(sid.id);

    // Deliver up to the optional question; the selector should take over there.
    await examSvc.sendQuestionTo(sessionRow(sid), student, first.q_order);
    const opened = sessionRow(sid);
    assert.equal(opened.selection_state, 'selecting');

    selection.beginChoice(sid.id, 'b');
    await selection.handleReply(opened, student, `${pool[0]},${pool[1]}`);
    const res = await selection.handleReply(sessionRow(sid), student, 'CONFIRM');
    assert.equal(res.committed, true);

    // Mirror what processAnswer does on a committed choice.
    const fresh = sessionRow(sid);
    const nextQ = examSvc.firstUnansweredSelected(fresh);
    assert.ok(nextQ, 'there must be a question left to deliver');
    assert.ok(pool.includes(nextQ.q_order), 'the delivered question must be one they picked');
    assert.notEqual(nextQ.q_order, first.q_order, 'the compulsory question was answered first');
  } finally { cap.restore(); }
});
```

If `firstUnansweredSelected` is not exported from `exam.js`, add it to
`module.exports` there — it is now part of the delivery contract.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS. This is the highest-risk task — it touches `handleInbound`, `processAnswer` and `sendQuestionTo`. If `timer-start.test.js` or `delivery-ledger.test.js` fails, the seam is firing when it should not.

- [ ] **Step 8: Commit**

```bash
git add src/services/selection.js src/services/exam.js src/db.js test/question-selection.test.js
git commit -m "feat(selection): tappable question selector with text fallback"
```

---

## Task 5: Grade against the priced paper

**Files:**
- Modify: `src/services/results.js` — `computeForSession` (line 8)
- Test: `test/question-selection.test.js` (append)

**Interfaces:**
- Consumes: `sessions.paper_total` from Task 3.
- Produces: `computeForSession(sessionId)` returns the same shape, with `totalMarks` now sourced from `paper_total` and a new `priceSource` of `'priced' | 'drawn'`.

- [ ] **Step 1: Write the failing tests**

Append to `test/question-selection.test.js`:

```js
const results = require('../src/services/results');

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

test('a session predating paper_total is priced from what it was drawn, not answered', () => {
  const eid = paperExam([{ marks: 4 }, { marks: 6 }]);
  const sid = examSvc.createSession(eid, 1);
  // Simulate a session created before this feature: no recorded price.
  db.prepare('UPDATE sessions SET paper_total = 0 WHERE id = ?').run(sid.id);
  answerFirst(sid.id, 4);
  const r = results.computeForSession(sid.id);
  assert.equal(r.priceSource, 'drawn');
  assert.equal(
    r.totalMarks, 10,
    'a historical attempt is owed both questions it was drawn; summing only the answer would report 4/4 = 100%'
  );
  assert.equal(r.percentage, 40);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/question-selection.test.js`
Expected: FAIL — `priceSource` is `undefined` and `totalMarks` is still the sum of answers.

- [ ] **Step 3: Change the denominator**

Replace lines 11 and 18 of `src/services/results.js`:

```js
  // The denominator is the price of the paper, not the sum of what came back.
  // Summing answers let a student raise their percentage by skipping the
  // hard questions, and left every timed-out attempt graded on a short paper.
  const priced = Number(session.paper_total) || 0;
  // Sessions predating paper_total have none recorded, so price them from the
  // questions they were DRAWN. Falling back to the answered marks would grade a
  // historical 1-of-2 attempt as a perfect score, which is the exact bug this
  // change exists to remove — so it must not be reintroduced for legacy rows.
  const drawnTotal = db.prepare(
    `SELECT COALESCE(SUM(qp.marks), 0) t
       FROM session_questions sq JOIN question_pool qp ON qp.id = sq.question_id
      WHERE sq.session_id = ?`
  ).get(sessionId).t;
  const answeredTotal = db.prepare('SELECT COALESCE(SUM(max_marks),0) t FROM answers WHERE session_id = ?').get(sessionId).t;
  const totalMarks = priced > 0 ? priced : (drawnTotal > 0 ? drawnTotal : answeredTotal);
```

```js
  const percentage = totalMarks > 0 ? Math.round((awarded / totalMarks) * 1000) / 10 : 0;
  return {
    sessionId,
    exam,
    score: awarded,
    totalMarks,
    percentage,
    passed: percentage >= (exam.pass_percentage ?? config.exam.passPercentage),
    answered,
    questionCount,
    priceSource: priced > 0 ? 'priced' : (drawnTotal > 0 ? 'drawn' : 'answers'),
  };
```

> Three-way fallback, in order: the recorded price, then everything the session was
> drawn, then the answered marks. The last tier only applies to sessions with no
> `session_questions` snapshot at all — template-only exams from before the pool
> existed. It is a floor to avoid dividing by zero, never the primary path.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/question-selection.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. `regression.test.js` asserts result percentages; those sessions get `paper_total` from Task 3, so they should be unchanged — but confirm rather than assume.

- [ ] **Step 6: Commit**

```bash
git add src/services/results.js test/question-selection.test.js
git commit -m "fix(results): grade against the priced paper, not answered marks"
```

---

## Task 6: Admin API

**Files:**
- Modify: `src/routes/api.js` — `qWithScheme` (near line 578), `POST /exams/:id/questions` (line 453), `POST /exams/:id/questions/batch` (line 491), `PUT /exams/:id/questions/:qid` (line 580), plus a new `PATCH /exams/:id/sections`
- Test: `test/question-selection.test.js` (append)

**Interfaces:**
- Consumes: Task 1's schema.
- Produces:
  - `qWithScheme` gains `is_compulsory: number`, `section_key: string`
  - `PATCH /exams/:id/sections` body `{ sections: [{ section_key, title, instructions, position, answer_count }] }` → `{ ok: true, sections: [...] }`
  - `GET /exams/:id` gains `sections` and `selection` (the derived plan)

- [ ] **Step 1: Write the failing tests**

Append to `test/question-selection.test.js`:

```js
// Route-level assertions without booting Express: exercise the same SQL the
// handlers run, so the contract (column names, coercion, scoping) is pinned.
test('qWithScheme exposes the selection columns', () => {
  const apiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'api.js'), 'utf8');
  assert.match(apiSrc, /is_compulsory: row\.is_compulsory/);
  assert.match(apiSrc, /section_key: row\.section_key/);
});

test('the question routes accept the selection columns', () => {
  const apiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'api.js'), 'utf8');
  assert.match(apiSrc, /is_compulsory=\?/, 'PUT must be able to flip the flag');
  assert.match(apiSrc, /section_key=\?/, 'PUT must be able to move a question between sections');
});

test('a section rule upserts rather than duplicating', () => {
  const eid = paperExam([{ section: 'b', compulsory: false }, { section: 'b', compulsory: false }]);
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

test('clearing the rules deletes them all', () => {
  const eid = paperExam([{ section: 'b', compulsory: false }, { section: 'b', compulsory: false }]);
  db.prepare(
    `INSERT INTO exam_sections(exam_id,section_key,title,instructions,position,answer_count)
     VALUES (?,?,?,?,?,?)`
  ).run(eid, 'b', 'SECTION B', 'Answer two', 1, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM exam_sections WHERE exam_id=?').get(eid).c, 1);

  // The body an admin sends after emptying the card: { sections: [] }.
  const incoming = [];
  const keep = incoming.map((s) => String(s && s.section_key || '').trim()).filter(Boolean);
  if (keep.length) {
    assert.fail('an empty body must take the delete-all branch');
  }
  db.prepare('DELETE FROM exam_sections WHERE exam_id = ?').run(eid);
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM exam_sections WHERE exam_id=?').get(eid).c, 0,
    'an empty sections array must remove the rules, not leave them orphaned'
  );
});
```

> Source-text assertions are weaker than HTTP tests, but this repo's route tests (`recipient-route.test.js`, `roster-routes.test.js`) already stub the app rather than booting it. If you prefer real HTTP, follow `recipient-route.test.js` and replace these three tests with `supertest`-free `fetch` calls against an ephemeral server.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/question-selection.test.js`
Expected: FAIL on the two source-text assertions; the upsert test passes because it tests the SQL this task will use.

- [ ] **Step 3: Expose the columns on read**

In `qWithScheme`, after `image: row.image || '',` add:

```js
    is_compulsory: row.is_compulsory == null ? 1 : row.is_compulsory,
    section_key: row.section_key || '',
```

- [ ] **Step 4: Accept the columns on write**

In `PUT /exams/:id/questions/:qid`, after the `b.explanation` field (line 598), add:

```js
  if (b.is_compulsory !== undefined) {
    fields.push('is_compulsory=?');
    vals.push(b.is_compulsory === false || b.is_compulsory === 0 || b.is_compulsory === '0' ? 0 : 1);
  }
  if (b.section_key !== undefined) { fields.push('section_key=?'); vals.push(String(b.section_key)); }
```

In `POST /exams/:id/questions`, extend the INSERT column list and add `q.is_compulsory` / `q.section_key` to the `.run(...)`, keeping column count and placeholder count equal.

In `POST /exams/:id/questions/batch`, do the same for the shared `insert` at line 502. Both sites carry the existing warning at `src/routes/api.js:525-527` about the two lists drifting — re-read it before editing.

- [ ] **Step 5: Add the sections route**

Add before `router.delete('/exams/:id', ...)`:

```js
// Selection rules for "answer any N of M" papers. Bulk upsert so the admin UI
// can save the whole card in one call; a section key that disappears from the
// body has its rule removed rather than left orphaned.
router.patch('/exams/:id/sections', (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (exam.status === 'live' || exam.status === 'ended') {
    return res.status(400).json({ error: 'Exam is already live/ended. Selection rules can no longer be edited.' });
  }
  const incoming = Array.isArray(req.body.sections) ? req.body.sections : [];
  const upsert = db.prepare(
    `INSERT INTO exam_sections(exam_id,section_key,title,instructions,position,answer_count)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(exam_id, section_key) DO UPDATE SET
       title=excluded.title, instructions=excluded.instructions,
       position=excluded.position, answer_count=excluded.answer_count`
  );
  db.exec('BEGIN');
  try {
    for (const s of incoming) {
      if (!s || !String(s.section_key || '').trim()) continue;
      const pool = db
        .prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ? AND section_key = ? AND is_compulsory = 0')
        .get(exam.id, String(s.section_key).trim()).c;
      const want = Math.max(0, parseInt(s.answer_count, 10) || 0);
      // Clamp to the real pool: a quota covering every optional question is
      // answer-all, and storing it would show the admin a rule that never fires.
      const count = Math.min(want, pool);
      upsert.run(exam.id, String(s.section_key).trim(), String(s.title || ''),
        String(s.instructions || ''), parseInt(s.position, 10) || 0, count);
    }
    const keep = incoming.map((s) => String(s && s.section_key || '').trim()).filter(Boolean);
    // Always delete what is no longer listed, INCLUDING when the body is an
    // empty array. Guarding this on `keep.length` means an admin who clears the
    // card and saves sends [] and silently keeps every old rule — the one thing
    // "save my rules" must never do.
    if (keep.length) {
      db.prepare(
        `DELETE FROM exam_sections WHERE exam_id = ? AND section_key NOT IN (${keep.map(() => '?').join(',')})`
      ).run(exam.id, ...keep);
    } else {
      db.prepare('DELETE FROM exam_sections WHERE exam_id = ?').run(exam.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ ok: true, sections: db.prepare('SELECT * FROM exam_sections WHERE exam_id = ? ORDER BY position, id').all(exam.id) });
});
```

Add `sections` and `selection` to `GET /exams/:id` (line 231):

```js
  const sections = db.prepare('SELECT * FROM exam_sections WHERE exam_id = ? ORDER BY position, id').all(exam.id);
  res.json({ exam, questions: qs, recipients, results, sections, selection: selection.sectionPlan(exam.id) });
```

Add at the top of `src/routes/api.js`, after `const marking = require('../services/marking');`:

```js
const selection = require('../services/selection');
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/question-selection.test.js`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/routes/api.js test/question-selection.test.js
git commit -m "feat(api): manage selection rules and per-question compulsory flags"
```

---

## Task 7: Reading the rule out of the PDF

Two files, so one task: the prompt and the reconciliation that consumes it.

**Read this first — the extraction contract does not return what the earlier draft
assumed.** `extractQuestionsFromText` (`src/services/ai.js:1546`) calls the model
per block and gets `{ questions: [...] }` back, then flattens every block into a
single **array of questions** (`ai.js:1657`, `ai.js:1751`, returned at
`ai.js:1780+`). There is no sibling `selection` key and no envelope object. So
`parsed.selection` is `undefined`, always, and any plan that reads it is dead code
that "passes" only because it never runs.

Two further traps, both of which silently corrupt the rules rather than crashing:

1. **`q_order` is not the paper's question number.** Import assigns `q_order` by
   insertion sequence (`pdfImport.js:319-425`) and `g.number` — the number the AI
   read off the paper — is discarded. The moment a block is dropped (they time out
   and are retried) or two blocks merge, `q_order` diverges from the printed
   number, and matching `"compulsory_question_numbers": ["3"]` positionally marks
   the **wrong question compulsory**.
2. **`is_compulsory` only ever needs to move in one direction, and the plan had it
   backwards.** The column defaults to `1`. A reconciliation that only ever writes
   `is_compulsory = 1` leaves *every* question compulsory, the selectable pool
   computes to zero, the quota clamps to zero, and every rule is discarded as
   "answer-all" — silently producing an exam with no selection at all.

The fix for all three: ask the model for the facts **per question**, in the shape it
already returns, and derive the section rules by grouping. No second AI call, no
positional guessing, and a dropped block degrades one question instead of
reshuffling the whole paper.

**Files:**
- Modify: `src/services/ai.js` — the extraction prompt near line 1546
- Modify: `src/services/pdfImport.js` — persist the new fields in the insert loop, then reconcile after it (~line 426)
- Test: `test/selection-rules.test.js` (create)

**Interfaces:**
- Consumes: Task 1's schema (`questions.source_number`, `section_key`, `is_compulsory`; table `exam_sections`).
- Produces from `pdfImport.js`: `applySelectionRules(examId, questions, savedQuestions) -> { applied: number, skipped: string[] }` — `questions` is the extraction array itself. Exported so it is testable without a PDF.

- [ ] **Step 1: Write the failing tests**

Create `test/selection-rules.test.js`:

```js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-selrules-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.DOTENV_CONFIG_PATH = path.join(tmp, '.env');
process.env.SEED_ON_BOOT = 'false';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { applySelectionRules } = require('../src/services/pdfImport');
after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// Mirrors what runImport persists: source_number keeps the printed number,
// is_compulsory defaults to 1 exactly as the schema does.
function examWith(spec) {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('PDF',30,'live')").run().lastInsertRowid;
  const saved = spec.map((q, i) => {
    const qid = db.prepare(
      `INSERT INTO questions(exam_id,q_order,type,text,section_key,source_number)
       VALUES (?,?,'theory',?,?,?)`
    ).run(eid, i + 1, `Q${i + 1}`, q.section || '', q.source_number ?? i + 1).lastInsertRowid;
    return { id: qid, q_order: i + 1, section_key: q.section || '', source_number: q.source_number ?? i + 1 };
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
  const { eid, saved } = examWith([
    { section: 'B' }, { section: 'B' }, { section: 'B' },
  ]);
  const out = applySelectionRules(eid, [
    { number: 1, section: 'B', compulsory: true },
    { number: 2, section: 'B' },
    { number: 3, section: 'B' },
  ], saved, { 'B': { title: 'SECTION B', instructions: 'Answer any TWO questions', answer_count: 2 } });
  assert.equal(out.applied, 1);

  const sec = db.prepare('SELECT * FROM exam_sections WHERE exam_id=?').get(eid);
  assert.equal(sec.answer_count, 2, 'the pool is two, because question 1 is compulsory');

  const rows = db.prepare('SELECT source_number, is_compulsory FROM questions WHERE exam_id=? ORDER BY q_order').all(eid);
  assert.equal(rows[0].is_compulsory, 1, 'question 1 stays compulsory');
  assert.equal(rows[1].is_compulsory, 0, 'question 2 becomes selectable — this is the write the earlier draft never made');
  assert.equal(rows[2].is_compulsory, 0, 'question 3 becomes selectable too');
});

test('compulsory is matched on the printed number, not on q_order', () => {
  // A dropped block means q_order 2 is the paper's question 7. Matching
  // positionally would force the wrong question.
  const { eid, saved } = examWith([
    { section: 'B', source_number: 5 },
    { section: 'B', source_number: 7 },
    { section: 'B', source_number: 8 },
  ]);
  applySelectionRules(eid, [
    { number: 5, section: 'B' },
    { number: 7, section: 'B', compulsory: true },
    { number: 8, section: 'B' },
  ], saved, { 'B': { answer_count: 1 } });

  const rows = db.prepare('SELECT source_number, is_compulsory FROM questions WHERE exam_id=? ORDER BY source_number').all(eid);
  assert.deepEqual(
    rows.map((r) => [r.source_number, r.is_compulsory]),
    [[5, 0], [7, 1], [8, 0]],
    'only printed question 7 is compulsory'
  );
});

test('a compulsory claim for a question that was never extracted is dropped', () => {
  const { eid, saved } = examWith([{ section: 'B', source_number: 1 }, { section: 'B', source_number: 2 }]);
  const out = applySelectionRules(eid, [
    { number: 1, section: 'B' },
    { number: 2, section: 'B' },
    { number: 99, section: 'B', compulsory: true },
  ], saved, { 'B': { answer_count: 1 } });
  assert.ok(out.skipped.some((s) => /99/.test(s)), 'the phantom question must be reported, not guessed at');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id=? AND is_compulsory=1').get(eid).c, 0);
});

test('a rule that ends up meaning answer-all is not written', () => {
  const { eid, saved } = examWith([
    { section: 'B' }, { section: 'B' },
  ]);
  const out = applySelectionRules(eid, [
    { number: 1, section: 'B', compulsory: true },
    { number: 2, section: 'B', compulsory: true },
  ], saved, { 'B': { answer_count: 2 } });
  assert.equal(out.applied, 0, 'answer-all is not a rule');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM exam_sections WHERE exam_id=?').get(eid).c, 0);
});

test('a quota larger than the real pool is clamped', () => {
  const { eid, saved } = examWith([
    { section: 'B' }, { section: 'B' },
  ]);
  applySelectionRules(eid, [
    { number: 1, section: 'B' }, { number: 2, section: 'B' },
  ], saved, { 'B': { answer_count: 9 } });
  const sec = db.prepare('SELECT * FROM exam_sections WHERE exam_id=?').get(eid);
  assert.equal(sec.answer_count, 2);
});

test('a section whose questions were all dropped is skipped', () => {
  const { eid, saved } = examWith([{ section: 'B' }]);
  const out = applySelectionRules(eid, [{ number: 1, section: 'GHOST' }], saved, {
    GHOST: { answer_count: 1 },
  });
  assert.equal(out.applied, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM exam_sections WHERE exam_id=?').get(eid).c, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/selection-rules.test.js`
Expected: FAIL — `applySelectionRules` is not exported from `pdfImport.js`.

- [ ] **Step 3: Extend the extraction prompt**

In `src/services/ai.js`, in the per-question shape (the Theory object at ~line 1580) add three fields, and mirror them on the Objective object at ~line 1546:

```
Theory:
{
  ...
  "number": 7,                // original number printed on the paper
  "section": "SECTION B",     // the section heading this question sits under, verbatim; "" if the paper has no sections
  "compulsory": true,         // true ONLY if the paper forces this exact question ("Answer ALL questions in Section A", "Questions 1 and 2 are compulsory", "Question 3 is compulsory")
  ...
}
```

Then add to the bullet list, after the `- SECTION INSTRUCTIONS:` bullet:

```
- SELECTION: "compulsory" is true ONLY for questions the document itself forces.
  A question that merely sits in a section with a limit is NOT compulsory — do not
  mark it true because it shares a section with compulsory questions.
- SECTION: "section" is the heading verbatim, or "" when the paper has none.
  Grouping by this value is how the platform reconstructs sections, so it must be
  consistent across every question of the same section.
```

> `number` already exists in the prompt. The change is that `pdfImport` must
> finally **keep** it (Task 7 Step 4) instead of discarding it — that is what makes
> compulsory matching safe when blocks drop.

- [ ] **Step 4: Persist the new fields during import**

In `src/services/pdfImport.js`, inside the insert loop (lines ~384 and ~400), add
`section_key` and `source_number` to both INSERT statements. `nextOrder` stays the
`q_order`; the printed number goes to its own column:

```js
      job.exam_id, nextOrder, 'objective', g.text, passage, JSON.stringify(opts),
      ...
      // slugOf is a small local helper: lowercase, non-alphanumerics to dashes.
      slugOf(g.section), Number(g.number) || 0,
```

Keep the column list and the placeholder count in step — the file already warns
about this at lines 525-527 for the API, and the same trap applies here.

- [ ] **Step 5: Reconcile the extraction against what was actually saved**

Add to `src/services/pdfImport.js`:

```js
/** "SECTION B" -> "section-b". Stable, so it matches what the admin sees. */
function slugOf(section) {
  return String(section || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Turn the extraction's per-question selection facts into stored rules.
 *
 * `questions` is the extraction array itself — the only shape this pipeline
 * actually returns. Section rules are DERIVED by grouping on each question's
 * `section`, and `sectionMeta` (title, instructions, answer_count, keyed by the
 * verbatim heading) supplies the wording. Every claim is checked against the rows
 * we actually saved:
 *
 *   - a compulsory question whose number never landed in the database is reported
 *     and dropped, because pointing at the wrong question is unrecoverable;
 *   - a count larger than the real pool is clamped;
 *   - a rule that ends up meaning "answer all" is not written at all, so the exam
 *     behaves exactly as it does today.
 */
function applySelectionRules(examId, questions, savedQuestions, sectionMeta = {}) {
  const list = Array.isArray(questions) ? questions : [];
  if (!list.length) return { applied: 0, skipped: [] };

  const saved = Array.isArray(savedQuestions) ? savedQuestions : [];
  // Keyed on the PRINTED number, which is what the paper said and what the model
  // echoed back. q_order is insertion order and drifts the moment a block drops.
  const bySourceNumber = new Map();
  for (const q of saved) {
    const n = Number(q.source_number);
    if (n) bySourceNumber.set(n, q);
  }

  const skipped = [];
  let applied = 0;

  // Group the extraction by section, keeping the model-declared compulsory flag.
  const groups = new Map();
  for (const q of list) {
    const section = String(q && q.section || '').trim();
    if (!section) continue;
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section).push(q);
  }

  db.exec('BEGIN');
  try {
    let position = 0;
    for (const [section, members] of groups) {
      const key = slugOf(section);
      const inSection = saved.filter((q) => String(q.section_key || '') === key);

      // Compulsory questions in this section, matched on the printed number.
      const forcedIds = new Set();
      for (const q of members) {
        if (!q.compulsory) continue;
        const row = bySourceNumber.get(Number(q.number));
        if (row) forcedIds.add(row.id);
        else skipped.push(`${section}: compulsory question ${q.number} was not extracted`);
      }
      if (!inSection.length) {
        skipped.push(`${section}: no questions were saved for it`);
        continue;
      }

      // Write BOTH directions. is_compulsory defaults to 1, so a reconciliation
      // that only ever forces questions leaves the whole pool compulsory and
      // every quota silently collapses to answer-all.
      const setFlag = db.prepare('UPDATE questions SET is_compulsory = ? WHERE id = ?');
      for (const q of inSection) setFlag.run(forcedIds.has(q.id) ? 1 : 0, q.id);

      const meta = sectionMeta[section] || sectionMeta[key] || {};
      const pool = inSection.length - forcedIds.size;
      const want = Math.max(0, parseInt(meta.answer_count, 10) || 0);
      const count = Math.min(want, pool);
      if (count <= 0 || count >= pool) {
        skipped.push(`${section}: rule is answer-all, nothing to choose`);
        continue;
      }

      db.prepare(
        `INSERT INTO exam_sections(exam_id,section_key,title,instructions,position,answer_count)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(exam_id, section_key) DO UPDATE SET
           title=excluded.title, instructions=excluded.instructions,
           position=excluded.position, answer_count=excluded.answer_count`
      ).run(
        examId, key,
        String(meta.title || section),
        String(meta.instructions || ''),
        position++, count
      );
      applied++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  console.log(`[pdfImport] selection rules: applied ${applied}, skipped ${skipped.length}`, skipped);
  return { applied, skipped };
}
```

Call it after the insert loop in `runImport`, where the extraction array and the
saved rows are both in scope:

```js
    // Selection rules last: every question row must exist before claims about
    // them can be checked against what was really extracted.
    try {
      const out = applySelectionRules(job.exam_id, filtered, created);
      if (out.applied) updateJob(jobId, { stage: 'Applying selection rules…', progress: 61 });
    } catch (err) {
      // A rule we cannot read must never fail an otherwise good import.
      console.error('[pdfImport] selection rules failed (continuing):', err.message);
    }
```

Read the surrounding code before editing: confirm the names actually holding the
extraction array and the inserted rows at that point in `runImport` rather than
assuming `filtered` and `created` are correct.

Add it to the **existing** `module.exports` object in `src/services/pdfImport.js`.
That object already carries fifteen names (`getJob`, `allJobs`, `jobsForExam`,
`activeJobForExam`, `deleteJob`, `createJob`, `updateJob`, `startJob`,
`recoverStaleJobs`, `buildOptions`, `correctKeyFor`, `imageFileNameFor`,
`storeMathImages`, `describeExtractionFailure`) and **does not export `runImport`**.
Replace the whole object and every importer of those helpers throws at require time:

```js
  describeExtractionFailure,
  applySelectionRules,   // added — exported so it is testable without a PDF
};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/selection-rules.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS. `pdf-images.test.js` and `scanned-pdf.test.js` cover the import path — confirm the new call did not shift a stage number or a job progress value they assert on.

- [ ] **Step 8: Commit**

```bash
git add src/services/ai.js src/services/pdfImport.js test/selection-rules.test.js
git commit -m "feat(pdf): read answer-N-of-M rules and compulsory questions from the paper"
```

---

## Task 8: Admin dashboard

**Files:**
- Modify: `src/public/app.js` — `questionFormHTML` (line 1092), the save handlers (~1217, ~1300), `editExamMeta` (line 1947), `renderTab` questions branch (line 647)
- Test: `test/question-selection.test.js` (append)

**Interfaces:**
- Consumes: Task 6's `is_compulsory`, `section_key`, `PATCH /exams/:id/sections`, and `data.sections` / `data.selection` from `GET /exams/:id`.
- Produces: `selectionRulesCardHTML(examId, sections, selection)` and `saveSelectionRules(examId)` on `window`, plus a `qf_compulsory` checkbox and `qf_section` select in the question form.

- [ ] **Step 1: Write the failing tests**

Append to `test/question-selection.test.js`:

```js
test('the question form carries a compulsory checkbox and a section field', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'app.js'), 'utf8');
  assert.match(src, /id="qf_compulsory"/);
  assert.match(src, /id="qf_section"/);
});

test('the question form posts both fields', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'app.js'), 'utf8');
  assert.match(src, /payload\.is_compulsory/);
  assert.match(src, /payload\.section_key/);
  assert.match(src, /formData\.append\('is_compulsory'/);
  assert.match(src, /formData\.append\('section_key'/);
});

test('the exam page renders a selection-rules card and a save path', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'app.js'), 'utf8');
  assert.match(src, /function selectionRulesCardHTML/);
  assert.match(src, /function saveSelectionRules/);
  assert.match(src, /\/api\/exams\/\$\{examId\}\/sections/);
});

test('a compulsory question is badged in the list', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'app.js'), 'utf8');
  assert.match(src, /🔒|Compulsory/);
});
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `node --test test/question-selection.test.js`
Expected: FAIL — `qf_compulsory` is absent.

- [ ] **Step 3: Add the fields to the question form**

In `questionFormHTML`, after the `Marks` field (line 1121), add:

```js
    <div class="field"><label>Section (paper grouping)</label>
      <select id="qf_section">${sectionOptionsHTML(q?.section_key || '', q?.exam_id || id)}</select>
      <p class="muted qmeta">Questions sharing a section are grouped when the paper asks the student to choose.</p>
    </div>
    <div class="field">
      <label style="display:flex;gap:8px;align-items:center;font-weight:400">
        <input type="checkbox" id="qf_compulsory" ${q?.is_compulsory === 0 ? '' : 'checked'}>
        Compulsory — always answered, never offered as a choice
      </label>
    </div>
```

`questionFormHTML(q, id)` does not receive the exam id for a new question, so add a helper that reads it from the module-level `examState`:

```js
/** <option>s for the section select: what exists, plus the current value. */
function sectionOptionsHTML(current, examId) {
  const eid = examId || examState.id;
  const existing = (examState.data && examState.data.sections) || [];
  const seen = new Map();
  for (const s of existing) if (s.section_key) seen.set(s.section_key, s.title || s.section_key);
  if (current && !seen.has(current)) seen.set(current, current);
  const opts = [...seen.entries()].map(([k, t]) => `<option value="${esc(k)}" ${k === current ? 'selected' : ''}>${esc(t)}</option>`);
  return `<option value="">— none —</option>` + opts.join('');
}
```

- [ ] **Step 4: Post both fields from every question save path**

There are three: the FormData path (~1222), the JSON path (~1244), and the edit path (~1300). In each, add:

```js
      formData.append('is_compulsory', document.querySelector('#qf_compulsory')?.checked ? '1' : '0');
      formData.append('section_key', document.querySelector('#qf_section')?.value || '');
```

```js
        is_compulsory: document.querySelector('#qf_compulsory')?.checked ? 1 : 0,
        section_key: document.querySelector('#qf_section')?.value || '',
```

```js
      is_compulsory: document.querySelector('#qf_compulsory')?.checked ? 1 : 0,
      section_key: document.querySelector('#qf_section')?.value || '',
```

- [ ] **Step 5: Add the selection-rules card**

Add the two functions near `renderTab`:

```js
function selectionRulesCardHTML(examId, sections, selection) {
  const byKey = new Map(selection.map((s) => [s.section_key, s]));
  const keys = [...new Set([...sections.map((s) => s.section_key), ...selection.map((s) => s.section_key)])];
  if (!keys.length) {
    return `<div class="card" style="margin-top:14px">
      <h3 style="margin-bottom:4px">SELECTION <span class="gr">RULES</span></h3>
      <p class="muted qmeta">No section limits which questions a student answers — everyone answers everything. Untick
      <em>Compulsory</em> on some questions and give their section a quota to offer a choice.</p>
    </div>`;
  }
  return `<div class="card" style="margin-top:14px">
    <h3 style="margin-bottom:4px">SELECTION <span class="gr">RULES</span></h3>
    <p class="muted qmeta">Students choose which questions to answer. Compulsory questions are always answered.</p>
    ${keys.map((k) => {
      const s = byKey.get(k) || {};
      const sec = sections.find((x) => x.section_key === k) || {};
      const pool = (s.optional || []).length;
      const forced = (s.compulsory || []).length;
      return `<div class="row" style="margin-top:12px;gap:10px;align-items:flex-end;flex-wrap:wrap">
        <div class="field" style="flex:1;min-width:180px"><label>Section</label>
          <input type="text" data-skey="${esc(k)}" value="${esc(sec.title || k)}"></div>
        <div class="field" style="flex:2;min-width:220px"><label>Paper instruction</label>
          <input type="text" data-sinst="${esc(k)}" value="${esc(sec.instructions || s.instructions || '')}"></div>
        <div class="field" style="width:120px"><label>Answer any</label>
          <input type="number" data-scount="${esc(k)}" min="0" max="${pool}" value="${s.quota || 0}"></div>
        <div class="muted" style="padding-bottom:10px">of ${pool} optional · ${forced} compulsory</div>
      </div>`;
    }).join('')}
    <div class="row" style="margin-top:14px">
      <button class="btn btn-primary" onclick="saveSelectionRules(${examId})">Save selection rules</button>
    </div>
  </div>`;
}

async function saveSelectionRules(examId) {
  const body = { sections: [...document.querySelectorAll('[data-scount]')].map((input) => {
    const k = input.dataset.scount;
    const titleEl = document.querySelector(`[data-skey="${CSS.escape(k)}"]`);
    const instEl = document.querySelector(`[data-sinst="${CSS.escape(k)}"]`);
    return {
      section_key: k,
      title: titleEl ? titleEl.value : k,
      instructions: instEl ? instEl.value : '',
      answer_count: parseInt(input.value, 10) || 0,
    };
  }) };
  await api(`/api/exams/${examId}/sections`, { method: 'PATCH', body });
  invalidateCache(`/api/exams/${examId}`);
  toast('Selection rules saved');
  renderExam(examId);
}
```

Render it in the questions branch of `renderTab`, above the question list:

```js
      ${selectionRulesCardHTML(id, examState.data.sections || [], examState.data.selection || [])}
```

- [ ] **Step 6: Badge compulsory questions in the list**

In `qitemHTML`, next to the existing question meta, add `${q.is_compulsory === 0 ? '<span class="pass" title="Student may choose not to answer this">optional</span>' : '<span class="muted" title="Always answered">🔒 compulsory</span>'}`.

- [ ] **Step 7: Add the rule summary to the Edit modal**

In `editExamMeta`, after the pass-mark field (line 1954), add:

```js
    ${(examState.data.selection || []).filter((s) => s.quota > 0).length
      ? `<div class="field"><label>Selection rules</label><div class="muted">${
          examState.data.selection.filter((s) => s.quota > 0)
            .map((s) => `${esc(s.title || s.section_key)}: answer any ${s.quota} of ${s.optional.length}`)
            .join('<br>')}</div></div>`
      : '<div class="field"><label>Selection rules</label><div class="muted">None — students answer every question.</div></div>'}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `node --test test/question-selection.test.js`
Expected: PASS.

- [ ] **Step 9: Run the full suite and lint the frontend**

Run: `npm test`
Expected: PASS.

Then open the exam page at `http://localhost:8080` after `npm run start:all` and confirm by hand: the card renders, a question can be made optional, the quota saves and survives a reload, and an in-flight paper shows the summary line.

- [ ] **Step 10: Commit**

```bash
git add src/public/app.js test/question-selection.test.js
git commit -m "feat(dashboard): compulsory toggle and per-section selection rules"
```

---

## Task 9: End-to-end verification

**Files:**
- Modify: `test/question-selection.test.js` (append)
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: one full-flow test and updated feature docs.

- [ ] **Step 1: Write the end-to-end test**

Append to `test/question-selection.test.js`:

```js
test('a selective paper is walked end to end: compulsory first, then the choice', async () => {
  // Section A: answer-all. Section B: three optional, choose two. The pool MUST
  // exceed the quota or the rule clamps to answer-all and never fires — a
  // two-question pool with answer_count 2 is not a selective section at all.
  const eid = paperExam([
    { compulsory: true, section: 'a' },
    { compulsory: true, section: 'a' },
    { compulsory: false, section: 'b' },
    { compulsory: false, section: 'b' },
    { compulsory: false, section: 'b' },
  ]);
  rule(eid, 'a', 'SECTION A', 0);
  rule(eid, 'b', 'SECTION B', 2);

  const phone = '23355500000';
  const sid = examSvc.createSession(eid, 1);
  const pool = poolOf(sid.id, 'b');          // session q_orders, never template ids
  assert.equal(pool.length, 3, 'three selectable questions');

  const cap = captureWa();
  try {
    // Compulsory questions first: answering them must not open a selector.
    await examSvc.handleInbound(phone, 'START');
    const beforeOptional = cap.sent.length;
    await examSvc.handleInbound(phone, 'an answer to A1');
    await examSvc.handleInbound(phone, 'an answer to A2');

    assert.equal(
      cap.sent.find((m) => m.kind === 'list'), undefined,
      'no selector while section A is still being answered'
    );
    assert.equal(sessionRow(sid).current_q_order, pool[0],
      'the first optional question is now current');

    // Choose the first and last optional, leaving the middle one behind.
    const skippedOrder = pool[1];
    const skippedText = db.prepare('SELECT text FROM session_questions WHERE session_id=? AND q_order=?')
      .get(sid.id, skippedOrder).text;

    await examSvc.handleInbound(phone, `${pool[0]},${pool[2]} CONFIRM`);
    assert.match(cap.sent.map((m) => m.text || m.body || '').join('\n'), /Locked in/);

    const flags = db.prepare(
      `SELECT sq.q_order, qp.is_selected FROM session_questions sq
         JOIN question_pool qp ON qp.id = sq.question_id
        WHERE sq.session_id = ? ORDER BY sq.q_order`
    ).all(sid.id);
    assert.equal(flags.find((r) => r.q_order === pool[0]).is_selected, 1);
    assert.equal(flags.find((r) => r.q_order === skippedOrder).is_selected, 0,
      'the unchosen question is deselected');
    assert.equal(flags.find((r) => r.q_order === pool[2]).is_selected, 1);

    assert.ok(
      !cap.sent.some((m) => (m.text || '').includes(skippedText)),
      'the unchosen question is never delivered'
    );
    assert.ok(beforeOptional < cap.sent.length, 'delivery continued past the compulsory block');
  } finally { cap.restore(); }
});
```

> The reply uses session `q_order`s from `poolOf`, never `sectionPlan(...).optional[i].id`.
> `sectionPlan` is template space: those ids are `questions.id` rows that have not been
> copied into `question_pool` yet, so using them here marks nothing and the selector
> silently reopens.

- [ ] **Step 2: Run it**

Run: `node --test test/question-selection.test.js`
Expected: PASS if Tasks 3-5 held. If it fails on "no selector while section A is
still being answered", `needsChoice` is firing on a compulsory question — check that
the row passed to it carries `is_compulsory` from the pool join, not the template.
If it fails on `current_q_order`, `nextInSequence` is returning a raw `q_order + 1`
instead of skipping deselected rows.

- [ ] **Step 3: Run everything one final time**

Run: `npm test`
Expected: PASS, all files.

- [ ] **Step 4: Update the README**

Add to the Features list and the Exam workflow section:

```markdown
- **Answer any N of M**: papers that ask the student to choose are honoured.
  Rules are read from the uploaded PDF ("Answer any FOUR questions from
  Section B", "Questions 1 and 2 are compulsory"), editable in the dashboard,
  and the student picks their questions by tapping in WhatsApp. Compulsory
  questions are never offered as a choice.
```

- [ ] **Step 5: Commit**

```bash
git add test/question-selection.test.js README.md
git commit -m "docs: student question selection in the feature list and workflow"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| §1 Data model, all nine columns + `exam_sections` | Task 1 |
| §1 `is_selected DEFAULT 1` guarantee | Task 1 (test), Task 3 (test) |
| §1 Derived rules (clamp, answer-all, implicit section) | Task 2 |
| §1 `topUpPool` / AI generator copy the columns | Task 3, Task 6 |
| §2 Per-question selection facts in the extraction prompt | Task 7 |
| §2 Derive section rules by grouping; never match on `q_order` | Task 7 |
| §2 Reconciliation: drop phantom numbers, clamp, write nothing | Task 7 |
| §2 Write `is_compulsory` in BOTH directions | Task 7 |
| §3a Four seams | Task 4 |
| §3b Selector messages, list + buttons | Task 4 |
| §3c Reply protocol incl. `CHANGE` window | Task 4 |
| §3d Text fallback > 10 rows | Task 4 |
| §3e Ordering, byte-identical when no quota | Task 3 |
| §3f Commit before send; outbox deliberately unused | Task 4 |
| §3g Resume mid-selection | Task 4 |
| §4 `paper_total`, immutability, legacy fallback | Task 5 |
| §5 Admin UI | Task 6, Task 8 |
| §6 Tests 1-10 | Tasks 2-8 |

**Three corrections found during self-review, all of which produced silently
wrong exams rather than errors.**

1. **PDF extraction has no `selection` envelope.** `extractQuestionsFromText`
   returns a flat array of questions. The original Task 7 read `parsed.selection`,
   which is permanently `undefined` — the reconciliation would have never run and no
   paper would ever get rules, with no failure to notice. Task 7 now asks for the
   facts per question and derives sections by grouping, which is the shape the
   pipeline actually returns.
2. **`q_order` is not the paper's question number.** Compulsory matching was
   positional, so one dropped block would force the wrong question compulsory. Task 1
   adds `questions.source_number` and Task 7 keeps `g.number` and matches on it.
3. **`is_compulsory` must be written in both directions.** The column defaults to 1,
   so a reconciliation that only ever *forces* questions leaves the whole pool
   compulsory, every quota clamps to answer-all, and every rule is silently dropped.
   Task 7 writes `1` for forced and `0` for the rest, and the test pins both.

**One gap, stated rather than hidden.** The spec's test 3 mentions `CONFIRM` with an
over-quota reply. Task 4 covers the typed over-quota rejection in `handleReply`, but
the spec's §3c row "over-quota rejected" for *tapped* rows is only partially covered —
`handleReply` refuses a 4th tap once `chosen.size === plan.quota`. That is the intended
behaviour and is implemented; it simply has no dedicated assertion. Add one to Task 4's
step-1 block if a reviewer wants it pinned.

**One deviation from the spec, deliberate.** The spec described provisional taps as
being held outside `session_questions.is_selected`; Task 4 introduces a
`sessions.selection_tentative` column for them. The spec's intent — that
`is_selected` is only ever written by a commit — is preserved and now has a concrete
mechanism, which the spec had left implicit.

**The design doc still needs one amendment.** `docs/plans/2026-10-05-student-question-selection-design.md`
§1 predates both `selection_tentative` and `source_number`, and §2 still describes a
top-level `selection` array. Amend it alongside Task 1/7 or the two documents will
contradict each other at review time.

**Type consistency.** `selection` exports `sectionsForExam`, `sectionPlan`,
`isSelective`, `computePaperTotal`, `applySelection`, `hasSelections`, `needsChoice`,
`beginChoice`, `sendSelector`, `handleReply`. Tasks 4-8 call only those names. The one
signature worth re-reading at implementation time is `needsChoice(session, question)`,
which takes the **question row**, not a q_order.

**Two test-helper traps, both now handled.** `examSvc.createSession()` returns the
session *row*, which already carries `.id` — so `sessionRow(sid)` would bind an object
to a SQLite parameter and throw; `sidOf` now accepts a row or a bare id. And an
end-to-end selective paper needs a pool *larger* than the quota: a two-question pool
with `answer_count: 2` clamps to answer-all and the selector never opens, which reads
as "the feature does not work" rather than as a bad fixture.