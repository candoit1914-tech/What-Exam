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

/** AI theory marking against the scheme + rubric. */
async function markTheoryAnswer(question, studentAnswer, scheme) {
  if (!ai.aiConfigured()) {
    throw new ai.AIError('AI is not configured. Set AI_API_KEY and AI_BASE_URL in .env to mark theory questions.');
  }
  const sch = scheme || getScheme(question.id);
  const total = Number(question.marks) || 0;
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
}

/**
 * Grade a photo (written/drawn) theory answer. With AI_VISION enabled the
 * image is sent to the vision-capable endpoint; any failure — or a text-only
 * provider — results in needsReview=true so the admin grades it manually.
 * Uses Puter.js vision when configured for honest, precise reading.
 * Never throws.
 */
async function markTheoryImageAnswer(question, studentAnswer, imageFile, scheme) {
  const total = Number(question.marks) || 0;
  const review = { marksAwarded: 0, maxMarks: total, needsReview: true, feedback: 'Photo answer awaiting manual review.', aiGenerated: false };

  // Try Puter.js vision first for honest, precise reading
  const puter = require('./puter');
  if (puter.isConfigured()) {
    try {
      const visionResult = await puter.readAndMarkPhotoAnswer(imageFile, question, scheme);
      if (visionResult.success) {
        return {
          marksAwarded: visionResult.marksAwarded,
          maxMarks: visionResult.maxMarks,
          breakdown: [],
          feedback: visionResult.feedback || `Photo read: ${visionResult.answerText?.slice(0, 150) || ''}`,
          aiGenerated: true,
          aiReason: 'puter_vision',
          needsReview: false,
        };
      }
      // Fallback: just read the text, then mark it
      const readResult = await puter.readPhotoAnswer(imageFile, question.text, question.type);
      if (readResult.success && readResult.answerText && readResult.answerText !== '[unreadable]') {
        const textResult = markTheoryAnswer({
          text: question.text,
          passage: question.passage || '',
          marks: total,
          type: 'theory',
        }, readResult.answerText, scheme);

        return {
          marksAwarded: textResult.marksAwarded,
          maxMarks: textResult.maxMarks,
          breakdown: textResult.breakdown || [],
          feedback: textResult.feedback || `Photo read: ${readResult.answerText.slice(0, 150)}`,
          aiGenerated: true,
          aiReason: 'puter_vision',
          needsReview: false,
        };
      }
    } catch (err) {
      console.error('[marking] Puter.js vision marking failed, trying fallback:', err.message);
    }
  }

  // Fallback to AI_VISION endpoint
  if (!config.ai.vision) return review;
  try {
    const full = imageFile && !path.isAbsolute(imageFile) ? path.join(config.uploadsDir, imageFile) : imageFile;
    const imageBase64 = fs.readFileSync(full).toString('base64');
    const sch = scheme || getScheme(question.id);
    const result = await ai.markImageTheory({
      questionText: question.text,
      passage: question.passage || '',
      modelAnswer: sch?.model_answer || '',
      keyPoints: sch?.key_points || [],
      rubric: sch?.rubric || [],
      presentationMarks: sch?.presentation_marks || 0,
      grammarMarks: sch?.grammar_marks || 0,
      maxMarks: total,
      studentAnswer,
      imageBase64,
    });
    return {
      marksAwarded: result.marksAwarded,
      maxMarks: result.maxMarks,
      breakdown: result.breakdown || [],
      feedback: result.feedback || '',
      aiGenerated: !!result.aiGenerated,
      aiReason: result.aiReason || '',
      needsReview: false,
    };
  } catch (err) {
    console.error('[marking] vision grading failed, flagged for manual review:', err.message);
    return review;
  }
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
  recomputeExamTotal,
};
