'use strict';
// The Participants tab has no DOM in this runner, so it is covered two ways.
//
//  * src/public/roster-ui.js is a pure classic script - no window, no document,
//    no top-level effects - so it is required directly here, exactly like
//    recipient-input.js. The section vocabulary and the attachment-name parse
//    are therefore asserted on real behaviour instead of on source text.
//
//  * The wiring that has to touch the DOM lives in app.js, which reads
//    window/document/localStorage at load and cannot be required. Its markup and
//    call sites are asserted as text against the very source src/frontend.js
//    serves verbatim to the browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ui = require('../src/public/roster-ui');
const publicDir = path.join(__dirname, '..', 'src', 'public');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

// The exact shape src/services/results.js builds for `roster.summary`, so the
// client is proven to speak the server's vocabulary rather than its own.
const SUMMARY = { finished: 1, inProgress: 1, notStarted: 1, notSent: 1, total: 4 };

// ── Section vocabulary ──────────────────────────────────────────────

test('the dropdown offers the five export sections, Total first', () => {
  // Order and labels both matter: Total is the default, and the labels are
  // what the admin reads next to a count they already know.
  assert.deepEqual(ui.rosterSectionOptions(SUMMARY), [
    ['total', 'Total'],
    ['finished', 'Finished'],
    ['in_progress', 'In progress'],
    ['not_started', 'Not started'],
    ['not_sent', 'Not sent'],
  ]);
});

test('the section list follows the server payload, not a copy baked into the client', () => {
  // A sixth group appearing in `roster.summary` must reach the dropdown without
  // an app.js edit. A hardcoded five-entry array cannot pass this.
  const extended = { ...SUMMARY, expiringSoon: 2 };
  assert.deepEqual(ui.rosterSectionOptions(extended).map(([value]) => value), [
    'total', 'finished', 'in_progress', 'not_started', 'not_sent', 'expiring_soon',
  ]);
});

test('a label is derived from the key, so a new section needs no client edit', () => {
  assert.equal(ui.sectionLabel('total'), 'Total');
  assert.equal(ui.sectionLabel('finished'), 'Finished');
  assert.equal(ui.sectionLabel('in_progress'), 'In progress');
  assert.equal(ui.sectionLabel('not_started'), 'Not started');
  assert.equal(ui.sectionLabel('not_sent'), 'Not sent');
  assert.equal(ui.sectionLabel('expiring_soon'), 'Expiring soon');
});

test('a camelCase group name becomes the snake_case key the server expects', () => {
  // `in_progress` and `inProgress` are deliberately different strings on the
  // server, so the conversion has to be mechanical and total.
  assert.equal(ui.sectionKey('inProgress'), 'in_progress');
  assert.equal(ui.sectionKey('notStarted'), 'not_started');
  assert.equal(ui.sectionKey('notSent'), 'not_sent');
  assert.equal(ui.sectionKey('finished'), 'finished');
  assert.equal(ui.sectionKey('total'), 'total');
});

test('every derived option survives the key conversion round trip', () => {
  for (const [value] of ui.rosterSectionOptions(SUMMARY)) {
    assert.equal(ui.sectionKey(value), value, `${value} is not stable`);
    assert.ok(value.split('_').every((w) => w === w.toLowerCase()), `${value} is not snake_case`);
  }
});

test('a nullish summary yields no options instead of throwing', () => {
  // The roster endpoint always sends `summary`; this is the guard for a
  // partial payload, where an exception would take the whole tab down.
  assert.deepEqual(ui.rosterSectionOptions(null), []);
  assert.deepEqual(ui.rosterSectionOptions(undefined), []);
  assert.deepEqual(ui.rosterSectionOptions({}), []);
});

// ── Attachment name ─────────────────────────────────────────────────

test('the download name comes from the server header, in either quoting style', () => {
  // src/routes/api.js always quotes it; the unquoted form is the common
  // hand-written fallback and must not leak a stray quote into the filename.
  assert.equal(ui.attachmentFilename('attachment; filename="participants-12-Not-sent.docx"', 'p.docx'),
    'participants-12-Not-sent.docx');
  assert.equal(ui.attachmentFilename('attachment; filename=participants-12.docx', 'p.docx'),
    'participants-12.docx');
});

test('a missing or unusable header falls back rather than producing "undefined"', () => {
  assert.equal(ui.attachmentFilename(null, 'participants-1.docx'), 'participants-1.docx');
  assert.equal(ui.attachmentFilename('', 'participants-1.docx'), 'participants-1.docx');
  assert.equal(ui.attachmentFilename('attachment', 'participants-1.docx'), 'participants-1.docx');
});

// ── Wiring in app.js (asserted as text: no DOM here) ─────────────────

test('roster-ui.js is loaded before app.js, which reads its global', () => {
  assert.ok(/<script src="\/roster-ui\.js"><\/script>/.test(html), 'roster-ui.js is not served');
  const uiAt = html.indexOf('/roster-ui.js');
  const appAt = html.indexOf('/app.js');
  assert.ok(uiAt > -1 && uiAt < appAt, 'roster-ui.js must load before app.js');
});

test('the section dropdown is rendered from the roster payload', () => {
  const m = app.match(/<select[^>]*id="rosterSection"[\s\S]*?<\/select>/);
  assert.ok(m, 'rosterSection select missing');
  // The <option> tag in this block is emitted by a JS interpolation, so the check
  // is that no option VALUE is written literally: a hardcoded five-entry list
  // cannot survive here, and a sixth section would need no app.js edit.
  for (const v of ['total', 'finished', 'in_progress', 'not_started', 'not_sent']) {
    assert.ok(!m[0].includes(`value="${v}"`), `option ${v} is hardcoded instead of derived`);
  }
  assert.ok(m[0].includes('rosterSectionOptions'), 'the select must use the shared helper');
  assert.ok(app.includes('value="${esc(value)}"'), 'option values must be escaped');
  assert.ok(app.includes("' selected'"), 'Total must be the default selection');
});

test('both export actions read the section at click time', () => {
  for (const fn of ['printRoster', 'downloadRosterDocx']) {
    assert.ok(app.includes(`function ${fn}(`), `${fn} missing`);
  }
  assert.ok(!app.includes('downloadRosterCsv'), 'the CSV downloader was removed');
  assert.ok(app.includes('rosterSectionValue()'), 'one shared reader is required');
  const uses = (app.match(/rosterSectionValue\(\)/g) || []).length;
  assert.ok(uses >= 3, `expected 2 call sites plus the definition, saw ${uses}`);
});

test('the docx action exists and asks for the right content type', () => {
  assert.ok(/Download Word/.test(app), 'Download Word button missing');
  assert.ok(app.includes('participants.docx'), 'docx endpoint not called');
});

test('the watermark controls are present and refresh without a page reload', () => {
  assert.ok(/Watermark logo/i.test(app));
  assert.ok(/type="file"/.test(app), 'file input missing');
  assert.ok(/Use default/i.test(app), 'reset control missing');
  assert.ok(/watermark-logo/.test(app), 'no watermark endpoint call');
  assert.ok(/loadWatermark\(\)/.test(app), 'the controls never load their own state');
});

test('the screen Not Sent table gains the two missing columns', () => {
  const m = app.match(/roster\.notSent,\s*\[([^\]]+)\]/);
  assert.ok(m, 'notSent rosterTable call not found');
  const cols = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
  assert.deepEqual(cols, ['Name', 'Phone', 'Questions answered', 'Started']);
});

test('the new controls inherit the existing button and field styling', () => {
  assert.ok(css.includes('btn-ghost'), 'ghost button class missing from css');
  assert.ok(/select[^{]*\{/.test(css), 'a global select rule must exist');
  assert.ok(/\.wm-controls\s*\{/.test(css), 'watermark control row has no rule');
  assert.ok(/#wmPreview\s*\{/.test(css), 'watermark preview has no rule');
  // The dashboard is dark; a hardcoded light border would glare in it.
  assert.ok(!/#wmPreview\s*\{[^}]*#ddd/i.test(css), 'preview border must not hardcode a light grey');
});
