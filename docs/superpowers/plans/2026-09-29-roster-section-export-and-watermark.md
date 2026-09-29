# Roster Section Export, Word Download, and Watermark Branding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an administrator export the exam roster for one selected section as CSV, a branded print page, or a branded Word `.docx`, and let them upload the app-wide watermark logo from the Participants tab.

**Tech Stack:** Node 24 (`node:zlib` for the ZIP container), Express 5, `sharp` for image processing, `multer` memory storage, vanilla browser JS. **No new npm dependencies.**

**Design:** [docs/plans/2026-09-29-roster-section-export-and-watermark-design.md](../../plans/2026-09-29-roster-section-export-and-watermark-design.md)

---

## Context You Need

`buildParticipantRoster(examId)` in `src/services/results.js:430` is the single source of truth and is **not modified by this plan**. It returns:

```js
{
  exam:  { id, title, duration_minutes, pass_percentage, status },
  finished: [...], inProgress: [...], notStarted: [...], notSent: [...],
  summary: { total, finished, inProgress, notStarted, notSent },
}
```

Every student row carries `rank`, `name`, `phone`, `final_score`, `final_percentage`, `passed`, `attempt_no`, `ended_at`, `started_at`, `questions_answered`, `status`.

Existing serialisers to modify:

| symbol | location | current signature |
|---|---|---|
| `csvCell` | `src/services/results.js:582` | `(value) => string` — formula-injection guard, **keep unchanged** |
| `rosterToCsv` | `src/services/results.js:591` | `(roster) => string` |
| `rosterPrintHTML` | `src/services/results.js:667` | `(roster) => string` |
| `esc` | `src/services/results.js:348` | escapes `&`, `<`, `>` only — **does not escape `"`** |
| `PRINT_CSS` | `src/services/results.js:~618` | embedded in the print document |

Routes to add (all after the existing admin guard at `src/routes/api.js:81`, wrapped in `asyncWrap` at `src/routes/api.js:144`):

```
GET    /api/exams/:id/participants/print?section=key
GET    /api/exams/:id/participants.csv?section=key
GET    /api/exams/:id/participants.docx?section=key
GET    /api/watermark-logo          -> { custom, url }
POST   /api/watermark-logo          -> multer memory image -> saved PNG
DELETE /api/watermark-logo
GET    /api/watermark-logo.png      -> processed PNG bytes (UI thumbnail)
```

`src/server.js:32` already sets `Access-Control-Expose-Headers: Content-Disposition`, so no CORS change is needed.

---

## Two deviations from the design doc — deliberate, flag them to the user

1. **Tests go in focused new files**, not appended to `test/participant-roster.test.js`, which is already large. Each new file must `require('./helpers/isolate')` **first**, matching `test/participant-roster.test.js` and `test/recipient-route.test.js`.
2. **Simple-group CSV blocks shrink from eight columns to four.** `rosterToCsv` today prints the finished eight-column `head` for *every* group (`src/services/results.js:600`, applied at lines 610-613), which is a bug: Not Sent rows have no score and no verdict. The design's column table says `notSent` is `Name, Phone, Questions answered, Started`. This changes the output shape of an existing export and requires updating the CSV assertion in `test/participant-roster.test.js` (~line 419). The print page and screen are **already** four columns; only the CSV is wrong.

---

## Task 1: Section vocabulary, filtering, and file naming

**Files:** `src/services/results.js`, `test/roster-sections.test.js`

- [ ] **Step 1.1** Add `test/roster-sections.test.js` with a failing test file skeleton. It must start:

```js
require('./helpers/isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROSTER_SECTIONS, normalizeSection, sectionGroups, sectionStamp, sectionSlug } = require('../src/services/results');
```

- [ ] **Step 1.2** Write failing tests:

```js
test('normalizeSection accepts every key, case- and whitespace-insensitively', () => {
  for (const key of Object.keys(ROSTER_SECTIONS)) {
    assert.equal(normalizeSection(key), key);
    assert.equal(normalizeSection(` ${key.toUpperCase()} `), key);
  }
  assert.deepEqual(Object.keys(ROSTER_SECTIONS), [
    'total', 'finished', 'in_progress', 'not_started', 'not_sent',
  ]);
});

test('normalizeSection falls back to total for junk, missing, and inherited keys', () => {
  for (const junk of [undefined, null, '', '   ', 'nope', 'toString', 'constructor',
                      '__proto__', 'hasOwnProperty', 0, false, {}, ['finished']]) {
    assert.equal(normalizeSection(junk), 'total', `input: ${String(junk)}`);
  }
});

test('sectionGroups returns the group keys for a section', () => {
  assert.deepEqual(sectionGroups('total'),
    ['finished', 'inProgress', 'notStarted', 'notSent']);
  assert.deepEqual(sectionGroups('not_sent'), ['notSent']);
  assert.deepEqual(sectionGroups('bogus'),
    ['finished', 'inProgress', 'notStarted', 'notSent']);
  // The stored group name (camelCase) differs from the URL key (snake_case).
  assert.deepEqual(sectionGroups('in_progress'), ['inProgress']);
});

test('sectionStamp is empty for total and human-readable otherwise', () => {
  assert.equal(sectionStamp('total'), '');
  assert.equal(sectionStamp('not_sent'), 'Not sent');
  assert.equal(sectionStamp('in_progress'), 'In progress');
  assert.equal(sectionStamp('garbage'), '');   // resolves to total
});

test('sectionSlug is filename-safe: snake_case, non-empty for total', () => {
  assert.equal(sectionSlug('not_sent'), 'Not-sent');
  assert.equal(sectionSlug('in_progress'), 'In-progress');
  assert.equal(sectionSlug('not_started'), 'Not-started');
  assert.match(sectionSlug('total'), /^[A-Za-z0-9-]+$/);
  assert.doesNotMatch(sectionSlug('not_sent'), /\s/);
});
```

- [ ] **Step 1.3** Run the test and watch it fail: `node --test test/roster-sections.test.js`

- [ ] **Step 1.4** Implement in `src/services/results.js`, immediately above `rosterToCsv`:

```js
// One definition of the five exportable sections. The keys are the URL
// vocabulary; the labels are what the dropdown, the document stamp and the
// filename use. The stored group names are camelCase, so `in_progress` and
// `inProgress` are deliberately different strings.
const ROSTER_SECTIONS = {
  total:       { label: 'Total',       groups: ['finished', 'inProgress', 'notStarted', 'notSent'] },
  finished:    { label: 'Finished',    groups: ['finished'] },
  in_progress: { label: 'In progress', groups: ['inProgress'] },
  not_started: { label: 'Not started', groups: ['notStarted'] },
  not_sent:    { label: 'Not sent',    groups: ['notSent'] },
};

// Unknown, missing or malformed input resolves to 'total' rather than
// throwing: these URLs are also built by bookmark and by a bare button
// click, and a section typo must not turn a register into a 404.
// The hasOwnProperty guard is deliberate - a plain truthy lookup on
// ROSTER_SECTIONS[key] would resolve 'constructor' and 'toString' to
// something truthy and then fail confusingly further down.
function normalizeSection(value) {
  const key = String(value == null ? '' : value).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ROSTER_SECTIONS, key) ? key : 'total';
}

function sectionGroups(section) {
  return ROSTER_SECTIONS[normalizeSection(section)].groups;
}

// 'Not sent' for the document stamp, '' for total so an unfiltered export
// keeps exactly today's appearance and filename.
function sectionStamp(section) {
  const key = normalizeSection(section);
  return key === 'total' ? '' : ROSTER_SECTIONS[key].label;
}

// 'Not-sent' for a filename: no spaces, no case-destroying surprises.
function sectionSlug(section) {
  const key = normalizeSection(section);
  return key === 'total' ? 'Total' : ROSTER_SECTIONS[key].label.replace(/\s+/g, '-');
}
```

- [ ] **Step 1.5** Append the four names to the `module.exports` object at `src/services/results.js:748`:

```js
module.exports = { /* ...existing... */ ROSTER_SECTIONS, normalizeSection, sectionGroups, sectionStamp, sectionSlug };
```

- [ ] **Step 1.6** Run `node --test test/roster-sections.test.js` — expect 5/5 pass.
- [ ] **Step 1.7** Run `npm test` — expect no new failures (Task 2 is the only intentional behaviour change and is not made yet).

**Commit:** `feat(roster): add section vocabulary and filename slugs`

---

## Task 2: One column definition per group, and section filtering in CSV

**Files:** `src/services/results.js`, `test/roster-sections.test.js`, `test/participant-roster.test.js`

The three simple groups share one shape. Declare it once so CSV, print, Word and the screen cannot drift.

- [ ] **Step 2.1** Add failing tests to `test/roster-sections.test.js`:

```js
const { rosterToCsv, csvCell, buildParticipantRoster } = require('../src/services/results');

const stubExam = { exam: { id: 12, title: 'Maths', duration_minutes: 30, pass_percentage: 50, status: 'live' } };
function stub(over = {}) {
  return {
    ...stubExam,
    finished: [], inProgress: [], notStarted: [], notSent: [],
    summary: { total: 0, finished: 0, inProgress: 0, notStarted: 0, notSent: 0 },
    ...over,
  };
}

test('rosterToCsv emits only the selected section', () => {
  const r = stub({
    finished:    [{ rank: 1, name: 'Ann', phone: '1', final_score: 9, final_percentage: 90, passed: 1, attempt_no: 1, ended_at: 'T' }],
    inProgress:  [{ name: 'Bob', phone: '2', questions_answered: 3, started_at: 'S1' }],
    notStarted:  [{ name: 'Cid', phone: '3', questions_answered: 0, started_at: null }],
    notSent:     [{ name: 'Dee', phone: '4', questions_answered: 0, started_at: null }],
  });
  const total = rosterToCsv(r, 'total');
  for (const t of ['Finished', 'In Progress', 'Not Started', 'Not Sent']) {
    assert.ok(total.includes(t), `total should contain ${t}`);
  }
  const notSent = rosterToCsv(r, 'not_sent');
  assert.ok(notSent.includes('Not Sent'));
  for (const t of ['Finished (ranked', 'In Progress', 'Not Started']) {
    assert.ok(!notSent.includes(t), `${t} must not leak into not_sent`);
  }
  assert.ok(notSent.includes('Dee'));
  assert.ok(!notSent.includes('Ann'));
  // An unknown or missing section behaves exactly like total.
  assert.equal(rosterToCsv(r, 'bogus'), total);
  assert.equal(rosterToCsv(r, undefined), total);
});

test('simple-group CSV blocks use four columns, not the finished eight', () => {
  const csv = rosterToCsv(stub({ notSent: [{ name: 'Dee', phone: '4', questions_answered: 0, started_at: null }] }), 'not_sent');
  assert.ok(csv.includes('Name,Phone,Questions answered,Started'), csv);
  assert.ok(!csv.includes('Position,Name,Phone,Score'), csv);
  assert.ok(!csv.includes('Result,Attempt'), csv);
});

test('rosterToCsv still guards formula injection and still carries a BOM', () => {
  const csv = rosterToCsv(stub({ notSent: [{ name: '=cmd|calc', phone: '4', questions_answered: 0, started_at: null }] }), 'not_sent');
  assert.ok(csv.startsWith('\uFEFF'), 'BOM must survive so Excel reads UTF-8 names');
  assert.ok(csv.includes("'=cmd|calc"), csv);
  assert.ok(!/(^|,)"?=cmd/.test(csv.replace(/'/g, '')), 'leading = must be neutralised');
  assert.equal(csvCell('=x'), "'=x");
});
```

- [ ] **Step 2.2** Run and watch it fail. The `Position,Name,Phone,Score` assertion must fail today.
- [ ] **Step 2.3** Rewrite `rosterToCsv` in `src/services/results.js`. **Note the rename:** the existing local helper is called `section(title, rows, withRank)`, which now collides with the `section` parameter — rename it to `block`.

```js
// Declared once, consumed by CSV, print, Word and the screen. The three
// simple groups genuinely share one shape; declaring it three times is how
// they came to disagree.
const ROSTER_FINISHED_COLS = ['Position', 'Name', 'Phone', 'Score', 'Percentage', 'Result', 'Attempt', 'Finished At'];
const ROSTER_SIMPLE_COLS = ['Name', 'Phone', 'Questions answered', 'Started'];

// section key -> [ block title, column head, row builder, roster field ]
function rosterBlocks(roster, section) {
  const all = {
    finished: ['Finished (ranked by percentage)', ROSTER_FINISHED_COLS, true, roster.finished],
    inProgress: ['In Progress', ROSTER_SIMPLE_COLS, false, roster.inProgress],
    notStarted: ['Not Started', ROSTER_SIMPLE_COLS, false, roster.notStarted],
    notSent: ['Not Sent', ROSTER_SIMPLE_COLS, false, roster.notSent],
  };
  return sectionGroups(section).map((k) => all[k]);
}

function rosterToCsv(roster, section) {
  const lines = [];
  lines.push(csvCell(roster.exam.title));
  const stamp = sectionStamp(section);
  if (stamp) lines.push('Section,' + csvCell(stamp));
  lines.push('Generated,' + csvCell(new Date().toISOString()));
  lines.push('');

  // `passed` is null for anyone who has not finished, which is a THIRD state,
  // not a fail: a plain truthiness test would print "Fail" next to a student
  // who has not been marked at all. So the em dash the report already uses for
  // a missing value stands in for "no result yet".
  const outcome = (passed) =>
    passed === null || passed === undefined ? '-' : passed ? 'Pass' : 'Fail';

  const finishedRow = (r) => [r.rank, r.name, r.phone,
    r.final_score ?? '', r.final_percentage ?? '',
    outcome(r.passed), r.attempt_no || '', r.ended_at || ''].map(csvCell).join(',');
  const simpleRow = (r) => [r.name, r.phone, r.questions_answered ?? '', r.started_at || '']
    .map(csvCell).join(',');

  for (const [title, head, withRank, rows] of rosterBlocks(roster, section)) {
    lines.push(csvCell(title));
    if (!rows.length) { lines.push('(none)'); lines.push(''); continue; }
    lines.push(head.map(csvCell).join(','));
    for (const r of rows) lines.push(withRank ? finishedRow(r) : simpleRow(r));
    lines.push('');
  }

  // BOM so Excel opens UTF-8 names (accents, non-Latin) correctly.
  return '\uFEFF' + lines.join('\r\n');
}
```

- [ ] **Step 2.4** Update the existing CSV assertion in `test/participant-roster.test.js` (~line 419) that expects the eight-column head for a simple group. Find it with `Select-String -Path test/participant-roster.test.js -Pattern "Position,Name,Phone,Score"` and change the simple-group expectation to the four-column head, keeping the finished block's eight-column expectation intact.
- [ ] **Step 2.5** Run `node --test test/roster-sections.test.js test/participant-roster.test.js` — expect all pass.
- [ ] **Step 2.6** Run `npm test`.

**Commit:** `feat(roster): filter CSV by section and fix simple-group columns`

---

## Task 3: The ZIP writer

**Files:** `src/services/zip.js`, `test/zip-read.js`, `test/zip.test.js`

A `.docx` is a ZIP of nine parts. `node:zlib` supplies `deflateRawSync`, `inflateRawSync` and `crc32`; verified present on the local Node `v24.18.0` and prototyped round-tripping through PowerShell `System.IO.Compression.ZipFile`.

- [ ] **Step 3.1** Create `test/zip-read.js` holding the independent reader, so Tasks 5 and 7 share it. Three hand-copied copies of a 30-line parser will drift; this is the one place in this plan where a shared test helper is right.

```js
'use strict';
// A deliberately independent ZIP reader: it walks the central directory itself
// instead of trusting the writer's bookkeeping, so the artefact is verified
// rather than the code that produced it.
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

function readZip(buf) {
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'missing local file header magic');
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd > 0, 'missing end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    assert.equal(buf.readUInt32LE(off), 0x02014b50, 'missing central directory header');
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    assert.equal(buf.readUInt32LE(lho), 0x04034b50, 'bad local header offset');
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? raw : zlib.inflateRawSync(raw);
    assert.equal(data.length, usize, `${name}: inflated size mismatch`);
    assert.equal(zlib.crc32(data) >>> 0, crc >>> 0, `${name}: CRC mismatch`);
    files.set(name, data);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

module.exports = { readZip };
```

- [ ] **Step 3.2** Write `test/zip.test.js` (failing), starting with `require('./helpers/isolate');`:

```js
'use strict';
require('./helpers/isolate');

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildZip } = require('../src/services/zip');
const { readZip } = require('./zip-read');

test('buildZip stores each entry and round-trips through an independent reader', () => {
  const xml = '<?xml version="1.0"?><w:p><w:r><w:t>Héllo — Ünicode</w:t></w:r></w:p>';
  const bin = Buffer.from([0, 1, 2, 253, 254, 255, 0, 128]);

  const out = buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(xml, 'utf8') },
    { name: 'word/media/watermark.png', data: bin },
  ]);
  const files = readZip(out);
  assert.deepEqual([...files.keys()], ['[Content_Types].xml', 'word/media/watermark.png']);
  assert.equal(files.get('[Content_Types].xml').toString('utf8'), xml);
  assert.deepEqual(files.get('word/media/watermark.png'), bin);
});

test('buildZip handles an empty payload and a large-ish entry', () => {
  const big = Buffer.alloc(300 * 1024, 0x41);
  const files = readZip(buildZip([
    { name: 'empty.txt', data: Buffer.alloc(0) },
    { name: 'big.txt', data: big },
  ]));
  assert.equal(files.get('empty.txt').length, 0);
  assert.deepEqual(files.get('big.txt'), big);
});
```

- [ ] **Step 3.3** Run it and watch it fail: `module '../src/services/zip' not found`.
- [ ] **Step 3.4** Create `src/services/zip.js`:

```js
// A .docx is a ZIP of XML parts. Node ships everything needed to build one:
// deflateRawSync for the compressed payload and crc32 for the checksum that
// Word validates on open. About forty lines replaces a ~1 MB dependency for
// what is ~300 lines of XML, and gives first-class control over a picture
// watermark that the `docx` package cannot express without hand-written VML
// anyway.
//
// Deliberately minimal: no zip64, no directory entries, no data descriptors,
// no encryption. Every part of a .docx is small, and a reader that chokes on
// the absence of those features is a reader we want to fail loudly on.
const zlib = require('node:zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const METHOD_DEFLATE = 8;

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5)
             | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  // MS-DOS epoch is 1980; anything earlier is not representable and does not
  // occur here, but the mask keeps the year in range.
  const day = (((Math.max(1980, date.getFullYear()) - 1980) & 0x7f) << 9)
            | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

/**
 * @param {{name: string, data: Buffer}[]} entries
 * @param {Date} [now] injectable for deterministic tests
 * @returns {Buffer}
 */
function buildZip(entries, now = new Date()) {
  const { time, day } = dosDateTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // Fall back to STORE when deflate does not actually help (tiny or
    // incompressible parts), so the artefact never grows for no reason.
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? METHOD_DEFLATE : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags: no UTF-8 bit, names are ASCII
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);            // extra length
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);          // extra
    central.writeUInt16LE(0, 32);          // comment
    central.writeUInt16LE(0, 34);          // disk number
    central.writeUInt16LE(0, 36);          // internal attrs
    central.writeUInt32LE(0, 38);          // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);               // comment length

  return Buffer.concat([...locals, centralBuf, eocd]);
}

module.exports = { buildZip };
```

- [ ] **Step 3.5** Run `node --test test/zip.test.js` — expect 2/2 pass.
- [ ] **Step 3.6** Verify the artefact opens in a real, independent reader. Write a throwaway `C:\Users\pax03\AppData\Local\Temp\opencode\zipcheck.js` that builds a two-entry ZIP, writes it to disk, and in the same run open it with PowerShell:

```powershell
node C:\Users\pax03\AppData\Local\Temp\opencode\zipcheck.js
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead("C:\Users\pax03\AppData\Local\Temp\opencode\out.zip")
$z.Entries | Select-Object FullName, Length
$z.Dispose()
```

Both entry names must appear. This is the check the design's earlier prototype already performed, repeated against the real writer.

**Commit:** `feat(roster): add dependency-free zip writer`

---

## Task 4: The watermark service

**Files:** `src/services/watermark.js`, `test/watermark.test.js`

One helper produces the finished watermark PNG, used by both the print page and the `.docx`, so the two cannot drift apart. This pipeline is already verified numerically on the real assets: `icon.svg` → 46,648 bytes in 574 ms, and the 2.3 MB `oktek-logo.png` → 40,470 bytes in 896 ms.

- [ ] **Step 4.1** Write `test/watermark.test.js` (failing). The harness details are not optional: `isolate` must be required FIRST, and it already redirects `DB_PATH`/`UPLOADS_DIR` into a temp dir, mkdirs it, exports that `root`, and **stubs `global.fetch` to throw**. Do not add your own temp dir or use `fetch`.

```js
'use strict';
require('./helpers/isolate');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { root } = require('./helpers/isolate');
const config = require('../src/config');      // isolate has already pointed uploadsDir at the temp dir
const DEFAULT_SVG = path.join(__dirname, '..', 'src', 'public', 'icon.svg');

let watermark;
test.before(() => { watermark = require('../src/services/watermark'); });

test.after(() => {
  // Leave no custom logo behind for the next test file in the same process.
  return watermark.remove();
});

test('watermarkPng returns a decodable 700x700 png', async () => {
  const png = await watermark.watermarkPng();
  assert.ok(Buffer.isBuffer(png));
  assert.ok(png.length > 1000, `suspiciously small: ${png.length}`);
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
  assert.deepEqual(await watermark.pngSize(png), { width: 700, height: 700 });
});

test('hasCustom is false until a logo is saved, and true after', async () => {
  await watermark.remove();
  assert.equal(watermark.hasCustom(), false);
  await watermark.save(fs.readFileSync(DEFAULT_SVG));
  assert.equal(watermark.hasCustom(), true);
  assert.equal(fs.existsSync(path.join(config.uploadsDir, 'watermark.png')), true);
  assert.equal(watermark.filePath(), path.join(config.uploadsDir, 'watermark.png'));
  await watermark.remove();
  assert.equal(watermark.hasCustom(), false);
  assert.equal(watermark.hasCustom(), false);   // removing twice is not an error
});

test('uploading a custom logo changes the bytes; removing reverts to the default', async () => {
  const before = await watermark.watermarkPng();
  await watermark.save(fs.readFileSync(DEFAULT_SVG));
  const custom = await watermark.watermarkPng();
  assert.notDeepEqual(custom, before, 'a custom logo must produce a different watermark');
  await watermark.remove();
  assert.deepEqual(await watermark.watermarkPng(), before, 'removing must revert to icon.svg');
});

test('save rejects bytes that are not an image', async () => {
  await assert.rejects(() => watermark.save(Buffer.from('not an image at all')), /image|decode|input/i);
  assert.equal(watermark.hasCustom(), false, 'a rejected upload must not leave a file behind');
});

test('invalidate forces a re-read of the file', async () => {
  const a = await watermark.watermarkPng();
  await watermark.save(fs.readFileSync(DEFAULT_SVG));
  assert.deepEqual(await watermark.watermarkPng(), a, 'still the cached promise');
  watermark.invalidate();
  assert.notDeepEqual(await watermark.watermarkPng(), a);
  await watermark.remove();
});
```

`pngSize` is a test-only helper exported from the service; it reads the IHDR width/height at bytes 16 and 20 so the test does not need to decode pixels.

- [ ] **Step 4.2** Run it and watch it fail: `module '../src/services/watermark' not found`.
- [ ] **Step 4.3** Create `src/services/watermark.js`:

```js
// The one watermark, used by the print page and the .docx alike.
//
// Storage: a single fixed filename. The file's EXISTENCE is the setting, so
// there is no column, no migration and no seed. uploadsDir is already on
// Render's persistent disk (render.yaml mounts it and sets UPLOADS_DIR), so
// the logo survives deploys.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const config = require('../config');

const FILE = 'watermark.png';
const SIZE = 700;

// Re-encoded to a 256-colour palette: a washed-out logo needs almost no
// colour depth, and a 700px mark lands at 40-47 KB instead of a few hundred,
// which is what makes it reasonable to inline as a data: URI in every
// printable page.
const PNG = { palette: true, quality: 90, effort: 10, compressionLevel: 9 };

// The default is vector, so it rasterises crisply at watermark scale.
// oktek-logo.png is deliberately not the default: 2.3 MB, and it is the
// certificate's partner mark, not the app's.
function defaultSource() {
  return path.join(__dirname, '..', 'public', 'icon.svg');
}

/**
 * Process any decodable image into the finished watermark.
 *
 *   decode -> trim -> square box -> flatten on white -> blur -> lift toward white
 *
 * trim() is not cosmetic: without it a 3:1 letterboxed upload keeps the letter
 * box, and the measured ink centre for icon.svg is (352, 328) instead of
 * (350, 350) - a visibly high watermark on every page.
 *
 * blur(2.5) is baked in because Word's watermark feature exposes no blur
 * control. The remaining fade is `linear(1, 96)`, applied in the pixels
 * because gain/blacklevel in the VML shape are honoured by Word and
 * LibreOffice but not by every consumer - a renderer that ignores the
 * washout must still show a pale, illegible-either-way mark.
 */
async function processWatermark(input) {
  return sharp(input, { density: 384 })
    .trim({ threshold: 10 })
    .resize({
      width: SIZE,
      height: SIZE,
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .flatten({ background: '#ffffff' })
    .blur(2.5)
    .linear(1, 96)
    .png(PNG)
    .toBuffer();
}

async function readSource() {
  try {
    return await fsp.readFile(filePath());
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return await fsp.readFile(defaultSource());
  }
}

function filePath() {
  return path.join(config.uploadsDir, FILE);
}

// A single cached promise, the pattern src/services/certificate.js:10 already
// uses. Failures are NOT cached: a transient decode error must not poison the
// process until restart.
let cached = null;

async function watermarkPng() {
  if (!cached) {
    cached = (async () => processWatermark(await readSource()))().catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

async function save(buffer) {
  // sharp decodes and re-encodes, so bytes that are not really a PNG cannot
  // survive the round trip. The stored filename is server-chosen, never the
  // client's, and SVG input is rasterised and never served, so no
  // user-supplied markup reaches a browser or Word.
  const out = await processWatermark(buffer);
  await fsp.mkdir(config.uploadsDir, { recursive: true });
  // Write-then-rename so a reader never sees a half-written PNG.
  const tmp = `${filePath()}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, out);
  await fsp.rename(tmp, filePath());
  invalidate();
  return out;
}

async function remove() {
  try {
    await fsp.unlink(filePath());
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  invalidate();
}

function hasCustom() {
  try {
    return fs.statSync(filePath()).size > 0;
  } catch {
    return false;
  }
}

function invalidate() {
  cached = null;
}

// Test-only: read the IHDR dimensions instead of decoding pixels.
async function pngSize(buffer) {
  const meta = await sharp(buffer).metadata();
  return { width: meta.width, height: meta.height };
}

module.exports = {
  SIZE, FILE, filePath, defaultSource, processWatermark,
  watermarkPng, save, remove, hasCustom, invalidate, pngSize,
};
```

- [ ] **Step 4.4** Run `node --test test/watermark.test.js` — expect 5/5 pass.
- [ ] **Step 4.5** Confirm no temp directory leaked: the `mkdtemp` dir is outside the repo, so nothing to clean in the working tree.

**Commit:** `feat(roster): add cached watermark image service`

---

## Task 5: The Word document

**Files:** `src/services/results.js`, `test/roster-docx.test.js`

Nine parts, assembled by the Task 3 writer. No Office renderer is installed on this machine, so DOCX correctness is proven structurally: an independent central-directory reader, XML well-formedness, and relationship resolution. Say so in the final report rather than claiming a visual check.

- [ ] **Step 5.1** Write `test/roster-docx.test.js` (failing), starting with `require('./helpers/isolate');` and `const { readZip } = require('./zip-read');` (Task 3, Step 3.1). Do not paste a second copy of the parser into this file:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { rosterDocx, ROSTER_SECTIONS } = require('../src/services/results');
const wm = require('../src/services/watermark');
const zlib = require('node:zlib');

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PART_NAMES = [
  '[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'word/document.xml',
  'word/_rels/document.xml.rels', 'word/styles.xml', 'word/header1.xml',
  'word/_rels/header1.xml.rels', 'word/media/watermark.png',
];

const WATERMARK = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // truncated fixture, part presence only

const roster = {
  exam: { id: 12, title: 'Maths & "Co"', duration_minutes: 30, pass_percentage: 50, status: 'live' },
  finished: [{ rank: 1, name: '<&">', phone: '+994 555 0001', final_score: 9,
               final_percentage: 90, passed: 1, attempt_no: 2, ended_at: '2026-09-29T10:00:00Z' }],
  inProgress: [{ name: 'Bob', phone: '+994 555 0002', questions_answered: 3, started_at: '2026-09-29T09:00:00Z' }],
  notStarted: [{ name: 'Cid', phone: '+994 555 0003', questions_answered: 0, started_at: null }],
  notSent: [{ name: 'Dee', phone: '+994 555 0004', questions_answered: 0, started_at: null }],
  summary: { total: 4, finished: 1, inProgress: 1, notStarted: 1, notSent: 1 },
};

async function docx(section) {
  return rosterDocx(roster, section, WATERMARK);
}

test('the docx is a zip containing all nine parts', async () => {
  const files = readZip(await docx('total'));
  assert.deepEqual([...files.keys()].sort(), [...PART_NAMES].sort());
});

test('document.xml is well-formed XML and escapes a hostile name', async () => {
  const doc = readZip(await docx('total')).get('word/document.xml').toString('utf8');
  assertXMLWellFormed(doc);
  assert.ok(!doc.includes('<&">'), 'the raw name must not appear unescaped');
  assert.ok(doc.includes('&lt;&amp;&quot;&gt;'), doc.slice(0, 400));
  assert.ok(!doc.includes('Maths & "Co"'), 'ampersand and quote must be escaped in attributes and text');
});

test('the page border is green on all four sides', async () => {
  const doc = readZip(await docx('total')).get('word/document.xml').toString('utf8');
  const m = doc.match(/<w:pgBorders[^>]*>([\s\S]*?)<\/w:pgBorders>/);
  assert.ok(m, 'pgBorders missing');
  for (const side of ['top', 'left', 'bottom', 'right']) {
    assert.ok(m[1].includes(`<w:${side} `), `${side} border missing`);
  }
  assert.equal((m[1].match(/25D366/g) || []).length, 4, 'all four sides use the WhatsApp green');
  assert.ok(m[0].includes('w:offsetFrom="page"'));
});

test('the header is the default one and titlePg is absent, so the mark repeats on every page', async () => {
  const doc = readZip(await docx('total')).get('word/document.xml').toString('utf8');
  assert.ok(/<w:headerReference[^>]*w:type="default"/.test(doc), 'header must be type="default"');
  assert.ok(!doc.includes('w:titlePg'), 'titlePg would move the header to page one only');
});

test('the VML watermark is centred, behind the text, and carries Word washout', async () => {
  const hdr = readZip(await docx('total')).get('word/header1.xml').toString('utf8');
  assert.ok(hdr.includes('type="#_x0000_t75"'), 'picture shape type missing');
  assert.ok(hdr.includes('mso-position-horizontal:center'));
  assert.ok(hdr.includes('mso-position-vertical:center'));
  assert.ok(/z-index:-\d+/.test(hdr), 'a positive z-index would cover the text');
  assert.ok(hdr.includes('gain="19661f"') && hdr.includes('blacklevel="22938f"'));
  assert.ok(hdr.includes('o:allowincell="f"'));
});

test('every r:id referenced resolves in the matching rels part', async () => {
  const files = readZip(await docx('total'));
  for (const [part, rels] of [
    ['word/document.xml', 'word/_rels/document.xml.rels'],
    ['word/header1.xml', 'word/_rels/header1.xml.rels'],
  ]) {
    const ids = new Set([...files.get(part).toString('utf8').matchAll(/r:id="([^"]+)"/g)].map(m => m[1]));
    for (const id of ids) {
      assert.ok(files.get(rels).toString('utf8').includes(`Id="${id}"`),
        `${part} references ${id}, absent from ${rels}`);
    }
    assert.ok(ids.size > 0, `${part} should reference at least one relationship`);
  }
  assert.ok(files.get('word/_rels/header1.xml.rels').toString('utf8')
    .includes('word/media/watermark.png'), 'header rels must point at the image');
});

test('the watermark png part is the exact buffer handed in', async () => {
  assert.deepEqual(readZip(await docx('total')).get('word/media/watermark.png'), WATERMARK);
});

test('section filtering and the section stamp are reflected in the body', async () => {
  const total = readZip(await docx('total')).get('word/document.xml').toString('utf8');
  for (const t of ['Finished', 'In Progress', 'Not Started', 'Not Sent']) {
    assert.ok(total.includes(t), `total should contain ${t}`);
  }
  const notSent = readZip(await docx('not_sent')).get('word/document.xml').toString('utf8');
  assert.ok(notSent.includes('Section: Not sent'));
  assert.ok(notSent.includes('Not Sent'));
  for (const t of ['In Progress', 'Not Started']) assert.ok(!notSent.includes(t), `${t} leaked`);
  assert.ok(!total.includes('Section:'), 'total stays unadorned');
});

test('an empty selected group renders an empty-state row, not a broken table', async () => {
  const doc = readZip(await docx('finished')).get('word/document.xml').toString('utf8');
  const empty = rosterDocx({ ...roster, finished: [] }, 'finished', WATERMARK);
  const body = readZip(empty).get('word/document.xml').toString('utf8');
  assertXMLWellFormed(body);
  assert.ok(body.includes('None'), body.slice(-600));
});

test('a huge roster does not blow the stack or produce invalid XML', async () => {
  const many = { ...roster, notSent: Array.from({ length: 3000 }, (_, i) => ({
    name: `Student ${i}`, phone: `+994 555 ${String(i).padStart(4, '0')}`,
    questions_answered: 0, started_at: null })) };
  const body = readZip(rosterDocx(many, 'not_sent', WATERMARK)).get('word/document.xml').toString('utf8');
  assertXMLWellFormed(body);
  assert.ok(body.includes('Student 2999'));
});
```

`assertXMLWellFormed` is a small local helper using `DOMParser` if available, else a regex sanity check on tag balance; define it at the top of the test file. Do not add a dependency for it.

- [ ] **Step 5.2** Run and watch it fail: `rosterDocx is not a function`.
- [ ] **Step 5.3** Implement in `src/services/results.js`. Add `const { buildZip } = require('./zip');` to the top requires. Add this escaper next to `esc`:

```js
// esc() handles text nodes; OOXML attributes and Word reject a raw quote or
// apostrophe, so the docx renderer needs its own escaper. Word refuses to
// open a file with one unescaped character, which makes this a correctness
// property rather than a cosmetic one.
function escXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
```

Then add `rosterDocx` after `rosterPrintHTML`. It is **synchronous** and takes the watermark as a `Buffer`, because the caller already has it cached and a sync function that `await`s nothing is easier to test:

```js
// A .docx is a ZIP of XML parts. Hand-rolled rather than pulled from npm:
// Node 24 ships deflateRawSync and crc32, so the container is ~40 lines, and
// a washed-out picture watermark needs hand-written VML regardless of which
// library assembles the file.
//
// Synchronous on purpose. The watermark Buffer is produced and cached by
// src/services/watermark.js; awaiting inside this function would only add a
// promise the caller does not need.
function rosterDocx(roster, section, watermarkPngBuffer) {
  const GREEN = '25D366';
  const stamp = sectionStamp(section);
  const dash = '—';                     // em dash: "no value", matching the report

  const txt = (v) => (v === null || v === undefined || v === '' ? dash : escXml(v));
  const num = (v) => (v === null || v === undefined || v === '' ? dash : escXml(v));
  const outcome = (p) => (p === null || p === undefined ? dash : p ? 'Pass' : 'Fail');

  const W = (s) => `<w:p>${s}</w:p>`;
  const run = (s, extra = '') => `<w:r>${extra}<w:t xml:space="preserve">${s}</w:t></w:r>`;
  const para = (s, extra = '') => W(run(s, extra));
  const heading = (s) =>
    `<w:p><w:pPr><w:spacing w:before="200" w:after="80"/></w:pPr>` +
    `<w:r><w:rPr><w:b/><w:color w:val="1A1A1A"/><w:sz w:val="26"/></w:rPr>` +
    `<w:t xml:space="preserve">${escXml(s)}</w:t></w:r></w:p>`;
  const cell = (s, width, header) =>
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>` +
    (header ? `<w:shd w:val="clear" w:fill="${GREEN}"/>` : '') +
    `</w:tcPr>${W(run(s, header ? '<w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr>' : ''))}</w:tc>`;
  const table = (head, rows, widths) =>
    '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>' +
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
      .join('') +
    '</w:tblBorders></w:tblPr>' +
    '<w:tr><w:trPr><w:tblHeader/></w:trPr>' +
    head.map((h, i) => cell(escXml(h), widths[i], true)).join('') +
    '</w:tr>' +
    rows.map(r => '<w:tr><w:trPr><w:cantSplit/></w:trPr>' +
      r.map((v, i) => cell(escXml(v), widths[i], false)).join('') + '</w:tr>').join('') +
    '</w:tbl>';

  const FIN_W = [520, 2100, 1900, 900, 1100, 1000, 800, 1360];
  const SIMPLE_W = [3000, 2100, 2100, 2480];
  const finishedCols = () => [
    ['#', num], ['Name', (v) => txt(v)], ['Phone', (v) => txt(v)],
    ['Score', num], ['Percentage', (v) => (v === null || v === undefined ? dash : `${escXml(v)}%`)],
    ['Result', (v) => txt(v)], ['Attempt', (v) => txt(v)], ['Finished', (v) => txt(v)],
  ];
  const simpleCols = () => [
    ['Name', (v) => txt(v)], ['Phone', (v) => txt(v)],
    ['Questions answered', num], ['Started', (v) => txt(v)],
  ];

  const renderBlock = (title, head, rows, widths, cells) => {
    const headRow = table(head, [], widths);
    if (!rows.length) return heading(title) + table([' '], [[dash]], widths);
    const bodyRows = rows.map(r => cells.map(c => c(r)));
    return heading(title) + table(head, bodyRows, widths);
  };

  const finishedCells = (r) => [num(r.rank), txt(r.name), txt(r.phone), num(r.final_score),
    r.final_percentage === null || r.final_percentage === undefined ? dash : `${escXml(r.final_percentage)}%`,
    outcome(r.passed), txt(r.attempt_no), txt(r.ended_at)];
  const simpleCells = (r) => [txt(r.name), txt(r.phone), num(r.questions_answered), txt(r.started_at)];

  const blocks = rosterBlocks(roster, section).map(([title, head, withRank, rows]) =>
    withRank
      ? renderBlock(title, ROSTER_FINISHED_COLS, rows, FIN_W, finishedCells)
      : renderBlock(title, ROSTER_SIMPLE_COLS, rows, SIMPLE_W, simpleCells));
```

`ROSTER_FINISHED_COLS` and `ROSTER_SIMPLE_COLS` come from Task 2 — but the DOCX needs its own display labels (`#`, `Score`, `Percentage`, `Result`, `Attempt`, `Finished`) rather than the CSV labels (`Position`, `Score`, `Percentage`, `Result`, `Attempt`, `Finished At`). Add a small mapping rather than mutating the shared arrays:

```js
const DOCX_FINISHED_HEAD = ['#', 'Name', 'Phone', 'Score', 'Percentage', 'Result', 'Attempt', 'Finished'];
const DOCX_SIMPLE_HEAD = ['Name', 'Phone', 'Questions answered', 'Started'];
```

Continue `rosterDocx` with the counts table, the page setup, and the parts:

```js
  const chipRow = table(
    ['Total', 'Finished', 'In progress', 'Not started', 'Not sent'],
    [[String(roster.summary.total), String(roster.summary.finished),
      String(roster.summary.inProgress), String(roster.summary.notStarted),
      String(roster.summary.notSent)]],
    [1956, 1956, 1956, 1956, 1956]);

  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
    ' xmlns:v="urn:schemas-microsoft-com:vml"' +
    ' xmlns:o="urn:schemas-microsoft-com:office:office"' +
    ' xmlns:w10="urn:schemas-microsoft-com:office:word">' +
    '<w:body>' +
    para(escXml(roster.exam.title), '<w:rPr><w:b/><w:sz w:val="38"/></w:rPr>') +
    para(`Duration ${escXml(roster.exam.duration_minutes)} min · Pass mark ${escXml(roster.exam.pass_percentage)}% · Status ${escXml(roster.exam.status || 'unknown')}`,
         '<w:rPr><w:color w:val="555555"/><w:sz w:val="22"/></w:rPr>') +
    (stamp ? para(`Section: ${escXml(stamp)}`, '<w:rPr><w:b/><w:color w:val="25D366"/><w:sz w:val="22"/></w:rPr>') : '') +
    chipRow + para('') + blocks.join('') +
    para(`Printed ${escXml(new Date().toLocaleString())}`,
         '<w:rPr><w:color w:val="666666"/><w:sz w:val="20"/></w:rPr>') +
    // A4 portrait 11906x16838 twips, margins matched to the print page.
    '<w:sectPr>' +
    '<w:headerReference w:type="default" r:id="rId4"/>' +
    '<w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="907" w:right="794" w:bottom="907" w:left="794" w:header="0" w:footer="0" w:gutter="0"/>' +
    `<w:pgBorders w:offsetFrom="page">` +
    ['top', 'left', 'bottom', 'right']
      .map(s => `<w:${s} w:val="single" w:sz="18" w:space="24" w:color="${GREEN}"/>`)
      .join('') +
    '</w:pgBorders>' +
    '</w:sectPr>' +
    '</w:body></w:document>';
```

The watermark goes in the header, in the exact VML shape Word itself writes for a picture watermark. `gain`/`blacklevel` are Word's native washout; the blur is baked into the PNG by Task 4 because the watermark feature exposes no blur control:

```js
  // 360pt square, expressed in EMU (1 pt = 12,700 EMU) and appended to the
  // shape's CSS as points, which is the unit Word reads for a watermark size.
  const wmSizePt = 360;
  const wmStyleSize = `${wmSizePt}pt`;

  const headerXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
    ' xmlns:v="urn:schemas-microsoft-com:vml"' +
    ' xmlns:o="urn:schemas-microsoft-com:office:office"' +
    ' xmlns:w10="urn:schemas-microsoft-com:office:word">' +
    '<w:p><w:r><w:pict>' +
    '<v:shapetype id="_x0000_t75" coordsize="21600,21600" o:spt="75" o:preferrelative="t"' +
    ' path="m@4@5l@4@11@9@11@9@5xe" filled="f" stroked="f">' +
    '<v:stroke joinstyle="miter"/>' +
    '<v:formulas>' +
    '<v:f eqn="if lineDrawn pixelLineWidth 0"/><v:f eqn="sum @0 1 0"/>' +
    '<v:f eqn="sum 0 0 @1"/><v:f eqn="prod @2 1 2"/><v:f eqn="prod @3 21600 pixelWidth"/>' +
    '<v:f eqn="prod @3 21600 pixelHeight"/><v:f eqn="sum @0 0 1"/><v:f eqn="prod @6 1 2"/>' +
    '<v:f eqn="prod @7 21600 pixelWidth"/><v:f eqn="sum @8 21600 0"/>' +
    '<v:f eqn="prod @7 21600 pixelHeight"/><v:f eqn="sum @10 21600 0"/>' +
    '</v:formulas>' +
    '<v:path o:extrusionok="f" gradientshapeok="t" o:connecttype="rect"/>' +
    '<o:lock v:ext="edit" aspectratio="t"/>' +
    '</v:shapetype>' +
    '<v:shape type="#_x0000_t75"' +
    ` style="position:absolute;margin-left:0;margin-top:0;width:${wmStyleSize};height:${wmStyleSize};` +
    'z-index:-251657216;' +
    'mso-position-horizontal:center;mso-position-horizontal-relative:margin;' +
    'mso-position-vertical:center;mso-position-vertical-relative:margin"' +
    ' o:allowincell="f">' +
    '<v:imagedata r:id="rId1" o:title="watermark" gain="19661f" blacklevel="22938f"/>' +
    '</v:shape>' +
    '</w:pict></w:r></w:p>' +
    '</w:hdr>';
```

Use only `wmSizePt` and `wmStyleSize` for the watermark shape — the VML `style` attribute sizes itself in points, so no EMU conversion is needed anywhere in this function. Do not introduce an unused constant.

The remaining parts:

```js
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '</Relationships>';

  const documentRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' +
    '</Relationships>';

  const headerRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/watermark.png"/>' +
    '</Relationships>';

  const stylesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>' +
    '<w:sz w:val="20"/><w:szCs w:val="20"/>' +
    '</w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
    '<w:name w:val="Normal"/><w:qFormat/>' +
    '</w:style>' +
    '</w:styles>';

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const coreXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"' +
    ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escXml(roster.exam.title)} - participants</dc:title>` +
    `<dc:creator>Exam Admin</dc:creator><cp:lastModifiedBy>Exam Admin</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
    '</cp:coreProperties>';

  const xml = (s) => Buffer.from(s, 'utf8');
  return buildZip([
    { name: '[Content_Types].xml',      data: xml(contentTypes) },
    { name: '_rels/.rels',              data: xml(rootRels) },
    { name: 'docProps/core.xml',        data: xml(coreXml) },
    { name: 'word/document.xml',        data: xml(documentXml) },
    { name: 'word/_rels/document.xml.rels', data: xml(documentRels) },
    { name: 'word/styles.xml',          data: xml(stylesXml) },
    { name: 'word/header1.xml',         data: xml(headerXml) },
    { name: 'word/_rels/header1.xml.rels', data: xml(headerRels) },
    { name: 'word/media/watermark.png', data: watermarkPngBuffer },
  ]);
}
```

Two correctness rules to respect while writing this, both about relationship ids:

- Every `r:id` used in `document.xml` and `header1.xml` must exist in the matching `.rels`. `header1.xml` uses `rId1` for the image, and `document.xml` uses `rId1` (styles), `rId2` (core props) and `rId4` (header) — the numbers need not be contiguous, only resolvable.
- `rId2` in `document.xml.rels` is not referenced from the body; that is fine and normal. A test asserts every *referenced* id resolves, not that every declared id is referenced.

- [ ] **Step 5.4** Add `rosterDocx` to `module.exports` at `src/services/results.js:748`.
- [ ] **Step 5.5** Run `node --test test/roster-docx.test.js` — expect 10/10 pass.
- [ ] **Step 5.6** Run `npm test`.
- [ ] **Step 5.7** Write a real `.docx` to disk and confirm an independent tool reads it. Add a throwaway script, not a committed test:

```powershell
node -e "process.env.UPLOADS_DIR='./data/uploads';const r=require('./src/services/results');const w=require('./src/services/watermark');w.watermarkPng().then(b=>{require('fs').writeFileSync('C:\Users\pax03\AppData\Local\Temp\opencode\roster.docx', r.rosterDocx({exam:{id:1,title:'T',duration_minutes:30,pass_percentage:50,status:'live'},finished:[],inProgress:[],notStarted:[],notSent:[],summary:{total:0,finished:0,inProgress:0,notStarted:0,notSent:0}}, 'total', b))})"
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::OpenRead("C:\Users\pax03\AppData\Local\Temp\opencode\roster.docx").Entries.FullName
```

All nine entries must appear. In the final report, state plainly that no Word or LibreOffice binary is available here, so the document was verified structurally and by an independent ZIP reader, not opened in Word.

**Commit:** `feat(roster): render branded word documents`

---

## Task 6: Branded print page

**Files:** `src/services/results.js`, `test/roster-print.test.js`

- [ ] **Step 6.1** Write `test/roster-print.test.js` (failing), starting with `require('./helpers/isolate');`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { rosterPrintHTML, buildParticipantRoster } = require('../src/services/results');

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DATA_URI = `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}`;

const roster = {
  exam: { id: 12, title: 'Maths', duration_minutes: 30, pass_percentage: 50, status: 'live' },
  finished: [{ rank: 1, name: 'Ann', phone: '1', final_score: 9, final_percentage: 90, passed: 1, attempt_no: 1, ended_at: 'T' }],
  inProgress: [{ name: 'Bob', phone: '2', questions_answered: 3, started_at: 'S1' }],
  notStarted: [{ name: 'Cid', phone: '3', questions_answered: 0, started_at: null }],
  notSent: [{ name: 'Dee', phone: '4', questions_answered: 0, started_at: null }],
  summary: { total: 4, finished: 1, inProgress: 1, notStarted: 1, notSent: 1 },
};

test('the print page embeds the watermark as a fixed, centred, self-contained data URI', () => {
  const html = rosterPrintHTML(roster, 'total', DATA_URI);
  assert.ok(html.includes(DATA_URI), 'watermark must be inlined, not linked');
  assert.ok(!/<img[^>]+src="(?!data:)/.test(html), 'nothing may be fetched at print time');
  assert.ok(/class="wm"/.test(html), 'watermark element missing');
  assert.ok(/position:\s*fixed/.test(html));
  assert.ok(/translate\(-50%,\s*-50%\)/.test(html));
  assert.ok(/pointer-events:\s*none/.test(html));
  assert.ok(/print-color-adjust:\s*exact/.test(html), 'green border must survive the print dialog');
});

test('the green page frame is present on every page', () => {
  const html = rosterPrintHTML(roster, 'total', DATA_URI);
  assert.ok(/class="frame"/.test(html));
  assert.ok(html.includes('#25D366'), 'frame must use the app green');
  assert.ok(/inset:\s*6mm/.test(html));
});

test('the document is still standalone: no app stylesheet, no scripts, no buttons', () => {
  const html = rosterPrintHTML(roster, 'total', DATA_URI);
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(!/<script/i.test(html));
  assert.ok(!/<button/i.test(html));
  assert.ok(!html.includes('styles.css'));
});

test('print honours the section and stamps it into the sub-line', () => {
  const html = rosterPrintHTML(roster, 'not_sent', DATA_URI);
  assert.ok(html.includes('>Not Sent'), 'the selected heading must render');
  assert.ok(html.includes('Section: Not sent'));
  // The five summary chips always render, so a leaked section is detected by
  // its HEADING casing, not by the label: '>In Progress' and '>Not Started'
  // are headings, while the chips read '>In progress' and '>Not started'.
  assert.ok(!html.includes('>In Progress'), 'another section leaked');
  assert.ok(!html.includes('>Not Started'), 'another section leaked');
  assert.ok(!html.includes('>Finished (ranked'), 'another section leaked');
  assert.ok(html.includes('Dee') && !html.includes('>Ann<'), 'no rows from another section');
  assert.ok(!rosterPrintHTML(roster, 'total', DATA_URI).includes('Section:'), 'total stays unadorned');
});

test('the print page still omits a score for a student who never finished', () => {
  const html = rosterPrintHTML(roster, 'not_sent', DATA_URI);
  assert.ok(!html.includes('>Fail<'), 'no verdict may be invented for an unattempted student');
  assert.ok(html.includes('&mdash;'), 'missing values render as an em dash');
});

test('omitting the watermark argument does not break the page', () => {
  const html = rosterPrintHTML(roster, 'total');
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(!html.includes('class="wm"'), 'no watermark element without a watermark');
});

test('all four groups and the five count chips render for total', () => {
  const html = rosterPrintHTML(roster, 'total', DATA_URI);
  for (const t of ['Finished', 'In Progress', 'Not Started', 'Not Sent']) {
    assert.ok(html.includes(`>${t}`), `missing heading ${t}`);
  }
  for (const c of ['Total', 'Finished', 'In progress', 'Not started', 'Not sent']) {
    assert.ok(html.includes(c), `missing chip ${c}`);
  }
});
```

- [ ] **Step 6.2** Run and watch it fail.
- [ ] **Step 6.3** Change the signature to `rosterPrintHTML(roster, section, watermarkDataUri)`.
- [ ] **Step 6.4** Update `PRINT_CSS`. The `@page` border is the spec'd route and **Chrome ignores it entirely**, so the frame is a `position: fixed` element instead; the watermark is fixed too, with content above it.

Add to the existing `PRINT_CSS` string:

```css
  @page { size: A4 portrait; margin: 16mm 14mm; }
  /* Chrome ignores `@page { border }` entirely, so the page frame is a fixed
     element. It repeats on every page in Chrome, Edge and Firefox. */
  .frame { position: fixed; inset: 6mm; border: 2.5pt solid #25D366;
           pointer-events: none; z-index: 0; }
  .wm { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
        width: 66%; pointer-events: none; z-index: 0; }
  body > *:not(.frame):not(.wm) { position: relative; z-index: 1; }
  /* Without this the green frame and header are dropped by the print dialog,
     the same trick reportHTML already uses at src/services/results.js:236. */
  body, .frame, th { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
```

Add this change **inside the `@media print` block's scope or as a top-level rule** — the screen preview must not show the frame floating over the page in the browser. Decide by rendering once in the browser: the simplest correct answer is to keep `.frame` and `.wm` hidden on screen and shown only in `@media print`, because the print page is a print artefact, not a preview:

```css
  .frame, .wm { display: none; }
  @media print {
    .frame, .wm { display: block; }
  }
```

Do **not** leave both rules active unconditionally; verify by opening the print URL in a browser and confirming the frame is invisible on screen and present in the print preview.

- [ ] **Step 6.5** In `rosterPrintHTML`, after `<body>`:

```js
${watermarkDataUri ? `<img class="wm" src="${esc(watermarkDataUri)}" alt="">` : ''}
<div class="frame"></div>
```

- [ ] **Step 6.6** Make the headings section-scoped and add the stamp. Replace the four hard-coded `<h2>` + rows block with:

```js
${rosterBlocks(roster, section).map(([title, head, withRank, rows]) => withRank
  ? `<h2>${esc(title)}</h2>\n${finishedRowsOf(rows)}`
  : `<h2>${esc(title)}</h2>\n${otherRowsOf(rows)}`
).join('\n')}
```

Keep the existing `finishedHead` / `otherHead` local constants — they are already correct at eight and four columns, matching the design. The `row` helpers become small local functions `finishedRowsOf(rows)` and `otherRowsOf(rows)` so they can take a row list.

- [ ] **Step 6.7** Add the stamp to the sub-line:

```js
<p class="sub">Duration ${esc(exam.duration_minutes)} min &middot; Pass mark ${esc(exam.pass_percentage)}% &middot; Status ${esc(exam.status || 'unknown')}${stamp ? ` &middot; <b>Section: ${esc(stamp)}</b>` : ''}</p>
```

- [ ] **Step 6.8** Run `node --test test/roster-print.test.js` — expect 7/7 pass.
- [ ] **Step 6.9** Open the print URL in a real browser and confirm: the frame and watermark are invisible on screen, both appear in the print preview, and the green prints. Report the result.

**Commit:** `feat(roster): brand the print page with watermark and green frame`

---

## Task 7: Routes

**Files:** `src/routes/api.js`, `test/roster-routes.test.js`

All five routes go after the admin guard at `src/routes/api.js:81`, wrapped in `asyncWrap` (`src/routes/api.js:144`).

- [ ] **Step 7.1** Write `test/roster-routes.test.js` (failing). Copy the harness from `test/recipient-route.test.js` **exactly**, because two things differ from a naive `fetch`-based test: `test/helpers/isolate.js` stubs `global.fetch` to throw, and `src/server.js:336` exports the express `app` (there is no `createApp()`), so the test mounts `src/routes/api` on its own express instance, exactly as `recipient-route.test.js` does.

```js
'use strict';
require('./helpers/isolate');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const db = require('../src/db');
const auth = require('../src/auth');
const api = require('../src/routes/api');
const { readZip } = require('./zip-read');   // see the note below

let server;
let base;
let token;
let examId;

function request(method, path_, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${path_}`,
      { method, headers: { authorization: `Bearer ${token}`, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { /* not json */ }
          resolve({ status: res.statusCode, headers: res.headers, buffer: buf, text, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function newExam() {
  return db
    .prepare("INSERT INTO exams (title, duration_minutes, status, pass_percentage) VALUES ('__roster_route__',30,'published',50)")
    .run().lastInsertRowid;
}

// multipart/form-data built by hand, so no new dependency appears for one test.
function multipart(fieldName, filename, contentType, content) {
  const boundary = '----rosterwatermarktest';
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`, 'utf8');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    body: Buffer.concat([head, content, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function postFile(contentType, body) {
  return request('POST', '/api/watermark-logo', {
    headers: { 'content-type': contentType, 'content-length': body.length }, body,
  });
}

before(async () => {
  token = auth.adminToken();
  const app = express();
  app.use(express.json());
  app.use('/api', api);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  examId = newExam();
});

after(() => { server?.close(); });
```

**On `readZip`:** it lives in `test/zip-read.js`, created in Task 3, Step 3.1, and is required by `test/zip.test.js`, `test/roster-docx.test.js` and `test/roster-routes.test.js`. One copy, because three hand-maintained copies of a ZIP parser will drift.

- [ ] **Step 7.2** Write the failing tests:

```js
const ICON_SVG = path.join(__dirname, '..', 'src', 'public', 'icon.svg');
const iconUpload = () => multipart('file', 'icon.svg', 'image/svg+xml', fs.readFileSync(ICON_SVG));

test('the section param is honoured and junk falls back to total', async () => {
  const junk = await request('GET', `/api/exams/${examId}/participants.csv?section=constructor`);
  const total = await request('GET', `/api/exams/${examId}/participants.csv`);
  assert.equal(junk.status, 200, junk.text);
  assert.equal(junk.text, total.text, 'an inherited-property key must fall back to total');
  assert.equal((await request('GET', `/api/exams/${examId}/participants.csv?section=not_sent`)).status, 200);
});

test('the csv is sent as an attachment with a section-aware filename', async () => {
  const filtered = await request('GET', `/api/exams/${examId}/participants.csv?section=not_sent`);
  assert.equal(filtered.status, 200, filtered.text);
  assert.ok(filtered.headers['content-type'].includes('text/csv'), filtered.headers['content-type']);
  const cd = filtered.headers['content-disposition'];
  assert.ok(cd.includes('attachment'), cd);
  assert.ok(cd.includes('Not-sent'), `filename must name the section: ${cd}`);
  const plain = await request('GET', `/api/exams/${examId}/participants.csv`);
  assert.ok(plain.headers['content-disposition'].includes(`participants-${examId}.csv`),
    plain.headers['content-disposition']);
});

test('the docx is a real zip attachment with all nine parts', async () => {
  const res = await request('GET', `/api/exams/${examId}/participants.docx?section=not_sent`);
  assert.equal(res.status, 200, res.text);
  assert.ok(res.headers['content-type'].includes('wordprocessingml.document'), res.headers['content-type']);
  assert.ok(res.headers['content-disposition'].includes('.docx'));
  assert.equal(res.buffer.readUInt32LE(0), 0x04034b50, 'zip local header magic');
  assert.equal(readZip(res.buffer).size, 9);
});

test('the print page renders server-side with the watermark inlined', async () => {
  const res = await request('GET', `/api/exams/${examId}/participants/print?section=not_sent`);
  assert.equal(res.status, 200);
  assert.ok(res.headers['content-type'].includes('text/html'));
  assert.ok(res.text.startsWith('<!DOCTYPE html>'));
  assert.ok(res.text.includes('data:image/png;base64,'), 'watermark must be inlined, not linked');
  assert.ok(res.text.includes('Section: Not sent'));
});

test('watermark status reports custom=false and a preview url', async () => {
  await request('DELETE', '/api/watermark-logo');
  const res = await request('GET', '/api/watermark-logo');
  assert.equal(res.status, 200);
  assert.equal(res.body.custom, false);
  assert.ok(res.body.url, 'the UI needs a url for the current mark either way');
});

test('the preview serves real png bytes at the watermark size', async () => {
  const res = await request('GET', '/api/watermark-logo.png');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.buffer.readUInt32LE(0), 0x89504e47, 'png magic');
  assert.equal(res.buffer.readUInt32LE(16), 700, 'png width from IHDR');
  assert.equal(res.buffer.readUInt32LE(20), 700, 'png height from IHDR');
});

test('uploading an svg logo flips custom to true and changes the served bytes', async () => {
  const before = (await request('GET', '/api/watermark-logo.png')).buffer;
  const up = await postFile(iconUpload().contentType, iconUpload().body);
  assert.equal(up.status, 200, up.text);
  assert.equal(up.body.custom, true);
  const after = (await request('GET', '/api/watermark-logo.png')).buffer;
  assert.notDeepEqual(after, before, 'a custom logo must change the served watermark');
  assert.equal(after.readUInt32LE(0), 0x89504e47, 'stored bytes must be a real png, never raw svg');
});

test('a non-image upload is rejected with 400 and leaves no file behind', async () => {
  const m = multipart('file', 'x.gif', 'image/gif', Buffer.from('GIF87a nope'));
  const up = await postFile(m.contentType, m.body);
  assert.equal(up.status, 400, `expected 400, got ${up.status}: ${up.text}`);
  assert.equal((await request('GET', '/api/watermark-logo')).body.custom, false);
});

test('bytes that lie about being a png are rejected, not stored', async () => {
  // Declares image/png but is not a PNG. The mimetype filter passes, so the
  // sharp decode is the only thing between this and a stored file.
  const m = multipart('file', 'fake.png', 'image/png', Buffer.from('definitely not a png'));
  const up = await postFile(m.contentType, m.body);
  assert.equal(up.status, 400, `expected 400, got ${up.status}: ${up.text}`);
  assert.equal((await request('GET', '/api/watermark-logo')).body.custom, false);
});

test('an upload with no file at all is a 400', async () => {
  const res = await request('POST', '/api/watermark-logo');
  assert.equal(res.status, 400, `expected 400, got ${res.status}`);
});

test('delete reverts to the default watermark, and twice is not a 500', async () => {
  const m = iconUpload();
  await postFile(m.contentType, m.body);
  const del = await request('DELETE', '/api/watermark-logo');
  assert.equal(del.status, 200);
  assert.equal(del.body.custom, false);
  const again = await request('DELETE', '/api/watermark-logo');
  assert.equal(again.status, 200, 'deleting twice must not 500');
});

test('all five routes require the admin token', async () => {
  for (const p of [`/api/exams/${examId}/participants.csv`,
                   `/api/exams/${examId}/participants/print`,
                   `/api/exams/${examId}/participants.docx`,
                   '/api/watermark-logo', '/api/watermark-logo.png']) {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(`${base}${p}`, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 401, `${p} must be protected`);
  }
});

test('a missing exam is a 404, not a 500', async () => {
  assert.equal((await request('GET', '/api/exams/999999/participants.csv')).status, 404);
  assert.equal((await request('GET', '/api/exams/999999/participants/print')).status, 404);
  assert.equal((await request('GET', '/api/exams/999999/participants.docx')).status, 404);
});
```
- [ ] **Step 7.3** Run and watch it fail with 404s / 500s.
- [ ] **Step 7.4** Add the export routes. Reuse `buildParticipantRoster` and `normalizeSection`; the only new logic is the filename and the watermark fetch:

```js
const watermarkService = require('../services/watermark');

function rosterFilename(examId, section, ext) {
  const slug = sectionSlug(section);
  return `participants-${examId}${slug === 'Total' ? '' : `-${slug}`}.${ext}`;
}

}

router.get('/exams/:id/participants/print', asyncWrap(async (req, res) => {
  const roster = buildParticipantRoster(req.params.id);
  if (!roster) return res.status(404).json({ error: 'Exam not found' });
  const section = normalizeSection(req.query.section);
  const png = await watermarkService.watermarkPng();
  res.type('html').send(rosterPrintHTML(roster, section, `data:image/png;base64,${png.toString('base64')}`));
}));

router.get('/exams/:id/participants.csv', asyncWrap(async (req, res) => {
  const roster = buildParticipantRoster(req.params.id);
  if (!roster) return res.status(404).json({ error: 'Exam not found' });
  const section = normalizeSection(req.query.section);
  res.set('Content-Disposition', `attachment; filename="${rosterFilename(req.params.id, section, 'csv')}"`);
  res.type('text/csv; charset=utf-8').send(rosterToCsv(roster, section));
}));

router.get('/exams/:id/participants.docx', asyncWrap(async (req, res) => {
  const roster = buildParticipantRoster(req.params.id);
  if (!roster) return res.status(404).json({ error: 'Exam not found' });
  const section = normalizeSection(req.query.section);
  const png = await watermarkService.watermarkPng();
  res.set('Content-Disposition', `attachment; filename="${rosterFilename(req.params.id, section, 'docx')}"`);
  res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
     .send(rosterDocx(roster, section, png));
}));
```


- [ ] **Step 7.5** Add a second multer instance for the watermark, next to `imageUpload` at `src/routes/api.js:58`. The existing one rejects SVG and JPEG is spelled `image/jpeg`; the design accepts SVG too, so this needs its own `fileFilter` and a clearer error than multer's default:

```js
// Accepts SVG as well as PNG/JPEG, because logos are frequently exported as
// SVG. SVG bytes are rasterised by sharp before being stored, so no
// user-supplied markup is ever served.
const watermarkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/png', 'image/jpeg', 'image/svg+xml'].includes(file.mimetype)) return cb(null, true);
    cb(new Error('Only PNG, JPG and SVG images are accepted'));
  },
});
```

- [ ] **Step 7.6** Add the three watermark routes plus the preview:

```js
router.get('/watermark-logo', asyncWrap(async (req, res) => {
  res.json({ custom: watermarkService.hasCustom(), url: '/api/watermark-logo.png' });
}));

router.get('/watermark-logo.png', asyncWrap(async (req, res) => {
  const png = await watermarkService.watermarkPng();
  res.set('Cache-Control', 'no-store');
  res.type('image/png').send(png);
}));

router.post('/watermark-logo', watermarkUpload.single('file'), asyncWrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image supplied' });
  try {
    await watermarkService.save(req.file.buffer);
    res.json({ custom: true, url: '/api/watermark-logo.png' });
  } catch (err) {
    // sharp's decode failure is the security boundary: bytes that are not
    // really an image cannot survive the round trip.
    res.status(400).json({ error: 'That file could not be read as an image' });
  }
}));

router.delete('/watermark-logo', asyncWrap(async (req, res) => {
  await watermarkService.remove();
  res.json({ custom: false, url: '/api/watermark-logo.png' });
}));
```

**Multer error handling:** `watermarkUpload.single('file')` rejects an oversized or wrongly-typed file with an `Error` that has no status. Add an error-handling check so it becomes a 400 rather than a 500. Either a route-local wrapper, or a small `upload.single` helper:

```js
const uploadSingle = (mw) => (req, res, next) =>
  mw(req, res, (err) => (err ? res.status(400).json({ error: err.message }) : next()));
```

Use `uploadSingle(watermarkUpload.single('file'))` in the POST route. Also confirm the existing `imageUpload` sites are not affected.

- [ ] **Step 7.7** Run `node --test test/roster-routes.test.js` — expect all pass.
- [ ] **Step 7.8** Run `npm test`.

**Commit:** `feat(roster): add section-scoped export and watermark routes`

---

## Task 8: Participants-tab UI

**Files:** `src/public/app.js`, `src/public/styles.css`, `test/roster-ui.test.js`

- [ ] **Step 8.1** Write `test/roster-ui.test.js` (failing). There is no DOM in the test runner, so assert on the served source as text — the file is served verbatim by `src/server.js`:

```js
require('./helpers/isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'styles.css'), 'utf8');

test('the section dropdown offers exactly the five export sections and reads Total', () => {
  const m = app.match(/<select[^>]*id="rosterSection"[\s\S]*?<\/select>/);
  assert.ok(m, 'rosterSection select missing');
  for (const v of ['total', 'finished', 'in_progress', 'not_started', 'not_sent']) {
    assert.ok(m[0].includes(`value="${v}"`), `missing option ${v}`);
  }
  assert.ok(/value="total" selected/.test(m[0]) || /value="total"\s+selected/.test(m[0]),
    'Total must be the default');
  assert.equal((m[0].match(/<option/g) || []).length, 5);
});

test('all three export actions read the section at click time', () => {
  for (const fn of ['printRoster', 'downloadRosterDocx', 'downloadRosterCsv']) {
    assert.ok(app.includes(`function ${fn}(`), `${fn} missing`);
  }
  assert.ok(app.includes('rosterSectionValue()'), 'one shared reader is required');
  const uses = (app.match(/rosterSectionValue\(\)/g) || []).length;
  assert.ok(uses >= 4, `expected 3 call sites plus the definition, saw ${uses}`);
});

test('the docx action exists and asks for the right content type', () => {
  assert.ok(/Download Word/.test(app), 'Download Word button missing');
  assert.ok(app.includes('participants.docx'), 'docx endpoint not called');
});

test('the watermark controls are present', () => {
  assert.ok(/Watermark logo/i.test(app));
  assert.ok(/type="file"/.test(app), 'file input missing');
  assert.ok(/Use default/i.test(app), 'reset control missing');
  assert.ok(/watermark-logo/.test(app), 'no watermark endpoint call');
});

test('the screen Not Sent table gains the two missing columns', () => {
  const m = app.match(/roster\.notSent,\s*\[([^\]]+)\]/);
  assert.ok(m, 'notSent rosterTable call not found');
  const cols = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
  assert.deepEqual(cols, ['Name', 'Phone', 'Questions answered', 'Started']);
});

test('the new controls inherit the existing button and field styling', () => {
  assert.ok(css.includes('btn-ghost'), 'ghost button class missing from css');
  assert.ok(/select[^{]*\{/.test(css), 'a global select rule must exist');
});
```

- [ ] **Step 8.2** Run and watch it fail.
- [ ] **Step 8.3** In `app.js`, extend the roster header at `src/public/app.js:795-800`. The section value is read at click time, so one selection applies to whichever button is pressed next:

```js
const ROSTER_SECTIONS = [
  ['total', 'Total'], ['finished', 'Finished'], ['in_progress', 'In progress'],
  ['not_started', 'Not started'], ['not_sent', 'Not sent'],
];

function rosterSectionValue() {
  const el = document.getElementById('rosterSection');
  return el ? el.value : 'total';
}
```

```html
<select id="rosterSection" title="Applies to print, Word and CSV exports">
  ${ROSTER_SECTIONS.map(([v, l]) => `<option value="${v}"${v === 'total' ? ' selected' : ''}>${l}</option>`).join('')}
</select>
<button class="btn btn-ghost" onclick="printRoster(${id})">${I.doc} Print / Save PDF</button>
<button class="btn btn-ghost" onclick="downloadRosterDocx(${id})">${I.doc} Download Word</button>
<button class="btn btn-ghost" onclick="downloadRosterCsv(${id})">${I.doc} Download CSV</button>
${watermarkControls()}
```

**Filter scope:** the dropdown filters the *export* only. The on-screen roster keeps showing all four tables, because that is where an administrator orients themselves. Do not filter `roster.finished` and friends.

- [ ] **Step 8.4** Add the docx downloader, mirroring `downloadRosterCsv` at `src/public/app.js:878`:

```js
async function downloadRosterDocx(id) {
  try {
    const section = rosterSectionValue();
    const res = await rosterFetch(`/api/exams/${id}/participants.docx?section=${encodeURIComponent(section)}`);
    if (!res.ok) throw new Error(await res.text());
    saveBlob(await res.blob(), filenameFrom(res, `participants-${id}.docx`));
  } catch (e) {
    alert(`Could not download the Word file: ${e.message}`);
  }
}
```

Reuse whatever the existing CSV/print code already uses for turning a `Response` into a file — do not introduce a second mechanism. Check `downloadRosterCsv` and `printRoster` first and match them.
- [ ] **Step 8.5** Add `?section=` to the two existing calls: `printRoster` (`src/public/app.js:905`) and `downloadRosterCsv` (`src/public/app.js:880`).
- [ ] **Step 8.6** Add the watermark controls. Small, self-contained, and they must not require a page reload to be usable:

```js
function watermarkControls() {
  return `
  <span class="wm-controls">
    <label class="btn btn-ghost" title="PNG, JPG or SVG up to 5 MB">
      ${I.doc} Watermark logo
      <input type="file" id="wmFile" accept="image/png,image/jpeg,image/svg+xml" hidden onchange="uploadWatermark(this)">
    </label>
    <img id="wmPreview" alt="" style="width:28px;height:28px;object-fit:contain;vertical-align:middle">
    <button class="btn btn-ghost" onclick="resetWatermark()">Use default</button>
  </span>`;
}

async function loadWatermark() {
  try {
    const { custom } = await api('/api/watermark-logo');
    const el = document.getElementById('wmPreview');
    if (el) el.src = `/api/watermark-logo.png?t=${Date.now()}${custom ? '&custom=1' : ''}`;
    const btn = document.getElementById('wmReset');
    if (btn) btn.disabled = !custom;
  } catch { /* the controls are optional chrome; a failure here must not block the roster */ }
}

async function uploadWatermark(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  try {
    const form = new FormData();
    form.append('file', file);
    await api('/api/watermark-logo', { method: 'POST', body: form });
    await loadWatermark();
  } catch (e) {
    alert(`Could not set the watermark: ${e.message}`);
  } finally {
    input.value = '';
  }
}

async function resetWatermark() {
  try {
    await api('/api/watermark-logo', { method: 'DELETE' });
    await loadWatermark();
  } catch (e) {
    alert(`Could not reset the watermark: ${e.message}`);
  }
}
```

The `t=${Date.now()}` cache-buster matters: the preview URL is constant, and without it a browser would keep showing the old mark after an upload or a reset. Call `loadWatermark()` from the same place the Participants tab is rendered.

- [ ] **Step 8.7** Fix the screen Not Sent table at `src/public/app.js:841`, which currently renders only two columns. Change the `rosterTable` column array to `['Name', 'Phone', 'Questions answered', 'Started']` and the row renderer to fill the two new cells, using the same dash or muted placeholder the other tables use for a missing value.
- [ ] **Step 8.8** Add the minimal CSS to `src/public/styles.css`, next to the existing `select`/`input` rules and using the existing `--green`:

```css
.wm-controls { display: inline-flex; align-items: center; gap: 6px; }
#wmPreview { border: 1px solid #ddd; border-radius: 4px; background: #fff; }
```

- [ ] **Step 8.9** Run `node --test test/roster-ui.test.js` — expect all pass.
- [ ] **Step 8.10** **Verify in a real browser.** Start the app, open an exam's Participants tab, and confirm: the dropdown defaults to Total; each of the five values produces an export containing only that section; Download Word opens a file; the Not Sent table shows four columns; a watermark upload updates the thumbnail; "Use default" reverts it; the print preview shows both the green frame and the watermark. Record what you actually observed.

**Commit:** `feat(roster): section-scoped export and watermark controls in the ui`

---

## Task 9: Full regression and final report

**Files:** none

- [ ] **Step 9.1** Run the whole suite: `npm test`. Every test must pass. Investigate any failure before moving on; do not weaken a test to make it green.
- [ ] **Step 9.2** Run the linter and typecheck if the repo has them. Check `package.json` scripts first:

```powershell
Get-Content package.json | Select-String -Pattern '"scripts"' -Context 0,10
```

If `lint` and `typecheck` exist, run both. If they do not, say so in the report rather than claiming they passed.
- [ ] **Step 9.3** Confirm no stray artefacts: `git status --short` should show only the intended files. Check that no temp or scratch file landed in the repo, and that `data/uploads/watermark.png` is **not** committed — add it to `.gitignore` if it is not already ignored.
- [ ] **Step 9.4** Review the diff for the two known deviations and confirm both are visible in the report to the user: the CSV simple-group columns changed from eight to four, and the tests live in focused new files.
- [ ] **Step 9.5** Commit: `feat(roster): section export, word download and watermark branding`
- [ ] **Step 9.6** Write the final report. It must state plainly:
  - what was built, and which of the three exports were verified in a real browser
  - that the `.docx` was verified **structurally** — independent ZIP reader, XML well-formedness, relationship resolution, and a third-party ZIP tool — because no Word or LibreOffice binary is available on this machine, so nobody mistakes that for a visual check
  - the CSV column change as a deliberate behaviour change, in case anyone depended on the old eight-column output
  - the Vercel ephemeral-storage caveat: `vercel.json` sets no `UPLOADS_DIR`, so on Vercel an uploaded watermark is lost on redeploy, exactly like the existing student photos and voice notes
  - that `@page { border }` is ignored by Chrome, so the print frame is a `position: fixed` element; a print pipeline that discards fixed elements would show the watermark with no frame

---

## Appendix: what was verified before this plan was written

These are facts, not assumptions. Re-verify only if something has changed.

| claim | how it was checked | result |
|---|---|---|
| `zlib.deflateRawSync`, `zlib.inflateRawSync`, `zlib.crc32` exist | Node `v24.18.0` | all present; `crc32('hello') = 907060870` |
| a hand-built ZIP opens in a real reader | `zipproto.js` + PowerShell `System.IO.Compression.ZipFile` | entries and UTF-8 content round-tripped |
| the 700px palette pipeline produces a usable watermark | run over `icon.svg` and `oktek-logo.png` | 46,648 B / 574 ms and 40,470 B / 896 ms |
| `trim` is required | ink bbox with and without | centred `(350,350)` with, `(352,328)` without |
| `sharp` handles arbitrary aspect ratios and formats | 3:1, 1:1 and SVG inputs | all decode and process |
| `Content-Disposition` is readable by the browser | `src/server.js:32` | already exposed |

## Appendix: known limitations to keep

- **VML is legacy.** Word and LibreOffice render it; Google Docs' importer may drop the watermark while keeping the border and text. Inherent to the Word-native approach.
- **`position: fixed` is the only working print page border.** Chrome ignores `@page { border }` entirely.
- **No Office renderer here.** The `.docx` is verified structurally, never opened in Word on this machine.
- **Vercel is ephemeral.** Same exposure as the existing uploads.

