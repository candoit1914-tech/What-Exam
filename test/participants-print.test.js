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

test('the green page frame runs edge to edge with every value inside it', () => {
  const html = rosterPrintHTML(roster, 'total', DATA_URI);
  assert.ok(/class="frame"/.test(html));
  assert.ok(html.includes('#25D366'), 'frame must use the app green');

  // A `position: fixed` box is resolved against the PAGE AREA, not the sheet, so
  // the old `inset: 8mm` against a 14mm/12mm @page margin put the rule 8mm INSIDE
  // the text block: a wide table ran out past the border instead of inside it.
  // The margin therefore has to leave the page entirely - `@page` margin 0 makes
  // the page area the sheet, so `inset: 0` really is the sheet edge.
  const pageMargin = /@page\s*\{[^}]*margin:\s*0/.test(html);
  assert.ok(pageMargin, '@page margin must be 0 or the frame cannot reach the sheet edge');

  const inset = /\.frame\s*\{[^}]*inset:\s*([\d.]+)m?/.exec(html);
  assert.ok(inset, 'frame inset must be declared');
  assert.equal(Number(inset[1]), 0, 'frame must sit on the sheet edge (inset 0)');

  // Edge-to-edge is only half the requirement: the values still have to be INSIDE
  // the rule, so the old @page margin becomes body padding instead of vanishing.
  const pad = /body\s*\{[^}]*padding:\s*([\d.]+)mm\s+([\d.]+)mm/.exec(html);
  assert.ok(pad, 'body must carry the printable inset as padding');
  assert.ok(Number(pad[1]) > 0 && Number(pad[2]) > 0,
    `body padding ${pad[1]}mm/${pad[2]}mm must be non-zero or content sits on the border`);

  assert.ok(/border:\s*[\d.]+pt solid #25D366/.test(html), 'outer rule missing');
  // Square corners now that the rule is the sheet edge: a radius would round the
  // paper itself off.
  assert.ok(!/\.frame\s*\{[^}]*border-radius/.test(html),
    'an edge-to-edge frame must not round the paper');
});

test('Name gets the widest column and Questions Answered the narrowest', () => {
  // Column widths are set with an explicit <colgroup>: with only `width: 100%`
  // the browser hands the column to whichever cell has the longest text, so a
  // long name and a short "3" both lost to the wide "Questions answered"
  // header, and the register read wrong.
  const html = rosterPrintHTML(roster, 'total', DATA_URI);
  // 'total' renders the finished table FIRST, so the four-column group is found
  // by shape rather than by position.
  const all = [...html.matchAll(/<colgroup>(.*?)<\/colgroup>/g)]
    .map((m) => [...m[1].matchAll(/width:\s*([\d.]+)%/g)].map((w) => Number(w[1])));
  const widths = all.find((w) => w.length === 4);
  assert.ok(widths, `no four-column colgroup found, saw ${JSON.stringify(all)}`);
  const sum = widths.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 100) < 0.5, `colgroup widths must total 100%, got ${sum}`);

  // Name (0) wider than Questions answered (2), and Questions answered the
  // narrowest of the four.
  assert.ok(widths[0] > widths[2], `Name ${widths[0]}% must exceed Questions answered ${widths[2]}%`);
  assert.equal(Math.min(...widths), widths[2],
    `Questions answered must be the narrowest column, widths were ${widths.join('/')}`);
});

test('the finished table gives Name more room than its numeric columns', () => {
  const html = rosterPrintHTML(roster, 'finished', DATA_URI);
  const groups = [...html.matchAll(/<colgroup>(.*?)<\/colgroup>/g)].map((m) => m[1]);
  const widths = [...groups[0].matchAll(/width:\s*([\d.]+)%/g)].map((m) => Number(m[1]));
  assert.equal(widths.length, 8, 'the finished table has eight columns');
  assert.ok(widths[1] > widths[3] && widths[1] > widths[4],
    `Name ${widths[1]}% must beat Score ${widths[3]}% and Percentage ${widths[4]}%`);
});

test('the print watermark is faded and blurred well past legibility', () => {
  const html = rosterPrintHTML(roster, 'total', DATA_URI);
  const wm = /\.wm\s*\{([^}]*)\}/.exec(html);
  assert.ok(wm, 'the .wm rule is missing');
  const rule = wm[1];

  const opacity = /opacity:\s*([\d.]+)/.exec(rule);
  assert.ok(opacity, 'the watermark needs an explicit opacity');
  assert.ok(Number(opacity[1]) <= 0.18,
    `watermark opacity ${opacity[1]} is too strong to sit behind text`);

  const blur = /blur\(([\d.]+)px\)/.exec(rule);
  assert.ok(blur, 'the watermark needs a blur so it reads as a mark, not text');
  assert.ok(Number(blur[1]) >= 1, `blur ${blur[1]}px is too slight`);
  // blur() on a fixed full-sheet element can be clipped by the page box, so the
  // mark must not also be scaled past the sheet.
  assert.ok(!/filter:[^;]*hue-rotate/.test(rule), 'no hue shift: it must stay grey');
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
