require('./helpers/isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROSTER_SECTIONS, normalizeSection, sectionGroups, sectionStamp, sectionSlug } = require('../src/services/results');

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
