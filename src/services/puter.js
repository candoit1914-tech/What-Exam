const fs = require('fs');
const path = require('path');
const config = require('../config');

let puter = null;

/**
 * Initialize Puter.js client.
 * Requires PUTER_API_KEY environment variable.
 */
function initPuter() {
  try {
    const { PuterClient } = require('@heyputer/puter.js');
    puter = new PuterClient({
      apiKey: process.env.PUTER_API_KEY || '',
    });
    console.log('[puter] Puter.js initialized');
    return true;
  } catch (err) {
    console.warn('[puter] Failed to initialize:', err.message);
    return false;
  }
}

function isConfigured() {
  return !!process.env.PUTER_API_KEY;
}

/**
 * Use Puter.js vision to read/analyze a handwritten photo answer.
 * Sends the image to GPT with a prompt asking it to transcribe the answer.
 */
async function readPhotoAnswer(imagePath, questionText, questionType = 'theory') {
  if (!isConfigured()) {
    return { success: false, error: 'Puter.js not configured (no PUTER_API_KEY)' };
  }

  if (!puter) {
    initPuter();
  }

  if (!puter) {
    return { success: false, error: 'Puter.js initialization failed' };
  }

  try {
    // Read the image file
    const fullPath = path.isAbsolute(imagePath) ? imagePath : path.join(config.uploadsDir, imagePath);
    if (!fs.existsSync(fullPath)) {
      return { success: false, error: `Image file not found: ${imagePath}` };
    }

    const imageBuffer = fs.readFileSync(fullPath);
    const ext = path.extname(fullPath).toLowerCase().replace('.', '');
    const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

    // Convert to base64 data URL for Puter.js
    const base64 = imageBuffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64}`;

    // Use Puter.js vision to analyze the image
    const prompt = `You are an exam answer reader. A student has written or drawn their answer to an exam question on paper and took a photo.

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
- Be honest and precise — this is a real exam`;

    const response = await puter.ai.chat(prompt, dataUrl, {
      model: 'gpt-4o-mini',
      temperature: 0.1,
    });

    const answerText = typeof response === 'string' ? response : response?.message?.content || '';

    console.log(`[puter] Vision analysis complete for ${imagePath}: ${answerText.slice(0, 100)}...`);

    return {
      success: true,
      answerText: answerText.trim(),
      confidence: 'high',
    };
  } catch (err) {
    console.error('[puter] Vision analysis failed:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Use Puter.js to generate a certificate background or decoration.
 */
async function generateCertificateImage(studentName, examTitle, score, passed) {
  if (!isConfigured() || !puter) {
    return null;
  }

  try {
    const prompt = `A professional ${passed ? 'congratulatory' : 'completion'} certificate background for ${studentName} who took "${examTitle}" and scored ${score}. Elegant, academic style with green and gold accents.`;

    const imageElement = await puter.ai.txt2img(prompt, { model: 'gpt-image-2' });

    // The imageElement is an HTML element in browser context
    // For server-side, we'd need to handle this differently
    return imageElement;
  } catch (err) {
    console.error('[puter] Certificate image generation failed:', err.message);
    return null;
  }
}

/**
 * Use Puter.js vision to read AND mark a handwritten photo answer.
 * This does everything in one call: reads the text, then grades it against the marking scheme.
 */
async function readAndMarkPhotoAnswer(imagePath, question, scheme) {
  if (!isConfigured()) {
    return { success: false, error: 'Puter.js not configured (no PUTER_API_KEY)' };
  }

  if (!puter) {
    initPuter();
  }

  if (!puter) {
    return { success: false, error: 'Puter.js initialization failed' };
  }

  try {
    // Read the image file
    const fullPath = path.isAbsolute(imagePath) ? imagePath : path.join(config.uploadsDir, imagePath);
    if (!fs.existsSync(fullPath)) {
      return { success: false, error: `Image file not found: ${imagePath}` };
    }

    const imageBuffer = fs.readFileSync(fullPath);
    const ext = path.extname(fullPath).toLowerCase().replace('.', '');
    const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

    // Convert to base64 data URL for Puter.js
    const base64 = imageBuffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64}`;

    // Build marking scheme context
    const totalMarks = question.marks || 5;
    let schemeContext = '';
    if (scheme) {
      if (scheme.model_answer) schemeContext += `\nModel answer: ${scheme.model_answer}`;
      if (scheme.key_points?.length) schemeContext += `\nKey points to look for: ${scheme.key_points.join('; ')}`;
      if (scheme.rubric?.length) {
        schemeContext += '\nRubric:';
        for (const r of scheme.rubric) {
          schemeContext += `\n  - ${r.point} (${r.marks} marks): ${r.explanation || ''}`;
        }
      }
    }

    // Combined prompt: read the answer AND mark it
    const prompt = `You are an honest, objective exam marker. A student has written/drawn their answer on paper and sent a photo.

EXAM QUESTION: ${question.text}
${question.passage ? `\nPassage/Context: ${question.passage}` : ''}
TOTAL MARKS AVAILABLE: ${totalMarks}
${schemeContext}

YOUR TASK (two steps):
STEP 1 - READ: Transcribe EXACTLY what the student wrote in this photo. Preserve their exact wording, spelling, grammar — even errors. If unclear, mark with [?]. If unreadable, return [unreadable].

STEP 2 - MARK: Grade the transcribed answer honestly and objectively against the marking scheme.
- Only award marks for content that correctly answers the question
- Do NOT give marks for partially correct or vague answers unless the rubric allows it
- Be strict but fair — match against key points and model answer
- If the answer is blank or unreadable, award 0 marks

RESPOND IN THIS EXACT FORMAT:
TRANSCRIBED_ANSWER: [your transcription of what is written]
MARKS_AWARDED: [number]
FEEDBACK: [brief explanation of why those marks were given]`;

    const response = await puter.ai.chat(prompt, dataUrl, {
      model: 'gpt-4o-mini',
      temperature: 0.1,
    });

    const responseText = typeof response === 'string' ? response : response?.message?.content || '';
    console.log(`[puter] Raw response: ${responseText.slice(0, 300)}...`);

    // Parse the response
    const transcribedMatch = responseText.match(/TRANSCRIBED_ANSWER:\s*(.+?)(?=\nMARKS_AWARDED:|$)/s);
    const marksMatch = responseText.match(/MARKS_AWARDED:\s*(\d+)/);
    const feedbackMatch = responseText.match(/FEEDBACK:\s*(.+?)$/s);

    const transcribedAnswer = transcribedMatch?.[1]?.trim() || '';
    const marksAwarded = Math.min(parseInt(marksMatch?.[1] || '0'), totalMarks);
    const feedback = feedbackMatch?.[1]?.trim() || '';

    console.log(`[puter] Marked: ${marksAwarded}/${totalMarks} — "${transcribedAnswer.slice(0, 100)}..."`);

    return {
      success: true,
      answerText: transcribedAnswer || '[unreadable]',
      marksAwarded,
      maxMarks: totalMarks,
      feedback,
      needsReview: false,
    };
  } catch (err) {
    console.error('[puter] readAndMark failed:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Use Puter.js AI chat for text-based tasks (question generation, marking, etc.)
 */
async function chat(prompt, options = {}) {
  if (!isConfigured() || !puter) {
    return null;
  }

  try {
    const response = await puter.ai.chat(prompt, {
      model: options.model || 'gpt-4o-mini',
      temperature: options.temperature || 0.7,
      max_tokens: options.maxTokens || 2000,
    });

    return typeof response === 'string' ? response : response?.message?.content || '';
  } catch (err) {
    console.error('[puter] Chat failed:', err.message);
    return null;
  }
}

module.exports = {
  initPuter,
  isConfigured,
  readPhotoAnswer,
  readAndMarkPhotoAnswer,
  generateCertificateImage,
  chat,
};
