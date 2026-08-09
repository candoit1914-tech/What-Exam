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