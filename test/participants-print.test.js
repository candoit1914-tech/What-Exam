'use strict';
require('./helpers/isolate');

const test = require('node:test');
const assert = require('node:assert/strict');
const { rosterPrintHTML } = require('../src/services/results');

// A stand-in for the real inlined mark: the renderer's job is to embed the
// bytes it is handed as a self-contained data URI, so the payload only has to
// LOOK like one - sharp never runs in this file.
const DATA_URI = `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}`;

// One fixture for every test below: the renderers are pure, so the cases differ
// only in the section they ask for, and a shared roster keeps a leak between
// sections visible as a name that should not be on the page at all.
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
