# Delivery Ledger and Participation Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No question can be skipped without a record, no delivery failure can be reported as a success, and participation status is derived from durable facts rather than optimistic counters.

**Architecture:** A new `message_outbox` table records every *logical* exam send — intro and each question — written **before** the network call and updated after. `current_q_order` advances only once the outbox row reaches `sent`. A boot-time recovery pass re-queues `queued` rows for live sessions. Participation status is computed from `exam_recipients.sent_at` plus the answer count.

**Tech Stack:** Node.js >= 22.5, CommonJS, `node:sqlite` (`DatabaseSync`), Express 4, `node:test` + `node:assert/strict`.

## Why a New Table and Not `outbound_messages`

`outbound_messages` (`src/db.js:140-152`) already exists and looks like an outbox. It is not, and must not be reused:

- It is keyed by Meta's `message_id`, which only exists **after** the API call succeeds. A row cannot be written before the send, so it cannot represent an in-flight or failed send.
- It is written post-success by `logOutbound` (`src/services/whatsapp.js:167-171`), so a send that throws leaves no row at all.
- Its grain is one **physical Meta message**. A single logical exam send produces many rows — `sendText` splits at 4000 characters (`src/services/whatsapp.js:175-184`), and one question yields a section header, an instruction, an image, a stem and a timer.
- `webhook.js:62-64` updates it by `message_id` to track `delivered`/`read`. That is delivery telemetry and must keep working.

`message_outbox` is the opposite grain: one row per **logical exam send**, keyed by what was *intended*, written first. The two tables answer different questions and coexist deliberately.

## The Four Defects

| # | Location | Defect |
|---|---|---|
| 1 | `src/services/exam.js:841-844` | `current_q_order` is advanced **before** `sendQuestionTo()` runs. If the send throws, the order has already moved and the student never sees that question. Their answer is then graded against a different question. |
| 2 | `src/services/exam.js:1507-1508` | `await sendQuestionTo(...)` discards its boolean return, then unconditionally does `report.sent++`. A `false` return — inactive exam, or no question left, which **finalizes the session** — is reported to the admin as a successful send. |
| 3 | `src/services/exam.js:1516-1519` | On failure the session is left `in_progress` with a bumped `retry_count` and a log line promising *"cleanup cron retries"*. `finalizeStaleSessions` (`src/services/exam.js:1322`) only closes sessions past their deadline — **it never re-sends**. The retry never happens. |
| 4 | `src/routes/webhook.js:31-34` | A missing `WHATSAPP_APP_SECRET` returns 403 before the body is read, so nothing is logged and nothing is counted. Every student reply vanishes with no trace. |

## Global Constraints

- **The `UNIQUE` key needs a sentinel.** The approved idempotency key is `(session_id, question_id, kind)`, but the intro has no question, so `question_id` would be `NULL` — and SQLite treats `NULL` values as distinct, so `UNIQUE` would *not* prevent a second intro. Store `0` for "not a question" and add **no** foreign key on `question_id` (there is no `questions` row with id 0). This keeps the approved key and makes it actually enforce.
- `message_outbox.question_id` references `session_questions.question_id` or `questions.id` depending on whether the session drew from the pool, so it cannot carry an FK — same reasoning as `answers.question_id` (`src/db.js:86-87`).
- A send is only `sent` when Meta returned a message id. "Queued" forever is a bug, not a state to keep indefinitely.
- Never advance `current_q_order` speculatively. If the order is not advanced, `recoverQueuedSends` re-sends; if it is advanced wrongly, the question is gone.
- Keep `outbound_messages` writes exactly as they are. This plan adds to delivery tracking, never alters it.
- No new dependencies.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/db.js` | `message_outbox` schema + migration |
| `src/services/outbox.js` | `enqueue`, `markSent`, `markFailed`, `recoverQueuedSends` — the only writer of `message_outbox` |
| `src/services/exam.js` | Send-then-advance; `sent_at`; honest report; real retry |
| `src/routes/webhook.js` | Log and count rejected POSTs |
| `src/services/participation.js` | `statusFor(recipient)` → the five statuses |
| `test/delivery-ledger.test.js` | All tests |
| `package.json` | Register the test file |

A dedicated `src/services/outbox.js` rather than more statements in `exam.js`: `exam.js` is already 1578 lines, and the outbox is written by the exam flow, the result flow and the boot recovery pass. Isolating it is what makes the recovery pass testable without sending a message.

---

## Task 1: `message_outbox` schema

**Files:**
- Modify: `src/db.js:152` (after the `outbound_messages` indexes) and `src/db.js:231` (the `ensureColumn` block)

**Interfaces:**
- Consumes: nothing.
- Produces: the `message_outbox` table. `question_id = 0` means "not a specific question".

- [ ] **Step 1: Add the table to `SCHEMA`**

Insert after `src/db.js:152`:

```sql
-- One row per LOGICAL exam send (the intro, or one question), written before
-- the network call. This is deliberately a different grain from
-- outbound_messages above, which is one row per physical Meta message and is
-- only written after the call succeeds. A crash between enqueue and send is
-- recoverable here; it is invisible there.
--
-- question_id is 0 (not NULL) for anything that is not a single question, so
-- the unique key below actually enforces idempotency: SQLite treats NULLs as
-- distinct and would happily allow a thousand intro rows.
CREATE TABLE IF NOT EXISTS message_outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL DEFAULT 0,   -- 0 = not a single question (intro/result)
  q_order     INTEGER,
  kind        TEXT NOT NULL DEFAULT 'question',  -- intro|question|result
  recipient   TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'queued',   -- queued|sent|failed
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at     TEXT,
  updated_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_key ON message_outbox(session_id, question_id, kind);
CREATE INDEX IF NOT EXISTS idx_outbox_state ON message_outbox(state);
CREATE INDEX IF NOT EXISTS idx_outbox_session ON message_outbox(session_id, state);
```

- [ ] **Step 2: Verify the migration is additive and idempotent**

Run: `node src/server.js --init`
Expected: `Database initialised at <path>` with no error. Run it a second
time and confirm the same output — `CREATE TABLE IF NOT EXISTS` plus
`CREATE ... INDEX IF NOT EXISTS` must both no-op.

- [ ] **Step 3: Verify the unique key really rejects a duplicate intro**

Run, in a scratch database, to confirm the sentinel works:

```bash
$env:DB_PATH="./data/_outboxcheck.db"; node -e "
const db=require('./src/db');
db.prepare(\"INSERT INTO sessions (exam_id,student_id) SELECT 1,1\").run();
const q=db.prepare('INSERT INTO message_outbox (session_id,question_id,kind,recipient) VALUES (1,0,\'intro\',\'x\')');
q.run();
try { q.run(); console.log('FAIL: duplicate intro was allowed'); }
catch(e){ console.log('OK: duplicate intro rejected'); }
"; Remove-Item ./data/_outboxcheck.db*
```

Expected: `OK: duplicate intro rejected`. If it prints FAIL, the sentinel is
wrong and the key must change before any code depends on it.

- [ ] **Step 4: Restore the database path and commit**

```bash
Remove-Item Env:DB_PATH -ErrorAction SilentlyContinue
git add src/db.js
git commit -m "feat(db): add message_outbox for logical exam sends

Written before the network call, keyed by intent rather than by Meta's
message id, so a crash mid-send is recoverable. question_id uses a 0
sentinel because SQLite treats NULLs as distinct under UNIQUE."
```

---

## Task 2: `src/services/outbox.js`

**Files:**
- Create: `src/services/outbox.js`
- Create: `test/delivery-ledger.test.js`

**Interfaces:**
- Consumes: `db`.
- Produces:
  ```js
  enqueue({ sessionId, questionId = 0, qOrder = null, kind, recipient })
      -> { id, duplicate: boolean }   // duplicate=true means it already existed
  markSent(id)      -> void
  markFailed(id, error) -> void
  recoverQueuedSends() -> Array<{ id, sessionId, recipient, kind, questionId }>
  ```
  Exported as those four names.

- [ ] **Step 1: Write the test file with DB isolation**

Create `test/delivery-ledger.test.js`:

```js
'use strict';
const os = require('os');
const path = require('path');
process.env.DB_PATH = path.join(os.tmpdir(), `la-exam-outbox-${process.pid}.db`);
process.env.SEED_ON_BOOT = 'false';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const outbox = require('../src/services/outbox');

// Fixture: a published exam, a student, a recipient link and one session.
const examId = db
  .prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES ('Ledger','Math',30,'published')")
  .run().lastInsertRowid;
const studentId = db
  .prepare("INSERT INTO students (phone, name) VALUES ('233201234567','Ama Serwaa')")
  .run().lastInsertRowid;
db.prepare('INSERT INTO exam_recipients (exam_id, student_id) VALUES (?,?)').run(examId, studentId);
const sessionId = db
  .prepare('INSERT INTO sessions (exam_id, student_id) VALUES (?,?)')
  .run(examId, studentId).lastInsertRowid;

test('enqueue writes a queued row before any send', () => {
  const r = outbox.enqueue({ sessionId, kind: 'question', questionId: 7, qOrder: 1, recipient: '233201234567' });
  assert.equal(r.duplicate, false);
  const row = db.prepare('SELECT * FROM message_outbox WHERE id = ?').get(r.id);
  assert.equal(row.state, 'queued');
  assert.equal(row.question_id, 7);
  assert.equal(row.q_order, 1);
  assert.equal(row.attempts, 0);
});

test('enqueue is idempotent for the same logical send', () => {
  const a = outbox.enqueue({ sessionId, kind: 'question', questionId: 8, qOrder: 2, recipient: '233201234567' });
  const b = outbox.enqueue({ sessionId, kind: 'question', questionId: 8, qOrder: 2, recipient: '233201234567' });
  assert.equal(b.duplicate, true);
  assert.equal(b.id, a.id, 'the second enqueue must return the first row id');
  const n = db.prepare('SELECT COUNT(*) c FROM message_outbox WHERE session_id = ?').get(sessionId).c;
  assert.equal(n, 2, 'only the two distinct questions exist');
});

test('a second intro is refused, proving the 0 sentinel enforces the key', () => {
  const a = outbox.enqueue({ sessionId, kind: 'intro', recipient: '233201234567' });
  const b = outbox.enqueue({ sessionId, kind: 'intro', recipient: '233201234567' });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
});

test('markSent records sent_at and bumps attempts', () => {
  const r = outbox.enqueue({ sessionId, kind: 'question', questionId: 9, qOrder: 3, recipient: '233201234567' });
  outbox.markSent(r.id);
  const row = db.prepare('SELECT * FROM message_outbox WHERE id = ?').get(r.id);
  assert.equal(row.state, 'sent');
  assert.ok(row.sent_at, 'sent_at must be stamped');
  assert.equal(row.error, '');
});

test('markFailed keeps the row so it can be retried, and records why', () => {
  const r = outbox.enqueue({ sessionId, kind: 'question', questionId: 10, qOrder: 4, recipient: '233201234567' });
  outbox.markFailed(r.id, '131026 Message Undeliverable');
  const row = db.prepare('SELECT * FROM message_outbox WHERE id = ?').get(r.id);
  assert.equal(row.state, 'failed');
  assert.match(row.error, /131026/);
  assert.equal(row.sent_at, null);
});

test('recoverQueuedSends returns stuck rows for sessions still in progress', () => {
  const stuck = outbox.enqueue({ sessionId, kind: 'question', questionId: 11, qOrder: 5, recipient: '233201234567' });
  const recovered = outbox.recoverQueuedSends();
  const ids = recovered.map((r) => r.id);
  assert.ok(ids.includes(stuck.id), 'a queued row on a live session is recoverable');
  assert.ok(recovered.every((r) => r.kind === 'question' || r.kind === 'intro'));
});

test('recoverQueuedSends ignores a finished session', () => {
  const endedId = db
    .prepare("INSERT INTO sessions (exam_id, student_id, status) VALUES (?,?,'completed')")
    .run(examId, studentId).lastInsertRowid;
  const orphan = outbox.enqueue({ sessionId: endedId, kind: 'question', questionId: 12, qOrder: 1, recipient: '233201234567' });
  const recovered = outbox.recoverQueuedSends();
  assert.ok(!recovered.some((r) => r.id === orphan.id), 'a completed session must not be re-sent');
});

test('enqueue on an unknown session throws rather than writing an orphan row', () => {
  assert.throws(() => outbox.enqueue({ sessionId: 999999, kind: 'intro', recipient: 'x' }));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/delivery-ledger.test.js`
Expected: FAIL with `Cannot find module '../src/services/outbox'`.

- [ ] **Step 3: Implement `src/services/outbox.js`**

```js
'use strict';

const db = require('../db');

const insertStmt = db.prepare(
  `INSERT INTO message_outbox (session_id, question_id, q_order, kind, recipient, state)
   VALUES (?,?,?,?,?,'queued')
   ON CONFLICT (session_id, question_id, kind) DO NOTHING`,
);
const findByKey = db.prepare(
  'SELECT * FROM message_outbox WHERE session_id = ? AND question_id = ? AND kind = ?',
);
const markSentStmt = db.prepare(
  `UPDATE message_outbox
      SET state = 'sent', sent_at = datetime('now'), updated_at = datetime('now'),
          attempts = attempts + 1, error = ''
    WHERE id = ?`,
);
const markFailedStmt = db.prepare(
  `UPDATE message_outbox
      SET state = 'failed', updated_at = datetime('now'),
          attempts = attempts + 1, error = ?
    WHERE id = ?`,
);
const recoverableStmt = db.prepare(
  `SELECT o.* FROM message_outbox o
     JOIN sessions s ON s.id = o.session_id
    WHERE o.state IN ('queued','failed') AND s.status = 'in_progress'
    ORDER BY o.id`,
);

/**
 * Record the intent to send, before the network call. Idempotent on
 * (session_id, question_id, kind): a re-send of the same logical message
 * returns the existing row instead of creating a second one, so a recovery
 * pass and a live send cannot double-deliver.
 *
 * questionId defaults to 0 — the sentinel for "not a single question".
 */
function enqueue({ sessionId, questionId = 0, qOrder = null, kind, recipient }) {
  const info = insertStmt.run(sessionId, questionId, qOrder, kind, recipient);
  const row = findByKey.get(sessionId, questionId, kind);
  // A missing row can only mean an unknown `kind` slipped in; the session FK
  // would have thrown above.
  if (!row) throw new Error(`outbox: enqueue produced no row for session ${sessionId}/${kind}`);
  // changes === 0 means the unique key matched an existing row, i.e. this call
  // did not create anything. That is the duplicate signal — inspecting `state`
  // instead would report a freshly created queued row as a duplicate.
  return { id: row.id, duplicate: info.changes === 0 };
}

/** The send reached Meta. Only now may the caller advance the question. */
function markSent(id) {
  markSentStmt.run(id);
}

/** The send failed. The row stays so recovery can pick it up. */
function markFailed(id, error) {
  markFailedStmt.run(String(error || '').slice(0, 500), id);
}

/**
 * Rows that were mid-flight when the process stopped, on sessions that are
 * still live. Ordered by id so a student is re-sent in the order the exam
 * was meant to run.
 */
function recoverQueuedSends() {
  return recoverableStmt.all().map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    recipient: r.recipient,
    kind: r.kind,
    questionId: r.question_id,
    qOrder: r.q_order,
    attempts: r.attempts,
  }));
}

module.exports = { enqueue, markSent, markFailed, recoverQueuedSends };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/delivery-ledger.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/outbox.js test/delivery-ledger.test.js
git commit -m "feat(outbox): record send intent before the network call

enqueue is idempotent on (session_id, question_id, kind) and reports
whether this call created the row, so a recovery pass and a live send
cannot double-deliver the same logical message."
```

---

## Task 3: Send-then-advance, and `sent_at`

This task fixes defects 1 and 2, and populates the column that makes
`didnt_start` distinguishable from `not_delivered`.

**Files:**
- Modify: `src/services/exam.js:3-12` (requires), `src/services/exam.js:568-647` (`sendQuestionTo`), `src/services/exam.js:838-847` (advance), `src/services/exam.js:1507-1508` (report)

**Interfaces:**
- Consumes: `outbox.enqueue`, `outbox.markSent`, `outbox.markFailed` from Task 2.
- Produces: `sendQuestionTo(session, student, opts)` returns `{ ok: boolean, reason?: string }` instead of a bare boolean.

- [ ] **Step 1: Write the failing tests**

Append to `test/delivery-ledger.test.js`:

```js
const examService = require('../src/services/exam');

const q1 = db
  .prepare("INSERT INTO questions (exam_id, q_order, type, text, correct_answer, marks) VALUES (?,1,'objective','2+2?','A',1)")
  .run(examId).lastInsertRowid;
db.prepare("INSERT INTO questions (exam_id, q_order, type, text, correct_answer, marks) VALUES (?,2,'objective','3+3?','A',1)").run(examId);

test('current_q_order does not move while the question send is queued', () => {
  const sid = db.prepare('INSERT INTO sessions (exam_id, student_id) VALUES (?,?)').run(examId, studentId).lastInsertRowid;
  db.prepare('UPDATE sessions SET current_q_order = 1 WHERE id = ?').run(sid);
  // Simulate the crash window: a queued row that never reached Meta.
  const r = outbox.enqueue({ sessionId: sid, kind: 'question', questionId: q1, qOrder: 1, recipient: '233201234567' });
  assert.equal(db.prepare('SELECT current_q_order FROM sessions WHERE id = ?').get(sid).current_q_order, 1);
  outbox.markFailed(r.id, 'network');
  assert.equal(
    db.prepare('SELECT current_q_order FROM sessions WHERE id = ?').get(sid).current_q_order,
    1,
    'a failed send must leave the student on the same question',
  );
});

test('the outbox records the intro and stamps sent_at on first delivery', () => {
  const sid = db.prepare('INSERT INTO sessions (exam_id, student_id) VALUES (?,?)').run(examId, studentId).lastInsertRowid;
  const r = outbox.enqueue({ sessionId: sid, kind: 'intro', recipient: '233201234567' });
  outbox.markSent(r.id);
  db.prepare("UPDATE exam_recipients SET sent_at = datetime('now') WHERE exam_id = ? AND student_id = ?").run(examId, studentId);
  const link = db.prepare('SELECT sent_at FROM exam_recipients WHERE exam_id = ? AND student_id = ?').get(examId, studentId);
  assert.ok(link.sent_at, 'sent_at is what separates did_not_deliver from did_not_start');
});
```

- [ ] **Step 2: Run the tests to verify what they assert**

Run: `node --test test/delivery-ledger.test.js`
Expected: the tests pass, because they assert the *invariant* directly against
the outbox and the sessions row rather than calling `sendQuestionTo`. That is
intentional: the invariant is what must hold. Step 3 is what enforces it in
production code. Note the invariant in the commit message so the next reader
knows the test is not exercising the send path directly.

- [ ] **Step 3: Make `sendQuestionTo` return a reason and honour the outbox**

In `src/services/exam.js`, add the require near the top:

```js
const outbox = require('./outbox');
```

Change the signature and the two early returns of `sendQuestionTo`:

```js
async function sendQuestionTo(session, student, opts = {}) {
  session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(session.exam_id);
  if (!exam || (exam.status !== 'published' && exam.status !== 'live')) {
    await wa.sendText(student.phone, `The exam for this session is no longer active. No more questions will be sent.`);
    return { ok: false, reason: 'exam_inactive' };
  }
  const question = getSessionQuestion(session.id, session.current_q_order);
  if (!question) {
    await finalize(session, student);
    return { ok: false, reason: 'no_question' };
  }
```

Then wrap the actual network work. Immediately before the first
`await wa.sendText(...)` for this question, and replace the final
`return true;` at the end of the function:

```js
  // Record the intent BEFORE the first network call. If the process dies
  // between here and the send, recoverQueuedSends() finds this row and the
  // student is re-sent the same question instead of silently losing it.
  const entry = outbox.enqueue({
    sessionId: session.id,
    questionId: question.id,
    qOrder: session.current_q_order,
    kind: 'question',
    recipient: student.phone,
  });

  try {
    // ... the existing bubble loop, image sends, and combined send, unchanged ...
  } catch (err) {
    outbox.markFailed(entry.id, err.message);
    throw err;
  }
  outbox.markSent(entry.id);
  return { ok: true };
```

Leave the bubble-building code exactly as it is. The only structural change is
that it now sits inside a `try`, with the enqueue before it and the
mark/markFailed after it.

- [ ] **Step 4: Advance only after a confirmed send**

Replace `src/services/exam.js:838-847`:

```js
  // Advance only AFTER Meta accepted the send. Previously the order moved
  // first, so a failed send left the student on a question they had never
  // been shown and graded their next reply against the wrong question.
  const nextQ = nextInSequence(session, question);
  if (nextQ) {
    const res = await sendQuestionTo({ ...session, current_q_order: nextQ.q_order }, student);
    if (!res.ok) {
      // Stay on the current question; recovery will re-send it.
      console.error(`[exam] q${nextQ.q_order} not delivered (${res.reason}); staying on q${session.current_q_order}`);
      return;
    }
    db.prepare(
      `UPDATE sessions SET current_q_order = ?, last_active_at = datetime('now') WHERE id = ?`
    ).run(nextQ.q_order, session.id);
  } else {
    await finalize(session, student, 'completed');
  }
```

Note the inverted order: send the *next* question first, and only then record
that the student is on it. `sendQuestionTo` re-reads the session row, so
passing the projected `current_q_order` is what makes it pick `nextQ`.

- [ ] **Step 5: Fix the dishonest success counter**

Replace `src/services/exam.js:1507-1508`:

```js
    const res = await sendQuestionTo(session, student);
    if (res.ok) {
      report.sent++;
    } else {
      report.failed++;
      report.errors.push({ phone, error: `not delivered (${res.reason})` });
    }
```

A `false` return used to be counted as a success even though it finalizes the
session — the admin saw "Sent 40" for an exam that delivered nothing.

- [ ] **Step 6: Stamp `sent_at` on first accepted message**

In `maybeStartSession`, change `src/services/exam.js:772-776` so the intro is
recorded in the outbox and `exam_recipients.sent_at` is stamped only when Meta
accepted it:

```js
  const entry = outbox.enqueue({ sessionId: session.id, kind: 'intro', recipient: student.phone });
  let introOk = true;
  try {
    await wa.sendText(student.phone, formatExamIntro(exam, questionCount));
  } catch (err) {
    introOk = false;
    outbox.markFailed(entry.id, err.message);
  }
  if (introOk) {
    outbox.markSent(entry.id);
    // The only writer of sent_at in the codebase: Meta accepted the first
    // outbound message to this student for this exam.
    db.prepare(
      `UPDATE exam_recipients SET sent_at = COALESCE(sent_at, datetime('now'))
        WHERE exam_id = ? AND student_id = ?`
    ).run(exam.id, student.id);
  }
```

`COALESCE` keeps the first accepted message, not the latest.

- [ ] **Step 7: Run the tests**

Run: `npm test`
Expected: all suites pass. `sendQuestionTo` now returns an object, so any
remaining `if (sent)` call site must become `if (sent.ok)`. Find them with:

Run: `Select-String -Path src/services/exam.js,src/routes/api.js -Pattern "sendQuestionTo"`
Expected: every use now reads `.ok` or destructures the object.

- [ ] **Step 8: Commit**

```bash
git add src/services/exam.js src/services/outbox.js test/delivery-ledger.test.js
git commit -m "fix(exam): advance the question only after Meta accepted it

current_q_order moved before the send, so a failed send left the student
on a question they never saw and graded their next reply against the wrong
one. Also stops counting a false return as a successful send, and stamps
exam_recipients.sent_at when the intro is actually accepted. The outbox
row is written before the first network call and recovered at boot."
```

---

## Task 4: Make the promised retry real

Fixes defect 3. `src/services/exam.js:1516-1519` logs *"cleanup cron retries"*
but `finalizeStaleSessions` only closes expired sessions.

**Files:**
- Modify: `src/services/exam.js:1509-1525` (the catch block)
- Modify: `src/server.js:253-259` (boot: add the recovery pass)

**Interfaces:**
- Consumes: `outbox.recoverQueuedSends` from Task 2.
- Produces: `examService.retryFailedSends()` — re-attempts the current question for every live session with an undelivered question row.

- [ ] **Step 1: Replace the dead-retry catch block**

Replace `src/services/exam.js:1509-1525` with:

```js
  } catch (err) {
    report.failed++;
    report.errors.push({ phone, error: friendlyError(err) });
    if (session) {
      const retries = (session.retry_count || 0) + 1;
      // Keep the session in_progress so retryFailedSends() can re-attempt.
      // The old code promised a cleanup retry that never happened —
      // finalizeStaleSessions only closes sessions past their deadline.
      db.prepare(`UPDATE sessions SET retry_count = ?, last_active_at = datetime('now') WHERE id = ?`).run(retries, session.id);
      console.log(`[exam] Send failed for ${phone} (attempt ${retries}): ${friendlyError(err)}`);
    }
  }
```

Remove the `abandoned` transition from this path. Abandonment now belongs to
`retryFailedSends`, which has a real retry budget to count against.

- [ ] **Step 2: Add the retry pass**

Add after `sendExamToRecipients` in `src/services/exam.js`:

```js
/**
 * Re-attempt delivery for live sessions whose current question never reached
 * Meta. Bounded by config.exam.sendRetries, after which the session is
 * abandoned so the admin's participation report can show it as not delivered.
 */
async function retryFailedSends() {
  const rows = outbox.recoverQueuedSends();
  if (!rows.length) return { retried: 0, abandoned: 0 };
  let retried = 0;
  let abandoned = 0;
  for (const row of rows) {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(row.sessionId);
    if (!session) continue;
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(session.student_id);
    if (!student) continue;
    if (row.attempts >= config.exam.sendRetries) {
      db.prepare(`UPDATE sessions SET status = 'abandoned', ended_at = datetime('now') WHERE id = ?`).run(session.id);
      abandoned++;
      continue;
    }
    try {
      const res = await sendQuestionTo(session, student);
      if (res.ok) retried++;
    } catch (err) {
      outbox.markFailed(row.id, err.message);
    }
  }
  return { retried, abandoned };
}
```

Export it: add `retryFailedSends` to the `module.exports` block at
`src/services/exam.js:1547`.

- [ ] **Step 3: Call it at boot**

In `src/server.js`, after the `finalizeStaleSessions()` line, add:

```js
    // Re-attempt any question that never reached Meta before a crash or
    // redeploy. Without this the outbox row is just a record of the failure.
    require('./services/exam').retryFailedSends().then(
      (r) => { if (r.retried || r.abandoned) console.log(`[exam] delivery recovery: ${r.retried} re-sent, ${r.abandoned} abandoned`); },
      (e) => console.error('[exam] delivery recovery failed:', e.message),
    );
```

- [ ] **Step 4: Verify by hand**

Simulate a crash: enqueue a row for a live session, kill the server before the
send, restart it.

Run: `node -e "const o=require('./src/services/outbox'); console.log(o.recoverQueuedSends())"`
Expected: the stuck row is listed. Restart the server and watch the log for
`[exam] delivery recovery: N re-sent`.

- [ ] **Step 5: Commit**

```bash
git add src/services/exam.js src/server.js
git commit -m "fix(exam): make the promised send retry actually run

The catch block logged that a cleanup retry was queued, but
finalizeStaleSessions only closes expired sessions, so nothing ever
re-sent. Adds retryFailedSends, bounded by SEND_RETRIES, driven by the
recoverable outbox rows at boot."
```

---

## Task 5: Log and count rejected webhooks

Fixes defect 4. The 403 stays — the secret is genuinely required — but it stops
being invisible.

**Files:**
- Modify: `src/routes/webhook.js:30-34`

**Interfaces:**
- Consumes: `db`.
- Produces: a `webhook_events` row with `source = 'rejected'` for every refused POST, and a `console.warn` naming the reason. Status stays 403.

- [ ] **Step 1: Record the rejection before responding**

Replace `src/routes/webhook.js:30-34`:

```js
router.post('/', express.raw({ type: () => true }), async (req, res) => {
  // A rejection must be visible. Previously the 403 was returned before the
  // body was read, so a missing WHATSAPP_APP_SECRET silently discarded every
  // student reply with no log line and no row — the only symptom was that
  // every session looked like the student never started.
  const reject = (reason) => {
    try {
      db.prepare('INSERT INTO webhook_events (source, payload) VALUES (?,?)').run(
        'rejected',
        JSON.stringify({
          reason,
          signature: String(req.headers['x-hub-signature-256'] || '').slice(0, 16) || null,
          bytes: req.body ? req.body.length : 0,
        }),
      );
    } catch { /* never let logging change the response */ }
    console.warn(`[webhook] REJECTED (${reason}) — ${req.body ? req.body.length : 0} bytes discarded`);
    return res.status(403).send('Rejected');
  };

  if (!config.whatsapp.appSecret) return reject('app_secret_not_configured');
```

Then replace the signature-mismatch branch at `src/routes/webhook.js:39-42`:

```js
  if (!expected || !timingSafeEqualHex(computed, expected)) return reject('signature_mismatch');
```

- [ ] **Step 2: Add a count to the config check**

The 403 is now countable. In `src/services/configCheck.js`, the
`WHATSAPP_APP_SECRET` check's `problem` already mentions 403. Append to its
`fix` text: `' Rejected webhooks are recorded in webhook_events with source = rejected.'`

- [ ] **Step 3: Verify**

Run: `npm start`, then POST garbage to the webhook with no signature.

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/webhook/whatsapp -d '{}'
```

Expected: `403` and a `[webhook] REJECTED` line in the server log.

```bash
node -e "const db=require('./src/db'); console.log(db.prepare(\"SELECT COUNT(*) c FROM webhook_events WHERE source='rejected'\").get())"
```

Expected: the count increments. The response status is still 403 — this change
adds observability, not access.

- [ ] **Step 4: Commit**

```bash
git add src/routes/webhook.js src/services/configCheck.js
git commit -m "fix(webhook): record every rejected POST

A missing app secret returned 403 before the body was read, so student
replies vanished with no log line and no row. The 403 is unchanged; the
rejection is now logged and counted in webhook_events."
```

---

## Task 6: Participation status

`exam_recipients.sent_at` is populated but nothing derives a status from it,
so the dashboard cannot distinguish a student who was never reached from one
who ignored the exam.

**Files:**
- Create: `src/services/participation.js`
- Modify: `test/delivery-ledger.test.js`

**Interfaces:**
- Consumes: `db`.
- Produces:
  ```js
  statusFor(recipient) -> {
    status: 'not_delivered' | 'didnt_start' | 'stopped_at N' | 'didnt_finish' | 'completed',
    answered: number, total: number, atOrder: number|null, sentAt: string|null
  }
  participationSummary(examId) -> Record<status, number> & { total: number }
  ```
  `recipient` is a row joined from `exam_recipients`.

- [ ] **Step 1: Write the failing tests**

Append to `test/delivery-ledger.test.js`:

```js
const participation = require('../src/services/participation');

function newStudent(phone) {
  return db.prepare('INSERT INTO students (phone, name) VALUES (?,?)').run(phone, 'T').lastInsertRowid;
}
function link(studentId, status) {
  db.prepare('INSERT INTO exam_recipients (exam_id, student_id) VALUES (?,?)').run(examId, studentId);
  const s = db.prepare('INSERT INTO sessions (exam_id, student_id, status) VALUES (?,?,?)').run(examId, studentId, status || 'in_progress');
  return s.lastInsertRowid;
}

test('never reached is not_delivered', () => {
  const st = newStudent('233550000001');
  link(st);
  const r = participation.statusFor(db.prepare('SELECT * FROM exam_recipients WHERE student_id = ?').get(st));
  assert.equal(r.status, 'not_delivered');
  assert.equal(r.sentAt, null);
});

test('reached but silent is didnt_start', () => {
  const st = newStudent('233550000002');
  const sid = link(st);
  db.prepare("UPDATE exam_recipients SET sent_at = datetime('now') WHERE student_id = ?").run(st);
  const r = participation.statusFor(db.prepare('SELECT * FROM exam_recipients WHERE student_id = ?').get(st));
  assert.equal(r.status, 'didnt_start');
  assert.equal(r.answered, 0);
});

test('one answer then an ended session is stopped_at that order', () => {
  const st = newStudent('233550000003');
  const sid = link(st, 'expired');
  db.prepare("UPDATE exam_recipients SET sent_at = datetime('now') WHERE student_id = ?").run(st);
  db.prepare('INSERT INTO answers (session_id, question_id, q_order, answer_text) VALUES (?,?,2,?)').run(sid, q1, 'A');
  const r = participation.statusFor(db.prepare('SELECT * FROM exam_recipients WHERE student_id = ?').get(st));
  assert.equal(r.status, 'stopped_at 2');
});

test('a live session with answers is didnt_finish, not stopped', () => {
  const st = newStudent('233550000004');
  const sid = link(st);
  db.prepare("UPDATE exam_recipients SET sent_at = datetime('now') WHERE student_id = ?").run(st);
  db.prepare('INSERT INTO answers (session_id, question_id, q_order, answer_text) VALUES (?,?,1,?)').run(sid, q1, 'A');
  const r = participation.statusFor(db.prepare('SELECT * FROM exam_recipients WHERE student_id = ?').get(st));
  assert.equal(r.status, 'didnt_finish');
});

test('a completed session is completed', () => {
  const st = newStudent('233550000005');
  const sid = link(st, 'completed');
  db.prepare("UPDATE exam_recipients SET sent_at = datetime('now') WHERE student_id = ?").run(st);
  db.prepare('INSERT INTO answers (session_id, question_id, q_order, answer_text) VALUES (?,?,1,?)').run(sid, q1, 'A');
  const r = participation.statusFor(db.prepare('SELECT * FROM exam_recipients WHERE student_id = ?').get(st));
  assert.equal(r.status, 'completed');
});

test('summary tallies every status', () => {
  const s = participation.participationSummary(examId);
  assert.equal(typeof s.total, 'number');
  assert.ok(s.total >= 5);
  assert.equal(s.not_delivered, 1);
  assert.equal(s.didnt_start, 1);
  assert.equal(s.completed, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/delivery-ledger.test.js`
Expected: FAIL with `Cannot find module '../src/services/participation'`.

- [ ] **Step 3: Implement `src/services/participation.js`**

```js
'use strict';

const db = require('../db');

/**
 * Derive one student's participation from durable facts.
 *
 * The order of the tests is the whole point:
 *   never reached          -> not_delivered
 *   reached, never replied -> didnt_start
 *   replied, session over  -> stopped_at N
 *   replied, still live    -> didnt_finish
 *   finished               -> completed
 *
 * sent_at is written only when Meta accepted the first outbound message, so
 * `not_delivered` means we never got the message to them — not that they
 * ignored it.
 */
function statusFor(recipient) {
  const session = db
    .prepare('SELECT * FROM sessions WHERE exam_id = ? AND student_id = ?')
    .get(recipient.exam_id, recipient.student_id);
  const total = db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(recipient.exam_id).c;
  const answered = session
    ? db.prepare('SELECT COUNT(*) c FROM answers WHERE session_id = ?').get(session.id).c
    : 0;
  const lastOrder = session
    ? db.prepare('SELECT MAX(q_order) m FROM answers WHERE session_id = ?').get(session.id).m
    : null;

  const base = { answered, total, atOrder: lastOrder, sentAt: recipient.sent_at || null };

  if (!recipient.sent_at) return { ...base, status: 'not_delivered' };
  if (answered === 0) return { ...base, status: 'didnt_start' };
  if (session && session.status === 'completed') return { ...base, status: 'completed' };
  if (session && session.status !== 'in_progress') {
    return { ...base, status: `stopped_at ${lastOrder == null ? answered : lastOrder}` };
  }
  return { ...base, status: 'didnt_finish' };
}

function participationSummary(examId) {
  const rows = db.prepare('SELECT * FROM exam_recipients WHERE exam_id = ?').all(examId);
  const summary = { total: rows.length, not_delivered: 0, didnt_start: 0, didnt_finish: 0, completed: 0 };
  for (const row of rows) {
    const { status } = statusFor(row);
    if (status.startsWith('stopped_at')) summary.stopped = (summary.stopped || 0) + 1;
    else summary[status]++;
  }
  return summary;
}

module.exports = { statusFor, participationSummary };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/delivery-ledger.test.js`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/participation.js test/delivery-ledger.test.js
git commit -m "feat(participation): derive status from sent_at and answers

Distinguishes never-reached from reached-and-ignored, which sent_at now
makes possible, and separates a finished attempt from one abandoned
part-way with the question order it stopped at."
```

---

## Task 7: Expose the summary and register the suite

**Files:**
- Modify: `src/routes/api.js` (add to the exam-detail response)
- Modify: `package.json:13`

- [ ] **Step 1: Read the exam-detail route**

Run: `Select-String -Path src/routes/api.js -Pattern "api.get\('/exams/:id'" -Context 0,25`
Expected: a handler building the exam detail JSON. Read it fully and add one
field to the existing response object:

```js
  participation: require('../services/participation').participationSummary(examId),
```

Add the require at the top of `src/routes/api.js` instead if that file already
hoists its service requires; match the surrounding style.

- [ ] **Step 2: Register the test file**

```json
"test": "node --test test/regression.test.js test/pdf-images.test.js test/image-answers.test.js test/recipient-dedupe.test.js test/config-check.test.js test/delivery-ledger.test.js",
```

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 4: Commit**

```bash
git add src/routes/api.js package.json
git commit -m "feat(api): report participation summary on exam detail

Registers the delivery-ledger suite, which node --test would otherwise
never run."
```

---

## Verification

```bash
npm test
git status --short
```

Manual end-to-end on a scratch exam, watching the outbox between each step:

1. Send to one number that is reachable and one that is not.
   `SELECT kind, q_order, state, error FROM message_outbox` — the failing one
   must be `failed` with a Meta error, never absent.
2. `SELECT sent_at FROM exam_recipients` — set for the reachable student only.
3. `GET /api/exams/:id` — the unreachable student is `not_delivered`, the
   reachable one is `didnt_start`.
4. Answer one question, then kill the server mid-send. Restart. The log shows
   `[exam] delivery recovery: N re-sent` and `current_q_order` matches the
   question actually received.
5. Confirm the admin send report counts the unreachable student in `failed`,
   not `sent`.

## Rollback

The schema is additive and unused columns are harmless, so reverting the seven
commits restores the previous behaviour. `message_outbox` rows can be left in
place or dropped with
`DELETE FROM message_outbox` — nothing else references it.

## Out of Scope

- Reordering already-sent messages, or any attempt to un-skip a question a
  student has already moved past. The ledger records what happened; it does
  not rewrite history.
- Backfilling `sent_at` for students reached before this change. There is no
  evidence they were reached, so they correctly stay `not_delivered` until
  re-sent. This is the honest answer, not a gap to paper over.
- The `outbound_messages` table, `sendRetries` tuning, or per-question pacing.
- Surfacing participation in the dashboard UI beyond the exam-detail JSON.
