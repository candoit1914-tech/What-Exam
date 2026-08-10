'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');

test('answers table has the answer_image column', () => {
  const cols = db.prepare("PRAGMA table_info('answers')").all().map((c) => c.name);
  assert.ok(cols.includes('answer_image'), `expected answer_image in columns: ${cols.join(', ')}`);
});
