# Student Bulk Delete, Exam Resend, and Start-on-Engagement Timer — Design

Date: 2026-10-04

## Problem

Three requests:

1. Delete students in bulk, as well as individually.
2. Allow the exam to be resent to students whose exam failed to start.
3. Until a student starts the exam, the timer must not run. If the admin has not
   ended the exam, an unstarted exam must remain intact.

Investigation found that (2) and (3) are **one bug**, not two.

### Root cause

`src/services/exam.js:1768` executes:

```js
db.prepare('UPDATE sessions SET started_at=NULL WHERE id=?').run(session.id);
```

but `sessions.started_at` is declared `TEXT NOT NULL DEFAULT (datetime('now'))`
(`src/db.js:75`, repeated in the rebuild DDL at `src/db.js:274`). SQLite rejects
the write:

```
NOT NULL constraint failed: sessions.started_at
```

The throw is swallowed by the `catch` at `src/services/exam.js:1774`, which
increments `retry_count` and eventually flips the session to `abandoned`. So every
fresh bulk send is recorded as a failure.

The development database corroborates this — 5 sessions, 4 `abandoned`,
1 `expired`, **0 `in_progress`**.

### The timer logic already exists but is unreachable

Three places already handle a NULL `started_at` correctly:

- `deadline()` — `src/services/exam.js:391-394` returns a far-future date.
- `finalizeStaleSessions()` — `src/services/exam.js:1586` filters
  `started_at IS NOT NULL`.
- `maybeStartSession()` — `src/services/exam.js:1021` stamps the clock on
  engagement, guarded by `if (!session.started_at)`.

All of it is dead code, because the column can never be NULL.

## Existing capabilities kept as-is

- Individual student delete: `DELETE /api/students/:id` (`src/routes/api.js:1144`),
  UI at `src/public/app.js:2112` and `:2128`.
- Per-student resume / restart / nudge logic: `sendExamToStudent()`
  (`src/services/exam.js:1726`).
- Bulk initial send: `POST /exams/:id/send` (`src/routes/api.js:440`).
- Bulk result resend: `POST /exams/:id/resend-all` (`src/routes/api.js:1161`).
- Roster/print/export already normalise NULL `started_at` to `''`
  (`src/services/results.js:498`) and render a dash (`:828`, `:953`).

## Section 1 — Schema: make `sessions.started_at` nullable

`src/db.js` — `started_at TEXT NOT NULL DEFAULT (datetime('now'))` becomes
`started_at TEXT` (nullable, default NULL).

SQLite cannot relax `NOT NULL` in place, so this requires a table rebuild. The
file already uses that pattern twice: the sessions rebuild at `src/db.js:263-298`
and the answers rebuild at `src/db.js:350-385`. The new migration follows it:

- Guard on the stored DDL containing `NOT NULL`, so it runs exactly once.
- `PRAGMA foreign_keys = OFF`, `BEGIN`, rebuild `sessions` with the nullable
  column, copy all 13 columns across, `DROP` then `RENAME`, `COMMIT`, restore the
  pragma.
- **Re-create all four session indexes afterwards**: `idx_sessions_exam`
  (`src/db.js:203`), `idx_sessions_exam_student` (`:224`), `idx_sessions_status`
  (`:225`), `idx_sessions_active` (`:320`). The existing rebuild at `:266-293`
  silently loses the first three, because they are created earlier in the file
  than the rebuild that drops the table. This migration will not repeat that.
- No backfill. An existing non-NULL `started_at` means that attempt genuinely
  started, so the value is preserved.

Two INSERTs must then write NULL explicitly, since the column DEFAULT is what was
silently starting the clock:

- `createSession()` — `src/services/exam.js:241`
- `restartSession()` — `src/services/exam.js:697`, so a resend-restart also waits
  for the student

`deadline()` and `finalizeStaleSessions()` then come alive unmodified.

## Section 2 — Bulk student delete

Deliberately alters nothing. Bulk delete reuses the existing individual delete
verbatim, so cascade behaviour stays where it already lives — in the schema
(`ON DELETE CASCADE` at `src/db.js:64`, `:72`, `:86`), not in the route.

### Backend

`POST /api/students/bulk-delete`, body `{ ids: [...] }` → `{ deleted: n }`.

POST rather than DELETE-with-body, which some HTTP clients mishandle. The route is
registered after the auth guard at `src/routes/api.js:99`, so it needs no separate
authorisation. It does not collide with `PATCH`/`DELETE /students/:id`, since
Express matches method and path together.

- Dedupe the ids.
- Run the same `DELETE FROM students WHERE id = ?` per id inside one transaction.
- Unknown ids are silent no-ops, not errors.

A student deleted this way disappears from every exam and their answers go with
them — identical to today's individual delete.

### Frontend

The Students table (`src/public/app.js:2102-2115`) gains a checkbox column and a
select-all in the header. On selection, a toolbar appears above the table with
**"Delete N selected"**, using the same `confirm()` wording shape as the existing
`deleteStudent` (`src/public/app.js:2130`) so the consequence reads identically.

Placement is the Students page because that is where the individual delete already
lives — bulk sits beside it.

## Section 3 — Resend the exam

### Send-time delivery becomes invite-only

`sendExamToStudent()` currently ends by pushing Q1 at send time
(`src/services/exam.js:1772`). That tail is removed.

| Session state on send/resend | Behaviour |
| --- | --- |
| none / `abandoned` / `expired` | `restartSession` → invite only |
| `in_progress`, clock still live | nudge: re-deliver the **current** question (existing `:1738-1760`) |
| `in_progress`, clock lapsed | `restartSession` → invite only |
| `completed` | `skipped` |

Template mode already returned early at `src/services/exam.js:1770`, so it gains
nothing and loses nothing.

### Routes

New `POST /exams/:id/resend`:

- **no body / empty `studentIds`** → auto-target every recipient with no session
  having a non-NULL `started_at`, i.e. invited but never begun
- **`studentIds` given** → exactly those recipients

Both paths reuse the same per-student logic, so a per-row resend of a mid-exam
student nudges rather than restarts.

`POST /exams/:id/send` (the initial blast) becomes invite-only too and keeps its
`status !== 'live'` guard at `src/routes/api.js:443`.

The report keeps the existing `{ sent, failed, skipped, resumed, errors }` shape,
so the existing toast at `src/public/app.js:1669` keeps working.

`sendIntro()` calls `recordAcceptance()` (`src/services/exam.js:1719`), so the
invite still stamps `exam_recipients.sent_at` — `sent_at` means "invite delivered".

### Frontend

- Recipients card (`src/public/app.js:686-695`): a **"Resend to not started (N)"**
  button beside "Send Exam to Recipients".
- Per-row **Resend** on every recipient (`src/public/app.js:715-722`).
- Status column (`src/public/app.js:711-713`) splits today's two states into four:
  `Not sent` / `Invite sent — not started` / `In progress` / `Finished`, driven by
  `sent_at` plus session presence plus `started_at`.

The participation map at `src/public/app.js:666-671` keys on `s.started_at` being
truthy, so it starts reporting "not started" correctly once NULL is reachable.

## Section 4 — Timer lifecycle

`started_at IS NULL` now means **invited, clock not running**. That state is inert
by construction:

- `deadline()` returns a far-future date, so the expiry check cannot fire.
- `finalizeStaleSessions()` filters `started_at IS NOT NULL`, so cleanup never
  touches it.
- The session stays `in_progress` indefinitely — the "exam remains intact"
  guarantee. Only `endExam()` (`src/services/exam.js:1619`) closes it, and it
  already sweeps every `in_progress` session regardless of `started_at`.

Two fixes:

1. **`timeRemaining()`** (`src/services/exam.js:439`) returns `'—'` when
   `started_at` is falsy. Q1 is no longer sent at invite time so this should be
   unreachable, but `new Date('').getTime()` is `NaN` and a `NaN:NaN` must never
   reach a student.
2. **Intro copy.** `formatExamIntro()` (`src/services/exam.js:640`) takes a
   context argument. The blanket *"Your timer starts now."* at `:648` is wrong for
   an invite:
   - invite → **"Reply START to begin — your timer starts the moment you reply."**
   - resume (`maybeStartSession`, `:984` and `:1032`, where the student just
     messaged) → *"Your timer starts now."*

Also normalise `src/services/exam.js:917` from `datetime('now')` to the ISO-8601-Z
form already used at `:929` and `:1022`, so `started_at` is one format everywhere.

## Section 5 — Testing

Setup follows `test/attempts.test.js` (temp DB via `DB_PATH`/`UPLOADS_DIR`/
`DOTENV_CONFIG_PATH` env vars, `SEED_ON_BOOT=false`,
`config.exam.sendCertificates = false`). Stubbing follows
`test/delivery-ledger.test.js` — reassign `wa.sendText`, restore in `finally`.

### `test/timer-start.test.js`

- `createSession` leaves `started_at` **NULL**. This assertion fails today.
- `deadline()` on a NULL-started session returns a far-future date, never `NaN`.
- `finalizeStaleSessions()` leaves a NULL-started `in_progress` session alone,
  while still finalizing a genuinely lapsed one.
- `sendExamToRecipients` on a fresh recipient delivers the **invite only** — no
  question text among the captured sends — and leaves `started_at` NULL.
- First inbound via `handleInbound` stamps `started_at` **and** delivers Q1, which
  is the `src/services/exam.js:916` branch waking up.
- No `NaN:NaN` can reach a student from the timer line.

### `test/exam-resend.test.js`

- Auto-target resend reaches only never-started recipients.
- Per-student resend of a mid-exam student nudges: same session,
  `current_q_order` unchanged, no new attempt.
- Resend of a completed student reports `skipped`.
- Resend of a lapsed `in_progress` session opens a fresh attempt with
  `started_at` NULL.
- Report shape stays `{ sent, failed, skipped, resumed, errors }`.

### `test/student-bulk-delete.test.js`

- All selected students are removed; unselected ones untouched.
- Cascade verified: their `exam_recipients`, `sessions` and `answers` rows are gone.
- Repeated ids are deduped; unknown ids are silent no-ops.

### Full suite

`npm test`. Invite-only send is a real behaviour change.
`test/delivery-ledger.test.js` and `test/regression.test.js` were checked and
neither asserts that a question is pushed at send time, but both are run before
this work is considered done.