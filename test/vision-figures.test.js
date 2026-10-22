'use strict';
require('./helpers/isolate');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const PDFDocument = require('pdfkit');
const config = require('../src/config');
const aiMod = require('../src/services/ai');
const pdf = require('../src/services/pdf');
const pdfImport = require('../src/services/pdfImport');

// AshnaAI is asked for a figure only when the page scanner came back empty
// about a page whose own text says "study the diagram above". These tests hold
// that bargain: the model points, the import validates, and nothing that fails
// the check is ever attached to a question.

function collectPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

// A drawing small enough that the geometric size floor (1.5% of the page)
// rejects it — 60x60pt is 0.72% of A4 — while a vision box over it is still
// large enough to pass. That gap is what makes this fixture test the rescue
// rather than the scanner.
async function missingFigurePdf() {
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

// A page whose figure the scanner DOES find — vision must stay out of it.
async function foundFigurePdf() {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.fontSize(12).text('1. Study the diagram above. It shows');
  doc.fontSize(11).text('A. this   B. that   C. other   D. none');
  doc.lineWidth(2).strokeColor('#000');
  doc.rect(120, 300, 320, 200).stroke(); // 13% of the page: kept
  doc.end();
  return collectPdf(doc);
}

const orig = {};
before(() => {
  orig.vision = config.ai.vision;
  orig.apiKey = config.ai.apiKey;
  orig.openaiKey = config.openai.apiKey;
  orig.aiConfigured = aiMod.aiConfigured;
  orig.locateFigures = aiMod.locateFigures;
  orig.chatJSON = aiMod.chatJSON;
  config.ai.vision = true;
  // locateFigures reads the config through the internal aiConfigured(): give it
  // a key so the gates under test are the ones this file means to exercise
  // (vision off / model failing), not "no provider at all". The paid OpenAI
  // key is pinned OFF for the same reason — the cases below are about the chat
  // provider, and one test turns the paid key on for itself.
  config.ai.apiKey = 'test-key';
  config.openai.apiKey = '';
  aiMod.aiConfigured = () => true;
});
after(() => {
  config.ai.vision = orig.vision;
  config.ai.apiKey = orig.apiKey;
  config.openai.apiKey = orig.openaiKey;
  aiMod.aiConfigured = orig.aiConfigured;
  aiMod.locateFigures = orig.locateFigures;
  aiMod.chatJSON = orig.chatJSON;
});

test('the scanner finds nothing on the fixture, as the rescue assumes', async () => {
  const buf = await missingFigurePdf();
  const sourceText = await pdf.textWithMarkers(buf);
  assert.equal(sourceText.images.length, 0, 'the 0.7% drawing is under the figure floor');
  assert.equal(sourceText.markers.length, 0);
  assert.ok(sourceText.text.includes('Study the diagram above'), 'the text still points at a figure');
  assert.match(pdfImport.figureSummary(sourceText.diagnostics), /No images or diagrams were attached/);
  assert.equal(typeof pdfImport.recoverFiguresWithVision, 'function', 'exported for the import pipeline');
});

test('a vision box over a real figure becomes a marker inside the question that asked for it', async () => {
  const buf = await missingFigurePdf();
  const sourceText = await pdf.textWithMarkers(buf);
  const calls = [];
  aiMod.locateFigures = async (args) => { calls.push(args); return [{ x: 150, y: 300, w: 60, h: 60 }]; };

  const added = await pdfImport.recoverFiguresWithVision(buf, sourceText);
  assert.equal(added, 1, 'one figure recovered');
  assert.equal(calls.length, 1, 'vision asked once, for the one page');
  assert.ok(calls[0].hint.includes('Study the diagram above'), 'the model is told what the page says');
  assert.ok(calls[0].imageBase64.length > 1000, 'the model is sent the page image');

  assert.equal(sourceText.images.length, 1);
  assert.equal(sourceText.images[0].kind, 'vector', 'cropped like any other region');
  assert.equal(sourceText.images[0].page, 1);
  assert.deepEqual(sourceText.markers, [{ idx: 0, page: 1 }]);

  const lines = sourceText.text.split('\n');
  const at = lines.indexOf('[IMG:0]');
  assert.ok(at > 0, 'marker present');
  assert.ok(lines[at - 1].includes('Study the diagram above'), 'marker directly after the referring row');
  assert.ok(at < lines.findIndex((l) => l.startsWith('2.')), 'marker stays inside question 1');

  assert.equal(sourceText.diagnostics.figures.visionRecovered, 1, 'the count is reported');
  assert.equal(sourceText.diagnostics.figures.kept, 1);
  assert.match(pdfImport.figureSummary(sourceText.diagnostics), /Found 1 image or diagram/);
  assert.match(pdfImport.figureSummary(sourceText.diagnostics), /located by the AI reading the page image/);
});

test('a box over blank paper is not attached, however the model answered', async () => {
  const buf = await missingFigurePdf();
  const sourceText = await pdf.textWithMarkers(buf);
  aiMod.locateFigures = async () => [{ x: 400, y: 620, w: 90, h: 90 }]; // empty margin

  const added = await pdfImport.recoverFiguresWithVision(buf, sourceText);
  assert.equal(added, 0, 'blank crop rejected by the ink check');
  assert.equal(sourceText.images.length, 0, 'nothing attached');
  assert.ok(!sourceText.text.includes('[IMG:'), 'no stray marker');
});

test('a page that already has its figure is never sent to the vision model', async () => {
  const buf = await foundFigurePdf();
  const sourceText = await pdf.textWithMarkers(buf);
  assert.equal(sourceText.images.length, 1, 'the scanner found this one');
  let calls = 0;
  aiMod.locateFigures = async () => { calls++; return [{ x: 120, y: 300, w: 320, h: 200 }]; };

  const added = await pdfImport.recoverFiguresWithVision(buf, sourceText);
  assert.equal(calls, 0, 'no vision call when the page already yielded a figure');
  assert.equal(added, 0);
  assert.equal(sourceText.images.length, 1, 'and the found figure is untouched');
  assert.equal(sourceText.markers.length, 1, 'with its original marker');
});

test('a vision failure never breaks the import', async () => {
  const buf = await missingFigurePdf();
  const sourceText = await pdf.textWithMarkers(buf);
  aiMod.locateFigures = async () => { throw new Error('provider down'); };

  const added = await pdfImport.recoverFiguresWithVision(buf, sourceText);
  assert.equal(added, 0, 'reported as nothing recovered');
  assert.equal(sourceText.images.length, 0);
  assert.ok(sourceText.text.includes('1. Study'), 'text untouched');
});

test('locateFigures refuses when vision is off, and never throws when the model does', async () => {
  // Each test swaps locateFigures for its own stub; put the real one back so
  // this exercises the real gate rather than the previous test's stub.
  aiMod.locateFigures = orig.locateFigures;
  let chatCalls = 0;
  aiMod.chatJSON = async () => { chatCalls++; return { figures: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] }; };

  config.ai.vision = false;
  assert.deepEqual(await aiMod.locateFigures({ imageBase64: 'x', pageWidth: 600, pageHeight: 800 }), []);
  assert.equal(chatCalls, 0, 'no call without vision enabled');

  config.ai.vision = true;
  aiMod.chatJSON = async () => { throw new Error('no vision on this model'); };
  assert.deepEqual(await aiMod.locateFigures({ imageBase64: 'x', pageWidth: 600, pageHeight: 800 }), []);
  assert.ok(true, 'a failing model returns [] rather than throwing');
  assert.equal((await aiMod.locateFigures({ imageBase64: '', pageWidth: 600, pageHeight: 800 })).length, 0, 'no image, no call');
});

test('locateFigures converts units and throws away boxes that are not figures', async () => {
  aiMod.locateFigures = orig.locateFigures;
  let seenMessages = null;
  aiMod.chatJSON = async (messages) => {
    seenMessages = messages;
    return {
      figures: [
        { x: 0.25, y: 0.5, w: 0.4, h: 0.1 }, // fractions → pixels
        { x: 150, y: 300, w: 60, h: 60 },     // already pixels
        { x: 0, y: 0, w: 1, h: 1 },           // the whole page: not a figure
        { x: 0.5, y: 0.5, w: 0.004, h: 0.004 }, // a few pixels: not a figure
        { x: 'left', y: 0, w: 0.2, h: 0.2 },  // nonsense
      ],
    };
  };
  const boxes = await aiMod.locateFigures({ imageBase64: 'AAA', pageWidth: 600, pageHeight: 800, hint: 'study the diagram above' });

  assert.equal(boxes.length, 2, 'the whole page and the fleck are rejected');
  assert.deepEqual(boxes[0], { x: 150, y: 400, w: 240, h: 80 }, 'fractions scaled to page pixels');
  assert.deepEqual(boxes[1], { x: 150, y: 300, w: 60, h: 60 }, 'pixel answers pass through');

  const user = seenMessages[1].content;
  assert.equal(user[0].type, 'text');
  assert.equal(user[1].type, 'image_url', 'the page image rides along');
  assert.ok(user[1].image_url.url.startsWith('data:image/png;base64,'));
  assert.ok(user[0].text.includes('study the diagram above'), 'the hint is included');
  assert.ok(user[0].text.includes('"figures"'), 'the answer shape is spelled out');
});

// ── coverage: every page, and the account that can actually see ────────

/**
 * `pages` pages, each naming its OWN figure (so each anchor is findable) and
 * each drawing under the scanner's size floor — the shape of a real paper whose
 * diagrams the geometric pass cannot assemble.
 */
async function manyMissingFigurePdf(pages) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  for (let p = 1; p <= pages; p++) {
    if (p > 1) doc.addPage();
    doc.fontSize(12).text(`${p}. Study the diagram above on page ${p}. The shape shows`);
    doc.fontSize(11).text('A. a cycle   B. a graph   C. a table   D. a scale');
    doc.moveDown(0.5);
    doc.lineWidth(2).strokeColor('#000');
    doc.rect(150, 300, 60, 60).stroke();
    doc.moveTo(150, 300).lineTo(210, 360).stroke();
    doc.moveTo(210, 300).lineTo(150, 360).stroke();
  }
  doc.end();
  return collectPdf(doc);
}

test('every page that asks for a figure gets its own vision pass, however many there are', async () => {
  // The rescue used to stop after three pages. A paper whose diagrams live on
  // pages 1, 4, 5, 9 and 12 therefore lost the ones past the cap, and every
  // question under them reached WhatsApp with no figure above it.
  const buf = await manyMissingFigurePdf(5);
  const sourceText = await pdf.textWithMarkers(buf);
  assert.equal(sourceText.images.length, 0, 'the 0.7% drawings stay under the scanner floor on every page');

  const hints = [];
  aiMod.locateFigures = async ({ hint }) => { hints.push(String(hint)); return [{ x: 150, y: 300, w: 60, h: 60 }]; };

  const added = await pdfImport.recoverFiguresWithVision(buf, sourceText);

  assert.equal(added, 5, 'all five pages are rescued — no cap silently skips the diagrams past the third page');
  assert.equal(hints.length, 5, 'vision was asked exactly once per page that needed it');
  for (let p = 1; p <= 5; p++) {
    assert.ok(hints.some((h) => h.includes(`on page ${p}`)), `page ${p} was asked about its own figure`);
  }
  assert.deepEqual(
    sourceText.markers.map((m) => m.page),
    [1, 2, 3, 4, 5],
    'the figures attach in page order, whatever order the answers came back in'
  );
  assert.equal(sourceText.images.length, 5, 'and each one is on the page it was found on');
});

test('a paid OpenAI key alone turns figure vision on, and is asked first', async () => {
  // No chat gateway at all: OPENAI_API_KEY on its own. The gate used to be the
  // chat primary's to give, so vision stayed off there while the paid credit
  // sat unused — and the call that did go out never named the paid model.
  aiMod.locateFigures = orig.locateFigures;
  const saved = {
    aiKey: config.ai.apiKey,
    aiBase: config.ai.baseUrl,
    openaiKey: config.openai.apiKey,
    chatJSON: aiMod.chatJSON,
  };
  const asks = [];
  try {
    config.ai.apiKey = '';
    config.ai.baseUrl = '';
    config.openai.apiKey = 'sk-paid-platform-test';
    config.ai.vision = true;
    aiMod.chatJSON = async (messages, opts) => { asks.push(opts || {}); return { figures: [] }; };

    await aiMod.locateFigures({ imageBase64: 'AAA', pageWidth: 600, pageHeight: 800, hint: 'study the diagram' });

    assert.equal(asks.length, 1, 'the gate opens on the paid key alone — vision is not the chat primary\'s to grant');
    assert.equal(asks[0].prefer, 'openai', 'and the paid account, on its vision model, is the one asked first');
  } finally {
    config.ai.apiKey = saved.aiKey;
    config.ai.baseUrl = saved.aiBase;
    config.openai.apiKey = saved.openaiKey;
    aiMod.chatJSON = saved.chatJSON;
  }
});
