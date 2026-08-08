# Exam Delivery, Watermark, UI, and AI-Grading Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five production issues — sessions that stop before the exam's full question set, watermark/source lines leaking into WhatsApp bubbles, white/blank boxes in the admin app, and answers left "pending admin review" — by making delivery sequence-aware, sanitizing watermark lines at three layers, cleaning the UI renderers, and letting the AI (a 40-year-examiner persona) grade everything.

**Architecture:** Changes live in `src/services/exam.js` (sequence-aware advance + pool top-up + send-time sanitization), `src/services/ai.js` (persona, `resolveObjectiveAnswer`, extraction rule, completeness estimate), `src/services/pdfImport.js` (import-time sanitization + completeness warning), a new tiny shared `src/services/textClean.js`, `src/services/db.js` (one additive `jobs.warning` column via the existing `ensureColumn` migration), `src/services/results.js` (untouched safety net), and `src/public/app.js` (UI renderers + warning display). Pure functions are exported and unit-tested; the WhatsApp/network-heavy paths stay untested per the repo's existing convention.

**Tech Stack:** Node.js >= 22 (CommonJS), `node:sqlite` DatabaseSync, `node:test`, no new dependencies, no table redesigns.

## Global Constraints

- Node.js >= 22.5, CommonJS, `node:test` (`node --test test/regression.test.js`). No new dependencies.
- **No table redesigns.** One *additive* column migration is allowed through the existing `ensureColumn` helper (`src/db.js:183-189`), mirroring how `questions.passage` and `answers.ai_detected` were added. Existing DBs get it automatically at startup.
- **FK constraint (hard, discovered during planning):** `session_questions.question_id` is `REFERENCES question_pool(id) ON DELETE CASCADE` and `PRAGMA foreign_keys = ON` (`src/db.js:11,132-138`). Therefore **a drawn `question_id` can NEVER hold a template `questions.id`** — the top-up must *copy* template questions into `question_pool` (carrying `scheme_json`), never reference the `questions` table from `session_questions`. This supersedes the spec's "resolve from pool OR questions" wording, which would violate the FK.
- All existing tests stay green (28/28 at plan start).
- Do not change `formatExamIntro`, the AI-copied-answer caution flow, `sendQuestionTo`'s multi-bubble semantics, or marking-scheme *generation* logic beyond persona/prompt text.
- `stripSourceWatermarks` must only drop standalone watermark/footer lines — never a passage sentence that merely mentions a URL or "source".
- The `jobs.warning` message is human-readable and shown by the frontend upload dialog; a warning must never set the job to `error`.

---

## File Structure

- `src/services/textClean.js` — **new.** `stripSourceWatermarks(text)` pure sanitizer. Shared by `exam.js` (send time) and `pdfImport.js` (import time). No imports, no side effects.
- `src/services/ai.js` — add `EXAMINER_PERSONA` + `examinerPrompt(base)` helper; prepend persona to `markTheory`, `answerObjectiveQuestions`, `verifyObjectiveAnswers`, `generateTheoryScheme`; add `resolveObjectiveAnswer`; add extraction-prompt watermark rule; add `estimateQuestionCount(text)` + `completenessWarning(estimate, extracted)`.
- `src/services/exam.js` — add `nextInSequence(session, question)`; rework the advance + already-answered skip loops in `processAnswer`; top up the pool in `drawSessionQuestions`; replace the objective no-key `needs_review=1` branch in `handleAnswer`; add retry + final-zero in `markAllPendingTheory`; apply `stripSourceWatermarks` in `buildQuestionBubbles`.
- `src/services/pdfImport.js` — sanitize each parsed question's `text`/`passage` before insert; set `warning` on the job after extraction.
- `src/services/db.js` — add `ensureColumn('jobs', 'warning', "TEXT DEFAULT ''")`.
- `src/public/app.js` — `renderTab` questions list passes the previous question's passage into `qitemHTML`; `qitemHTML` renders `↳ same passage as above` for repeats; `schemeHTML` renders blocks only when non-empty; `pollPdfJob` done branch shows `job.warning`.
- `test/regression.test.js` — new tests (each task appends here; existing 28 tests must stay green).

---

## Task 1: Sequence-aware advance (`nextInSequence`)

**Files:**
- Modify: `src/services/exam.js:451-486` (already-answered skip loop + normal advance), `:777-798` (exports)
- Test: `test/regression.test.js`

**Interfaces:**
- Consumes: existing `sessionQuestionSequence(session)` (`exam.js:123-140`) and `getSessionQuestion(sessionId, qOrder)` (`exam.js:99-115`).
- Produces: exported `nextInSequence(session, question)` → next question row in the session's presentation order, or `null` when the current question is last; `null`/fallback `getSessionQuestion(session.id, question.q_order + 1)` when the current question is not found in the sequence.

- [ ] **Step 1: Write the failing test**

Append to `test/regression.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/regression.test.js`
Expected: FAIL — `exam.nextInSequence is not a function`.

- [ ] **Step 3: Implement `nextInSequence` and rework the two advance loops**

Add after `sessionQuestionSequence` (`src/services/exam.js:140`):

```js
/**
 * The question a session presents after `question`, in presentation order.
 * Returns null when the current question is last. If the current question is
 * not part of the sequence (should not happen), falls back to q_order + 1 so
 * behavior degrades gracefully instead of finalizing early.
 */
function nextInSequence(session, question) {
  const seq = sessionQuestionSequence(session);
  const i = seq.findIndex((q) => q.id === question.id);
  if (i === -1) return getSessionQuestion(session.id, question.q_order + 1);
  return seq[i + 1] || null;
}
```

Replace the already-answered skip loop (`src/services/exam.js:454-469`) with:

```js
  if (already) {
    let nq = nextInSequence(session, question);
    while (
      nq &&
      db.prepare('SELECT id FROM answers WHERE session_id = ? AND question_id = ?').get(session.id, nq.id)
    ) {
      nq = nextInSequence(session, nq);
    }
    if (nq) {
      db.prepare('UPDATE sessions SET current_q_order = ? WHERE id = ?').run(nq.q_order, session.id);
      await sendQuestionTo(session, student);
    } else {
      await finalize(session, student, 'completed');
    }
    return;
  }
```

Replace the normal advance (`src/services/exam.js:476-485`) with:

```js
  const nextQ = nextInSequence(session, question);
  if (nextQ) {
    db.prepare(
      `UPDATE sessions SET current_q_order = ?, last_active_at = datetime('now') WHERE id = ?`
    ).run(nextQ.q_order, session.id);
    await sendQuestionTo(session, student);
  } else {
    await finalize(session, student, 'completed');
  }
```

Add to `module.exports` (`src/services/exam.js:777`):

```js
  nextInSequence,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/regression.test.js`
Expected: PASS — new test green, all previous tests still green (28 + 1).

- [ ] **Step 5: Commit**

```bash
git add src/services/exam.js test/regression.test.js
git commit -m "fix(exam): advance sessions by sequence position, not q_order+1"
```

---

## Task 2: Top up the session draw when the pool is smaller than the exam

**Files:**
- Modify: `src/services/exam.js:81-92` (`drawSessionQuestions`)
- Test: `test/regression.test.js`

**Interfaces:**
- Consumes: existing `shuffle` (`exam.js:67-74`), the `question_pool` and `questions` tables.
- Produces: `drawSessionQuestions(sessionId, examId)` returns `chosen.length` as today, but now draws `n` rows even when the pool starts smaller than `n` — by copying template `questions` rows (with their `scheme_json` from `marking_schemes`) into `question_pool` first, skipping templates whose exact text already exists in the pool. `session_questions.question_id` always references a `question_pool` row (FK-safe).

- [ ] **Step 1: Write the failing test**

Append to `test/regression.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/regression.test.js`
Expected: FAIL — `assert.equal(drawn, 5)` is `2` (current `drawSessionQuestions` draws only the 2 pool rows).

- [ ] **Step 3: Implement the top-up**

Replace `drawSessionQuestions` (`src/services/exam.js:81-92`) with:

```js
/**
 * Assign a fresh random question set for an attempt. When the exam has a
 * question pool, each session draws its own subset in a random order, so
 * different students (and retakes) see different questions. If the pool is
 * smaller than the exam's question count, missing template questions are
 * COPIED into the pool first (with their marking scheme) so every session
 * presents the full exam. Copies keep session_questions.question_id pointing
 * at question_pool rows, which its FK constraint requires.
 */
function drawSessionQuestions(sessionId, examId) {
  const n = db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(examId).c;
  if (!n) return 0;
  const pool = db.prepare('SELECT id, text FROM question_pool WHERE exam_id = ?').all(examId);
  if (pool.length < n) topUpPool(examId, pool, n);
  const ids = db.prepare('SELECT id FROM question_pool WHERE exam_id = ?').all(examId);
  const chosen = shuffle(ids).slice(0, n);
  const ins = db.prepare(
    'INSERT INTO session_questions (session_id, question_id, q_order) VALUES (?,?,?)'
  );
  chosen.forEach((p, i) => ins.run(sessionId, p.id, i + 1));
  return chosen.length;
}

/** Copy template questions into the pool until it holds at least `target` rows. */
function topUpPool(examId, currentPool, target) {
  const inPool = new Set(currentPool.map((r) => String(r.text || '').trim()));
  const templates = db.prepare('SELECT * FROM questions WHERE exam_id = ? ORDER BY q_order').all(examId);
  const insertPool = db.prepare(
    `INSERT INTO question_pool (exam_id, type, text, passage, options, correct_answer, marks, difficulty, learning_objective, explanation, scheme_json, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  let added = 0;
  for (const t of templates) {
    if (currentPool.length + added >= target) break;
    const text = String(t.text || '').trim();
    if (inPool.has(text)) continue; // already represented in the pool
    const scheme = db.prepare('SELECT scheme FROM marking_schemes WHERE question_id = ?').get(t.id);
    insertPool.run(
      examId, t.type, t.text, t.passage || '', t.options || null, t.correct_answer || null,
      t.marks, t.difficulty || 'medium', t.learning_objective || '', t.explanation || '',
      scheme ? scheme.scheme : '', t.source || 'manual'
    );
    inPool.add(text);
    added++;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/regression.test.js`
Expected: PASS — new test green; the existing `sessionQuestionSequence resolves drawn pool order...` test (`test/regression.test.js:268`) still passes.

- [ ] **Step 5: Commit**

```bash
git add src/services/exam.js test/regression.test.js
git commit -m "fix(exam): top up the session pool with template questions when it is short"
```

---

## Task 3: PDF import completeness warning

**Files:**
- Modify: `src/services/ai.js` (add `estimateQuestionCount` + `completenessWarning`; export), `src/services/db.js:190-192` (add `ensureColumn('jobs','warning',...)`), `src/services/pdfImport.js:118-120` (compute + persist warning)
- Test: `test/regression.test.js`

**Interfaces:**
- Produces (ai.js): `estimateQuestionCount(text)` → integer count of question-numbered lines (`/^\s*\d{1,3}\s*[.)]\s/gm`); `completenessWarning(estimate, extracted)` → `null` when `extracted.length` is not far below `estimate` (specifically when `estimate < 3 || extracted * 2 >= estimate`), otherwise a string message `"Extracted X questions, but the document appears to contain ~Y. Some questions (often the theory section) may have been missed."`.
- Produces (pdfImport.js): sets `warning` on the job (surfaces via existing `SELECT *` job queries).
- Consumes (frontend, Task 9): `job.warning` string.

- [ ] **Step 1: Write the failing tests**

Append to `test/regression.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/regression.test.js`
Expected: FAIL — `ai.estimateQuestionCount is not a function`.

- [ ] **Step 3: Implement the helpers**

Add to `src/services/ai.js` near `splitIntoBlocks` (around `:570`):

```js
/**
 * Rough count of how many questions a document contains, based on question
 * numbers ("1." / "2)" style) at line starts. Used to warn when an import
 * extracts far fewer questions than the paper clearly holds.
 */
function estimateQuestionCount(text) {
  const lines = String(text || '').split(/\r?\n/);
  return lines.filter((l) => /^\s*\d{1,3}\s*[.)]\s/.test(l)).length;
}

/** Human-readable warning, or null when the extraction looks complete. */
function completenessWarning(estimate, extracted) {
  const count = Array.isArray(extracted) ? extracted.length : 0;
  if (estimate < 3 || count * 2 >= estimate) return null;
  return `Extracted ${count} questions, but the document appears to contain ~${estimate}. Some questions (often the theory section) may have been missed.`;
}
```

Export both in `ai.js` `module.exports` (after `trailingContext`):

```js
  estimateQuestionCount,
  completenessWarning,
```

Add the column migration in `src/services/db.js` (after line 192):

```js
ensureColumn('jobs', 'warning', "TEXT DEFAULT ''");
```

- [ ] **Step 4: Wire the warning into the import job**

In `src/services/pdfImport.js` after the `if (!parsed.length)` guard (`:118-120`):

```js
    const warning = ai.completenessWarning(ai.estimateQuestionCount(text), parsed);
    if (warning) updateJob(jobId, { warning });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/regression.test.js`
Expected: PASS — new helpers green, all prior tests green.

- [ ] **Step 6: Commit**

```bash
git add src/services/ai.js src/services/db.js src/services/pdfImport.js test/regression.test.js
git commit -m "feat(import): warn when a PDF extraction looks incomplete"
```

---

## Task 4: `stripSourceWatermarks` sanitizer (shared module)

**Files:**
- Create: `src/services/textClean.js`
- Test: `test/regression.test.js`

**Interfaces:**
- Produces: `stripSourceWatermarks(text)` → string. Drops a whole line when it (case-insensitive) contains `www.`/`http://`/`https://`, contains `sronu`, matches `/downloaded\s+(from|by)|source\s*[:=]|visit\s+(us\s+)?at\b/i`, or is entirely a bare domain `/^[a-z0-9][a-z0-9-]*\.(com|org|net|gh|edu|co)\b/i`. Collapses runs of 2+ newlines to one and trims. Never drops mid-sentence mentions.
- Consumed by: Task 5 (send + import time).

- [ ] **Step 1: Write the failing tests**

Append to `test/regression.test.js`:

```js
const { stripSourceWatermarks } = require('../src/services/textClean');

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/regression.test.js`
Expected: FAIL — `Cannot find module '../src/services/textClean'`.

- [ ] **Step 3: Implement the sanitizer**

Create `src/services/textClean.js`:

```js
'use strict';

// Watermark / source / download footer lines that get glued onto extracted
// questions (e.g. "DOWNLOADED FROM SRONU papers.sronu.com") must never reach a
// student. Only STANDALONE lines matching a precise, safe pattern are dropped:
// a passage sentence that merely mentions a URL or "source" survives.
const BARE_DOMAIN = /^[a-z0-9][a-z0-9-]*\.(com|org|net|gh|edu|co)\b/i;
const WATERMARK = /(www\.|https?:\/\/)|sronu|downloaded\s+(from|by)|source\s*[:=]|visit\s+(us\s+)?at\b/i;

function stripSourceWatermarks(text) {
  const lines = String(text || '').split(/\r?\n/);
  const kept = lines.filter((line) => {
    const l = line.trim();
    if (!l) return true; // blank lines are collapsed below, not dropped
    return !(WATERMARK.test(l) || BARE_DOMAIN.test(l));
  });
  return kept.join('\n').replace(/\n{2,}/g, '\n').trim();
}

module.exports = { stripSourceWatermarks };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/regression.test.js`
Expected: PASS — all new sanitizer tests green; existing 28 + earlier new tests green.

- [ ] **Step 5: Commit**

```bash
git add src/services/textClean.js test/regression.test.js
git commit -m "feat(text): add stripSourceWatermarks sanitizer for watermark footer lines"
```

---

## Task 5: Apply watermark stripping at send time, import time, and in the extraction prompt

**Files:**
- Modify: `src/services/exam.js:205-218` (`buildQuestionBubbles`), `src/services/pdfImport.js:159-220` (insert loop), `src/services/ai.js:407-418` (extraction rules)
- Test: `test/regression.test.js`

**Interfaces:**
- Consumes: `stripSourceWatermarks` from Task 4.
- Produces: `buildQuestionBubbles` emits passage text that has already passed `stripPaperOnlyInstructions` AND `stripSourceWatermarks`; the "already sent" comparison uses the same cleaned text; imported questions store cleaned `text`/`passage`.

- [ ] **Step 1: Write the failing tests**

Append to `test/regression.test.js`:

```js
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
  assert.equal(out.filter((b) => b === passage).length, 1, 'passage emitted exactly once across both questions');
  assert.equal(out.filter((b) => b.startsWith('*THEORY*')).length, 1, 'banner emitted exactly once');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/regression.test.js`
Expected: FAIL — the first test's `doesNotMatch(/sronu/i)` (the dirty passage is emitted verbatim today).

- [ ] **Step 3: Sanitize in `buildQuestionBubbles`**

Replace `src/services/exam.js:212-215` with:

```js
  const clean = (p) => stripPaperOnlyInstructions(stripSourceWatermarks(p)).trim();
  const passage = clean(question.passage);
  if (passage && !prev.some((q) => clean(q.passage) === passage)) {
    bubbles.push(passage);
  }
```

Add the import at the top of `src/services/exam.js` (after line 7):

```js
const { stripSourceWatermarks } = require('./textClean');
```

- [ ] **Step 4: Sanitize at import time in `pdfImport.js`**

Add the import at the top of `src/services/pdfImport.js` (after line 4):

```js
const { stripSourceWatermarks } = require('./textClean');
```

In the insert loop (`src/services/pdfImport.js:162-164`), sanitize right where the passage is carried forward:

```js
    for (const g of parsed) {
      if (g.passage && String(g.passage).trim()) curPassage = stripSourceWatermarks(String(g.passage).trim());
      const passage = curPassage;
      g.text = stripSourceWatermarks(g.text);
```

- [ ] **Step 5: Add the extraction-prompt rule in `ai.js`**

In `extractQuestionsFromText`'s system prompt rules block (`src/services/ai.js`, after line 417), add:

```
- WATERMARK LINES: Never copy watermark, source, or download footer/header lines (e.g. "Downloaded from sronu.com", "Source: www.example.com", "DOWNLOADED FROM SRONU") into text, passage, or instructions. Always drop such lines.
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/regression.test.js`
Expected: PASS — new bubble tests green; the existing passage-once tests (`:254-261`) still green.

- [ ] **Step 7: Commit**

```bash
git add src/services/exam.js src/services/pdfImport.js src/services/ai.js test/regression.test.js
git commit -m "fix(watermark): strip source watermark lines at send, import, and extraction"
```

---

## Task 6: Admin app — questions tab passage dedup

**Files:**
- Modify: `src/public/app.js:556-564` (`renderTab` questions branch), `:636-655` (`qitemHTML`)
- Test: manual/visual (no frontend test harness exists). Verify in smoke test (Task 12).

**Interfaces:**
- Produces: `qitemHTML(q, id, samePassageAsPrev)` — third param boolean; when true and `q.passage` is non-empty, renders `↳ same passage as above` in place of the `.qpassage` box. No signature used elsewhere (only `renderTab` calls it).

- [ ] **Step 1: Implement**

In `renderTab`'s `questions` branch (`src/public/app.js:563-564`), replace the `.map` with a tracked map:

```js
      ${questions.map((q, i) => {
        const prev = i > 0 ? questions[i - 1] : null;
        const same = !!q.passage && !!prev && prev.passage === q.passage;
        return qitemHTML(q, id, same);
      }).join('')}`;
```

In `qitemHTML` (`src/public/app.js:636-655`), change the signature and passage rendering:

```js
function qitemHTML(q, id, samePassageAsPrev = false) {
  const opts = q.options || [];
  return `<div class="qitem">
    <div class="qhead">
      <div>
        <div class="muted" style="font-size:12px">Q${q.q_order} · ${q.type} · ${q.marks} mark(s) · ${q.difficulty} · ${badge(q.source)}</div>
        ${q.passage && samePassageAsPrev
          ? `<div class="qpassage-same">↳ same passage as above</div>`
          : q.passage ? `<div class="qpassage">${esc(q.passage)}</div>` : ''}
        <div class="qtext">${esc(q.text)}</div>
```

- [ ] **Step 2: Verify**

Start the app (`npm run start:all`), open the Questions tab of the existing exam with a comprehension paper. Confirm the passage box appears once and later group members show `↳ same passage as above`; confirm the white box is gone. No unit tests (no frontend harness).

- [ ] **Step 3: Commit**

```bash
git add src/public/app.js
git commit -m "feat(app): collapse repeated comprehension passage boxes on the questions tab"
```

---

## Task 7: Admin app — marking scheme tab empty-block cleanup

**Files:**
- Modify: `src/public/app.js:657-681` (`schemeHTML`)
- Test: manual/visual (Task 12). Add a tiny regression test for any extracted helper if trivial; otherwise verify visually.

**Interfaces:**
- Produces: `schemeHTML(q, id)` renders each block only when it has content; renders no `.scheme` box at all when nothing remains.

- [ ] **Step 1: Implement**

Replace `schemeHTML`'s summary-building body (`src/public/app.js:659-670`) with content-gated blocks:

```js
  let summary = '';
  if (q.type === 'objective') {
    summary = `<p><b>Correct answer:</b> ${esc(scheme?.correct_answer || q.correct_answer || '—')} &nbsp; <b>Marks:</b> ${q.marks}</p>`;
  } else if (scheme) {
    const parts = [];
    if (scheme.model_answer && String(scheme.model_answer).trim()) {
      parts.push(`<p><b>Model answer:</b> ${esc(scheme.model_answer)}</p>`);
    }
    const points = scheme.key_points || [];
    if (points.length) {
      parts.push(`<p><b>Key points:</b></p><ul>${points.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>`);
    }
    const rubric = scheme.rubric || [];
    if (rubric.length) {
      parts.push(`<p><b>Rubric:</b></p>
      <table><thead><tr><th>Point</th><th>Marks</th><th>Explanation</th></tr></thead>
      <tbody>${rubric.map((r) => `<tr><td>${esc(r.point)}</td><td>${r.marks}</td><td>${esc(r.explanation || '')}</td></tr>`).join('')}</tbody></table>`);
    }
    if (Number(scheme.presentation_marks) || Number(scheme.grammar_marks)) {
      parts.push(`<p class="muted">Presentation: ${scheme.presentation_marks || 0} · Grammar: ${scheme.grammar_marks || 0}</p>`);
    }
    summary = parts.join('');
  }
```

Update the box renderer at the bottom of `schemeHTML` (`src/public/app.js:679`) to skip the box when there is nothing to show:

```js
    ${summary
      ? `<div class="scheme">${summary}</div>`
      : q.type === 'theory' ? '' : '<div class="scheme"><span class="muted">No scheme yet.</span></div>'}
```

- [ ] **Step 2: Verify**

Start the app, open the Marking Scheme tab. Confirm questions whose scheme has only, say, `presentation_marks: 0 / grammar_marks: 0` and empty `model_answer`/`key_points`/`rubric` no longer render empty boxes or a filler `—` row.

- [ ] **Step 3: Commit**

```bash
git add src/public/app.js
git commit -m "feat(app): hide empty marking-scheme blocks instead of rendering white boxes"
```

---

## Task 8: Shared examiner persona

**Files:**
- Modify: `src/services/ai.js` (add `EXAMINER_PERSONA` + `examinerPrompt`; prepend to `markTheory:922`, `answerObjectiveQuestions:712`, `verifyObjectiveAnswers:808`, `generateTheoryScheme:668`; export)
- Test: `test/regression.test.js`

**Interfaces:**
- Produces: exported `EXAMINER_PERSONA` (string) and `examinerPrompt(base)` → `EXAMINER_PERSONA + '\n\n' + base`. All four existing AI grading/scheme functions build their `system` via `examinerPrompt(...)`.

- [ ] **Step 1: Write the failing test**

Append to `test/regression.test.js`:

```js
test('EXAMINER_PERSONA is a real persona and examinerPrompt prepends it', () => {
  assert.match(ai.EXAMINER_PERSONA, /40 years of experience/i, 'persona carries the examiner experience');
  const out = ai.examinerPrompt('BASE');
  assert.ok(out.startsWith(ai.EXAMINER_PERSONA), 'persona leads the prompt');
  assert.match(out, /BASE/, 'base content follows the persona');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/regression.test.js`
Expected: FAIL — `ai.EXAMINER_PERSONA` is undefined.

- [ ] **Step 3: Implement**

Add to `src/services/ai.js` right after `SYSTEM_BASE` (around `:147-151`):

```js
const EXAMINER_PERSONA =
  'You are a genuine, sincere, objective professional teacher and chief examiner with more than 40 years of experience, deeply well-versed in national examinations (including the Ghana BECE). You grade fairly, honestly, and consistently: you give full credit where it is due, partial credit for partially correct work, and no credit only where nothing was earned. You never mark down out of strictness or mark up out of sympathy.';

/** Wrap any grading/scheme system prompt with the shared examiner persona. */
function examinerPrompt(base) {
  return `${EXAMINER_PERSONA}\n\n${base}`;
}
```

Then change each of the four system prompts from `const system = SYSTEM_BASE + \`...\`` to `const system = examinerPrompt(SYSTEM_BASE + \`...\`)` at:
- `generateTheoryScheme` (`:668`)
- `answerObjectiveQuestions` (`:712`)
- `verifyObjectiveAnswers` (`:808`)
- `markTheory` (`:922`)

Export in `ai.js` `module.exports`:

```js
  EXAMINER_PERSONA,
  examinerPrompt,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/regression.test.js`
Expected: PASS — persona test green; all prior tests green.

- [ ] **Step 5: Commit**

```bash
git add src/services/ai.js test/regression.test.js
git commit -m "feat(ai): add shared 40-year-examiner persona to all grading prompts"
```

---

## Task 9: `resolveObjectiveAnswer` AI call

**Files:**
- Modify: `src/services/ai.js` (add function; export)
- Test: `test/regression.test.js`

**Interfaces:**
- Produces: `resolveObjectiveAnswer({ questionText, passage, options })` → `Promise<{ correct_index, explanation }>`; `correct_index` is `-1` when the examiner is not certain. Options passed as `0. text` lines. Uses `ANSWER_TIMEOUT_MS`/`ANSWER_MAX_TOKENS`, `temperature: 0.1`, one internal retry (the standard 2-attempt loop), and the `EXAMINER_PERSONA`. On total failure returns `{ correct_index: -1, explanation: '' }` (never throws).
- Consumed by: Task 10 (`handleAnswer`).

- [ ] **Step 1: Write the failing test**

Append to `test/regression.test.js`:

```js
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
```

Note: `resolveObjectiveAnswer` will attempt a real AI call; the repo's existing convention is that AI-call tests only assert shape/contract, and in CI without an API key `chatJSON` throws, which the function must convert to `{ correct_index: -1 }` rather than reject. This test therefore also verifies the never-throws contract when no key is configured.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/regression.test.js`
Expected: FAIL — `ai.resolveObjectiveAnswer is not a function`.

- [ ] **Step 3: Implement**

Add after `answerObjectiveQuestions` (after `:793`):

```js
/**
 * Determine the correct answer for a SINGLE objective question at answer time.
 * Used when a question reached a student with no stored answer key. One
 * question per call keeps latency low mid-exam. Returns correct_index: -1
 * when the examiner is not certain or the AI call fails — callers must never
 * store a guess that would mark innocent students wrong.
 */
async function resolveObjectiveAnswer({ questionText, passage, options = [] }) {
  const system = examinerPrompt(SYSTEM_BASE + `
For the single question below, determine the single correct answer option. Return:
{"correct_index": 2, "explanation": "one short sentence"}
Rules:
- correct_index is the 0-based index into the options array.
- CORRECTNESS IS NON-NEGOTIABLE: only pick an answer you are CERTAIN is correct.
- If the question is ambiguous, has more than one defensible answer, or you are not certain, set correct_index to -1 and explain why. NEVER guess.
- COMPACT OUTPUT: Output ONLY the JSON object.
`);
  const opts = options.map((o, j) => {
    const text = typeof o === 'string' ? o : (o && (o.text ?? o.key)) || '';
    return `  ${j}. ${text}`;
  });
  const user = [
    passage ? `PASSAGE:\n${passage}` : '',
    `QUESTION:\n${questionText}`,
    `Options:\n${opts.join('\n')}`,
  ].filter(Boolean).join('\n\n');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await chatJSON(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        { timeoutMs: ANSWER_TIMEOUT_MS, maxTokens: ANSWER_MAX_TOKENS, maxRetries: 0, temperature: 0.1 }
      );
      const idx = Number(result.correct_index);
      const valid = Number.isInteger(idx) && idx >= 0 && idx < options.length;
      return { correct_index: valid ? idx : -1, explanation: result.explanation || '' };
    } catch (err) {
      if (attempt === 0) {
        await delay(1000);
        continue;
      }
      console.error('[ai] resolveObjectiveAnswer failed:', err.message);
      return { correct_index: -1, explanation: '' };
    }
  }
}
```

Export `resolveObjectiveAnswer` in `ai.js` `module.exports` (after `answerObjectiveQuestions`):

```js
  resolveObjectiveAnswer,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/regression.test.js`
Expected: PASS — contract test green.

- [ ] **Step 5: Commit**

```bash
git add src/services/ai.js test/regression.test.js
git commit -m "feat(ai): add resolveObjectiveAnswer single-question resolver"
```

---

## Task 10: Objective answers with no stored key are AI-graded, never flagged

**Files:**
- Modify: `src/services/exam.js:498-509` (objective no-key branch in `handleAnswer`)
- Test: `test/regression.test.js`

**Interfaces:**
- Consumes: `ai.resolveObjectiveAnswer` (Task 9), `marking.resolveCorrectKey` / `marking.markObjective` (existing).
- Produces: `handleAnswer` no longer inserts any objective answer with `needs_review=1`. On a resolved key it persists `correct_answer` on the question's own row (`question_pool` when `question._pool`, else `questions`; for template questions also refreshes the `marking_schemes` objective scheme) then marks via the existing `markObjective` path with `marked_by='ai'`. On `-1` or AI error it records 0 marks, `marked_by='ai'`, `needs_review=0`, with a neutral note.

- [ ] **Step 1: Write the failing tests**

Append to `test/regression.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/regression.test.js`
Expected: FAIL — today's branch inserts `marked_by='manual'`, `needs_review=1`.

- [ ] **Step 3: Implement**

Replace the no-key branch in `handleAnswer` (`src/services/exam.js:498-509`) with:

```js
    // No verified answer key stored → the AI examiner determines the answer on
    // the spot, persists it for results and future answers, and grades this
    // answer immediately. A genuinely uncertain examiner or an AI failure
    // records 0 marks with a neutral note — never pending admin review.
    if (!marking.resolveCorrectKey(question)) {
      let resolved = null;
      try {
        resolved = await ai.resolveObjectiveAnswer({
          questionText: question.text,
          passage: question.passage || '',
          options: JSON.parse(question.options || '[]'),
        });
      } catch (e) {
        resolved = null;
      }
      const idx = resolved ? Number(resolved.correct_index) : -1;
      const options = JSON.parse(question.options || '[]');
      const key = options[idx] ? String(options[idx].key || '').toUpperCase() : null;

      if (key && idx >= 0) {
        if (question._pool) {
          db.prepare('UPDATE question_pool SET correct_answer = ? WHERE id = ?').run(key, question.id);
        } else {
          db.prepare('UPDATE questions SET correct_answer = ? WHERE id = ?').run(key, question.id);
          db.prepare(
            `INSERT INTO marking_schemes (question_id, type, scheme) VALUES (?, 'objective', ?)
             ON CONFLICT(question_id) DO UPDATE SET scheme=excluded.scheme, updated_at=datetime('now')`
          ).run(question.id, JSON.stringify({
            type: 'objective',
            correct_answer: key,
            marks: question.marks,
            explanation: resolved?.explanation || '',
          }));
        }
        question.correct_answer = key;
        const result = marking.markObjective(question, letter);
        db.prepare(
          `INSERT INTO answers (session_id, question_id, q_order, answer_text, is_correct, marks_awarded, max_marks, marked_by, ai_feedback, needs_review, marked_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))`
        ).run(
          session.id, question.id, question.q_order, letter,
          result.isCorrect ? 1 : 0, result.marksAwarded, result.maxMarks, 'ai',
          `Answer key determined by the AI examiner: ${key}.`, 0
        );
      } else {
        db.prepare(
          `INSERT INTO answers (session_id, question_id, q_order, answer_text, is_correct, marks_awarded, max_marks, marked_by, ai_feedback, needs_review, marked_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))`
        ).run(
          session.id, question.id, question.q_order, letter,
          0, 0, question.marks, 'ai',
          'The examiner could not determine the answer to this question.', 0
        );
      }
      return true;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/regression.test.js`
Expected: PASS — both new tests green; all prior tests green.

- [ ] **Step 5: Commit**

```bash
git add src/services/exam.js test/regression.test.js
git commit -m "fix(exam): AI-grade objective answers with no stored key instead of flagging review"
```

---

## Task 11: Robust theory marking — one retry, then zero with a note

**Files:**
- Modify: `src/services/exam.js:570-604` (`markAllPendingTheory`)
- Test: `test/regression.test.js`

**Interfaces:**
- Consumes: `marking.markTheoryAnswer`, `ai.mapLimit`, `getSessionQuestion`.
- Produces: each pending theory answer gets one automatic retry (~1s wait) before the final result is stored. On final failure, the answer is `marked_by='ai'`, `marks_awarded=0`, `needs_review=0`, with the note "The examiner could not mark this answer; 0 marks were recorded." Never `needs_review=1`.

- [ ] **Step 1: Write the failing test**

Append to `test/regression.test.js`:

```js
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
```

Note: `marking.markTheoryAnswer` is patched to throw on every attempt, so this exercises the retry AND the final-failure path. The test takes ~1s (the single retry wait).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/regression.test.js`
Expected: FAIL — today's catch sets `marked_by='manual'`, `needs_review=1`.

- [ ] **Step 3: Implement**

Replace `markAllPendingTheory` (`src/services/exam.js:570-604`) with:

```js
async function markAllPendingTheory(sessionId) {
  const pending = db
    .prepare(`SELECT * FROM answers WHERE session_id = ? AND marked_by = 'pending' ORDER BY q_order`)
    .all(sessionId);
  if (!pending.length) return;

  const tasks = pending.map((a) => async () => {
    const question = getSessionQuestion(sessionId, a.q_order);
    if (!question) return;
    let scheme = null;
    if (question._pool) {
      try {
        scheme = JSON.parse(question.scheme_json || '{}');
      } catch {
        scheme = null;
      }
    }
    let marked;
    try {
      marked = await marking.markTheoryAnswer(question, a.answer_text, scheme);
    } catch (err) {
      await delay(1000);
      try {
        marked = await marking.markTheoryAnswer(question, a.answer_text, scheme);
      } catch (err2) {
        db.prepare(
          `UPDATE answers SET marked_by='ai', marks_awarded=0, needs_review=0, ai_feedback='The examiner could not mark this answer; 0 marks were recorded.', marked_at=datetime('now') WHERE id=?`
        ).run(a.id);
        return;
      }
    }
    const detected = !!marked.aiGenerated || Number(a.ai_detected) === 1;
    const feedback = detected
      ? `⚠️ AI-written answer detected — 0 marks awarded (copying AI answers is cheating). ${marked.feedback || marked.aiReason}`.trim()
      : marked.feedback;
    db.prepare(
      `UPDATE answers SET marked_by='ai', marks_awarded=?, ai_feedback=?, needs_review=?, ai_detected=?, marked_at=datetime('now') WHERE id=?`
    ).run(detected ? 0 : marked.marksAwarded, feedback, detected ? 1 : 0, detected ? 1 : 0, a.id);
  });

  await ai.mapLimit(tasks, 3, (run) => run());
}
```

Add the `delay` helper (if not present) near the top of `src/services/exam.js` (after the requires):

```js
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/regression.test.js`
Expected: PASS — failure-path test green; existing AI-copied-detection and marking tests green.

- [ ] **Step 5: Commit**

```bash
git add src/services/exam.js test/regression.test.js
git commit -m "fix(exam): retry theory marking once, then award 0 with a note instead of pending review"
```

---

## Task 12: Frontend job-warning display + full verification

**Files:**
- Modify: `src/public/app.js:940-945` (`pollPdfJob` done branch)

**Interfaces:**
- Consumes: `job.warning` (Task 3).

- [ ] **Step 1: Implement**

In `pollPdfJob`, replace the done branch (`src/public/app.js:940-945`) with:

```js
    if (job.status === 'done') {
      clearInterval(timer);
      invalidateCache(`/api/exams/${examId}`);
      div.remove();
      const base = `Extracted ${job.count} questions (schemes generated automatically).`;
      toast(job.warning ? `${base} ${job.warning}` : base);
      renderExam(examId);
    }
```

- [ ] **Step 2: Full verification**

Run:
```bash
node --test test/regression.test.js
```
Expected: all tests pass (28 existing + all new).

```bash
node --check src/services/exam.js
node --check src/services/ai.js
node --check src/services/pdfImport.js
node --check src/services/textClean.js
node --check src/services/db.js
node --check src/public/app.js
```
Expected: no syntax errors.

Manual smoke: `npm run start:all`, upload `bece-english-language-2026.pdf` (contains the SRONU footer) → confirm the job completes, any completeness warning is shown, the questions list has no SRONU lines, one banner + one passage per group, and `↳ same passage as above` rows on the Questions tab; run an exam end-to-end → result message shows all answers scored with no "pending review by your administrator" line.

- [ ] **Step 3: Commit**

```bash
git add src/public/app.js
git commit -m "feat(app): show PDF import completeness warning when the job completes"
```

---

## Self-Review (completed by planner)

1. **Spec coverage:** Section 1a → Task 1; 1b → Task 2 (with the FK-mandated copy-into-pool correction); 1c → Tasks 3 + 12; 2a/2b/2c → Tasks 4 + 5; Section 3 → Task 5 test; 4a/4b → Tasks 6 + 7; 5a/5b → Tasks 8 + 9; 5c → Task 10; 5d → Task 11; 5e → results.js unchanged (safety net); Section 5f → Tasks 10 + 11 tests.
2. **Placeholder scan:** every step carries real code; no "TBD"/"similar to"/"handle edge cases".
3. **Type consistency:** `nextInSequence(session, question)`, `stripSourceWatermarks(text)`, `resolveObjectiveAnswer({...})`, `examinerPrompt(base)`, `completenessWarning(estimate, extracted)`, `estimateQuestionCount(text)` are named identically across definition, exports, consumers, and tests. `qitemHTML(q, id, samePassageAsPrev)` is the only call-site change; `schemeHTML(q, id)` signature unchanged.
4. **Known deviation from spec:** Task 2 copies template questions into `question_pool` instead of referencing `questions` rows from `session_questions`, because the FK (`session_questions.question_id → question_pool(id)`, `PRAGMA foreign_keys=ON`) forbids the spec's wording. Results queries in `results.js` need no change (they join `question_pool` via `sq.question_id` and fall back to `questions` by `a.question_id`). Flagged to the user in the handoff message.

## Exit Criteria

- All tests in `test/regression.test.js` pass (existing 28 + new).
- `node --check` clean on every touched file.
- Manual smoke passes per Task 12 Step 2: no watermark bubble, no repeated instructions, no white boxes, no "pending review" line, session presents the full question set.
