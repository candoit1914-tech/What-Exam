# PDF Diagram & Image Extraction Design

Date: 2026-08-09
Status: Approved (user: "Sure")
Repo: What-Exam (La_Exam)
Branch: main

## Problem

PDF uploads currently extract text only (`src/services/pdf.js` `extractText`).
Diagrams and images in the paper (e.g. BECE Integrated Science Figure 1(a)
domestic farm animals, Figure 1(b) respiratory system, circuit symbols, pH
table) are silently discarded, so theory questions that reference a figure
are unanswerable on WhatsApp and invisible on reports.

## Scope

Extract every meaningful image/diagram from an uploaded exam PDF and:

1. Attach it to the question it belongs to (position-based, deterministic).
2. Show it in the admin dashboard question views.
3. Show it in the student web report.
4. Send it on WhatsApp as an image bubble **before** the question text bubble.

Both objective and theory questions can carry diagrams. Images that live
inside the answers/solutions/marking-scheme section are NOT attached.

## Non-goals (explicitly deferred)

- Manual re-association of diagrams in the admin UI (auto-attach only).
- Cropping diagrams tightly to glyph boxes (whole-rectangle bounding boxes).
- Store diagrams per question_pool variant (pool questions are AI-only today).
- Resize/retire behavior for diagrams on question delete (orphan cleanup is
  best-effort; files may linger, matching the current `data/uploads` behavior).

## Context (current pipeline)

```
upload -> saveUpload -> pdfImport.startJob
  -> pdf.extractText(buffer)                    # text only
  -> ai.splitSolutionSections(text)             # strips solutions/marking section
  -> ai.splitIntoBlocks(cleanText)              # deterministic question blocks
  -> ai.extractQuestionsFromText                # per-block AI call(s)
  -> INSERT INTO questions ...
```

- `questions` table has no attachment columns; `ensureColumn` migrator exists in
  `src/db.js`.
- WhatsApp `sendImage(to, buffer)` exists in `src/services/whatsapp.js` but
  takes a PNG buffer (preserves `image/png` content-type), used for
  certificates via `exam.js`. It can be reused with a buffer read from the
  saved diagram file.
- `buildQuestionBubbles` / `sendQuestionTo` in `src/services/exam.js` build the
  ordered text bubble list per question; delivery race safety is already
  handled by `pacedSend`.
- Reports are token-gated HTML rendered by `results.reportHTML`, served at
  `/report/:sessionId?token=…` in `src/server.js`.

## Approach (chosen): position-marker extraction + whole-block raster render

### 1. Extraction engine (`src/services/pdf.js` — new function `extractDocument`)

New async function `extractDocument(buffer)` that walks every page once and
returns:

```js
{
  text,            // same joined text as extractText() today
  images: [        // every diagram-sized image drawn on the document
    { page, x, y, w, h, kind: 'raster'|'vector' }
  ]
}
```

- `extractText` remains as a thin wrapper calling `extractDocument` and
  returning only `.text` (backward compatibility for other callers/tests).
- Per page, we ask pdfjs for the operator list (`getOperatorList`) and track:
  - `paintImageXObject` / `paintInlineImageXObject` ops -> raster images. Their
    bounds come from the CTM at the paint op; pdfjs exposes the image XObject
    via the operator-list args in the same order as the paint order on that
    page, so we pair each paint XObject name with the « active image » of the
    same index on the page. If positional pairing proves unstable across
    pdfjs versions, fall back to matching by drawing order of `paint` ops in
    the document coordinate space using transform.Min and transform.Max.
  - dense runs of vector drawing ops (paths/strokes/fills) with few/no text
    glyphs inside their bounding box -> vector diagrams (e.g. page 13 grid
    is excluded because its cells contain text glyphs).
- Coordinates are normalized into the pdfjs coordinate space (top-left origin
  after `getViewport({scale:1})`), so images and text line up with the text
  extraction.

Filtering rules (each checked, documented in code):

- Images smaller than about 1.5% of page area (`w*h / pageArea < 0.015`) are
  treated as bullets/ornaments and skipped.
- Images larger than about 20% of page area are treated as whole-page scans /
  watermark backgrounds and skipped UNLESS the page has exactly one large
  image (some papers put a single diagram on a page with 1-2 questions).
- Images whose bounding box overlaps a solutions/marking page are excluded by
  construction (see marker step).

`extractDocument` does NOT render images; it only records where they are.

### 2. Marker injection into the text pipeline

This step runs BEFORE the AI is involved:

- Build the image list with per-page `yMid` (vertical middle of the box).
- For each image, find the nearest text line above it on the same page (from
  the same operator list pass) and insert a unique marker line on its own
  line at that position:

  ```
  [IMG:12]            # one per image, sequential
  ```

- If an image has no text line above it on its page (diagram at the very top
  of a page), the marker is inserted at the START of that page's text.

- The marker text rides the existing pipeline unchanged:

  ```
  splitSolutionSections -> splitIntoBlocks -> AI extraction
  ```

  A marker lost in `splitSolutionSections` (i.e. its line is inside the
  answers/marking section) is dropped automatically — the image it referenced
  is never attached to anything. This is the "solutions section filter" —
  images on answer pages simply never surface.

- After the AI returns parsed questions, any question whose text or leading
  context block contains `[IMG:n]` gets the `n`-th image attached to its
  `image` column; ALL marker strings are stripped from the stored question
  text (both `text` and `passage`).

- If a marker's image is not picked up by ANY question from the block that
  contained it (AI dropped/merged lines), it is attached to the FIRST question
  of that block as a deterministic fallback (documented in code).

- One image per question (single `image` column). If a question's text
  contains more than one marker, the FIRST one wins; the extras are counted
  into the job warning so the admin knows a diagram was left out.

Edge case: multiple diagrams on one page -> multiple markers -> each attaches
independently to whichever question's block contains it (the caption line such
as "Figure 1 (a)" is typically in the same block).

### 3. Rendering to files

- For each accepted image, render the page region of its `(x,y,w,h)` box using
  pdfjs `page.render` into an offscreen `@napi-rs/canvas` (already in
  dependencies; add a `canvas` import in `pdf.js`) at ~2x scale with a small
  white padding margin (e.g. 8 PDF points).
- Encode PNG (`canvas.toBuffer('image/png')`) and write to
  `data/uploads/` as `<timestamp>-<questionSlot>.png` (same dir as uploaded
  PDFs; `config.uploadsDir` exists).
- If `@napi-rs/canvas` proves incompatible with pdfjs's render target in
  this Node/OS, fall back to `node-canvas`… (documented risk; tradeoff noted
  in implementation plan).

### 4. Schema & API

`src/db.js`:

```sql
ensureColumn('questions', 'image', "TEXT DEFAULT ''")
ensureColumn('question_pool', 'image', "TEXT DEFAULT ''")
-- image = relative filename under uploadsDir, '' = none
```

`qWithScheme` returns `image: row.image` so the dashboard and report can show
it.

Upload flow (`routes/api.js` + `pdfImport.js`):

- `pdfImport.startJob` calls `pdf.extractDocument` first, passes the resolved
  images through to `extractQuestionsFromText`.
- `ai.extractQuestionsFromText` gains an optional `images` param; after
  parse, it strips markers and returns questions with `image` set.
- The insert statement gains the `image` column.
- Job `warning` gains an optional advisory when images were found on pages but
  none could be attached ("Detected N diagram(s) that could not be matched —
  review the questions after import").

Serving:

- `src/routes/api.js`: `GET /api/exams/:id/images/:file` — admin-token-gated
  file serving from uploadsDir (sanitized basename). Dashboard `<img>` uses
  this.
- Report: since the report is token-gated but served by the backend
  directly, the report HTML embeds `data:` or a signed one-time URL. Simplest
  consistent approach: `/report/:sessionId/attachment?file=<name>&token=<same-report-token>`
  added to `server.js`, checked with `auth.verifyReportToken`, then served
  from uploadsDir. `results.reportHTML` renders `<img>` under the question
  text when `q.image` is set.
- WhatsApp: `sendImage` is extended to accept either a PNG buffer or a
  relative filename on disk (transparent read before upload); no API change.

### 5. WhatsApp delivery (exam.js)

In `sendQuestionTo`:

- Before `buildQuestionBubbles`, if the question has an `image`, read the
  file and `await wa.sendImage(student.phone, bufferOrPath)`.
- Then `await wa.sendText(...)` each bubble in order — the text flow already
  awaits `sendText` per bubble, so ordering is image-first, text-second.
- Continue on failure with an error log (non-blocking; the question text is
  still sent) matching the existing "errors never block the exam" behavior.
- `buildQuestionBubbles` output is unchanged; tests that assert bubble text do
  not need to change beyond adding a mocked `sendImage` when the question has
  an image.

### 6. Dashboard (public/app.js)

- `qitemHTML` renders `<img class="qimg" src="/api/exams/:examId/images/:file">`
  under the question when the API returns `image`.
- Question editor: a preview `<img>` below the textarea when editing (reads
  the same field) — no upload UI in v1.

## Testing

- `test/regression.test.js` (node:test):
  - New fixture PDF built with pdfkit (dev dependency) containing: 1 text
    question with an embedded PNG diagram + caption, 1 question on a later
    page with a vector-drawn diagram, and 1 fake "answers" section on the
    last page with an image.
  - Assert `extractDocument` returns the expected image count and bounds.
  - Assert marker attaches to the correct question, solutions images never
    attach, marker text is stripped.
  - Assert `db` schema migration adds `image` column on an existing rows.
  - Assert report HTML renders `<img>` when question.image is set.
  - Assert WhatsApp: with a stubbed `wa.sendImage/sendText`, image is called
    before text for a question with image; both non-blocking errors logged.
  - Existing tests keep passing (extractText signature unchanged).

## File change map

| File | Change |
|---|---|
| `src/services/pdf.js` | `extractDocument` + image detection + render-to-disk |
| `src/services/ai.js` | marker attach/strip in extraction return |
| `src/services/pdfImport.js` | startJob uses `extractDocument`; inserts image column; warning text |
| `src/db.js` | ensureColumn 'image' on questions + question_pool |
| `src/routes/api.js` | serve `/api/exams/:id/images/:file`; include `image` in qWithScheme; insert passes image |
| `src/server.js` | `/report/:sessionId/attachment` route serving diagrams for token-verified reports |
| `src/services/results.js` | reportHTML renders `<img>` for question images |
| `src/services/exam.js` | image bubble before text bubbles |
| `src/services/whatsapp.js` | `sendImage` accepts a path as alternative to buffer |
| `src/public/app.js` | dashboard renders/attaches `<img>` in list + editor |
| `README.md` | note: diagram extraction supported |

## Risks / notes

- pdfjs operator-list -> image pairing depends on the pdfjs version; the
  layout-based fallback (draw-order pairing) is included.
- @napi-rs/canvas + pdfjs « render to canvas suppressed » — verified locally
  before the first pull request; fallback documented (node-canvas or raw
  image XObject extraction) if blocked.
- WhatsApp media upload requires each image to be re-uploaded per send; we
  accept that cost (certificates already do the same).
- BECE science uses tiny images on answer pages (page 18 model answer) that
  must stay un-attached — covered by §2 marker mechanism.