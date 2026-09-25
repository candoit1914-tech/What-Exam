# Design: WhatsApp Delivery Integrity, Recipient Dedupe, and Attempt Restarts

Date: 2026-09-25

## Context

Six reported symptoms trace back to twelve concrete defects in one codebase:

- Recipients "don't get the exam in WhatsApp".
- The exam "stops at question N".
- Students who finish are indistinguishable from those who abandon.
- Duplicate numbers become duplicate students.
- There is no way to restart a student who ran out of time.
- Math expressions are still broken on PDF imports.

The two largest causes are missing `.env` values, not code defects:
`WHATSAPP_TEMPLATE_NAME` unset makes `exam.js` fall through to a free-form
send, which Meta rejects with **131026** (no open 24-hour session) for any
recipient who has never messaged the bot; `WHATSAPP_APP_SECRET` unset makes
`webhook.js` return **403 on every inbound POST**, silently discarding every
student reply.

The structural cause behind "stops at question N" and the unusable participation
report is one thing: **session state is committed on intent-to-send, never on
delivery.** Nothing durably records whether a question actually reached the
student.

## Verified defects

| # | Defect | Evidence |
|---|--------|----------|
| 1 | `sent_at` never written — "Didn't start" is unreachable | `db.js:64` declares; 7 reads across `api.js`/`app.js`, **0** writes |
| 2 | Replies silently dropped when `appSecret` missing | `webhook.js:31-34` returns 403 **before** logging to `webhook_events` |
| 3 | No template ⇒ Meta 131026 for cold recipients | `exam.js:1503-1504` |
| 4 | **Advance-before-send** ⇒ silent question skip + mis-grading | `exam.js:841-844` commits `current_q_order` *before* `await sendQuestionTo()` |
| 5 | `false` return counted as `sent++` | `exam.js:1507-1508`; `sendQuestionTo` returns `false` without throwing when the exam is inactive or the question is missing |
| 6 | Retry queue is a comment, not code | `exam.js:1516-1519` says "cleanup cron retries"; `finalizeStaleSessions` only finalizes *expired* sessions and never re-sends |
| 7 | `startsWith('1')` precedes length rules | `exam.js:53`; a 9-digit number starting with `1` becomes a NANP number |
| 8 | "Added N" counts submitted lines, not new students | `api.js:303` `added.push()` runs even when `INSERT OR IGNORE` was ignored |
| 9 | A duplicate line overwrites the student's **global** name | `api.js:297-299` |
| 10 | Split on `[\n,]+` only | `app.js:1309`; no `;`, tab, or whitespace |
| 11 | `image` column dropped on question insert | `api.js:648-655` lists 12 columns, omitting `image` |
| 12 | `getOrCreateStudent` is read-then-write outside a transaction | `exam.js:72-79`; a concurrent duplicate raises `SQLITE_CONSTRAINT_UNIQUE` and fails the whole bulk import |

### Defect 4 in detail

`processAnswer` commits the next question pointer, then awaits the send:

```js
db.prepare(`UPDATE sessions SET current_q_order = ?, last_active_at = datetime('now') WHERE id = ?`)
  .run(nextQ.q_order, session.id);
await sendQuestionTo(session, student);   // may throw
```

If the send throws (rate limit **131056** after all retries, 15s timeout, 5xx),
the session has advanced to Q(N+1) while the student never saw it. Their next
reply is graded against **Q(N+1)'s** answer key. This is a silent question-skip
*and* a scoring corruption, and it matches the reported "exam stops" exactly.

## Goals

1. A question pointer may only advance after the question was **accepted by
   Meta**, never before.
2. A failed or dropped send must be **recoverable without admin action**.
3. The participation report must be **derived from durable facts**, not inferred.
4. One normalized phone number = one student, with honest counts and explicit
   name-conflict resolution.
5. Any student can be restarted, with **full attempt history** preserved.
6. The math pipeline must **stop failing silently**.

## Non-goals

Deliberately excluded from this change:

- **Animations.** WhatsApp's Cloud API cannot render arbitrary animation.
  Deferred by explicit instruction; the closest platform-native equivalents
  (interactive cards, reactions, carousels) are a separate future piece.
- Animated landing page / `advert/` Remotion work.
- Rendering math images in the dashboard, reports, or certificates.
- Inline linearized math (`3/4`, `x²`, `√16`) for hand-typed or AI-generated
  questions.
- Changing the existing math *delivery* mechanism on WhatsApp, which works.

## Design

### 1. Delivery ledger

A new `message_outbox` table records every *logical send unit* — the intro, and
each question as a whole — written **before** the network call:

```sql
CREATE TABLE message_outbox (
  id           INTEGER PRIMARY KEY,
  exam_id      INTEGER NOT NULL,
  session_id   INTEGER,                          -- null for intro-only rows
  student_id   INTEGER NOT NULL,
  question_id  INTEGER,                          -- null for intro
  kind         TEXT NOT NULL,                    -- 'intro' | 'question'
  status       TEXT NOT NULL DEFAULT 'queued',   -- queued|sent|delivered|failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at      TEXT,
  delivered_at TEXT,
  UNIQUE(session_id, question_id, kind)
);
CREATE INDEX idx_outbox_recover ON message_outbox(status, kind);
```

`UNIQUE(session_id, question_id, kind)` is the idempotency key: re-sending a
question updates the same row instead of appending a duplicate. This removes
the "Q1 keeps repeating" class of bugs at the schema level.

**Send-then-commit** replaces advance-before-send everywhere:

```
1. INSERT OR IGNORE outbox (status='queued') for (session, question, 'question')
2. attempt the network send
3. success -> status='sent', sent_at=now
             THEN commit current_q_order = next question
4. failure -> attempts++, last_error, remain 'queued'
```

A **recovery pass** selects `queued` rows whose session is still `in_progress`
and whose deadline has not passed, re-sends them, and commits the advance on
success. Because the pointer only moves after `sent`, a failed send leaves the
student parked on the question they have not answered rather than skipping it —
and the next pass heals it.

`exam_recipients.sent_at` is written when Meta **accepts** the first outbound
message for that (exam, student). Acceptance, not the admin's click, is the
honest definition of "sent".

### 2. Participation status

Derived from the ledger, `sessions`, and `answers`:

| Status | Rule |
|--------|------|
| `not_delivered` | outbox `failed`, or `sent` with no `delivered` callback |
| `didnt_start` | `sent_at` set **and** `answers = 0` |
| `didnt_finish` | `0 < answers < total`, session not `completed` |
| `stopped_at` | as `didnt_finish`, reporting `N = ` last answered `q_order` |
| `completed` | session `status = 'completed'` |

"Didn't start" therefore means *Meta accepted the message and the student never
answered* — a bad number is distinguishable from an ignoring student, because
the two differ in whether a `delivered` callback arrived.

### 3. Recipients

**Normalization** (`normalizePhone`) is fixed so length rules run *before* the
bare-`1` rule:

1. Strip non-digits, drop a leading `+`, collapse a `00` prefix.
2. Ghana: 10 chars starting `0` ⇒ `233` + rest; 9 chars ⇒ `233` + raw.
   Local: 10 chars starting `2` ⇒ kept.
3. NANP: 11 chars starting `1` ⇒ kept. **A 9- or 10-digit number starting `1`
   is no longer hijacked into NANP.**
4. Any other length ⇒ rejected with an explicit reason.

**Splitting** accepts `[\n,;\t]+` and whitespace; every token is validated, and
invalid tokens are reported rather than silently mangled.

**Dedupe** is explicit, in one transaction, over an ordered map keyed by
normalized number:

- New number ⇒ insert student, link recipient.
- Existing number ⇒ merge; `INSERT OR IGNORE` no longer inflates counts, and
  `added` increments only on a real change.
- Both names non-empty and different ⇒ recorded as a **name conflict** and
  surfaced to the admin for resolution. The global name is never silently
  overwritten.
- A pre-existing name always wins, so importing exam 2 can never rename a
  student on exam 1.

The response becomes `{ added, merged, conflicts[], invalid[] }` and drives a
review step in the UI before the send button is enabled.

Wrapping the whole import in a single transaction also removes defect 12.

### 4. Attempts and restart

`sessions` becomes one row per **attempt**:

- Add `attempt_no INTEGER NOT NULL DEFAULT 1`.
- Replace `UNIQUE(exam_id, student_id)` with `UNIQUE(exam_id, student_id, attempt_no)`.
- Add a partial index guaranteeing one active attempt per exam/student:
  `CREATE UNIQUE INDEX idx_session_active ON sessions(exam_id, student_id) WHERE status = 'in_progress';`

`restartSession` stops mutating the existing row. It **closes** the current
attempt (`status = 'superseded'`, preserving its score and answers) and **opens**
a new session with `attempt_no + 1` and a fresh question draw. History therefore
survives restarts rather than being deleted.

New endpoints, each with a per-student and a bulk variant:

- `POST /api/sessions/:id/restart` — close the attempt, open a new one, re-send.
- `POST /api/sessions/:id/extend` — add N minutes to the same attempt, no new
  attempt, no position change. Answers a "stuck at the last question" student
  without discarding their work.
- `POST /api/exams/:id/restart-all` — bulk restart.

Restarts are capped by a per-exam `max_attempts` setting, **default unlimited**.

### 5. Math: instrument, then fix

The pipeline fails silently at four independent points: the LLM in the middle
must preserve literal `[MATH:n]` tokens; the `qs[0]` fallback mis-attaches an
image to the block's first question; render failures are swallowed; and
detection only unions glyphs sharing a font, missing expressions whose
numerator and denominator come from different fonts.

Rather than guess, the import job returns diagnostics surfaced in the job
result panel and the log:

```js
mathDiagnostics: {
  expressionsDetected, markersEmitted, markersPreservedByLlm, markersDropped[],
  rendersOk, rendersFailed: [{ idx, error }], unattached: [],
  misAttached: [{ idx, questionId, reason }],
}
```

That identifies the actual break, which is then fixed specifically. Defect 11
(the dropped `image` column) is fixed immediately as an independent bug.

### 6. Config self-check and setup checklist

`config.selfCheck()` returns missing or placeholder values — template name, app
secret, token, verify token — with the exact Meta navigation path for each and
a redacted display. A dashboard banner surfaces the result, so the two
403/131026 causes become visible within seconds of boot instead of silently
costing every student their exam.

Secrets are entered by the operator and are never read, logged, or displayed
in full by the application.

For the missing app secret specifically, per decision: the webhook **keeps
returning 403** (unsigned webhooks are never accepted, so spoofed answers stay
impossible), but every rejection is written to `webhook_events`, counted, and
surfaced on the dashboard banner.

## Data migration

Additive, with one table rebuild:

1. Create `message_outbox` and its indexes.
2. Rebuild `sessions` to drop `UNIQUE(exam_id, student_id)`, add `attempt_no`,
   and add the partial active-attempt index. Existing rows get
   `attempt_no = 1`.
3. Add `max_attempts` to `exams`, defaulting to unlimited.
4. **Backfill `sent_at` is deliberately not attempted** — historical delivery
   is unknowable, and inventing it would be worse than leaving it NULL. The
   report treats NULL as `not_delivered` with a clear label.
5. Existing `in_progress` sessions have no outbox rows, so the first recovery
   pass re-sends their current question — which is the desired self-heal for
   exams already frozen by defect 4.

## Testing

**Unit** — `normalizePhone` against a table of formats (including the
`123456789` regression case); recipient splitting and dedupe/merge/conflict
resolution; outbox state transitions; participation-status derivation;
attempt numbering and the active-attempt invariant.

**Integration** — a failing send must leave `current_q_order` **unchanged**; the
recovery pass must re-send and then commit; a restart must open a new attempt
and leave the previous attempt's answers and score intact; a concurrent
duplicate import must not half-apply.

**Regression** — the six existing math-flow tests in `test/pdf-images.test.js`
plus new cases for the dropped `image` column and the diagnostics payload.

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| The sessions rebuild loses data | Rebuilt inside a transaction; row counts and checksum verified before commit; a backup is taken first |
| Re-sending on recovery annoys students | Recovery only touches `queued` rows — never a `sent` one — so a student who already received a question is not messaged again |
| The recovery pass sends to a student who already answered | The pass re-reads the session pointer and skips any outbox row whose question is already answered |
| The ledger grows unbounded | Rows are retained for report accuracy; add a retention sweep for `sent` rows older than the exam's archival window |
| `sent_at` stays NULL for historical exams | Reported as `not_delivered` with a clear label rather than fabricated |

## Rollout order

1. Migration (additive + `sessions` rebuild + backfill).
2. Outbox, send-then-commit, and the recovery pass.
3. `sent_at` writes and the participation report.
4. Recipient normalization, dedupe, and conflict resolution.
5. Attempts, restart, and extend endpoints.
6. Math diagnostics, then the specific fix they identify.
7. Config self-check, dashboard banner, and setup checklist.

Each stage is independently deployable and independently testable, so a failure
in a later stage never blocks the fixes that came before.

## Open questions

None blocking. Deferred to the implementation stage:

- Retention window for `sent` outbox rows.
- Whether `Extend Time` should also be available to students on request.
- Exact UI for resolving name conflicts (inline in the recipients table vs. a
  modal).
