# Design: Exam AI Integrity & Delivery Enhancements

Date: 2026-08-07
Status: Approved

## Summary

Five changes to the What Exam WhatsApp examination system:

1. AI objective answers are strictly correct (generate + self-verify).
2. AI-copied theory answers are detected, the student is cautioned immediately and again in the final result, and the copied answer earns 0 marks.
3. Every WhatsApp question message carries a bold Objective/Theory header.
4. Theory answers are stored silently during the exam and ALL theory questions are marked together when the exam ends; the final WhatsApp result includes a per-theory-question mark breakdown.
5. Objective questions default to 40 unless the admin chooses otherwise; PDF uploads keep every question.
6. Passages & section instructions (English / Ghanaian Language / French) are preserved and shown with their questions.
7. Marking schemes found in an uploaded PDF are used.

## 1. AI strictly correct objective answers

- Harden the `answerObjectiveQuestions` prompt (PDF fill-in) so answers must be objectively correct and unambiguous.
- Add a self-verification pass: a second AI call re-checks every generated answer against its question and options. Answers the AI cannot confirm are returned with `correct_index = -1` and are NOT stored as guesses.
- In `pdfImport`, an unverifiable answer leaves `correct_answer` NULL; the question is marked for admin review.
- Harden the `generateQuestions` prompt so every objective `correct_index` is guaranteed correct and unambiguous.
- In the live exam, an objective question with no stored correct answer is marked `needs_review = 1` instead of being marked wrong.

## 2. AI-copied theory answer detection

- New `ai.detectAiGeneratedAnswer({ questionText, studentAnswer })` — a lightweight call that returns `{ ai_generated, ai_reason }`.
- When a theory answer is submitted during the exam, detection runs inline:
  - If detected, the student is cautioned IMMEDIATELY over WhatsApp, `ai_detected = 1` is stored, and the answer will earn 0 marks.
  - The next question is sent regardless (no normal per-answer feedback).
- `markTheory` (end-of-exam marking) also returns `ai_generated`/`ai_reason`. If either inline detection or end marking flags the answer, marks are capped at 0 and `ai_detected = 1`.
- The final result message repeats the caution for every flagged answer.
- Schema: `answers.ai_detected INTEGER NOT NULL DEFAULT 0` (migration via `ensureColumn`).

## 3. WhatsApp bold type header

- `formatQuestion` renders `*QUESTION N — OBJECTIVE*` or `*QUESTION N — THEORY*` as a bold header line on every question message.

## 4. Theory answers: next question; all marked at the end

- During the exam a theory answer is stored with `marked_by = 'pending'` and 0 marks; the next question is sent immediately. No per-answer AI marking latency.
- At the end (`finalize`, and `endExam`), `exam.markAllPendingTheory(sessionId)` AI-marks every pending theory answer (with cheating detection) concurrently, then results are computed.
- `sendResultMessage` gains a per-theory-question breakdown (`Q6. 3/5`, `Q7. 0/5 ⚠️ AI-copied`).

## 5. Objective default = 40

- The AI-generation form replaces the single "Number of questions" with "Number of objective questions" (default 40) and "Number of theory questions" (default 5).
- `generateQuestions` accepts explicit `objectiveCount`/`theoryCount` (falls back to the old even split when absent).
- PDF upload keeps ALL questions from the PDF, objectives included (no truncation). Locked by a regression test.

## 6. Passages & instructions

- Extend `CONTEXT_START` in `ai.js` with French instruction patterns (e.g. "Lisez le passage", "Répondez à toutes les questions", "Lisez attentivement").
- Passages already render in WhatsApp questions, the admin dashboard, and the report page.

## 7. PDF marking schemes

- `pdfImport` saves an imported theory scheme whenever ANY of `model_answer` / `key_points` / `rubric` is present (currently requires both model answer AND key points).
- The extraction prompt is fed any "MARKING SCHEME" / "marking guide" / "suggested answers" section found in the document, alongside the answer key, so rubric/model answers on the paper are reused instead of regenerated.

## Files touched

- `src/db.js` — `ai_detected` column (schema + migration)
- `src/services/ai.js` — strict prompts, self-verify pass, `detectAiGeneratedAnswer`, `markTheory` ai_generated, French context patterns, marking-scheme section detection
- `src/services/marking.js` — pass-through of ai_generated/aiReason
- `src/services/exam.js` — bold type header, pending theory answers, inline detection + caution, end-of-exam marking
- `src/services/results.js` — per-theory breakdown + AI-copy cautions in result message and report
- `src/routes/api.js` — generate endpoint objective/theory counts; answers PATCH clears `ai_detected`
- `src/services/pdfImport.js` — save partial schemes; honour self-verified answers; keep all questions
- `src/public/app.js` — AI-gen form counts (objective default 40); results view AI-detected badge
- `test/regression.test.js` — regression tests

## Behaviour notes

- Detection is conservative: when unsure, `ai_generated = false` (benefit of the doubt — never accuse a genuine student).
- AI marking failures never block the exam: the answer is flagged `needs_review`.
- Objective questions with a NULL correct answer are flagged for review, never marked wrong.
