# Design: Exam Delivery, Watermark, UI, and AI-Grading Fixes

Date: 2026-08-08
Status: Approved (design review)
Project: La_Exam (Node.js >= 22, CommonJS, `node:test`, no new dependencies)

## Context

Five issues reported from production use of the deployed app:

1. **WhatsApp exam ends early** — a session stopped at question 35 with more than
   5 minutes remaining. Investigation (confirmed with the user): the exam's
   database actually contained only 35 questions ("Number of questions: 35" was
   shown in the intro); the theory questions that were supposed to be on the
   paper were never present. The bot finalized correctly because it ran out of
   questions — but two latent weaknesses made this worse and are worth fixing.
2. **"DOWNLOADED FROM SRONU papers.sronu.com" bubble** — a watermark line from
   the imported PDF was preserved by the AI extraction and attached as a
   passage/instruction, so it was sent as its own WhatsApp bubble (once, before
   question 11), appearing "vertically arranged".
3. **Repeated objectives/theory instructions** — user clarification: the
   "repeat" was the same SRONU watermark line, not section instructions. The
   existing banner-once/passage-once delivery logic already prevents section
   instruction duplication; a regression test will pin this.
4. **White/blank boxes in the app** — on both the Questions and Marking Scheme
   tabs, empty or placeholder-stuffed cards/tables take space and look bad.
5. **Answers pending admin review** — theory marking failures and objective
   questions with no stored answer key were flagged `needs_review=1` and
   reported to the student as "N answer(s) pending review by your administrator."
   In the observed run, 20 of 35 answers were unscored (score 42.9%). The user
   wants the AI to grade everything — acting as a genuine, sincere, objective
   professional teacher/examiner with 40+ years of experience — with no admin
   involvement.

## Goals

1. Make sessions deliver every question the exam actually has, even when
   question order has gaps (deleted questions) or the question pool is smaller
   than the exam's question set; and surface when a PDF import extracts far
   fewer questions than the document contains.
2. Remove watermark/source/download lines (e.g. "DOWNLOADED FROM SRONU
   papers.sronu.com", URLs, "Source: ...") from imported PDF content and from
   WhatsApp delivery, including for already-imported exams.
3. Keep the banner-once / passage-once delivery behavior and prove the
   watermark never repeats across bubbles.
4. Remove empty/placeholder white boxes from the Questions and Marking Scheme
   tabs of the admin app.
5. Eliminate "pending review by administrator": the AI (upgraded examiner
   persona) determines the correct answer for objectives without a stored key
   and grades theory answers robustly with retries; on final failure, award
   0 marks with an explanatory note instead of flagging for admin review.

## Non-goals

- Re-importing existing exams (send-time sanitization cleans them in place).
- Changing the certificate/results format (it correctly reflects the score; the
  reported "42.9% / fail" was caused by unscored pending answers).
- Removing the small `source` badge (`pdf`/`ai`) on question cards (user said
  the only real watermark is SRONU).
- Database schema changes. No new dependencies.

## Constraints

- No new dependencies; no DB schema changes.
- Fixes must benefit already-imported exams at delivery time.
- Do not change `formatExamIntro`, the AI-detection caution flow, or marking
  scheme generation logic beyond persona/prompt text.
- All existing tests must stay green (28/28 at plan start).

---

## Section 1 — Exam ending early (sessions must present the full exam)

### 1a. Advance by sequence position, not `q_order + 1`

**File:** `src/services/exam.js`, `processAnswer` (~lines 473-486).

Currently the next question is looked up as `getSessionQuestion(session.id,
question.q_order + 1)`. If any question in the middle was deleted, its `q_order`
slot is gone and the session stops early even though later questions exist.

Change: advance by position in `sessionQuestionSequence(session)`:

- Build the sequence, find the current question by `id`, and take the next
  entry; if there is no next entry, finalize.
- If the current question is not found in the sequence (should not happen),
  fall back to the old `q_order + 1` lookup so behavior degrades gracefully.

### 1b. Top up the session draw when the pool is smaller than the exam

**File:** `src/services/exam.js`, `drawSessionQuestions` (~lines 81-92),
`getSessionQuestion` (~99-115), `sessionQuestionSequence` (~122-140).

`drawSessionQuestions` currently draws `shuffle(pool).slice(0, n)` where
`n` = `COUNT(questions)`. When `pool.length < n`, sessions present fewer
questions than the exam lists. Change:

- `drawSessionQuestions`: if the pool has fewer than `n` entries, top up with
  the exam's template questions (from `questions`, excluding any already in the
  pool), shuffled, until `n` rows are drawn.
- `getSessionQuestion` (mapped path): a drawn `question_id` may now reference
  either a `question_pool` row or a template `questions` row. Resolve from the
  pool first; on miss, resolve from `questions` by id; stamp `q_order` with the
  session order either way.
- `sessionQuestionSequence` (drawn path): resolve each drawn `question_id`
  from the pool OR the questions table so topped-up template questions appear
  in the sequence in session order (this keeps banner/passage-once dedup
  correct for them).

The results queries in `src/services/results.js` already join
`session_questions` to both `question_pool` and `questions`
(`p.id IS NULL` fallback), so topped-up template questions are already handled
there.

### 1c. PDF import completeness warning

**Files:** `src/services/pdfImport.js` (~lines 114-120) and `src/services/ai.js`
`splitIntoBlocks` / `extractQuestionsFromText`.

After extraction, estimate the number of questions the document contains by
counting question-number patterns (`/^\s*\d{1,3}\s*[.)]/gm` over lines, taking
the max distinct number / count). If `parsed.length` is well below that
estimate (e.g. less than half), persist a human-readable warning on the job
(e.g. `warning: "Extracted 35 questions, but the document appears to contain
~60. Some questions (often the theory section) may have been missed."`). The
job API already returns job rows; the frontend upload dialog will display the
warning when the job completes.

### 1d. Tests

- Sequence advance continues across a deleted-question gap (unit, regression).
- Pool top-up: exam with 5 template questions and a 3-question pool draws 5;
  session order is contiguous; topped-up questions resolve to template rows.
- Completeness warning helper returns null when counts match and a message
  when the document estimate far exceeds the extracted count.

---

## Section 2 — Strip watermark / source / download lines

### 2a. New sanitizer `stripSourceWatermarks(text)`

**File:** `src/services/exam.js` (near `stripPaperOnlyInstructions`) or a small
shared util. Behavior:

- Split into lines. Drop a whole line (case-insensitive) when it matches any of
  these precise, safe patterns (a standalone footer/watermark line):
  - contains `www.`, `http://`, or `https://`; or
  - contains `sronu` (or any `XYZ papers.XYZ` site); or
  - matches `/downloaded\s+(from|by)|source\s*[:=]|visit\s+(us\s+)?at\b/i`; or
  - is entirely a bare domain: `/^[a-z0-9][a-z0-9-]*\.(com|org|net|gh|edu|co)\b/i`.
- "papers" alone never triggers removal (it appears in legitimate prose); it
  only matters as part of a matched domain (`papers.sronu.com` is caught by the
  `sronu` / bare-domain rules).
- Collapse runs of 2+ newlines to a single newline and trim (fixes the
  "vertically arranged" whitespace the SRONU line showed).
- Must NOT remove legitimate content: a passage sentence that merely mentions
  a website or "source" mid-sentence survives; only standalone watermark/footer
  lines are removed.

### 2b. Apply at three layers

1. **Extraction prompt** — `src/services/ai.js` `extractQuestionsFromText`
   system prompt (~lines 407-418): add an explicit rule: "Never copy watermark,
   source, or download lines (e.g. 'Downloaded from sronu.com', 'Source:
   www.example.com') into text, passage, or instructions. Always drop such
   footer/header lines."
2. **Import time** — `src/services/pdfImport.js`: run `stripSourceWatermarks`
   on every extracted question's `text` and `passage` before inserting
   (~lines 159-220), so stored data is clean for future deliveries.
3. **Send time** — `src/services/exam.js` `buildQuestionBubbles` (~line 212):
   apply `stripSourceWatermarks` to the passage (in the same step as
   `stripPaperOnlyInstructions`) so already-imported exams are cleaned
   immediately, without re-importing. Also apply when computing the
   "already sent" comparison so dedup uses the cleaned text.

### 2c. Tests

- `stripSourceWatermarks` unit tests: the SRONU line (including a
  vertically-arranged one-word-per-line variant), a URL footer, a "Source:"
  line, a legitimate passage mentioning a website (survives), and newline-run
  collapse.
- Bubble-level test: `buildQuestionBubbles` output for a question whose passage
  contains a watermark contains no `sronu`/URL lines.

---

## Section 3 — No repeated section instructions

The banner-once and passage-once logic in `buildQuestionBubbles` already
deduplicates. Add a regression test:

- Two questions in a sequence share the same instruction-laden passage → the
  passage (and its watermark-free form) is emitted exactly once across the
  bubbles for both questions.

---

## Section 4 — Remove white/blank boxes in the app

### 4a. Questions tab — `src/public/app.js` `qitemHTML` (~lines 636-655)

The same comprehension passage is stored on every question of a group, so each
card renders a full passage box. Change the questions-tab renderer
(`renderTab`, ~line 556-564) to track the previous question's passage and pass
it to `qitemHTML`:

- First question with a passage → render the `.qpassage` box as today.
- Later questions whose passage exactly equals the previous one → render a
  compact muted line instead: `↳ same passage as above` (no big box).
- Empty passage → no box (already the case).

### 4b. Marking Scheme tab — `src/public/app.js` `schemeHTML` (~lines 657-681)

Render each block only when it has content:

- "Model answer:" paragraph only when `scheme.model_answer` is non-empty.
- Key points `<ul>` only when `key_points` has entries.
- Rubric table only when `rubric` has rows (removes the empty
  `<tr><td colspan="3">—</td></tr>` filler).
- "Presentation: X · Grammar: Y" only when either value is non-zero.
- When nothing remains to show for a question, render no `.scheme` box at all.

### 4c. Tests

- These are static frontend template changes; covered by manual/visual
  verification in the smoke test (no frontend test harness exists in the repo).

---

## Section 5 — AI grading with no admin involvement

### 5a. Shared examiner persona

**File:** `src/services/ai.js`.

Add a shared constant, e.g. `EXAMINER_PERSONA`:

> "You are a genuine, sincere, objective professional teacher and chief
> examiner with more than 40 years of experience, deeply well-versed in
> national examinations (including the Ghana BECE). You grade fairly, honestly,
> and consistently: you give full credit where it is due, partial credit for
> partially correct work, and no credit only where nothing was earned. You
> never mark down out of strictness or mark up out of sympathy."

Prepend/append it to the system prompts of:
- `markTheory` (~line 922)
- `answerObjectiveQuestions` (~line 712)
- `verifyObjectiveAnswers` (~line 808)
- `generateTheoryScheme` (~line 668)
- the new `resolveObjectiveAnswer` (5b)

### 5b. New AI call: `resolveObjectiveAnswer`

**File:** `src/services/ai.js`.

Signature: `resolveObjectiveAnswer({ questionText, passage, options })`.
Single-question call returning `{ correct_index, explanation }`; `correct_index`
is `-1` when the examiner is not certain. Uses the existing answer-batch timeout
constants, temperature ~0.1, and one retry. Options passed as `0. text` lines
(like `answerObjectiveQuestions`).

### 5c. Objective answer-time resolution — `src/services/exam.js` `handleAnswer`

Replace the "No answer key stored — flagged for review" branch (~lines 498-509):

1. If `marking.resolveCorrectKey(question)` is null:
   - Call `ai.resolveObjectiveAnswer` with question text + passage + options.
   - On a valid `correct_index` (0..options.length-1): resolve the option key
     letter and persist it on the question's own row so results and future
     answers use it: `UPDATE question_pool SET correct_answer = ? WHERE id = ?`
     when `question._pool` is true, otherwise
     `UPDATE questions SET correct_answer = ? WHERE id = ?`. (For template
     questions, also refresh the matching `marking_schemes` objective scheme.)
     Then mark the student's answer with the existing `markObjective` path and
     record `marked_by='ai'`.
   - On `-1` or on an AI error (after the retry): award `0`, `marked_by='ai'`,
     `needs_review=0`, `ai_feedback` = a neutral note ("The examiner could not
     determine the answer to this question.").
2. Normal path (key exists) unchanged.

No answer is ever inserted with `needs_review=1` by the objective branch again.

### 5d. Robust theory marking — `src/services/exam.js` `markAllPendingTheory`

- Wrap each `marking.markTheoryAnswer` call with one automatic retry (wait
  ~1s between attempts), matching the pattern used by AI answer batches.
- On final failure, replace the current `'manual'`/`needs_review=1` update with
  `marked_by='ai'`, `marks_awarded=0`, `needs_review=0`, `ai_feedback` = an
  explanatory note ("The examiner could not mark this answer; 0 marks were
  recorded."). Never leave it pending.
- Keep the AI-copied detection cap behavior unchanged.

### 5e. Results message

**File:** `src/services/results.js` (~lines 108-111). The "pending review by
your administrator" line stays as a safety net but will no longer fire in the
normal flow (nothing sets `needs_review=1` anymore).

### 5f. Tests

- Unit: objective branch calls the AI resolver when no key is stored; marks and
  persists the resolved key; on `-1`/error records 0 with `needs_review=0`.
- Unit: `markAllPendingTheory` records 0 / `needs_review=0` after a final AI
  failure (mock `markTheoryAnswer` to throw twice).
- Keep existing AI-detection and marking tests green.

---

## Design decisions (confirmed with the user)

- Objective fallback when the AI cannot determine an answer: **0 marks with a
  neutral note** (never pending review).
- The app's `source` badge is retained (not part of this change).
- Existing exams are cleaned at delivery time; no re-import required.
- The abrupt-end report was caused by a genuinely 35-question exam; the fixes
  in Section 1 make sessions robust to gaps/pool sizing and make incomplete
  imports visible, but they cannot invent missing theory questions for an
  already-created exam — the admin must add those questions (or re-import).

## Verification

- `npm test` (all existing + new unit tests) green.
- `node --check` on all touched files.
- Manual smoke: upload a PDF containing a watermark footer → confirm no
  watermark bubble, one banner, one passage bubble, questions uninterrupted;
  answer objective/theory questions → results show all answers scored, no
  "pending review" line.
