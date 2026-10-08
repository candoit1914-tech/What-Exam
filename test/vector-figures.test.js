'use strict';
require('./helpers/isolate');
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const pdf = require('../src/services/pdf');
const { figureSummary } = require('../src/services/pdfImport');

// A real exam figure is not one shape. It is a box, a circle, a few arrows and
// a handful of labels drawn as SEPARATE paths — pdfjs hands those over one
// constructPath op at a time, each tiny enough to fail the size floor on its
// own. Assembled by hand in a test they are already known-good geometry; what
// this suite pins is that the importer puts them back together, marks them in
// the text, and renders a crop a student can actually read.
const TMP = path.join(require('os').tmpdir(), 'vector-figures-test-' + process.pid);

function collectPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function photoPng(w, h) {
  const { createCanvas } = require('@napi-rs/canvas');
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#cfe8ff';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#036';
  ctx.lineWidth = 4;
  ctx.strokeRect(4, 4, w - 8, h - 8);
  return c.toBuffer('image/png');
}

async function diagramPdf() {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.fontSize(14).text('INTEGRATED SCIENCE 2');
  doc.moveDown(0.5);
  doc.fontSize(11).text('FIGURE 1: The water cycle');
  // The drawing: six separate strokes plus a filled box and three labels.
  const x = 120;
  const y = 220;
  doc.lineWidth(2).strokeColor('#000');
  doc.rect(x, y, 340, 200).stroke();
  doc.circle(x + 80, y + 70, 45).stroke();
  doc.moveTo(x + 150, y + 150).lineTo(x + 250, y + 100).stroke();
  doc.moveTo(x + 250, y + 100).lineTo(x + 235, y + 112).stroke();
  doc.moveTo(x + 250, y + 100).lineTo(x + 240, y + 85).stroke();
  doc.moveTo(x + 40, y + 170).lineTo(x + 120, y + 170).stroke();
  doc.rect(x + 180, y + 140, 90, 40).fillColor('#8fd').fill();
  doc.fillColor('#000').fontSize(12);
  doc.text('SUN', x + 60, y + 60, { lineBreak: false });
  doc.text('CLOUD', x + 195, y + 152, { lineBreak: false });
  doc.text('RAIN', x + 245, y + 90, { lineBreak: false });
  // Question text laid out BELOW the drawing, as a real paper has it.
  doc.fontSize(11);
  doc.text('1. Study the diagram above and answer questions 1 to 3.', 50, 450);
  doc.text('A. Evaporation   B. Condensation   C. Precipitation   D. Transpiration', 50, 470);
  doc.text('2. The process labelled SUN is', 50, 510);
  doc.text('A. Evaporation   B. Condensation   C. Precipitation   D. Collection', 50, 530);
  doc.text('FIGURE 2: A photograph of a village market');
  doc.image(photoPng(320, 160), 120, doc.y + 6, { width: 320 });
  doc.y += 180;
  doc.text('3. Study the photograph above. The goods displayed are mainly');
  doc.text('A. imported   B. locally grown   C. manufactured   D. processed');
  doc.end();
  return collectPdf(doc);
}

let buf;
before(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  buf = await diagramPdf();
});

test('a diagram drawn as many vector paths is one figure, marked in reading order', async () => {
  const { images, markers, text } = await pdf.textWithMarkers(buf);

  const vec = images.find((i) => i.kind === 'vector');
  assert.ok(vec, 'the multi-path drawing is detected as a figure');
  assert.ok(vec.w > 300 && vec.h > 180, `cluster spans the drawing, got ${Math.round(vec.w)}x${Math.round(vec.h)}`);
  assert.ok(images.some((i) => i.kind === 'raster'), 'the photograph on the same page is detected too');

  // Document order: the drawing sits above the photograph, so it takes [IMG:0].
  assert.equal(images[0].kind, 'vector', 'figures are ordered top-to-bottom on the page');
  assert.equal(markers.length, 2, 'both figures carry a marker');
  assert.deepEqual(markers.map((m) => m.idx), [0, 1], 'marker indices follow document order');

  const at = text.indexOf('[IMG:0]');
  assert.ok(at > text.indexOf('FIGURE 1: The water cycle'), 'marker after the caption above the drawing');
  assert.ok(at < text.indexOf('1. Study the diagram above'), 'marker before the question that refers to it');
  assert.equal((await pdf.textWithMarkers(buf)).diagnostics.figures.kept, 2, 'the run reports what it kept');
});

test('the rendered crop carries the drawing, its colours and its labels', async () => {
  const { images } = await pdf.extractDocument(buf);
  const vec = images.find((i) => i.kind === 'vector');
  assert.ok(vec, 'figure detected');
  const dest = path.join(TMP, 'diagram.png');
  await pdf.renderVectorRegion(buf, vec, dest);

  const { data, info } = await sharp(dest).flatten({ background: '#ffffff' }).raw().toBuffer({ resolveWithObject: true });
  let dark = 0;
  let colored = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (r < 128 && g < 128 && b < 128) dark++;
    if (Math.abs(r - g) > 25 || Math.abs(g - b) > 25) colored++;
  }
  // Before the operator list replay understood constructPath, this crop was
  // blank: the diagram was detected, saved, and empty.
  assert.ok(dark > 4000, `the drawing is actually drawn (dark=${dark})`);
  // Before the *RGBColor ops were read as 0..255, every fill painted black.
  assert.ok(colored > 1000, `the diagram keeps its colours (colored=${colored})`);

  // "SUN" sits inside the circle: ink in the middle of the circle is the
  // label — the outline itself never reaches that far in. Crop space is 2x the
  // page, offset by the figure box.
  const { data: labelData } = await sharp(dest)
    .flatten({ background: '#ffffff' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cx = Math.round((200 - (vec.x - 4)) * 2); // circle centre, in crop pixels (crop pads 4pt)
  const cy = Math.round((290 - (vec.y - 4)) * 2);
  let labelInk = 0;
  for (let yy = Math.max(0, cy - 30); yy < Math.min(info.height, cy + 30); yy++) {
    for (let xx = Math.max(0, cx - 35); xx < Math.min(info.width, cx + 35); xx++) {
      const i = (yy * info.width + xx) * info.channels;
      if (labelData[i] < 128 && labelData[i + 1] < 128 && labelData[i + 2] < 128) labelInk++;
    }
  }
  assert.ok(labelInk > 20, `the SUN label is drawn (labelInk=${labelInk})`);
});

test('figureSummary says what happened to the figures', () => {
  assert.equal(figureSummary(null), '', 'no diagnostics, no sentence');
  assert.equal(figureSummary({}), '', 'diagnostics without figures, no sentence');

  const found = figureSummary({ figures: { pages: 17, kept: 3, candidates: { raster: 4, vector: 9 }, dropped: { tooSmall: 10 } } });
  assert.match(found, /Found 3 images or diagrams across 17 pages/);
  assert.match(found, /attached each to its question/);

  const empty = figureSummary({ figures: { pages: 17, kept: 0, candidates: { raster: 0, vector: 0 }, dropped: {} } });
  assert.match(empty, /No images or diagrams were found in this PDF \(17 pages scanned\)/);
  assert.ok(!/rejected/.test(empty), 'a paper with no figures is not blamed on a filter');

  const rejected = figureSummary({ figures: { pages: 17, kept: 0, candidates: { raster: 0, vector: 102 }, dropped: { tooSmall: 68, repeatingOrnament: 34 } } });
  assert.match(rejected, /found 102 candidates, all rejected/);
  assert.match(rejected, /68 too small to be a figure/);
  assert.match(rejected, /34 page decorations repeated on several pages/);

  const one = figureSummary({ figures: { pages: 1, kept: 1, candidates: { raster: 0, vector: 6 }, dropped: {} } });
  assert.match(one, /Found 1 image or diagram across 1 page and attached each/);
});
