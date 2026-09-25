# Recipient Dedupe and Phone Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One normalized phone number means one student. Bulk recipient import reports honest counts, surfaces name conflicts instead of silently overwriting, and rejects malformed numbers.

**Architecture:** A rules-table `normalizePhone` in `src/services/exam.js` replaces the branching prefix checks, so length is validated before any country-code inference. A new `addRecipients(examId, entries)` service runs the whole import in one SQLite transaction and returns a structured report. The route becomes a thin adapter; the UI gains a conflict review step.

**Tech Stack:** Node.js >= 22.5, CommonJS, `node:sqlite` (`DatabaseSync`), Express 4, `node:test` + `node:assert/strict`, vanilla browser JS.

## Global Constraints

- **Test database isolation is mandatory.** `src/db.js:9` opens `config.dbPath`, which `src/config.js:28` reads from `process.env.DB_PATH` at require time. Every new test file MUST set `process.env.DB_PATH` to a temp path **before** the first `require('../src/db')`, or it will write to the real `data/exams.db`. This is why existing tests in `test/regression.test.js` touch production data — do not copy that pattern.
- `normalizePhone` returns `''` for anything it cannot confidently map. Never return a partial or guessed number.
- A pre-existing student name always wins. An import must never rename an existing student.
- One transaction wraps the entire import. A failure must leave zero partial recipients.
- Tests run via `node --test`. `npm test` lists files **explicitly** — a new test file that is not added to the `test` script in `package.json` will silently never run.
- `WHATSAPP_SEND_INTERVAL_MS`, `sendConcurrency` and all pacing behaviour are out of scope.
- No new dependencies.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/services/exam.js` | `normalizePhone` (rules table), `splitRecipients` (tokenizer), `addRecipients` (transactional dedupe) |
| `src/routes/api.js` | Thin adapter: parse body, call `addRecipients`, respond |
| `src/public/app.js` | Use `splitRecipients` for the textarea; render the conflict review step |
| `test/recipient-dedupe.test.js` | All tests for this plan |
| `package.json` | Register the new test file |

`addRecipients` lives in `exam.js` rather than a new file because it is student/exam domain logic sitting beside `getOrCreateStudent` and `normalizePhone`, and it is needed by the route only. Splitting it out would create a module that imports `db` and is imported by exactly one caller.

---

## Task 1: Test harness and `normalizePhone` rewrite

Fixes defect 7: `src/services/exam.js:53` checks `p.startsWith('1')` before any length validation, so a 9-digit Ghanaian number beginning `1` is stored as a 9-digit NANP fragment instead of `2331xxxxxxxx`.

**Files:**
- Create: `test/recipient-dedupe.test.js`
- Modify: `src/services/exam.js:46-70`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `normalizePhone(raw: unknown): string` — returns E.164 digits with no `+`, or `''` when unmappable. Already exported from `src/services/exam.js`; signature and semantics change here.

- [ ] **Step 1: Write the test file with DB isolation and the failing test**

Create `test/recipient-dedupe.test.js`:

```js
'use strict';
// MUST precede every require of src/db — src/config.js reads DB_PATH at
// require time and src/db.js opens the file at require time.
const os = require('os');
const path = require('path');
process.env.DB_PATH = path.join(os.tmpdir(), `la-exam-dedupe-${process.pid}.db`);
process.env.SEED_ON_BOOT = 'false';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const exam = require('../src/services/exam');

// One row per input format. Every Ghanaian number must normalise to the same
// 12 digits no matter how it was typed; that identity is the whole point.
const NORMALIZE_CASES = [
  // Ghana, local with trunk 0
  ['0242004542', '233242004542'],
  ['0201234567', '233201234567'],
  // Ghana, already international
  ['233242004542', '233242004542'],
  ['+233 24 200 4542', '233242004542'],
  ['00233 24 200 4542', '233242004542'],
  // International with a stray national 0 after the country code
  ['2330242004542', '233242004542'],
  // THE REGRESSION: 9 digits beginning with 1 used to be treated as NANP
  ['123456789', '233123456789'],
  ['124567890', '233124567890'],
  // NANP stays untouched
  ['+1 202 555 0143', '12025550143'],
  ['12025550143', '12025550143'],
  // Nigeria
  ['08012345678', '2348012345678'],
  // Ten digits starting 2 is kept verbatim
  ['2025550143', '2025550143'],
  // Unmappable input yields empty string, never a guess
  ['abc', ''],
  ['123', ''],
  ['12345678901234567', ''],
  ['', ''],
  [null, ''],
];

test('normalizePhone maps every accepted format to one canonical number', () => {
  for (const [input, expected] of NORMALIZE_CASES) {
    assert.equal(
      exam.normalizePhone(input),
      expected,
      `normalizePhone(${JSON.stringify(input)}) should be ${JSON.stringify(expected)}`,
    );
  }
});

test('the five spellings of one Ghanaian number are indistinguishable', () => {
  const spellings = ['0242004542', '233242004542', '+233 24 200 4542', '00233242004542', '2330242004542'];
  const results = new Set(spellings.map((s) => exam.normalizePhone(s)));
  assert.equal(results.size, 1, `expected 1 canonical value, got ${[...results].join(', ')}`);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/recipient-dedupe.test.js`
Expected: FAIL. `normalizePhone('123456789')` returns `'123456789'` but the test expects `'233123456789'`; `normalizePhone('123')` returns `'123'` but expects `''`; `normalizePhone('12025550143')` may also mismatch. The failure message names the offending input.

- [ ] **Step 3: Replace `normalizePhone` with a rules table**

In `src/services/exam.js`, replace lines 46-70 (the whole `normalizePhone` function) with:

```js
/**
 * Candidate phone formats, most specific first. A rule that matches owns the
 * number outright. Length is validated BEFORE any country-code inference so a
 * short national number can never be mistaken for an international one — the
 * bug this table replaces checked `startsWith('1')` first, which turned every
 * 9-digit Ghanaian number beginning with 1 into a 9-digit NANP fragment.
 */
const PHONE_RULES = [
  // Explicit country code, with or without a stray national trunk 0.
  { re: /^2330?\d{9}$/, build: (p) => '233' + p.replace(/^2330/, '233') },
  { re: /^2340?\d{10}$/, build: (p) => '234' + p.replace(/^2340/, '234') },
  // North American: country code 1 plus ten digits.
  { re: /^1\d{10}$/, build: (p) => p },
  // Ghana national: 0XXXXXXXXX (ten) or XXXXXXXXX (nine).
  { re: /^0\d{9}$/, build: (p) => '233' + p.slice(1) },
  { re: /^\d{9}$/, build: (p) => '233' + p },
  // Nigeria national: 0XXXXXXXXXX (eleven) or XXXXXXXXXX (ten).
  { re: /^0\d{10}$/, build: (p) => '234' + p.slice(1) },
  // Ten digits beginning 2 is already an international local-part.
  { re: /^2\d{9}$/, build: (p) => p },
  // Remaining bare ten-digit numbers are Nigerian.
  { re: /^\d{10}$/, build: (p) => '234' + p },
];

function normalizePhone(raw) {
  const digits = String(raw == null ? '' : raw).replace(/[^\d]/g, '');
  if (!digits) return '';
  // 00 is the international access prefix; + was already stripped above.
  const p = digits.startsWith('00') ? digits.slice(2) : digits;
  for (const rule of PHONE_RULES) {
    if (rule.re.test(p)) return rule.build(p);
  }
  return '';
}
```

Delete the now-unreferenced comments about NANP handling that sat above the old function. Keep the `// ── Students ──` section header.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/recipient-dedupe.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Confirm the full suite still passes**

Run: `npm test`
Expected: the same pass/fail set as before this change. `normalizePhone` is called by `getOrCreateStudent` paths, so if any existing regression test depended on the old 9-digit-`1` behaviour it will now fail — read the failure before assuming it is unrelated.

- [ ] **Step 6: Commit**

```bash
git add src/services/exam.js test/recipient-dedupe.test.js
git commit -m "fix(phone): validate length before country-code inference

The prefix checks ran before any length validation, so a 9-digit Ghanaian
number beginning with 1 was stored as a 9-digit NANP fragment. Two spellings
of the same person therefore became two students. Replaces the branching
prefix checks with an ordered rules table and returns '' for anything it
cannot map instead of guessing."
```

---

## Task 2: Recipient tokenizer

Fixes defect 10: `src/public/app.js:1309` splits on `/[\n,]+/` only, so a pasted list separated by semicolons, tabs or spaces yields one bogus "phone number".

**Files:**
- Modify: `src/services/exam.js` (add `splitRecipients` after `normalizePhone`)
- Test: `test/recipient-dedupe.test.js`

**Interfaces:**
- Consumes: `normalizePhone` from Task 1.
- Produces: `splitRecipients(raw: unknown): string[]` — raw tokens with whitespace trimmed and empties dropped. **Does not validate**; validation is the caller's job so it can report per-token reasons. Exported from `src/services/exam.js`.

- [ ] **Step 1: Write the failing test**

Append to `test/recipient-dedupe.test.js`:

```js
test('splitRecipients breaks a pasted list on every common separator', () => {
  assert.deepEqual(
    exam.splitRecipients('0242004542, 0244004542\n0246004542'),
    ['0242004542', '0244004542', '0246004542'],
  );
  assert.deepEqual(
    exam.splitRecipients('0242004542;0244004542\t0246004542'),
    ['0242004542', '0244004542', '0246004542'],
  );
  assert.deepEqual(
    exam.splitRecipients('0242004542\r\n0244004542\r\n'),
    ['0242004542', '0244004542'],
  );
  assert.deepEqual(exam.splitRecipients('0242004542,,,;  \n'), ['0242004542']);
  assert.deepEqual(exam.splitRecipients(''), []);
  assert.deepEqual(exam.splitRecipients(null), []);
});

test('splitRecipients does not merge a name that follows its number', () => {
  // A pasted "number name" pair keeps both tokens; the name is a separate
  // field supplied by the UI, not something the tokenizer should discard.
  assert.deepEqual(
    exam.splitRecipients('0242004542 Ama Serwaa'),
    ['0242004542', 'Ama', 'Serwaa'],
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/recipient-dedupe.test.js`
Expected: FAIL with `TypeError: exam.splitRecipients is not a function`.

- [ ] **Step 3: Implement `splitRecipients`**

In `src/services/exam.js`, immediately after the `normalizePhone` function, add:

```js
/**
 * Split a pasted recipient list into raw tokens. Accepts commas, semicolons,
 * pipes, tabs, newlines and runs of spaces. Does NOT validate: an invalid
 * token must reach the caller so it can report the exact input and reason
 * rather than silently disappearing.
 */
function splitRecipients(raw) {
  return String(raw == null ? '' : raw)
    .split(/[\s,;|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/recipient-dedupe.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/exam.js test/recipient-dedupe.test.js
git commit -m "feat(recipients): split pasted lists on every common separator

The textarea only split on newlines and commas, so a list pasted with
semicolons, tabs or spaces became a single invalid number. Tokenizing only;
validation stays with the caller so bad input is reported, not dropped."
```

---

## Task 3: Transactional `addRecipients` with dedupe and conflict detection

Fixes defects 8, 9 and 12 in `src/routes/api.js:292-305`: `added.push()` runs even when `INSERT OR IGNORE` was ignored (so "Added 7" counts submitted lines), a duplicate line overwrites the student's **global** name, and `getOrCreateStudent` is a read-then-write outside a transaction so a concurrent duplicate raises `SQLITE_CONSTRAINT_UNIQUE` and fails the whole import.

**Files:**
- Modify: `src/services/exam.js` (add `addRecipients` after `getOrCreateStudent`)
- Test: `test/recipient-dedupe.test.js`

**Interfaces:**
- Consumes: `normalizePhone`, `db`.
- Produces:
  ```js
  addRecipients(examId, entries) -> {
    added:    Array<{ id: number, phone: string, name: string }>,
    merged:   number,
    conflicts:Array<{ phone: string, existingName: string, incomingName: string }>,
    invalid:  Array<{ input: string, reason: string }>
  }
  ```
  `entries` is `Array<{ phone: string, name?: string }>`. Runs entirely inside one transaction; on any unexpected error it rolls back and rethrows. Exported from `src/services/exam.js`.

- [ ] **Step 1: Write the failing tests**

Append to `test/recipient-dedupe.test.js`. These need a real (temp) database, so add the setup block first, right after the existing requires:

```js
const db = require('../src/db');

function makeExam(title) {
  return db
    .prepare("INSERT INTO exams (title, subject, duration_minutes, status) VALUES (?,?,?,'published')")
    .run(title, 'Test', 60).lastInsertRowid;
}

function recipientCount(examId) {
  return db
    .prepare('SELECT COUNT(*) c FROM exam_recipients WHERE exam_id = ?')
    .get(examId).c;
}
```

Then append the tests:

```js
test('addRecipients links a new student and reports it as added', () => {
  const examId = makeExam('__dedupe_new__');
  const r = exam.addRecipients(examId, [{ phone: '0242004542', name: 'Ama Serwaa' }]);
  assert.equal(r.added.length, 1);
  assert.equal(r.merged, 0);
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.added[0].phone, '233242004542');
  assert.equal(r.added[0].name, 'Ama Serwaa');
  assert.equal(recipientCount(examId), 1);
});

test('addRecipients collapses five spellings of one number into one recipient', () => {
  const examId = makeExam('__dedupe_spellings__');
  const r = exam.addRecipients(examId, [
    { phone: '0242004542' },
    { phone: '233242004542' },
    { phone: '+233 24 200 4542' },
    { phone: '00233242004542' },
    { phone: '0242004542' },
  ]);
  assert.equal(r.added.length, 1, 'only the first spelling creates a student');
  assert.equal(r.merged, 4, 'the other four are reported as merged, not added');
  assert.equal(recipientCount(examId), 1);
});

test('addRecipients counts a repeat against an existing recipient as merged', () => {
  const examId = makeExam('__dedupe_repeat__');
  exam.addRecipients(examId, [{ phone: '0242004542', name: 'Ama Serwaa' }]);
  const second = exam.addRecipients(examId, [{ phone: '0242004542', name: 'Ama Serwaa' }]);
  assert.equal(second.added.length, 0);
  assert.equal(second.merged, 1);
  assert.equal(recipientCount(examId), 1, 're-adding must not create a second recipient row');
});

test('addRecipients reports a name conflict and never renames the student', () => {
  const examId = makeExam('__dedupe_conflict__');
  exam.addRecipients(examId, [{ phone: '0242004542', name: 'Ama Serwaa' }]);
  const r = exam.addRecipients(examId, [{ phone: '233242004542', name: 'Ama Serwea' }]);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].phone, '233242004542');
  assert.equal(r.conflicts[0].existingName, 'Ama Serwaa');
  assert.equal(r.conflicts[0].incomingName, 'Ama Serwea');
  const student = db.prepare('SELECT name FROM students WHERE phone = ?').get('233242004542');
  assert.equal(student.name, 'Ama Serwaa', 'existing name must win');
});

test('a name-only re-add does not raise a conflict', () => {
  const examId = makeExam('__dedupe_noname__');
  exam.addRecipients(examId, [{ phone: '0242004542', name: 'Ama Serwaa' }]);
  const r = exam.addRecipients(examId, [{ phone: '0242004542' }]);
  assert.deepEqual(r.conflicts, [], 'an absent name is not a disagreement');
  assert.equal(r.merged, 1);
});

test('a blank incoming name never clears an existing name', () => {
  const examId = makeExam('__dedupe_blank__');
  exam.addRecipients(examId, [{ phone: '0242004542', name: 'Ama Serwaa' }]);
  exam.addRecipients(examId, [{ phone: '0242004542', name: '   ' }]);
  const student = db.prepare('SELECT name FROM students WHERE phone = ?').get('233242004542');
  assert.equal(student.name, 'Ama Serwaa');
});

test('addRecipients reports invalid input with the original text and a reason', () => {
  const examId = makeExam('__dedupe_invalid__');
  const r = exam.addRecipients(examId, [
    { phone: '0242004542', name: 'Ama' },
    { phone: 'abc', name: 'Broken' },
    { phone: '123', name: 'Too short' },
  ]);
  assert.equal(r.added.length, 1);
  assert.equal(r.invalid.length, 2);
  assert.equal(r.invalid[0].input, 'abc');
  assert.match(r.invalid[0].reason, /number/i);
  assert.equal(r.invalid[1].input, '123');
});

test('addRecipients links an already-known student who is new to this exam', () => {
  const examId = makeExam('__dedupe_existing_student__');
  const studentId = db
    .prepare("INSERT INTO students (phone, name) VALUES ('233990001111','Kofi Mensah')")
    .run().lastInsertRowid;
  const r = exam.addRecipients(examId, [{ phone: '0990001111' }]);
  assert.equal(r.merged, 1, 'a known student is a merge, not a creation');
  assert.equal(r.added.length, 0);
  const link = db
    .prepare('SELECT student_id FROM exam_recipients WHERE exam_id = ?')
    .get(examId);
  assert.equal(link.student_id, studentId, 'the existing student row is reused');
  assert.deepEqual(r.conflicts, []);
});

test('addRecipients rolls the whole import back when a link fails', () => {
  // exam_recipients.exam_id is a foreign key and src/db.js:10 turns
  // PRAGMA foreign_keys ON, so linking to a non-existent exam throws AFTER the
  // student row has been inserted. That is exactly the window a missing
  // transaction would leak.
  const before = db.prepare('SELECT COUNT(*) c FROM students').get().c;
  assert.throws(() => exam.addRecipients(99999999, [{ phone: '0242004542' }]));
  const after = db.prepare('SELECT COUNT(*) c FROM students').get().c;
  assert.equal(after, before, 'a thrown error must roll the whole import back');
});

test('addRecipients reports a blank or null phone as invalid rather than throwing', () => {
  const examId = makeExam('__dedupe_blank_phone__');
  const r = exam.addRecipients(examId, [{ phone: '0242004542' }, { phone: null }, { phone: '  ' }]);
  assert.equal(r.added.length, 1);
  assert.equal(r.invalid.length, 2);
  assert.equal(recipientCount(examId), 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/recipient-dedupe.test.js`
Expected: FAIL with `TypeError: exam.addRecipients is not a function`. The two `normalizePhone` and two `splitRecipients` tests still pass.

- [ ] **Step 3: Implement `addRecipients`**

In `src/services/exam.js`, immediately after the `getOrCreateStudent` function, add:

```js
/**
 * Link recipients to an exam, collapsing duplicates by normalized number.
 *
 * Runs in one transaction: `students.phone` is UNIQUE, so a read-then-write
 * outside a transaction lets a concurrent import of the same new number raise
 * SQLITE_CONSTRAINT_UNIQUE and lose every recipient in the batch.
 *
 * An existing student name ALWAYS wins. A differing incoming name is reported
 * as a conflict for the admin to resolve — importing exam 2 must never rename
 * a student on exam 1.
 */
function addRecipients(examId, entries) {
  const added = [];
  const conflicts = [];
  const invalid = [];
  let merged = 0;

  const insertStudent = db.prepare('INSERT INTO students (phone, name) VALUES (?, ?)');
  const findStudent = db.prepare('SELECT * FROM students WHERE phone = ?');
  const linkRecipient = db.prepare(
    'INSERT OR IGNORE INTO exam_recipients (exam_id, student_id) VALUES (?, ?)',
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    // Collapse on the normalized number, keeping first-seen order so the
    // report reads in the order the admin pasted.
    const byPhone = new Map();
    for (const entry of entries || []) {
      const raw = entry && entry.phone;
      const phone = normalizePhone(raw);
      if (!phone) {
        invalid.push({ input: String(raw == null ? '' : raw), reason: 'Not a recognised phone number' });
        continue;
      }
      const name = String((entry && entry.name) || '').trim();
      const prior = byPhone.get(phone);
      if (prior) {
        // Same number pasted twice. A name on the later copy that disagrees
        // with the first is a conflict; an absent or equal one is not.
        if (name && prior.name && name !== prior.name) {
          conflicts.push({ phone, existingName: prior.name, incomingName: name });
        } else if (name && !prior.name) {
          prior.name = name;
        }
        continue;
      }
      byPhone.set(phone, { phone, name });
    }

    for (const { phone, name } of byPhone.values()) {
      let student = findStudent.get(phone);
      if (!student) {
        const info = insertStudent.run(phone, name);
        student = findStudent.get(info.lastInsertRowid);
        added.push({ id: student.id, phone, name: student.name || '' });
      } else {
        merged++;
        if (name && !student.name) {
          // Only ever fills a blank. Never overwrites a real name.
          db.prepare('UPDATE students SET name = ? WHERE id = ?').run(name, student.id);
          student = findStudent.get(student.id);
        } else if (name && student.name && name !== student.name) {
          conflicts.push({ phone, existingName: student.name, incomingName: name });
        }
      }
      linkRecipient.run(examId, student.id);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { added, merged, conflicts, invalid };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/recipient-dedupe.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/exam.js test/recipient-dedupe.test.js
git commit -m "feat(recipients): transactional dedupe with conflict reporting

added[] was pushed unconditionally, so the success count reported pasted
lines rather than new students; a duplicate line also overwrote the
student's global name, and the read-then-write in getOrCreateStudent could
abort an entire batch on a concurrent duplicate. One transaction, explicit
collapse on the normalized number, and a reported conflict instead of a
silent rename."
```

---

## Task 4: Route the endpoint through `addRecipients`

**Files:**
- Modify: `src/routes/api.js:280-306`

**Interfaces:**
- Consumes: `examService.addRecipients(examId, entries) -> report` from Task 3.
- Produces: `POST /api/exams/:id/recipients` responds `{ added, merged, conflicts, invalid, counts: { added: number, merged: number } }`. `added` keeps its existing array shape so the current UI keeps working; `counts` and the new keys are additive.

- [ ] **Step 1: Confirm there is no HTTP test harness**

Run: `Select-String -Path package.json -Pattern "supertest|light-my-request"`
Expected: no match. The project has no HTTP test dependency, so this route is
verified by hand in Step 3 rather than by a request-level test. **Do not add a
test dependency for this one endpoint.**

- [ ] **Step 2: Replace the route body**

In `src/routes/api.js`, replace the handler at lines 280-306 with:

```js
router.post('/exams/:id/recipients', (req, res) => {
  const { phones, students } = req.body || {};
  const entries = [];
  if (Array.isArray(students)) {
    for (const s of students) {
      if (s && s.phone) entries.push({ phone: s.phone, name: s.name || '' });
    }
  } else {
    const flat = Array.isArray(phones) ? phones : [phones];
    for (const p of flat) {
      if (typeof p !== 'string') continue;
      // One pasted string may hold many numbers; tokenize before validating
      // so a semicolon- or space-separated list is not lost as a single
      // invalid entry.
      for (const token of examService.splitRecipients(p)) {
        entries.push({ phone: token, name: '' });
      }
    }
  }

  const report = examService.addRecipients(req.params.id, entries);
  res.json({ ...report, counts: { added: report.added.length, merged: report.merged } });
});
```

- [ ] **Step 3: Verify the route manually**

Run the server in one terminal (`npm start`) and in another:

```bash
curl -s -X POST http://localhost:3000/api/exams/1/recipients -H "Content-Type: application/json" -d "{\"phones\":\"0242004542, 233242004542;0244004542\"}"
```

Expected JSON: `added` has exactly one entry, `counts.merged` is 1, `invalid` is empty. Paste the same payload again and confirm `counts.added` is 0 and `counts.merged` is 3.

- [ ] **Step 4: Commit**

```bash
git add src/routes/api.js
git commit -m "feat(api): report honest recipient counts and conflicts

The route reported one entry per pasted line and silently renamed students.
It now returns counts, name conflicts and invalid input, and tokenizes a
pasted multi-number string before validating it."
```

---

## Task 5: UI — tokenizer and conflict review

Fixes the client half of defect 10 and surfaces the conflicts from Task 3.

**Files:**
- Modify: `src/public/app.js:1309` (the textarea split) and the add-recipients handler immediately after it
- Modify: `src/public/index.html` (add the `recipientReview` host element if absent)

**Interfaces:**
- Consumes: the Task 4 response `{ added, merged, conflicts, invalid, counts }`.
- Produces: `splitRecipientInput(raw) -> string[]` — a browser-local tokenizer. Not exported to CommonJS; this file is served as a plain script.

- [ ] **Step 1: Confirm the split site and add the review host**

Run: `Select-String -Path src/public/app.js -Pattern "split\(" -Context 2,4`
Expected: a `split(/[\n,]+/)` at approximately line 1309 inside the add-recipients handler.

Run: `Select-String -Path src/public/index.html -Pattern "recipientReview"`
Expected: no match. Add the host directly after the add-recipients button:

```html
<div id="recipientReview" hidden></div>
```

- [ ] **Step 2: Replace the split with a browser-side tokenizer**

Replace the `split(/[\n,]+/)` expression with a call to a small local helper. Add it near the top of `src/public/app.js`, after the other utility functions:

```js
/** Split a pasted recipient list on commas, semicolons, pipes, tabs, newlines and spaces. */
function splitRecipientInput(raw) {
  return String(raw == null ? '' : raw)
    .split(/[\s,;|]+/)
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
}
```

Then use it in the handler:

```js
const tokens = splitRecipientInput(textarea.value);
```

`src/public/app.js` is served as a plain script to the browser, so it cannot
`require` the service. The rule is duplicated deliberately: the service copy
guarantees the API is correct for any caller, and the browser copy keeps the
preview honest.

- [ ] **Step 3: Render the conflict review step**

In the recipients panel, after the add-recipients success message, render a
review block when `conflicts.length` or `invalid.length` is non-zero. Insert
this before the `Send Exam to Recipients` button is enabled:

```js
function renderRecipientReview(report) {
  var host = document.getElementById('recipientReview');
  if (!host) return;
  var parts = [];
  if (report.conflicts && report.conflicts.length) {
    parts.push('<div class="warn"><strong>' + report.conflicts.length +
      ' name conflict' + (report.conflicts.length === 1 ? '' : 's') + ' — kept the existing name:</strong><ul>');
    for (var i = 0; i < report.conflicts.length; i++) {
      var c = report.conflicts[i];
      parts.push('<li>' + esc(c.phone) + ': kept &quot;' + esc(c.existingName) +
        '&quot;, ignored &quot;' + esc(c.incomingName) + '&quot;</li>');
    }
    parts.push('</ul></div>');
  }
  if (report.invalid && report.invalid.length) {
    parts.push('<div class="fail"><strong>' + report.invalid.length +
      ' could not be added:</strong><ul>');
    for (var j = 0; j < report.invalid.length; j++) {
      parts.push('<li>&quot;' + esc(report.invalid[j].input) + '&quot; — ' +
        esc(report.invalid[j].reason) + '</li>');
    }
    parts.push('</ul></div>');
  }
  host.innerHTML = parts.join('');
  host.hidden = parts.length === 0;
}
```

Verify `esc` exists in `src/public/app.js` before using it:

Run: `Select-String -Path src/public/app.js -Pattern "function esc"`
Expected: a match. If absent, add `function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}`

Call `renderRecipientReview(report)` from the add-recipients success handler,
after updating the recipient table.

- [ ] **Step 4: Verify in the browser**

Run: `npm start`, open the admin recipients tab, and paste:

```
0242004542 Ama Serwaa
233242004542; Ama Serwea
abc
```

Expected: one recipient added, a conflict row for `233242004542` keeping
"Ama Serwaa", and `abc` listed as unaddable. Re-paste the same block and
confirm the added count is 0.

- [ ] **Step 5: Commit**

```bash
git add src/public/app.js
git commit -m "feat(ui): show recipient name conflicts and rejected input

Paste only split on newlines and commas, so semicolon- or space-separated
lists were lost. The review block makes the dedupe outcome visible instead
of silently keeping the first name."
```

---

## Task 6: Register the test file

`npm test` enumerates test files explicitly. Without this, everything above
builds and then never runs.

**Files:**
- Modify: `package.json:13`

**Interfaces:**
- Consumes: `test/recipient-dedupe.test.js` from Task 1.
- Produces: `npm test` runs the new file.

- [ ] **Step 1: Add the file to the test script**

Change the `test` script to:

```json
"test": "node --test test/regression.test.js test/pdf-images.test.js test/image-answers.test.js test/recipient-dedupe.test.js",
```

`test/sentence-merging.test.js` exists but is not listed. Leave it alone —
adding it is out of scope, but mention it in the completion report.

- [ ] **Step 2: Run the whole suite**

Run: `npm test`
Expected: all suites pass, with the new file's 12 tests included.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(test): register recipient-dedupe suite in npm test

node --test takes explicit file paths, so the new suite never ran."
```

---

## Verification

Run after Task 6:

```bash
npm test
git status --short
git log --oneline -6
```

Expected: green suite, a clean working tree, and six commits matching the
tasks above.

Manual end-to-end check on a scratch exam:

1. Import `0242004542`, `+233 24 200 4542` and `00233 24 200 4542` in one
   paste. Expect one recipient.
2. Import the same three with a differing name. Expect a conflict, the
   original name preserved, and zero new students.
3. Import `abc` and `123`. Expect both rejected with reasons.
4. Confirm the success toast reads "Added 1" on the first import and
   "Added 0" on every subsequent one.

## Rollback

Every change is additive. Reverting the six commits restores the previous
behaviour; no schema change is involved, so no data migration is reversed.

## Out of Scope

- Backfilling or repairing names already overwritten by the old route.
- A per-number merge/rename endpoint for resolving conflicts after the fact.
- Correcting numbers already stored under the old normalizer. Run
  `SELECT phone FROM students WHERE length(phone) <> 12 AND phone NOT LIKE '1%'` to
  find candidates; repairing them is a separate decision.
- International formats beyond Ghana, Nigeria and NANP.
