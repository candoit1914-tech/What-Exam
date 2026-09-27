'use strict';

// A scanned PDF reported "No questions could be parsed from this PDF. The
// document may not contain exam questions in a recognizable format."
//
// That message blamed the user's document, but the document was fine. A scan
// carries a small stray text layer - a page number, a running header, a
// watermark, a scan stamp - and the OCR fallback only triggered on text that
// was COMPLETELY empty. So a scan that produced a few dozen junk characters
// skipped OCR entirely, yielded zero question blocks, and failed with a
// message pointing at the file instead of at the extractor.
//
// These tests pin the three layers involved: the OCR quality gate, the warning
// the extractor emits when there is nothing to read, and the message the user
// actually sees.
require('./helpers/isolate');

const test = require('node:test');
const assert = require('node:assert/strict');

const ai = require('../src/services/ai');
const pdf = require('../src/services/pdf');
const pdfImport = require('../src/services/pdfImport');

test('a stray text layer on a scanned document is treated as no text layer', () => {
  // 17 pages, ~40 characters of header/page-number junk.
  assert.equal(
    pdf.needsOcrFallback('Biology 2026  1  2  3', 17),
    true,
    'a few characters across many pages means the text layer is not real text'
  );
});

test('a genuine text document is left alone', () => {
  const real = 'Choose the correct answer from the options below. '.repeat(400);
  assert.equal(pdf.needsOcrFallback(real, 17), false);
});

test('a short but real text document is not dragged into OCR', () => {
  // Under the per-page character threshold, but full of real words. This is a
  // real one-page question sheet: ~120 characters of genuine text. Character
  // count alone would send it to OCR, which then approximates the real text
  // instead of reading it - a regression that broke sentence merging.
  const oneRealPage = [
    'What is the capital',
    'of Ghana?',
    'The capital is Accra.',
    'Which city is the largest?',
    'A. Accra',
    'B. Kumasi',
    '1. What is',
    '2. Where is',
  ].join(' ');
  assert.ok(oneRealPage.length < 200, 'fixture must stay under the char threshold');
  assert.equal(pdf.needsOcrFallback(oneRealPage, 1), false);
});

test('a scan whose text layer is all page numbers still needs OCR', () => {
  // The reported failure: a scan that produced page numbers and a running
  // header. No real words, so nothing was extractable without OCR.
  const stray = 'Biology 2026 1 2 3 '.repeat(4);
  assert.equal(pdf.needsOcrFallback(stray, 17), true);
});

test('a repeated running header on every page still needs OCR', () => {
  // A denser stray layer than bare page numbers, and the case a plain
  // character or word count misses: 544 characters and 51 words across 17
  // pages, but it is the same three words repeated on every page. No real text
  // layer looks like that.
  const headerPerPage = 'Advanced Level Examination 2026 ';
  assert.equal(pdf.needsOcrFallback(headerPerPage.repeat(17), 17), true);
});

test('a short page of mostly symbols keeps its text layer', () => {
  // Real text that carries almost no words: a math stem, an image marker and
  // four options. OCR-ing this destroys the stacked-fraction math markers and
  // breaks sentence merging. Two real words with two distinct spellings is
  // still varied text, not a dead layer.
  const imageQuestion = '1. Simplify: [IMG:0] A. 4x^2 B. 2x^2 C. 4x D. 2x';
  assert.ok(imageQuestion.length < 200, 'fixture must stay under the char threshold');
  assert.equal(pdf.needsOcrFallback(imageQuestion, 1), false);
});

test('a math-heavy page with a real text layer is not OCR-ed', () => {
  // Real text that is mostly symbols: 6 real words, well under any per-page
  // character threshold. OCR-ing this destroys the stacked-fraction math
  // markers and returns 0 expressions.
  const mathPage = '1. Arrange the following: 3 4 , 0.8, 1 2, 0.65 in descending order.';
  assert.ok(mathPage.length < 200, 'fixture must stay under the char threshold');
  assert.equal(pdf.needsOcrFallback(mathPage, 1), false);
});

test('completely empty text always needs OCR', () => {
  assert.equal(pdf.needsOcrFallback('', 17), true);
  assert.equal(pdf.needsOcrFallback('   \n  ', 17), true);
});

test('an unreadable PDF reports WHY instead of blaming the document', async () => {
  const warnings = [];
  const out = await ai.extractQuestionsFromText('', null, (w) => warnings.push(w));
  assert.deepEqual(out, []);
  assert.equal(warnings.length, 1, 'the unreadable-text case must report a reason');
  assert.match(warnings[0], /text/i);
});

test('an unreadable PDF is not blamed on a provider timeout', async () => {
  // End to end: the real empty-text path emits its own warning, so
  // `describeExtractionFailure` receives BOTH an empty text and a blockWarning.
  // The timeout wording used to win, telling the user their provider was too
  // slow when the truth was that nothing could be read off the page.
  const warnings = [];
  await ai.extractQuestionsFromText('', null, (w) => warnings.push(w));
  assert.equal(warnings.length, 1);

  const reported = pdfImport.describeExtractionFailure({
    text: '',
    isOcr: false,
    blockWarning: warnings[0],
  });
  assert.doesNotMatch(reported, /did not answer in time/i);
  assert.doesNotMatch(reported, /may not contain exam questions/i);
  assert.match(reported, /text|scan|OCR/i);
});

test('the failure message names unreadable text, not a missing question format', () => {
  // Nothing readable at all - the scan defeated text extraction. Telling the
  // user their document "may not contain exam questions" sends them to
  // re-check a file that is perfectly fine.
  const unreadable = pdfImport.describeExtractionFailure({
    text: '',
    isOcr: false,
    blockWarning: '',
  });
  assert.doesNotMatch(unreadable, /may not contain exam questions/i);
  assert.match(unreadable, /text|scan|OCR/i);

  // OCR ran but the scan was too poor to read.
  const blurryScan = pdfImport.describeExtractionFailure({
    text: '',
    isOcr: true,
    blockWarning: '',
  });
  assert.doesNotMatch(blurryScan, /may not contain exam questions/i);
  assert.match(blurryScan, /scan|OCR|clearer/i);
});

test('a text document with no recognisable questions still gets the format message', () => {
  // This is the one case where blaming the document's format is correct: there
  // was plenty of readable text, it just was not an exam paper.
  const msg = pdfImport.describeExtractionFailure({
    text: 'A full page of prose that is clearly readable.',
    isOcr: false,
    blockWarning: '',
  });
  assert.match(msg, /may not contain exam questions|recognizable format/i);
});

test('a provider that answered too slowly is reported as such', () => {
  const msg = pdfImport.describeExtractionFailure({
    text: 'Question 1 ...',
    isOcr: false,
    blockWarning: '2 question block(s) could not be parsed',
  });
  assert.match(msg, /2 question block\(s\)/);
  assert.match(msg, /did not answer in time|AI_BLOCK_TIMEOUT_MS/);
});
