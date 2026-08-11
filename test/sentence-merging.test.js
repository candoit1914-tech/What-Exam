'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const pdf = require('../src/services/pdf');
const PDFDocument = require('pdfkit');
const { createCanvas } = require('@napi-rs/canvas');

// Create a simple test PDF with sentence-split lines
function createSplitSentencePdf() {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    
    // This line should be merged with the next line
    doc.fontSize(12).text('What is the capital');
    doc.text('of Ghana?');
    doc.text('');
    
    // This line should NOT be merged (starts with capital after sentence)
    doc.text('The capital is Accra.');
    doc.text('Which city is the largest?');
    doc.text('');
    
    // This line should NOT be merged (looks like an option)
    doc.text('A. Accra');
    doc.text('B. Kumasi');
    doc.text('');
    
    // This line should NOT be merged (looks like a numbered item)
    doc.text('1. What is');
    doc.text('2. Where is');
    
    doc.end();
  });
}

test('sentence merging joins split sentences correctly', async () => {
  const buffer = await createSplitSentencePdf();
  const text = await pdf.extractText(buffer);
  
  // Verify the split sentence was merged
  assert.ok(text.includes('What is the capital of Ghana?'), 
    'Split sentence should be merged: "What is the capital of Ghana?"');
  
  // Verify sentences with proper punctuation are NOT merged
  assert.ok(text.includes('The capital is Accra.'), 
    'Complete sentence should stay separate');
  assert.ok(text.includes('Which city is the largest?'), 
    'Sentence starting with capital should stay separate');
  
  // Verify options are NOT merged
  assert.ok(text.includes('A. Accra'), 
    'Option A should stay separate');
  assert.ok(text.includes('B. Kumasi'), 
    'Option B should stay separate');
  
  // Verify numbered items are NOT merged
  assert.ok(text.includes('1. What is'), 
    'Numbered item 1 should stay separate');
  assert.ok(text.includes('2. Where is'), 
    'Numbered item 2 should stay separate');
});

test('sentence merging handles continuation lines', async () => {
  const buffer = await createSplitSentencePdf();
  const { text } = await pdf.extractDocument(buffer);
  
  // The first two lines should be merged
  const lines = text.split('\n');
  const firstLine = lines[0];
  
  // First line should contain the merged sentence
  assert.ok(firstLine.includes('capital') && firstLine.includes('Ghana'),
    'First line should contain the merged sentence parts');
});

test('textWithMarkers preserves sentence merging', async () => {
  const buffer = await createSplitSentencePdf();
  const { text } = await pdf.textWithMarkers(buffer);
  
  // Even with markers, the sentence should be merged
  assert.ok(text.includes('capital of Ghana'),
    'textWithMarkers should also merge split sentences');
});
