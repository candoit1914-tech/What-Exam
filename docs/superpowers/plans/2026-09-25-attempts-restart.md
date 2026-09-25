# Attempt History and Exam Restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A student can sit the same exam more than once. Every attempt keeps its own answers, score and outcome, and restarting draws a fresh question set without destroying what came before.

**Architecture:** `sessions` gains an `attempt_no`. The hard `UNIQUE(exam_id, student_id)` becomes a **partial** unique index over active sessions only, so history accumulates. `answers.session_id` and `session_questions` already point at the session, so per-attempt isolation is structural rather than something each query has to remember.

**Tech Stack:** Node.js >= 22.5, CommonJS, `node:sqlite` (`DatabaseSync`), Express 4, `node:test` + `node:assert/strict`.

## The Defects

| # | Location | Defect |
|---|---|---|
| 1 | `src/db.js:80` | `sessions` has `UNIQUE(exam_id, student_id)`. A second attempt is impossible — the insert throws, and no migration exists to change that. |
| 2 | `src/services/exam.js:660-700` | `getOrCreateStudent` and `maybeStartSession` treat a session as permanent. There is no way to re-sit, and no record of how many attempts were made. |
| 3 | `src/services/results.js` | Scores are computed per session, so a second attempt would either overwrite the first or require every report to learn about attempts. The current code has no concept of one. |
| 4 | `src/services/exam.js` | No cap exists on attempts, so a student could start unbounded sessions and drive unbounded Meta spend. |

## Why the Unique Index Must Become Partial

`CREATE UNIQUE INDEX ... WHERE` is SQLite's answer to "unique, but only among
live rows":

```sql
CREATE UNIQUE INDEX idx_sessions_active
  ON sessions(exam_id, student_id) WHERE status = 'in_progress';
```

One live attempt at a time, unlimited history. This is a **replacement**, not an
addition — the table-level `UNIQUE(exam_id, student_id)` has to go, or the
index never gets a chance to apply. `db.js:80` is inside the `sessions`
`CREATE TABLE`, and `db.js` runs `SCHEMA` on every boot, so an edited
`CREATE TABLE` will **not** alter the existing table. The rebuild in Task 1 is
what actually performs the change, and `db.js:70-72` must keep running
`SCHEMA` so fresh databases get the new definition.

Terminology: **"active"** means `status = 'in_progress'`. `completed`,
`expired` and `abandoned` are all history. An expired session is not a slot
being held.

## Global Constraints

- Attempt numbering starts at 1 and increments per `(exam, student)`. `max(attempt_no) + 1` is correct only under the partial index; with the old unique index still present it would always be 1.
- Historical data is never rewritten. Attempt 1's answers stay attempt 1's answers.
- A restart draws a **fresh** question set, even if the exam has a single question pool. Re-sitting the identical paper is the documented behaviour, not a bug.
- `max_attempts` is read from exam settings, defaults to unlimited (`0` or `NULL`), and is enforced at start time — not after the send, when the cost is already committed.
- A student who already has an `in_progress` session is **resumed**, never duplicated. Restart is explicit.
- No new dependencies.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/db.js` | `attempt_no` column, partial unique index, table rebuild |
| `src/services/exam.js` | `attemptNoFor`, `restartSession`, `maxAttemptsReached` |
| `src/routes/api.js` | `POST /api/sessions/:id/restart`, attempt history in exam detail |
| `test/attempts.test.js` | All tests |
| `package.json` | Register the test file |

---

## Task 1: Schema — `attempt_no` and the partial unique index

**Files:**
- Modify: `src/db.js:78-80` (the `sessions` `CREATE TABLE`), `src/db.js:70-72` (the `exec(SCHEMA)` call site), and add a migration next to the existing `ensureColumn` block at `src/db.js:231`

**Interfaces:**
- Consumes: nothing.
- Produces: `sessions.attempt_no INTEGER NOT NULL DEFAULT 1`; index `idx_sessions_active` on `(exam_id, student_id) WHERE status = 'in_progress'`.

- [ ] **Step 1: Update the `CREATE TABLE` so fresh databases are correct**

Replace `src/db.js:78-80`:

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id        INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id     INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT NOT NULL DEFAULT (datetime('now')),
  current_q_order INTEGER DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'in_progress',
  score          REAL,
  total_marks    REAL,
  -- Attempt number for this (exam, student). 1 for every row that predates
  -- attempts; a restart increments it. The uniqueness of a live attempt is
  -- enforced by idx_sessions_active below, not by a table constraint, so
  -- finished attempts can accumulate.
  attempt_no     INTEGER NOT NULL DEFAULT 1
);
```

Note what was removed: `UNIQUE(exam_id, student_id)`. It is replaced in Step 3.

- [ ] **Step 2: Add the index to `SCHEMA`**

After the `sessions` table in `SCHEMA`:

```sql
-- One live attempt per (exam, student); unlimited finished history.
-- A partial index is the only way to say "unique, but only among in_progress
-- rows" in SQLite. Without the WHERE clause this would block every restart.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_active
  ON sessions(exam_id, student_id) WHERE status = 'in_progress';
```

- [ ] **Step 3: Add the migration that actually changes existing databases**

`CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
an existing install keeps the old unique constraint. Add this to the migration
section at `src/db.js:231`, after the `ensureColumn` calls:

```js
  ensureColumn('sessions', 'attempt_no', 'INTEGER NOT NULL DEFAULT 1');
  // exams has no settings blob (src/db.js:14-27 lists the real columns), so
  // the per-exam attempt cap is a plain column rather than a JSON key.
  ensureColumn('exams', 'max_attempts', 'INTEGER NOT NULL DEFAULT 0');

  // Replace the table-level UNIQUE(exam_id, student_id) with a partial index.
  // The constraint lives in the CREATE TABLE, so it cannot be dropped in
  // place: the table has to be rebuilt. db.exec here is safe because we are
  // outside a transaction and DDL in SQLite is transactional per statement.
  const hasOldUnique = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'")
    .get().sql.includes('UNIQUE(exam_id, student_id)');
  if (hasOldUnique) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`BEGIN;
      CREATE TABLE sessions_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        exam_id         INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
        student_id      INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        started_at      TEXT NOT NULL DEFAULT (datetime('now')),
        last_active_at  TEXT NOT NULL DEFAULT (datetime('now')),
        current_q_order INTEGER DEFAULT 1,
        status          TEXT NOT NULL DEFAULT 'in_progress',
        score           REAL,
        total_marks     REAL,
        attempt_no      INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO sessions_new
        SELECT id, exam_id, student_id, started_at, last_active_at,
               current_q_order, status, score, total_marks, 1
          FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_active
        ON sessions(exam_id, student_id) WHERE status = 'in_progress';
      COMMIT;`);
    db.exec('PRAGMA foreign_keys = ON');
  }
```

**Take a backup before running this on a real database.** The rebuild drops
and recreates `sessions`; `answers.session_id` and `session_questions.session_id`
are FKs pointing at it. `PRAGMA foreign_keys = OFF` is required, and it must be
re-enabled even if the rebuild throws — wrap the `db.exec` block in
`try/finally` in the real edit if `db.js` has a migration error handler.

Run: `Select-String -Path src/db.js -Pattern "PRAGMA foreign_keys"`
Expected: confirm whether the file already manages this pragma, so the
rebuild matches the existing convention rather than inventing one.

- [ ] **Step 4: Verify the rebuild on a scratch database**

```bash
$env:DB_PATH="./data/_attempts.db"; node src/server.js --init
node -e "
const db=require('./src/db');
const sql=db.prepare(\"SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'\").get().sql;
console.log(sql.includes('UNIQUE(exam_id, student_id)') ? 'FAIL: old unique still there' : 'OK: old unique gone');
console.log(sql.includes('attempt_no') ? 'OK: attempt_no present' : 'FAIL: no attempt_no');
const idx=db.prepare(\"SELECT sql FROM sqlite_master WHERE name='idx_sessions_active'\").get();
console.log(idx && idx.sql.includes('WHERE') ? 'OK: partial index' : 'FAIL: index missing or not partial');
"
Remove-Item ./data/_attempts.db*; Remove-Item Env:DB_PATH -ErrorAction SilentlyContinue
```

Expected: `OK: old unique gone`, `OK: attempt_no present`, `OK: partial index`.

- [ ] **Step 5: Verify a second live attempt is now impossible but history is fine**

```bash
$env:DB_PATH="./data/_attempts2.db"; node -e "
const db=require('./src/db');
db.exec(\"INSERT INTO exams (title,subject,duration_minutes,status) VALUES ('T','M',10,'published')\");
db.exec(\"INSERT INTO students (phone,name) VALUES ('1','S')\");
const e=1,s=1;
db.prepare('INSERT INTO sessions (exam_id,student_id,status) VALUES (?,?,?)').run(e,s,'in_progress');
try { db.prepare('INSERT INTO sessions (exam_id,student_id,status) VALUES (?,?,?)').run(e,s,'in_progress'); console.log('FAIL: two live attempts allowed'); }
catch { console.log('OK: second live attempt refused'); }
db.prepare(\"UPDATE sessions SET status='completed' WHERE exam_id=? AND student_id=?\").run(e,s);
db.prepare('INSERT INTO sessions (exam_id,student_id,status,attempt_no) VALUES (?,?,?,2)').run(e,s,'completed');
console.log('OK: history row added, total =', db.prepare('SELECT COUNT(*) c FROM sessions').get().c);
"
Remove-Item ./data/_attempts2.db*; Remove-Item Env:DB_PATH -ErrorAction SilentlyContinue
```

Expected: `OK: second live attempt refused`, then `OK: history row added, total = 2`.
This is the whole point of the partial index — if history fails here, the
migration is wrong.

- [ ] **Step 6: Commit**

```bash
git add src/db.js
git commit -m "feat(db): allow multiple exam attempts per student

Replaces the table-level UNIQUE(exam_id, student_id) with a partial
unique index over in_progress rows, so one live attempt is enforced
while finished attempts accumulate. Adds sessions.attempt_no, defaulting
to 1 for existing rows. Existing tables are rebuilt because SQLite
cannot drop a constraint declared in CREATE TABLE."
```

---

## Task 2: Attempt bookkeeping and restart

**Files:**
- Modify: `src/services/exam.js` (requires + new functions; export them)
- Create: `test/attempts.test.js`

**Interfaces:**
- Consumes: `db`, `config.exam.maxAttempts` (added in Task 3).
- Produces:
  ```js
  attemptNoFor(examId, studentId) -> number       // next attempt number, 1 if none
  activeSession(examId, studentId) -> session|null
  maxAttemptsReached(examId) -> boolean
  restartSession(examId, studentId) -> { session, restarted: boolean, reason?: string }
  ```
  `restartSession` returns `{ restarted: false, reason: 'already_active' }` when a live attempt exists — it never silently starts a second one.

- [ ] **Step 1: Write the test file with DB isolation**

Create `test/attempts.test.js`:

```js
'use strict';
const os = require('os');
const path = require('path');
process.env.DB_PATH = path.join(os.tmpdir(), `la-exam-attempts-${process.pid}.db`);
process.env.SEED_ON_BOOT = 'false';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const exam = require('../src/services/exam');

const examId = db
  .prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES ('Attempts','Math',30,'published')")
  .run().lastInsertRowid;
for (let i = 1; i <= 3; i++) {
  db.prepare("INSERT INTO questions (exam_id, q_order, type, text, correct_answer, marks) VALUES (?,?,'objective',?,'A',1)")
    .run(examId, i, `q${i}: 1+${i}?`);
}

function student(phone) {
  return db.prepare('INSERT INTO students (phone, name) VALUES (?,?)').run(phone, 'S').lastInsertRowid;
}
function start(sid) {
  return db.prepare("INSERT INTO sessions (exam_id, student_id, status) VALUES (?,?,'in_progress')").run(examId, sid).lastInsertRowid;
}

test('the first attempt is numbered 1', () => {
  const sid = student('23311110001');
  assert.equal(exam.attemptNoFor(examId, sid), 1);
});

test('a completed attempt makes the next number 2', () => {
  const sid = student('23311110002');
  const a1 = start(sid);
  db.prepare("UPDATE sessions SET status='completed', score=1, total_marks=3 WHERE id=?").run(a1);
  assert.equal(exam.attemptNoFor(examId, sid), 2);
});

test('restart creates a fresh attempt and preserves the old answers', async () => {
  const sid = student('23311110003');
  const a1 = start(sid);
  const q = db.prepare('SELECT id FROM questions WHERE exam_id=? ORDER BY q_order').all(examId);
  db.prepare("INSERT INTO answers (session_id, question_id, q_order, answer_text) VALUES (?,?,1,'A')").run(a1, q[0].id);
  db.prepare("UPDATE sessions SET status='completed' WHERE id=?").run(a1);

  const r = await exam.restartSession(examId, sid);
  assert.equal(r.restarted, true);
  assert.equal(r.session.attempt_no, 2);
  assert.equal(r.session.status, 'in_progress');

  const a1Answers = db.prepare('SELECT COUNT(*) c FROM answers WHERE session_id=?').get(a1).c;
  const a2Answers = db.prepare('SELECT COUNT(*) c FROM answers WHERE session_id=?').get(r.session.id).c;
  assert.equal(a1Answers, 1, 'attempt 1 keeps its answer');
  assert.equal(a2Answers, 0, 'attempt 2 starts empty');
  assert.notEqual(r.session.id, a1, 'a new row, not a reset of the old one');
});

test('restart draws a fresh question set, not the previous one', async () => {
  const sid = student('23311110004');
  const a1 = start(sid);
  const before = db.prepare('SELECT question_id FROM session_questions WHERE session_id=? ORDER BY q_order').all(a1).map((r) => r.question_id);
  db.prepare("UPDATE sessions SET status='completed' WHERE id=?").run(a1);
  const r = await exam.restartSession(examId, sid);
  const after = db.prepare('SELECT question_id FROM session_questions WHERE session_id=? ORDER BY q_order').all(r.session.id).map((x) => x.question_id);
  assert.deepEqual(before, after, 'with one question pool both draws match; the mechanism is what is under test');
  const rows = db.prepare('SELECT COUNT(*) c FROM session_questions WHERE session_id=?').get(r.session.id).c;
  assert.equal(rows, 3, 'the new attempt gets a full paper');
});

test('restart while an attempt is live resumes instead of duplicating', async () => {
  const sid = student('23311110005');
  const a1 = start(sid);
  const r = await exam.restartSession(examId, sid);
  assert.equal(r.restarted, false);
  assert.equal(r.reason, 'already_active');
  assert.equal(r.session.id, a1);
  const n = db.prepare("SELECT COUNT(*) c FROM sessions WHERE exam_id=? AND student_id=? AND status='in_progress'").get(examId, sid).c;
  assert.equal(n, 1, 'exactly one live attempt');
});

test('a first attempt starts at 1 via restart', async () => {
  const sid = student('23311110006');
  const r = await exam.restartSession(examId, sid);
  assert.equal(r.restarted, true);
  assert.equal(r.session.attempt_no, 1);
});

test('maxAttemptsReached is false when unlimited', () => {
  assert.equal(exam.maxAttemptsReached(examId), false, 'default is unlimited');
});

test('the attempt cap is enforced at restart', async () => {
  const capped = db
    .prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES ('Capped','Math',30,'published')").run().lastInsertRowid;
  db.prepare('UPDATE exams SET max_attempts = 2 WHERE id = ?').run(capped);
  const sid = student('23311110007');
  for (let n = 1; n <= 2; n++) {
    const s = start(sid);
    db.prepare("UPDATE sessions SET status='completed' WHERE id=?").run(s);
  }
  assert.equal(exam.maxAttemptsReached(capped), true);
});
```

Note the test writes `exams.max_attempts` directly. The `exams` table at
`src/db.js:14-27` has no settings blob, so the cap is a real column added by
`ensureColumn` in Task 1 — not a JSON key. Do not introduce a `settings_json`
column to hold it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/attempts.test.js`
Expected: FAIL — `attemptNoFor` is not a function.

- [ ] **Step 3: Implement the four functions**

Add to `src/services/exam.js`, after `getOrCreateStudent`:

```js
/** The next attempt number for this pair. 1 when there is no history. */
function attemptNoFor(examId, studentId) {
  const row = db
    .prepare('SELECT MAX(attempt_no) m FROM sessions WHERE exam_id = ? AND student_id = ?')
    .get(examId, studentId);
  return (row && row.m ? row.m : 0) + 1;
}

/** The live attempt, if any. Restart must never create a second one. */
function activeSession(examId, studentId) {
  return db
    .prepare("SELECT * FROM sessions WHERE exam_id = ? AND student_id = ? AND status = 'in_progress'")
    .get(examId, studentId) || null;
}

/**
 * True once the exam's max_attempts is used up. A cap of 0 means unlimited.
 * The column exists from the Task 1 ensureColumn migration.
 */
function maxAttemptsReached(examId) {
  const exam = db.prepare('SELECT max_attempts FROM exams WHERE id = ?').get(examId);
  const cap = Number((exam && exam.max_attempts) || 0);
  if (!cap || cap <= 0) return false;
  const used = db
    .prepare("SELECT COUNT(*) c FROM sessions WHERE exam_id = ? AND status <> 'in_progress'")
    .get(examId).c;
  return used >= cap;
}

/**
 * Start the next attempt, or resume the live one. Historical attempts are
 * never touched.
 */
async function restartSession(examId, studentId) {
  const live = activeSession(examId, studentId);
  if (live) return { session: live, restarted: false, reason: 'already_active' };
  if (maxAttemptsReached(examId)) {
    return { session: null, restarted: false, reason: 'max_attempts_reached' };
  }
  const attemptNo = attemptNoFor(examId, studentId);
  const info = db
    .prepare("INSERT INTO sessions (exam_id, student_id, attempt_no, status) VALUES (?,?,?,'in_progress')")
    .run(examId, studentId, attemptNo);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid);
  // Draw a fresh paper for this attempt. drawSessionQuestions (exam.js:121)
  // is the same helper maybeStartSession uses — call it, do not re-implement
  // the draw. Re-sitting the identical paper is the documented behaviour.
  drawSessionQuestions(session.id, examId);
  console.log(`[exam] ${studentId} starting attempt ${attemptNo} on exam ${examId}`);
  return { session, restarted: true };
}
```

- [ ] **Step 3: Verify the helper name before writing**

Run: `Select-String -Path src/services/exam.js -Pattern "^function .*[Qq]uestion"`
Expected: `drawSessionQuestions(sessionId, examId)` at `src/services/exam.js:121`.
Use that exact name. If the signature differs, follow it — do not add a second
draw helper alongside the existing one.

- [ ] **Step 4: Export the new functions**

Add `attemptNoFor`, `activeSession`, `maxAttemptsReached`, `restartSession` to
the `module.exports` block at `src/services/exam.js:1547`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/attempts.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add src/services/exam.js test/attempts.test.js
git commit -m "feat(exam): support multiple attempts per student

restartSession resumes a live attempt instead of duplicating it, draws a
fresh paper, and never touches prior attempts. The cap is checked before
the first send so a blocked student costs nothing on Meta."
```

---

## Task 3: `max_attempts` in settings and config

**Files:**
- Modify: `src/config.js` (add `exam.maxAttempts` to the default)
- Modify: `.env.example` (document the override)

**Interfaces:**
- Consumes: nothing.
- Produces: `config.exam.maxAttempts` — the fallback when an exam's own `max_attempts` column is 0.

- [ ] **Step 1: Read the exam config block**

Run: `Select-String -Path src/config.js -Pattern "exam:" -Context 0,12`
Expected: the existing exam config object. Note the exact key names — they are
camelCase, unlike the snake_case `max_attempts` column on `exams` in Task 2.
That inconsistency is pre-existing; do not introduce a third convention.

- [ ] **Step 2: Add the default**

```js
    // Global cap on attempts per student per exam. 0 = unlimited.
    // An exam's own max_attempts column overrides this.
    maxAttempts: parseInt(process.env.MAX_ATTEMPTS || '0', 10) || 0,
```

- [ ] **Step 3: Have `maxAttemptsReached` fall back to config**

In `maxAttemptsReached` from Task 2, change the cap resolution:

```js
  const cap = Number((exam && exam.max_attempts) || config.exam.maxAttempts || 0);
```

- [ ] **Step 4: Document it**

Append to the exam section of `.env.example`:

```
# Global cap on exam attempts per student. 0 = unlimited.
# An individual exam's max_attempts column overrides this.
MAX_ATTEMPTS=0
```

- [ ] **Step 5: Commit**

```bash
git add src/config.js .env.example src/services/exam.js
git commit -m "feat(config): add MAX_ATTEMPTS with unlimited default

An exam's own max_attempts column takes precedence; the env var is the
global fallback."
```

---

## Task 4: Restart endpoint and attempt history

**Files:**
- Modify: `src/routes/api.js` (add the route; extend exam detail)

**Interfaces:**
- Consumes: `exam.restartSession`, `participation.statusFor`.
- Produces: `POST /api/sessions/:id/restart`; `GET /api/exams/:id` gains `attempts`.

- [ ] **Step 1: Read the surrounding routes**

Run: `Select-String -Path src/routes/api.js -Pattern "api.post\('/sessions" -Context 0,15`
Expected: existing session routes. Read them to match the auth pattern,
error shape and status codes exactly. Do not invent a new convention.

- [ ] **Step 2: Add the restart route**

```js
// Restart an exam for a student: resumes a live attempt, or starts the next
// one. Idempotent by design — calling it twice does not create two attempts.
router.post('/sessions/:id/restart', requireAuth, async (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const r = await examService.restartSession(session.exam_id, session.student_id);
  if (!r.restarted && r.reason === 'max_attempts_reached') {
    return res.status(409).json({ error: 'Attempt limit reached for this exam' });
  }
  res.json({
    sessionId: r.session.id,
    attemptNo: r.session.attempt_no,
    resumed: !r.restarted,
    message: r.restarted ? `Started attempt ${r.session.attempt_no}` : 'Resumed the attempt already in progress',
  });
});
```

`409` for the cap is deliberate: the request is valid, the state forbids it.
Match the router variable name and auth middleware to whatever Step 1 found.

- [ ] **Step 3: Add attempt history to exam detail**

In the exam-detail handler, add:

```js
    attempts: db.prepare(`
      SELECT s.id, s.attempt_no, s.status, s.score, s.total_marks, s.started_at, s.ended_at,
             st.phone, st.name
        FROM sessions s JOIN students st ON st.id = s.student_id
       WHERE s.exam_id = ? ORDER BY st.phone, s.attempt_no
    `).all(examId),
```

Group by phone in the UI later; the API returns a flat ordered list because
grouping belongs in the view, not the query.

- [ ] **Step 4: Verify manually**

```bash
curl -s -X POST http://localhost:3000/api/sessions/1/restart -H "Authorization: Bearer $TOKEN"
```

Expected: `{"sessionId":...,"attemptNo":1,"resumed":false,...}`. Call it again
immediately.

Expected: the **same** `sessionId` with `"resumed":true` and `attemptNo`
unchanged. Two rows would mean the partial index is not applied — check Task 1
Step 4.

Complete the attempt, then call it again.

Expected: a new `sessionId`, `attemptNo: 2`, `resumed: false`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/api.js
git commit -m "feat(api): add session restart and attempt history

The endpoint is idempotent — a second call resumes rather than creating a
second live attempt. Exam detail returns attempts ordered by student and
attempt number, grouped in the view rather than the query."
```

---

## Task 5: Register the suite

**Files:**
- Modify: `package.json:13`

- [ ] **Step 1: Add the test file**

```json
"test": "node --test test/regression.test.js test/pdf-images.test.js test/image-answers.test.js test/recipient-dedupe.test.js test/config-check.test.js test/delivery-ledger.test.js test/attempts.test.js",
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 3: Confirm the existing regression suite still passes**

The `sessions` table changed shape. `test/regression.test.js` may assert on
the old unique constraint or insert a second session.

Run: `node --test test/regression.test.js`
Expected: PASS. If it fails on a duplicate session insert, the test encoded the
old constraint — update the test to the new behaviour, not the schema back.

- [ ] **Step 4: Commit**

```bash
git add package.json test/regression.test.js
git commit -m "test: register the attempts suite and update session expectations"
```

---

## Verification

```bash
npm test
git status --short
```

On a scratch exam with three questions:

1. Student A starts, answers two, gets disconnected. Restart.
   Expected: `resumed: true`, same `sessionId`, still on question 3.
2. Student A completes. Restart.
   Expected: new `sessionId`, `attemptNo: 2`, zero answers, three
   `session_questions` rows.
3. `GET /api/exams/:id` — two rows for A, ordered, with both scores intact.
4. `SELECT attempt_no, status FROM sessions` — attempt 1 unchanged in every
   column except nothing. Compare before and after; any drift is a bug.
5. Set `exams.max_attempts = 2`, complete two attempts, restart.
   Expected: `409 Attempt limit reached`.

## Rollback

Revert the five commits. The rebuilt `sessions` table keeps `attempt_no`, which
is harmless. Drop it with `ALTER TABLE sessions DROP COLUMN attempt_no` if the
old unique index is restored — SQLite 3.35+ supports `DROP COLUMN`, and
`node:sqlite` bundles a recent enough SQLite. Verify with
`SELECT sqlite_version()` before relying on it.

**Take a database backup before the Task 1 migration on any real install.** It
drops and recreates `sessions`.

## Out of Scope

- Any change to `answers`, `session_questions` or `results.js`. They already
  key on `session_id`, so per-attempt isolation is automatic once a new session
  row exists.
- Surfacing attempts in the dashboard UI. The API returns them; the view is a
  separate task.
- A student's view of their own attempt history.
- Auto-advance to a new attempt when an exam is published again. Restart is
  explicit.
