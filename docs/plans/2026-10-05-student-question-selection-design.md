# Student Question Selection ("Answer Any N of M") — Design

Date: 2026-10-05

## Problem

An uploaded exam paper can carry its own selection instruction — *"Answer any FOUR
(4) questions from Section B"*, *"Questions 1 and 2 are compulsory"*, *"Answer ALL
the questions in Section A"*. Today the platform cannot express any of this:

- There is **no** `is_compulsory` concept and **no** per-section structure anywhere
  in `src/db.js`.
- Every question is delivered, in order, and the exam only ends when the list is
  exhausted (`drawSessionQuestions`, `src/services/exam.js:267`; `sendQuestionTo`,
  `src/services/exam.js:755`). "Answer 4 of 6" is not representable.
- The PDF importer preserves instruction text verbatim into the first question's
  `passage` field (`src/services/ai.js:1546`) but never converts it into a rule.
- The grader divides by `SUM(max_marks) FROM answers`
  (`src/services/results.js:11`) — only what was answered. A student who answers 4
  of 6 is scored out of 4 marks' worth, so **skipping the hard questions raises the
  percentage**. The same bug rewards any student who runs out of time early.

Goal: the student chooses which questions to answer, in WhatsApp, from a paper whose
own instructions define the choice — and compulsory questions are not offered as a
choice at all.

## Decisions

| Decision | Choice |
|---|---|
| Scope | Per-section, with an implicit single section when none is detected |
| Source of rules | Auto-detected from the PDF by the import AI; admin can override every value |
| Student UX | Tappable list + confirm buttons; plain-text fallback |
| Max score | Compulsory + quota. Extra answers beyond the quota are discarded |
| Timer | Selection happens inside the timed window |
| Revision | `CHANGE` allowed until the first answer is recorded, then locked |
| When | Just in time, at the section boundary — not up front |
| Admin control | Per-question `Compulsory` toggle + per-section quota |
| PDF path | Import must follow the paper's own instruction lines |

## Approach

An **additive selection layer**: a new `src/services/selection.js` owns everything
quota-shaped (rule resolution, selector rendering, reply parsing, commit), and
`exam.js` calls into it at seams that already exist.

Rejected alternatives:

- **Rewriting the session engine around a section cursor.** Conceptually cleaner,
  but it would rewrite the most crash-sensitive code in the repo — the
  write-intent-to-outbox-before-send invariant documented at `src/services/exam.js:837`
  — to add a feature that is additive, not corrective. Regression risk outweighs the
  tidier mental model.
- **Admin-only rules.** Drops the requirement that PDF upload follow the paper's own
  instruction lines.

## 1. Data model

Six additive changes, all backward-compatible.

```sql
-- questions and question_pool (both)
ALTER TABLE questions    ADD COLUMN is_compulsory INTEGER NOT NULL DEFAULT 1;
ALTER TABLE questions    ADD COLUMN section_key   TEXT    NOT NULL DEFAULT '';
ALTER TABLE question_pool ADD COLUMN is_compulsory INTEGER NOT NULL DEFAULT 1;
ALTER TABLE question_pool ADD COLUMN section_key   TEXT    NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS exam_sections (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id      INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  section_key  TEXT    NOT NULL,        -- stable slug, matches questions.section_key
  title        TEXT    DEFAULT '',     -- "SECTION B"
  instructions TEXT    DEFAULT '',     -- the paper's verbatim line, shown to the student
  position     INTEGER NOT NULL DEFAULT 0,
  answer_count INTEGER NOT NULL DEFAULT 0,  -- 0 = answer all, no selector
  UNIQUE(exam_id, section_key)
);
CREATE INDEX IF NOT EXISTS idx_exam_sections_exam ON exam_sections(exam_id, position);

ALTER TABLE questions        ADD COLUMN is_compulsory   INTEGER NOT NULL DEFAULT 1;
ALTER TABLE questions        ADD COLUMN section_key     TEXT    NOT NULL DEFAULT '';
ALTER TABLE questions        ADD COLUMN source_number   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE question_pool    ADD COLUMN is_compulsory   INTEGER NOT NULL DEFAULT 1;
ALTER TABLE question_pool    ADD COLUMN section_key     TEXT    NOT NULL DEFAULT '';
ALTER TABLE sessions         ADD COLUMN selection_state   TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions         ADD COLUMN selection_section TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions         ADD COLUMN selection_tentative TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions         ADD COLUMN paper_total REAL NOT NULL DEFAULT 0;
ALTER TABLE session_questions ADD COLUMN is_selected INTEGER NOT NULL DEFAULT 1;
ALTER TABLE session_questions ADD COLUMN section_key   TEXT    NOT NULL DEFAULT '';
```

`is_compulsory` defaults to `1`, so every pre-existing question is compulsory and
every pre-existing exam behaves exactly as it does today.

`selection_state` has **no `locked` value**. "Has this section already been chosen?"
is derived from the committed `session_questions.is_selected` rows for that section,
not stored. A single state column cannot represent two selective sections in one
paper, so the derived check is the only correct formulation.

`selection_tentative` holds provisional ticks as a JSON array of session `q_order`s.
`is_selected` is the committed answer and is written only by a commit, so a student
who taps two questions and then goes quiet has silently deselected nothing.

`source_number` stores the number printed on the paper. Import assigns `q_order` by
insertion order, so `q_order` diverges from the printed number the moment a block is
dropped or merged — anything that matches the paper's own numbering must use
`source_number`, never `q_order`.

### The `is_selected DEFAULT 1` guarantee

`session_questions.is_selected` defaults to `1`. `nextInSequence`
(`src/services/exam.js:387`) filters on it, but a paper with no rules never sets it
to `0`, so the filter removes nothing and delivery is unchanged. This is what makes
the whole feature opt-in without a data migration.

### Derived rules

No rule state is duplicated — a section's behaviour is computed from the questions
plus one row:

- **Selective** iff `exam_sections.answer_count > 0` **and** the section holds at
  least one non-compulsory question.
- **Selectable pool** = the section's non-compulsory questions.
- Delivery is one filtered pass over the section in paper order. Compulsory
  questions stay in that order and interleave with the chosen ones wherever they
  fall — a compulsory question sitting after two optional ones is delivered after
  them. The selector is raised when the sequence first reaches a non-compulsory
  question of a selective section, not as a single block before the section.
- `answer_count >= pool size` ⇒ treated as answer-all. The selector would be a
  no-op, so it is suppressed rather than shown.
- `section_key = ''` everywhere ⇒ an implicit single section, which is never
  selective.

`topUpPool` (`src/services/exam.js:298`) and the AI generator
(`src/routes/api.js:784`) copy `is_compulsory` and `section_key` from the template
row, so pool draws inherit the rules. AI-generated pool questions default to
compulsory and ungrouped — the safe fallback.

## 2. Reading the rule out of the PDF

`extractQuestionsFromText` (`src/services/ai.js:1472`) calls the model per block,
gets `{ questions: [...] }` back, and **flattens every block into a single array of
questions**. There is no envelope object and no sibling `selection` key. So the rule
is requested **per question**, in the shape the pipeline already returns, and the
section rules are derived by grouping. A second AI call would be a new dependency
edge for no gain.

```
Theory/Objective object, per question:
  "number":      7,                // the number printed on the paper
  "section":     "SECTION B",     // the heading verbatim; "" if the paper has none
  "compulsory":  true,             // true ONLY if the paper forces this question
```

```
- SELECTION: "compulsory" is true ONLY for questions the document itself forces.
  A question that merely sits in a section with a limit is NOT compulsory — do not
  mark it true because it shares a section with compulsory questions.
- SECTION: "section" is the heading verbatim, or "" when the paper has none.
  Grouping by this value is how the platform reconstructs sections, so it must be
  consistent across every question of the same section.
```

`pdfImport.js` persists `number` as `questions.source_number` (it was previously
discarded) and `section` as `questions.section_key`, then reconciles:

1. **Group** the extraction by `section`, slugging the heading. A group whose
   questions never landed in the database is skipped and reported.
2. **Match on the printed number**, never on `q_order`. Match compulsory questions
   through `source_number`; a claimed number that was never extracted is reported and
   dropped, because under-forcing is recoverable and pointing at the wrong question
   is not.
3. **Write `is_compulsory` in both directions** — `1` for forced questions and `0`
   for the rest of the section. The column defaults to `1`, so a reconciliation that
   only ever *forces* questions leaves the whole pool compulsory, the selectable pool
   computes to zero, and every quota silently clamps to answer-all.
4. **Clamp** `answer_count` to the real pool size. A count that clamps down to the
   pool size leaves the section non-selective, so it is delivered in full — the
   clamp and the answer-all rule in §1 compose deliberately rather than
   accidentally.
5. If nothing survives, **write no rule at all.** The exam stays exactly as it is
   today.

A rule is stored per section; `is_compulsory` is set on each question of that section.

## 3. Chat flow

### 3a. Where the selector slots in

Two seams in `exam.js`, both on existing code paths:

**Entering a section** — in `advanceAndSend` (`src/services/exam.js:848`) and
`sendQuestionTo`, before sending question X:

```js
if (selection.needsChoice(session, X.section_key)) {
  await sendSelector();              // sets selection_state='selecting',
  return;                            // selection_section=X.section_key
}
```

**Answering while selecting** — the first branch of `processAnswer`
(`src/services/exam.js:1073`):

```js
if (session.selection_state === 'selecting') {
  await selection.handleReply(session, student, body, meta);
  return;                            // never falls through to handleAnswer
}
```

A section of all-compulsory questions — typically the objective block — therefore
flows through completely untouched. The selector only ever appears at a section
boundary.

The intro (`formatExamIntro`, `src/services/exam.js:646`) gains a line stating the
rule, e.g. `Section B: you must answer 3 of 5 questions.`

### 3b. Messages sent

For Section B, quota 3, pool of 5, one compulsory:

```
*SECTION B*

Instructions: Answer any THREE (3) questions from this section.

🔒 Q1 is compulsory — you will answer it.
Tap the questions you want to answer, then confirm.
You must choose exactly 3.
```

then an **interactive list** — one row per optional question, `id` =
`sel:<sectionKey>:<n>`, title truncated to WhatsApp's 24-character row-title cap —
then **buttons** `[ Confirm selection ]`.

Both helpers already exist: `sendInteractiveList` and `sendInteractiveButtons`
(`src/services/whatsapp.js:216`).

### 3c. Reply protocol

| Input | Behaviour |
|---|---|
| list row tap | toggle that question, persist, ack `✓ Added Q4 — 2 of 3 chosen.` |
| `CONFIRM` / Confirm tap | count **must equal** the quota → commit; otherwise error + re-prompt |
| `2,4,5` / `2 4 5` / `2.4. 5.` | set exactly those; over-quota rejected, under-quota flagged |
| `CHANGE` | reopens — only while the session has **no answers recorded** |
| anything else | `I didn't catch that. Tap questions, or reply like 2,4,5.` + re-send selector |

### 3d. Text fallback

Used when a section has more than 10 optional questions (WhatsApp's list-row cap) or
when the interactive send throws. Same protocol minus the list: one text bubble of
numbered, truncated stems and `Reply with the numbers, e.g. 2,4,5`.

### 3e. Ordering

`drawSessionQuestions` and `sessionQuestionSequence` currently hard-sort
objective-first-then-theory (`src/services/exam.js:285`, `src/services/exam.js:374`).
New rule:

- **No selective section on the exam** → byte-identical to today.
- **Selective section present** → order by section position, then paper order
  within the section.

This is the one place the feature genuinely conflicts with existing behaviour, and
it is why the fallback matters: papers without a quota keep their current ordering
exactly.

### 3f. Commit and the CHANGE window

The choice is written to `session_questions.is_selected` and `sessions.paper_total`
**before** the first selected question is sent, so a crash after commit loses
nothing — the student simply re-confirms on their next message.

The message outbox is deliberately **not** used for selection. Its
`UNIQUE(session_id, question_id, kind)` key (`src/services/outbox.js:18`) cannot
express "the same section selected twice", and the selector is idempotently
re-renderable, so the outbox would buy nothing while adding a failure mode.

The timer keeps running throughout selection.

### 3g. Resume, expiry and abandonment

**Resume mid-selection.** A server restart leaves `selection_state='selecting'` on
disk with no pending send. Every resume path — `maybeStartSession`
(`src/services/exam.js:1000`) and the invite-reply branch of `handleInbound`
(`src/services/exam.js:933`) — must check `selection_state` before calling
`sendQuestionTo` and re-render the selector instead. This is a fourth seam, and it
is the one that makes the feature survive the outage the outbox exists for.

**Expiry.** `finalizeStaleSessions` (`src/services/exam.js:1598`) and the deadline
check in `handleInbound` treat `selection_state='selecting'` as an ordinary
in-progress session. Expiry mid-selection finalizes normally: no questions were
selected, so only compulsory answers exist and they are graded against the
`paper_total` set at session start.

## 4. Grading

The denominator must be **frozen**, or an admin editing a question's marks tomorrow
silently changes a student's percentage today.

`computeForSession` (`src/services/results.js:8`) changes from
`SUM(max_marks) FROM answers` to `sessions.paper_total`:

| Moment | `paper_total` set to |
|---|---|
| session starts, no selection configured | Σ marks of all drawn questions |
| selection committed | Σ compulsory drawn + Σ marks of the **selected** drawn |
| selection re-committed after `CHANGE` | recomputed from the new selection |
| answer to a non-selected question | excluded, contributes 0 |

`paper_total` is **immutable once the first answer is recorded** — that is what
"locked" means in §3c, and it is why `CHANGE` is refused from that point on. A
re-commit before that point rewrites it.

Freezing at session start also closes the pre-existing skip-the-hard-questions
exploit: a student who times out after question 4 of 6 is now charged for all 6.

**This changes historical percentages for unfinished attempts** — previously
denominated only by what was answered. It is the correct exam behaviour, and it is
called out here because it is a visible change to past numbers, not only to future
ones.

`markAllPendingTheory` (`src/services/exam.js:1418`) needs no change: only delivered
questions ever receive an `answers` row. The report page, certificate and roster all
read `computeForSession`, so they inherit the new denominator without modification.

## 5. Admin UI

- **Per question:** a `Compulsory` checkbox and a `Section` select on the existing
  add/edit form (`qitemHTML`, `PUT /exams/:id/questions/:qid`). Unticking Compulsory
  on the theory questions is the entire "only theory is selectable" workflow.
- **Per section:** a *Selection rules* card on the exam page — one row per detected
  section showing the paper's verbatim instruction and an
  `Answer any [N] of these [M]` input.
- **Edit Exam modal** (`editExamMeta`, `src/public/app.js:1947`): a rule summary line.
- **API:** `PATCH /exams/:id/sections` for bulk rule upsert; `is_compulsory` and
  `section_key` accepted by the existing question POST and PUT.

## 6. Testing

New `test/question-selection.test.js` and `test/selection-rules.test.js`, using the
`timer-start.test.js` harness (temp DB, stubbed `whatsapp.sendText`).

1. **Back-compat** — an exam with no rules produces byte-identical messages to today.
   This is the `is_selected DEFAULT 1` guarantee, and it is the first test to fail
   if the feature leaks into the default path.
2. The selector appears at the section boundary, not before the compulsory section.
3. Tap-toggling, text-number parsing, and `CONFIRM` with both under- and over-quota.
4. `CHANGE` works before the first answer and is refused after it.
5. A compulsory question is never selectable and is always delivered.
6. Only selected questions are delivered; unselected ones earn nothing.
7. `paper_total` is correct with and without a selection, is recomputed on
   re-commit, and is immutable after the first answer.
8. Expiry mid-selection finalizes cleanly with no half-open selector, and a resume
   with `selection_state='selecting'` re-renders the selector instead of sending a
   question.
9. More than 10 optional questions falls back to text and still completes.
10. Import reconciliation: phantom question numbers dropped (matched on
    `source_number`, never `q_order`), counts clamped, a dropped block still leaves
    the right question compulsory, and an extraction with no section data writes no
    rule at all.

## Non-goals

- Nested or weighted section hierarchies.
- Extra-credit for questions beyond the quota (explicitly discarded).
- Randomising which questions a student may choose from.
- Retroactive recomputation of `paper_total` for sessions that already have one.