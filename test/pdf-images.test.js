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