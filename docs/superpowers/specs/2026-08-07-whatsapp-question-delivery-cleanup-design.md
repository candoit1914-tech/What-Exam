# WhatsApp Question Delivery Cleanup — Design

Date: 2026-08-07
Status: Approved (design), pending implementation

## Problem

After a PDF import succeeds, questions are delivered to students over WhatsApp.
Today each question is sent in a single chat bubble that mixes three kinds of
content together:

1. The question stem.
2. Any `passage` text on the question — which may be a real reading
   comprehension passage (English Language, Ghanaian Language, French) **or** a
   section instruction copied from the paper ("Answer ALL questions", "Your
   answer should be between 250 and 300 words", "Shade your answer with a
   pencil").
3. A per-question label like `*QUESTION 1 — OBJECTIVE*`.

Observed problems:

- Paper-physical instructions ("shade with a pencil", "write in the answer
  booklet", "do not write in the margin") are copied verbatim from the PDF and
  make no sense in a typed chat — students cannot shade with a pencil, they
  type letters.
- Passages and instructions are glued inside the question bubble.
- There is no section-level "Objective"/"Theory" banner; the type label is
  repeated on every question.

## Goals

1. **Strip paper-only instructions** at send time. Keep real comprehension
   passages and keep useful short instructions (word limits, "Answer ALL/ONE
   question"). Drop only the physical-paper mechanics (shading, booklets,
   margins, ink, rough work, tick/cross/circle/underline-as-marking).
2. **One bold banner per type**: a bold `*OBJECTIVE*` bubble before the first
   objective question, a bold `*THEORY*` bubble before the first theory
   question. Question labels become `*QUESTION N*` (type not repeated).
3. **Passage/instruction on its own bubble**, once, before the first question
   that uses it — never inside the question bubble.

Non-goals: changing the exam intro's own instructions, the options message,
marking/AI logic, or the DB schema.

## Approach

All changes are send-time in `src/services/exam.js`. No schema changes, no
re-import: the behaviour applies to already-imported exams.

### 1. `stripPaperOnlyInstructions(text)`

Sentence-aware cleanup. Splits the text into sentences/lines and drops only
sentences that BOTH read like an instruction AND contain a paper-only keyword.
This protects prose passages that merely mention a paper keyword (e.g. a
comprehension story about a lost pencil is never corrupted).

- Instruction-like signals: imperative start (write/shade/use/tick/cross/
  circle/underline/fill/answer/do not/ensure/remember/…), or phrases like
  "your answer(s)", "answer sheet/booklet", "should be".
- Paper-only keywords: `shade`, `pencil`, `HB`, `answer booklet/sheet/grid`,
  `margin`, `do not write`, `rough work`, `blue or black ink`, `tick`, `cross
  out`, `circle/ring/underline` the answer, `fill in the box/oval`, `question
  paper`.
- Kept: "Your answer should be between 250 and 300 words.", "Answer ALL
  questions in this section.", "Answer ONE question in this section.", real
  passage prose.

### 2. `sessionQuestionSequence(session)`

The ordered list of questions this session presents to the student. For drawn
(pool) sessions read `session_questions` in `q_order`; otherwise the exam's
template questions in `q_order`. Used to derive what the student has already
seen.

### 3. `buildQuestionBubbles(exam, question, sequence, index)`

Returns the ordered list of chat bubbles for a question:

1. Banner — `*OBJECTIVE*` or `*THEORY*`, only when no earlier question in the
   sequence has that type (appears exactly once, before the first of its type).
2. Passage bubble — the stripped passage text, only when no earlier question in
   the sequence carried the same stripped passage (appears exactly once, before
   the first question that uses it).
3. Question bubble — `*QUESTION N*` + stem, no passage, no type suffix.

### 4. `formatQuestion` change

Label becomes `*QUESTION N*` (drops ` — OBJECTIVE/THEORY`). The passage is no
longer inlined into the body (it is emitted as its own bubble by
`buildQuestionBubbles`).

### 5. `sendQuestionTo` wiring

Build the sequence, locate the current question's index, call
`buildQuestionBubbles`, send each bubble via its own `wa.sendText` call (= one
WhatsApp chat bubble), then send the options message as today. Because
"already sent" is derived from questions earlier in the sequence, resume and
admin re-send nudges do not repeat banners or passages.

## Testing

Update in `test/regression.test.js`:

- `formatQuestion` label tests → expect `*QUESTION N*` (no type suffix, no
  inlined passage).
- New `stripPaperOnlyInstructions` tests: paper-only sentences dropped; word
  limits and "Answer ALL/ONE question" kept; prose passage containing the word
  "pencil" kept intact.
- New banner tests: `*OBJECTIVE*` once before first objective, `*THEORY*` once
  before first theory, not repeated.
- New passage-bubble tests: appears once before the first question that uses
  it; absent on later questions.

## Files

- `src/services/exam.js` — new helpers + `sendQuestionTo` wiring.
- `test/regression.test.js` — updated and new tests.
