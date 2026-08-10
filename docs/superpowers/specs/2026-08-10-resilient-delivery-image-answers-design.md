# Resilient Delivery & Image Answers Design

Date: 2026-08-10
Status: Approved (user: "Sure")
Repo: What-Exam (La_Exam)
Branch: main

## Problem

Four behaviors are missing or partial in the current exam flow:

1. **Written/drawn theory answers**: a student answering a theory question by
   sending a WhatsApp *photo* (handwritten work or a drawing) is ignored — the
   webhook only processes text messages, so the answer is dropped and the exam
   stalls waiting for a reply.
2. **Theory sections that open with a passage**: papers where the theory
   section starts with a passage/introduction question (e.g. "Read the case
   study below" / Section B lead-in text) do not reliably carry that PDF text
   onto the theory questions, so students miss context that came from the
   uploaded PDF.
3. **Abrupt exam stops**: if the server restarts mid-exam, in-progress
   sessions whose deadline has passed are never finalized — they stay stuck in
   `in_progress` forever, and the student never receives the report or
   certificate for the answers they did give.
4. **Watermarked PDFs**: watermark/footer lines are stripped from text, but
   nothing formally guarantees clean content proceeds to WhatsApp; behavior
   should be "ignore watermarks and proceed" — never block delivery.

## Scope

1. Accept a written (photo) or drawn answer for **theory** questions via
   WhatsApp, attempt AI vision grading, fall back to manual review; surface
   the image in the dashboard and the student report.
2. Carry a theory-section passage from the uploaded PDF onto the following
   theory questions, using the same rule already applied to
   reading-comprehension groups.
3. On server startup, finalize every session still `in_progress` past its
   deadline: compute the report, generate the certificate, send the WhatsApp
   result — with whatever answers were collected. Unanswered questions score 0.
4. Watermarks: detect and **strip** watermark/footer lines at import (as
   today) and proceed with normal delivery — no blocking, no skipping of
   diagrams.

## Non-goals (explicitly deferred)

- Voice notes, documents, or video as theory answers (images only).
- Student-side answer editing/retraction outside the existing flow.
- Image answers for objective questions (objective answers must be a letter).
- Digital-signature or human verification of photo answers.
- Detecting *visual* watermarks baked into diagram pixels (out of reach with
  the current text-based stack).

## Context (current pipeline)

- **Webhook** (`src/routes/webhook.js`): verifies signature, acknowledges
  immediately, then `wa.parseWebhook(body)` → `examService.handleInbound(phone,
  text, ev)`. `parseWebhook` (`whatsapp.js:269`) reads only `m.text.body` and
  interactive replies — image messages have no body, so they are skipped
  (`if (ev.type !== 'message') continue; if (!bodyText) continue;`). The
  Media endpoint (`GET /v21.0/{mediaId}`) is NOT used anywhere today — no
  download capability exists yet.
- **`answers` table** (`db.js:83`): `answer_text TEXT NOT NULL`, plus
  `ai_detected`, `marks_awarded`, etc. `ensureColumn` migrator exists; a
  legacy-FK migration already rebuilt `answers` once and must be preserved.
- **AI client** (`src/services/ai.js`): text-only `messages` (string content,
  `{role, content}`). Vision (content arrays with `image_url`) is NOT
  supported by `callEndpoint`; a capability flag is needed so text-only
  providers skip vision and go straight to manual review.
- **Sessions** (`db.js:73`): status `in_progress|completed|expired|abandoned`.
  `exam.js:562` finalizes on timer expiry; the timer check is in-memory, so a
  server restart orphans `in_progress` sessions.
- **finalize** (`exam.js:893`): computes result, sends WhatsApp result,
  builds token-gated report; certificate is best-effort ("never break the
  finalize flow").
- **Passages** (`pdfImport.js:204-216`): `curPassage` carry-forward exists for
  extraction groups ("Reading-comprehension papers share one passage across a
  run of questions… Theory and objective questions are saved together in
  document order"); theory questions DO receive `passage` when the parser
  returns one, but nothing verifies theory-section lead-ins survive.
- **Watermarks** (`textClean.js`): `stripSourceWatermarks` drops only
  standalone lines matching `sronu|downloaded (from|by)|source:|visit us at`
  plus URL-only lines. Applied to question text and passages at import.

## Approach

### Feature 1 — Written/drawn answers for theory (WhatsApp photos)

1. **Webhook media download** (`src/services/whatsapp.js`):
   - `parseWebhook` gains `type: 'image'` events: for `m.type === 'image'`,
     return `{ type: 'message', phone, messageId, timestamp, mediaType:
     'image', mediaId: m.image?.id, body: m.image?.caption || '' }`.
   - New `downloadMedia(mediaId)` → `GET
     https://graph.facebook.com/v21.0/{mediaId}` with the access token (the
     Graph API redirects to the media URL; follow it) → returns a Buffer.
   - Add `downloadMedia` to `module.exports`.

2. **Webhook route** (`webhook.js`): for image events, `bodyText` may be a
   caption (optional). Pass `ev` through to `handleInbound` exactly as today —
   images must not be dropped when a caption is absent.

3. **Exam engine** (`src/services/exam.js` — `handleInbound`):
   - When the session is expecting a **theory** answer and the event is an
     image: `const buf = await wa.downloadMedia(ev.mediaId)` (non-blocking
     errors → the existing "try again" message), save to
     `config.uploadsDir/<sessionId>-<qOrder>-<ts>.png` via `@napi-rs/canvas`
     re-encode (normalizes format; same lib already used by `pdf.js`), store
     the relative filename, and record the answer with `answer_image` set and
     `answer_text = caption || '(photo answer)'`.
   - **Objective** questions: image answers are refused with "Please reply
     with the letter of your answer" (scheme untouched).
   - Grading: a new `markImageAnswer` path in `services/marking.js`:
     provider supports vision → send `{type:'text'} + {type:'image_url',
     image_url:{url:'data:image/png;base64,…'}}` content with the question,
     passage, scheme → marks; provider is text-only or the call fails →
     save the answer with `needs_review` semantics (existing review flow) and
     no marks.
   - **Vision capability flag** (`src/config.js` + `ai.js`): e.g.
     `AI_VISION=true` (default false). `marking.aiSupportsVision()` checks the
     flag; text-only providers skip vision entirely.
   - After recording, the normal "next question or finalize" path runs
     unchanged — an image counts as an answer.

4. **Schema** (`src/db.js`): `ensureColumn('answers', 'answer_image', "TEXT
   DEFAULT ''")`; include `answer_image` in the rewritten-answers migration
   copy list. `answers.answer_text` stays `NOT NULL` (photo answers store the
   caption or `'(photo answer)'`).

5. **Dashboard** (`src/public/app.js`): the answer viewer and results table
   render an `<img>` when `answer_image` is set, served through an
   admin-token-gated attachment route in `src/routes/api.js` (sanitized
   basename from uploadsDir — same pattern the question-diagram feature uses,
   e.g. `/api/exams/:id/images/:file`).
   **Report** (`src/services/results.js` + `src/server.js`): render `<img>`
   under the answer block via the token-gated `/report/:sessionId/attachment`
   route (report token verified, file basename sanitized, served from
   uploadsDir — same approach the report diagrams use).

### Feature 2 — Theory section passages

- Verify and extend the passage carry-forward (`pdfImport.js:204`): theory
  questions must receive `passage` exactly like comprehension groups. Add an
  assertion in the regression test that a Section-B lead-in (paragraph before
  the first theory question) ends up on the theory questions.
- Passages already pass through `stripSourceWatermarks` (line 214); keep
  that.
- Expected size: a small fix/verification in `pdfImport.js` plus a test —
  no schema or API change.

### Feature 3 — Startup recovery for abruptly-stopped exams

- New `finalizeStaleSessions()` in `src/services/exam.js`, called from
  `src/server.js` after DB init (and exported for tests):
  - `SELECT s.* FROM sessions s JOIN exams e … WHERE s.status='in_progress' AND
    s.started_at + exam duration < now`.
  - For each: `await finalize(session, student, 'expired')` — the existing
    finalize path already produces result + report + certificate and never
    breaks on certificate errors.
  - Unanswered session questions score 0 (existing computation).
  - Wrap each in try/catch; a failure on one session must not stop the rest;
    log and continue.
- `finalize(session, student, 'expired')` must tolerate a session with zero
  answers (report renders "No answers" per question; WhatsApp result still
  goes out; certificate still generated).

### Feature 4 — Watermarks: ignore and proceed

- Keep the existing `stripSourceWatermarks` behavior; optionally broaden the
  `WATERMARK` regex with common school/exam footer patterns (e.g.
  `mock\s+exam|do\s+not\s+share|for\s+internal\s+use` on standalone lines).
- No new blocking logic anywhere: diagrams that carry visual watermarks are
  delivered as-is; a watermarked PDF proceeds to WhatsApp normally once text
  watermarks are stripped.

## Testing

`test/regression.test.js` (node:test), following the existing suite:

1. `parseWebhook` returns an image event with `mediaId` for an `image` message
   (with and without caption).
2. `handleInbound` with a mocked `wa.downloadMedia` records a theory answer
   with `answer_image` set and progresses to the next question; an image on an
   objective question is refused; download failure → "please try again" and
   session not advanced.
3. Vision grading: with the vision flag off / call failure, the answer is
   saved unmarked (review flow) and the exam continues.
4. Theory passage: a fixture parse with a Section-B lead-in assigns the
   passage to the theory questions.
5. `finalizeStaleSessions` finalizes an overdue `in_progress` session
   (mocked WA) into a report + certificate + WhatsApp result; zero-answer
   session still finalizes; a throwing session does not stop the others.
6. `stripSourceWatermarks` removes a watermarked footer line and keeps the
   question text; import proceeds.

Existing tests must keep passing (no signature changes to `extractText`,
`sendText`, or `parseWebhook`'s message events).

## File change map

| File | Change |
|---|---|
| `src/services/whatsapp.js` | `parseWebhook` image events + `downloadMedia` |
| `src/routes/webhook.js` | pass image events through (don't drop captionless) |
| `src/services/exam.js` | image answer intake + save; `finalizeStaleSessions`; zero-answer-tolerant `finalize('expired')` (verify) |
| `src/services/marking.js` | `markImageAnswer` + vision/manual fallback |
| `src/services/ai.js` | optional vision content-message support + capability flag |
| `src/config.js` | `AI_VISION` flag (default off) |
| `src/db.js` | `answers.answer_image` column (+ legacy migration copy list) |
| `src/services/pdfImport.js` | verify/extend theory passage carry-forward |
| `src/services/textClean.js` | broaden watermark patterns (optional, safe) |
| `src/server.js` | startup recovery call; report attachment route for answer images |
| `src/services/results.js` | report renders answer-image `<img>` |
| `src/public/app.js` | dashboard answer viewer renders answer-image `<img>` |
| `README.md` | note: photo answers + recovery + vision flag |

## Risks / notes

- WhatsApp media download requires the Media API (`GET /v21.0/{mediaId}`);
  links expire (hours), so download immediately in the webhook handler.
- Vision grading depends on the provider accepting `image_url` content; the
  flag gates it, and any failure falls back to manual review — the exam never
  blocks (consistent with "AI marking errors never block the exam").
- Photo format: re-encode to PNG with `@napi-rs/canvas` to keep the report
  serving path uniform with diagrams/certificates.
- `answers` was rebuilt once already (FK removal); the migration block must
  be updated, not duplicated.
- Startup recovery only covers sessions whose deadline already passed; a
  session where the student simply never started is untouched (existing
  behavior).