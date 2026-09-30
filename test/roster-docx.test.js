'use strict';
require('./helpers/isolate');

const test = require('node:test');
const assert = require('node:assert/strict');
const { rosterDocx, ROSTER_SECTIONS } = require('../src/services/results');
const wm = require('../src/services/watermark');
const { readZip } = require('./zip-read');

const PART_NAMES = [
  '[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'word/document.xml',
  'word/_rels/document.xml.rels', 'word/styles.xml', 'word/header1.xml',
  'word/_rels/header1.xml.rels', 'word/media/watermark.png',
];

// Truncated fixture for the structural tests: a .docx is a ZIP, so the image
// part is opaque bytes as far as anything here is concerned. The real service
// output is exercised separately below.
const WATERMARK = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

const roster = {
  exam: { id: 12, title: 'Maths & "Co"', duration_minutes: 30, pass_percentage: 50, status: 'live' },
  finished: [{ rank: 1, name: '<&">', phone: '+994 555 0001', final_score: 9,
               final_percentage: 90, passed: 1, attempt_no: 2, ended_at: '2026-09-29T10:00:00Z' }],
  inProgress: [{ name: 'Bob', phone: '+994 555 0002', questions_answered: 3, started_at: '2026-09-29T09:00:00Z' }],
  notStarted: [{ name: 'Cid', phone: '+994 555 0003', questions_answered: 0, started_at: null }],
  notSent: [{ name: 'Dee', phone: '+994 555 0004', questions_answered: 0, started_at: null }],
  summary: { total: 4, finished: 1, inProgress: 1, notStarted: 1, notSent: 1 },
};

function docx(section) {
  return rosterDocx(roster, section, WATERMARK);
}

function part(buf, name) {
  return readZip(buf).get(name).toString('utf8');
}

// No DOMParser here (Node has none, and adding a dependency for it is not on
// the table), so well-formedness is checked by a small scanner: declaration
// present, tags balanced and correctly nested, attributes quoted, and no bare
// ampersand outside a legal entity. That is precisely the set of mistakes a
// hand-written OOXML part actually makes.
const TAG = /^<(\/?)([A-Za-z_][A-Za-z0-9_.:-]*)((?:\s+[A-Za-z_][A-Za-z0-9_.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/;
const BARE_AMP = /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9A-Fa-f]+;)/;

function assertText(text, where) {
  const bad = BARE_AMP.exec(text);
  assert.equal(bad, null, `illegal entity ${JSON.stringify(bad && bad[0])} ${where}`);
}

function assertXMLWellFormed(xml) {
  assert.ok(xml.startsWith('<?xml version='), 'missing XML declaration');
  const declEnd = xml.indexOf('?>');
  assert.ok(declEnd > 0, 'unterminated XML declaration');

  const stack = [];
  let i = declEnd + 2;
  let closedRoot = false;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      assert.equal(xml.slice(i).trim(), '', 'trailing content after the root element');
      i = xml.length;
      break;
    }
    const between = xml.slice(i, lt);
    if (stack.length === 0) {
      assert.equal(between.trim(), '', 'content outside the root element');
    } else {
      assertText(between, `in the text of <${stack[stack.length - 1]}>`);
    }
    const m = TAG.exec(xml.slice(lt));
    assert.ok(m, `malformed tag at offset ${lt}: ${xml.slice(lt, lt + 60)}`);
    const [, closing, name, attrs, selfClose] = m;
    assert.ok(!attrs.includes('<'), `unescaped "<" in an attribute of <${name}>`);
    if (closing === '/') {
      const open = stack.pop();
      assert.equal(open, name, `</${name}> does not close <${open === undefined ? 'nothing' : open}>`);
      closedRoot = closedRoot || stack.length === 0;
    } else if (selfClose === '/') {
      // A self-closing element opens and closes itself, so the stack is unchanged.
    } else {
      stack.push(name);
    }
    i = lt + m[0].length;
  }
  assert.equal(stack.length, 0, `unclosed element(s): ${stack.join(', ')}`);
  assert.ok(closedRoot, 'no element was closed');
}

// Relationship targets are relative to the part that owns the .rels file, so
// word/_rels/header1.xml.rels resolves "media/watermark.png" against word/.
function resolveTarget(relsName, target) {
  const base = relsName.slice(0, relsName.indexOf('_rels/'));
  const segments = (base + target).split('/');
  const out = [];
  for (const s of segments) {
    if (s === '' || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return out.join('/');
}

test('the docx is a zip containing all nine parts', () => {
  const files = readZip(docx('total'));
  assert.deepEqual([...files.keys()].sort(), [...PART_NAMES].sort());
});

test('document.xml is well-formed XML and escapes a hostile name', () => {
  const doc = part(docx('total'), 'word/document.xml');
  assertXMLWellFormed(doc);
  assert.ok(!doc.includes('<&">'), 'the raw name must not appear unescaped');
  assert.ok(doc.includes('&lt;&amp;&quot;&gt;'), doc.slice(0, 400));
  assert.ok(!doc.includes('Maths & "Co"'), 'ampersand and quote must be escaped in text');
});

test('the page border is green on all four sides', () => {
  const doc = part(docx('total'), 'word/document.xml');
  const m = doc.match(/<w:pgBorders[^>]*>([\s\S]*?)<\/w:pgBorders>/);
  assert.ok(m, 'pgBorders missing');
  for (const side of ['top', 'left', 'bottom', 'right']) {
    assert.ok(m[1].includes(`<w:${side} `), `${side} border missing`);
  }
  assert.equal((m[1].match(/25D366/g) || []).length, 4, 'all four sides use the WhatsApp green');
  assert.ok(m[0].includes('w:offsetFrom="page"'));
});

test('the header is the default one and titlePg is absent, so the mark repeats on every page', () => {
  const doc = part(docx('total'), 'word/document.xml');
  assert.ok(/<w:headerReference[^>]*w:type="default"/.test(doc), 'header must be type="default"');
  assert.ok(!doc.includes('w:titlePg'), 'titlePg would move the header to page one only');
});

test('the VML watermark is centred, behind the text, and carries Word washout', () => {
  const hdr = part(docx('total'), 'word/header1.xml');
  assertXMLWellFormed(hdr);
  assert.ok(hdr.includes('type="#_x0000_t75"'), 'picture shape type missing');
  assert.ok(hdr.includes('mso-position-horizontal:center'));
  assert.ok(hdr.includes('mso-position-vertical:center'));
  assert.ok(/z-index:-\d+/.test(hdr), 'a positive z-index would cover the text');
  assert.ok(hdr.includes('gain="19661f"') && hdr.includes('blacklevel="22938f"'));
  assert.ok(hdr.includes('o:allowincell="f"'));
});

test('every r:id referenced resolves to an existing part, and so does every declared one', () => {
  const files = readZip(docx('total'));
  // Only the two parts that carry r:id references; the package-level
  // _rels/.rels has no r:id-bearing part of its own but is still checked.
  for (const [name, rels] of [
    ['word/document.xml', 'word/_rels/document.xml.rels'],
    ['word/header1.xml', 'word/_rels/header1.xml.rels'],
  ]) {
    const partXml = files.get(name).toString('utf8');
    const relsXml = files.get(rels).toString('utf8');
    const ids = new Set([...partXml.matchAll(/r:id="([^"]+)"/g)].map((m) => m[1]));
    assert.ok(ids.size > 0, `${name} should reference at least one relationship`);
    for (const id of ids) {
      assert.ok(relsXml.includes(`Id="${id}"`), `${name} references ${id}, absent from ${rels}`);
    }
    // A relationship nobody references is normal; one whose target does not
    // exist is a dangling pointer that makes Word offer to repair the file.
    for (const m of relsXml.matchAll(/<Relationship Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
      const target = resolveTarget(rels, m[2]);
      assert.ok(files.has(target),
        `${rels} ${m[1]} points at ${m[2]}, which resolves to a missing part: ${target}`);
    }
  }
  for (const m of files.get('_rels/.rels').toString('utf8')
    .matchAll(/<Relationship Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    assert.ok(files.has(m[2]), `_rels/.rels ${m[1]} points at a missing part: ${m[2]}`);
  }
  assert.ok(files.get('word/_rels/header1.xml.rels').toString('utf8')
    .includes('media/watermark.png'), 'header rels must point at the image');
});

test('the watermark png part is the exact buffer handed in, and a real one survives', async () => {
  const embedded = readZip(docx('total')).get('word/media/watermark.png');
  assert.ok(Buffer.isBuffer(embedded));
  assert.equal(embedded.length, WATERMARK.length);
  assert.ok(embedded.equals(WATERMARK), 'the image part must be byte-identical to the input');

  // The truncated fixture proves plumbing; the real service output proves the
  // part is a decodable PNG rather than arbitrary bytes.
  const png = await wm.watermarkPng();
  const real = readZip(rosterDocx(roster, 'total', png)).get('word/media/watermark.png');
  assert.equal(real.length, png.length);
  assert.ok(real.equals(png), 'the real watermark must round-trip unchanged');
  assert.deepEqual(await wm.pngSize(real), { width: 700, height: 700 });
});

test('section filtering and the section stamp are reflected in the body', () => {
  const total = part(docx('total'), 'word/document.xml');
  for (const t of ['Finished', 'In Progress', 'Not Started', 'Not Sent']) {
    assert.ok(total.includes(t), `total should contain ${t}`);
  }
  const notSent = part(docx('not_sent'), 'word/document.xml');
  assertXMLWellFormed(notSent);
  assert.ok(notSent.includes('Section: Not sent'));
  assert.ok(notSent.includes('Not Sent'));
  // The count chips always render, so a leak shows up as a block title.
  for (const t of ['In Progress', 'Not Started']) assert.ok(!notSent.includes(t), `${t} leaked`);
  assert.ok(!total.includes('Section:'), 'total stays unadorned');
  assert.ok(!ROSTER_SECTIONS.total.label.includes('Section'), 'sanity: the stamp is a per-section string');
});

test('an empty selected group renders an empty-state row, not a broken table', () => {
  const body = part(rosterDocx({ ...roster, finished: [] }, 'finished', WATERMARK), 'word/document.xml');
  assertXMLWellFormed(body);
  assert.ok(body.includes('None'), body.slice(-600));
  assert.ok(body.includes('Finished (ranked by percentage)'), 'the heading still names the group');
});

test('a huge roster does not blow the stack or produce invalid XML', () => {
  const many = { ...roster, notSent: Array.from({ length: 3000 }, (_, i) => ({
    name: `Student ${i}`, phone: `+994 555 ${String(i).padStart(4, '0')}`,
    questions_answered: 0, started_at: null })) };
  const body = part(rosterDocx(many, 'not_sent', WATERMARK), 'word/document.xml');
  assertXMLWellFormed(body);
  assert.ok(body.includes('Student 2999'));
  assert.ok(!body.includes('Student 3000'));
});
