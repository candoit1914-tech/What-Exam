require('./helpers/isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROSTER_SECTIONS, normalizeSection, sectionGroups, sectionStamp, sectionSlug, rosterColumns, rosterBlocks } = require('../src/services/results');

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

// ── Column definitions and render blocks ───────────────────────────────
// The Word document and the print page must name the same columns, so the
// names are declared once here rather than written out per renderer.
const stubExam = { exam: { id: 12, title: 'Maths', duration_minutes: 30, pass_percentage: 50, status: 'live' } };
function stub(over = {}) {
  return {
    ...stubExam,
    finished: [], inProgress: [], notStarted: [], notSent: [],
    summary: { total: 0, finished: 0, inProgress: 0, notStarted: 0, notSent: 0 },
    ...over,
  };
}

test('rosterColumns gives the finished group eight columns and every simple group four', () => {
  assert.deepEqual(rosterColumns('finished'),
    ['Position', 'Name', 'Phone', 'Score', 'Percentage', 'Result', 'Attempt', 'Finished At']);
  for (const group of ['inProgress', 'notStarted', 'notSent']) {
    assert.deepEqual(rosterColumns(group), ['Name', 'Phone', 'Questions answered', 'Started']);
  }
});

test('rosterBlocks returns only the groups the section names, in roster order', () => {
  const r = stub({
    finished:   [{ rank: 1, name: 'Ann' }],
    inProgress: [{ name: 'Bob' }],
    notStarted: [{ name: 'Cid' }],
    notSent:    [{ name: 'Dee' }],
  });
  assert.deepEqual(rosterBlocks(r, 'total').map((b) => b.key),
    ['finished', 'inProgress', 'notStarted', 'notSent']);
  assert.deepEqual(rosterBlocks(r, 'not_sent').map((b) => b.key), ['notSent']);
  assert.deepEqual(rosterBlocks(r, 'finished').map((b) => b.key), ['finished']);
  // Junk resolves to total, exactly as normalizeSection does.
  assert.deepEqual(rosterBlocks(r, 'bogus').map((b) => b.key),
    ['finished', 'inProgress', 'notStarted', 'notSent']);
  // Each block carries its own title, column names, rank flag and rows.
  const [first] = rosterBlocks(r, 'finished');
  assert.equal(first.title, 'Finished (ranked by percentage)');
  assert.equal(first.ranked, true);
  assert.deepEqual(first.rows, r.finished);
  assert.deepEqual(rosterBlocks(r, 'not_sent')[0].columns,
    ['Name', 'Phone', 'Questions answered', 'Started']);
});
