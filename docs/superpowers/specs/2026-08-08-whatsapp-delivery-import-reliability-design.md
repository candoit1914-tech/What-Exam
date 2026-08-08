# Design: WhatsApp Delivery Polish + Import Reliability

Date: 2026-08-08
Status: Approved (design review)
Project: La_Exam (Node.js >= 22, CommonJS, `node:test`, no new dependencies)

## Context

Issues reported from production use of the deployed app:

1. **PDF import drops questions** — a paper with 40 objectives + 4-6 theory
   questions (with a marking scheme) imported as only 35 objectives and no
   theory. Live reproduction: the extraction step splits the paper into
   question-aligned blocks; each block is one AI call. A block that fails
   (network `fetch failed` on the NVIDIA endpoint under concurrency) is
   *silently skipped* (`ai.js` block runner), losing every question in that
   block. With a marking scheme appended, the theory section spans 3 blocks,
   and one failing block wipes the whole theory section.
2. **Questions "halfly displayed"** — a student sees a question cut off and
   can't answer it. `whatsapp.js` has no message-size guard; a question or
   passage bubble over WhatsApp's 4,096-character hard limit is not delivered
   complete. Questions can also be *stored* truncated when a block's JSON
   output hits `BLOCK_MAX_TOKENS` (3000) and the model stops mid-question.
3. **Question order** — `drawSessionQuestions` shuffles the pool, so sessions
   present questions in a random order instead of the order they appear in the
   uploaded PDF.
4. **Bubble layout** — section instructions (e.g. "Answer ALL questions", "Your
   answer should be between 250 and 300 words") are stored inside the first
   question's `passage` field and are sent jammed together with the passage,
   with the `*OBJECTIVE*`/`*THEORY*` header and the first question, so the chat
   reads cramped. The user wants: header first, then the section instructions,
   then the passage in its own bubble, then the questions, with breathing room.
5. **Results model answers** — the user wants the model answers available in
   the results. Decision (confirmed): the *theory* model answers go in the
   report (printed as PDF), NOT in the WhatsApp message. The WhatsApp results
   message keeps the objective answer key and theory marks as it does today.

## Goals

1. Never lose a question block to a transient endpoint failure: retry failed
   blocks serially, and surface a warning when a block still cannot be parsed.
2. Guarantee no WhatsApp message is ever cut off: split long messages under the
   4,096-char limit.
3. Deliver the paper in the exact PDF order to every student.
4. Present each section beautifully in the chat: header bubble → section
   instruction bubble → passage bubble → question bubbles, with clear spacing.
5. Report (PDF) shows the model answers for every question, visible by default.

## Non-goals

- Re-importing existing exams (delivery-time fixes benefit them immediately;
  only the import reliability + block-warning changes require a fresh import).
- Changing `formatExamIntro`, the marking/grading flows, or the certificate.
- Adding a server-side PDF generator (the report's existing Print / Save-as-PDF
  button already produces the PDF).
- Changing the WhatsApp results summary (objectives answer key + theory marks
  stay as-is; no theory model answers in WhatsApp).
- New dependencies. No DB schema changes.

## Constraints

- All existing tests must stay green except where the bubble-shape assertions
  are intentionally updated.
- Fixes must be verifiable with unit tests (no live WhatsApp/AI calls in the
  suite; the existing pattern of stubbing `chatJSON` and mocks is followed).

---

## Section 1 — Import reliability: no silently dropped blocks

### 1a. Bump the block output cap

**File:** `src/services/ai.js` (~line 176). `BLOCK_MAX_TOKENS` 3000 → 6000 so a
theory block whose JSON carries `model_answer`, `key_points`, and `rubric`
cannot truncate mid-question (the source-level cause of stored "half" questions).

### 1b. Serially retry failed blocks after the concurrent wave

**File:** `src/services/ai.js`, `extractQuestionsFromText` (~lines 375-534).

Current behavior: each block runs with `BLOCK_RETRIES` (2) retries on its own
clock at `BLOCK_CONCURRENCY` (4); on final failure the block returns `null` and
is skipped at the settle loop (~line 507).

Change:

- Extract the per-block attempt into a small internal helper `runBlock(blockPrompt)`
  so the concurrent wave and the serial re-run share the same retry loop.
- After the concurrent `mapLimit` wave, collect the indices whose block returned
  `null`. If any exist, re-run exactly those blocks **serially** (a second
  `mapLimit` pass with concurrency 1) with the same per-block retries and
  timeout. A flaky shared endpoint usually succeeds once it is no longer being
  flooded.
- Blocks that still fail after the serial pass are dropped (as today, never
  fail the whole paper) — but this time the caller is told.

### 1c. Surface a warning when a block still fails

**File:** `src/services/ai.js` and `src/services/pdfImport.js` (~line 115).

- `extractQuestionsFromText(rawText, onProgress, onWarning)` gains an optional
  third callback, consistent with the existing `onProgress` pattern. It is
  called with a human-readable message when any block still fails after the
  serial re-run, e.g.
  `"3 question block(s) could not be parsed — some questions may be missing. Retry the upload to recover them."`
- `pdfImport.startJob` passes `onWarning` that merges into the job's `warning`
  field (combining with the existing `completenessWarning` message when both
  fire), so the admin sees it in the upload dialog.

---

## Section 2 — WhatsApp: long messages split, never cut off

**File:** `src/services/whatsapp.js`.

- Add `const MAX_TEXT_LENGTH = 4000;` (safety margin under the 4,096 hard cap).
- Add a pure, exported helper `splitTextChunks(text, maxLen = MAX_TEXT_LENGTH)`:
  - `text.length <= maxLen` → `[text]`.
  - Otherwise split into chunks at newline boundaries wherever possible,
    accumulating lines; a single line longer than `maxLen` is hard-split.
  - Every non-final chunk ends with `…` (continuation marker) and every chunk
    is at most `maxLen` chars.
- `sendText(to, text)` sends each chunk sequentially via the existing low-level
  `api` call with `logOutbound` per chunk, and returns the last response. All
  existing callers (question bubbles, results, notices, intro) inherit the
  protection with no other changes.

---

## Section 3 — Beautiful bubble layout + PDF order

### 3a. Separate section instructions from the passage

**File:** `src/services/exam.js`.

Add a pure, exported helper `splitSectionMeta(text)` returning
`{ instructions, passage }`:

- Split into lines; collect *consecutive leading* instruction-like lines into
  `instructions`; stop at the first non-instruction line; everything after it
  (including any later instruction-ish prose) stays in `passage`. This avoids
  stripping real prose that merely mentions instructions mid-passage.
- An instruction-like line is one matching the existing `INSTRUCTION_START`
  (~line 232) / `INSTRUCTION_PHRASE` (~line 234) patterns, plus section-specific
  phrases: `/between\s+\d+\s+and\s+\d+\s+words/i`, `/question(s)?\s+(\d+\s*(-|to)\s*)?\d+/i`
  (e.g. "answer questions 1 to 5"), and `/in\s+this\s+section/i`.
- Empty input → `{ instructions: '', passage: '' }`.

This works on already-imported exams because section instructions are stored in
the first question's `passage`; no re-import needed.

### 3b. New bubble order in `buildQuestionBubbles` (~lines 253-267)

For each question, emit (all strings exported/pure so tests can pin them):

1. **Header bubble** — once per type, only before the first question of that
   type: `*OBJECTIVE*\n\n━━━━━━━━━━━━━━━━━━━━` (and `*THEORY*` equivalent).
2. **Instruction bubble** — only when the current question is the first of its
   type and `splitSectionMeta` yields instructions:
   `*Instructions*\n\n${instructions}`.
3. **Passage bubble** — only when `splitSectionMeta(...).passage` is non-empty,
   and only once per passage group (dedup by the *split* body, so dedup works
   even after instructions are pulled out): the passage body on its own.
4. **Question bubble** — unchanged: `*QUESTION n*\n\n${stem}`.

`stripPaperOnlyInstructions` + `stripSourceWatermarks` still run on the passage
before splitting (existing cleaning behavior preserved).

### 3c. PDF order in `drawSessionQuestions` (~lines 88-100)

- Replace `shuffle(ids).slice(0, n)` with `ORDER BY id` and `slice(0, n)`.
  Imported questions enter the pool in PDF order, so `id` order == PDF order.
  For imported papers the pool holds exactly the paper's questions, so only the
  order changes (no subsetting).
- Remove the now-unused `shuffle` helper (~lines 70-77).

---

## Section 4 — Results: model answers visible in the report

**File:** `src/services/results.js` `reportHTML` (~lines 200-204).

- Make the theory model-answer block visible by default: `<details class="model"
  open>` (was closed). The print stylesheet already forces `details.model`
  `display:block`, so the Print / Save-as-PDF output already contains the model
  answers; opening on screen simply makes them visible without a click.
- WhatsApp results message (`sendResultMessage`) is unchanged.

---

## Tests (`test/regression.test.js`)

- **Update** the four `buildQuestionBubbles` bubble-shape assertions to the new
  layout (header + instruction + passage + question strings above).
- **New `splitSectionMeta`**: pure instruction ("Answer ONE question in this
  section."), instruction + prose (comprehension fixture line 1 → instructions,
  remaining lines → passage), no instruction (whole text stays a passage),
  instruction-only (passage empty).
- **New `splitTextChunks`**: short text → one chunk; long text → multiple
  chunks each ≤ 4000 with `…` on non-final; a single over-long line hard-splits.
- **New `drawSessionQuestions` order**: insert three pool rows in a known id
  order, draw, assert `session_questions` q_order maps to ascending pool id.
- **New block retry**: stub `ai.chatJSON` (monkeypatch) so the first block's
  first call throws, then succeeds; assert all questions survive and the serial
  re-run is exercised. A second case where `chatJSON` always throws asserts the
  `onWarning` callback fires.

## Verification

- `node --check` on all touched files.
- `node --test test/regression.test.js` — all green (44 existing, minus updated
  shapes, plus the new tests).
- Manual smoke (deployed): upload the debug paper with a marking scheme → all
  40 objective + theory questions import, no missing-question warning; run a
  session → sections render as header → instructions → passage → questions in
  PDF order; a very long question arrives complete; results → report PDF shows
  model answers.
