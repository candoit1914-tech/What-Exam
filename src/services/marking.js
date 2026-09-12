const fs = require('fs');
const path = require('path');
const db = require('../db');
const ai = require('./ai');
const config = require('../config');

// ── Marking scheme generation ──────────────────────────────────────────

/**
 * Build a marking scheme for a question. Objective schemes are derived
 * automatically from the stored correct answer. Theory schemes are
 * AI-generated when they do not already exist.
 */
async function buildMarkingScheme(question) {
  const existing = db.prepare('SELECT * FROM marking_schemes WHERE question_id = ?').get(question.id);
  if (question.type !== 'objective' && existing && JSON.parse(existing.scheme).model_answer) {
    return JSON.parse(existing.scheme);
  }

  let scheme;
  if (question.type === 'objective') {
    scheme = {
      type: 'objective',
      correct_answer: question.correct_answer,
      marks: question.marks,
      explanation: question.explanation || '',
    };
  } else {
    let generated = null;
    if (ai.aiConfigured()) {
      try {
        generated = await ai.generateTheoryScheme({
          text: question.text,
          marks: question.marks,
          difficulty: question.difficulty,
        });
      } catch (err) {
        generated = null; // fall back to an editable placeholder
      }
    }
    scheme = generated
      ? {
          type: 'theory',
          model_answer: generated.model_answer || '',
          key_points: generated.key_points || [],
          rubric: generated.rubric || [],
          presentation_marks: generated.presentation_marks || 0,
          grammar_marks: generated.grammar_marks || 0,
        }
      : {
          type: 'theory',
          model_answer: '',
          key_points: [],
          rubric: [{ point: '', marks: 0, explanation: '' }],
          presentation_marks: 0,
          grammar_marks: 0,
        };
    // keep any admin edits to an existing scheme, refreshing only the AI parts
    if (existing) {
      const old = JSON.parse(existing.scheme);
      scheme.model_answer = old.model_answer || scheme.model_answer;
      scheme.key_points = old.key_points?.length ? old.key_points : scheme.key_points;
      scheme.rubric = old.rubric?.length ? old.rubric : scheme.rubric;
    }
  }

  db.prepare(
    `INSERT INTO marking_schemes (question_id, type, scheme) VALUES (?, ?, ?)
     ON CONFLICT(question_id) DO UPDATE SET scheme=excluded.scheme, updated_at=datetime('now')`
  ).run(question.id, scheme.type, JSON.stringify(scheme));

  return scheme;
}

function getScheme(questionId) {
  const row = db.prepare('SELECT scheme FROM marking_schemes WHERE question_id = ?').get(questionId);
  return row ? JSON.parse(row.scheme) : null;
}

// ── Marking ────────────────────────────────────────────────────────────

function normalizeAnswer(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/g, '')
    .toUpperCase();
}

function isObjectiveAnswer(input) {
  return /^[A-D]$/.test(normalizeAnswer(input).replace(/\.$/, ''));
}

function parseOptions(question) {
  if (!question) return [];
  if (Array.isArray(question.options)) return question.options;
  try {
    return JSON.parse(question.options || '[]');
  } catch {
    return [];
  }
}

/**
 * Resolve the correct option KEY (a bare A-D letter) for an objective question,
 * tolerating messy stored values like "B", "b.", "B. Accra", "Option B", or a
 * full option text ("Accra"). The stored value is reconciled against the
 * question's options, so a student who picks the genuinely correct option is
 * never marked wrong just because the answer key was stored with extra text or
 * a different format.
 */
function resolveCorrectKey(question) {
  const raw = question && question.correct_answer;
  if (raw == null || String(raw).trim() === '') return null;
  const opts = parseOptions(question);

  const exact = normalizeAnswer(raw).replace(/\.$/, '');
  if (/^[A-D]$/.test(exact)) return exact;

  const ot = (o) => normalizeAnswer(o && o.text);
  const byText = opts.find((o) => {
    const t = ot(o);
    return !!t && (t === exact || t.includes(exact) || exact.includes(t));
  });
  if (byText) return String(byText.key || '').toUpperCase();

  const lead =
    String(raw).match(/^(?:option\s*)?\(?([A-Da-d])\)?$/i) ||
    String(raw).match(/^(?:option\s*)?\(?([A-Da-d])\)?\s*[.\-:\]](?:\s|$)/i);
  if (lead) return lead[1].toUpperCase();

  return null;
}

/** Reduce any stored correct answer to a bare A-D letter (or null). */
function sanitizeCorrectAnswer(value, options) {
  return resolveCorrectKey({ correct_answer: value, options });
}

/**
 * Resolve the student's answer to a bare A-D letter, accepting a letter,
 * "b.", or the full option text ("Accra"). Returns null when nothing matches.
 */
function resolveStudentLetter(question, raw) {
  const ans = normalizeAnswer(raw).replace(/\.$/, '');
  if (/^[A-D]$/.test(ans)) return ans;
  const opts = parseOptions(question);
  const hit = opts.find((o) => {
    const t = normalizeAnswer(o && o.text);
    return !!t && (t === ans || t.includes(ans) || ans.includes(t));
  });
  return hit ? String(hit.key || '').toUpperCase() : null;
}

/** Instant objective marking. Accepts "B", "b", "B." or the full option text. */
function markObjective(question, studentAnswer) {
  const ans = resolveStudentLetter(question, studentAnswer);
  const correct = resolveCorrectKey(question);
  const isCorrect = !!ans && !!correct && ans === correct;
  return {
    isCorrect,
    marksAwarded: isCorrect ? Number(question.marks) : 0,
    maxMarks: Number(question.marks),
  };
}

/** AI theory marking against the scheme + rubric. Falls back to heuristic keyword matching if AI fails. */
async function markTheoryAnswer(question, studentAnswer, scheme) {
  const sch = scheme || getScheme(question.id);
  const total = Number(question.marks) || 0;

  if (!ai.aiConfigured()) {
    // AI not configured — use heuristic directly
    console.log('[marking] AI not configured, using heuristic fallback');
    return heuristicMark(question, studentAnswer, sch);
  }

  try {
    const result = await ai.markTheory({
      questionText: question.text,
      modelAnswer: sch?.model_answer || '',
      keyPoints: sch?.key_points || [],
      rubric: sch?.rubric || [],
      presentationMarks: sch?.presentation_marks || 0,
      grammarMarks: sch?.grammar_marks || 0,
      maxMarks: total,
      studentAnswer,
    });
    return {
      marksAwarded: result.marksAwarded,
      maxMarks: result.maxMarks,
      breakdown: result.breakdown || [],
      feedback: result.feedback || '',
      aiGenerated: !!result.aiGenerated,
      aiReason: result.aiReason || '',
    };
  } catch (err) {
    // AI failed (quota, timeout, etc.) — use heuristic as fallback
    console.error(`[marking] AI marking failed, using heuristic fallback: ${err.message}`);
    const h = heuristicMark(question, studentAnswer, sch);
    h.feedback = `[AI unavailable — heuristic fallback] ${h.feedback}`;
    return h;
  }
}

/**
 * Grade a photo (written/drawn) theory answer.
 * If studentAnswer already contains a meaningful reading (from inbound OCR/AI),
 * marks it directly via markTheoryAnswer.  Otherwise tries local OCR and AI
 * vision to re-read from the image file.  Never throws.
 */
async function markTheoryImageAnswer(question, studentAnswer, imageFile, scheme) {
  const total = Number(question.marks) || 0;
  const review = { marksAwarded: 0, maxMarks: total, needsReview: true, feedback: 'Photo answer awaiting manual review.', aiGenerated: false };

  // If the inbound read already produced meaningful text, mark it directly
  // without re-reading the image (avoids duplicate OCR/vision calls that may
  // fail on Render).
  const PLACEHOLDERS = ['(photo answer)', '(photo answer - could not read)', '(photo answer - transcription failed)', '(audio answer)', '(audio answer - could not transcribe)', '(audio answer - transcription failed)', '(photo answer - awaiting manual review)'];
  const preReadText = (studentAnswer || '').trim();
  const isPlaceholder = !preReadText || PLACEHOLDERS.includes(preReadText) || preReadText.length < 3;
  if (!isPlaceholder) {
    try {
      const textResult = await markTheoryAnswer({
        id: question.id,
        text: question.text,
        passage: question.passage || '',
        marks: total,
        type: 'theory',
      }, preReadText, scheme);
      return {
        marksAwarded: textResult.marksAwarded,
        maxMarks: textResult.maxMarks,
        breakdown: textResult.breakdown || [],
        feedback: textResult.feedback || `Student answer: ${preReadText.slice(0, 150)}`,
        aiGenerated: true,
        aiReason: 'pre_read_text',
        needsReview: false,
      };
    } catch (err) {
      console.error('[marking] Text marking of pre-read answer failed:', err.message);
    }
  }

  // No pre-read text or marking failed — try re-reading from the image
  if (imageFile) {
    // Try local OCR first (tesseract.js)
    const ocr = require('./ocr');
    try {
      const ocrResult = await ocr.readPhotoAnswer(imageFile, question.text);
      if (ocrResult.success && ocrResult.text && ocrResult.text !== '[unreadable]' && ocrResult.text.length > 1) {
        const textResult = await markTheoryAnswer({
          id: question.id,
          text: question.text,
          passage: question.passage || '',
          marks: total,
          type: 'theory',
        }, ocrResult.text, scheme);
        return {
          marksAwarded: textResult.marksAwarded,
          maxMarks: textResult.maxMarks,
          breakdown: textResult.breakdown || [],
          feedback: textResult.feedback || `OCR read (${ocrResult.confidence}% conf): ${ocrResult.text.slice(0, 150)}`,
          aiGenerated: true,
          aiReason: 'local_ocr',
          needsReview: false,
        };
      }
    } catch (err) {
      console.error('[marking] Local OCR failed:', err.message);
    }

    // Fallback to AI vision providers
    if (ai.aiConfigured()) {
      try {
        const readText = await ai.readPhotoAnswer(imageFile, question.text);
        if (readText && readText !== '[unreadable]' && readText.length > 1) {
          const textResult = await markTheoryAnswer({
            id: question.id,
            text: question.text,
            passage: question.passage || '',
            marks: total,
            type: 'theory',
          }, readText, scheme);
          return {
            marksAwarded: textResult.marksAwarded,
            maxMarks: textResult.maxMarks,
            breakdown: textResult.breakdown || [],
            feedback: textResult.feedback || `AI read: ${readText.slice(0, 150)}`,
            aiGenerated: true,
            aiReason: 'ai_vision',
            needsReview: false,
          };
        }
      } catch (err) {
        console.error('[marking] AI vision failed:', err.message);
      }
    }
  }

  // Nothing worked — the photo could not be read. Return 0 marks with
  // needsReview so the admin can manually grade it. We do NOT run heuristic
  // keyword matching on placeholder text since it always yields 0 and wastes time.
  return {
    marksAwarded: 0,
    maxMarks: total,
    breakdown: [],
    feedback: 'Photo answer could not be read by OCR or AI vision. Awaiting manual review by administrator.',
    aiGenerated: false,
    aiReason: 'photo_unreadable',
    needsReview: true,
  };
}

// ── Heuristic keyword marking (AI fallback) ───────────────────────────

/**
 * Common English stop words to exclude from keyword matching.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'just', 'because', 'but', 'and', 'or', 'if', 'while', 'about', 'it',
  'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our',
  'you', 'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their',
  'what', 'which', 'who', 'whom', 'there', 'their', 'been', 'also',
  'make', 'like', 'even', 'well', 'back', 'much', 'go', 'good', 'much',
]);

/**
 * Extract meaningful keywords from a string: tokenize, lowercase, strip
 * stop words and very short tokens, return a Set.
 */
function extractKeywords(text) {
  if (!text) return new Set();
  const tokens = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^-+|-+$/g, ''))
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
  return new Set(tokens);
}

/**
 * Compute Jaccard-style overlap between student keywords and scheme keywords.
 * Returns a ratio 0..1.
 */
function keywordOverlap(studentSet, schemeSet) {
  if (!schemeSet.size) return 0;
  let matches = 0;
  for (const kw of schemeSet) {
    if (studentSet.has(kw)) matches++;
    // also check partial stem match (e.g. "govern" matches "governance")
    else {
      for (const sk of studentSet) {
        if (sk.length >= 5 && kw.length >= 5 && (sk.includes(kw) || kw.includes(sk))) {
          matches++;
          break;
        }
      }
    }
  }
  return matches / schemeSet.size;
}

/**
 * Heuristic keyword-based marking fallback.  Used when ALL AI providers
 * fail (Gemini quota, NVIDIA errors, etc.) so that students still earn
 * partial marks for relevant content instead of a blanket 0.
 *
 * Awards marks proportionally based on keyword overlap with the marking
 * scheme's key_points and model_answer.  Capped at 60% of total to
 * ensure AI marking is always preferred when available.
 */
function heuristicMark(question, studentAnswer, scheme) {
  const total = Number(question.marks) || 0;
  if (!total || !studentAnswer) {
    return { marksAwarded: 0, maxMarks: total, breakdown: [], feedback: 'No answer provided.', aiGenerated: false, aiReason: 'no_answer', needsReview: false };
  }

  const cap = Math.ceil(total * 0.6); // max 60% via heuristic

  // Build scheme keyword set from key_points + model_answer
  const schemeKeywords = new Set();
  const kp = scheme?.key_points || [];
  for (const point of kp) {
    for (const kw of extractKeywords(point)) schemeKeywords.add(kw);
  }
  for (const kw of extractKeywords(scheme?.model_answer || '')) schemeKeywords.add(kw);

  // Also extract from rubric points
  const rubric = scheme?.rubric || [];
  for (const r of rubric) {
    for (const kw of extractKeywords(r.point || '')) schemeKeywords.add(kw);
    for (const kw of extractKeywords(r.explanation || '')) schemeKeywords.add(kw);
  }

  const studentKeywords = extractKeywords(studentAnswer);

  if (!schemeKeywords.size) {
    // No scheme keywords available — give partial credit for substantive answers.
    // A student who writes a multi-sentence answer with real words (not just
    // placeholders) deserves something instead of a blanket 0.
    const wordCount = studentAnswer.split(/\s+/).filter(w => w.length > 2).length;
    if (wordCount >= 10) {
      const awarded = Math.min(Math.ceil(total * 0.25), cap);
      return {
        marksAwarded: awarded,
        maxMarks: total,
        breakdown: [],
        feedback: `No marking scheme available. Awarded ${awarded}/${total} marks for a substantive answer (${wordCount} words). Admin review recommended.`,
        aiGenerated: false,
        aiReason: 'no_scheme_partial',
        needsReview: true,
      };
    }
    return { marksAwarded: 0, maxMarks: total, breakdown: [], feedback: 'No marking scheme available for heuristic marking.', aiGenerated: false, aiReason: 'no_scheme', needsReview: false };
  }

  const overlap = keywordOverlap(studentKeywords, schemeKeywords);
  const raw = Math.round(overlap * total * 10) / 10;
  const awarded = Math.min(Math.round(raw), cap);

  // Build breakdown by key point
  const breakdown = [];
  const perKp = kp.length ? total / kp.length : 0;
  for (const point of kp) {
    const kpKw = extractKeywords(point);
    const kpOverlap = keywordOverlap(studentKeywords, kpKw);
    const kpMarks = Math.round(kpOverlap * perKp);
    if (kpMarks > 0 || kpOverlap > 0.3) {
      breakdown.push({ criterion: point, marks: kpMarks, comment: kpOverlap > 0.5 ? 'Key point addressed' : 'Partially addressed' });
    }
  }

  const feedback = awarded > 0
    ? `Heuristic marking: ~${Math.round(overlap * 100)}% keyword match with marking scheme. ${awarded}/${total} marks awarded (capped at ${cap} without AI verification).`
    : 'Heuristic marking: insufficient keyword overlap with marking scheme. 0 marks awarded.';

  return {
    marksAwarded: awarded,
    maxMarks: total,
    breakdown,
    feedback,
    aiGenerated: false,
    aiReason: 'heuristic_fallback',
    needsReview: false,
  };
}

// ── Exam totals ────────────────────────────────────────────────────────

function recomputeExamTotal(examId) {
  const row = db
    .prepare('SELECT COALESCE(SUM(marks),0) AS total FROM questions WHERE exam_id = ?')
    .get(examId);
  db.prepare('UPDATE exams SET total_marks = ? WHERE id = ?').run(row.total, examId);
  return row.total;
}

module.exports = {
  buildMarkingScheme,
  getScheme,
  normalizeAnswer,
  isObjectiveAnswer,
  resolveCorrectKey,
  sanitizeCorrectAnswer,
  resolveStudentLetter,
  markObjective,
  markTheoryAnswer,
  markTheoryImageAnswer,
  heuristicMark,
  recomputeExamTotal,
};
