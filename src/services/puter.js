const config = require('../config');

let puter = null;

/**
 * Initialize Puter.js client for fast question generation.
 * Photo reading is handled by ai.readPhotoAnswer() instead.
 */
function initPuter() {
  if (puter) return puter;
  if (!config.puter?.apiKey) return null;
  try {
    const { PuterClient } = require('@heyputer/puter.js');
    puter = new PuterClient({ apiKey: config.puter.apiKey });
    console.log('[puter] Puter.js initialized for question generation');
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
 * Fast AI chat via Puter.js (used for question generation, not photo reading).
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

module.exports = { initPuter, isConfigured, chat };
