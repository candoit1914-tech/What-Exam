const db = require('../db');
const ai = require('./ai');

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

/** Instant objective marking. Accepts "B", "b", "B." */
function markObjective(question, studentAnswer) {
  const ans = normalizeAnswer(studentAnswer).replace(/\.$/, '');
  const correct = normalizeAnswer(question.correct_answer).replace(/\.$/, '');
  const isCorrect = ans === correct;
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
  return result;
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
  markObjective,
  markTheoryAnswer,
  recomputeExamTotal,
};
