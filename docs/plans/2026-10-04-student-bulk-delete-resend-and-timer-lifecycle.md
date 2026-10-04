# Student Bulk Delete, Exam Resend, and Start-on-Engagement Timer — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let an admin bulk-delete students, resend the exam to students who never received or started it, and stop the exam clock from running until a student actually begins.

**Architecture:** The resend and timer features share one root cause. `src/services/exam.js:1768` writes `started_at=NULL`, but `sessions.started_at` is `NOT NULL`, so SQLite throws; the `catch` at `:1774` swallows it and drives the session to `abandoned`. Every fresh send is therefore recorded as failed. Fixing the schema unlocks timer logic that already exists and is currently dead code (`deadline()` at `:391`, `finalizeStaleSessions()` at `:1586`, `maybeStartSession()` at `:1021`). Send-time delivery then becomes invite-only, so a student's first reply is what starts the clock.

**Tech Stack:** Node 22+ (`node:sqlite` `DatabaseSync`), Express 4, vanilla JS SPA, `node:test` + `node:assert/strict`.

**Design doc:** `docs/plans/2026-10-04-student-bulk-delete-resend-and-timer-lifecycle-design.md`

---

## Critical pre-flight

**Task 1 rebuilds a live table.** Before running it against `data/exams.db`, copy the file (including `-wal` and `-shm`) and run the migration against the copy. The user's real database holds 3 exams and 6 students.

```
Copy-Item data\exams.db "$env:TEMP\exams-backup.db"
```

The migration is guarded on the stored DDL containing `NOT NULL`, so it runs exactly once and is a no-op on an already-migrated database.

## Test invocation

All test commands run from the repo root. `npm test` runs `node --test test/*.test.js`.

To run one file:

```
node --test test/timer-start.test.js
```

Expected PASS output ends with `# pass N` and `# fail 0`.

Every test file must set its own env vars **before** requiring `../src/db`, because `src/db.js` opens the database at require time.

---

## Task 1: Make `sessions.started_at` nullable

**Files:**
- Modify: `src/db.js:75` (CREATE TABLE DDL)
- Modify: `src/db.js:274` (rebuild DDL in the existing migration)
- Modify: after `src/db.js:298` (add the new migration)
- Modify: `src/db.js:241` — no, that is `exam.js`. See Task 2.
- Test: `test/timer-start.test.js` (create)

**Step 1: Write the failing test**

Create `test/timer-start.test.js`:

```js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-timer-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.DOTENV_CONFIG_PATH = path.join(tmp, '.env');
process.env.SEED_ON_BOOT = 'false';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const exam = require('../src/services/exam');
const wa = require('../src/services/whatsapp');
const config = require('../src/config');
config.exam.sendCertificates = false;
after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function fixture() {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Timer',30,'live')").run().lastInsertRowid;
  const sid = db.prepare('INSERT INTO students(phone) VALUES (?)').run('233timer' + eid).lastInsertRowid;
  db.prepare('INSERT INTO exam_recipients(exam_id,student_id) VALUES (?,?)').run(eid, sid);
  db.prepare("INSERT INTO questions(exam_id,q_order,type,text,options,correct_answer) VALUES (?,1,'objective','Q1',?,'A')")
    .run(eid, JSON.stringify([{ key: 'A', text: 'Yes' }, { key: 'B', text: 'No' }]));
  return { eid, sid, student: db.prepare('SELECT * FROM students WHERE id=?').get(sid) };
}

test('a new session has no start time, so the clock is not running yet', () => {
  const { eid, sid } = fixture();
  const session = exam.createSession(eid, sid);
  const row = db.prepare('SELECT started_at FROM sessions WHERE id=?').get(session.id);
  assert.equal(row.started_at, null);
});

test('an unstarted session has a far-future deadline, not an invalid one', () => {
  const { eid, sid } = fixture();
  const session = exam.createSession(eid, sid);
  const dl = exam.deadline(session);
  assert.ok(Number.isFinite(dl.getTime()), 'deadline must be a real date');
  assert.ok(dl.getTime() > Date.now() + 86400000, 'deadline must be far in the future');
});

test('cleanup never expires a session that has not started', async () => {
  const { eid, sid } = fixture();
  exam.createSession(eid, sid);
  const n = await exam.finalizeStaleSessions();
  const row = db.prepare('SELECT status FROM sessions WHERE exam_id=? AND student_id=?').get(eid, sid);
  assert.equal(n, 0);
  assert.equal(row.status, 'in_progress');
});

test('cleanup still expires a session that started long ago', async () => {
  const { eid, sid } = fixture();
  const session = exam.createSession(eid, sid);
  db.prepare("UPDATE sessions SET started_at=datetime('now','-50 minutes') WHERE id=?").run(session.id);
  const original = wa.sendText;
  wa.sendText = async () => ({ messages: [{ id: 'mock' }] });
  wa.sendImage = async () => {};
  try {
    const n = await exam.finalizeStaleSessions();
    assert.ok(n >= 1, 'the lapsed session must be finalized');
    assert.equal(db.prepare('SELECT status FROM sessions WHERE id=?').get(session.id).status, 'expired');
  } finally {
    wa.sendText = original;
  }
});
```

**Step 2: Run test to verify it fails**

```
node --test test/timer-start.test.js
```

Expected: FAIL. `a new session has no start time` fails with `actual: '2026-10-04 12:00:00'` vs `expected: null`.

**Step 3: Change the CREATE TABLE DDL**

In `src/db.js`, change line 75 from:

```js
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
```

to:

```js
  started_at      TEXT,
```

**Step 4: Change the rebuild DDL in the existing migration**

In `src/db.js`, change line 274 (inside the `CREATE TABLE sessions_new` block) the same way — a database that still has the old UNIQUE constraint must not be rebuilt back into a NOT NULL column:

```js
        started_at      TEXT,
```

**Step 5: Add the nullable migration**

Insert after the existing sessions rebuild block, immediately before the `attempt_no` backfill comment at `src/db.js:300`. SQLite cannot relax `NOT NULL` in place, so this rebuilds the table. The four indexes are re-created explicitly because three of them are declared earlier in this file and are destroyed by the `DROP TABLE`.

```js
// Migration: started_at was NOT NULL DEFAULT (datetime('now')), so the write
// that parks an invited-but-unstarted session (started_at = NULL) always threw.
// A session that exists without a start time is the normal state between
// "invite sent" and "student replied", so the column has to allow it.
const sessionsStartedDdl = db
  .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'")
  .get();
if (sessionsStartedDdl && /started_at\s+TEXT\s+NOT\s+NULL/i.test(sessionsStartedDdl.sql)) {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`
      BEGIN;
      CREATE TABLE sessions_nullable_start (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        exam_id         INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
        student_id      INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        current_q_order INTEGER NOT NULL DEFAULT 1,
        status          TEXT NOT NULL DEFAULT 'in_progress',
        started_at      TEXT,
        last_active_at  TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at        TEXT,
        final_score     REAL DEFAULT 0,
        final_percentage REAL DEFAULT 0,
        passed          INTEGER DEFAULT 0,
        retry_count     INTEGER NOT NULL DEFAULT 0,
        attempt_no      INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO sessions_nullable_start
        (id, exam_id, student_id, current_q_order, status, started_at, last_active_at,
         ended_at, final_score, final_percentage, passed, retry_count, attempt_no)
      SELECT
        id, exam_id, student_id, current_q_order, status, started_at, last_active_at,
        ended_at, final_score, final_percentage, passed, COALESCE(retry_count, 0), attempt_no
      FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_nullable_start RENAME TO sessions;
      COMMIT;
    `);
    // Re-created because the DROP above took them with it, and three of the
    // four are declared before this migration runs.
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_exam ON sessions(exam_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_exam_student ON sessions(exam_id, student_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)');
    console.log('Migrated sessions: started_at is now nullable.');
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
```

Place this block **before** the `attempt_no` backfill at `src/db.js:302` and before `CREATE UNIQUE INDEX ... idx_sessions_active` at `src/db.js:320`, so those still see the rebuilt table.

**Step 6: Run test to verify it passes**

```
node --test test/timer-start.test.js
```

Expected: the first three PASS. `cleanup still expires a session that started long ago` will also pass, because it sets `started_at` explicitly.

**Step 7: Verify the migration is idempotent**

```
node -e "process.env.DB_PATH='$env:TEMP\exams-backup.db';require('./src/db');console.log(require('node:sqlite')?'':'')" 2>&1 | Select-String "Migrated"
```

Then run the identical command a second time and confirm `Migrated sessions: started_at is now nullable.` is **not** printed again.

**Step 8: Commit**

```bash
git add src/db.js test/timer-start.test.js
git commit -m "fix(db): allow sessions.started_at to be null until the student begins"
```

---

## Task 2: New sessions and restarts start with no clock

**Files:**
- Modify: `src/services/exam.js:240-242` (`createSession`)
- Modify: `src/services/exam.js:696-698` (`restartSession`)
- Test: `test/timer-start.test.js` (extend)

**Step 1: Write the failing test**

Append to `test/timer-start.test.js`:

```js
test('a restarted attempt also waits for the student', () => {
  const { eid, sid } = fixture();
  const first = exam.createSession(eid, sid);
  db.prepare("UPDATE sessions SET started_at=datetime('now') WHERE id=?").run(first.id);
  db.prepare("UPDATE sessions SET status='completed' WHERE id=?").run(first.id);
  const next = exam.restartSession(first);
  assert.equal(db.prepare('SELECT started_at FROM sessions WHERE id=?').get(next.id).started_at, null);
});
```

**Step 2: Run test to verify it fails**

```
node --test test/timer-start.test.js
```

Expected: FAIL — `restartSession` inherits the `datetime('now')` DEFAULT, so `started_at` is a timestamp, not `null`.

**Step 3: Make `createSession` write NULL explicitly**

In `src/services/exam.js`, replace lines 240-242:

```js
    info = db
      .prepare('INSERT INTO sessions (exam_id, student_id, attempt_no) VALUES (?, ?, ?)')
      .run(exam_id, studentId, attemptsUsed(examId, studentId) + 1);
```

with:

```js
    // started_at is written explicitly, not left to the column DEFAULT. A
    // session exists from the moment the invite goes out, so its absence is
    // what tells the timer not to run until the student actually replies.
    info = db
      .prepare('INSERT INTO sessions (exam_id, student_id, attempt_no, started_at) VALUES (?, ?, ?, NULL)')
      .run(examId, studentId, attemptsUsed(examId, studentId) + 1);
```

**Step 4: Make `restartSession` write NULL explicitly**

In `src/services/exam.js`, replace lines 696-698:

```js
  const info = db
    .prepare('INSERT INTO sessions (exam_id, student_id, attempt_no) VALUES (?, ?, ?)')
    .run(current.exam_id, current.student_id, used + 1);
```

with:

```js
  // Same reasoning as createSession: a restart is a fresh invite, so the new
  // attempt must not inherit a running clock.
  const info = db
    .prepare('INSERT INTO sessions (exam_id, student_id, attempt_no, started_at) VALUES (?, ?, ?, NULL)')
    .run(current.exam_id, current.student_id, used + 1);
```

**Step 5: Run test to verify it passes**

```
node --test test/timer-start.test.js
```

Expected: PASS, `# fail 0`.

**Step 6: Commit**

```bash
git add src/services/exam.js test/timer-start.test.js
git commit -m "fix(exam): create sessions and restarts without a start time"
```

---

## Task 3: Invite-only delivery

**Files:**
- Modify: `src/services/exam.js:1766-1773` (`sendExamToStudent`)
- Modify: `src/services/exam.js:391` region — `timeRemaining` guard (Task 4)
- Test: `test/timer-start.test.js` (extend)

**Step 1: Write the failing test**

Append to `test/timer-start.test.js`:

```js
test('sending an exam delivers the invite only, not a question', async () => {
  const { eid } = fixture();
  const sent = [];
  const original = wa.sendText;
  wa.sendText = async (phone, text) => { sent.push(text); return { messages: [{ id: 'mock' }] }; };
  try {
    const report = await exam.sendExamToRecipients(eid);
    assert.equal(report.sent, 1);
    assert.equal(report.failed, 0);
    const joined = sent.join('\n');
    assert.ok(joined.includes('INSTRUCTIONS'), 'the invite must be delivered');
    assert.ok(!joined.includes('QUESTION 1'), 'no question may be pushed at send time');
    assert.ok(!joined.includes('Time remaining'), 'no countdown before the student begins');
  } finally { wa.sendText = original; }
});

test('the first student reply starts the clock and delivers question 1', async () => {
  const { eid, student } = fixture();
  const sent = [];
  const original = wa.sendText;
  wa.sendText = async (phone, text) => { sent.push(text); return { messages: [{ id: 'mock' }] }; };
  try {
    await exam.sendExamToRecipients(eid);
    sent.length = 0;
    await exam.handleInbound(student.phone, 'START');
    const row = db.prepare('SELECT started_at FROM sessions WHERE exam_id=?').get(eid);
    assert.ok(row.started_at, 'the clock must start on first engagement');
    assert.ok(sent.join('\n').includes('QUESTION 1'), 'question 1 must arrive on the reply');
  } finally { wa.sendText = original; }
});

test('an unstarted session never emits a NaN countdown', () => {
  const { eid, sid } = fixture();
  const session = exam.createSession(eid, sid);
  const examRow = db.prepare('SELECT * FROM exams WHERE id=?').get(eid);
  const text = exam.timeRemaining(session, examRow);
  assert.ok(!/NaN/.test(text), `timer text was ${JSON.stringify(text)}`);
});
```

**Step 2: Run test to verify it fails**

```
node --test test/timer-start.test.js
```

Expected: FAIL on `sending an exam delivers the invite only` — `QUESTION 1` is present in the captured sends. The `timeRemaining` test fails with `TypeError` until Step 4 exports it.

**Step 3: Remove the send-time question push**

In `src/services/exam.js`, replace lines 1766-1773:

```js
    if (fresh) {
      const attemptCount = getSessionQuestionCount(session.id) || questionCount;
      db.prepare('UPDATE sessions SET started_at=NULL WHERE id=?').run(session.id);
      await sendIntro(session, student, exam, attemptCount, template);
      if (template) { report.sent++; return; }
    }
    await sendQuestionTo(session, student);
    report.sent++;
```

with:

```js
    if (fresh) {
      const attemptCount = getSessionQuestionCount(session.id) || questionCount;
      // The clock does not run from the send. createSession/restartSession
      // already left started_at NULL; re-assert it so a session carried over
      // from an older code path cannot resume a stale countdown.
      db.prepare('UPDATE sessions SET started_at=NULL WHERE id=?').run(session.id);
      await sendIntro(session, student, exam, attemptCount, template);
      // Question 1 is delivered by handleInbound when the student replies, so
      // that starting the clock and receiving the paper are the same event.
      report.sent++;
      return;
    }
    await sendQuestionTo(session, student);
    report.sent++;
```

**Step 4: Export `timeRemaining`**

The guard test needs to call it directly. Add to the `module.exports` block in `src/services/exam.js` (after `deadline,`):

```js
  timeRemaining,
```

**Step 5: Run test to verify progress**

```
node --test test/timer-start.test.js
```

Expected: the invite-only and first-reply tests now PASS. `an unstarted session never emits a NaN countdown` FAILS with `NaN:NaN` — that is Task 4.

**Step 6: Commit**

```bash
git add src/services/exam.js test/timer-start.test.js
git commit -m "fix(exam): deliver the invite at send time and question 1 on the reply"
```

---

## Task 4: Guard the countdown and split the intro copy

**Files:**
- Modify: `src/services/exam.js:439-447` (`timeRemaining`)
- Modify: `src/services/exam.js:640-662` (`formatExamIntro`)
- Modify: `src/services/exam.js:917` (timestamp format)
- Test: `test/timer-start.test.js` (already written in Task 3)

**Step 1: Run test to verify it fails**

```
node --test test/timer-start.test.js
```

Expected: FAIL on `an unstarted session never emits a NaN countdown`, actual `NaN:NaN`.

**Step 2: Guard `timeRemaining`**

In `src/services/exam.js`, replace line 440 with a guard before the arithmetic:

```js
function timeRemaining(session, exam) {
  // Reachable only if a question is ever delivered before the student engages.
  // new Date('') is NaN, and "Time remaining: NaN:NaN" must never ship.
  if (!session || !session.started_at) return '—';
  const startedAtStr = String(session.started_at);
```

Keep the rest of the function unchanged.

**Step 3: Split the intro copy**

In `src/services/exam.js`, change the signature at line 640 and the timer step at line 648:

```js
function formatExamIntro(exam, questionCount, { started = false } = {}) {
```

and replace the fourth step in `steps`:

```js
    started
      ? 'Your timer starts now. The exam ends automatically when time is up.'
      : 'Reply START to begin — your timer starts the moment you reply.',
```

Update the call at `src/services/exam.js:1032` (the resume path inside `maybeStartSession`, where the student has just messaged) to:

```js
  await wa.sendText(student.phone, formatExamIntro(exam, questionCount, { started: true }));
```

Leave `src/services/exam.js:984` and the `sendIntro` call at `:1716` on the default (invite) wording.

**Step 4: Normalise the timestamp format**

In `src/services/exam.js`, replace line 917:

```js
    db.prepare("UPDATE sessions SET started_at=datetime('now') WHERE id=?").run(session.id);
```

with the same ISO-8601-Z form used at `:929` and `:1022`, so `started_at` has one format in every row:

```js
    const startedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    db.prepare('UPDATE sessions SET started_at = ? WHERE id=?').run(startedAt, session.id);
```

**Step 5: Run test to verify it passes**

```
node --test test/timer-start.test.js
```

Expected: PASS, `# fail 0`.

**Step 6: Run the full suite**

```
npm test
```

Expected: `# fail 0`. If `test/delivery-ledger.test.js` or `test/regression.test.js` fail, read the assertion before changing anything — both were checked during design and neither asserts that a question is pushed at send time.

**Step 7: Commit**

```bash
git add src/services/exam.js test/timer-start.test.js
git commit -m "fix(exam): guard the countdown and start the clock wording to the context"
```

---

## Task 5: Resend route and targeting

**Files:**
- Create: `test/exam-resend.test.js`
- Modify: `src/services/exam.js:1793-1814` (`sendExamToRecipients`)
- Modify: `src/services/exam.js:1816+` (`module.exports`)
- Modify: `src/routes/api.js:1161` (add route after `resend-all`)

**Step 1: Write the failing test**

Create `test/exam-resend.test.js`:

```js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-resend-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.DOTENV_CONFIG_PATH = path.join(tmp, '.env');
process.env.SEED_ON_BOOT = 'false';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const exam = require('../src/services/exam');
const wa = require('../src/services/whatsapp');
const config = require('../src/config');
config.exam.sendCertificates = false;
after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

let seq = 0;
function fixture(studentCount = 2) {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Resend',30,'live')").run().lastInsertRowid;
  db.prepare("INSERT INTO questions(exam_id,q_order,type,text,options,correct_answer) VALUES (?,1,'objective','Q1',?,'A')")
    .run(eid, JSON.stringify([{ key: 'A', text: 'Yes' }, { key: 'B', text: 'No' }]));
  const ids = [];
  for (let i = 0; i < studentCount; i++) {
    const sid = db.prepare('INSERT INTO students(phone) VALUES (?)').run('233resend' + (seq++) + eid).lastInsertRowid;
    db.prepare('INSERT INTO exam_recipients(exam_id,student_id) VALUES (?,?)').run(eid, sid);
    ids.push(sid);
  }
  return { eid, ids, student: (id) => db.prepare('SELECT * FROM students WHERE id=?').get(id) };
}

test('auto-target resend reaches only recipients who never started', async () => {
  const { eid, ids } = fixture(2);
  const original = wa.sendText;
  wa.sendText = async () => ({ messages: [{ id: 'mock' }] });
  try {
    await exam.sendExamToRecipients(eid);
    // The first student begins; the second never replies.
    await exam.handleInbound('233resend0' + eid, 'START');
    const report = await exam.resendExamToRecipients(eid, null);
    assert.equal(report.sent, 1, 'only the never-started student is re-invited');
    assert.ok(db.prepare('SELECT started_at FROM sessions WHERE exam_id=? AND student_id=?').get(eid, ids[0]).started_at);
  } finally { wa.sendText = original; }
});

test('an explicit studentIds list overrides auto-targeting', async () => {
  const { eid, ids } = fixture(2);
  const original = wa.sendText;
  wa.sendText = async () => ({ messages: [{ id: 'mock' }] });
  try {
    await exam.sendExamToRecipients(eid);
    const report = await exam.resendExamToRecipients(eid, [ids[0]]);
    assert.equal(report.sent, 1);
    assert.equal(report.skipped + report.sent, 1, 'only the requested student is touched');
  } finally { wa.sendText = original; }
});

test('resending to a student mid-exam nudges instead of restarting', async () => {
  const { eid, ids } = fixture(1);
  const sent = [];
  const original = wa.sendText;
  wa.sendText = async (phone, text) => { sent.push(text); return { messages: [{ id: 'mock' }] }; };
  try {
    await exam.sendExamToRecipients(eid);
    await exam.handleInbound('233resend0' + eid, 'START');
    const before = db.prepare('SELECT id, current_q_order FROM sessions WHERE exam_id=? AND student_id=?').get(eid, ids[0]);
    sent.length = 0;
    const report = await exam.resendExamToRecipients(eid, [ids[0]]);
    assert.equal(report.resumed, 1, 'a live attempt is nudged');
    const after = db.prepare('SELECT id, current_q_order FROM sessions WHERE exam_id=? AND student_id=?').get(eid, ids[0]);
    assert.equal(after.id, before.id, 'no new attempt is created');
    assert.equal(after.current_q_order, before.current_q_order, 'position is unchanged');
    assert.ok(sent.join('\n').includes('QUESTION 1'), 'the current question is re-delivered');
  } finally { wa.sendText = original; }
});

test('resending to a student who finished is skipped', async () => {
  const { eid, ids } = fixture(1);
  const original = wa.sendText;
  wa.sendText = async () => ({ messages: [{ id: 'mock' }] });
  try {
    await exam.sendExamToRecipients(eid);
    const s = db.prepare('SELECT id FROM sessions WHERE exam_id=? AND student_id=?').get(eid, ids[0]);
    db.prepare("UPDATE sessions SET status='completed' WHERE id=?").run(s.id);
    const report = await exam.resendExamToRecipients(eid, [ids[0]]);
    assert.equal(report.skipped, 1);
    assert.equal(report.sent, 0);
  } finally { wa.sendText = original; }
});

test('the resend report keeps the shape the dashboard already renders', async () => {
  const { eid } = fixture(1);
  const original = wa.sendText;
  wa.sendText = async () => ({ messages: [{ id: 'mock' }] });
  try {
    const report = await exam.resendExamToRecipients(eid, null);
    for (const key of ['sent', 'failed', 'skipped', 'resumed', 'errors']) {
      assert.ok(key in report, `report must include ${key}`);
    }
  } finally { wa.sendText = original; }
});
```

**Step 2: Run test to verify it fails**

```
node --test test/exam-resend.test.js
```

Expected: FAIL with `TypeError: exam.resendExamToRecipients is not a function`.

**Step 3: Add the service function**

In `src/services/exam.js`, insert after `sendExamToRecipients` (which ends at line 1814):

```js
/**
 * Re-invite recipients. With no `studentIds` the target is every recipient who
 * has no started attempt — the cohort that got the invite but never began, plus
 * anyone whose send failed. An explicit list is honoured as given, so a
 * per-student resend can also nudge somebody who is already mid-exam.
 */
async function resendExamToRecipients(examId, studentIds = null) {
  const exam = db.prepare('SELECT * FROM exams WHERE id=?').get(examId);
  if (!exam) throw new Error('Exam not found');
  const report = { sent: 0, failed: 0, skipped: 0, resumed: 0, errors: [] };
  if (!['published', 'live'].includes(exam.status)) {
    report.skipped = db
      .prepare('SELECT COUNT(*) c FROM exam_recipients WHERE exam_id=?')
      .get(examId).c;
    return report;
  }

  const ids = (Array.isArray(studentIds) ? studentIds : [])
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v > 0);
  const unique = [...new Set(ids)];

  const placeholders = unique.map(() => '?').join(',');
  const rows = unique.length
    ? db.prepare(
        `SELECT s.* FROM students s
         JOIN exam_recipients r ON r.student_id = s.id
         WHERE r.exam_id = ? AND s.id IN (${placeholders})`
      ).all(examId, ...unique)
    : db.prepare(
        `SELECT s.* FROM students s
         JOIN exam_recipients r ON r.student_id = s.id
         WHERE r.exam_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM sessions ss
              WHERE ss.exam_id = r.exam_id AND ss.student_id = s.id
                AND ss.started_at IS NOT NULL
           )`
      ).all(examId);

  const questionCount = db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id=?').get(examId).c;
  const template = config.whatsapp.templateName;
  await mapLimit(rows, config.exam.sendConcurrency, (student) =>
    sendExamToStudent(exam, student, questionCount, template, report)
  );
  return report;
}
```

**Step 4: Export it**

In `src/services/exam.js`, add to `module.exports` after `sendExamToRecipients,`:

```js
  resendExamToRecipients,
```

**Step 5: Add the route**

In `src/routes/api.js`, insert after the `resend-all` route at line 1166:

```js
// Re-invite an exam. No studentIds targets everyone who has not started; an
// explicit list targets exactly those students.
router.post('/exams/:id/resend', asyncWrap(async (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (exam.status !== 'live' && exam.status !== 'published') {
    return res.status(400).json({ error: 'Only a live exam can be resent.' });
  }
  const ids = req.body && Array.isArray(req.body.studentIds) ? req.body.studentIds : null;
  res.json(await examService.resendExamToRecipients(req.params.id, ids));
}));
```

This sits after the auth guard at `src/routes/api.js:99`, so it inherits admin auth with no extra work.

**Step 6: Run test to verify it passes**

```
node --test test/exam-resend.test.js
```

Expected: PASS, `# fail 0`.

**Step 7: Run the full suite**

```
npm test
```

Expected: `# fail 0`.

**Step 8: Commit**

```bash
git add src/services/exam.js src/routes/api.js test/exam-resend.test.js
git commit -m "feat(exam): resend the exam to students who have not started"
```

---

## Task 6: Bulk delete route

**Files:**
- Create: `test/student-bulk-delete.test.js`
- Modify: `src/routes/api.js:1144-1148`

**Step 1: Write the failing test**

Create `test/student-bulk-delete.test.js`:

```js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-bulkdel-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.DOTENV_CONFIG_PATH = path.join(tmp, '.env');
process.env.SEED_ON_BOOT = 'false';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function seed() {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Bulk',30,'live')").run().lastInsertRowid;
  db.prepare("INSERT INTO questions(exam_id,q_order,type,text,correct_answer) VALUES (?,1,'objective','Q1','A')").run(eid);
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const sid = db.prepare('INSERT INTO students(phone) VALUES (?)').run('233bulkdel' + i).lastInsertRowid;
    db.prepare('INSERT INTO exam_recipients(exam_id,student_id) VALUES (?,?)').run(eid, sid);
    const sess = db.prepare('INSERT INTO sessions(exam_id,student_id,started_at) VALUES (?,?,datetime(\'now\'))').run(eid, sid).lastInsertRowid;
    const q = db.prepare('SELECT id FROM questions WHERE exam_id=?').get(eid);
    db.prepare('INSERT INTO answers(session_id,question_id,q_order,answer_text) VALUES (?,?,1,\'A\')').run(sess, q.id);
    ids.push(sid);
  }
  return { eid, ids };
}

test('bulk delete removes every selected student and their dependent rows', () => {
  const { ids } = seed();
  const stmt = db.prepare('DELETE FROM students WHERE id = ?');
  const del = db.transaction((list) => {
    let n = 0;
    for (const id of new Set(list)) n += stmt.run(id).changes;
    return n;
  });
  assert.equal(del(ids), 3);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM students').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM exam_recipients').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM answers').get().c, 0);
});

test('bulk delete leaves unselected students alone', () => {
  const { ids } = seed();
  db.prepare('DELETE FROM students WHERE id = ?').run(ids[0]);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM students').get().c, 2);
  assert.ok(db.prepare('SELECT * FROM students WHERE id=?').get(ids[1]));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions WHERE student_id=?').get(ids[1]).c, 1);
});

test('repeated ids are collapsed and unknown ids are silent no-ops', () => {
  const { ids } = seed();
  const stmt = db.prepare('DELETE FROM students WHERE id = ?');
  const del = db.transaction((list) => {
    let n = 0;
    for (const id of new Set(list)) n += stmt.run(id).changes;
    return n;
  });
  assert.equal(del([ids[0], ids[0], 999999]), 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM students').get().c, 2);
});

test('a student linked to another exam keeps that link when deleted elsewhere', () => {
  const { ids } = seed();
  const other = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Other',30,'live')").run().lastInsertRowid;
  db.prepare('INSERT INTO exam_recipients(exam_id,student_id) VALUES (?,?)').run(other, ids[0]);
  db.prepare('DELETE FROM students WHERE id = ?').run(ids[0]);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM exam_recipients WHERE exam_id=?').get(other).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM exams WHERE id=?').get(other).c, 1);
});
```

**Step 2: Run test to verify the cascade assumptions hold**

```
node --test test/student-bulk-delete.test.js
```

Expected: PASS. These tests exercise the schema's existing `ON DELETE CASCADE` rather than new code, so passing here confirms the cascade the route relies on. If the cascade assertions fail, stop and report it — it means the schema does not behave as the design assumes.

**Step 3: Add the route**

In `src/routes/api.js`, insert after the existing single-delete route at line 1148:

```js
// Bulk delete. Deliberately the same statement as the single delete above, in
// one transaction, so bulk and individual removal cannot drift apart in
// behaviour. The dependent rows go because of the schema's ON DELETE CASCADE,
// not because of anything written here.
router.post('/students/bulk-delete', (req, res) => {
  const raw = (req.body && req.body.ids) || [];
  if (!Array.isArray(raw)) return res.status(400).json({ error: 'ids must be an array of student ids' });
  const ids = raw.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const remove = db.prepare('DELETE FROM students WHERE id = ?');
  const deleted = db.transaction((list) => {
    let n = 0;
    for (const id of new Set(list)) n += remove.run(id).changes;
    return n;
  });
  res.json({ deleted: deleted(ids) });
});
```

Registered after the auth guard at `src/routes/api.js:99`, so it inherits admin auth. It cannot collide with `PATCH`/`DELETE /students/:id` because Express matches method and path together.

**Step 4: Run the full suite**

```
npm test
```

Expected: `# fail 0`.

**Step 5: Commit**

```bash
git add src/routes/api.js test/student-bulk-delete.test.js
git commit -m "feat(students): add bulk delete for the students list"
```

---

## Task 7: Students page bulk selection UI

**Files:**
- Modify: `src/public/app.js:2093-2135` (`renderStudents`, `deleteStudent`)

**Step 1: Replace the Students table markup**

In `renderStudents()`, replace the `<table>` block at `src/public/app.js:2102-2115`:

```js
    <div class="card table-card reveal">
      <div id="studentBulkBar" class="spread" style="margin-bottom:12px" hidden>
        <p class="sub" style="margin:0"><b id="studentBulkCount">0</b> selected</p>
        <button class="btn btn-primary danger" onclick="deleteSelectedStudents()">Delete selected</button>
      </div>
      <table>
        <thead><tr>
          <th style="width:28px"><input type="checkbox" id="studentSelectAll" onchange="toggleAllStudents(this)"></th>
          <th>Name</th><th>Phone</th><th>Exams</th><th>Attempts</th><th>First seen</th><th></th>
        </tr></thead>
        <tbody>
          ${students.length === 0 ? `<tr><td colspan="7"><div class="empty-state">${I.empty}<p>No students yet.</p></div></td></tr>` : ''}
          ${students.map((s) => `<tr>
            <td><input type="checkbox" class="student-pick" value="${s.id}" onchange="syncStudentSelection()"></td>
            <td>${esc(s.name || '—')}</td>
            <td>${esc(s.phone)}</td>
            <td>${s.exams}</td>
            <td>${s.attempts}</td>
            <td class="muted">${s.created_at}</td>
            <td><button class="small ghost" onclick="renameStudent(${s.id})">Rename</button> <button class="small ghost danger" onclick="deleteStudent(${s.id}, this)">Delete</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
```

**Step 2: Add the selection helpers**

Insert after `renderStudents()` in `src/public/app.js`:

```js
function selectedStudentIds() {
  return [...document.querySelectorAll('.student-pick:checked')].map((el) => Number(el.value));
}

function syncStudentSelection() {
  const picked = selectedStudentIds();
  const bar = document.getElementById('studentBulkBar');
  const count = document.getElementById('studentBulkCount');
  const all = document.getElementById('studentSelectAll');
  if (bar) bar.hidden = picked.length === 0;
  if (count) count.textContent = String(picked.length);
  if (all) {
    const boxes = [...document.querySelectorAll('.student-pick')];
    all.checked = boxes.length > 0 && picked.length === boxes.length;
  }
}

function toggleAllStudents(master) {
  for (const el of document.querySelectorAll('.student-pick')) el.checked = master.checked;
  syncStudentSelection();
}
```

**Step 3: Add the bulk delete handler**

Insert after `deleteStudent()` in `src/public/app.js`:

```js
async function deleteSelectedStudents() {
  const ids = selectedStudentIds();
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} student${ids.length === 1 ? '' : 's'}? This permanently removes their exam sessions and answers.`)) return;
  const res = await api('/api/students/bulk-delete', { method: 'POST', body: { ids } });
  invalidateCache('/api/students');
  toast(`${res.deleted} student${res.deleted === 1 ? '' : 's'} deleted`);
  renderStudents();
}
```

**Step 4: Verify in the browser**

Run `npm start`, sign in, open Students. Confirm: the select-all checkbox toggles every row; the bar appears only when something is selected; the count matches; cancelling the confirm changes nothing; deleting removes exactly the ticked rows and the table re-renders with the bar hidden.

```
npm start
```

**Step 5: Commit**

```bash
git add src/public/app.js
git commit -m "feat(students): add bulk selection and delete to the students list"
```

---

## Task 8: Resend controls and the four-state status column

**Files:**
- Modify: `src/public/app.js:686-695` (Recipients card buttons)
- Modify: `src/public/app.js:705-724` (Recipients table)
- Modify: `src/public/app.js:1657-1670` (`sendExam`, plus a new `resendExam`)

**Step 1: Add the resend button**

In the Recipients card, replace the button row at `src/public/app.js:690-693`:

```js
        <div class="row" style="margin-top:12px;flex-wrap:wrap;gap:8px">
          <button class="btn btn-primary" onclick="addRecipients(${id})">Add Recipients</button>
          <button class="btn btn-ghost" onclick="sendExam(${id})">${I.wa} Send Exam to Recipients</button>
          <button class="btn btn-ghost" onclick="resendExam(${id})">${I.wa} Resend to Not Started (${notParticipated.length})</button>
        </div>
```

`notParticipated` is already computed at `src/public/app.js:674`.

**Step 2: Replace the status cell and add the per-row Resend**

In the recipients table, replace the row mapping at `src/public/app.js:709-722`:

```js
          ${recipients.map((r) => {
            const sess = participatedMap[r.id];
            let status;
            if (sess) {
              const finished = ['completed', 'expired', 'ended'].includes(sess.status);
              status = finished
                ? '<span class="pass">Finished</span>'
                : '<span class="pass">In progress</span>';
            } else if (r.sent_at) {
              status = '<span class="fail">Invite sent — not started</span>';
            } else {
              status = '<span class="muted">Not sent</span>';
            }
            const time = sess && sess.started_at ? sess.started_at : '';
            return `<tr>
              <td>${esc(r.name || '—')}</td>
              <td>${esc(r.phone)}</td>
              <td class="muted">${esc(r.sent_at || '—')}</td>
              <td>${status} ${time ? `<span class="muted qmeta">(${esc(time)})</span>` : ''}</td>
              <td>
                <button class="small ghost" onclick="resendExam(${id}, ${r.id})">Resend</button>
                <button class="small ghost danger" onclick="removeRecipient(${id}, ${r.id})">Remove</button>
              </td>
            </tr>`;
          }).join('')}
```

**Step 3: Add `resendExam` and fix the stale send copy**

In `src/public/app.js`, replace `sendExam` at lines 1657-1670 so the confirm no longer claims sessions start immediately, and add the new function after it:

```js
async function sendExam(id) {
  if (!confirm('Send this exam to all recipients now? Each student gets an invite; their timer starts when they reply.')) return;
  const btn = event.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await api(`/api/exams/${id}/send`, { method: 'POST' });
    invalidateCache(`/api/exams/${id}`);
    const errList = (res.errors || []).map((e) => `${e.phone}: ${e.error}`).join(' | ');
    const parts = [`Sent ${res.sent}`, `resumed ${res.resumed || 0}`, `failed ${res.failed}`];
    toast(errList ? `${parts.join(', ')}. ${errList}` : parts.join(', ') + '.');
    renderExam(id);
  } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Send Exam to Recipients'; }
}

async function resendExam(id, studentId = null) {
  const target = studentId ? 'this student' : 'everyone who has not started';
  if (!confirm(`Resend the exam to ${target}? Their timer starts when they reply.`)) return;
  const btn = event && event.currentTarget;
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    const body = studentId ? { studentIds: [studentId] } : {};
    const res = await api(`/api/exams/${id}/resend`, { method: 'POST', body });
    invalidateCache(`/api/exams/${id}`);
    const errList = (res.errors || []).map((e) => `${e.phone}: ${e.error}`).join(' | ');
    const parts = [`sent ${res.sent}`, `resumed ${res.resumed || 0}`, `skipped ${res.skipped}`, `failed ${res.failed}`];
    toast(errList ? `${parts.join(', ')}. ${errList}` : parts.join(', ') + '.');
    renderExam(id);
  } catch (e) {
    toast(e.message, true);
    if (btn) { btn.disabled = false; btn.textContent = 'Resend'; }
  }
}
```

**Step 4: Verify in the browser**

Run `npm start`, open a live exam, Recipients tab. Confirm: the resend button shows the not-started count; a per-row Resend prompts; the Status column shows all four states; the participation summary still reads correctly.

```
npm start
```

**Step 5: Commit**

```bash
git add src/public/app.js
git commit -m "feat(exam): add resend controls and a four-state recipient status"
```

---

## Task 9: Full verification

**Files:** none

**Step 1: Run the whole suite**

```
npm test
```

Expected: `# fail 0`, with the three new files reporting passes.

**Step 2: Confirm the migration is safe on a copy of the real database**

```
Copy-Item data\exams.db "$env:TEMP\exams-verify.db" -Force
$env:DB_PATH="$env:TEMP\exams-verify.db"
node -e "require('./src/db');const db=require('./src/db');console.log(db.prepare('SELECT COUNT(*) c FROM students').get(), db.prepare(\"SELECT sql FROM sqlite_master WHERE name='sessions'\").get().sql.includes('NOT NULL'))"
```

Expected: the student count matches the original and the final `false` confirms `started_at` is nullable.

```
Remove-Item Env:\DB_PATH
```

**Step 3: Confirm no stale "starts immediately" copy remains**

```
Select-String -Path src\public\app.js,src\services\exam.js -Pattern "Sessions start immediately|Your timer starts now"
```

Expected: `Your timer starts now` may appear only inside the `started` branch of `formatExamIntro`. `Sessions start immediately` should not appear at all.

**Step 4: Review the diff**

```
git diff cfbd50f..HEAD --stat
```

Expected changes limited to: `src/db.js`, `src/services/exam.js`, `src/routes/api.js`, `src/public/app.js`, and three new test files.