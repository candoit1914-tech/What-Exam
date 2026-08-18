const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * Puter.js service — uses REST API directly (not the browser SDK).
 * Requires PUTER_API_KEY environment variable.
 */

function isConfigured() {
  return !!process.env.PUTER_API_KEY;
}

/**
 * Call Puter.js AI chat API directly via REST.
 * Supports both text and image (base64 data URL) inputs.
 */
async function puterChat(messages, options = {}) {
  const apiKey = process.env.PUTER_API_KEY;
  if (!apiKey) throw new Error('PUTER_API_KEY not set');

  const body = {
    model: options.model || 'gpt-4o-mini',
    messages,
    temperature: options.temperature ?? 0.1,
    max_tokens: options.maxTokens || 2000,
  };

  console.log(`[puter] Calling Puter.js API with model=${body.model}...`);

  const resp = await fetch('https://api.puter.com/v1/ai/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Puter.js API ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || '';
  console.log(`[puter] API response: ${content.slice(0, 150)}...`);
  return content;
}

/**
 * Read a handwritten photo answer using Puter.js vision.
 * Sends the image to GPT-4o-mini and gets back the transcribed text.
 */
async function readPhotoAnswer(imagePath, questionText, questionType = 'theory') {
  if (!isConfigured()) {
    return { success: false, error: 'Puter.js not configured (no PUTER_API_KEY)' };
  }

  try {
    const fullPath = path.isAbsolute(imagePath) ? imagePath : path.join(config.uploadsDir, imagePath);
    if (!fs.existsSync(fullPath)) {
      return { success: false, error: `Image file not found: ${imagePath}` };
    }

    const imageBuffer = fs.readFileSync(fullPath);
    const ext = path.extname(fullPath).toLowerCase().replace('.', '');
    const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    const base64 = imageBuffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64}`;

    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `You are an exam answer reader. A student has written or drawn their answer to an exam question on paper and took a photo.

Question: ${questionText}

TASK: Read EXACTLY what is written in this photo. Transcribe the student's handwritten answer word-for-word, preserving their exact wording, spelling, and grammar — even if it contains errors.

RULES:
- Return ONLY the student's actual answer text as written
- Do NOT correct spelling or grammar
- Do NOT summarize or paraphrase
- Do NOT add your own interpretation
- If the handwriting is unclear, transcribe what you can read and mark unclear parts with [?]
- If it's a drawing/diagram, describe what you see
- If you cannot read anything, return: [unreadable]
- Be honest and precise — this is a real exam`,
          },
          {
            type: 'image_url',
            image_url: { url: dataUrl },
          },
        ],
      },
    ];

    const answerText = await puterChat(messages, { model: 'gpt-4o-mini', temperature: 0.1 });
    console.log(`[puter] Vision read: "${answerText.slice(0, 150)}..."`);

    return {
      success: true,
      answerText: answerText.trim(),
    };
  } catch (err) {
    console.error('[puter] Vision read failed:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  isConfigured,
  readPhotoAnswer,
};
