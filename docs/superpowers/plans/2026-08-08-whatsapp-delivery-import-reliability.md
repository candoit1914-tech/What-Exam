# WhatsApp Delivery Polish + Import Reliability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix dropped extraction blocks on PDF import, cut-off WhatsApp questions, shuffled delivery order, cramped bubble layout, and hidden report model answers.

**Architecture:** Four small changes across existing services, each independently testable: (1) `ai.js` extraction serially retries failed blocks and reports a warning, (2) `whatsapp.js` splits over-long messages, (3) `exam.js` renders section header → instructions → passage → question bubbles and draws the pool in PDF order, (4) `results.js` opens the report's model-answer details. No schema or dependency changes.

**Tech Stack:** Node.js >= 22, CommonJS, `node:sqlite`, `node:test` (`node --test test/regression.test.js`).

## Global Constraints

- No new dependencies. No DB schema changes.
- `node --test test/regression.test.js` must pass after every task.
- Existing 44 tests must stay green except the four `buildQuestionBubbles` shape assertions that are intentionally updated in Task 2.
- Follow the codebase's existing style: 2-space indent, no comments unless explaining a non-obvious rule (existing code documents reasoning above functions).
- `git add` emits benign CRLF warnings; ignore them.

---

### Task 1: `splitSectionMeta` helper in `exam.js`

**Files:**
- Modify: `src/services/exam.js` (add helper near `stripPaperOnlyInstructions`, ~line 236)
- Test: `test/regression.test.js`

**Interfaces:**
- Produces: `splitSectionMeta(text) -> { instructions: string, passage: string }` (exported from `exam`).
- Produces: regex constants `INSTRUCTION_START`, `INSTRUCTION_PHRASE` (already present, reused).
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

Append to `test/regression.test.js`:

```js
test('splitSectionMeta pulls leading instruction lines out of a passage', () => {
  const r = exam.splitSectionMeta(
    'Answer ONE question in this section.\n' +
    'Your answer should be between 250 and 300 words.\n' +
    'Write about the importance of education.'
  );
  assert.equal(r.instructions, 'Answer ONE question in this section.\nYour answer should be between 250 and 300 words.');
  assert.equal(r.passage, 'Write about the importance of education.');
});

test('splitSectionMeta keeps comprehension prose in passage, not instructions', () => {
  const r = exam.splitSectionMeta(
    'Read the following passage carefully and answer questions 1 to 5.\n' +
    'The farmers of the valley rely on irrigation channels that carry water from the mountain.\n' +
    'Every dry season the council dredges the channels so the fields stay productive.'
  );
  assert.match(r.instructions, /^Read the following passage carefully/);
  assert.match(r.passage, /^The farmers of the valley/);
  assert.match(r.passage, /fields stay productive/);
});

test('splitSectionMeta returns no instructions when none lead the text', () => {
  assert.deepEqual(exam.splitSectionMeta('What is the capital of Ghana?'), { instructions: '', passage: 'What is the capital of Ghana?' });
});

test('splitSectionMeta handles empty input', () => {
  assert.deepEqual(exam.splitSectionMeta(''), { instructions: '', passage: '' });
  assert.deepEqual(exam.splitSectionMeta('   '), { instructions: '', passage: '' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/regression.test.js`
Expected: FAIL — `exam.splitSectionMeta is not a function`.

- [ ] **Step 3: Implement `splitSectionMeta`**

In `src/services/exam.js`, after `stripPaperOnlyInstructions` (~line 244):

```js
// Section instructions live in the first question's passage field. Pull the
// leading instruction-like lines ("Read the passage…", "Answer ONE question…")
// into their own bubble so they are not jammed against the header, and leave
// the reading passage itself separate.
const SECTION_INSTRUCTION = [
  /^read\b/i,
  /between\s+\d+\s+and\s+\d+\s+words/i,
  /question(s)?\s+(\d+\s*(-|to)\s+)?\d+/i,
  /in\s+this\s+section/i,
];

function isInstructionLine(line) {
  return INSTRUCTION_START.test(line) || INSTRUCTION_PHRASE.test(line) ||
    SECTION_INSTRUCTION.some((re) => re.test(line));
}

function splitSectionMeta(text) {
  const lines = String(text || '')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const instructions = [];
  for (const line of lines) {
    if (isInstructionLine(line)) instructions.push(line);
    else break; // real prose starts here; never strip mid-passage
  }
  return {
    instructions: instructions.join('\n'),
    passage: lines.slice(instructions.length).join('\n'),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/regression.test.js`
Expected: PASS (all 4 new + all existing).

- [ ] **Step 5: Commit**

```bash
git add src/services/exam.js test/regression.test.js
git commit -m "Add splitSectionMeta to separate section instructions from passages"
```

---

### Task 2: New bubble layout in `buildQuestionBubbles`

**Files:**
- Modify: `src/services/exam.js` (add `SECTION_DIVIDER`, `formatSectionHeader`, `formatSectionInstructions`; rework `buildQuestionBubbles`, ~lines 253-267)
- Modify: `src/services/exam.js` module.exports (add `splitSectionMeta` if not already)
- Test: `test/regression.test.js` (update the four bubble-shape tests, lines 238-267)

**Interfaces:**
- Consumes: `splitSectionMeta` from Task 1.
- Produces: new bubble strings — header `*OBJECTIVE*\n\n━━━━━━━━━━━━━━━━━━━━`, instruction `*Instructions*\n\n<text>`, passage body, question via `formatQuestion` (unchanged).

- [ ] **Step 1: Update the bubble-shape tests**

Replace the four tests at `test/regression.test.js` lines 238-267 with:

```js
const SECTION_DIVIDER = '━━━━━━━━━━━━━━━━━━━━';

test('buildQuestionBubbles sends OBJECTIVE header once then each question', () => {
  const q1 = { id: 1, q_order: 1, type: 'objective', text: 'Q1', passage: '' };
  const q2 = { id: 2, q_order: 2, type: 'objective', text: 'Q2', passage: '' };
  const seq = [q1, q2];
  assert.deepEqual(exam.buildQuestionBubbles({}, q1, seq, 0), [`*OBJECTIVE*\n\n${SECTION_DIVIDER}`, '*QUESTION 1*\n\nQ1']);
  assert.deepEqual(exam.buildQuestionBubbles({}, q2, seq, 1), ['*QUESTION 2*\n\nQ2']);
});

test('buildQuestionBubbles sends THEORY header once before theory questions', () => {
  const q1 = { id: 1, q_order: 1, type: 'objective', text: 'Q1', passage: '' };
  const q2 = { id: 2, q_order: 2, type: 'theory', text: 'Q2', passage: '' };
  const q3 = { id: 3, q_order: 3, type: 'theory', text: 'Q3', passage: '' };
  const seq = [q1, q2, q3];
  assert.deepEqual(exam.buildQuestionBubbles({}, q2, seq, 1), [`*THEORY*\n\n${SECTION_DIVIDER}`, '*QUESTION 2*\n\nQ2']);
  assert.deepEqual(exam.buildQuestionBubbles({}, q3, seq, 2), ['*QUESTION 3*\n\nQ3']);
});

test('buildQuestionBubbles emits header, instructions, passage, then question', () => {
  const passage = 'Read the passage.\nAma lost her pencil on the way to school.';
  const q1 = { id: 1, q_order: 1, type: 'objective', text: 'Q1', passage };
  const q2 = { id: 2, q_order: 2, type: 'objective', text: 'Q2', passage };
  const seq = [q1, q2];
  assert.deepEqual(exam.buildQuestionBubbles({}, q1, seq, 0), [
    `*OBJECTIVE*\n\n${SECTION_DIVIDER}`,
    '*Instructions*\n\nRead the passage.',
    'Ama lost her pencil on the way to school.',
    '*QUESTION 1*\n\nQ1',
  ]);
  assert.deepEqual(exam.buildQuestionBubbles({}, q2, seq, 1), ['*QUESTION 2*\n\nQ2']);
});

test('buildQuestionBubbles treats an unknown index as the first question', () => {
  const q = { id: 7, q_order: 3, type: 'objective', text: 'Q3', passage: 'Read the passage.' };
  assert.deepEqual(exam.buildQuestionBubbles({}, q, [], -1), [
    `*OBJECTIVE*\n\n${SECTION_DIVIDER}`,
    '*Instructions*\n\nRead the passage.',
    '*QUESTION 3*\n\nQ3',
  ]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/regression.test.js`
Expected: FAIL — bubble strings no longer match the current output.

- [ ] **Step 3: Implement the new layout**

In `src/services/exam.js`, before `buildQuestionBubbles` (~line 246), add:

```js
const SECTION_DIVIDER = '━━━━━━━━━━━━━━━━━━━━';

function formatSectionHeader(type) {
  return `*${type}*\n\n${SECTION_DIVIDER}`;
}

function formatSectionInstructions(instructions) {
  return `*Instructions*\n\n${instructions}`;
}
```

Replace the body of `buildQuestionBubbles` (~lines 253-267):

```js
function buildQuestionBubbles(exam, question, sequence, index) {
  const bubbles = [];
  const type = question.type === 'theory' ? 'THEORY' : 'OBJECTIVE';
  const prev = index > 0 ? sequence.slice(0, index) : [];
  const firstOfType = !prev.some((q) => q.type === question.type);
  if (firstOfType) bubbles.push(formatSectionHeader(type));

  const clean = (p) => stripPaperOnlyInstructions(stripSourceWatermarks(p)).trim();
  const { instructions, passage } = splitSectionMeta(clean(question.passage));
  if (firstOfType && instructions) {
    bubbles.push(formatSectionInstructions(instructions));
  }
  if (passage && !prev.some((q) => splitSectionMeta(clean(q.passage)).passage === passage)) {
    bubbles.push(passage);
  }
  bubbles.push(formatQuestion(exam, question));
  return bubbles;
}
```

Add `splitSectionMeta` to `module.exports` if it is not already exported.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/regression.test.js`
Expected: PASS (updated bubble tests + all others).

- [ ] **Step 5: Commit**

```bash
git add src/services/exam.js test/regression.test.js
git commit -m "Render section header, instructions, and passage as separate bubbles"
```

---

### Task 3: `drawSessionQuestions` delivers the pool in PDF order

**Files:**
- Modify: `src/services/exam.js` (remove `shuffle`, ~lines 70-77; `drawSessionQuestions`, ~lines 88-100)
- Test: `test/regression.test.js`

**Interfaces:**
- Consumes: `topUpPool` (unchanged).
- Produces: `drawSessionQuestions(sessionId, examId)` draws pool rows ordered by `id` (== PDF order) instead of shuffled.

- [ ] **Step 1: Write the failing test**

Append to `test/regression.test.js`:

```js
test('drawSessionQuestions presents the pool in PDF (insertion) order, not shuffled', () => {
  const db = require('../src/db');
  db.exec('BEGIN');
  try {
    const examId = db
      .prepare("INSERT INTO exams (title, subject, duration_minutes) VALUES ('__order_exam__','Test',30)")
      .run().lastInsertRowid;
    for (let i = 1; i <= 3; i++) {
      db.prepare("INSERT INTO questions (exam_id, q_order, type, text, marks) VALUES (?,?,?,?,?)")
        .run(examId, i, 'objective', 'TQ' + i, 1);
    }
    const ids = [];
    for (let i = 1; i <= 3; i++) {
      ids.push(db.prepare("INSERT INTO question_pool (exam_id, type, text) VALUES (?,'objective',?)")
        .run(examId, 'PQ' + i).lastInsertRowid);
    }
    const studentId = db
      .prepare('INSERT INTO students (phone) VALUES (?)')
      .run('__order_phone__' + Date.now()).lastInsertRowid;
    const sessionId = db
      .prepare('INSERT INTO sessions (exam_id, student_id) VALUES (?,?)')
      .run(examId, studentId).lastInsertRowid;

    exam.drawSessionQuestions(sessionId, examId);
    const drawn = db
      .prepare('SELECT q_order, question_id FROM session_questions WHERE session_id = ? ORDER BY q_order')
      .all(sessionId);
    assert.deepEqual(drawn.map((d) => d.question_id), ids, 'presented in insertion (PDF) order');
  } finally {
    db.exec('ROLLBACK');
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/regression.test.js`
Expected: FAIL — shuffled order rarely equals insertion order (passes ~1/6 of the time; rerun if it happens to pass, or make it deterministic by setting the pool so a shuffle is extremely unlikely to match — a 6+ row pool makes a match improbable).

- [ ] **Step 3: Implement PDF order**

In `src/services/exam.js`:

- Delete the `shuffle` function (~lines 70-77).
- In `drawSessionQuestions` (~line 93), replace:

```js
const ids = db.prepare('SELECT id FROM question_pool WHERE exam_id = ?').all(examId);
const chosen = shuffle(ids).slice(0, n);
```

with:

```js
// Present the paper in the uploaded PDF order (pool rows are inserted in that
// order), never shuffled.
const ids = db.prepare('SELECT id FROM question_pool WHERE exam_id = ? ORDER BY id').all(examId);
const chosen = ids.slice(0, n);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/regression.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/exam.js test/regression.test.js
git commit -m "Deliver question pool in PDF order instead of shuffled"
```

---

### Task 4: Split long WhatsApp messages in `whatsapp.js`

**Files:**
- Modify: `src/services/whatsapp.js` (add `MAX_TEXT_LENGTH`, `splitTextChunks`; rework `sendText`, ~line 91)
- Test: `test/regression.test.js`

**Interfaces:**
- Produces: `splitTextChunks(text, maxLen = 4000) -> string[]` (exported). Every chunk ≤ `maxLen`; every non-final chunk ends with `' …'`.
- Produces: `sendText(to, text)` sends each chunk sequentially and returns the last response.

- [ ] **Step 1: Write the failing tests**

Append to `test/regression.test.js`:

```js
const wa = require('../src/services/whatsapp');

test('splitTextChunks leaves short text as one chunk', () => {
  assert.deepEqual(wa.splitTextChunks('Hello world'), ['Hello world']);
});

test('splitTextChunks splits long text into capped chunks with continuation markers', () => {
  const chunks = wa.splitTextChunks('x'.repeat(9000), 4000);
  assert.ok(chunks.length >= 3, '9000 chars becomes at least 3 chunks');
  for (const c of chunks) assert.ok(c.length <= 4000, `chunk under cap (${c.length})`);
  assert.ok(chunks.slice(0, -1).every((c) => c.endsWith(' …')), 'non-final chunks carry the marker');
  assert.equal(chunks[chunks.length - 1].endsWith(' …'), false, 'final chunk has no marker');
});

test('splitTextChunks splits a single over-long line', () => {
  const chunks = wa.splitTextChunks('y'.repeat(8500), 4000);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= 4000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/regression.test.js`
Expected: FAIL — `wa.splitTextChunks is not a function`.

- [ ] **Step 3: Implement chunking**

In `src/services/whatsapp.js`, after the `MAX_ATTEMPTS` constant (~line 6):

```js
// WhatsApp rejects text messages longer than 4096 characters. Keep every
// message comfortably under that cap and split longer bodies into multiple
// messages with a continuation marker.
const MAX_TEXT_LENGTH = 4000;

function splitTextChunks(text, maxLen = MAX_TEXT_LENGTH) {
  const t = String(text || '');
  if (t.length <= maxLen) return [t];
  const hard = (s) => {
    const parts = [];
    while (s.length > maxLen) { parts.push(s.slice(0, maxLen)); s = s.slice(maxLen); }
    if (s) parts.push(s);
    return parts;
  };
  const chunks = [];
  let cur = '';
  for (const line of t.split('\n')) {
    for (const piece of hard(line)) {
      if (cur && cur.length + 1 + piece.length > maxLen) { chunks.push(cur); cur = ''; }
      cur = cur ? cur + '\n' + piece : piece;
      if (cur.length >= maxLen) { chunks.push(cur); cur = ''; }
    }
  }
  if (cur) chunks.push(cur);
  if (chunks.length === 0) chunks.push('');
  const marker = ' …';
  return chunks.map((c, i) => {
    if (i === chunks.length - 1) return c;
    return c.length + marker.length <= maxLen ? c + marker : c.slice(0, maxLen - marker.length) + marker;
  });
}
```

Replace `sendText` (~lines 91-100):

```js
async function sendText(to, text) {
  let data;
  for (const chunk of splitTextChunks(text)) {
    data = await api('messages', {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: chunk },
    });
    logOutbound(to, data?.messages?.[0]?.id, 'text');
  }
  return data;
}
```

Add `splitTextChunks` to `module.exports`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/regression.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/whatsapp.js test/regression.test.js
git commit -m "Split long WhatsApp text messages under the 4096-char limit"
```

---

### Task 5: Extract a shared `runBlock` + serial retry + `onWarning` in `ai.js`

**Files:**
- Modify: `src/services/ai.js` (`BLOCK_MAX_TOKENS`, ~line 176; extraction block runner, ~lines 469-499; settle loop, ~lines 501-507)
- Test: `test/regression.test.js`

**Interfaces:**
- Consumes: existing `chatJSON`, `mapLimit`, `BLOCK_*` constants, `delay`.
- Produces: `extractQuestionsFromText(rawText, onProgress, onWarning)` — blocks that fail in the concurrent wave are re-run serially; `onWarning(message)` fires when any block still fails. Signature stays backward compatible (third arg optional).

- [ ] **Step 1: Write the failing tests**

Append to `test/regression.test.js`:

```js
test('extractQuestionsFromText serially retries a block that failed in the wave', async () => {
  const orig = ai.chatJSON;
  const calls = { n: 0 };
  ai.chatJSON = async () => {
    calls.n++;
    if (calls.n <= 4) throw new Error('fetch failed');
    return { questions: [{ type: 'objective', text: 'Retry Q', options: ['A. X', 'B. Y'], correct_answer: 'A', correct_index: 0 }] };
  };
  try {
    const out = await ai.extractQuestionsFromText('1. Retry Q?\nA. X\nB. Y');
    assert.equal(out.length, 1, 'question survives the failed wave via the serial re-run');
    assert.equal(out[0].text, 'Retry Q');
    assert.ok(calls.n >= 5, 'wave retries exhausted before the serial re-run succeeded');
  } finally {
    ai.chatJSON = orig;
  }
});

test('extractQuestionsFromText warns when a block still fails after the serial retry', async () => {
  const orig = ai.chatJSON;
  ai.chatJSON = async () => { throw new Error('fetch failed'); };
  const warnings = [];
  try {
    const out = await ai.extractQuestionsFromText('1. Retry Q?\nA. X\nB. Y', null, (w) => warnings.push(w));
    assert.equal(out.length, 0, 'no questions parsed');
    assert.equal(warnings.length, 1, 'warning fired once');
    assert.match(warnings[0], /could not be parsed/);
  } finally {
    ai.chatJSON = orig;
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/regression.test.js`
Expected: FAIL — the second test gets `warnings.length === 0` (no warning is emitted today); the first may pass by luck of retries, the second fails deterministically.

- [ ] **Step 3: Implement the retry + warning**

In `src/services/ai.js`:

- Change `BLOCK_MAX_TOKENS` (line 176) to `6000` and update the surrounding comment to note the cap also protects theory model answers.
- Change the signature at line 375: `async function extractQuestionsFromText(rawText, onProgress, onWarning) {`
- Replace the block-runner section (lines ~469-499) with:

```js
  let completed = 0;
  // A single block runs on its own shorter clock with a couple of retries. If
  // it still fails (timeout, HTTP error, bad JSON) the block is re-run
  // serially after the wave (Task: flaky shared endpoints usually succeed once
  // they are no longer flooded); only then is it dropped and reported.
  const runBlock = async (bp) => {
    for (let attempt = 0; attempt <= BLOCK_RETRIES; attempt++) {
      try {
        return await chatJSON(
          [
            { role: 'system', content: system },
            { role: 'user', content: user(bp.block, bp.shared) },
          ],
          // Internal retries are disabled: the block wrapper owns retries, and
          // the hard timeout guarantees a stuck fetch cannot stall the import.
          { timeoutMs: BLOCK_TIMEOUT_MS, maxTokens: BLOCK_MAX_TOKENS, maxRetries: 0 }
        );
      } catch (err) {
        const isTimeout = err && err.name === 'AIError' && /timed out/i.test(err.message);
        if (attempt < BLOCK_RETRIES) {
          await delay(1000 * (attempt + 1));
          continue;
        }
        console.error('[ai] extraction block skipped:', isTimeout ? 'timeout' : err.message);
        return null;
      }
    }
    return null;
  };

  const tasks = blockPrompts.map((bp) => async () => {
    completed++;
    if (onProgress) onProgress(completed, blocks.length);
    return runBlock(bp);
  });

  const settled = await mapLimit(tasks, BLOCK_CONCURRENCY, (run) => run());

  // Re-run every failed block serially (concurrency 1). This recovers most
  // transient failures and is what stops a whole theory section disappearing.
  const failed = [];
  for (let i = 0; i < settled.length; i++) if (!settled[i]) failed.push(i);
  if (failed.length) {
    const rerun = await mapLimit(failed.map((i) => blockPrompts[i]), 1, runBlock);
    for (let k = 0; k < rerun.length; k++) if (rerun[k]) settled[failed[k]] = rerun[k];
    const stillFailed = failed.filter((_, k) => !rerun[k]);
    if (stillFailed.length && onWarning) {
      onWarning(
        `${stillFailed.length} question block(s) could not be parsed — some questions may be missing. Retry the upload to recover them.`
      );
    }
  }
```

Keep the settle loop (lines ~503-533) unchanged — it already skips null results.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/regression.test.js`
Expected: PASS (both new tests + all existing, including the live-style extraction tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/ai.js test/regression.test.js
git commit -m "Serially retry failed extraction blocks and report a missing-question warning"
```

---

### Task 6: Wire `onWarning` + open report model answers

**Files:**
- Modify: `src/services/pdfImport.js` (~lines 115-124)
- Modify: `src/services/results.js` (~line 200)

**Interfaces:**
- Consumes: `extractQuestionsFromText(rawText, onProgress, onWarning)` from Task 5.
- Produces: import jobs carry a combined `warning` when blocks were skipped; the report shows theory model answers open by default.

- [ ] **Step 1: Write the failing tests**

These are integration/UI changes without a clean unit seam. Verification is manual/`node --check`; per repo convention (no frontend test harness), they are covered by the smoke check in Task 8. No new unit tests in this task.

- [ ] **Step 2: Implement `pdfImport` warning wiring**

In `src/services/pdfImport.js`, around line 115, add a local before the extraction call:

```js
    let blockWarning = '';
```

Then change the extraction call to pass the third callback:

```js
    const parsed = await ai.extractQuestionsFromText(
      text,
      (done, total) => {
        const pct = 10 + Math.round((done / Math.max(1, total)) * 45);
        updateJob(jobId, { stage: `Parsing questions… (${done}/${total})`, progress: pct });
      },
      (warning) => { blockWarning = warning; }
    );
```

Then merge with the existing completeness warning (around line 123):

```js
    const warning = [ai.completenessWarning(ai.estimateQuestionCount(text), parsed), blockWarning]
      .filter(Boolean)
      .join(' ');
    if (warning) updateJob(jobId, { warning });
```

- [ ] **Step 3: Open the report model answers by default**

In `src/services/results.js`, line 200:

```html
<details class="model">
```

becomes:

```html
<details class="model" open>
```

- [ ] **Step 4: Syntax-check the touched files**

Run: `node --check src/services/pdfImport.js && node --check src/services/results.js && node --test test/regression.test.js`
Expected: exit 0 for the checks; full suite still green.

- [ ] **Step 5: Commit**

```bash
git add src/services/pdfImport.js src/services/results.js
git commit -m "Report skipped extraction blocks on the import job and show report model answers by default"
```

---

### Task 7: Full verification + push

**Files:** none new.

- [ ] **Step 1: Run the whole suite**

Run: `node --check src/services/ai.js && node --check src/services/exam.js && node --check src/services/whatsapp.js && node --check src/services/pdfImport.js && node --check src/services/results.js && node --test test/regression.test.js`
Expected: all checks exit 0; every test passes (count noted in output).

- [ ] **Step 2: Boot the server once**

Run: `$env:PORT='3999'; node src/server.js` (with the AI key cleared in a throwaway copy of `.env`, as in prior rounds) — expected: "What Exam admin running" on 3999, health endpoint 200. Stop it.

- [ ] **Step 3: Commit any stragglers and push**

```bash
git status
git add -A
git commit -m "Finish WhatsApp delivery polish + import reliability round"
git push origin main
```

- [ ] **Step 4: Smoke (deployed, admin)**

Upload the debug paper with a marking scheme → all questions import with no missing-question warning; run a session → header → instructions → passage → questions in PDF order; a very long question arrives complete; results → report PDF shows model answers.
