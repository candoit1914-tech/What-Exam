# WhatsApp Question Delivery Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean up how questions are delivered over WhatsApp — strip paper-only instructions, send one bold `*OBJECTIVE*`/`*THEORY*` banner per type, and put passages/instructions on their own chat bubble once instead of inline in the question bubble.

**Architecture:** All changes are send-time in `src/services/exam.js`. Three new pure helpers (`stripPaperOnlyInstructions`, `sessionQuestionSequence`, `buildQuestionBubbles`) plus a simplified `formatQuestion`; `sendQuestionTo` uses them to emit one `wa.sendText` per chat bubble. "Already sent" is derived from the session's question sequence, so no DB schema changes and already-imported exams benefit immediately.

**Tech Stack:** Node ≥ 22.5, CommonJS, `node:test` (`node --test test/regression.test.js`), `node:sqlite` DatabaseSync.

## Global Constraints

- No new dependencies, no DB schema changes, no re-import needed.
- All changes live in `src/services/exam.js` and `test/regression.test.js`.
- Keep the real passage text and useful short instructions (word limits, "Answer ALL/ONE question"). Drop ONLY sentences that BOTH read like an instruction AND contain a paper-only keyword (pencil, booklet, margin, ink, shade, tick, etc.) — a comprehension passage that mentions "pencil" in prose must survive intact.
- Banner rules: `*OBJECTIVE*` exactly once before the first objective question, `*THEORY*` exactly once before the first theory question. Question label becomes `*QUESTION N*` (no type suffix, no inlined passage).
- Passage/instruction bubble: appears exactly once, before the first question in the session's sequence that carries that text.
- Do NOT change `formatExamIntro`, `formatOptions`, or marking/AI logic.
- Test command: `npm test` (runs `node --test test/regression.test.js`). Single-test command: `node --test --test-name-pattern "<name>" test/regression.test.js`.

---

### Task 1: `stripPaperOnlyInstructions`

**Files:**
- Modify: `src/services/exam.js` — add helper near the `// ── Formatting helpers ──` section (after line 156, before `formatOptions`)
- Modify: `src/services/exam.js` — add to `module.exports` (line 729-731)
- Test: `test/regression.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `stripPaperOnlyInstructions(text: string|undefined|null) -> string` — returns `text` with paper-only instruction sentences removed, segments joined with `\n`.

- [ ] **Step 1: Write the failing test**

Append to `test/regression.test.js`:

```js
test('stripPaperOnlyInstructions drops paper-only mechanics but keeps passages and useful instructions', () => {
  const input = [
    'Read the following passage carefully and answer questions 1 to 5.',
    'Ama lost her pencil on the way to school.',
    'Answer ALL questions in this section.',
    'Your answer should be between 250 and 300 words.',
    'Shade your answer with a pencil.',
    'Write your answers in the answer booklet.',
    'Do not write in the margin.',
  ].join('\n');
  const out = exam.stripPaperOnlyInstructions(input);
  assert.match(out, /Read the following passage/, 'passage-introducing instruction stays');
  assert.match(out, /Ama lost her pencil/, 'prose mention of pencil survives');
  assert.match(out, /Answer ALL questions/, '"Answer ALL" stays');
  assert.match(out, /250 and 300 words/, 'word limit stays');
  assert.doesNotMatch(out, /Shade your answer/, 'pencil-shading instruction dropped');
  assert.doesNotMatch(out, /answer booklet/, 'booklet instruction dropped');
  assert.doesNotMatch(out, /Do not write in the margin/, 'margin instruction dropped');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern "stripPaperOnlyInstructions" test/regression.test.js`
Expected: FAIL — `exam.stripPaperOnlyInstructions is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/services/exam.js` after the `formatQuestion`/`timeRemaining` block (keep the existing `// ── Formatting helpers ──` section ordering):

```js
// Paper-only exam instructions (shading, booklets, margins, ink) make no sense
// in a typed chat. A sentence is dropped only when it BOTH reads like an
// instruction AND names a physical-paper mechanic, so comprehension prose that
// happens to mention "pencil" is never corrupted.
const PAPER_ONLY =
  /\bshad(?:e|e in|ing)\b|\bpencil\b|\bpen\b|\bH\s*B\b|\banswer\s+(?:booklet|sheet|grid)\b|\bmargins?\b|\bruled\s+lines?\b|\brough\s+work\b|\b(?:blue|black)\s+ink\b|\btick\b|\bcross\s+out\b|\b(circle|ring|underline)\b|\bfill\s+in\b|\bdo\s+not\s+write\b|\bquestion\s+paper\b/i;
const INSTRUCTION_START =
  /^(write|shade|use|tick|cross|circle|ring|underline|fill|answer|do not|don't|ensure|make sure|remember|leave|erase|rub)/i;
const INSTRUCTION_PHRASE = /(your\s+answers?|answer\s+(sheet|booklet|grid|paper)|should\s+be|in\s+the\s+box)/i;

function stripPaperOnlyInstructions(text) {
  const segments = String(text || '')
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return segments
    .filter((s) => !((INSTRUCTION_START.test(s) || INSTRUCTION_PHRASE.test(s)) && PAPER_ONLY.test(s)))
    .join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern "stripPaperOnlyInstructions" test/regression.test.js`
Expected: PASS.

- [ ] **Step 5: Export the helper**

In `module.exports` (bottom of `src/services/exam.js`) add `stripPaperOnlyInstructions,`:

```js
  formatQuestion,
  stripPaperOnlyInstructions,
```

Run: `npm test` — expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/exam.js test/regression.test.js
git commit -m "Strip paper-only instructions from WhatsApp question delivery"
```

---

### Task 2: Simplify `formatQuestion` label

**Files:**
- Modify: `src/services/exam.js:143-148` — `formatQuestion`
- Test: `test/regression.test.js:162-176`

**Interfaces:**
- Consumes: nothing new.
- Produces: `formatQuestion(exam, question, qCount) -> string` — now `*QUESTION N*\n\n<text>` (no type suffix, no passage inlined).

- [ ] **Step 1: Update the failing tests**

Replace the two existing tests (lines 162-176) in `test/regression.test.js`:

```js
test('formatQuestion renders a bold QUESTION header without the passage', () => {
  const q = { q_order: 1, type: 'objective', text: 'What is 2+2?', passage: 'Read the passage.' };
  assert.equal(exam.formatQuestion({ title: 'Test' }, q, 10), '*QUESTION 1*\n\nWhat is 2+2?');
});

test('formatQuestion drops the type suffix and never inlines the passage', () => {
  const q = { q_order: 2, type: 'theory', text: 'Explain photosynthesis.', passage: 'Read the passage.' };
  assert.equal(exam.formatQuestion({ title: 'Test' }, q, 10), '*QUESTION 2*\n\nExplain photosynthesis.');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern "formatQuestion" test/regression.test.js`
Expected: FAIL — output still contains `— OBJECTIVE` / the passage.

- [ ] **Step 3: Implement the simplification**

Replace the body of `formatQuestion` (src/services/exam.js:143-148) with:

```js
function formatQuestion(exam, question, qCount) {
  // The type banner and any passage/instruction are sent as their own bubbles
  // by buildQuestionBubbles, so the question bubble carries just the stem.
  return `*QUESTION ${question.q_order}*\n\n${String(question.text).trim()}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-name-pattern "formatQuestion" test/regression.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/exam.js test/regression.test.js
git commit -m "Simplify question bubble to QUESTION N with no inlined passage"
```

---

### Task 3: `sessionQuestionSequence`

**Files:**
- Modify: `src/services/exam.js` — add helper near `getSessionQuestionCount` (line 117-120)
- Modify: `src/services/exam.js` — export it
- Test: `test/regression.test.js`

**Interfaces:**
- Consumes: `db` (already imported).
- Produces: `sessionQuestionSequence(session) -> Array<question>` — ordered questions this session presents: `session_questions` → `question_pool` when drawn, else the exam's template questions in `q_order`.

- [ ] **Step 1: Write the failing test**

Append to `test/regression.test.js`:

```js
test('sessionQuestionSequence uses template order when no pool is drawn', () => {
  const session = { id: -999, exam_id: -999 };
  const seq = exam.sessionQuestionSequence(session);
  assert.ok(Array.isArray(seq), 'returns an array');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern "sessionQuestionSequence" test/regression.test.js`
Expected: FAIL — `exam.sessionQuestionSequence is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add after `getSessionQuestionCount` (line 117-120) in `src/services/exam.js`:

```js
/** Ordered questions this session presents, in the order the student sees them. */
function sessionQuestionSequence(session) {
  const s = db.prepare('SELECT exam_id FROM sessions WHERE id = ?').get(session.id);
  if (!s) return [];
  const drawn = db
    .prepare('SELECT q_order, question_id FROM session_questions WHERE session_id = ? ORDER BY q_order')
    .all(session.id);
  if (drawn.length) {
    const get = db.prepare('SELECT * FROM question_pool WHERE id = ?');
    return drawn
      .map((m) => {
        const row = get.get(m.question_id);
        if (row) row._pool = true;
        return row;
      })
      .filter(Boolean);
  }
  return db.prepare('SELECT * FROM questions WHERE exam_id = ? ORDER BY q_order').all(s.exam_id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern "sessionQuestionSequence" test/regression.test.js`
Expected: PASS.

- [ ] **Step 5: Export the helper**

Add `sessionQuestionSequence,` to `module.exports` (next to `getSessionQuestionCount`).

Run: `npm test` — expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/exam.js test/regression.test.js
git commit -m "Add session question sequence resolver"
```

---

### Task 4: `buildQuestionBubbles`

**Files:**
- Modify: `src/services/exam.js` — add helper after `formatQuestion`/`stripPaperOnlyInstructions`
- Modify: `src/services/exam.js` — export it
- Test: `test/regression.test.js`

**Interfaces:**
- Consumes: `formatQuestion` (Task 2), `stripPaperOnlyInstructions` (Task 1).
- Produces: `buildQuestionBubbles(exam, question, sequence, index) -> string[]` — ordered WhatsApp bubble texts: optional `*OBJECTIVE*`/`*THEORY*` banner, optional passage bubble, then the question bubble.

- [ ] **Step 1: Write the failing tests**

Append to `test/regression.test.js`:

```js
test('buildQuestionBubbles sends OBJECTIVE banner once then each question', () => {
  const q1 = { id: 1, q_order: 1, type: 'objective', text: 'Q1', passage: '' };
  const q2 = { id: 2, q_order: 2, type: 'objective', text: 'Q2', passage: '' };
  const seq = [q1, q2];
  assert.deepEqual(exam.buildQuestionBubbles({}, q1, seq, 0), ['*OBJECTIVE*', '*QUESTION 1*\n\nQ1']);
  assert.deepEqual(exam.buildQuestionBubbles({}, q2, seq, 1), ['*QUESTION 2*\n\nQ2']);
});

test('buildQuestionBubbles sends THEORY banner once before theory questions', () => {
  const q1 = { id: 1, q_order: 1, type: 'objective', text: 'Q1', passage: '' };
  const q2 = { id: 2, q_order: 2, type: 'theory', text: 'Q2', passage: '' };
  const q3 = { id: 3, q_order: 3, type: 'theory', text: 'Q3', passage: '' };
  const seq = [q1, q2, q3];
  assert.deepEqual(exam.buildQuestionBubbles({}, q2, seq, 1), ['*THEORY*', '*QUESTION 2*\n\nQ2']);
  assert.deepEqual(exam.buildQuestionBubbles({}, q3, seq, 2), ['*QUESTION 3*\n\nQ3']);
});

test('buildQuestionBubbles sends a shared passage once before the first question that uses it', () => {
  const passage = 'Read the passage.\nAma lost her pencil on the way to school.';
  const q1 = { id: 1, q_order: 1, type: 'objective', text: 'Q1', passage };
  const q2 = { id: 2, q_order: 2, type: 'objective', text: 'Q2', passage };
  const seq = [q1, q2];
  assert.deepEqual(exam.buildQuestionBubbles({}, q1, seq, 0), ['*OBJECTIVE*', passage, '*QUESTION 1*\n\nQ1']);
  assert.deepEqual(exam.buildQuestionBubbles({}, q2, seq, 1), ['*QUESTION 2*\n\nQ2']);
});

test('buildQuestionBubbles treats an unknown index as the first question', () => {
  const q = { id: 7, q_order: 3, type: 'objective', text: 'Q3', passage: 'Read the passage.' };
  assert.deepEqual(exam.buildQuestionBubbles({}, q, [], -1), ['*OBJECTIVE*', 'Read the passage.', '*QUESTION 3*\n\nQ3']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern "buildQuestionBubbles" test/regression.test.js`
Expected: FAIL — `exam.buildQuestionBubbles is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add after `stripPaperOnlyInstructions` in `src/services/exam.js`:

```js
/**
 * The chat bubbles to send for one question: a bold type banner (once per
 * type, before the first of its kind), the cleaned passage/instruction (once,
 * before the first question that uses it), then the question bubble. "Already
 * sent" is derived from the questions that precede this one in the sequence,
 * so resume/nudge re-sends never duplicate banners or passages.
 */
function buildQuestionBubbles(exam, question, sequence, index) {
  const bubbles = [];
  const type = question.type === 'theory' ? 'THEORY' : 'OBJECTIVE';
  const prev = index > 0 ? sequence.slice(0, index) : [];
  if (!prev.some((q) => q.type === question.type)) {
    bubbles.push(`*${type}*`);
  }
  const passage = stripPaperOnlyInstructions(question.passage).trim();
  if (passage && !prev.some((q) => stripPaperOnlyInstructions(q.passage).trim() === passage)) {
    bubbles.push(passage);
  }
  bubbles.push(formatQuestion(exam, question));
  return bubbles;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-name-pattern "buildQuestionBubbles" test/regression.test.js`
Expected: PASS.

- [ ] **Step 5: Export the helper**

Add `buildQuestionBubbles,` to `module.exports` (next to `formatQuestion`).

Run: `npm test` — expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/exam.js test/regression.test.js
git commit -m "Build per-question WhatsApp bubbles: banner once, passage once, question"
```

---

### Task 5: Wire `sendQuestionTo`

**Files:**
- Modify: `src/services/exam.js:247-265` — `sendQuestionTo`

**Interfaces:**
- Consumes: `sessionQuestionSequence` (Task 3), `buildQuestionBubbles` (Task 4), `formatOptions` (existing).
- Produces: `sendQuestionTo(session, student)` sends the banner/passage/question bubbles each as its own `wa.sendText`, then the options bubble for objective questions.

- [ ] **Step 1: Implement the wiring**

Replace the question-send block in `sendQuestionTo` (src/services/exam.js:260-264):

```js
  const sequence = sessionQuestionSequence(session);
  const index = sequence.findIndex((q) => q.id === question.id);
  for (const bubble of buildQuestionBubbles(exam, question, sequence, index)) {
    await wa.sendText(student.phone, bubble);
  }
  if (question.type === 'objective') {
    await wa.sendText(student.phone, formatOptions(exam, session, question));
  }
  return true;
```

- [ ] **Step 2: Verify no syntax/type regressions**

Run: `node --check src/services/exam.js` — expected: no output, exit 0.
Run: `npm test` — expected: all tests pass (the new helper tests cover the bubbles; `sendQuestionTo` itself is exercised by the existing test suite where applicable).

- [ ] **Step 3: Commit**

```bash
git add src/services/exam.js
git commit -m "Send banner, passage, and question as separate WhatsApp bubbles"
```

---

## Self-Review

- **Spec coverage:** strip → Task 1; banner once + `*QUESTION N*` → Tasks 2 + 4; passage own bubble once → Tasks 3 + 4; wiring → Task 5; tests → every task. Spec's "already-imported exams benefit, no schema change" → all send-time.
- **Placeholder scan:** every step carries concrete code and exact expected test output.
- **Type consistency:** `stripPaperOnlyInstructions(text) -> string`, `sessionQuestionSequence(session) -> Question[]`, `buildQuestionBubbles(exam, question, sequence, index) -> string[]`, `formatQuestion(exam, question, qCount) -> string` are used consistently across Tasks 1-5.
