# Math Marker Rendering and Image Answer Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find out why one PDF's math renders wrong, fix the question image path, and make the answer pipeline report what it actually did instead of failing silently.

**Architecture:** Two separable defects. The **measurement** half instruments the PDF pipeline so the next failing PDF is diagnosed from a log rather than a guess. The **image capture** half is a definite bug — the manual question route drops `q.image` — and is fixed independently.

**Tech Stack:** Node.js >= 22.5, CommonJS, `node:sqlite`, Express 4, `node:test` + `node:assert/strict`, Puppeteer (already a dependency for PDF rendering).

## The Defects

| # | Location | Defect |
|---|---|---|
| 1 | `src/routes/api.js:648-655` | The manual question INSERT lists `exam_id, q_order, type, text, correct_answer, marks` and silently omits `q.image`. A hand-added question with an image loses it. `ALL ?` binds the array as one parameter, so any change here must be verified against the actual driver behaviour. |
| 2 | `src/services/pdf.js` | Math rendering is unverified. No log says whether a marker was found, how many failed, or whether the page rendered at all. |
| 3 | `src/services/ai.js` | Import failures return partial or empty results with no record of which page or marker broke. |
| 4 | `src/services/pdfImport.js` | Image attachment is best-effort and silent. A missing file or a failed upload leaves the question with no image and no warning. |

## Why Measurement Comes First

The exact PDF regression was never supplied, so the failing input is unknown.
Picking a fix now would be guessing. The instrumented pipeline identifies
whether the marker is missing, the render is blank, or the upload fails — three
different fixes — from the next run's log. The `q.image` bug is different: it is
reproducible from the code alone, so it ships now and does not wait.

## Global Constraints

- Diagnostics are log-only. No new columns, no new tables, no schema change.
- Logging must be gated so `SEED_ON_BOOT` and CI runs stay quiet. Use `process.env.PDF_DIAG === '1'` for per-page detail and always log the one-line summary at `warn` on failure.
- Never log the full PDF text. Log markers, counts and page numbers.
- Attachment failures must be visible but must not abort the import. A student
  getting a question without its image is bad; losing the whole exam is worse.
- No new dependencies — Puppeteer is already present.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/services/pdf.js` | Render diagnostics: marker found/failed, page count, blank detection |
| `src/services/pdfImport.js` | Per-page import outcome, attachment outcome |
| `src/routes/api.js` | The `q.image` insert fix |
| `test/image-answers.test.js` | Extend for the `q.image` fix |
| `package.json` | No change expected — confirm the suite is already registered |

---

## Task 1: Instrument PDF rendering

**Files:**
- Modify: `src/services/pdf.js` (the marker-replacement and page-render sites)

**Interfaces:**
- Consumes: `process.env.PDF_DIAG`.
- Produces: a diagnostic object from the render entry point, and one `warn` line per failed marker.

- [ ] **Step 1: Read the render path before changing it**

Run: `Select-String -Path src/services/pdf.js -Pattern "^function|^async function|marker|renderP|page\." -Context 0,2`
Expected: the marker list, the replacement loop, and the page render call.
Read the whole file — the diagnostic has to describe what this file actually
does, and guessing at function names here produces instrumentation that never
fires.

- [ ] **Step 2: Add the diagnostics to the render entry point**

Add at the top of the file:

```js
// PDF render diagnostics. Set PDF_DIAG=1 for per-page detail. Failure
// summaries always log, because a silently blank math page is the hardest
// class of bug to notice from a student's screenshot alone.
const DIAG = process.env.PDF_DIAG === '1';
function diag(...args) { if (DIAG) console.log('[pdf:diag]', ...args); }
```

In the marker loop, record each outcome:

```js
      const found = pageContent.includes(marker);
      if (found) {
        replaced++;
        // ... existing replacement, unchanged ...
      } else {
        missing.push({ page: pageNumber, marker });
        diag('marker not found', { page: pageNumber, marker });
      }
```

After the loop:

```js
  if (missing.length) {
    console.warn(`[pdf] ${missing.length}/${totalMarkers} math markers not found`, missing);
  }
  if (DIAG) {
    console.log('[pdf:diag] summary', { pages: pageCount, totalMarkers, replaced, missing: missing.length });
  }
```

- [ ] **Step 3: Detect a blank render**

The most common invisible failure is a page that rendered to nothing. After the
page buffer is produced, and only when `DIAG` is set (the check costs real
time), log its size:

```js
  if (DIAG) {
    const kb = Math.round((buffer ? buffer.length : 0) / 1024);
    if (kb < 5) console.warn(`[pdf] page ${pageNumber} rendered to ${kb}KB — likely blank`, { page: pageNumber, kb });
    else diag('page ok', { page: pageNumber, kb });
  }
```

- [ ] **Step 4: Exercise it against the real pipeline**

Find a PDF in the repo or ask the user for the failing one. Render it with the
diagnostics on:

```bash
$env:PDF_DIAG="1"; node -e "require('./src/services/pdf').renderToImages('<path-to.pdf>', './data/_diag')"
```

Expected: a `[pdf:diag] summary` line with real counts. If `missing` is
non-zero, the marker list in `pdf.js` does not match this document's encoding —
that is the bug, and it is now visible instead of guessed.

**Stop and report to the user here if a marker is missing.** The fix depends
on which marker and which page, and guessing would be exactly the failure mode
this task exists to prevent.

- [ ] **Step 5: Commit**

```bash
git add src/services/pdf.js
git commit -m "feat(pdf): log which math markers were found and which were not

A silently blank math page is close to invisible from a student's
screenshot. Marker misses and near-empty page renders now warn; per-page
detail is behind PDF_DIAG=1 so normal runs stay quiet."
```

---

## Task 2: Log the import outcome per page

**Files:**
- Modify: `src/services/pdfImport.js`

**Interfaces:**
- Consumes: the per-page image paths from Task 1's render.
- Produces: one summary `warn` when any page or attachment fails.

- [ ] **Step 1: Read the import loop**

Run: `Select-String -Path src/services/pdfImport.js -Pattern "for|await|attach|image" -Context 0,2`
Expected: the per-question loop and where the image is attached. Read the whole
function.

- [ ] **Step 2: Count successes and failures instead of swallowing them**

Wherever the loop currently discards an error, collect instead:

```js
  const failures = [];
  // ... inside the per-question loop, on the image attach step:
  try {
    await attachImage(questionId, imagePath);
  } catch (err) {
    // The question is still imported — losing the image is recoverable,
    // losing the exam is not. But it must be visible.
    failures.push({ questionId, imagePath, error: err.message });
  }
  // ... after the loop:
  if (failures.length) {
    console.warn(`[pdf-import] ${failures.length} image attachment(s) failed`, failures);
  }
```

If the existing code already has a `try/catch` around the attach, extend that
one rather than adding a second.

- [ ] **Step 3: Warn when a page produced no questions**

```js
  if (pageQuestionCount === 0) {
    console.warn(`[pdf-import] page ${pageNumber} produced 0 questions — check markers and page size`, { page: pageNumber });
  }
```

- [ ] **Step 4: Commit**

```bash
git add src/services/pdfImport.js
git commit -m "feat(pdf-import): report failed image attachments and empty pages

Import continues on failure — a missing image is recoverable, a missing
exam is not — but every failure is now counted and logged."
```

---

## Task 3: Fix the dropped `q.image`

The one defect reproducible from the code alone.

**Files:**
- Modify: `src/routes/api.js:648-655`
- Modify: `test/image-answers.test.js`

**Interfaces:**
- Consumes: `req.body.image`.
- Produces: the image persisted on manually created questions.

- [ ] **Step 1: Read the route**

Run: `Select-String -Path src/routes/api.js -Pattern "INSERT INTO questions" -Context 6,6`
Expected: the manual question insert. Read the surrounding handler to see the
validation already in place.

- [ ] **Step 2: Write the failing test**

`test/image-answers.test.js` has **no HTTP harness** — it calls services and
`db` directly, and there is no supertest or light-my-request in the project.
Write the test in that style. Append to `test/image-answers.test.js`:

```js
test('a manually inserted question keeps its image', () => {
  const eid = db
    .prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES ('Img','M',10,'published')")
    .run().lastInsertRowid;
  // Mirror exactly what src/routes/api.js:648-655 binds, so this test fails
  // for the same reason the route fails.
  db.prepare(
    `INSERT INTO questions (exam_id, q_order, type, text, correct_answer, marks, image)
     VALUES (?,?,?,?,?,?,?)`
  ).run(eid, 1, 'objective', 'What is 2+2?', 'A', 1, 'data/exams/uploads/q1.png');
  const row = db.prepare('SELECT image FROM questions WHERE exam_id = ? AND q_order = 1').get(eid);
  assert.equal(row.image, 'data/exams/uploads/q1.png', 'image must survive the insert');
});
```

**This test proves the schema accepts the column, not that the route uses it.**
That is deliberate: the route is covered by the manual verification in Step 5,
and a green test here must not be mistaken for a green route. The real
assertion is that Step 5's `curl` shows the image in the created question.

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/image-answers.test.js`
Expected: FAIL — `row.image` is `null`.

- [ ] **Step 4: Fix the insert**

Replace `src/routes/api.js:648-655` so the column list, the placeholder count
and the bound array all move together:

```js
  db.prepare(
    `INSERT INTO questions (exam_id, q_order, type, text, correct_answer, marks, image)
     VALUES (?,?,?,?,?,?,?)`
  ).run(examId, body.q_order, body.type, body.text, body.correct_answer, marks, body.image || null);
```

**The `ALL ?` trap.** If the existing code binds an array as a single
parameter — `db.prepare(...).run(values)` — then changing the column list
without changing the binding produces a parameter-count error at runtime, not
at parse time. The fix above binds each value explicitly, which is why it is
written out longhand rather than with a spread. Verify by running the test,
not by reading it.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/image-answers.test.js`
Expected: PASS.

- [ ] **Step 6: Audit every other question insert for the same omission**

Run: `Select-String -Path src,test -Pattern "INSERT INTO questions" -Context 0,4`
Expected: every insert lists the columns it binds. `pdfImport.js` is the other
writer and already handles images — confirm rather than assume. Any third
writer is a bug of the same kind.

- [ ] **Step 7: Commit**

```bash
git add src/routes/api.js test/image-answers.test.js
git commit -m "fix(api): persist image on manually created questions

The manual question INSERT omitted the image column, so a hand-added
question silently lost its diagram. Binds each value explicitly rather
than relying on array binding, so the parameter count cannot drift from
the column list."
```

---

## Task 4: Confirm the answer pipeline accepts and reports images

**Files:**
- Modify: `test/image-answers.test.js` only, unless a failure reveals a source defect.

**Interfaces:**
- Consumes: `results.js` image handling.
- Produces: proof that a stored image reaches the results view, and an
  explicit failure message when it does not.

- [ ] **Step 1: Read the image path in results**

Run: `Select-String -Path src/services/results.js,src/routes/api.js -Pattern "\.image" -Context 0,2`
Expected: the query and the response field that carry the image to the view.

- [ ] **Step 2: Write the end-to-end test**

```js
test('a stored question image survives into the results row', () => {
  const eid = db
    .prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES ('Img2','M',10,'published')")
    .run().lastInsertRowid;
  const sid = db.prepare("INSERT INTO students (phone, name) VALUES ('23399900001','K')").run().lastInsertRowid;
  db.prepare('INSERT INTO exam_recipients (exam_id, student_id) VALUES (?,?)').run(eid, sid);
  const ssid = db.prepare('INSERT INTO sessions (exam_id, student_id) VALUES (?,?)').run(eid, sid).lastInsertRowid;
  const qid = db
    .prepare("INSERT INTO questions (exam_id, q_order, type, text, correct_answer, marks, image) VALUES (?,1,'objective','Graph?','A',1,'g.png')")
    .run(eid).lastInsertRowid;
  db.prepare('INSERT INTO session_questions (session_id, question_id, q_order) VALUES (?,?,1)').run(ssid, qid);
  db.prepare("INSERT INTO answers (session_id, question_id, q_order, answer_text) VALUES (?,?,1,'A')").run(ssid, qid);

  const rows = results.getResults(ssid);
  const hit = rows.questions.find((q) => q.image);
  assert.ok(hit, 'the image must reach the results row');
  assert.equal(hit.image, 'g.png');
});
```

Use the real accessor. Read Step 1's output for the actual export name and
result shape — if it returns an array of sessions rather than `{ questions }`,
adapt the assertion to that shape. Do not add a wrapper function just to make
this test's shape work.

- [ ] **Step 3: Run the test**

Run: `node --test test/image-answers.test.js`
Expected: PASS.

This is a schema-level assertion, so it passes whether or not `results.js` is
correct. That is the point: the schema is the contract, and the route and the
results payload are verified by inspection in Steps 1 and 5.

- [ ] **Step 4: Verify the real payload by hand**

```bash
npm start
# create a published exam, import or add one question with an image,
# assign and complete a session, then:
curl -s http://localhost:3000/api/exams/<id>/results -H "Authorization: Bearer $TOKEN"
```

Expected: the question object in the response has a non-null `image` whose
value matches what was stored. If it does not, the defect is in `results.js` —
fix it there and say so in the commit.

- [ ] **Step 4: Commit**

```bash
git add test/image-answers.test.js
git commit -m "test: prove a stored question image reaches the results payload"
```

---

## Task 5: Full-suite verification

**Files:**
- None.

- [ ] **Step 1: Run everything**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 2: Confirm diagnostics are quiet by default**

Run: `node src/server.js --init`
Expected: no `[pdf:diag]` output unless `PDF_DIAG=1`. Diagnostics that are
always on become noise, and noise gets ignored.

- [ ] **Step 3: Confirm the suite registration**

Run: `Select-String -Path package.json -Pattern "image-answers"`
Expected: present. If it is missing, the image tests have never run in CI —
add it, and check whether `test/sentence-merging.test.js` is also missing.

---

## Verification

```bash
npm test
git status --short
```

1. Add a question through the admin form with an image. Reload the edit page.
   Expected: the image is still there. Before Task 3 it disappeared.
2. Import a PDF containing math with `PDF_DIAG=1`.
   Expected: a summary with pages, total markers, replaced, missing.
3. Import a PDF with a deliberately broken image path.
   Expected: the exam still imports, and a `[pdf-import] N image
   attachment(s) failed` warning names the question and path.
4. Take an exam containing an image question and open the results.
   Expected: the image renders for the student and for the admin.

## Rollback

Revert the five commits. No schema change, no data migration — the diagnostics
are logs, and the `q.image` fix only starts persisting a value that was being
dropped. Questions that already lost an image during the bug's lifetime are not
recoverable; that data was never written.

## Out of Scope

- Linearizing math to Unicode or text. WhatsApp is the delivery target and
  renders an image correctly; a text conversion is a separate, larger project.
- LaTeX rendering, equation editors, or an image cropper.
- Changing the AI question parser.
- Dashboard and report math. The WhatsApp path is the one that was broken.
- Performance optimisation of the render. The diagnostic size check runs only
  under `PDF_DIAG=1` for exactly this reason.
