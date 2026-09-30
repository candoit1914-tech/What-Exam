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

test('the green page frame sits near the sheet edge as a double rule', () => {
  const html = rosterPrintHTML(roster, 'total', DATA_URI);
  assert.ok(/class="frame"/.test(html));
  assert.ok(html.includes('#25D366'), 'frame must use the app green');
  // Inside the @page margin (14mm/12mm) so it never touches the table, but not
  // at 0: a zero-inset border is clipped by every printer's non-printable edge.
  const inset = Number(/inset:\s*([\d.]+)mm/.exec(html)[1]);
  assert.ok(inset > 0 && inset < 12, `frame inset ${inset}mm must sit inside the page margin`);
  // The double rule: a real border plus an inset hairline offset.
  assert.ok(/border:\s*[\d.]+pt solid #25D366/.test(html), 'outer rule missing');
  assert.ok(/box-shadow:\s*inset 0 0 0/.test(html), 'inner hairline rule missing');
  assert.ok(/border-radius/.test(html), 'corners should be softened, not sharp');
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
  assert.ok(html.includes('Section: Not sent'), 'the sub-line must name the section');
  // The group headings are gone, so a leaked section can no longer be detected
  // by heading text. Row content is the only honest signal left, so it is what
  // this asserts on: Dee's group renders, Ann's and Bob's do not.
  assert.ok(html.includes('Dee'), "the selected group's row must render");
  assert.ok(!html.includes('>Ann<'), 'no rows from another section');
  assert.ok(!html.includes('>Bob<'), 'no rows from another section');
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

test('the four group headings are gone but every group and chip still renders for total', () => {
  const html = rosterPrintHTML(roster, 'total', DATA_URI);
  assert.ok(!/<h2/.test(html), 'no group heading elements may survive');
  for (const t of ['In Progress', 'Not Started', 'Not Sent', 'Finished (ranked']) {
    assert.ok(!html.includes(t), `group heading "${t}" must not be printed`);
  }
  for (const c of ['Total', 'Finished', 'In progress', 'Not started', 'Not sent']) {
    assert.ok(html.includes(c), `missing chip ${c}`);
  }
  for (const n of ['Ann', 'Bob', 'Cid', 'Dee']) {
    assert.ok(html.includes(`>${n}<`), `missing row for ${n}`);
  }
});

test('selecting one group prints only that group, and row order is the roster order', () => {
  // Ranking is done once in buildParticipantRoster (see participant-roster.test.js),
  // so the renderer's job is to preserve that order rather than to re-sort it.
  // Re-sorting here is what would break the '100% above 9%' numeric comparison.
  const ranked = {
    ...roster,
    finished: [
      { rank: 1, name: 'Ann', phone: '1', final_score: 10, final_percentage: 100, passed: 1, attempt_no: 1, ended_at: 'T' },
      { rank: 2, name: 'Bob', phone: '2', final_score: 7, final_percentage: 75, passed: 1, attempt_no: 1, ended_at: 'T' },
      { rank: 3, name: 'Cid', phone: '3', final_score: 5, final_percentage: 50, passed: 1, attempt_no: 1, ended_at: 'T' },
    ],
  };
  const html = rosterPrintHTML(ranked, 'finished', DATA_URI);
  const order = ['>Ann<', '>Bob<', '>Cid<'].map((t) => html.indexOf(t));
  assert.ok(order.every((v) => v >= 0), 'every finished row must render');
  assert.ok(order[0] < order[1] && order[1] < order[2],
    `rows must render in roster order - got indexes ${order.join(',')}`);
  // Only the finished group reaches the page.
  assert.ok(!html.includes('>Dee<'), 'finished leaked a not-sent row');

  // Each of the other section values isolates its own group and nobody else's.
  const page = (section) => rosterPrintHTML(roster, section, DATA_URI);
  assert.ok(page('in_progress').includes('>Bob<'), 'in_progress row missing');
  assert.ok(!page('in_progress').includes('>Ann<'), 'in_progress leaked a finished row');
  assert.ok(page('not_started').includes('>Cid<'), 'not_started row missing');
  assert.ok(!page('not_started').includes('>Bob<'), 'not_started leaked an in-progress row');
  assert.ok(page('not_sent').includes('>Dee<'), 'not_sent row missing');
  assert.ok(!page('not_sent').includes('>Cid<'), 'not_sent leaked a not-started row');
});
