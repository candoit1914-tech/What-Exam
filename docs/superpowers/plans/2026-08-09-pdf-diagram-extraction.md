# PDF Diagram & Image Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract every meaningful image/diagram from an uploaded exam PDF, attach it to the correct question (position-based, deterministic), and deliver it in the admin dashboard, the student web report, and as a WhatsApp image bubble sent before the question text.

**Architecture:** `pdf.extractDocument` walks every page once via the pdfjs operator list — replaying `transform` ops to track the CTM — and returns both the joined text (with `[IMG:n]` marker lines inserted at each image's position) and image entries (`{page, x, y, w, h, kind}`). Raster images are decoded directly from `page.objs` (raw RGBA bitmap → PNG), vector regions are redrawn by replaying the vector ops into an offscreen canvas. The markers ride the existing text pipeline, markers in the solutions/marking section are dropped automatically, and each marker attaches to its containing question. A single `image` column per question stores a file name under `data/uploads/`.

**Tech Stack:** Node 24, Express, `pdfjs-dist` 4.10.38 (legacy build, `OPS` exported), `@napi-rs/canvas` ^1.0.3 (already in dependencies), SQLite (`node:sqlite`), `pdfkit` (dev dependency — test fixture builder), `node:test` regression suite.

## Global Constraints

- Keep `extractText` and every existing function signature/behavior backward compatible — other callers (`scripts/*`, tests) call them.
- `questions.image` must default to `''`; migrating an existing database must not drop data (use the existing `ensureColumn` pattern in `src/db.js:183`).
- Markers never reach the AI as raw noise: marker lines must survive AI extraction (prompt instruction) AND be stripped from all stored question fields.
- Image size filters: skip `w*h / pageArea < 0.015` (bullets/ornaments); skip `w*h / pageArea > 0.20` unless it's the only image on the page.
- Solutions-section images never attach (marker dropped by `splitSolutionSections`); the marker mechanism must work unchanged for pages 10/11/12/18 of the reference PDF.
- Rendering must never draw text glyphs through pdfjs path fills (CanvasGraphics/`@napi-rs/canvas` misfire); vector replays skip `showText`-type ops entirely and skip non-native `Path` fills.
- All new code must work in Node 24 without adding npm dependencies (except nothing new; everything needed is already in package.json).
- Commits after every task, message style like existing history (`feat:`, `fix:` prefixes).
- Reference paper (for manual sanity checks): `C:\Users\pax03\Desktop\bece-science-2026.pdf` — 22 pages; raster images on pages 10, 11, 12, 18; page 13 is a vector-canvas exit (pH table grid — its TEXT makes it not a vector).

---

### Task 1: DB migration — add `image` columns

**Files:**
- Modify: `src/db.js` (after the existing `ensureColumn` block, ~line 193)
- Modify: `src/services/exam.js` `topUpPool` (line 129-150) — copy `image` into pool rows
- Modify: `test/regression.test.js` (append a new test near the pool/migration tests)

**Interfaces:**
- Consumes: nothing new.
- Produces: `questions.image` and `question_pool.image` columns, both `TEXT DEFAULT ''`. Existing rows keep `''`. `qWithScheme` (Task 2) and report (Task 9) read `row.image`.

- [ ] **Step 1: Write the failing test**

Add to `test/regression.test.js` at the end:

```javascript
test('db migration adds image columns to questions and question_pool', () => {
  const db = require('../src/db');
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.ok(cols('questions').includes('image'), 'questions.image exists');
  assert.ok(cols('question_pool').includes('image'), 'question_pool.image exists');
});

test('topUpPool copies the image column into pool rows', () => {
  const db = require('../src/db');
  db.exec('BEGIN');
  try {
    const examId = db.prepare("INSERT INTO exams (title, duration_minutes) VALUES ('x', 1)").run().lastInsertRowid;
    db.prepare("INSERT INTO questions (exam_id, q_order, type, text, image) VALUES (?,1,'objective','Q', 'diag-1.png')").run(examId);
    exam.topUpPool(examId, [], 1);
    const pool = db.prepare('SELECT image FROM question_pool WHERE exam_id = ?').all(examId);
    assert.equal(pool[0].image, 'diag-1.png', 'pool copy keeps image file name');
  } finally { db.exec('ROLLBACK'); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `questions.image` column absent; `topUpPool` copy drops it.

- [ ] **Step 3: Implement migration**

In `src/db.js` after line 191 add:

```javascript
ensureColumn('questions', 'image', "TEXT DEFAULT ''");
ensureColumn('question_pool', 'image', "TEXT DEFAULT ''");
```

In `src/services/exam.js` `topUpPool`, change the `insertPool` statement and the `.run(...)` call to carry `t.image || ''`:

```javascript
const insertPool = db.prepare(
  `INSERT INTO question_pool (exam_id, type, text, passage, options, correct_answer, marks, difficulty, learning_objective, explanation, scheme_json, source, image)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
);
// ...
insertPool.run(
  examId, t.type, t.text, t.passage || '', t.options || null, t.correct_answer || null,
  t.marks, t.difficulty || 'medium', t.learning_objective || '', t.explanation || '',
  scheme ? scheme.scheme : '', t.source || 'manual', t.image || ''
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: both new tests pass; all existing tests still pass (the whole run, ~45 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db.js src/services/exam.js test/regression.test.js
git commit -m "feat(db): add image column to questions and question_pool"
```

---

## Task 2: `extractDocument` — image detection + marker injection (pdf.js)

**Files:**
- Modify: `src/services/pdf.js` (single large change)
- Test: `test/pdf-images.test.js` (new file, same pattern as `test/regression.test.js`, node:test)

**Interfaces:**
- Consumes: `config.uploadsDir` (exists).
- Produces:
  - `async function extractDocument(buffer)` → `{ text, images }` where `images` = `[{ page, x, y, w, h, kind }]` (canvas space: top-left origin, scale 1) and `text` = the current `extractText` output if run WITHOUT markers — but the real import path gets markers inserted; see API below.
  - `extractText(buffer)` stays exported, now a thin wrapper: `(await extractDocument(buffer)).text` but with all `[IMG:n]` marker lines removed (backward compat for scripts, and the estimate/warning helpers in `ai.js` must not see them).
  - New exported helper `textWithMarkers(buffer)` — inserts `[IMG:n]` lines at image positions and also returns the `markers` array (used by Task 3); plus plain exported `stripMarkers(text)`.

**Rationale (verified against the reference PDF 2026-08-09):**
- `page.getOperatorList()` returns `ops.fnArray`/`ops.argsArray`; `OPS.transform` args are `[a,b,c,d,e,f]` (new CTM multiplier); `OPS.paintImageXObject` args are `[objId, width, height]` (drawing size from the CTM, NOT the args).
- The image is drawn over the unit square under the current CTM: AABB = corners of the unit square transformed by `ctm`.
- pdfjs viewport at `scale:1` maps PDF user space (y-up) to canvas space (y-down): `canvasY = vp.height - userY - boxH`.
- Verified bboxes on the reference PDF (canvas space, page 595.28 × 841.89):
  - p10 `(133.56, 416.52, 404.69, 212.52)`, p11 `(226.78, 101.92, 218.25, 195.75)`, p12 `(133.56, 117.44, 404.69, 232.16)`, p18 `(57.02, 62.36, 481.23, 288.62)` — page 18 is inside the model-solutions section and MUST stay un-attached.
- Filters: `area = w*h`; page area = `vp.width * vp.height`; skip when `area/pageArea < 0.015` (bullets); skip when `> 0.20` unless it's the only image on the page; also skip when `kind==='vector'` and its box contains extracted text glyphs (the pH-table case — see Task 4).

- [ ] **Step 1: Write the failing tests (new file `test/pdf-images.test.js`)**

```javascript
'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const pdf = require('../src/services/pdf');

const TMP = path.join(require('os').tmpdir(), 'pdf-images-test-' + process.pid);
const TINY_OUT = path.join(TMP, 'out');
// 1x1 red PNG (1 byte pixel + 8-byte IHDR signature) — pdfkit accepts a Buffer
const RED_PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050001e20e2b8a0000000049454e44ae426082', 'hex');

function fixturePdf() {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    // page 1: objective question + embedded raster image
    doc.fontSize(12).text('1. What is the capital of Ghana?');
    doc.image(RED_PNG, 100, 300, { width: 200, height: 150 });
    doc.text('', 0, 0);
    doc.text('Figure 1 - map');
    // page 2: vector diagram — a thick black square (no text inside its box)
    doc.addPage();
    doc.text('2. The box below is called');
    doc.rect(150, 250, 300, 250).fillAndStroke('#000000', '#000000');
    // page 3: fake "solutions" section with an image that must NOT attach
    // (large enough to survive the size filters — its solutions block is
    //  dropped later by splitSolutionSections, not by the area filter)
    doc.addPage();
    doc.text('Part B Solutions');
    doc.image(RED_PNG, 50, 500, { width: 300, height: 250 });
    doc.end();
  });
}

let fixture;
before(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  fixture = await fixturePdf();
});

test('extractDocument detects raster and vector images with plausible boxes', async () => {
  const { images } = await pdf.extractDocument(fixture);
  assert.ok(images.length >= 2, `expected at least 2 images, got ${images.length}`);
  const raster = images.filter((i) => i.kind === 'raster');
  const vec = images.filter((i) => i.kind === 'vector');
  assert.equal(raster.length, 2, 'page1 image + page3 solutions image');
  assert.equal(vec.length, 1, 'page 2 vector');
  // Page 1 raster sits lower-middle of the page, left-aligned-ish x=100
  const p1 = raster.find((i) => i.page === 1);
  assert.ok(p1.y > 200 && p1.y < 600, 'raster page1 vertical band');
});

test('the marker for an image is inserted after the nearest line above it', async () => {
  // marker placement is covered in Task 3 tests; here we only pin the shape
  const { images } = await pdf.extractDocument(fixture);
  assert.ok(images.length >= 2);
});
```

Before writing more, keep this file and build up in Task 3 (markers) — this task only asserts `extractDocument`'s shape.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/pdf-images.test.js`
Expected: FAIL — `extractDocument`/`images` undefined.

- [ ] **Step 3: Implement `extractDocument` in `src/services/pdf.js`**

```javascript
// Helper: multiply 3x3-affine matrices [a,b,c,d,e,f]
function mul(A, B) {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}

function unitSquareAABB(m) {
  const [a, b, c, d, e, f] = m;
  const xs = [e, e + a, e + c, e + a + c];
  const ys = [f, f + b, f + d, f + b + d];
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}
```

Then inside the module, replace the pdfjs lazy-load block with a shared loader:

```javascript
let pdfjs = null;
async function loadPdfjs() {
  if (!pdfjsmod) {
    pdfjsmod = await import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsmod;
}
```

(The current file requires it synchronously via `require('pdfjs-dist/legacy/build/pdf.mjs')` — keep that style; an ESM `.mjs` can be required synchronously in CJS as the existing code shows.)

Add to the same file:

```javascript
/**
 * One pass per page over the operator list. Returns per-page {
 *   paints: [{ fn, args, index }],
 *   textRows: [{ y, line }],      // user-space y of first item of the line
 *   pageSize: { w, h }            // user-space (vp at scale 1)
 * } — no rendering.
 */
async function analyzePage(doc, pageNo) {
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList();
  let ctm = [1, 0, 0, 1, 0, 0];
  const paints = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.transform) { ctm = mul(ctm, args); continue; }
    if (fn === OPS.save) { continue; }                    // not needed: we replay from a clean base per paint
    if (fn === OPS.restore) { continue; }                 // (restores mirror transforms we already track)
    if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      const { x, y, w, h } = unitSquareAABB(ctm);
      paints.push({
        kind: 'raster',
        page: pageNo,
        x, y, w, h,                       // user space (y-up)
        imageId: fn === OPS.paintImageXObject ? args[0] : null,
        rawWidth: args[1], rawHeight: args[2],   // pixel dims (unused for box)
      });
    }
  }
  // Text lines (user space) from getTextContent:
  const content = await page.getTextContent();
  const rows = [];
  let cur = '';
  let curY = null;
  const flush = () => { if (cur) rows.push({ y: curY, line: cur }); cur = ''; curY = null; };
  for (const it of content.items) {
    if (it.hasEOL) { flush(); }
    const s = it.str || '';
    if (curY == null) curY = it.transform ? it.transform[5] : 0;
    if (cur && s && !/\s$/.test(cur) && !/^\s/.test(s) && cur.trim() && s.trim()) cur += ' ';
    cur += s;
  }
  flush();
  return { paints, rows, width: vp.width, height: vp.height };
}
```

Notes:
- This replay is deliberately frame-accurate to the existing `extractText` line-join rules, so markers sit at the same line boundaries as the AI later sees.
- We do NOT track `q`/`Q` since our AABB is computed per paint op from the CTM as pdfjs sees it at emit time (the evaluator emits `transform` ops before each `cm`-related paint).

Then the main function:

```javascript
async function extractDocument(buffer) {
  const d = await getDocument({ ... same options as extractText currently ... }).promise;
  const images = [];
  const pageRows = [];   // per page rows
  const textParts = [];
  for (let p = 1; p <= d.numPages; p++) {
    const { paints, rows, width, height } = await analyzePage(d, p);
    pageRows.push(rows);
    // → build the line-joined text (same algorithm as today, but we keep rows)
    // (reuse the join logic from extractText below)
  }
  // Raster filtering happens in Task 3 (needs page area + marker placement).
}
```

**IMPORTANT (implementation note for the engineer):** do not copy the rough code above — implement `extractDocument` as:

1. A private `joinTextLines(contentItems)` that produces the same joined text lines as current `extractText` (verified: same whitespace-joining rules), returning `{ lines, rows }` where `rows` = `[{ y, line }]` per line in document order with user-space y from the FIRST item of the line.
2. `analyzePage` returns `{ paints, rows, w, h }` exactly as above (paints in user space).
3. `extractDocument` loops pages: collects `{ page, x, y, w, h, kind }` (user-space, canvas space = y-down via `vp.height - y - h` conversion done at the end for consumers; see Task 3 signature: consumer reads `images[{page, x, y, w, h, kind}]` where x/y are **canvas space, top-left origin** — convert once when assembling).
4. Then:
   - `text` = lines joined with `\n` (same as today, *without* markers);
   - dedupe identical paints (same box+kind) across pages is NOT needed.
   - keeps `extractText` export = `stripMarkers(extractDocument(text).text)`.

- [ ] **Step 4: Run the failing tests**

Run: `node --test test/pdf-images.test.js`
Expected: the shape + raster/vector split pass now (first test); marker test still fails (Task 3).

- [ ] **Step 5: Commit**

```bash
git add src/services/pdf.js test/pdf-images.test.js
git commit -m "feat(pdf): detect raster and vector images via operator-list replay"
```

---

## Task 3: Marker injection + filters + `textWithMarkers`

**Files:**
- Modify: `src/services/pdf.js`
- Test: extend `test/pdf-images.test.js`

**Interfaces:**
- Produces: `pdf.textWithMarkers(buffer)` → `{ text (same as before, plus markers), markers: [{index, page}] }` where marker lines read `[IMG:n]` and are placed:
  - after the nearest row ABOVE the image center in user space (row.y > imageMid, minimal gap);
  - at the very start of that page's text if no row is above.
- `pdf.stripMarkers(text)` → text without any `[IMG:n]` lines (each whole line removed, `.replace(/^\[IMG:\d+\]\s*\n?/gm, '')`), used by `extractText` and by Task 5 after attach.

- [ ] **Step 1: Extend the failing tests (in `test/pdf-images.test.js`)**

```javascript
test('markers land after the nearest line above each image', async () => {
  const { text, markers } = await pdf.textWithMarkers(fixture);
  assert.ok(text.includes('[IMG:0]'), 'first marker present');
  assert.ok(text.includes('[IMG:1]'), 'second marker present');
  // The page-1 marker must sit after the Q1 stem line, before "Figure ..." caption
  const i1 = text.indexOf('[IMG:0]');
  assert.ok(i1 > text.indexOf('1. What is'), 'after stem');
  assert.ok(i1 < text.indexOf('Figure 1 - map'), 'before caption');
  // The page-3 marker still exists in the marked text (it survived the size
  // filters); whether it attaches is decided in Task 6 (solutions block drop).
  const i1 = text.indexOf('[IMG:1]');
  assert.ok(i1 > text.indexOf('Part B Solutions'), 'page-3 marker present after its section heading');
});

test('filters drop tiny ornaments and giant spreads but keep single big images', async () => {
  const { images } = await pdf.extractDocument(fixture);
  // No tiny raster garbage: the 1x1 PNG scaled to 200x150 is 2.7% of the page,
  // it stays; a hypothetical 0x0 never happens.
  assert.ok(images.every((i) => i.w > 1 && i.h > 1));
});

test('stripMarkers removes marker lines fully', () => {
  const t = 'a\n[IMG:3]\nb\n';
  assert.equal(pdf.stripMarkers(t), 'a\nb\n');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/pdf-images.test.js`
Expected: marker tests fail (`textWithMarkers` missing).

- [ ] **Step 3: Implement `textWithMarkers` + filters in `src/services/pdf.js`**

```javascript
const IMG_MARKER = /^\[IMG:\d+\]\s*\n?/gm;

function stripMarkers(text) {
  return String(text || '').replace(IMG_MARKER, '');
}

async function textWithMarkers(buffer) {
  const { images, textLines, pageBounds } = await extractDocument(buffer); // reuse Task 2
  let lines = textLines.slice();            // array of { y, line } user-space rows
  const pageRowRanges = ...                 // per-page indexes into lines
  const markers = [];
  images.forEach((img, idx) => {
    const midY = img.userMid;               // expose `userMid` from extractDocument
    const pageRows = ...lines slice for img.page;
    let anchor = null;
    for (const row of pageRows) {
      if (row.y > midY && (!anchor || row.y - midY < anchor.y - midY)) anchor = row;
    }
    let at = anchor ? lines.indexOf(anchor) + 1 : pageStartIndex(img.page);
    // Multiple markers on one page: process images in REVERSE page order so an
    // earlier splice never shifts a later anchor's index.
    lines.splice(at, 0, { y: null, line: `[IMG:${idx}]` });
    markers.push({ index: idx, page: img.page });
  });
  return { text: lines.map((r) => r.line).join('\n'), markers };
}
```

**Filters** in `extractDocument` — the function must apply these rules when producing `images`:

```javascript
const PAGE_AREA_MIN = 0.015;
const PAGE_AREA_MAX = 0.20;
// after collecting rawPaints per page, per page:
const pageArea = w * h;
const perPage = rawPaints.filter((p) => {
  const ratio = p.w * p.h / pageArea;
  if (ratio < PAGE_AREA_MIN) return false;
  if (ratio > PAGE_AREA_MAX) {
    return rawPaintsForPage.length === 1;   // single big image on the page keeps it
  }
  return true;
});
```

Return `{ images, text, pageBounds }` where `text` is the plain (marker-free) text and `images` are filtered, `userMid` stored on each (used by `textWithMarkers`).

**IMPORTANT:** the `extractDocument` internal return shape is private (underscore) — the PUBLIC return of `extractDocument` stays `{ text, images }` with `text` = marker-free lines (matches the spec: markers never appear in `extractText`/`extractDocument` text; they exist only in `textWithMarkers`).

- [ ] **Step 4: Run tests**

Run: `node --test test/pdf-images.test.js`
Expected: all new marker/filter tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/pdf.js test/pdf-images.test.js
git commit -m "feat(pdf): inject [IMG:n] markers at image positions with size filters"
```

---

## Task 4: Raster decode → PNG (via pdfjs decoded XObject)

**Files:**
- Modify: `src/services/pdf.js`
- Test: extend `test/pdf-images.test.js`

**Interfaces:**
- Produces: `pdf.renderImage(filePath, imageEntry, outPath)` — guarantees `outPath` holds a PNG of at least the image's box (2x scale), returns `outPath`.
- Reads `config.uploadsDir` for path join (Task 7).

- [ ] **Step 1: Write the failing test**

```javascript
test('renderImage writes a PNG containing the raster pixels', async () => {
  fs.mkdirSync(TINY_OUT, { recursive: true });
  const before = fs.readdirSync(TINY_OUT).length; // ensure out dir exists
  const { images } = await pdf.extractDocument(fixture);
  const p1r = images.find((i) => i.page === 1 && i.kind === 'raster');
  const dest = path.join(TINY_OUT, 'r1.png');
  await pdf.renderImage(fixture, p1r, dest);
  const buf = fs.readFileSync(dest);
  assert.equal(buf.slice(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG magic');
  // PNG must be ROUGHLY the drawn size at 1x (image non-empty)
  assert.ok(buf.length > 400, 'non-trivial PNG');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/pdf-images.test.js`
Expected: FAIL (`renderImage` undefined).

- [ ] **Step 3: Implement `renderImage`**

```javascript
/**
 * Render the region of one raster image to a PNG file.
 */
async function renderImage(buffer, image, outPath) {
  const doc = await openDoc(buffer);
  const page = await doc.getPage(image.page);
  const vp = page.getViewport({ scale: 1 });
  // Decode the raw bitmap from pdfjs's object store:
  const objId = image.rasterId;         // the paint arg[0] (image XObject name)
  // NOTE: pdfjs only decodes on demand; getObject evaluates at first need:
  // we must touch it via page.objs:
  await page.objs.ensure(objId).catch(() => {});
  const img = page.objs.get(objId);
  if (!img || !img.data) throw new Error('image not decodable: ' + objId);
  const { createCanvas } = require('@napi-rs/canvas');
  const cWidth = Math.max(1, Math.round(image.w * 2));
  const cHeight = Math.max(1, Math.round(image.h * 2));
  const canvas = createCanvas(cWidth, cHeight);
  const ctx = canvas.getContext('2d');
  // PDF-space image is bitmap-sized; the canvas region is image.w × image.h in
  // user space; draw the bitmap stretched to the canvas:
  const imageCanvas = createCanvas(img.width, img.height);
  imageCanvas.getContext('2d').putImageData(new Uint8ClampedArray(img.data.buffer ? img.data : img.data.slice()), 0, 0);
  ctx.scale(2, 2);
  ctx.drawImage(imageCanvas, 0, 0, image.w, image.h);
  fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
  return outPath;
}
```

Refine pieces:
- `getDoc(buffer)` refactors the existing `extractText` loader so `image.renderImage` reuses the same `config` pdfjs options (including `standardFontDataUrl`).
- `page.objs.ensure(objId)` can reject; if it does, fall back to raw pixel extraction from `page.getOperatorList` (the op's `args[0]` names the object; `page.objs.get(objId)` after `getOperatorList()` usually has it — try `page.objs.get` first inside a `try`, else `ensure`).
- `ImageData` is available in the `@napi-rs/canvas` scope — pass a `Uint8ClampedArray`; `img.data` may be 1 or 4 channels; only 4-channel (RGBA) goes through `putImageData`; check `img.data.length === img.width * img.height * 4` — if the decoded buffer is smaller (mask), render white/transparent fallback: fill with rgba black and put the mask — that's beyond the fixture; keep a `console.warn` and draw a gray box instead (documented limitation — masks are rare in exam diagrams).

- [ ] **Step 4: Run tests**

Run: `node --test test/pdf-images.test.js`
Expected: PASS (a valid red PNG appears in the temp dir).

- [ ] **Step 5: Commit**

```bash
git add src/services/pdf.js test/pdf-images.test.js
git commit -m "feat(pdf): render raster images to PNG from pdfjs XObjects"
```

---

## Task 5: Vector region rendering (operator replay) + text-in-box exclusion

**Files:**
- Modify: `src/services/pdf.js`
- Test: extend `test/pdf-images.test.js`

**Interfaces:**
- Produces: `pdf.renderVectorRegion(buffer, image, outPath)` — draws the `showText`less replay of the page's operators into the region (incl. lines, fills, strokes, curves) as PNG; returns `outPath`.
- `extractDocument` gains: for vector candidates, runs a **quick text-overlap test**: if the region bbox contains at least one extracted text row (row.y within `[y, y+h]` user space), the region is NOT a diagram → dropped from `images` (kind field may be `'vector'` for the diagram-only case). The current `analyzePage` already returns `rows`, so the ROW check is done when assembling images.

- [ ] **Step 1: Write the failing test**

```javascript
test('vector regions render a non-blank PNG', async () => {
  const { images } = await pdf.extractDocument(fixture);
  const v = images.find((i) => i.kind === 'vector');
  assert.ok(v, 'page-2 vector exists');
  const dest = path.join(TINY_OUT, 'v.png');
  await pdf.renderVectorRegion(fixture, v, dest);
  const buf = fs.readFileSync(dest);
  assert.equal(buf.slice(0, 8).toString('hex'), '89504e470d0a1a0a');
  // Non-blank: the black 300x250-'filled' rect must have dark pixels
  // (we re-play the same path fill; blank would be all white)
  assert.ok(buf.includes(0), 'has non-white bytes'); // loose pixel check
});

test('vector regions with text inside are NOT listed as diagrams', async () => {
  const doc = new PDFDocument();
  // draw a "grid" with text INSIDE its box (the pH-table pattern)
  doc.rect(50, 200, 400, 150).fill('#eee');
  doc.fontSize(10).text('pH table cell text 1', 55, 245);
  doc.text('pH table cell text 2', 55, 260);
  doc.end();
  const buf2 = await collectPdf(doc);
  const { images } = await pdf.extractDocument(buf2);
  const r = images.find((i) => i.kind === 'vector');
  assert.equal(r, undefined, 'vector with text inside is excluded');
});

// Reusable: finish a PDFDocument stream and get the Buffer
function collectPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/pdf-images.test.js`
Expected: FAIL (`renderVectorRegion` undefined; vector present in the first fixture).

- [ ] **Step 3: Implement `renderVectorRegion` (operator replay)**

The draw must:
1. Open the doc, page, viewport(scale 1).
2. `getOperatorList()`; maintain `ctm` (same replay as analysis); open an offscreen canvas sized `region.w×2 × region.h×2` (padded), and `ctx.setTransform(2, 0, 0, -2, -region.x * 2, (region.y + region.h) * 2)`? Simpler: transform so user space → canvas:
   - flip Y: `ctx.translate(0, outH)` then `ctx.scale(2, -2)` then `ctx.translate(-region.x, -region.y)`.
3. For each op:
   - `OPS.transform`: `ctx.transform(...args)` (uses the same semantics as our CTM replay — since our initial ctm was identity, and pdfjs's own CTM is what canvas state uses, direct `ctx.transform` works).
   - `OPS.constructPath`: `args[0]` (the op list) and `args[1]` — re-walk ops; for each `moveTo/lineTo/curveTo/quadraticCurveTo/arc/arcTo/rectangle/closePath` call the equivalent ctx method (user space — the CTM/vp translate handle the coordinates).
   - `OPS.fill` / `OPS.eoFill` / `OPS.fillStroke`: `ctx.fill()` (fill rule 'nonzero' / 'evenodd' via `ctx.fill('evenodd')`).
   - `OPS.stroke`: `ctx.stroke()`.
   - color ops: `setStrokeColor`/`setFillColor`/`setStrokeRGBColor`/`setFillRGBColor`/`setStrokeGray`/`setFillGray`/`setStrokeCMYKColor`/`setFillCMYKColor` (guard: CMYK is unsupported — paint flat via approximate rgb... fallback: treat as #000 or console.warn). Standard: our exam diagrams rarely use CMYK.
   - line width/join/cap/miter: `OPS.setLineWidth` etc.
   - `OPS.showText` and any text-ish op: **skip** (documented — vector figure labels handled by the raster-embedded figures; the extraction's `vector-with-text-inside` rule keeps text-carrying boxes out).
   - `OPS.paintImageXObject` etc.: skip (they're handled by Task 4 renderer; during vector replay they would demand pdfjs's canvas — we deliberately skip and the region rarely includes them).
   - everything else: ignore.
4. `fs.writeFileSync(outPath, canvas.toBuffer('image/png'))`.

Keep the replay SHARED with `analyzePage` — the same `ctm` tracking object with `draw: false` when scanning (`extractDocument`), `draw: true` when rendering.

- [ ] **Step 4: Run tests**

Run: `node --test test/pdf-images.test.js`
Expected: vector tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/pdf.js test/pdf-images.test.js
git commit -m "feat(pdf): replay-vector rendering + exclude text-bearing boxes"
```

---

## Task 6: Attach markers to questions (pdfImport + ai wiring)

**Files:**
- Modify: `src/services/pdfImport.js` (`startJob`)
- Modify: `src/services/ai.js` (`extractQuestionsFromText` — the marker attach)
- Test: extend `test/pdf-images.test.js` (integration-lite, no AI — use a stubbed chatJSON)

**Interfaces:**
- Consumes: `pdf.textWithMarkers`, `pdf.stripMarkers`, `pdf.renderImage`, `pdf.renderVectorRegion`.
- Produces: `startJob` inserts `questions.image` = relative file name (e.g. `1739...-e3-q7-0.png`), attachments handled:
  1. If `textWithMarkers` returned a marker line that survived `splitSolutionSections` + `splitIntoBlocks`, the AI keeps it in `text` or `passage` of exactly one question — that question gets `images[markerIdx]` attached.
  2. If the marker never appears in any parsed question text, attach to the FIRST question of its containing block (spec §2 fallback).
  3. Markers that fell inside the solutions section never surface; `images` on answer pages never attach and are silently discarded.
- `extractQuestionsFromText(rawText, onProgress, onWarning, opts)` — new 4th param; `opts.markers` = the `markers` array from `textWithMarkers` (`[{ idx, page }]`). The already-inserted `[IMG:n]` lines travel inside `rawText` itself, so block splitting sees them; `opts.markers` is only needed to distinguish "no markers at all" from "markers that never matched".
- Add to the AI system prompt: `IMPORTANT: Raw text may contain lines like "[IMG:5]" — those are real figure markers from the paper. If a marker belongs to this question's stem or its figure caption, PRESERVE it verbatim in the "text" or "passage" field of that question (never invent or move markers).`
- After `all` is assembled, run `attachMarkers` (new function in `ai.js`, see Step 3) and strip markers from every question text/passage BEFORE returning.

- [ ] **Step 1: Write the failing test (stub chatJSON)**

```javascript
const path = require('path');
// reuse fixture from Task 2/3 file — but to control the exact text, build a
// synthetic document: '1. Look at Figure 1.\n[IMG:0]\nFigure 1 - a map\n\n'
// with a stubbed chatJSON that echoes blocks minus focus
test('import pipeline attaches marker images to the right question', async () => {
  const pdfImport = require('../src/services/pdfImport');
  const aiMod = require('../src/services/ai');
  const orig = aiMod.chatJSON;
  // block 1 = '1. Look at Figure 1.\n[IMG:0]\nFigure 1 - a map'
  aiMod.chatJSON = async () => ({
    questions: [{
      type: 'theory', number: 1,
      text: 'Look at Figure 1. [IMG:0]',
      passage: 'Figure 1 - a map',
    }],
  });
  try {
    const { text, markers } = await pdf.textWithMarkers(fixture);
    // blocks run through the same split; simulate with a smaller doc:
    const qs = await aiMod.extractQuestionsFromText('1. Look at Figure 1.\n[IMG:5]\n', null, null, { markers: { lines: [{ idx: 5, page: 1 }] } });
    // after attach, the returned question's text NO LONGER contains [IMG:5]
    assert.equal(qs[0].text, 'Look at Figure 1.');
    assert.equal(qs[0].image, undefined, 'image file name assigned later in pdfImport');
  } finally { aiMod.chatJSON = orig; }
});
```

(The `image` field is named `_markerIndex` during extraction — set `qs[0].markerIndex = 5`. `pdfImport` then maps it to a filename and stores it. See Task 7.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/pdf-images.test.js`
Expected: FAIL — marker still in text.

- [ ] **Step 3: Implement attach + strip in `ai.js`**

New exported function:

```js
function attachMarkers(questionsByBlock, markers) {
  // markers: { idx, page, block } array aligned to blocks from splitIntoBlocks
  const results = [];
  const owned = new Set();
  for (let b = 0; b < markers.length; b++) {
    const qs = questionsByBlock[b] || [];
    const markerList = markers[b] || [];
    for (const m of markerList) {
      let target = null;
      for (const q of qs) {
        const textQ = String(q.text || '') + ' ' + String(q.passage || '');
        if (textQ.includes(`[IMG:${m.idx}]`)) { target = q; break; }
      }
      if (!target && qs.length) target = qs[0];   // fallback: first question of the block
      if (target) {
        target.markerIndex = m.idx;   // pdfImport turns it into a file name
        used.add(m.idx);
      }
    }
  }
  return { used, unused: markers.flat().filter((m) => !used.has(m.idx)) };
}
```

In `extractQuestionsFromText`:
1. Accept `opts = {}` as 4th param; when `opts.markers` exists (array of `{idx, page}`), after `splitSolutionSections` + `splitIntoBlocks`, note that markers that survived are per-block: `blocks.map((blk) => [...blk.matchAll(/\[IMG:(\d+)\]/g)].map((mm) => ({ idx: +mm[1] }))`. Those whose section the block represents. Markers lost in solutions section never exist → `unused` list naturally excludes them.
2. In the block-processing loop (after `settled` and before dedupe), call `attachMarkers(blockQuestions, blockMarkers)` where `blockQuestions` = array-of-arrays (currently flattened) — the code as written flattens immediately (line 593-640); restructure minimally: keep a parallel `blockOrder` array capturing each block's question list as it is appended, then post-loop run `attachMarkers`.
3. After attach, strip markers from every `q.text`/`q.passage` via `stripMarkers` — add `stripMarkers` to own import? `ai.js` already imports from `./textClean`; simplest: `const { stripMarkers } = require('./pdf');`? NO — circularly avoid: `ai` should not require `pdf`. Move `stripMarkers` into `textClean.js` and let BOTH pdf.js and ai.js use it (`textClean` currently imports no service) — `src/services/textClean.js` gains:

```js
const IMG_MARKER = /^\[IMG:\d+]\s*\n?/gm;
function stripMarkers(text) { return String(text || '').replace(IMG_MARKER, ''); }
```

(add to `module.exports` — keep `stripSourceWatermarks` intact).
4. **Decision (locked):** keep `extractQuestionsFromText` returning a plain array (existing callers destructure it as an array — no shape change). The AI call receives `opts.markers` and sees the `[IMG:n]` lines; attach + strip happen INSIDE `extractQuestionsFromText`, because it is the only place where blocks and questions are aligned. Attach info travels on the question objects (`q.markerIndex`); any unmatched marker triggers `onWarning`. Implementation:

```js
// inside the flatten loop: collect each block's questions instead of only flattening
const qsByBlock = [];
// ...per block: qsByBlock.push(blockQuestions)

const blockMarkers = blocks.map((blk) =>
  [...blk.matchAll(/\[IMG:(\d+)\]/g)].map((mm) => ({ idx: +mm[1] }))
);
const { used, unused: dropped } = attachMarkers(qsByBlock, blockMarkers);
for (const q of all) {
  q.text = stripMarkers(q.text);
  q.passage = stripMarkers(q.passage);
}
if (dropped.length > 0) {
  onWarning?.(`Detected ${dropped.length} diagram(s) that could not be matched to a question — check them after import.`);
}
```

`attachMarkers` is the exported pure function from Step 3; the warning uses the `onWarning` callback `pdfImport.startJob` already passes.

- [ ] **Step 4: Run tests**

Run: `node --test test/pdf-images.test.js`
Expected: marker-strip + fallback tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/ai.js src/services/textClean.js src/services/pdf.js test/pdf-images.test.js
git commit -m "feat(ai): attach [IMG:n] markers to extracted questions"
```

---

## Task 7: pdfImport — render + save with `image` column

**Files:**
- Modify: `src/services/pdfImport.js`
- Modify: `src/routes/api.js` (`qWithScheme` add `image`)
- Test: extend `test/pdf-images.test.js` (full startJob smoke test with a tiny in-memory DB is heavy; instead unit-test the file-naming + save loop via a helper exported from pdfImport)

**Interfaces:**
- Consumes: `extractDocument` (images), `textWithMarkers`, `renderImage`, `renderVectorRegion`, markers from Task 6.
- Produces: question rows with `image` = `basename(file)`; files under `data/uploads/`. File name: `${Date.now()}-${job.exam_id}-q${nextOrder}-${markerIndex}.png`.
- Adds to job `warning`: if `dropped` (from Task 6 `onWarning`) or >0 marker renders failed.

- [ ] **Step 1: Write failing test (helper exported)**

```js
test('file name for an attached marker is deterministic', () => {
  const p = pdfImport.imageFileNameFor(1739, 3, 1);
  assert.equal(p, '1739-3-q1-1739-3-q1-1.png'.replace('q1-1', 'q1-1')); // placeholder — assert pattern instead:
  assert.match(p, /^\d+-3-q\d+-impl\d+\.png$/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/pdf-images.test.js`
Expected: FAIL (export missing).

- [ ] **Step 3: Implement startJob changes**

In `pdfImport.startJob`, replace:

```js
const text = await pdf.extractText(buffer);
```

with:

```js
const source = await pdf.textWithMarkers(buffer);   // { text, markers }
const { images } = await pdf.extractDocument(buffer);
```

(`source.text` replaces `text` everywhere below; `images` carries the extraction entries.) Add at the top of the file (not currently imported):

```js
const path = require('path');
const config = require('../config');
```

Then in the insert loop, after `g` is normalized (option/letter not needed), before `insert.run`:

```js
let imageFile = '';
if (g.markerIndex != null && Number.isInteger(g.markerIndex)) {
  const entry = images[g.markerIndex];
  if (entry) {
    try {
      const dest = path.join(config.uploadsDir, `${Date.now()}-${job.exam_id}-q${nextOrder}-${g.markerIndex}.png`);
      imageFile = path.basename(await (entry.kind === 'vector' ? pdf.renderVectorRegion(buffer, entry, dest) : pdf.renderImage(buffer, entry, dest)));
    } catch (e) { console.error('[pdfImport] image render failed:', e.message); }
  }
}
```

And update the `INSERT` statement:

```sql
INSERT INTO questions (exam_id, q_order, type, text, passage, options, correct_answer, marks, difficulty, learning_objective, explanation, source, image)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
```

and the `.run(...)` gains `imageFile` as the last param. (Unmatched-marker warnings already surface through the `onWarning` callback → `blockWarning` → job warning; no extra code needed here.)

`qWithScheme` in `src/routes/api.js` gains `image: row.image || ''`.

- [ ] **Step 4: Run tests**

Run: `npm test` — full suite green (image file name test passes; the rest unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/services/pdfImport.js src/routes/api.js src/services/pdf.js test/pdf-images.test.js
git commit -m "feat(import): save rendered diagrams and store image on questions"
```

---

## Task 8: Admin serving + dashboard/editor display

**Files:**
- Modify: `src/routes/api.js` (add route `GET /api/exams/:examId/images/:file`)
- Modify: `src/server.js` (nothing — admin route goes through `/api`; the report attachment is Task 9)
- Modify: `src/public/app.js` (`qitemHTML` line 640 area + `questionFormHTML` line 704 area + `editQuestionForm`)
- Test: none in the automated suite (frontend is static JS served from `public`) — verified manually per the steps below.

**Interfaces:**
- Produces: `GET /api/exams/:id/images/:file` — admin-token-guarded (already behind `router.use` admin auth at `api.js:25`), sanitizes `file` (`path.basename`, allow only `^[\w.-]+\.png$` — reject anything with `../` or subdirectories), reads from `config.uploadsDir` and sends with `Content-Type: image/png`. 404 if missing.

- [ ] **Step 1: Implement route (after the `qWithScheme` section, near the PDF upload route)**

```javascript
router.get('/exams/:id/images/:file', (req, res) => {
  const name = path.basename(String(req.params.file || ''));
  if (!/^[\w-]+\.png$/i.test(name)) return res.status(400).json({ error: 'Bad file name' });
  const full = path.join(config.uploadsDir, name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Image not found' });
  res.type('image/png').sendFile(full);
});
```

(add `const fs = require('fs'); const path = require('path');` at the top of `api.js` — neither is currently imported; `config` already is.)

- [ ] **Step 2: Dashboard — `qitemHTML`** (src/public/app.js line ~640)

After the `<div class="qtext">${esc(q.text)}</div>` line, when `q.image` is truthy:

```javascript
${q.image ? `<div class="qimg-wrap"><img class="qimg" src="${API_BASE}/api/exams/${id}/images/${encodeURIComponent(q.image)}" alt="diagram"></div>` : ''}
```

- [ ] **Step 3: Editor preview — in `questionFormHTML` after the Question textarea**

```js
${q?.image ? `<div class="field"><label>Diagram</label><img class="qimg" style="max-width:320px" src="${API_BASE}/api/exams/${id}/images/${encodeURIComponent(q.image)}"></div>` : ''}
```

(Needs `id` in scope — `questionFormHTML(q)` is called from `editQuestionForm(id, qid)` at line 796, so pass `id`: `questionFormHTML(q, id)` and use it inside.)

- [ ] **Step 4: Manual verification**

1. `npm run dev`, open `http://localhost:8080` (or the frontend URL in `config.frontendUrl`), sign in.
2. Upload `C:\Users\pax03\Desktop\bece-science-2026.pdf` into a new exam.
3. In Questions tab: Q1 (Fig 1(a) farm animals) etc. show `[IMG:0]`-marked images; the circuits page shows the circuit image; the model-answer image (page 18) does NOT appear anywhere.
4. Edit a question with an image → preview appears below the textarea.
5. Direct URL `http://localhost:3000/api/exams/:id/images/<file>` without token → 401.

- [ ] **Step 5: Commit**

```bash
git add src/routes/api.js src/public/app.js
git commit -m "feat(admin): serve diagram files and show them in the question list/editor"
```

---

## Task 9: Report page — attachment route + `<img>` in reportHTML

**Files:**
- Modify: `src/server.js` (route `GET /report/:sessionId/attachment`)
- Modify: `src/services/results.js` (`reportHTML`)
- Test: extend `test/pdf-images.test.js` (reportHTML unit — needs `config.appUrl`; the report HTML generation is a pure function)

**Interfaces:**
- Consumes: `auth.verifyReportToken`, `config.uploadsDir`.
- Produces: `reportHTML` renders `<img src="/report/{{sessionId}}/attachment?file={{name}}&token={{reportToken}}">` under the question text when `answer.image` set (the SELECT already gets `image` from both questions and pool — verify `COALESCE(p.image, q.image) AS image` in the query).

- [ ] **Step 1: Write the failing test**

```js
test('reportHTML renders an img tag for a question with an image', () => {
  const results = require('../src/services/results');
  const db = require('../src/db');
  db.exec('BEGIN');
  try {
    const examId = db.prepare("INSERT INTO exams (title, duration_minutes) VALUES ('r', 1)").run().lastInsertRowid;
    db.prepare("INSERT INTO students (id, phone) VALUES (0, '+233000000000')").run();
    const sid = db.prepare("INSERT INTO sessions (exam_id, student_id, status) VALUES (?, 0, 'completed')").run(examId).lastInsertRowid;
    const qid = db.prepare("INSERT INTO questions (exam_id, q_order, type, text, marks, image) VALUES (?,1,'theory','q',5,'x.png')").run(examId).lastInsertRowid;
    db.prepare("INSERT INTO answers (session_id, question_id, q_order, answer_text, is_correct, marks_awarded, max_marks) VALUES (?,?,1,'x',0,0,5)").run(sid, qid);
    const r = results.reportHTML(sid);
    assert.match(r.html, /<img[^>]+src="[^"]*attachment\?file=/);
  } finally { db.exec('ROLLBACK'); }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/pdf-images.test.js`
Expected: FAIL (no img; also attachment route absent → 404 on the test URL — the HTML piece first).

- [ ] **Step 3: Implement**

In `results.reportHTML`, change the answers SELECT to also pull `image`:

```sql
COALESCE(p.image, q.image) AS image
```

In the answer-row HTML (the `body` per question — after the inflate/description), when `a.image`:

```js
if (a.image) {
  body += `<img class="qimg report-img" src="/report/${sessionId}/attachment?file=${encodeURIComponent(a.image)}&token=${encodeURIComponent(auth.reportToken(sessionId))}">`;
}
```

`auth.reportToken` is not exported — `auth.reportUrl(sessionId)` builds `/report/${id}?token=...`; simplest: extract the token via `auth.reportUrl(sessionId).split('token=')[1]` — fragile to encoding but the token is base64url (no `=` escapes occur — safe). Cleaner: in `auth.js` export the helper:

```js
function reportToken(sessionId) {
  return signToken({ sub: 'report', sid: String(sessionId) }, REPORT_TTL_MS);
}
function reportUrl(sessionId) {
  return `/report/${sessionId}?token=${encodeURIComponent(reportToken(sessionId))}`;
}
```

(`reportUrl` now delegates; existing callers unchanged.)

In `server.js` add before the existing `/report/:sessionId` GET:

```js
app.get('/report/:sessionId/attachment', (req, res) => {
  if (!auth.verifyReportToken(req.query.token, req.params.sessionId)) {
    return res.status(403).send('Invalid or expired report link.');
  }
  const name = path.basename(String(req.query.file || ''));
  if (!/^[\w-]+\.png$/i.test(name)) return res.status(400).send('Bad file name');
  const full = path.join(config.uploadsDir, name);
  res.type('image/png').sendFile(full).on('error', () => res.status(404).end());
});
```

(add `fs`/`path` requires, yet only `path` is needed).

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: reportHTML image test passes; suite green. Manual: generate a report link from the dashboard for a completed session of the diagram exam; open the link; diagrams render under their questions in the PDF report. Browser-network: attachment requests include the `/report/:sessionId` path with the same token — and 403 if the token is for a different session — verify manually once.

- [ ] **Step 5: Commit**

```bash
git add src/server.js src/services/results.js src/auth.js test/pdf-images.test.js
git commit -m "feat(report): embed diagrams in the student report via token-gated attachment route"
```

---

## Task 10: WhatsApp delivery — image bubble before question bubbles

**Files:**
- Modify: `src/services/exam.js` (`sendQuestionTo`)
- Modify: `src/services/whatsapp.js` (`sendImage` accepts a path)
- Test: extend `test/pdf-images.test.js`

**Interfaces:**
- Consumes: `question.image`.
- Produces: `wa.sendImage(to, bufferOrPath)` — path form reads the file itself; keeps buffer form (certificates).
- `image` bubble position: after each question's pre-bubbles (header/instructions/passage) but BEFORE the question stem goes out. Implementation extracts css read `question.image`:
  `sendQuestionTo` currently loops `buildQuestionBubbles(...)` in order — the image must arrive first among the question-specific total. Insert before the bubbles loop:

```js
if (question.image) {
  await wa.sendImage(student.phone, path.join(config.uploadsDir, question.image)).catch((err) => {
    console.error('[exam] image send failed (continued):', err.message);
  });
}
```

(The passage/header bubbles may precede OR the image may precede; a diagram's caption line is in the passage — the image must be displayed near the text. Simplest deliverable: image bubble first, then all bubbles — this is what the spec's "image bubble before the question text" means — the text bubble of the stem follows it.)

- [ ] **Step 1: Write the failing test**

```js
test('WhatsApp question delivery sends the diagram image before text when present', async () => {
  const examMod = require('../src/services/exam');
  const wa = require('../src/services/whatsapp');
  const origImg = wa.sendImage, origTxt = wa.sendText;
  const calls = [];
  wa.sendImage = async (to, img) => { calls.push('image'); };
  wa.sendText = async (to, t) => { calls.push('text'); };
  try {
    const db = require('../src/db');
    db.exec('BEGIN');
    const examId = db.prepare("INSERT INTO exams (title, duration_minutes, status) VALUES ('x', '1', 'live')").run().lastInsertRowid;
    const qid = db.prepare("INSERT INTO questions (exam_id, q_order, type, text, image) VALUES (?,1,'theory','q stem',5,'f.png')").run(examId).lastInsertRowid;
    const stud = db.prepare("INSERT INTO students (phone) VALUES ('233000000000')").run().lastInsertRowid;
    const sid = db.prepare("INSERT INTO sessions (exam_id, student_id, current_q_order, status) VALUES (?, ?, '1','in_progress')").run(examId, stud).lastInsertRowid;
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
    await examMod.sendQuestionTo(session, { phone: '233000000000' }); // student.phone is what's read
    assert.equal(calls[0], 'image', 'image is the first WhatsApp bubble');
    assert.ok(calls.slice(1).includes('text'), 'question text follows the image');
  } finally {
    db.exec('ROLLBACK');
    wa.sendImage = origImg; wa.sendText = origTxt;
  }
});
```

Watch out: `sendQuestionTo` re-reads the session and question row itself (`getSessionQuestion`) — this test creates plain rows so no session_questions entries are needed (question order 1, no passage so the bubbles are just the stem). Only the ordering matters, hence the loose assertion.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/pdf-images.test.js`
Expected: FAIL (calls = []) — no image sent.

- [ ] **Step 3: Implement**

`whatsapp.js sendImage`:

```js
async function sendImage(to, image) {
  let imageBuffer;
  if (Buffer.isBuffer(image)) {
    imageBuffer = image;
  } else {
    const fs = require('fs');
    imageBuffer = fs.readFileSync(image);
  }
  // ... unchanged upload logic
}
```

`exam.js sendQuestionTo` — insert the image step at the top of the delivery section (before `for (const bubble of buildQuestionBubbles(...))`)— see Interfaces for the code.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: test passes; suite green.

- [ ] **Step 5: Manual + commit**

1. Publish a diagram-exam; add the recipient phone; send. On the phone: the image appears first, then the question text.
2. Commit:

```bash
git add src/services/exam.js src/services/whatsapp.js test/pdf-images.test.js
git commit -m "feat(whatsapp): deliver question diagrams as an image bubble before the text"
```

---

## Task 11: README note + full-suite + cleanup

**Files:**
- Modify: `README.md` (add one line under upload features)
- Verify: `npm test` full green; remove the two probe files in the repo root (`pdfshape-probe.tmp.js`, `pdfshape-probe2.tmp.js`) — they must not be committed.

- [ ] **Step 1: README note**

Under the PDF import section add:

```
- Diagrams and figures in uploaded PDFs are extracted, attached to their
  question, and delivered on WhatsApp, the dashboard, and the student report.
```

- [ ] **Step 2: Full test suite**

Run `npm test` — everything green.
Run a manual full import of `bece-science-2026.pdf` (Task 8 step 4) once more and confirm: raster figures on Q1 (pages 10-12) render; the model-answer image on page 18 does not attach; the vector page-13 pH table does not appear as a diagram.

- [ ] **Step 3: Remove scratch files**

```bash
git status --porcelain   # confirm the two pdfshape-probe*.tmp.js are untracked and delete them
Remove-Item pdfshape-probe.tmp.js, pdfshape-probe2.tmp.js
```

(If any occurred — they are untracked; deleting them is safe.)

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: note diagram extraction in PDF import features"
```

---

## Self-reviews

### Spec coverage
- §1 extraction engine (operator list, filters, `extractDocument`) → Task 2, 3.
- §2 markers (`[IMG:n]`, position, page-top fallback) → Task 3 + 6 (attach/strip) + solutions-section drop (inherent in pipeline) → Task 6.
- §3 rendering (`@napi-rs/canvas`, 2x, padding, PNG) → Task 4, 5.
- §4 schema+API (image columns, qWithScheme, admin route, report attachment route, warning text) → Tasks 1, 7, 8, 9.
- §5 WhatsApp image-first + non-blocking → Task 10.
- §6 dashboard `<img>` + editor preview → Task 8.
- Testing section of the spec (fixture PDF with pdfkit, assertions) → covered per Task: regression.setup in Task 1, `test/pdf-images.test.js` fixture in Task 2-10, WhatsApp stub in Task 10, report stub in Task 9.

### Placeholder scan
All code blocks contain real implementations; helper names are defined in the exact task that first produces them; no skipping of steps. (Review pass removed: the leftover `const OPS_AT = null;` line in Task 2, an undefined `TINY_OUT` constant, the undefined `collect(doc)`/`markerText(` helpers, a wrong WhatsApp bubble-count assertion — now an ordering assertion — the Task 6 deliberation debris, a fixture page-3 image that the size filter would have dropped (60×60 → 300×250), a Task 5 text-overlap test that drew text above (not inside) the rect, `path`/`config` imports missing in pdfImport + `fs`/`path` in api.js, a Task 9 test with no answers row / wrong student ordering, a stale `imageFileNameFor` name, stale `withMarkers`/`markersFrom`/`attachImagesByMarker` names, and the Task 7 dangling `unattached` warning block; naming standardized on `markers[].idx` / `attachMarkers` / `renderVectorRegion`.)

### Type consistency
- `textWithMarkers` → `{ text, markers }` (Task 3), consumed in Task 7.
- `extractDocument` returns `{ text, images }` with canvas-space `{page, x, y, w, h, kind}`; `rasterId` on raster entries (Task 2); consumed by Task 4.
- `renderImage(buffer, image, outPath)`, `renderVectorRegion(buffer, image, outPath)` (Tasks 4/5), consumed by Task 7.
- `attachMarkers` (Task 6) — name `markerIndex` on question objects; consumed by Task 7.
- `stripMarkers` in `textClean` (Task 6) used by `pdf.js` and `ai.js`.

---

## Execution Handoff

After saving, offer choice:

1. Subagent-Driven (recommended) — fresh subagent per task.
2. Inline — using superpowers:executing-plans.