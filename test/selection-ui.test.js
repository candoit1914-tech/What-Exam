'use strict';
// src/public/selection-ui.js is a pure classic script — no window, no document,
// no top-level effects — so it is required directly here, exactly like
// recipient-input.js and roster-ui.js. The rule-merging, the summary wording and
// the PATCH body are therefore asserted on real behaviour rather than on source
// text.
//
// The wiring that must touch the DOM lives in app.js, which reads window/document
// at load and cannot be required. Its markup and call sites are asserted as text
// against the very source src/frontend.js serves verbatim to the browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ui = require('../src/public/selection-ui');
const publicDir = path.join(__dirname, '..', 'src', 'public');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

// The exact shape GET /api/exams/:id returns for `selection`, as
// src/services/selection.js sectionPlan builds it.
const PLAN = {
  section_key: 'section-b',
  title: 'SECTION B',
  instructions: 'Answer any TWO questions',
  quota: 2,
  compulsory: [{ q_order: 1, marks: 5 }],
  optional: [{ q_order: 2, marks: 5 }, { q_order: 3, marks: 5 }, { q_order: 4, marks: 5 }],
};

test('a section with a rule renders one row carrying the real pool sizes', () => {
  const rows = ui.ruleRows(
    [{ section_key: 'section-b', title: 'SECTION B', instructions: 'Answer any TWO questions', answer_count: 2 }],
    [PLAN]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].section_key, 'section-b');
  // The card shows what the section OWES — three questions, one of them
  // compulsory — because that is the number an admin types. Showing the quota
  // (the two they pick) would reprice the rule to 2 on the next save.
  assert.equal(rows[0].answer_count, 3, "the card shows the server's resolved rule");
  assert.equal(rows[0].pool, 3);
  assert.equal(rows[0].compulsory, 1);
});

test('a plan that carries toAnswer is shown verbatim', () => {
  const rows = ui.ruleRows([], [{ ...PLAN, toAnswer: 4, quota: 3 }]);
  assert.equal(rows[0].answer_count, 4, 'the server-resolved count wins over any rebuild');
});

test('a section with questions but no rule still appears, so the admin can set one', () => {
  // An imported paper can carry section_key on its questions while resolving to
  // answer-all (quota 0). Hiding that section would leave the admin with no way
  // to offer the choice.
  const rows = ui.ruleRows([], [{ ...PLAN, quota: 0 }]);
  assert.equal(rows.length, 1, 'the section is listed even with no stored rule');
  assert.equal(rows[0].answer_count, 0, 'and it starts at answer-all');
  assert.equal(rows[0].title, 'SECTION B', 'the title falls back to the plan');
});

test('a stored rule whose questions were all deleted still appears', () => {
  // The server drops rules that resolve to answer-all, so a leftover rule can
  // outlive its questions. Hiding it would make it uneditable and unremovable.
  const rows = ui.ruleRows([{ section_key: 'section-z', title: 'SECTION Z', answer_count: 2 }], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pool, 0);
  assert.equal(rows[0].answer_count, 0, 'with nothing to choose from, the quota reads zero');
});

test('sections from both sources merge without duplicating a key', () => {
  const rows = ui.ruleRows(
    [{ section_key: 'section-b', title: 'SECTION B', answer_count: 2 }, { section_key: 'section-c', title: 'SECTION C', answer_count: 1 }],
    [PLAN, { section_key: 'section-b', quota: 2 }, { section_key: 'section-d', title: 'SECTION D', quota: 0 }]
  );
  assert.deepEqual(rows.map((r) => r.section_key), ['section-b', 'section-c', 'section-d']);
});

test('a section that exists only on the questions gets a row, so a quota can be typed', () => {
  // An import can save the grouping while failing to read the paper's own
  // instruction, leaving no exam_sections row at all. With no row the card has
  // no input, and the choice the paper clearly offers can never be set — which
  // is how a section ends up with nothing to select from in the chat.
  const rows = ui.ruleRows([], [], [
    { section_key: 'section-b', is_compulsory: 1 },
    { section_key: 'section-b', is_compulsory: 0 },
    { section_key: 'section-b', is_compulsory: 0 },
    { section_key: '', is_compulsory: 1 },
  ]);
  assert.equal(rows.length, 1, 'the section is listed from its questions alone');
  assert.equal(rows[0].section_key, 'section-b', 'a question with no section does not invent one');
  assert.equal(rows[0].pool, 2, 'the pool is what the server will clamp the quota against');
  assert.equal(rows[0].compulsory, 1);
  assert.equal(rows[0].answer_count, 0, 'and it starts at answer-all until a quota is typed');
});

test('the resolved plan still wins over the raw questions for a known key', () => {
  const rows = ui.ruleRows(
    [{ section_key: 'section-b', title: 'SECTION B', answer_count: 2 }],
    [PLAN],
    [{ section_key: 'section-b', is_compulsory: 1 }] // stale list, all compulsory
  );
  assert.equal(rows[0].pool, 3, 'the plan carries the server\u2019s resolved pool, not a re-count');
  assert.equal(rows[0].answer_count, 3, 'and the rule it resolved, compulsory included');
});

test('the row hint states the ceiling so the quota is never a surprise', () => {
  const [row] = ui.ruleRows([], [PLAN]);
  // The ceiling is the whole section: the student owes the compulsory question
  // too, so an input capped at the optional pool would refuse the paper's own
  // "answer any 4 of 5" the moment one of the five is compulsory.
  assert.equal(ui.rowHint(row), '4 questions · 1 compulsory');
  assert.equal(ui.rowHint({ pool: 1, compulsory: 0 }), '1 question · 0 compulsory');
});

test('only live rules reach the summary, counted the way the paper counts them', () => {
  // A section the server resolved to 0 is answer-all. Listing it as a rule
  // would tell the admin students get a choice they do not get.
  const lines = ui.summaryLines([
    PLAN,
    { section_key: 'section-c', title: 'SECTION C', quota: 0, optional: [{}, {}] },
  ]);
  assert.deepEqual(lines, ['SECTION B: answer 3 of 4 (1 compulsory)']);
  assert.deepEqual(ui.summaryLines([]), [], 'no rules reads as none, not as an empty line');
  assert.deepEqual(ui.summaryLines(undefined), []);
});

test('the summary falls back to the key when a section has no title', () => {
  assert.deepEqual(
    ui.summaryLines([{ section_key: 'section-b', quota: 1, optional: [{}] }]),
    ['section-b: answer 1 of 1']
  );
});

test('a blank quota is sent as 0, never dropped', () => {
  // Omitting the key would leave the stored rule untouched, so an admin who
  // cleared the field would watch it come back on reload.
  const body = ui.rulesPayload([{ section_key: 'section-b', title: 'SECTION B', answer_count: '' }]);
  assert.equal(body.sections[0].answer_count, 0);
  assert.ok('answer_count' in body.sections[0], 'the key must be present so the rule is rewritten');
});

test('a nameless row is dropped from the body rather than written as a blank key', () => {
  const body = ui.rulesPayload([
    { section_key: '', title: 'x', answer_count: 1 },
    { section_key: '   ', title: 'y', answer_count: 1 },
    { section_key: ' section-b ', title: 'SECTION B', answer_count: 2 },
  ]);
  assert.deepEqual(body.sections.map((s) => s.section_key), ['section-b'], 'keys are trimmed');
});

test('the section select offers every known section plus the current value', () => {
  const opts = ui.sectionOptions(
    [{ section_key: 'section-b', title: 'SECTION B' }],
    [PLAN],
    ''
  );
  assert.deepEqual(opts, [['section-b', 'SECTION B']]);

  // A question saved before its section had a rule must keep offering that
  // section, or editing it would silently clear the grouping.
  const withCurrent = ui.sectionOptions([], [], 'section-x');
  assert.deepEqual(withCurrent, [['section-x', 'section-x']]);
});

test('the select merges both sources and never lists a key twice', () => {
  const opts = ui.sectionOptions(
    [{ section_key: 'section-b', title: 'SECTION B' }],
    [PLAN, { section_key: 'section-d', title: 'SECTION D' }],
    'section-b'
  );
  assert.deepEqual(opts, [['section-b', 'SECTION B'], ['section-d', 'SECTION D']]);
});

// ── app.js wiring (source text: app.js reads window/document at load) ──

test('the question form carries a compulsory checkbox and a section field', () => {
  assert.match(app, /id="qf_compulsory"/);
  assert.match(app, /id="qf_section"/);
});

test('all three question save paths post both selection fields', () => {
  // The add, add-with-image, and edit paths each build their own payload. A
  // missing field on any one of them silently drops that question's grouping.
  const compulsorySends = app.match(/is_compulsory/gi) || [];
  const sectionSends = app.match(/section_key/gi) || [];
  assert.ok(compulsorySends.length >= 3, `expected is_compulsory on every save path, saw ${compulsorySends.length}`);
  assert.ok(sectionSends.length >= 3, `expected section_key on every save path, saw ${sectionSends.length}`);
  assert.match(app, /formData\.append\('is_compulsory'/);
  assert.match(app, /formData\.append\('section_key'/);
  // Both JSON paths build an object literal, so the fields appear as keys there.
  assert.match(app, /is_compulsory: document\.querySelector\('#qf_compulsory'\)/);
  assert.match(app, /section_key: document\.querySelector\('#qf_section'\)/);
});

test('the exam page renders a selection-rules card and a save path', () => {
  assert.match(app, /function selectionRulesCardHTML/);
  assert.match(app, /function saveSelectionRules/);
  assert.match(app, /\/api\/exams\/\$\{examId\}\/sections/);
  assert.match(app, /selectionRulesCardHTML\(id,/, 'the card is rendered in the questions tab');
  assert.match(
    app,
    /selectionRulesCardHTML\(id, examState\.data\.sections \|\| \[\], examState\.data\.selection \|\| \[\], examState\.data\.questions \|\| \[\]\)/,
    'the questions are passed in: a section with no stored rule has no row without them'
  );
  assert.match(
    app,
    /max="\$\{r\.pool \+ r\.compulsory\}"/,
    'the ceiling is the whole section: answer_count counts the compulsory questions too'
  );
});

test('a compulsory question is badged in the list', () => {
  assert.match(app, /q\.is_compulsory === 0/, 'optional questions are badged as such');
  assert.match(app, /compulsory/);
});

test('selection-ui.js is loaded before app.js reads its global', () => {
  const scriptLines = html.split('\n').filter((l) => /<script src="\/.*\.js">/.test(l));
  const uiAt = scriptLines.findIndex((l) => /selection-ui\.js/.test(l));
  const appAt = scriptLines.findIndex((l) => /app\.js/.test(l));
  assert.ok(uiAt >= 0, 'selection-ui.js must be loaded as a classic script');
  assert.ok(appAt >= 0);
  assert.ok(uiAt < appAt, 'app.js reads the SelectionUI global at load, so order matters');
});