'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const pdf = require('../src/services/pdf');

const TMP = path.join(require('os').tmpdir(), 'pdf-images-test-' + process.pid);
// 2x2 solid red PNG built with @napi-rs/canvas (pdfkit's png-js rejects some
// minimal hand-crafted PNGs)
const { createCanvas } = require('@napi-rs/canvas');
const redCanvas = createCanvas(2, 2);
const redCtx = redCanvas.getContext('2d');
redCtx.fillStyle = '#ff0000';
redCtx.fillRect(0, 0, 2, 2);
const RED_PNG = redCanvas.toBuffer('image/png');

function collectPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function fixturePdf() {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(12).text('1. What is the capital of Ghana?');
    doc.image(RED_PNG, 100, 300, { width: 200, height: 150 });
    doc.text('', 0, 0);
    doc.text('Figure 1 - map');
    doc.addPage();
    doc.text('2. The box below is called');
    doc.rect(150, 250, 300, 250).fillAndStroke('#000000', '#000000');
    doc.addPage();
    doc.text('Part B Solutions');
    doc.image(RED_PNG, 50, 500, { width: 300, height: 250 });
    doc.end();
  });
}

let fixture;
before(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  fixture = await fixturePdf();
});

test('extractDocument detects raster and vector images with plausible boxes', async () => {
  const { images } = await pdf.extractDocument(fixture);
  assert.ok(images.length >= 2, `expected at least 2 images, got ${images.length}`);
  const raster = images.filter((i) => i.kind === 'raster');
  const vec = images.filter((i) => i.kind === 'vector');
  assert.equal(raster.length, 2, 'page1 image + page3 solutions image');
  assert.equal(vec.length, 1, 'page 2 vector');
  const p1 = raster.find((i) => i.page === 1);
  assert.ok(p1.y > 200 && p1.y < 600, 'raster page1 vertical band');
});

test('extractDocument text stays marker-free and matches extractText', async () => {
  const { text } = await pdf.extractDocument(fixture);
  assert.doesNotMatch(text, /\[IMG:/, 'no markers leak into extractDocument text');
  const plain = await pdf.extractText(fixture);
  assert.equal(text, plain, 'extractDocument text equals extractText output');
});

test('markers land after the nearest line above each image', async () => {
  const { images } = await pdf.extractDocument(fixture);
  const idxOf = (page, kind) => images.findIndex((i) => i.page === page && i.kind === kind);
  assert.equal(idxOf(1, 'raster'), 0, 'page-1 raster is image 0');
  assert.equal(idxOf(2, 'vector'), 1, 'page-2 vector is image 1');
  assert.equal(idxOf(3, 'raster'), 2, 'page-3 raster is image 2 (marker index follows images order)');
  const { text, markers } = await pdf.textWithMarkers(fixture);
  assert.ok(text.includes('[IMG:0]'), 'first marker present');
  assert.ok(text.includes('[IMG:1]'), 'second marker present');
  assert.ok(text.includes('[IMG:2]'), 'third marker present');
  // The page-1 marker must sit after the Q1 stem line, before the caption
  const i0 = text.indexOf('[IMG:0]');
  assert.ok(i0 > text.indexOf('1. What is'), 'after stem');
  assert.ok(i0 < text.indexOf('Figure 1 - map'), 'before caption');
  // The page-2 marker sits with the vector question
  const i1 = text.indexOf('[IMG:1]');
  assert.ok(i1 > text.indexOf('2. The box below'), 'page-2 marker after its stem');
  // The page-3 marker still exists in the marked text (it survives the size
  // filters); whether it attaches is decided by the solutions-block drop.
  const i2 = text.indexOf('[IMG:2]');
  assert.ok(i2 > text.indexOf('Part B Solutions'), 'page-3 marker after its section heading');
  assert.deepEqual(markers.map((m) => m.idx), [0, 1, 2], 'markers in images order');
});

test('filters drop tiny ornaments and giant spreads but keep single big images', async () => {
  const { images } = await pdf.extractDocument(fixture);
  assert.ok(images.every((i) => i.w > 1 && i.h > 1));
});

// ── math expressions + page headers ────────────────────────────────────

// "Simplify:"-style maths expressions are short, wide images far smaller than
// diagrams. They must survive the size filter or the question loses the actual
// expression and becomes unanswerable in WhatsApp.
test('small wide raster math expressions survive the size filter', async () => {
  const { createCanvas } = require('@napi-rs/canvas');
  const c = createCanvas(120, 30);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0000cc';
  ctx.fillRect(0, 0, 120, 30);
  const png = c.toBuffer('image/png');

  const doc = new PDFDocument();
  doc.fontSize(11).text('1. Simplify:');
  doc.y += 4;
  doc.image(png, 110, doc.y, { width: 120, height: 30 });
  doc.y += 30 + 8;
  doc.text('A. 4x^2');
  doc.text('B. 2x^2');
  doc.text('C. 4x');
  doc.text('D. 2x');
  doc.end();
  const buf = await collectPdf(doc);

  const { images } = await pdf.extractDocument(buf);
  const expr = images.find((i) => i.kind === 'raster');
  assert.ok(expr, 'expression image is detected');
  assert.ok(expr.h < 60, 'expression is short');
  assert.ok(expr.w / expr.h >= 2.5, 'expression is wide');
  const pageArea = 612 * 792;
  assert.ok((expr.w * expr.h) / pageArea < 0.015, 'was previously dropped by the min-size filter');
});

test('tiny near-square raster ornaments are still dropped', async () => {
  const { createCanvas } = require('@napi-rs/canvas');
  const c = createCanvas(30, 30);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 30, 30);
  const png = c.toBuffer('image/png');

  const doc = new PDFDocument();
  doc.fontSize(11).text('1. Which is a prime number?');
  doc.image(png, 60, 400, { width: 30, height: 30 });
  doc.moveDown(1);
  doc.text('A. 4  B. 7  C. 9  D. 12');
  doc.end();
  const buf = await collectPdf(doc);

  const { images } = await pdf.extractDocument(buf);
  assert.equal(images.length, 0, 'bullet-sized square is not detected as a figure');
});

test('a page-1 header banner with no text above it is dropped', async () => {
  const { createCanvas } = require('@napi-rs/canvas');
  const c = createCanvas(240, 60);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#cc0000';
  ctx.fillRect(0, 0, 240, 60);
  const banner = c.toBuffer('image/png');
  const c2 = createCanvas(150, 150);
  const ctx2 = c2.getContext('2d');
  ctx2.fillStyle = '#000000';
  ctx2.fillRect(0, 0, 150, 150);
  const fig = c2.toBuffer('image/png');

  const doc = new PDFDocument();
  doc.image(banner, 186, 40, { width: 240, height: 60 }); // top of page 1, no text above
  doc.moveDown(2).fontSize(16).text('2026 BECE Mathematics');
  doc.fontSize(11).text('1. Use the circle below to answer the question.');
  doc.y += 4;
  doc.image(fig, 230, doc.y, { width: 150, height: 150 });
  doc.y += 150 + 8;
  doc.text('A. 14  B. 22  C. 28  D. 30');
  doc.end();
  const buf = await collectPdf(doc);

  const { images } = await pdf.extractDocument(buf);
  const kept = images.find((i) => i.h > 60);
  assert.ok(kept, 'the question figure is kept');
  assert.equal(images.length, 1, 'the header banner is dropped');
});

test('a short wide vector box containing text is kept as a math expression', async () => {
  const doc = new PDFDocument();
  doc.fontSize(11).text('3. Solve for x in the equation below:');
  doc.rect(120, 300, 300, 30).fill('#eeeeee'); // vector box, short
  doc.fontSize(10).text('ax^2 + bx + c = 0', 130, 305);
  doc.moveDown(1);
  doc.text('A. x = 2  B. x = 3  C. x = 5  D. x = 7');
  doc.end();
  const buf = await collectPdf(doc);

  const { images } = await pdf.extractDocument(buf);
  assert.ok(images.some((i) => i.kind === 'vector' && i.h <= 60), 'short equation box is kept despite text inside');
});

test('markers anchor above the image top so expressions land between stem and options', async () => {
  const { createCanvas } = require('@napi-rs/canvas');
  const c = createCanvas(120, 30);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#008800';
  ctx.fillRect(0, 0, 120, 30);
  const png = c.toBuffer('image/png');

  const doc = new PDFDocument();
  doc.fontSize(11).text('1. Simplify:');
  doc.y += 4;
  doc.image(png, 110, doc.y, { width: 120, height: 30 });
  doc.y += 30 + 8;
  doc.text('A. 4x^2');
  doc.text('B. 2x^2');
  doc.text('C. 4x');
  doc.text('D. 2x');
  doc.end();
  const buf = await collectPdf(doc);

  const { text, markers } = await pdf.textWithMarkers(buf);
  assert.equal(markers.length, 1);
  const stemIdx = text.indexOf('1. Simplify:');
  const optIdx = text.indexOf('A. 4x^2');
  const mkIdx = text.indexOf('[IMG:0]');
  assert.ok(mkIdx > stemIdx, 'marker after the stem');
  assert.ok(mkIdx < optIdx, 'marker before the options');
});

test('stripMarkers removes marker lines fully', () => {
  assert.equal(pdf.stripMarkers('a\n[IMG:3]\nb\n'), 'a\nb\n');
  assert.equal(pdf.stripMarkers('no markers here'), 'no markers here');
});

async function pngStats(file) {
  const sharp = require('sharp');
  const meta = await sharp(file).metadata();
  const stats = await sharp(file).stats();
  return { meta, stats };
}

test('renderImage writes a decodable red PNG at 2x the detected box', async () => {
  const { images } = await pdf.extractDocument(fixture);
  const raster = images.filter((i) => i.kind === 'raster');
  assert.ok(raster.length >= 1, 'need a raster image');
  const outPath = path.join(TMP, 'raster-red.png');
  await pdf.renderImage(fixture, raster[0], outPath);
  const { meta, stats } = await pngStats(outPath);
  assert.equal(meta.format, 'png');
  assert.equal(meta.width, Math.round(raster[0].w * 2), '2x box width');
  assert.equal(meta.height, Math.round(raster[0].h * 2), '2x box height');
  const [r, g, b] = stats.channels;
  assert.ok(r.mean > 200, `red channel is dominant, got ${r.mean}`);
  assert.ok(g.mean < 60 && b.mean < 60, 'green and blue stay low');
});

test('renderImage on the solutions raster box renders at its box size', async () => {
  const { images } = await pdf.extractDocument(fixture);
  const p3 = images.find((i) => i.page === 3 && i.kind === 'raster');
  assert.ok(p3, 'page-3 raster exists');
  const outPath = path.join(TMP, 'raster-solutions.png');
  await pdf.renderImage(fixture, p3, outPath);
  const { meta } = await pngStats(outPath);
  assert.equal(meta.width, Math.round(p3.w * 2));
  assert.equal(meta.height, Math.round(p3.h * 2));
  const { stats } = await pngStats(outPath);
  assert.ok(stats.channels[0].mean > 200, 'still the red figure');
});

test('renderImage on a vector image falls back to a placeholder without throwing', async () => {
  const { images } = await pdf.extractDocument(fixture);
  const vec = images.find((i) => i.kind === 'vector');
  assert.ok(vec, 'vector image exists');
  const outPath = path.join(TMP, 'vector-placeholder.png');
  await pdf.renderImage(fixture, vec, outPath);
  const { meta } = await pngStats(outPath);
  assert.equal(meta.format, 'png');
  assert.equal(meta.width, Math.round(vec.w * 2), 'placeholder matches the vector box 2x');
});

test('vector regions render a non-blank PNG', async () => {
  const { images } = await pdf.extractDocument(fixture);
  const v = images.find((i) => i.kind === 'vector');
  assert.ok(v, 'page-2 vector exists');
  const dest = path.join(TMP, 'v.png');
  await pdf.renderVectorRegion(fixture, v, dest);
  const buf = fs.readFileSync(dest);
  assert.equal(buf.slice(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG magic');
  const sharp = require('sharp');
  const { data } = await sharp(dest).raw().toBuffer({ resolveWithObject: true });
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 128) dark++;
  }
  assert.ok(dark > 0, 'has non-white pixels (the black 300x250 box)');
});

test('vector regions with text inside are NOT listed as diagrams', async () => {
  const doc = new PDFDocument();
  doc.rect(50, 200, 400, 150).fill('#eeeeee');
  doc.fontSize(10).text('pH table cell text 1', 55, 245);
  doc.text('pH table cell text 2', 55, 260);
  doc.end();
  const buf2 = await collectPdf(doc);
  const { images } = await pdf.extractDocument(buf2);
  const r = images.find((i) => i.kind === 'vector');
  assert.equal(r, undefined, 'vector with text inside is excluded');
});

// ── Task 6: marker attachment in the extraction pipeline ──────────────

const aiMod = require('../src/services/ai');

async function withStubChatJSON(questions, fn) {
  const orig = aiMod.chatJSON;
  aiMod.chatJSON = async () => ({ questions });
  try {
    return await fn();
  } finally {
    aiMod.chatJSON = orig;
  }
}

test('extraction attaches markers that survived into a question and strips them from text', async () => {
  await withStubChatJSON(
    [{ type: 'theory', number: 1, text: 'Look at Figure 1. [IMG:0]', passage: 'Figure 1 - a map' }],
    async () => {
      const qs = await aiMod.extractQuestionsFromText(
        '1. Look at Figure 1.\n[IMG:0]\nFigure 1 - a map\n\n',
        null, null,
        { markers: [{ idx: 0, page: 1 }] }
      );
      assert.equal(qs.length, 1);
      assert.equal(qs[0].text, 'Look at Figure 1.', 'marker stripped from text');
      assert.equal(qs[0].passage, 'Figure 1 - a map', 'marker stripped from passage');
      assert.equal(qs[0].markerIndex, 0, 'marker attached to the question that kept it');
    }
  );
});

test('extraction falls back to the first question of the block when the AI dropped the marker', async () => {
  await withStubChatJSON(
    [{ type: 'objective', number: 7, text: 'Which instrument measures current?', options: ['A. Voltmeter', 'B. Ammeter', 'C. Ohmmeter', 'D. Galvanometer'] }],
    async () => {
      const qs = await aiMod.extractQuestionsFromText(
        '7. Which instrument measures current?\n[IMG:2]\n',
        null, null,
        { markers: [{ idx: 2, page: 2 }] }
      );
      assert.equal(qs.length, 1);
      assert.equal(qs[0].markerIndex, 2, 'fallback: marker attaches to the first question of the block');
    }
  );
});

test('extraction warns (once) when a marker block yielded no questions', async () => {
  const warnings = [];
  await withStubChatJSON([], async () => {
    await aiMod.extractQuestionsFromText(
      '9. State two uses of a thermometer.\n[IMG:4]\n',
      null, (w) => warnings.push(w),
      { markers: [{ idx: 4, page: 3 }] }
    );
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /diagram/);
});

test('stripping does not fire when the document had no markers at all', async () => {
  const warnings = [];
  await withStubChatJSON(
    [{ type: 'theory', number: 1, text: 'Explain photosynthesis.', passage: '' }],
    async () => {
      const qs = await aiMod.extractQuestionsFromText('1. Explain photosynthesis.\n', null, (w) => warnings.push(w));
      assert.equal(qs[0].markerIndex, undefined, 'no marker attachment for marker-less documents');
      assert.equal(qs[0].text, 'Explain photosynthesis.');
    }
  );
  assert.equal(warnings.length, 0, 'no phantom-marker warnings for pasted text');
});

// ── Task 7: pdfImport image saving ─────────────────────────────────────

const pdfImport = require('../src/services/pdfImport');

test('file name for an attached marker is deterministic', () => {
  const p = pdfImport.imageFileNameFor(1739, 3, 1, 1739000000000);
  assert.equal(p, '1739000000000-1739-q3-1.png');
  assert.match(p, /^\d+-1739-q3-1\.png$/);
});

test('import loop renders the marker image into uploads (smoke via helper path)', async () => {
  const { images } = await pdf.extractDocument(fixture);
  const raster = images.find((i) => i.kind === 'raster');
  const dest = path.join(TMP, 'upload-q1-0.png');
  const written = await pdf.renderImage(fixture, raster, dest);
  assert.equal(written, dest);
  const { meta } = await pngStats(written);
  assert.equal(meta.format, 'png', 'rendered image usable by the import loop');
});

test('reportHTML renders an img tag for a question with an image', () => {
  const results = require('../src/services/results');
  const db = require('../src/db');
  db.exec('BEGIN');
  try {
    const examId = db.prepare("INSERT INTO exams (title, duration_minutes) VALUES ('r', 1)").run().lastInsertRowid;
    db.prepare("INSERT INTO students (id, phone) VALUES (0, '+233000000000')").run();
    const sid = db.prepare("INSERT INTO sessions (exam_id, student_id, status) VALUES (?, 0, 'completed')").run(examId).lastInsertRowid;
    const qid = db.prepare("INSERT INTO questions (exam_id, q_order, type, text, marks, image) VALUES (?,1,'theory','q',5,'x.png')").run(examId).lastInsertRowid;
    db.prepare("INSERT INTO answers (session_id, question_id, q_order, answer_text, is_correct, marks_awarded, max_marks) VALUES (?,?,1,'x',0,0,5)").run(sid, qid);
    const r = results.reportHTML(sid);
    assert.match(r.html, /<img[^>]+src="[^"]*attachment\?file=/);
  } finally { db.exec('ROLLBACK'); }
});

test('WhatsApp question delivery sends the diagram image before text when present', async () => {
  const examMod = require('../src/services/exam');
  const wa = require('../src/services/whatsapp');
  const db = require('../src/db');
  const origImg = wa.sendImage, origTxt = wa.sendText;
  const calls = [];
  wa.sendImage = async () => { calls.push('image'); };
  wa.sendText = async () => { calls.push('text'); };
  try {
    db.exec('BEGIN');
    const examId = db.prepare("INSERT INTO exams (title, duration_minutes, status) VALUES ('x', '1', 'live')").run().lastInsertRowid;
    db.prepare("INSERT INTO questions (exam_id, q_order, type, text, image) VALUES (?,1,'theory','q stem','f.png')").run(examId).lastInsertRowid;
    const stud = db.prepare("INSERT INTO students (phone) VALUES ('233000000000')").run().lastInsertRowid;
    const sid = db.prepare("INSERT INTO sessions (exam_id, student_id, current_q_order, status) VALUES (?, ?, '1','in_progress')").run(examId, stud).lastInsertRowid;
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
    await examMod.sendQuestionTo(session, { phone: '233000000000' });
    // New flow: section header and instructions are sent first as separate
    // messages, then the diagram image, then question text.
    assert.equal(calls[0], 'text', 'section header is the first bubble');
    assert.ok(calls[1] === 'text' || calls[1] === 'image', 'instructions or image follows');
    const imgIdx = calls.indexOf('image');
    assert.ok(imgIdx >= 0, 'image is sent');
    assert.ok(imgIdx < calls.length - 1, 'question text follows the image');
  } finally {
    db.exec('ROLLBACK');
    wa.sendImage = origImg; wa.sendText = origTxt;
  }
});

// ── Math expression bubbles ─────────────────────────────────────────────
//
// WAEC/BECE math papers typeset fractions and powers as STACKED glyphs
// (numerator/denominator share an x column with different baselines). pdf.js
// flattens those to digits dumped at the end of the page text; detectMathExprs
// finds the stacks geometrically, splices a [MATH:n] marker in their place, and
// renderMathRegion crops each expression to its own WhatsApp image bubble.

// First writable system TrueType font — needed so pdf.js can load glyph paths
// and actually paint ink during render tests (pdfkit's built-in Helvetica is
// not embedded). Falls back to skipping the ink assertions if none is found.
function systemTtf() {
  const candidates = [
    'C:/Windows/Fonts/times.ttf',
    'C:/Windows/Fonts/arial.ttf',
    'C:/Windows/Fonts/segoeui.ttf',
    '/System/Library/Fonts/Times.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ];
  return candidates.find((p) => fs.existsSync(p));
}

// A page with two stacked-glyph fractions, like "3/4" and "1/2" typeset by a
// math font: digits at the same x column ~9pt apart in baseline.
async function mathFixturePdf() {
  const doc = new PDFDocument();
  const ttf = systemTtf();
  if (ttf) doc.registerFont('mathfont', ttf);
  doc.font(ttf ? 'mathfont' : 'Helvetica').fontSize(12);
  doc.text('1. Arrange the following:');
  doc.text('3', 210, 680);
  doc.text('4', 210, 671);
  doc.text(' , 0.8, ', 230, 680);
  doc.text('1', 330, 680);
  doc.text('2', 330, 671);
  doc.text(', 0.65 in descending order.', 350, 680);
  doc.end();
  return collectPdf(doc);
}

test('stacked math glyphs become [MATH:n] markers in reading order, digits dropped', async () => {
  const res = await pdf.textWithMarkers(await mathFixturePdf());
  assert.equal(res.mathExprs.length, 2, 'two stacked fractions detected');
  for (const ex of res.mathExprs) {
    assert.equal(ex.page, 1);
    assert.ok(ex.w > 0 && ex.h > 0, 'expression has a real box');
  }
  assert.ok(res.text.includes('[MATH:0]'), 'first fraction marker spliced');
  assert.ok(res.text.includes('[MATH:1]'), 'second fraction marker spliced');
  assert.ok(res.text.includes('Arrange the following:'), 'stem intact');
  assert.ok(res.text.includes('0.8'), 'ordinary inline number keeps its digits');
  assert.ok(res.text.includes('0.65'), 'ordinary inline number keeps its digits');
  // The stacked digits themselves must not leak into the question text (they
  // were replaced by the markers).
  for (const leaked of ['3', '4', '2']) {
    assert.ok(!res.text.includes(leaked), `stacked digit "${leaked}" removed from text`);
  }
  // Markers sit where the fractions were, before the text that followed them.
  const m0 = res.text.indexOf('[MATH:0]');
  const m1 = res.text.indexOf('[MATH:1]');
  assert.ok(m0 < res.text.indexOf('0.8'), '[MATH:0] spliced before "0.8"');
  assert.ok(m1 < res.text.indexOf('0.65'), '[MATH:1] spliced before "0.65"');
});

test('renderMathRegion crops an ink-bearing PNG at the expression box size', async (t) => {
  const ttf = systemTtf();
  if (!ttf) {
    t.skip('no system TrueType font to embed — glyph paint cannot be verified');
    return;
  }
  const buf = await mathFixturePdf();
  const res = await pdf.textWithMarkers(buf);
  assert.equal(res.mathExprs.length, 2);
  const dest = path.join(TMP, 'math-expr-0.png');
  await pdf.renderMathRegion(buf, res.mathExprs[0], dest, 4);
  const magic = fs.readFileSync(dest).slice(0, 8).toString('hex');
  assert.equal(magic, '89504e470d0a1a0a', 'PNG magic');
  const sharp = require('sharp');
  const { data, info } = await sharp(dest).raw().toBuffer({ resolveWithObject: true });
  assert.ok(Math.abs(info.width - Math.round(res.mathExprs[0].w * 4)) <= 8, 'width ~ 4x the box');
  assert.ok(Math.abs(info.height - Math.round(res.mathExprs[0].h * 4)) <= 8, 'height ~ 4x the box');
  let dark = 0;
  for (let k = 0; k < data.length; k += 4) if (data[k] < 128) dark++;
  assert.ok(dark > 0, 'expression pixels are painted (not a blank crop)');
});

test('math markers riding in text or options attach as markerIndices and are stripped from stored fields', async () => {
  await withStubChatJSON(
    [{
      type: 'objective',
      number: 1,
      text: 'Simplify: [MATH:0] y + 1',
      options: ['A. [MATH:1] + 4', 'B. 2y', 'C. y', 'D. y + 2'],
    }],
    async () => {
      const qs = await aiMod.extractQuestionsFromText(
        '1. Simplify:\n[MATH:0]\nA. [MATH:1] + 4\nB. 2y\nC. y\nD. y + 2\n',
        null, null,
        { mathMarkers: [0, 1] }
      );
      assert.equal(qs.length, 1);
      assert.deepEqual(qs[0].markerIndices, [0, 1], 'both math markers attached in document order');
      assert.equal(qs[0].markerIndex, undefined, 'no figure markerIndex for math-only markers');
      assert.equal(qs[0].text, 'Simplify: y + 1', 'marker stripped from text');
      assert.equal(qs[0].options[0], 'A. + 4', 'marker stripped from the option string');
    }
  );
});

test('a math marker whose block yielded no questions warns', async () => {
  const warnings = [];
  await withStubChatJSON([], async () => {
    await aiMod.extractQuestionsFromText(
      '9. Evaluate:\n[MATH:4]\n',
      null, (w) => warnings.push(w),
      { mathMarkers: [4] }
    );
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /math/);
});

test('storeMathImages renders each expression and inserts question_images rows in position order', async () => {
  const ttf = systemTtf();
  if (!ttf) {
    t.skip('no system TrueType font to embed');
    return;
  }
  const db = require('../src/db');
  const pdfImport = require('../src/services/pdfImport');
  const uploadsDir = require('../src/config').uploadsDir;
  db.exec('BEGIN');
  let examId, questionId;
  try {
    const buf = await mathFixturePdf();
    const res = await pdf.textWithMarkers(buf);
    assert.equal(res.mathExprs.length, 2);
    examId = db.prepare("INSERT INTO exams (title, duration_minutes) VALUES ('math', 30)").run().lastInsertRowid;
    questionId = db.prepare(
      "INSERT INTO questions (exam_id, q_order, type, text, marks, source) VALUES (?,1,'objective','Arrange:',1,'pdf')"
    ).run(examId).lastInsertRowid;
    await pdfImport.storeMathImages(
      { markerIndices: [0, 1] }, questionId, res.mathExprs, new Map(), buf, examId, 1
    );
    const rows = db.prepare('SELECT position, image, kind FROM question_images WHERE question_id = ? ORDER BY position').all(questionId);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.position), [0, 1], 'positions 0 and 1');
    assert.equal(rows[0].kind, 'math');
    for (const row of rows) {
      assert.ok(fs.existsSync(path.join(uploadsDir, row.image)), `rendered ${row.image} exists`);
    }
    assert.notEqual(rows[0].image, rows[1].image, 'two distinct expression files');
  } finally {
    db.exec('ROLLBACK');
  }
});

test('WhatsApp delivery sends math expression bubbles in position order above the question text', async () => {
  const examMod = require('../src/services/exam');
  const wa = require('../src/services/whatsapp');
  const db = require('../src/db');
  const origImg = wa.sendImage, origTxt = wa.sendText;
  const calls = [];
  wa.sendImage = async (phone, file) => { calls.push('image:' + path.basename(file)); };
  wa.sendText = async () => { calls.push('text'); };
  try {
    db.exec('BEGIN');
    const examId = db.prepare("INSERT INTO exams (title, duration_minutes, status) VALUES ('x', '1', 'live')").run().lastInsertRowid;
    const qid = db.prepare("INSERT INTO questions (exam_id, q_order, type, text, image) VALUES (?,1,'theory','q stem','legacy.png')").run(examId).lastInsertRowid;
    db.prepare("INSERT INTO question_images (question_id, position, image, kind) VALUES (?,0,'m0.png','math')").run(qid);
    db.prepare("INSERT INTO question_images (question_id, position, image, kind) VALUES (?,1,'m1.png','math')").run(qid);
    const stud = db.prepare("INSERT INTO students (phone) VALUES ('233000000000')").run().lastInsertRowid;
    const sid = db.prepare("INSERT INTO sessions (exam_id, student_id, current_q_order, status) VALUES (?, ?, '1','in_progress')").run(examId, stud).lastInsertRowid;
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
    await examMod.sendQuestionTo(session, { phone: '233000000000' });
    const i0 = calls.indexOf('image:m0.png');
    const i1 = calls.indexOf('image:m1.png');
    assert.ok(i0 >= 0 && i1 >= 0, 'both math bubbles are sent');
    assert.ok(i0 < i1, 'bubbles sent in position order');
    const lastText = calls.map((c, i) => (c.startsWith('text') ? i : -1)).filter((i) => i >= 0).pop();
    assert.ok(lastText !== undefined && i1 < lastText, 'both bubbles arrive above the question text');
    assert.ok(!calls.includes('image:legacy.png'), 'legacy single image not used when question_images exist');
  } finally {
    db.exec('ROLLBACK');
    wa.sendImage = origImg; wa.sendText = origTxt;
  }
});