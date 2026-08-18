const fs = require('fs');
const path = require('path');
const config = require('../config');

let worker = null;

/**
 * Get or create a Tesseract.js worker for OCR.
 * Reuses the same worker across calls (language data stays loaded).
 */
async function getWorker() {
  if (worker) return worker;
  const Tesseract = require('tesseract.js');
  console.log('[ocr] Starting Tesseract.js worker...');
  worker = await Tesseract.createWorker('eng', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text') {
        // silent during recognition
      }
    },
  });
  console.log('[ocr] Tesseract.js worker ready');
  return worker;
}

/**
 * Read text from an image using local OCR (Tesseract.js).
 * No API key needed — works offline.
 */
async function readPhotoAnswer(imagePath, questionText = '') {
  const uploadsDir = config.uploadsDir;
  const fullPath = path.isAbsolute(imagePath) ? imagePath : path.join(uploadsDir, imagePath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Image file not found: ${imagePath}`);
  }

  try {
    const w = await getWorker();
    console.log(`[ocr] Reading image: ${imagePath}`);

    const { data: { text, confidence } } = await w.recognize(fullPath);

    const cleaned = text.trim().replace(/\n{3,}/g, '\n\n');
    console.log(`[ocr] Read ${cleaned.length} chars (confidence: ${Math.round(confidence)}%)`);
    console.log(`[ocr] Text: "${cleaned.slice(0, 200)}..."`);

    if (!cleaned || cleaned.length < 2) {
      return { success: false, text: '[unreadable]', confidence: 0 };
    }

    return { success: true, text: cleaned, confidence };
  } catch (err) {
    console.error('[ocr] Read failed:', err.message);
    return { success: false, text: '', confidence: 0, error: err.message };
  }
}

/**
 * Terminate the worker (call on shutdown).
 */
async function terminate() {
  if (worker) {
    await worker.terminate();
    worker = null;
    console.log('[ocr] Worker terminated');
  }
}

module.exports = { readPhotoAnswer, terminate };
