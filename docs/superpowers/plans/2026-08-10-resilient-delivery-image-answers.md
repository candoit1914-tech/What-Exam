# Resilient Delivery & Image Answers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept WhatsApp photo (written/drawn) answers for theory questions with AI-vision-then-manual grading, carry theory-section passages from PDFs, recover abruptly-stopped exams into reports + certificates on restart, and strip watermarks without ever blocking delivery.

**Architecture:** Image messages flow through the existing webhook → `examService.handleInbound` → `processAnswer` → `handleAnswer` pipeline; the photo is downloaded via the WhatsApp Media API, re-encoded to PNG under `data/uploads`, stored on the answer row (`answers.answer_image`), and graded by a vision-capable AI call (gated by `AI_VISION`) with automatic fallback to `needs_review`. Stale in-progress sessions are finalized at boot by a new `finalizeStaleSessions()` that reuses the existing `finalize(session, student, 'expired')` path (report + certificate + WhatsApp result). Theory passages already ride the existing `curPassage` carry-forward in `pdfImport`; a regression test locks this in. Watermark stripping is broadened in `textClean`; nothing is ever blocked.

**Tech Stack:** Node 22+ (`node:sqlite`, `node:test`), Express, WhatsApp Cloud API (v21.0), OpenAI-compatible chat completions, `@napi-rs/canvas`, pdfjs-dist.

## Global Constraints

- Node 22.5+ requirement; `npm test` = `node --test test/regression.test.js test/pdf-images.test.js` — every new test file MUST be appended to the `test` script in `package.json`.
- `answers.answer_text` stays `NOT NULL` — a photo answer stores the caption or `'(photo answer)'`.
- Photo filenames MUST match the report attachment regex `^[\w-]+\.png$` (served by `server.js:43`) — always `<sessionId>-<qOrder>-<epoch>.png`.
- AI marking errors must NEVER block the exam (existing invariant; "errors never block the exam").
- The `answers` table was rebuilt once already (question-FK removal, `db.js:200-236`); extend that migration — do not create a second rebuild.
- All `answers` INSERTs in `src/services/exam.js` must keep column order in sync with the table.
- Certificate generation is best-effort and must never break finalize (`exam.js:918-922`).
- WhatsApp media links expire in hours — download immediately inside the webhook-handling path.
- Config additions go in `src/config.js` AND `.env.example` (with `your_`-style placeholder so `valid()` treats it as unset).

---

### Task 1: Schema — `answers.answer_image` column

**Files:**
- Modify: `src/db.js` (~line 194 ensureColumn block, ~lines 205-236 legacy migration)
- Test: `test/image-answers.test.js` (create)

**Interfaces:**
- Consumes: `ensureColumn(table, column, ddl)` helper at `db.js:183`.
- Produces: `answers.answer_image TEXT DEFAULT ''` available on all `SELECT * FROM answers` rows ('' = no photo).

- [ ] **Step 1: Create the test file and the failing test**

Create `test/image-answers.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');

test('answers table has the answer_image column', () => {
  const cols = db.prepare("PRAGMA table_info('answers')").all().map((c) => c.name);
  assert.ok(cols.includes('answer_image'), `expected answer_image in columns: ${cols.join(', ')}`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/image-answers.test.js`
Expected: FAIL — `answer_image` missing from columns.

- [ ] **Step 3: Add the column + migrate legacy rows**

In `src/db.js`, after the existing `ensureColumn('answers', 'ai_detected', ...)` line (~line 194), add:

```js
ensureColumn('answers', 'answer_image', "TEXT DEFAULT ''");
```

Then update the legacy rebuild block (~lines 205-236). Find this comment and code:

```js
// Migration: answers.question_id used to be FK-constrained to questions().
```

Inside the block, the `CREATE TABLE answers` definition (~line 208) gains a column after `answer_text`:

```js
      answer_text   TEXT NOT NULL,
```

becomes

```js
      answer_text   TEXT NOT NULL,
      answer_image  TEXT DEFAULT '',
```

And the `INSERT INTO answers (id, session_id, ...)` copy list (~line 226) and the `SELECT` from `answers_legacy` (~line 229) both gain `answer_image`:

```js
    INSERT INTO answers
      (id, session_id, question_id, q_order, answer_text, answer_image, is_correct, marks_awarded,
       max_marks, marked_by, ai_feedback, needs_review, ai_detected, marked_at)
    SELECT
      id, session_id, question_id, q_order, answer_text, answer_image, is_correct, marks_awarded,
      max_marks, marked_by, ai_feedback, needs_review, ai_detected, marked_at
    FROM answers_legacy;
```

(Keep every other column exactly as it is today — only add `answer_image`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/image-answers.test.js`
Expected: PASS.

- [ ] **Step 5: Add the test file to the npm script**

In `package.json`, change:

```json
"test": "node --test test/regression.test.js test/pdf-images.test.js",
```

to:

```json
"test": "node --test test/regression.test.js test/pdf-images.test.js test/image-answers.test.js",
```

- [ ] **Step 6: Run the full suite and commit**

Run: `npm test`
Expected: all tests pass.

```bash
git add src/db.js test/image-answers.test.js package.json
git commit -m "feat(db): store answer_image on answers"
```

---

### Task 2: Config — `AI_VISION` flag

**Files:**
- Modify: `src/config.js` (`ai` section, ~line 45-50)
- Modify: `.env.example`

**Interfaces:**
- Produces: `config.ai.vision` — boolean, `false` when unset; referenced by `marking.markTheoryImageAnswer` in Task 4.

- [ ] **Step 1: Add the flag**

In `src/config.js`, inside the `ai` object after `timeoutMs`:

```js
    timeoutMs: parseInt(process.env.AI_TIMEOUT_MS || '120000', 10),
```

add:

```js
    vision: process.env.AI_VISION === 'true',
```

- [ ] **Step 2: Document it in .env.example**

Append (after the `AI_TIMEOUT_MS` line):

```
# Set to true only when AI_MODEL accepts image input (e.g. gpt-4o).
# Photo answers then get AI-vision grading; otherwise they are flagged
# for manual review on the dashboard.
AI_VISION=false
```

- [ ] **Step 3: Verify and commit**

Run: `node -e "const c=require('./src/config'); console.log('vision =', c.ai.vision)"` — upstream env must not flip it; it should print `vision = false` (unless `AI_VISION=true` is exported in your shell, which is fine).

```bash
git add src/config.js .env.example
git commit -m "feat(config): add AI_VISION flag for photo-answer grading"
```

---

### Task 3: WhatsApp client — image events + media download

**Files:**
- Modify: `src/services/whatsapp.js` — `parseWebhook` (~lines 269-297), exports (~lines 299-308)

**Interfaces:**
- Produces:
  - `parseWebhook(body)` now ALSO returns `{ type:'message', phone, messageId, timestamp, mediaType:'image', mediaId, body }` events for image messages (`body` = optional caption).
  - `downloadMedia(mediaId)` → `Promise<{ buffer: Buffer, mimeType: string }>`. Throws on Graph failure so callers can surface "please try again".
- Consumes: existing `request(url, { headers })` helper at `whatsapp.js:90` (uses `GRAPH` base `https://graph.facebook.com/v21.0` and the access token via `waHeaders()` — check how `request` is called by `sendText` at line 152 and mirror its `headers` argument).

- [ ] **Step 1: Write the failing tests**

Append to `test/image-answers.test.js`:

```js
const wa = require('../src/services/whatsapp');

test('parseWebhook returns an image event from an image message', () => {
  const body = {
    entry: [{ changes: [{ value: {
      messages: [{
        from: '233201234567', id: 'wamid.image.1', timestamp: '1750000000', type: 'image',
        image: { id: 'MEDIA_ID_1', caption: 'my written answer' },
      }],
    } }] }],
  };
  const ev = wa.parseWebhook(body).find((e) => e.type === 'message');
  assert.ok(ev, 'image message yields a message event');
  assert.equal(ev.mediaType, 'image');
  assert.equal(ev.mediaId, 'MEDIA_ID_1');
  assert.equal(ev.body, 'my written answer');
});

test('parseWebhook image event without caption has an empty body', () => {
  const body = {
    entry: [{ changes: [{ value: {
      messages: [{ from: '233201234567', id: 'wamid.image.2', timestamp: '1750000000', type: 'image',
        image: { id: 'MEDIA_ID_2' } }],
    } }] }],
  };
  const ev = wa.parseWebhook(body)[0];
  assert.equal(ev.mediaType, 'image');
  assert.equal(ev.body, '');
});

test('downloadMedia resolves buffer and mimeType through the Graph media URL', async () => {
  // Stub global.fetch: first call returns the media meta (an expiring URL),
  // second returns the bytes.
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ url: 'https://media.example.com/abc.jpg', mime_type: 'image/jpeg' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(Buffer.from([1, 2, 3, 4]), { status: 200 });
  };
  try {
    const out = await wa.downloadMedia('MEDIA_ID_1');
    assert.deepEqual([...out.buffer], [1, 2, 3, 4]);
    assert.equal(out.mimeType, 'image/jpeg');
    assert.match(calls[0].url, /\/MEDIA_ID_1$/);
    assert.ok(/Bearer /.test(calls[0].opts.headers.Authorization), 'token attached to the media request');
  } finally {
    global.fetch = original;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/image-answers.test.js`
Expected: FAIL — `mediaType` undefined / `downloadMedia is not a function`.

- [ ] **Step 3: Implement image events in parseWebhook**

In `parseWebhook` (lines 269-297), inside the `messages.map`, after `interactiveType`/`replyId`, add:

```js
      mediaType: m.type === 'image' ? 'image' : '',
      mediaId: m.type === 'image' ? m.image?.id || '' : '',
```

and after the `body:` line, append `mediaId` handling — change the `body` expression to also read the image caption:

```js
      body:
        m.text?.body ||
        (isInteractive ? m.interactive?.button_reply?.text || m.interactive?.list_reply?.title : '') ||
        (m.type === 'image' ? m.image?.caption || '' : ''),
```

- [ ] **Step 4: Implement downloadMedia**

Add a new function after `parseWebhook`:

```js
/**
 * Download inbound WhatsApp media (a student photo answer) by Graph media id.
 * GET /{mediaId} returns JSON with an expiring URL; the bytes come from the
 * second request. The access token is attached to both.
 */
async function downloadMedia(mediaId) {
  if (!mediaId) throw new Error('No media id');
  const meta = await request(`${GRAPH}/v21.0/${mediaId}`, {
    headers: waHeaders(),
    timeoutMs: 60000,
  });
  const url = meta?.url;
  if (!url) throw new Error(`WhatsApp media meta missing url: ${JSON.stringify(meta).slice(0, 200)}`);
  const res = await fetch(url, { headers: waHeaders() });
  if (!res.ok) throw new Error(`WhatsApp media download failed (${res.status})`);
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    mimeType: meta.mime_type || '',
  };
}
```

Check `waHeaders()` — if it does not exist, mirror exactly what `sendText` passes to `request` (read lines 150-160 and reuse that header object; name it `waHeaders()` if it is currently inline).

Add to `module.exports`:

```js
  downloadMedia,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/image-answers.test.js`
Expected: PASS (all 3 new tests + the Task-1 test).

- [ ] **Step 6: Commit**

```bash
git add src/services/whatsapp.js test/image-answers.test.js
git commit -m "feat(whatsapp): parse inbound image events and download media"
```

---

### Task 4: AI-vision theory marking with manual fallback

**Files:**
- Modify: `src/services/ai.js` — new exported `markImageTheory` (near `markTheory`, ~line 1268)
- Modify: `src/services/marking.js` — new exported `markTheoryImageAnswer` (after `markTheoryAnswer`, line ~189)

**Interfaces:**
- Consumes: `config.ai.vision` (Task 2); `config.uploadsDir`; `chatJSON(messages, opts)` (`ai.js:105`); `getScheme(questionId)` (`marking.js`); `fs.readFileSync`.
- Produces:
  - `ai.markImageTheory({ questionText, passage, modelAnswer, keyPoints, rubric, presentationMarks, grammarMarks, maxMarks, studentAnswer, imageBase64 })` → same shape as `markTheory`: `{ marksAwarded, maxMarks, breakdown, feedback, aiGenerated, aiReason }`.
  - `marking.markTheoryImageAnswer(question, studentAnswer, imageFile, scheme)` → `{ marksAwarded, maxMarks, needsReview, feedback, aiGenerated }`. `needsReview: true` whenever vision is unavailable or the AI call fails — it NEVER throws.

- [ ] **Step 1: Write the failing tests**

Append to `test/image-answers.test.js`:

```js
const marking = require('../src/services/marking');
const config = require('../src/config');

test('markTheoryImageAnswer flags for manual review when vision is off', async () => {
  const wasVision = config.ai.vision;
  config.ai.vision = false;
  try {
    const out = await marking.markTheoryImageAnswer(
      { id: 1, text: 'Draw the water cycle.', marks: 4, passage: '' },
      '(photo answer)', 'nonexistent.png', { model_answer: '', key_points: [], rubric: [], presentation_marks: 0, grammar_marks: 0 }
    );
    assert.equal(out.needsReview, true);
    assert.equal(out.marksAwarded, 0);
  } finally {
    config.ai.vision = wasVision;
  }
});

test('markTheoryImageAnswer flags for manual review when the AI call fails', async () => {
  const wasVision = config.ai.vision;
  const wasRead = require('fs').readFileSync;
  config.ai.vision = true;
  require('fs').readFileSync = () => 'fake-base64';
  const ai = require('../src/services/ai');
  const orig = ai.markImageTheory;
  ai.markImageTheory = async () => { throw new Error('vision endpoint exploded'); };
  try {
    const out = await marking.markTheoryImageAnswer(
      { id: 1, text: 'Draw the water cycle.', marks: 4, passage: '' },
      '(photo answer)', 'f.png', {}
    );
    assert.equal(out.needsReview, true, 'AI failure falls back to manual review');
  } finally {
    config.ai.vision = wasVision;
    require('fs').readFileSync = wasRead;
    ai.markImageTheory = orig;
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/image-answers.test.js`
Expected: FAIL — `markTheoryImageAnswer is not a function`.

- [ ] **Step 3: Implement `ai.markImageTheory`**

In `src/services/ai.js`, after the existing `markTheory` export-block function (place the function right before it), add:

```js
/**
 * Mark a theory answer delivered as a photo (written/drawn work). Vision
 * endpoints accept the image as an image_url content item. Called only when
 * config.ai.vision is enabled; text-only providers never reach this.
 */
async function markImageTheory({ questionText, passage, modelAnswer, keyPoints, rubric, presentationMarks, grammarMarks, maxMarks, studentAnswer, imageBase64 }) {
  if (!aiConfigured()) {
    throw new AIError('AI is not configured. Set AI_API_KEY and AI_BASE_URL in .env to mark theory questions.');
  }
  const user = [
    'Grade the student attempt below against the model answer and rubric.',
    '',
    'QUESTION:',
    [passage, questionText].filter(Boolean).join('\n\n'),
    '',
    `MODEL ANSWER: ${modelAnswer || '(not available)'}`,
    keyPoints && keyPoints.length ? `KEY POINTS: ${keyPoints.join('; ')}` : 'KEY POINTS: (none)',
    rubric && rubric.length ? `RUBRIC: ${rubric.join('; ')}` : 'RUBRIC: (none)',
    `PRESENTATION MARKS: ${presentationMarks}`,
    `GRAMMAR MARKS: ${grammarMarks}`,
    `MAX MARKS: ${maxMarks}`,
    '',
    'STUDENT ATTEMPT (the attached photo of their written/drawn work):',
    studentAnswer ? `Caption: ${studentAnswer}` : '',
    '',
    'Return JSON with: marksAwarded (number, 0..maxMarks), breakdown (array of {criterion, marks, comment}), feedback (string for the student), aiGenerated (true only if the photo clearly contains AI-produced text).',
  ].filter((l) => typeof l === 'string').join('\n');

  const messages = [
    { role: 'system', content: SYSTEM_BASE + '\nYou grade written/drawn answers shown in photos, fairly and strictly per the rubric.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: user },
        imageBase64
          ? { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } }
          : null,
      ].filter(Boolean),
    },
  ];
  return chatJSON(messages, { temperature: 0.2 });
}
```

Check that `chatJSON` passes the `content` array untouched into `callEndpoint`'s `body.messages` (read `ai.js:105-135` before committing — if it post-processes messages, the array must pass through as-is).

Add `markImageTheory,` to `module.exports` (the exports object near line 1329; keep alphabetical order with the other `mark*` entries).

- [ ] **Step 4: Implement `marking.markTheoryImageAnswer`**

In `src/services/marking.js`, after `markTheoryAnswer` (ends line 189), add:

```js
const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * Grade a photo (written/drawn) theory answer. With AI_VISION enabled the
 * image is sent to the vision-capable endpoint; any failure — or a text-only
 * provider — results in needsReview=true so the admin grades it manually.
 * Never throws.
 */
async function markTheoryImageAnswer(question, studentAnswer, imageFile, scheme) {
  const total = Number(question.marks) || 0;
  const review = { marksAwarded: 0, maxMarks: total, needsReview: true, feedback: 'Photo answer awaiting manual review.', aiGenerated: false };
  if (!config.ai.vision) return review;
  try {
    const full = imageFile && !path.isAbsolute(imageFile) ? path.join(config.uploadsDir, imageFile) : imageFile;
    const imageBase64 = fs.readFileSync(full).toString('base64');
    const sch = scheme || getScheme(question.id);
    const result = await ai.markImageTheory({
      questionText: question.text,
      passage: question.passage || '',
      modelAnswer: sch?.model_answer || '',
      keyPoints: sch?.key_points || [],
      rubric: sch?.rubric || [],
      presentationMarks: sch?.presentation_marks || 0,
      grammarMarks: sch?.grammar_marks || 0,
      maxMarks: total,
      studentAnswer,
      imageBase64,
    });
    return {
      marksAwarded: result.marksAwarded,
      maxMarks: result.maxMarks,
      breakdown: result.breakdown || [],
      feedback: result.feedback || '',
      aiGenerated: !!result.aiGenerated,
      aiReason: result.aiReason || '',
      needsReview: false,
    };
  } catch (err) {
    console.error('[marking] vision grading failed, flagged for manual review:', err.message);
    return review;
  }
}
```

Check the top of `marking.js` for existing `require('fs')` / `require('path')` / `require('../config')` imports (it already requires `ai` and `db`); only add the ones missing.

- [ ] **Step 5: Export it**

Add `markTheoryImageAnswer,` to `module.exports` in `marking.js` (the object ending line ~212).

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/image-answers.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/services/ai.js src/services/marking.js test/image-answers.test.js
git commit -m "feat(marking): vision-grade photo answers with manual-review fallback"
```

---

### Task 5: Exam engine — accept photo answers for theory

**Files:**
- Modify: `src/routes/webhook.js` (~lines 67-69)
- Modify: `src/services/exam.js` — `handleAnswer` theory branch (~lines 792-838); requires at top

**Interfaces:**
- Consumes: `wa.downloadMedia(mediaId)` (Task 3); `config.uploadsDir`; `@napi-rs/canvas`; the `answers` row shape of Task 1.
- Produces: theory answers with `answer_image` set; image answers on objective questions rejected with a warning.

- [ ] **Step 1: Write the failing tests**

Append to `test/image-answers.test.js`. Mirror the DB isolation pattern from `regression.test.js:279-313` (`db.exec('BEGIN')` / `ROLLBACK` in `finally`) and the module-stub pattern for `wa` (stub `downloadMedia`/`sendText`/`sendImage` on the `../src/services/whatsapp` module object — `exam.js` calls them through that object, so monkey-patching it works):

```js
const exam = require('../src/services/exam');
const marking = require('../src/services/marking');

// Real 2x2 PNG so downloadMedia stubs survive @napi-rs/canvas loadImage
// (a hand-crafted 4-byte buffer would take the "cannot receive" error path).
const { createCanvas } = require('@napi-rs/canvas');
const photoCanvas = createCanvas(2, 2);
const photoCtx = photoCanvas.getContext('2d');
photoCtx.fillStyle = '#3366ff';
photoCtx.fillRect(0, 0, 2, 2);
const PHOTO_PNG = photoCanvas.toBuffer('image/png');

function waStub(overrides = {}) {
  const orig = {};
  const target = require('../src/services/whatsapp');
  for (const key of ['downloadMedia', 'sendText', 'sendImage', 'sendResultMessage']) {
    orig[key] = target[key];
    if (overrides[key]) target[key] = overrides[key];
  }
  const markingKey = 'markTheoryAnswer';
  orig[markingKey] = marking[markingKey];
  marking[markingKey] = async () => ({ marksAwarded: 0, maxMarks: 1, breakdown: [], feedback: 'stub', aiGenerated: false });
  return () => {
    for (const key of Object.keys(orig)) {
      if (key === 'markTheoryAnswer') marking[key] = orig[key];
      else target[key] = orig[key];
    }
  };
}

test('photo answer is recorded with answer_image and advances the session', async () => {
  const db = require('../src/db');
  db.exec('BEGIN');
  const restore = waStub({
    downloadMedia: async () => ({ buffer: PHOTO_PNG, mimeType: 'image/png' }),
    sendText: async () => {},
    sendImage: async () => {},
    sendResultMessage: async () => {},
  });
  require('../src/config').exam.sendCertificates = false;
  try {
    const examId = db.prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES (?,?,?,'live')")
      .run('__photo_exam__', 'Test', 30).lastInsertRowid;
    const studentId = db.prepare("INSERT INTO students (phone) VALUES (?)")
      .run('__photo_phone__' + Date.now()).lastInsertRowid;
    db.prepare("INSERT INTO questions (exam_id, q_order, type, text, marks) VALUES (?,1,'theory','Draw and label the water cycle.',4)")
      .run(examId);
    const sessionId = db.prepare(
      "INSERT INTO sessions (exam_id, student_id, status, current_q_order, started_at, duration_minutes) VALUES (?,?,'in_progress',1,datetime('now'),30)"
    ).run(examId, studentId).lastInsertRowid;

    await exam.handleInbound(db.prepare('SELECT phone FROM students WHERE id = ?').get(studentId).phone, '', { mediaType: 'image', mediaId: 'M1' });

    const row = db.prepare('SELECT * FROM answers WHERE session_id = ? AND q_order = 1').get(sessionId);
    assert.ok(row, 'answer row created');
    assert.equal(row.answer_text, '(photo answer)');
    assert.match(row.answer_image, /^[\w-]+\.png$/, 'stored filename fits the attachment route regex');
  } finally {
    restore();
    db.exec('ROLLBACK');
  }
});

test('photo answer on an objective question is refused', async () => {
  const db = require('../src/db');
  db.exec('BEGIN');
  const sent = [];
  const restore = waStub({ sendText: async (phone, text) => { sent.push(text); } });
  try {
    const examId = db.prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES (?,?,?,'live')")
      .run('__photo_obj_exam__', 'Test', 30).lastInsertRowid;
    const studentId = db.prepare("INSERT INTO students (phone) VALUES (?)")
      .run('__photo_obj_phone__' + Date.now()).lastInsertRowid;
    db.prepare("INSERT INTO questions (exam_id, q_order, type, text, options, marks) VALUES (?,1,'objective','Pick A.',?,1)")
      .run(examId, JSON.stringify([{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }]));
    const sessionId = db.prepare(
      "INSERT INTO sessions (exam_id, student_id, status, current_q_order, started_at, duration_minutes) VALUES (?,?,'in_progress',1,datetime('now'),30)"
    ).run(examId, studentId).lastInsertRowid;

    await exam.handleInbound(db.prepare('SELECT phone FROM students WHERE id = ?').get(studentId).phone, '', { mediaType: 'image', mediaId: 'M2' });

    assert.equal(sent.length, 1, 'one warning message');
    assert.match(sent[0], /letter/i);
    const row = db.prepare('SELECT * FROM answers WHERE session_id = ? AND q_order = 1').get(sessionId);
    assert.equal(row, undefined, 'no answer recorded for the objective question');
  } finally {
    restore();
    db.exec('ROLLBACK');
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/image-answers.test.js`
Expected: FAIL — image events rejected / no `answer_image` on the recorded answer (test may take a few seconds through the session flow).

- [ ] **Step 3: Let image events through the webhook**

In `src/routes/webhook.js` (~line 68-69), change:

```js
    const bodyText = (ev.body || '').trim();
    if (!bodyText) continue;
```

to:

```js
    const bodyText = (ev.body || '').trim();
    if (!bodyText && ev.mediaType !== 'image') continue;
```

- [ ] **Step 4: Refuse photos on objective questions**

In `src/services/exam.js`, at the top of `handleAnswer` (line 706), inside the `if (question.type === 'objective')` branch, BEFORE the letter resolution, add:

```js
    if (meta.mediaType === 'image') {
      await wa.sendText(
        student.phone,
        '⚠️ For this question, please type the letter of your answer (e.g. *A*).'
      );
      return false;
    }
```

- [ ] **Step 5: Accept photos on theory questions**

In the theory branch of `handleAnswer` (the `else` starting line 792), replace the opening two lines:

```js
    const answerText = body;
    const context = [question.passage, question.text].filter(Boolean).join('\n\n');
```

with:

```js
    let answerText = body;
    let answerImage = '';
    if (meta.mediaType === 'image') {
      try {
        const { buffer } = await wa.downloadMedia(meta.mediaId);
        const { createCanvas, loadImage } = require('@napi-rs/canvas');
        const img = await loadImage(buffer);
        const canvas = createCanvas(img.width, img.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        answerImage = `${session.id}-${question.q_order}-${Date.now()}.png`;
        fs.writeFileSync(path.join(config.uploadsDir, answerImage), canvas.toBuffer('image/png'));
        answerText = (body || '').trim() || '(photo answer)';
      } catch (err) {
        console.error('[exam] photo answer download/render failed:', err.message);
        await wa.sendText(student.phone, 'Sorry, I could not receive your photo. Please try again.');
        return false;
      }
    }
    const context = [question.passage, question.text].filter(Boolean).join('\n\n');
```

Then update the INSERT (~line 800) to include the new column:

```js
    db.prepare(
      `INSERT INTO answers (session_id, question_id, q_order, answer_text, answer_image, is_correct, marks_awarded, max_marks, marked_by, ai_feedback, needs_review, ai_detected)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      session.id, question.id, question.q_order, answerText, answerImage,
      null, 0, question.marks, 'pending', '', 0, 0
    );
```

Guard the AI-copy detection so photos skip it (change `if (ai.aiConfigured())` at line 808 to `if (ai.aiConfigured() && !answerImage)`).

Check the top of `exam.js` requires — add `const fs = require('fs');` if not already present (search the file; `path` and `config` are already imported).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/image-answers.test.js`
Expected: PASS. Then `node --test test/regression.test.js` — no regressions (objective/theory text flows unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/routes/webhook.js src/services/exam.js test/image-answers.test.js
git commit -m "feat(exam): accept photo answers for theory questions"
```

---

### Task 6: Grade photo answers at finalize

**Files:**
- Modify: `src/services/exam.js` — `markAllPendingTheory` (~lines 850-891)

**Interfaces:**
- Consumes: `marking.markTheoryImageAnswer(question, studentAnswer, imageFile, scheme)` (Task 4).
- Produces: photo answers marked by AI when vision works; otherwise `needs_review=1` with `marked_by='pending'` + feedback text; the theory-marking fallback (retry-once-then-0-marks) is NOT used for photos.

- [ ] **Step 1: Write the failing test**

Append to `test/image-answers.test.js` — self-contained (transaction + stubs, like Task 5):

```js
test('markAllPendingTheory grades a photo answer via vision when available', async () => {
  const db = require('../src/db');
  db.exec('BEGIN');
  const marking = require('../src/services/marking');
  const wasVision = require('../src/config').ai.vision;
  require('../src/config').ai.vision = true;
  const orig = marking.markTheoryImageAnswer;
  const calls = [];
  marking.markTheoryImageAnswer = async (q, a, f, s) => {
    calls.push({ a, f });
    return { marksAwarded: 3, maxMarks: 4, needsReview: false, feedback: 'good drawing', aiGenerated: false };
  };
  try {
    const examId = db.prepare("INSERT INTO exams (title, subject, duration_minutes) VALUES (?,?,?)")
      .run('__photo_grade_exam__', 'Test', 30).lastInsertRowid;
    const studentId = db.prepare("INSERT INTO students (phone) VALUES (?)")
      .run('__photo_grade_phone__' + Date.now()).lastInsertRowid;
    const questionId = db.prepare("INSERT INTO questions (exam_id, q_order, type, text, marks) VALUES (?,1,'theory','Draw the water cycle.',4)")
      .run(examId).lastInsertRowid;
    const sessionId = db.prepare(
      "INSERT INTO sessions (exam_id, student_id, status, current_q_order, started_at, duration_minutes) VALUES (?,?,'in_progress',1,datetime('now'),30)"
    ).run(examId, studentId).lastInsertRowid;
    db.prepare(
      `INSERT INTO answers (session_id, question_id, q_order, answer_text, answer_image, is_correct, marks_awarded, max_marks, marked_by, ai_feedback, needs_review)
       VALUES (?,?,1,'(photo answer)','s-1-1.png',NULL,0,4,'pending','',0)`
    ).run(sessionId, questionId);

    await exam.markAllPendingTheory(sessionId);

    const row = db.prepare('SELECT * FROM answers WHERE session_id = ? AND q_order = 1').get(sessionId);
    assert.equal(row.marks_awarded, 3);
    assert.equal(row.needs_review, 0);
    assert.equal(row.marked_by, 'ai');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].f, 's-1-1.png', 'image file passed to the vision marker');
  } finally {
    marking.markTheoryImageAnswer = orig;
    require('../src/config').ai.vision = wasVision;
    db.exec('ROLLBACK');
  }
});

test('markAllPendingTheory flags a photo answer for manual review without vision', async () => {
  const db = require('../src/db');
  db.exec('BEGIN');
  const marking = require('../src/services/marking');
  const wasVision = require('../src/config').ai.vision;
  require('../src/config').ai.vision = false;
  try {
    const examId = db.prepare("INSERT INTO exams (title, subject, duration_minutes) VALUES (?,?,?)")
      .run('__photo_review_exam__', 'Test', 30).lastInsertRowid;
    const studentId = db.prepare("INSERT INTO students (phone) VALUES (?)")
      .run('__photo_review_phone__' + Date.now()).lastInsertRowid;
    const questionId = db.prepare("INSERT INTO questions (exam_id, q_order, type, text, marks) VALUES (?,1,'theory','Draw the water cycle.',4)")
      .run(examId).lastInsertRowid;
    const sessionId = db.prepare(
      "INSERT INTO sessions (exam_id, student_id, status, current_q_order, started_at, duration_minutes) VALUES (?,?,'in_progress',1,datetime('now'),30)"
    ).run(examId, studentId).lastInsertRowid;
    db.prepare(
      `INSERT INTO answers (session_id, question_id, q_order, answer_text, answer_image, is_correct, marks_awarded, max_marks, marked_by, ai_feedback, needs_review)
       VALUES (?,?,1,'(photo answer)','s-1-1.png',NULL,0,4,'pending','',0)`
    ).run(sessionId, questionId);

    await exam.markAllPendingTheory(sessionId);

    const row = db.prepare('SELECT * FROM answers WHERE session_id = ? AND q_order = 1').get(sessionId);
    assert.equal(row.needs_review, 1, 'flagged for manual review');
    assert.equal(row.marked_by, 'pending');
    assert.match(row.ai_feedback, /awaiting manual review/i);
  } finally {
    require('../src/config').ai.vision = wasVision;
    db.exec('ROLLBACK');
  }
});
```

(If `markAllPendingTheory` is not exported from `exam`, export it in this task — check the module.exports at `exam.js:1074` and add `markAllPendingTheory,` if missing. It already exists as a function in the file.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/image-answers.test.js`
Expected: FAIL — the photo answer is sent to `markTheoryAnswer` (text path) or skipped.

- [ ] **Step 3: Implement the photo branch in markAllPendingTheory**

In `markAllPendingTheory` (starts line 850), replace the per-answer body (the `try/catch` around `marking.markTheoryAnswer` at lines 867-880):

```js
    let marked;
    if (a.answer_image) {
      try {
        marked = await marking.markTheoryImageAnswer(question, a.answer_text, a.answer_image, scheme);
      } catch {
        marked = { marksAwarded: 0, maxMarks: question.marks, needsReview: true, feedback: 'Photo answer awaiting manual review.', aiGenerated: false };
      }
      if (marked.needsReview) {
        db.prepare(
          `UPDATE answers SET needs_review=1, marked_by='pending', ai_feedback=?, marked_at=datetime('now') WHERE id=?`
        ).run(marked.feedback || 'Photo answer awaiting manual review.', a.id);
        return;
      }
      db.prepare(
        `UPDATE answers SET marked_by='ai', marks_awarded=?, ai_feedback=?, needs_review=0, ai_detected=?, marked_at=datetime('now') WHERE id=?`
      ).run(marked.marksAwarded, marked.feedback, marked.aiGenerated ? 1 : 0, a.id);
      return;
    }
```

then keep the existing text-path try/catch below it unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/image-answers.test.js`
Expected: PASS. Then `node --test test/regression.test.js` (unchanged theory flow).

- [ ] **Step 5: Commit**

```bash
git add src/services/exam.js test/image-answers.test.js
git commit -m "feat(exam): grade photo answers at finalize with review fallback"
```

---

### Task 7: Show photo answers — report, API, dashboard

**Files:**
- Modify: `src/services/results.js` — reality check: theory answer block (~line 194-207)
- Modify: `src/routes/api.js` — answers SELECT (~line 571); new image route (after line 507 pattern)
- Modify: `src/public/app.js` — student-answer cell (~line 1183)

**Interfaces:**
- Consumes: `auth.reportToken(sessionId)` (already used at `results.js:218`); admin auth gate in `api.js` (read how `router.get('/exams/:id/images/:file')` gates at line 507 and copy the middleware for the new route; `path` and `config` are imported in `api.js` for the images route — reuse them).
- Produces: `<img>` for photo answers in the student report, `answer_image` in `GET /api/results/:sessionId`, and a thumbnail in the dashboard detail table.

- [ ] **Step 1: Write the failing tests**

Append to `test/image-answers.test.js`:

```js
const results = require('../src/services/results');

test('reportHTML embeds the photo answer img', () => {
  const db = require('../src/db');
  db.exec('BEGIN');
  try {
    const examId = db.prepare("INSERT INTO exams (title, subject, duration_minutes) VALUES (?,?,?)")
      .run('__photo_report_exam__', 'Test', 30).lastInsertRowid;
    const studentId = db.prepare("INSERT INTO students (phone) VALUES (?)")
      .run('__photo_report_phone__' + Date.now()).lastInsertRowid;
    const questionId = db.prepare("INSERT INTO questions (exam_id, q_order, type, text, marks) VALUES (?,1,'theory','Draw the water cycle.',4)")
      .run(examId).lastInsertRowid;
    const sessionId = db.prepare(
      "INSERT INTO sessions (exam_id, student_id, status, current_q_order, started_at, duration_minutes, ended_at) VALUES (?,?,'completed',1,datetime('now'),30,datetime('now'))"
    ).run(examId, studentId).lastInsertRowid;
    db.prepare(
      `INSERT INTO answers (session_id, question_id, q_order, answer_text, answer_image, is_correct, marks_awarded, max_marks, marked_by, ai_feedback, needs_review)
       VALUES (?,?,1,'(photo answer)','a-1-123.png',NULL,0,4,'pending','',1)`
    ).run(sessionId, questionId);

    const { html } = results.reportHTML(sessionId);
    assert.match(html, /student photo answer/);
    assert.match(html, new RegExp(`\\/report\\/${sessionId}\\/attachment\\?file=a-1-123\\.png`));
  } finally {
    db.exec('ROLLBACK');
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/image-answers.test.js`
Expected: FAIL — no img markup for `answer_image`.

- [ ] **Step 3: Render the photo in the report**

In `src/services/results.js`, in the theory branch of the rows map, after the `.theory-block` and before the `ai_feedback` line (~line 207), add:

```js
        if (a.answer_image) {
          body += `<img class="report-img answer-photo" src="/report/${sessionId}/attachment?file=${encodeURIComponent(a.answer_image)}&token=${encodeURIComponent(auth.reportToken(sessionId))}" alt="student photo answer" style="max-width:340px;border:1px solid var(--line);border-radius:10px;margin-top:10px">`;
        }
```

- [ ] **Step 4: Expose answer_image on the admin API**

In `src/routes/api.js`, the answers SELECT at line 571 — add `a.answer_image,` to the column list:

```js
       SELECT a.id, a.q_order, a.answer_text, a.answer_image, a.is_correct, a.marks_awarded, a.max_marks,
```

Then add the file-serving route after the images route (line ~507) — copy the gating from `/exams/:id/images/:file`:

```js
router.get('/results/:sessionId/image/:file', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const name = path.basename(String(req.params.file || ''));
  if (!/^[\w-]+\.png$/i.test(name)) return res.status(400).send('Bad file name');
  res.type('image/png').sendFile(path.join(config.uploadsDir, name)).on('error', () => res.status(404).end());
});
```

(Read the existing images route first — mirror its auth middleware and exact `sendFile`/error handling.)

- [ ] **Step 5: Render the thumbnail in the dashboard**

In `src/public/app.js`, the student-answer cell at line 1183:

```js
          <td>${esc(a.answer_text)}</td>
```

becomes:

```js
          <td>${a.answer_image ? `<img src="${API_BASE}/api/results/${id}/image/${encodeURIComponent(a.answer_image)}" alt="photo answer" style="max-height:90px;border-radius:8px">` : esc(a.answer_text)}</td>
```

(`id` is in scope in `renderResultDetail`; `API_BASE` is the global set by `/config.js`.)

- [ ] **Step 6: Run tests and commit**

Run: `node --test test/image-answers.test.js`
Expected: PASS.

```bash
git add src/services/results.js src/routes/api.js src/public/app.js test/image-answers.test.js
git commit -m "feat(results): surface photo answers in report, API, and dashboard"
```

---

### Task 8: Startup recovery for abruptly-stopped exams

**Files:**
- Modify: `src/services/exam.js` — new exported `finalizeStaleSessions()` (near `finalize`, line ~893); export at line ~1074
- Modify: `src/server.js` — call it in `run()` (~line 249, next to `recoverStaleJobs()`)

**Interfaces:**
- Consumes: `finalize(session, student, reason)` (`exam.js:893`), `db`.
- Produces: `finalizeStaleSessions()` → `Promise<number>` (count of finalized sessions); called once at server boot.

- [ ] **Step 1: Write the failing test**

Append to `test/image-answers.test.js`:

```js
test('finalizeStaleSessions finalizes overdue in_progress sessions and skips others', async () => {
  const db = require('../src/db');
  db.exec('BEGIN');
  // finalize() calls wa.sendText / results.sendResultMessage / wa.sendImage
  // and config.exam.sendCertificates — stub the module methods (exam reaches
  // them through the module objects, so monkey-patching works).
  const wasCert = require('../src/config').exam.sendCertificates;
  require('../src/config').exam.sendCertificates = false;
  const sentResults = [];
  const origSendResult = results.sendResultMessage;
  const origSendText = require('../src/services/whatsapp').sendText;
  const origSendImage = require('../src/services/whatsapp').sendImage;
  results.sendResultMessage = async (sessionId) => { sentResults.push(sessionId); };
  require('../src/services/whatsapp').sendText = async () => {};
  require('../src/services/whatsapp').sendImage = async () => {};
  try {
    const examId = db.prepare("INSERT INTO exams (title, subject, duration_minutes) VALUES (?,?,?)")
      .run('__stale_exam__', 'Test', 30).lastInsertRowid;
    const studentId = db.prepare("INSERT INTO students (phone) VALUES (?)")
      .run('__stale_phone__' + Date.now()).lastInsertRowid;
    db.prepare("INSERT INTO questions (exam_id, q_order, type, text, marks) VALUES (?,1,'objective','Q',1)")
      .run(examId);
    db.prepare('INSERT INTO exam_recipients (exam_id, student_id) VALUES (?,?)').run(examId, studentId);
    const staleId = db.prepare(
      "INSERT INTO sessions (exam_id, student_id, status, current_q_order, started_at, duration_minutes) VALUES (?,?,'in_progress',1,datetime('now','-2 hours'),30)"
    ).run(examId, studentId).lastInsertRowid;
    const freshId = db.prepare(
      "INSERT INTO sessions (exam_id, student_id, status, current_q_order, started_at, duration_minutes) VALUES (?,?,'in_progress',1,datetime('now'),90)"
    ).run(examId, studentId).lastInsertRowid;

    const n = await exam.finalizeStaleSessions();

    assert.equal(n, 1, 'exactly one stale session finalized');
    assert.ok(sentResults.includes(staleId), 'result message sent for the stale session');
    assert.equal(
      db.prepare('SELECT status FROM sessions WHERE id = ?').get(staleId).status,
      'expired',
      'stale session finalized as expired'
    );
    assert.equal(
      db.prepare('SELECT status FROM sessions WHERE id = ?').get(freshId).status,
      'in_progress',
      'fresh session untouched'
    );
  } finally {
    results.sendResultMessage = origSendResult;
    require('../src/services/whatsapp').sendText = origSendText;
    require('../src/services/whatsapp').sendImage = origSendImage;
    require('../src/config').exam.sendCertificates = wasCert;
    db.exec('ROLLBACK');
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/image-answers.test.js`
Expected: FAIL — `finalizeStaleSessions is not a function`.

- [ ] **Step 3: Implement finalizeStaleSessions**

In `src/services/exam.js`, after `finalize` (ends line 923), add:

```js
/**
 * Recover sessions left in_progress past their deadline by a crash or
 * redeploy: each is finalized exactly like timer expiry (report + WhatsApp
 * result + certificate). One failing session never blocks the rest.
 */
async function finalizeStaleSessions() {
  const stale = db.prepare(
    `SELECT s.id, s.student_id FROM sessions s
     WHERE s.status = 'in_progress'
       AND datetime(s.started_at, '+' || s.duration_minutes || ' minutes') < datetime('now')`
  ).all();
  let n = 0;
  for (const row of stale) {
    try {
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(row.id);
      const student = db.prepare('SELECT * FROM students WHERE id = ?').get(row.student_id);
      if (!session || !student) continue;
      await finalize(session, student, 'expired');
      console.log(`[startup] finalized stale session ${row.id} (${student.phone})`);
      n++;
    } catch (err) {
      console.error(`[startup] failed to finalize stale session ${row.id}:`, err.message);
    }
  }
  if (n) console.log(`[startup] finalized ${n} stale session(s) — reports, certificates and results were sent.`);
  return n;
}
```

In `module.exports` (line ~1074) add `finalizeStaleSessions,`.

- [ ] **Step 4: Call it at boot**

In `src/server.js`, in `run()` right after the `recoverStaleJobs()` line (~line 249), add:

```js
    await require('./services/exam').finalizeStaleSessions();
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/image-answers.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/exam.js src/server.js test/image-answers.test.js
git commit -m "feat(exam): finalize stale sessions on startup with report and certificate"
```

---

### Task 9: Theory-section passage regression test

**Files:**
- Modify: `test/regression.test.js` (append near the passage tests, line ~47)
- Possibly modify: `src/services/pdfImport.js:204-216` (only if the test fails)

**Interfaces:**
- Consumes: `ai.splitIntoBlocks(text)`.

- [ ] **Step 1: Write the test**

Append to `test/regression.test.js`:

```js
// ── Theory sections that open with a passage/lead-in from the paper ──

test('a Section B lead-in passage stays with the theory questions that follow', () => {
  const paper = [
    'SECTION B: THEORY',
    'Read the case study below and answer the questions that follow.',
    'Mrs Adjei runs a small bakery. She hires three workers and bakes 200 loaves daily.',
    '',
    '1. State two fixed costs of the bakery.',
    '2. Calculate the daily revenue if each loaf sells for 5 cedis.',
  ].join('\n');
  const blocks = ai.splitIntoBlocks(paper);
  assert.equal(blocks.length, 1, 'one theory block');
  assert.match(blocks[0], /^SECTION B: THEORY/m, 'section header leads the block');
  assert.match(blocks[0], /Mrs Adjei runs a small bakery/, 'lead-in passage kept');
  assert.match(blocks[0], /^1\. State two fixed costs/m, 'theory questions follow the lead-in');
});
```

- [ ] **Step 2: Run the test**

Run: `node --test test/regression.test.js`
Expected: PASS (the `curPassage` carry-forward in `pdfImport.js:204-216` already keeps extraction-group passages; this locks in the Section-B behavior). If it FAILS, fix `src/services/pdfImport.js` so the parser's passage result for a theory group is carried to the following theory questions exactly like comprehension groups (read lines 204-216 first; the change is to ensure `g.passage` is honored for `g.type === 'theory'` groups the same way — do not touch objective groups' behavior).

- [ ] **Step 3: Commit**

```bash
git add test/regression.test.js src/services/pdfImport.js
git commit -m "test(import): theory sections keep their PDF lead-in passages"
```

---

### Task 10: Broaden watermark stripping (ignore and proceed)

**Files:**
- Modify: `src/services/textClean.js` (~line 7)
- Modify: `test/regression.test.js` (append watermark tests — search the file for an existing `stripSourceWatermarks` test block and extend it)

**Interfaces:**
- Produces: `stripSourceWatermarks(text)` also drops standalone lines like `MOCK EXAM 2026`, `DO NOT SHARE`, `FOR INTERNAL USE ONLY`; ordinary prose is untouched. No delivery-blocking logic is added anywhere.

- [ ] **Step 1: Write the failing tests**

Append to `test/regression.test.js`:

```js
// ── Watermarks: ignore and proceed (strip, never block) ──

test('stripSourceWatermarks drops common school/exam footer watermarks', () => {
  assert.equal(
    stripSourceWatermarks('MOCK EXAMINATION 2026\n1. Who is the president?\nDO NOT SHARE\n'),
    '1. Who is the president?'
  );
  assert.equal(
    stripSourceWatermarks('FOR INTERNAL USE ONLY\n2. Define osmosis.\n3. Define diffusion.\n'),
    '2. Define osmosis.\n3. Define diffusion.'
  );
});

test('stripSourceWatermarks keeps normal prose that merely mentions exams', () => {
  assert.equal(
    stripSourceWatermarks('The mock exam was written by the students of form three.'),
    'The mock exam was written by the students of form three.'
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/regression.test.js`
Expected: FAIL — the first test: watermark lines survive.

- [ ] **Step 3: Broaden the pattern**

In `src/services/textClean.js`, change line 7:

```js
const WATERMARK = /sronu|downloaded\s+(from|by)|source\s*[:=]|visit\s+(us\s+)?at\b/i;
```

to:

```js
const WATERMARK =
  /sronu|downloaded\s+(from|by)|source\s*[:=]|visit\s+(us\s+)?at\b|mock\s+exam(?:ination)?|do\s+not\s+share|for\s+internal\s+use\b/i;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/regression.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/textClean.js test/regression.test.js
git commit -m "feat(import): strip more watermark footers; never block delivery"
```

---

### Task 11: README documentation

**Files:**
- Modify: `README.md` (Features + WhatsApp setup sections)

- [ ] **Step 1: Update the README**

In the Features list (line ~10), after the "Instant objective marking..." bullet, add:

```markdown
- **Photo answers (theory)**: students can send a written/drawn answer as a
  WhatsApp photo. With `AI_VISION=true` the AI grades the image; otherwise the
  answer is flagged for manual review. Photos appear in the dashboard and the
  student report.
```

In the WhatsApp Cloud API setup section (step 4, line ~72), after the token bullet, add:

```markdown
5. Optional: set `AI_VISION=true` in `.env` only when `AI_MODEL` accepts image
   input (e.g. `gpt-4o`). Photo answers are then AI-graded with a manual-review
   fallback; without it they are always flagged for review.
```

In the Exam workflow section (step 6, line ~88), after the timer-finalize bullet, add:

```markdown
6. If the server restarts mid-exam, any session past its deadline is finalized
   automatically on boot — the student still receives the report and
   certificate for the answers given so far.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: photo answers, AI vision flag, startup recovery"
```

---

## Verification

After all tasks: `npm test` (full suite) and a quick boot smoke test `node src/server.js --init` (init mode skips listen but runs startup recovery — session-less DB is a no-op).

## File change map

| File | Tasks |
|---|---|
| `src/db.js` | 1 |
| `src/config.js` / `.env.example` | 2 |
| `src/services/whatsapp.js` | 3 |
| `src/services/ai.js` / `src/services/marking.js` | 4 |
| `src/routes/webhook.js` / `src/services/exam.js` | 5, 6, 8 |
| `src/services/results.js` / `src/routes/api.js` / `src/public/app.js` | 7 |
| `src/server.js` | 8 |
| `src/services/pdfImport.js` (only if test fails) | 9 |
| `src/services/textClean.js` | 10 |
| `README.md` | 11 |
| `test/image-answers.test.js` (new) / `test/regression.test.js` / `package.json` | all |

## Risks / notes

- `markAllPendingTheory` photo branch runs inside the existing concurrency-capped `ai.mapLimit` (line 890) — fine.
- `handleInbound` photo tests take real DB writes — tests use `INSERT OR REPLACE` with fixed ids and run against the dev db used by `regression.test.js`; follow its existing DB isolation approach (check how `regression.test.js` cleans up — mirror it).
- The vision `content` array must reach the provider untouched — verify `chatJSON` passthrough while implementing Task 4. If the secondary `CLAUDE_*` provider races primary, that logic is inside `chatJSON` and is reused as-is.
- `finalizeStaleSessions` only touches sessions whose deadline already passed; fresh or never-started sessions are untouched (existing behavior, per spec).