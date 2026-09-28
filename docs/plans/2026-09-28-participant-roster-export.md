# Participant Roster Export Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let an admin see every exam participant split into ranked-finished, in-progress, not-started and not-sent, then download it as CSV or print it to paper/PDF, with finished students ordered by percentage descending.

**Architecture:** One pure function `buildParticipantRoster(examId)` in `src/services/results.js` builds four buckets from the existing `sessions` and `exam_recipients` tables, using a SQL window function to pick each student's best finished attempt. That single structure feeds a JSON route, a CSV route and a standalone print page, so all three can never disagree. Three routes in `src/routes/api.js` inherit the existing `auth.verifyAdmin` guard. The admin SPA gets a card with a Print button and a Download CSV button.

**Tech Stack:** Node.js with `node:sqlite` `DatabaseSync`, Express 4, `node:test` with `node:assert/strict`, vanilla JS SPA (no build step, no framework).

**Design doc:** `docs/plans/2026-09-28-participant-roster-export-design.md`

---

## Critical context for the implementer

**Schema facts (verified — do not re-derive):**

- `students(id, phone, name, created_at)` — `phone` is UNIQUE
- `exam_recipients(exam_id, student_id, sent_at)` — composite PK
- `sessions(id, exam_id, student_id, current_q_order, status, started_at, last_active_at, ended_at, final_score, final_percentage, passed, attempt_no, retry_count)`
- `sessions.status` values in use: `in_progress`, `completed`, `ended`, `expired`, `abandoned`
- `exams(id, title, duration_minutes, pass_percentage, total_marks, status, published_at, ended_at, max_attempts)`

**Existing auth:** `src/routes/api.js:81` has `router.use(...)` requiring `auth.verifyAdmin` for every route registered after it. New routes must be added **after** that line to inherit the guard.

**Existing test isolation:** two patterns exist. `test/helpers/isolate.js` is required first by most suites and points `DB_PATH` at a temp dir. `test/attempts.test.js` instead sets `process.env.DB_PATH` itself before requiring `../src/db`. For this feature use the **`attempts.test.js` pattern** because the roster tests need to insert real rows and read them back.

**Frontend auth gotcha:** the API authenticates with an `Authorization: Bearer <token>` **header** (`src/public/app.js:31`), never a query parameter. A plain `<a href="/api/exams/1/participants.csv">` will return **401**. Both buttons must `fetch` with the header, then trigger the download or the print window from the resulting blob. This is the single easiest thing to get wrong.

**No build step.** `src/public/app.js` is served directly. `dist/index.html` is a build artifact — do not edit it by hand; check whether it is generated before assuming it needs a change.

---

### Task 1: Roster query — best attempt per student, ranked

**Files:**
- Create: `test/participant-roster.test.js`
- Modify: `src/services/results.js`

**Step 1: Write the failing test**

Create `test/participant-roster.test.js` with the temp-database pattern copied from `test/attempts.test.js:1-14`:

```js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-roster-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.SEED_ON_BOOT = 'false';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const results = require('../src/services/results');
after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// One exam, one question, N recipients with finished sessions carrying scores.
function seedFinished() {
  const eid = db
    .prepare("INSERT INTO exams(title,duration_minutes,status,pass_percentage) VALUES ('Bio',30,'live',50)")
    .run().lastInsertRowid;
  const mk = (name, pct, score, status, attempt, ended) => {
    const sid = db.prepare('INSERT INTO students(phone,name) VALUES (?,?)').run('233' + Math.random().toString(36).slice(2, 8), name).lastInsertRowid;
    db.prepare('INSERT INTO exam_recipients(exam_id,student_id,sent_at) VALUES (?,?,datetime(\'now\'))').run(eid, sid);
    db.prepare(
      `INSERT INTO sessions(exam_id,student_id,status,final_score,final_percentage,passed,attempt_no,ended_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(eid, sid, status, score, pct, pct >= 50 ? 1 : 0, attempt, ended);
    return sid;
  };
  return {
    eid,
    low: mk('Low Learner', 30, 3, 'completed', 1, '2026-01-01 10:00:00'),
    high: mk('High Learner', 90, 9, 'completed', 1, '2026-01-01 10:05:00'),
    mid: mk('Mid Learner', 60, 6, 'expired', 1, '2026-01-01 10:10:00'),
  };
}

test('finished students are ranked by percentage, highest first', () => {
  const { eid } = seedFinished();
  const roster = results.buildParticipantRoster(eid);
  const names = roster.finished.map((r) => r.name);
  assert.deepEqual(names, ['High Learner', 'Mid Learner', 'Low Learner']);
  assert.deepEqual(roster.finished.map((r) => r.rank), [1, 2, 3]);
});

test('only a student\'s best finished attempt is ranked', () => {
  const eid = db.prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Retry',30,'live')").run().lastInsertRowid;
  const sid = db.prepare("INSERT INTO students(phone,name) VALUES ('233retry','Retrier')").run().lastInsertRowid;
  db.prepare('INSERT INTO exam_recipients(exam_id,student_id) VALUES (?,?)').run(eid, sid);
  for (const [pct, attempt] of [[20, 1], [80, 2]]) {
    db.prepare(
      `INSERT INTO sessions(exam_id,student_id,status,final_score,final_percentage,passed,attempt_no)
       VALUES (?,?,'completed',?,?,1,?)`
    ).run(eid, sid, pct / 10, pct, attempt);
  }
  const roster = results.buildParticipantRoster(eid);
  assert.equal(roster.finished.length, 1, 'one row per student, not one per attempt');
  assert.equal(roster.finished[0].final_percentage, 80);
  assert.equal(roster.finished[0].attempt_no, 2);
});
```

**Step 2: Run the test to verify it fails**

Run: `node --test test/participant-roster.test.js`
Expected: FAIL with `TypeError: results.buildParticipantRoster is not a function`

**Step 3: Write minimal implementation**

Add to `src/services/results.js`, above `module.exports`:

```js
// ── Participant roster ──────────────────────────────────────────────────
// One structure, three renderings (screen, CSV, print). Ranking is done in SQL
// with a window function so the best attempt per student is chosen by the
// database, not by JS sorting that could drift between the three views.
const FINISHED_STATUSES = "('completed','ended','expired')";

function buildParticipantRoster(examId) {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
  if (!exam) return null;

  // Every recipient is the backbone, so a student who never started is still
  // listed. LEFT JOINs keep them, with NULL session columns.
  const rows = db
    .prepare(
      `SELECT st.id AS student_id, st.name, st.phone, r.sent_at,
              s.id AS session_id, s.status, s.started_at, s.ended_at,
              s.final_score, s.final_percentage, s.passed, s.attempt_no,
              s.current_q_order,
              ROW_NUMBER() OVER (
                PARTITION BY st.id
                ORDER BY COALESCE(s.final_percentage, -1) DESC,
                         COALESCE(s.final_score, -1) DESC,
                         s.ended_at ASC
              ) AS attempt_rank
         FROM exam_recipients r
         JOIN students st ON st.id = r.student_id
         LEFT JOIN sessions s ON s.student_id = st.id AND s.exam_id = r.exam_id
        WHERE r.exam_id = ?
        ORDER BY COALESCE(s.final_percentage, -1) DESC,
                 COALESCE(s.final_score, -1) DESC,
                 s.ended_at ASC`
    )
    .all(examId);

  const byId = new Map();
  for (const row of rows) {
    if (!byId.has(row.student_id)) byId.set(row.student_id, []);
    byId.get(row.student_id).push(row);
  }

  const shape = (r) => ({
    student_id: r.student_id,
    name: r.name || '',
    phone: r.phone,
    sent_at: r.sent_at || '',
    status: r.status || '',
    started_at: r.started_at || '',
    ended_at: r.ended_at || '',
    final_score: r.final_score,
    final_percentage: r.final_percentage,
    passed: r.passed ? 1 : 0,
    attempt_no: r.attempt_no,
    questions_answered: r.current_q_order || 0,
  });

  const finished = [];
  const inProgress = [];
  const notStarted = [];
  const notSent = [];

  for (const sessions of byId.values()) {
    // The best attempt is attempt_rank 1, whatever its status.
    const best = sessions.find((r) => r.attempt_rank === 1) || sessions[0];
    // Finished means SOME attempt finished, even if a later one is in progress:
    // a student who already has a final score belongs in the leaderboard.
    const bestFinished = sessions.find((r) => FINISHED_STATUSES.includes(`'${r.status}'`));

    if (bestFinished) {
      finished.push({ ...shape(bestFinished), rank: 0 });
    } else if (best.status === 'in_progress') {
      inProgress.push(shape(best));
    } else if (best.sent_at) {
      notStarted.push(shape(best));
    } else {
      notSent.push(shape(best));
    }
  }

  finished.forEach((r, i) => { r.rank = i + 1; });

  return {
    exam: {
      id: exam.id,
      title: exam.title,
      duration_minutes: exam.duration_minutes,
      pass_percentage: exam.pass_percentage,
      status: exam.status,
    },
    finished,
    inProgress,
    notStarted,
    notSent,
    summary: {
      finished: finished.length,
      inProgress: inProgress.length,
      notStarted: notStarted.length,
      notSent: notSent.length,
      total: byId.size,
    },
  };
}
```

Also extend the export at the end of the file:

```js
module.exports = { computeForSession, persistSessionTotals, sendResultMessage, sendResultAndCertificate, bulkResendResults, reportHTML, buildParticipantRoster, FINISHED_STATUSES };
```

**Step 4: Run the test to verify it passes**

Run: `node --test test/participant-roster.test.js`
Expected: PASS, 2 tests

**Step 5: Commit**

```bash
git add test/participant-roster.test.js src/services/results.js
git commit -m "Rank exam participants by percentage using each student's best attempt"
```

---

### Task 2: Section coverage and null-percentage ordering

**Files:**
- Modify: `test/participant-roster.test.js`
- Modify: `src/services/results.js` (only if a test fails)

**Step 1: Write the failing tests**

Append to `test/participant-roster.test.js`:

```js
test('the four sections are mutually exclusive and cover every recipient', () => {
  const eid = db
    .prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Mix',30,'live')")
    .run().lastInsertRowid;
  const mk = (name, sent, session) => {
    const sid = db.prepare('INSERT INTO students(phone,name) VALUES (?,?)').run('233' + Math.random().toString(36).slice(2, 8), name).lastInsertRowid;
    if (sent) db.prepare('INSERT INTO exam_recipients(exam_id,student_id,sent_at) VALUES (?,?,datetime(\'now\'))').run(eid, sid);
    if (session) {
      db.prepare('INSERT INTO sessions(exam_id,student_id,status,current_q_order) VALUES (?,?,?,?)')
        .run(eid, sid, session, 1);
    }
    return sid;
  };
  mk('Finished One', true, 'completed');
  mk('Running', true, 'in_progress');
  mk('Waiting', true, null);
  mk('Never Told', false, null);

  const r = results.buildParticipantRoster(eid);
  const all = [...r.finished, ...r.inProgress, ...r.notStarted, ...r.notSent];
  const ids = all.map((x) => x.student_id);
  assert.equal(ids.length, 4, 'every recipient appears exactly once');
  assert.equal(new Set(ids).size, 4, 'no student appears in two sections');
  assert.equal(r.finished.length, 1);
  assert.equal(r.inProgress.length, 1);
  assert.equal(r.notStarted.length, 1);
  assert.equal(r.notSent.length, 1);
});

test('a student with no final percentage sorts last instead of erroring', () => {
  const eid = db
    .prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Nulls',30,'live')")
    .run().lastInsertRowid;
  const mk = (name, pct) => {
    const sid = db.prepare('INSERT INTO students(phone,name) VALUES (?,?)').run('233' + Math.random().toString(36).slice(2, 8), name).lastInsertRowid;
    db.prepare('INSERT INTO exam_recipients(exam_id,student_id) VALUES (?,?)').run(eid, sid);
    db.prepare(
      `INSERT INTO sessions(exam_id,student_id,status,final_score,final_percentage)
       VALUES (?,?,'completed',NULL,?)`
    ).run(eid, sid, pct);
  };
  mk('Graded', 75);
  mk('Ungraded', null);
  const r = results.buildParticipantRoster(eid);
  assert.equal(r.finished.length, 2);
  assert.equal(r.finished[r.finished.length - 1].name, 'Ungraded', 'NULL percentage must sort last');
});

test('a not-started recipient still reports the allotted time', () => {
  const eid = db
    .prepare("INSERT INTO exams(title,duration_minutes,status) VALUES ('Timer',45,'live')")
    .run().lastInsertRowid;
  const sid = db.prepare("INSERT INTO students(phone,name) VALUES ('233timer','Waiter')").run().lastInsertRowid;
  db.prepare('INSERT INTO exam_recipients(exam_id,student_id,sent_at) VALUES (?,?,datetime(\'now\'))').run(eid, sid);
  const r = results.buildParticipantRoster(eid);
  assert.equal(r.notStarted[0].questions_answered, 0);
  assert.equal(r.exam.duration_minutes, 45);
});
```

**Step 2: Run the tests to verify they fail**

Run: `node --test test/participant-roster.test.js`
Expected: the first two PASS if Task 1 was correct, but any that fail reveal a real bug in the classification. If all three pass, that is acceptable — the tests are still worth keeping as regression guards, and note in the commit that they passed immediately because Task 1 already satisfied them. If `Ungraded` does NOT sort last, fix the SQL: the `COALESCE(s.final_percentage, -1) DESC` in the `ORDER BY` must also appear in the `ROW_NUMBER` window's `ORDER BY` (it does in Task 1) and the outer `ORDER BY` (it does).

**Step 3: Run the full suite**

Run: `npm test`
Expected: all tests pass, including the pre-existing 225

**Step 4: Commit**

```bash
git add test/participant-roster.test.js src/services/results.js
git commit -m "Cover every recipient exactly once across the four roster sections"
```

---

### Task 3: CSV serialiser with formula-injection escaping

**Files:**
- Modify: `test/participant-roster.test.js`
- Modify: `src/services/results.js`

**Step 1: Write the failing test**

Append:

```js
test('CSV escapes values that a spreadsheet would run as a formula', () => {
  const csv = results.rosterToCsv({
    exam: { id: 1, title: 'Sheet' },
    finished: [{ rank: 1, name: '=cmd|calc!A1', phone: '+233123', final_score: 5, final_percentage: 50, passed: 1, attempt_no: 1, ended_at: '2026-01-01 10:00:00' }],
    inProgress: [],
    notStarted: [],
    notSent: [],
    summary: { finished: 1, inProgress: 0, notStarted: 0, notSent: 0, total: 1 },
  });
  assert.match(csv, /'=cmd\|calc!A1/, 'leading = must be neutralised');
  assert.match(csv, /'\+233123/, 'leading + must be neutralised');
});

test('CSV row order matches the ranked array', () => {
  const roster = {
    exam: { id: 1, title: 'Ordered' },
    finished: [
      { rank: 1, name: 'First', phone: '1', final_score: 9, final_percentage: 90, passed: 1, attempt_no: 1, ended_at: '' },
      { rank: 2, name: 'Second', phone: '2', final_score: 6, final_percentage: 60, passed: 1, attempt_no: 1, ended_at: '' },
    ],
    inProgress: [], notStarted: [], notSent: [],
    summary: { finished: 2, inProgress: 0, notStarted: 0, notSent: 0, total: 2 },
  };
  const csv = results.rosterToCsv(roster);
  assert.ok(csv.indexOf('First') < csv.indexOf('Second'), 'rows must follow the ranked order');
});
```

**Step 2: Run to verify failure**

Run: `node --test test/participant-roster.test.js`
Expected: FAIL with `TypeError: results.rosterToCsv is not a function`

**Step 3: Write minimal implementation**

Add to `src/services/results.js`:

```js
// A leading =, +, - or @ makes Excel/LibreOffice evaluate the cell, so a
// student named "=cmd|..." would run on open. Prefixing an apostrophe forces
// text without changing what a human reads.
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function rosterToCsv(roster) {
  const lines = [];
  lines.push(csvCell(roster.exam.title));
  lines.push('Generated,' + csvCell(new Date().toISOString()));
  lines.push('');

  const head = 'Position,Name,Phone,Score,Percentage,Result,Attempt,Finished At';
  const row = (r, withRank) => [
    withRank ? r.rank : '',
    r.name, r.phone,
    r.final_score === null || r.final_score === undefined ? '' : r.final_score,
    r.final_percentage === null || r.final_percentage === undefined ? '' : r.final_percentage,
    r.passed ? 'Pass' : 'Fail',
    r.attempt_no || '',
    r.ended_at || '',
  ].map(csvCell).join(',');

  const section = (title, rows, withRank) => {
    lines.push(csvCell(title));
    if (!rows.length) { lines.push('(none)'); lines.push(''); return; }
    lines.push(head);
    for (const r of rows) lines.push(row(r, withRank));
    lines.push('');
  };

  section('Finished (ranked by percentage)', roster.finished, true);
  section('In Progress', roster.inProgress, false);
  section('Not Started', roster.notStarted, false);
  section('Not Sent', roster.notSent, false);

  // BOM so Excel opens UTF-8 names (accents, non-Latin) correctly.
  return '\uFEFF' + lines.join('\r\n');
}
```

Add `rosterToCsv` and `csvCell` to `module.exports`.

**Step 4: Run to verify pass**

Run: `node --test test/participant-roster.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add test/participant-roster.test.js src/services/results.js
git commit -m "Add CSV export with spreadsheet formula-injection escaping"
```

---

### Task 4: The three routes

**Files:**
- Modify: `src/routes/api.js` (insert after the existing `router.get('/exams/:id', ...)` block, which is well after the `router.use` auth guard at line 81)

**Step 1: Write the routes**

```js
// ── Participant roster: screen, CSV, print ──────────────────────────────
router.get('/exams/:id/participants', (req, res) => {
  const roster = results.buildParticipantRoster(req.params.id);
  if (!roster) return res.status(404).json({ error: 'Exam not found' });
  res.json(roster);
});

router.get('/exams/:id/participants.csv', (req, res) => {
  const roster = results.buildParticipantRoster(req.params.id);
  if (!roster) return res.status(404).send('Exam not found');
  const safe = String(roster.exam.title).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'exam';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="participants-${safe}.csv"`);
  res.send(results.rosterToCsv(roster));
});

router.get('/exams/:id/participants/print', (req, res) => {
  const roster = results.buildParticipantRoster(req.params.id);
  if (!roster) return res.status(404).send('<h1>Exam not found</h1>');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(results.rosterPrintHTML(roster));
});
```

**Step 2: Verify the route ordering is safe**

Run: `Select-String -Path "src/routes/api.js" -Pattern "auth.verifyAdmin"`.

Expected: the guard is at line 81, and the three new routes are below it. If a new route landed above line 81 it would be **unauthenticated** — fix that before continuing. Route order matters here because `/exams/:id/participants.csv` must not be swallowed by a generic `/exams/:id` handler; Express matches exact segments, so the more specific paths are fine, but confirm the new routes are registered after the guard.

**Step 3: Smoke-test with the server running**

Run: `node src/server.js` in one terminal. In another:

```powershell
# no token -> 401 proves the guard applies
Invoke-WebRequest -Uri "http://localhost:10000/api/exams/1/participants" -UseBasicParsing | Select-Object StatusCode
```

Expected: 401 Unauthorized.

**Step 4: Commit**

```bash
git add src/routes/api.js
git commit -m "Add participant roster JSON, CSV and print routes behind the admin guard"
```

---

### Task 5: Standalone print page

**Files:**
- Modify: `test/participant-roster.test.js`
- Modify: `src/services/results.js`

**Step 1: Write the failing test**

Append:

```js
test('print HTML carries a repeating header and print pagination rules', () => {
  const html = results.rosterPrintHTML({
    exam: { id: 1, title: 'Print Me', duration_minutes: 30, pass_percentage: 50, status: 'live' },
    finished: [{ rank: 1, name: 'Alpha', phone: '233', final_score: 8, final_percentage: 80, passed: 1, attempt_no: 1, ended_at: '2026-01-01 10:00:00' }],
    inProgress: [{ name: 'Beta', phone: '234', questions_answered: 3, started_at: '2026-01-01 10:00:00' }],
    notStarted: [{ name: 'Gamma', phone: '235', questions_answered: 0 }],
    notSent: [{ name: 'Delta', phone: '236' }],
    summary: { finished: 1, inProgress: 1, notStarted: 1, notSent: 1, total: 4 },
  });
  assert.match(html, /<style>/, 'must be self-contained with inline CSS');
  assert.match(html, /@page/, 'needs a page size and margins');
  assert.match(html, /@media print/, 'needs print rules');
  assert.match(html, /<thead>/, 'headers must repeat across pages');
  assert.match(html, /Print Me/, 'exam title must be visible');
  assert.ok(!/<script/i.test(html), 'print page must not need JavaScript');
  assert.ok(!/class="btn/.test(html), 'no app chrome on the print page');
});
```

**Step 2: Run to verify failure**

Run: `node --test test/participant-roster.test.js`
Expected: FAIL with `TypeError: results.rosterPrintHTML is not a function`

**Step 3: Write minimal implementation**

Add to `src/services/results.js`:

```js
const htmlEsc = (v) => String(v === null || v === undefined ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// A standalone page: no app CSS, no JS, no buttons. The browser's own print
// dialog handles the rest, and "Save as PDF" is one click from there. That
// avoids a PDF dependency and the table-pagination bugs they bring.
function rosterPrintHTML(roster) {
  const pct = (r) => (r.final_percentage === null || r.final_percentage === undefined ? '—' : `${r.final_percentage}%`);
  const esc = htmlEsc;

  const table = (title, head, body) => `
    <section>
      <h2>${esc(title)} <span class="count">(${body.rows})</span></h2>
      ${body.rows === 0 ? '<p class="empty">None</p>' : `
      <table>
        <thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${body.html}</tbody>
      </table>`}
    </section>`;

  const finishedHtml = roster.finished
    .map((r) => `<tr><td>${esc(r.rank)}</td><td>${esc(r.name || '—')}</td><td>${esc(r.phone)}</td><td>${esc(r.final_score ?? '—')}</td><td>${esc(pct(r))}</td><td class="${r.passed ? 'pass' : 'fail'}">${r.passed ? 'Pass' : 'Fail'}</td><td>${esc(r.attempt_no || '')}</td><td>${esc(r.ended_at || '')}</td></tr>`)
    .join('');

  const simple = (list) => list
    .map((r) => `<tr><td>${esc(r.name || '—')}</td><td>${esc(r.phone)}</td><td>${esc(r.questions_answered ?? 0)}</td><td>${esc(r.started_at || 'Not started')}</td></tr>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Participants — ${esc(roster.exam.title)}</title>
<style>
  @page { margin: 14mm; }
  * { box-sizing: border-box; }
  body { font: 12px/1.45 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #111; margin: 0; padding: 18px; }
  h1 { font-size: 19px; margin: 0 0 2px; }
  .meta { color: #555; font-size: 11px; margin-bottom: 12px; }
  .totals { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 2px solid #111; }
  .totals div { font-size: 11px; }
  .totals b { display: block; font-size: 17px; }
  h2 { font-size: 13px; margin: 18px 0 6px; text-transform: uppercase; letter-spacing: .04em; }
  h2 .count { color: #666; font-weight: normal; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
  thead { display: table-header-group; }
  th, td { border: 1px solid #ccc; padding: 5px 7px; text-align: left; }
  th { background: #f2f2f2; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; }
  tr { page-break-inside: avoid; break-inside: avoid; }
  .pass { color: #0a7d33; font-weight: 600; }
  .fail { color: #b42318; font-weight: 600; }
  .empty { color: #777; font-style: italic; margin: 4px 0 0; }
  section { page-break-inside: auto; }
  @media print { body { padding: 0; } }
</style></head><body>
<h1>${esc(roster.exam.title)} — Participants</h1>
<div class="meta">Generated ${esc(new Date().toLocaleString())} &middot; Pass mark ${esc(roster.exam.pass_percentage ?? '—')}% &middot; Duration ${esc(roster.exam.duration_minutes ?? '—')} min</div>
<div class="totals">
  <div><b>${roster.summary.finished}</b>Finished</div>
  <div><b>${roster.summary.inProgress}</b>In progress</div>
  <div><b>${roster.summary.notStarted}</b>Not started</div>
  <div><b>${roster.summary.notSent}</b>Not sent</div>
  <div><b>${roster.summary.total}</b>Total recipients</div>
</div>
${table('Finished — ranked by percentage',
  ['#', 'Name', 'Phone', 'Score', 'Percentage', 'Result', 'Attempt', 'Finished at'],
  { rows: roster.finished.length, html: finishedHtml })}
${table('In progress', ['Name', 'Phone', 'Answered', 'Started'], { rows: roster.inProgress.length, html: simple(roster.inProgress) })}
${table('Not started (full time still available)', ['Name', 'Phone', 'Answered', 'Started'], { rows: roster.notStarted.length, html: simple(roster.notStarted) })}
${table('Not sent', ['Name', 'Phone', 'Answered', 'Started'], { rows: roster.notSent.length, html: simple(roster.notSent) })}
</body></html>`;
}
```

Add `rosterPrintHTML` and `htmlEsc` to `module.exports`.

**Step 4: Run to verify pass**

Run: `node --test test/participant-roster.test.js`
Expected: PASS

**Step 5: Manually check the print preview**

Run: `node src/server.js`, get an admin token, open `/api/exams/1/participants/print` in a browser with the token as a header (or temporarily log the HTML to a file and open it). Confirm in the print preview that headers repeat on page 2 and no row is split across pages.

**Step 6: Commit**

```bash
git add test/participant-roster.test.js src/services/results.js
git commit -m "Add standalone print page with repeating headers and pagination rules"
```

---

### Task 6: The Print and Download CSV buttons in the app

**Files:**
- Modify: `src/public/app.js` (the exam detail roster area around line 705, where the PARTICIPATION SUMMARY card already lives)

**Step 1: Add the fetch-based download and print helpers**

Add near the other helpers in `src/public/app.js`:

```js
// The API authenticates with an Authorization header, so a plain <a href>
// would 401. Fetch with the token, then trigger the download or print from a
// blob. This is the reason these are buttons and not links.
async function fetchBlob(path) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API_BASE + path, { headers });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return await res.text();
}

async function downloadRosterCsv(examId) {
  const btn = document.getElementById('btnRosterCsv');
  if (btn) btn.disabled = true;
  try {
    const text = await fetchBlob(`/api/exams/${examId}/participants.csv`);
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `participants-exam-${examId}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('Could not download the roster: ' + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function printRoster(examId) {
  try {
    const html = await fetchBlob(`/api/exams/${examId}/participants/print`);
    const w = window.open('', '_blank');
    if (!w) { alert('Allow pop-ups for this site to print the roster.'); return; }
    w.document.write(html);
    w.document.close();
    // Let the document lay out before opening the print dialog.
    setTimeout(() => { w.focus(); w.print(); }, 400);
  } catch (err) {
    alert('Could not open the print view: ' + err.message);
  }
}
```

**Step 2: Add the participants card to the exam detail view**

Insert immediately before the existing `PARTICIPATION SUMMARY` card in the exam detail renderer (the `totalR > 0 ?` block around line 705):

```js
${roster ? `
<div class="card" style="margin-top:14px">
  <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
    <h3 style="margin:0">PARTICIPANTS <span class="gr">ROSTER</span></h3>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      <button class="btn btn-ghost" id="btnRosterPrint" onclick="printRoster(${id})">${I.print} Print / Save PDF</button>
      <button class="btn btn-ghost" id="btnRosterCsv" onclick="downloadRosterCsv(${id})">${I.download} Download CSV</button>
    </div>
  </div>
  <div class="row" style="margin-top:10px;gap:16px;flex-wrap:wrap">
    <div><b>${roster.summary.finished}</b> <span class="muted">Finished</span></div>
    <div><b>${roster.summary.inProgress}</b> <span class="muted">In progress</span></div>
    <div><b>${roster.summary.notStarted}</b> <span class="muted">Not started</span></div>
    <div><b>${roster.summary.notSent}</b> <span class="muted">Not sent</span></div>
  </div>
  ${roster.finished.length ? `
  <div class="table-card" style="margin-top:12px"><table>
    <thead><tr><th>#</th><th>Name</th><th>Phone</th><th>Score</th><th>Percentage</th><th>Result</th><th>Attempt</th><th>Finished</th></tr></thead>
    <tbody>
      ${roster.finished.map((r) => `<tr>
        <td>${r.rank}</td>
        <td>${esc(r.name || '—')}</td>
        <td>${esc(r.phone)}</td>
        <td>${esc(r.final_score ?? '—')}</td>
        <td>${r.final_percentage ?? '—'}${r.final_percentage !== null && r.final_percentage !== undefined ? '%' : ''}</td>
        <td><span class="${r.passed ? 'pass' : 'fail'}">${r.passed ? 'Pass' : 'Fail'}</span></td>
        <td class="muted">${esc(r.attempt_no || '')}</td>
        <td class="muted">${esc(r.ended_at || '')}</td>
      </tr>`).join('')}
    </tbody>
  </table></div>` : '<p class="muted" style="margin-top:10px">No participant has finished this exam yet.</p>'}
  ${roster.inProgress.length ? `
  <h4 style="margin:16px 0 6px">In progress</h4>
  <div class="table-card"><table>
    <thead><tr><th>Name</th><th>Phone</th><th>Answered</th><th>Started</th></tr></thead>
    <tbody>${roster.inProgress.map((r) => `<tr><td>${esc(r.name || '—')}</td><td>${esc(r.phone)}</td><td>${esc(r.questions_answered ?? 0)}</td><td class="muted">${esc(r.started_at || '')}</td></tr>`).join('')}</tbody>
  </table></div>` : ''}
  ${roster.notStarted.length ? `
  <h4 style="margin:16px 0 6px">Not started — full ${esc(roster.exam.duration_minutes ?? '')} minutes still available</h4>
  <div class="table-card"><table>
    <thead><tr><th>Name</th><th>Phone</th><th>Sent</th></tr></thead>
    <tbody>${roster.notStarted.map((r) => `<tr><td>${esc(r.name || '—')}</td><td>${esc(r.phone)}</td><td class="muted">${esc(r.sent_at || '')}</td></tr>`).join('')}</tbody>
  </table></div>` : ''}
  ${roster.notSent.length ? `
  <h4 style="margin:16px 0 6px">Not sent</h4>
  <div class="table-card"><table>
    <thead><tr><th>Name</th><th>Phone</th></tr></thead>
    <tbody>${roster.notSent.map((r) => `<tr><td>${esc(r.name || '—')}</td><td>${esc(r.phone)}</td></tr>`).join('')}</tbody>
  </table></div>` : ''}
</div>` : ''}
```

**Step 3: Load the roster alongside the exam**

In the exam detail loader (around `src/public/app.js:606`, where `const data = await api(...)` runs), add the roster fetch. Keep it non-fatal so a roster failure never blanks the whole exam page:

```js
const data = await api(`/api/exams/${id}`);
let roster = null;
try { roster = await api(`/api/exams/${id}/participants`); } catch (_) { roster = null; }
```

Then pass `roster` into the template renderer alongside the existing `recipients` / `results` variables.

**Step 4: Ensure the icon keys exist**

Run: `Select-String -Path "src/public/app.js" -Pattern "I = \{|print:|download:"`.

Expected: if `I.print` or `I.download` is undefined, either add those two keys to the icon object or drop the `${I.print} ` / `${I.download} ` prefixes from the markup. An `undefined` in the DOM renders the literal text "undefined", so check the rendered button, not just the console.

**Step 5: Verify in the browser**

Run: `node src/server.js`, sign in as admin, open an exam that has recipients. Confirm:
- both buttons appear above the roster
- **Download CSV** saves a file that opens in Excel with the four sections in order
- **Print / Save PDF** opens a clean page with no app chrome
- an exam with no participants shows counts of zero and no broken tables

**Step 6: Commit**

```bash
git add src/public/app.js
git commit -m "Add Print and Download CSV buttons with the ranked participants roster"
```

---

### Task 7: Full verification

**Step 1: Run the whole suite**

Run: `npm test`
Expected: all pass. Baseline before this feature is 225, so expect 225 + 7 = 232.

**Step 2: Confirm the new routes are guarded**

Run:

```powershell
Select-String -Path "src/routes/api.js" -Pattern "auth.verifyAdmin|participants" | ForEach-Object { "$($_.LineNumber): $($_.Line.Trim())" }
```

Expected: the guard line number is **less than** every `participants` route line number.

**Step 3: Confirm no secrets are staged**

Run: `git status --porcelain`
Expected: only the intended source and test files, never `.env`.

**Step 4: Push**

```bash
git push origin main
```

---

## Notes for the implementer

- **Do not add an npm dependency.** The print page is deliberately browser-native. If you find yourself wanting `puppeteer` or `jspdf`, that is a sign a task step has drifted.
- **Do not add a migration.** The design uses only existing columns.
- **`dist/index.html`** is a build artifact. Check `package.json` for a build script before editing anything under `dist/`.
- **The auth header is the easiest thing to break.** If the buttons stop working with 401, check that `fetchBlob` sends `Authorization` and that the buttons call it instead of navigating.
- If `ROW_NUMBER()` is rejected by the bundled SQLite build, fall back to selecting all sessions and choosing the best attempt in JavaScript — but keep the same output shape so no test changes.
