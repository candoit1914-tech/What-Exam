'use strict';
require('./helpers/isolate');

// The production chain this file pins, end to end, with NOTHING stubbed but
// fetch: a scanned-in diagram the geometric page scan cannot assemble → the
// paid OpenAI account is asked (real chatJSON, real locateFigures, real
// HTTP shape) → its box survives the ink check (real recoverFiguresWithVision)
// → the box is rendered into a real PNG file on disk (real renderVectorRegion)
// — the exact file WhatsApp would send above the question.
//
// Every earlier vision test stubs locateFigures at the boundary, so a break
// anywhere INSIDE the real chain (request shape, response parsing, provider
// order, unit conversion, the crop) passed them all. The deployment this
// mirrors: AshnaAI gateway out of credit (answers500), a working paid
// OPENAI_API_KEY, AI_VISION=true.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');

const config = require('../src/config');
const ai = require('../src/services/ai');
const pdf = require('../src/services/pdf');
const pdfImport = require('../src/services/pdfImport');

function collectPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

// The same shape as the unit-level fixtures: a drawing under the geometric
// scanner's size floor, and page text that tells the student to study it.
async function scannedDiagramPdf() {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.fontSize(12).text('1. Study the diagram above. The shape shows');
  doc.fontSize(11).text('A. a cycle   B. a graph   C. a table   D. a scale');
  doc.moveDown(0.5);
  doc.lineWidth(2).strokeColor('#000');
  doc.rect(150, 300, 60, 60).stroke();
  doc.moveTo(150, 300).lineTo(210, 360).stroke();
  doc.moveTo(210, 300).lineTo(150, 360).stroke();
  doc.fontSize(12).text('2. Which label fits the diagram?', 50, 400);
  doc.fontSize(11).text('A. AXIS   B. NODE   C. KEY   D. LEGEND', 50, 420);
  doc.end();
  return collectPdf(doc);
}

// Read PNG width/height straight out of the IHDR — the same way the import
// does it — so the "model" answers in the exact units of the page it was sent.
function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const saved = { fetch: global.fetch, vision: config.ai.vision, openai: config.openai, ai: { ...config.ai } };
const files = [];
afterEach(async () => {
  global.fetch = saved.fetch;
  config.ai.vision = saved.vision;
  config.openai = saved.openai;
  config.ai.baseUrl = saved.ai.baseUrl;
  config.ai.apiKey = saved.ai.apiKey;
  config.ai.model = saved.ai.model;
  ai.resetCircuitBreakers();
  for (const f of files.splice(0)) {
    try { fs.unlinkSync(f); } catch { /* best effort */ }
  }
});

/** Mirror the deployment: gateway present but dead, paid OpenAI key working. */
function productionConfig() {
  ai.resetCircuitBreakers();
  config.openai = {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-live-openai-test',
    model: 'gpt-4o-mini',
    visionModel: 'gpt-4o-mini',
  };
  config.ai.baseUrl = 'https://api.ashna.ai/v1/api';
  config.ai.apiKey = 'gateway-chat-key';
  config.ai.model = 'gpt-5-mini';
  config.ai.vision = true;
}

test('a dead gateway and a paid OpenAI key: the scanned diagram reaches the question as a real file', async () => {
  productionConfig();
  const buf = await scannedDiagramPdf();
  const sourceText = await pdf.textWithMarkers(buf);
  assert.equal(sourceText.images.length, 0, 'the page scan found nothing to assemble — the production case');

  // A stand-in for the OpenAI vision API: it DECODES the page image actually
  // sent in the request and answers with a tight box over the drawing, the
  // way a real vision model reading the page would. The dead gateway answers
  // 500 — and being asked at all is itself a failure here, because figure
  // vision must lead with the paid account.
  const calls = [];
  global.fetch = async (url, init) => {
    const u = String(url);
    const body = init && init.body ? JSON.parse(init.body) : {};
    calls.push({ url: u, body });
    if (u.startsWith('https://api.ashna.ai/')) {
      return { ok: false, status: 500, text: async () => 'upstream exploded', json: async () => ({}) };
    }
    // "Look" at the page image in the request: pull the PNG out of the
    // data URL and find the inked drawing on it.
    const content = body.messages[1].content;
    const imageItem = content.find((c) => c.type === 'image_url');
    assert.ok(imageItem, 'the page image is part of the request');
    assert.ok(imageItem.image_url.url.startsWith('data:image/png;base64,'), 'as an OpenAI data URL');
    const pagePng = Buffer.from(imageItem.image_url.url.split(',')[1], 'base64');
    const size = pngSize(pagePng);
    assert.ok(size.width > 500 && size.height > 700, 'a full A4 page was rendered for the model');
    // The drawing sits at (150, 300)-(210, 360) in page points; answer in
    // fractions of the page, exactly as the prompt asks.
    const reply = JSON.stringify({
      figures: [{ x: 150 / size.width, y: 300 / size.height, w: 60 / size.width, h: 60 / size.height }],
    });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: reply } }] }) };
  };

  const added = await pdfImport.recoverFiguresWithVision(buf, sourceText);

  // 1. The paid account was asked — first, alone, on the vision model.
  assert.equal(added, 1, 'the diagram was recovered through the real HTTP chain');
  assert.equal(calls.length, 1, 'exactly one provider was billed for the page');
  assert.match(calls[0].url, /api\.openai\.com\/v1\/chat\/completions/, 'the paid OpenAI account answered it');
  assert.equal(calls[0].body.model, 'gpt-4o-mini', 'on the vision model');
  const sentText = calls[0].body.messages[1].content.find((c) => c.type === 'text').text;
  assert.ok(/figures/.test(sentText), 'asked to point at figures, in the documented shape');

  // 2. The box is on the drawing, in page pixels, attached to the question
  //    that asked for it — units converted, markers placed.
  const fig = sourceText.images[0];
  assert.equal(fig.kind, 'vector');
  assert.equal(fig.page, 1);
  assert.ok(Math.abs(fig.x - 150) <= 2 && Math.abs(fig.y - 300) <= 2,
    `box anchored at the drawing's real position, not ${fig.x},${fig.y}`);
  assert.ok(fig.w >= 50 && fig.h >= 50, `box covers the drawing (${fig.w}x${fig.h})`);
  const lines = sourceText.text.split('\n');
  const at = lines.indexOf('[IMG:0]');
  assert.ok(at > 0 && lines[at - 1].includes('Study the diagram above'), 'the marker sits inside the question that asked');

  // 3. The rescued box renders to a REAL, non-blank PNG — the file WhatsApp
  //    would send above the question number. This is the hop every stubbed
  //    test skipped: a box that parses but crops to nothing still leaves the
  //    student answering blind.
  const dest = path.join(config.uploadsDir, `e2e-vision-figure-${process.pid}.png`);
  files.push(dest);
  await pdf.renderVectorRegion(buf, fig, dest);
  const png = fs.readFileSync(dest);
  assert.equal(png.readUInt32BE(0), 0x89504e47, 'a real PNG file');
  const { data } = await require('sharp')(png)
    .flatten({ background: '#ffffff' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let inked = 0;
  for (let i = 0; i < data.length; i++) if (data[i] < 245) inked++;
  assert.ok(inked / data.length > 0.01, `the figure file has visible ink (${(100 * inked / data.length).toFixed(1)}%), not a blank crop`);
});

test('a broken paid account falls back to the gateway instead of losing the figure silently', async () => {
  productionConfig();
  const buf = await scannedDiagramPdf();
  const sourceText = await pdf.textWithMarkers(buf);

  const calls = [];
  global.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith('https://api.openai.com/')) {
      return { ok: false, status: 401, text: async () => 'invalid api key', json: async () => ({}) };
    }
    // The gateway, unlike in the previous test, CAN see.
    const reply = JSON.stringify({ figures: [{ x: 0.25, y: 0.36, w: 0.1, h: 0.07 }] });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: reply } }] }) };
  };

  const added = await pdfImport.recoverFiguresWithVision(buf, sourceText);

  assert.equal(added, 1, 'the figure is still rescued when the paid key is wrong — vision is not one account’s gift');
  const firstGatewayAt = calls.findIndex((u) => u.includes('ashna.ai'));
  assert.ok(firstGatewayAt >= 1, 'the gateway was reached only after the paid account failed');
  assert.ok(
    calls.slice(0, firstGatewayAt).every((u) => u.includes('api.openai.com')),
    'every call before it went to the paid account — it is always asked first, and its retries never leave the account'
  );
  assert.equal(sourceText.images.length, 1);
});
