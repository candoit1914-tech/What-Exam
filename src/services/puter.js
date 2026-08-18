const fs = require('fs');
const path = require('path');
const config = require('../config');

let puter = null;

function initPuter() {
  if (puter) return puter;
  if (!config.puter?.apiKey) return null;
  try {
    const { PuterClient } = require('@heyputer/puter.js');
    puter = new PuterClient({ apiKey: config.puter.apiKey });
    console.log('[puter] Puter.js initialized');
  } catch (err) {
    console.warn('[puter] Failed to initialize:', err.message);
    puter = null;
  }
  return puter;
}

function isConfigured() {
  return !!(config.puter?.apiKey);
}

/**
 * Read a handwritten photo answer using Puter.js vision (GPT-4o-mini).
 * GPT-4o-mini supports vision natively, so this should work reliably.
 */
async function readPhotoAnswer(imagePath, questionText) {
  if (!isConfigured()) throw new Error('Puter.js not configured');
  const client = initPuter();
  if (!client) throw new Error('Puter.js initialization failed');

  const uploadsDir = config.uploadsDir;
  const fullPath = path.isAbsolute(imagePath) ? imagePath : path.join(uploadsDir, imagePath);
  if (!fs.existsSync(fullPath)) throw new Error(`Image not found: ${imagePath}`);

  const imageBuffer = fs.readFileSync(fullPath);
  const ext = path.extname(fullPath).toLowerCase().replace('.', '');
  const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const base64 = imageBuffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const prompt = `Read EXACTLY what is written in this photo of a student's exam answer.

Question: ${questionText}

RULES:
- Return ONLY the student's actual answer text as written
- Do NOT correct spelling or grammar
- Do NOT summarize or paraphrase
- Do NOT add any explanation or prefix
- If the handwriting is unclear, transcribe what you can read and mark unclear parts with [?]
- If it's a drawing/diagram, describe what you see
- If you cannot read anything, return exactly: [unreadable]`;

  console.log(`[puter] Reading photo answer with vision...`);
  const response = await client.ai.chat(prompt, dataUrl, {
    model: 'gpt-4o-mini',
    temperature: 0.1,
  });

  const text = typeof response === 'string' ? response : response?.message?.content || '';
  console.log(`[puter] Photo read: "${text.slice(0, 150)}..."`);
  return text.trim();
}

/**
 * Fast AI chat via Puter.js (used for question generation).
 */
async function chat(prompt, options = {}) {
  if (!isConfigured()) return null;
  const client = initPuter();
  if (!client) return null;
  try {
    const response = await client.ai.chat(prompt, {
      model: options.model || 'gpt-4o-mini',
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens || 2000,
    });
    return typeof response === 'string' ? response : response?.message?.content || '';
  } catch (err) {
    console.error('[puter] Chat failed:', err.message);
    return null;
  }
}

module.exports = { initPuter, isConfigured, readPhotoAnswer, chat };
