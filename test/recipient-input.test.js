'use strict';
// Pure parser tests. No DB, no DOM — recipient-input.js must be requireable
// on its own, which is the whole reason it does not live inside app.js
// (app.js reads window/document/localStorage at load and would need stubbing).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const input = require('../src/public/recipient-input');

test('splits "Name Phone" into name and phone', () => {
  assert.deepEqual(input.parseRecipientInput('Ama Serwaa 0242004542'), [
    { phone: '0242004542', name: 'Ama Serwaa' },
  ]);
});

test('REGRESSION: a spaced international number stays one entry', () => {
  // The textarea placeholder advertises '+1 555 123 4567'. A whitespace split
  // would emit four tokens, and because the client posts `students` rather
  // than `phones` the server's rejoinPhoneRuns never repairs it. Count matters
  // as much as the field: the bug is 1 entry becoming 4.
  const out = input.parseRecipientInput('+233 24 200 4542');
  assert.equal(out.length, 1);
  assert.deepEqual(out, [{ phone: '+233242004542', name: '' }]);
});

test('rejoins a 00233-prefixed spaced number', () => {
  const out = input.parseRecipientInput('00233 24 200 4542');
  assert.equal(out.length, 1);
  assert.deepEqual(out, [{ phone: '00233242004542', name: '' }]);
});

test('splits on comma and semicolon', () => {
  const out = input.parseRecipientInput('0242004542, 233242004542;0244004542');
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((r) => r.phone), ['0242004542', '233242004542', '0244004542']);
});

test('splits on pipe and tab', () => {
  // Assert the fields, not just the count: a parser that returned three
  // entries with the wrong contents would satisfy a length check alone.
  assert.deepEqual(input.parseRecipientInput('a|b\tc'), [
    { phone: 'a', name: '' },
    { phone: 'b', name: '' },
    { phone: 'c', name: '' },
  ]);
});

test('consumes a leading paren instead of orphaning it into the name', () => {
  // "(233) 24 200 4542" normalises to a VALID number, so a paren left in the
  // name would be persisted silently as a student called "Ama Serwaa (".
  assert.deepEqual(input.parseRecipientInput('(233) 24 200 4542'), [
    { phone: '233242004542', name: '' },
  ]);
  assert.deepEqual(input.parseRecipientInput('Ama Serwaa (233) 24 200 4542'), [
    { phone: '233242004542', name: 'Ama Serwaa' },
  ]);
});

test('keeps a paren that belongs to the name, not the number', () => {
  // The mirror image of the case above: a parenthesised NAME must survive
  // intact, or "(Kofi)" would be truncated to "(Kofi" or stripped to "Kofi)".
  assert.deepEqual(input.parseRecipientInput('(Kofi) 0242004542'), [
    { phone: '0242004542', name: '(Kofi)' },
  ]);
});

test('keeps internal spaces in a multi-word name', () => {
  assert.deepEqual(input.parseRecipientInput('Boamah Bryan Ntim 0242004542'), [
    { phone: '0242004542', name: 'Boamah Bryan Ntim' },
  ]);
});

test('a name with no number is passed through so the server can reject it', () => {
  // Silently dropping it would hide the reason from the admin.
  assert.deepEqual(input.parseRecipientInput('Ama Serwaa'), [
    { phone: 'Ama Serwaa', name: '' },
  ]);
});

test('empty and nullish input yield no entries', () => {
  assert.deepEqual(input.parseRecipientInput(''), []);
  assert.deepEqual(input.parseRecipientInput(null), []);
  assert.deepEqual(input.parseRecipientInput(undefined), []);
  assert.deepEqual(input.parseRecipientInput('\n\n  \n'), []);
});

test('parseRecipientLine is stable when fed its own output', () => {
  for (const raw of ['Ama Serwaa 0242004542', '+233 24 200 4542', 'abc']) {
    const first = input.parseRecipientLine(raw);
    assert.equal(input.parseRecipientLine(first.phone).phone, first.phone);
  }
});
