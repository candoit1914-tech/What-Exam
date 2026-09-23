# Design: Math-Expression Bubbles for PDF Math Exams on WhatsApp

Date: 2026-09-22

## Context

BECE/WAEC-style math papers (e.g. `papers.sronu.com/bece/mathematics/2026`) are
typeset as PDFs where math notation — fractions, indices/powers, matrices,
surd stacks — is drawn from **stacked glyphs in a dedicated math font**
(`g_d0_f3`), *not* from raster images. A fraction `3/4` is two glyphs at the
same x with baselines ~8pt apart; the fraction bar is a thin vector stroke.

pdf.js flattens these to plain text, dumping the digits at the end of the page
text. The WhatsApp delivery today therefore sends:

> Arrange the following: , 0.8, , 0.65 in descending order.

Students cannot read the question. English papers extract cleanly (no math).
Science papers carry real diagrams already handled by the existing `[IMG:n]`
pipeline. Math papers are the gap.

## Goal

For PDF-imported questions that contain stacked math notation, deliver each
**math expression as its own small image bubble** above the question text on
WhatsApp (chosen direction; option 2). Text stays text; only the lost math bits
become images.

## Requirements

1. Detect stacked-glyph math expressions (fractions, indices, matrices, surd
   stacks) per page during PDF analysis.
2. Replace their escaped digits in the extracted text with inline `[MATH:n]`
   markers so the text reads correctly and each expression can attach to the
   question (and option) that owns it.
3. Render each expression to a small PNG by cropping a full-page high-res
   render (native `Path2D` render — the "glyph paths abort" assumption is
   outdated).
4. Store multiple images per question (a single question can require ≥2
   expression bubbles).
5. Deliver expression bubbles in document/reading order **above** the question
   text bubble; existing raster diagrams (`[IMG:n]`) keep their current single
   `questions.image` behavior unchanged.

## Design

### 1. Detection — `src/services/pdf.js`

In `analyzePage(doc, pageNo)`:

- After `getTextContent()`, collect glyph items with geometry
  (`{str, fontName, transform[4]=x, transform[5]=y, width, height}`) into
  per-font lists.
- For each font, group items into clusters by overlapping x-window. A cluster
  is a math expression when it has **≥2 items with ≥2 distinct baselines and
  max baseline-gap ≥ 0.55 × char-height** (distinguishes stacked math from
  ordinary inline text; confirmed by measurement — gaps are ~8pt vs ~11.5pt
  line height).
- Compute the cluster's user-space AABB `{x, y, w, h}` and `userMid`. Emit as
  `mathExprs: [{page, userBox, userMid}]`. These are NOT added to `paints`
  (they are text, not paint ops) and are exempt from the paint size filters.
- While joining row text, skip the `str` of every char that belongs to a math
  cluster and instead splice the token `[MATH:n]` at that position (n = index
  into `mathExprs`). Result: `"1. Arrange the following: [MATH:0], 0.8,
  [MATH:1], 0.65 in descending order."`

`extractDocument()` / `textWithMarkers()` carry the new `mathExprs` array and
the inline `[MATH:n]` tokens ride inside the text exactly like `[IMG:n]`.

### 2. Rendering — `src/services/pdf.js`

New `renderMathRegion(buffer, expr, outPath)`:

- `globalThis.Path2D = require('@napi-rs/canvas').Path2D` before render (the
  fix that makes pdf.js render glyphs onto the native canvas; verified).
- Render the owning page once at scale ~4 to a canvas, then `drawImage`-crop
  the expression AABB (+2pt pad). One page render serves all expressions on
  that page (cache per page within one import job).

### 3. AI extraction — `src/services/ai.js`

- `extractQuestionsFromText` already gathers `[IMG:(\d+)]` per block. Parse
  `[MATH:(\d+)]` the same way → `mathByBlock`.
- Add prompt rule: preserve `[MATH:n]` markers verbatim in `text`, `passage`,
  **and** `options` (option lines are extracted separately and can contain
  fractions: e.g. "A. 3/4").
- Extend `attachMarkers`: give a question **all** math markers of its block that
  it kept, in document order → `q.markerIndices = [n0, n1, ...]` (new, distinct
  from single `markerIndex`). Unmatched math markers fall back to the block's
  first question. Strip `[MATH:n]` from stored `text`/`passage`/options.
- `onWarning` path extended for unmatched math markers.

### 4. Storage — `src/db.js` + `src/services/pdfImport.js`

New table:

```sql
CREATE TABLE IF NOT EXISTS question_images (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL DEFAULT 0,
  image       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'math',   -- math|figure
  UNIQUE(question_id, position)
);
```

- `pdfImport.startJob`: when `g.markerIndices` is present, render each math
  expression (cache the owner page's full render), insert a `question_images`
  row with increasing `position`. Keep the existing single `questions.image`
  logic for `g.markerIndex` (raster/vector figures) unchanged — no migration
  of existing data.
- `ensureColumn` migrations unchanged; new table created idempotently.

### 5. WhatsApp delivery — `src/services/exam.js`

In `sendQuestionTo()` between meta bubbles and the question bubble:

- Load `q.question_images` ordered by `position`. Send each expression bubble
  via `wa.sendImage` **before** the question text bubble, in position order.
- Fall back to `question.image` unchanged when no `question_images` exist.
- A send failure on one expression logs and continues (same pattern as the
  existing image send).

### Reading-placeholder convention

A stripped fraction leaves a visible gap in the delivered text. Students match
bubbles to gaps **left-to-right in reading order** (the same order the bubbles
are sent). No placeholder token is inserted into the text this pass.

## Files to Modify

| File | Change |
|------|--------|
| `src/services/pdf.js` | Detect math clusters, `[MATH:n]` splicing, `renderMathRegion` (`globalThis.Path2D`) |
| `src/services/ai.js` | `[MATH:n]` block parsing, prompt rule, multi-marker attach → `markerIndices` |
| `src/db.js` | `question_images` table |
| `src/services/pdfImport.js` | Render + insert `question_images` rows |
| `src/services/exam.js` | Send expression bubbles in order above question text |
| `test/pdf-images.test.js` | Cases: math PDF detection count, clean text, render ink, multi-image question |

## Verification

1. Unit: page-2 objectives of `bece-math-2026.pdf` produce `[MATH:n]` markers
   and clean text (`"Arrange the following: , 0.8, , 0.65"` → markers present,
   digits gone from the tail).
2. Unit: Q1 gets two `question_images` rows (positions 0,1) with ink-bearing
   renders.
3. Regression: English PDF still imports with zero math markers; science
   diagrams still use `[IMG:n]` single-image path.
4. WhatsApp: send Q1 → two fraction bubbles then the question text; options
   with fractions also carry their bubble.
5. Full `node --test` passes.

## Out of Scope

- Inline images inside WhatsApp text (impossible).
- Linearization of math to text (e.g. `3/4`, `x^2`) — rejected direction.
- OCR fallback for math (unchanged); OCR path returns no `mathExprs`.
- Manual single-image upload behavior (`questions.image`) — unchanged.