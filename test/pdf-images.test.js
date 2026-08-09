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