const config = require('../config');

class AIError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AIError';
  }
}

function aiConfigured() {
  return !!(config.ai.apiKey || config.ai.baseUrl);
}

async function chatJSON(messages, { temperature = 0.4, maxRetries = 2 } = {}) {
  if (!aiConfigured()) {
    throw new AIError('AI is not configured. Set AI_API_KEY and AI_BASE_URL in .env');
  }

  const body = {
    model: config.ai.model,
    messages,
    temperature,
    max_tokens: 8192,
  };

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.ai.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new AIError(`AI request failed (${res.status}): ${text.slice(0, 300)}`);
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new AIError('AI returned empty response');

      return parseJSON(content);
    } catch (err) {
      lastErr = err;
      if (err instanceof AIError && attempt < maxRetries) continue;
      throw err;
    }
  }
  throw lastErr;
}

function parseJSON(content) {
  let text = String(content).trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('[');
  const objStart = text.indexOf('{');
  const candidates = [text];
  if (start !== -1 && objStart !== -1) {
    candidates.push(text.slice(Math.min(start, objStart)));
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch { /* try next */ }
  }
  throw new AIError('AI response was not valid JSON: ' + text.slice(0, 200));
}

const SYSTEM_BASE =
  'You are an expert examination setter and examiner. Always answer with valid JSON only. ' +
  'Never include markdown, code fences, or commentary.';

/**
 * Generate a full exam question set with automatic marking scheme.
 */
async function generateQuestions({ subject, topics, count, types, difficulty, instructions }) {
  const counts = { objective: 0, theory: 0 };
  const typeList = (types || ['objective', 'theory']);
  typeList.forEach((t) => (counts[t] = t === 'objective' ? Math.round(count / typeList.length) : 0));
  const objectiveCount = Math.max(1, counts.objective);
  const theoryCount = typeList.includes('theory') ? Math.max(0, count - objectiveCount) : 0;

  const system = SYSTEM_BASE + `
Return an object: {"questions": [...]}. Every question is a JSON object.

Objective question schema:
{
  "type": "objective",
  "text": "question stem",
  "options": ["option1", "option2", "option3", "option4"],
  "correct_index": 0,
  "marks": 1,
  "difficulty": "easy|medium|hard",
  "learning_objective": "what skill this tests",
  "explanation": "why the answer is correct"
}

Theory question schema:
{
  "type": "theory",
  "text": "question stem",
  "marks": 5,
  "difficulty": "easy|medium|hard",
  "learning_objective": "what skill this tests",
  "model_answer": "a complete model answer",
  "key_points": ["point 1", "point 2", ...],
  "rubric": [{"point": "key idea a student must state", "marks": 2, "explanation": "what is expected"}],
  "presentation_marks": 1,
  "grammar_marks": 1
}

Rules:
- The number of objective questions MUST be ${objectiveCount} and theory questions MUST be ${theoryCount}.
- Options must have exactly one correct answer; distractors must be plausible.
- correct_index is the 0-based index of the correct option.
- Theory rubric points must sum to (marks - presentation_marks - grammar_marks) or less; total scoring adds up to exactly marks where sensible.
- Difficulty overall: ${difficulty || 'mixed'}.
`;

  const user = [
    `Subject: ${subject || 'General'}`,
    topics ? `Topics: ${topics}` : 'Topics: general',
    instructions ? `Additional instructions: ${instructions}` : '',
    `Please generate ${count} questions total (${objectiveCount} objective, ${theoryCount} theory).`,
  ]
    .filter(Boolean)
    .join('\n');

  const result = await chatJSON([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);

  return Array.isArray(result) ? result : result.questions;
}

/**
 * Extract structured questions from raw exam text (from PDF or pasted document).
 * Detects options and answer keys; generates schemes where missing.
 */
async function extractQuestionsFromText(rawText) {
  const system = SYSTEM_BASE + `
You are given the raw text of an examination document. Extract every question.

Return: {"questions": [...]}. Each question is one of:

Objective:
{
  "type": "objective",
  "text": "stem (options already removed)",
  "options": ["A. Kumasi", "B. Accra", ...]  // keep any letter prefixes as-is, or plain text
  "correct_answer": "B",   // the option LETTER if the document has an answer key, else ""
  "marks": 1,
  "difficulty": "easy|medium|hard",
  "learning_objective": "",
  "explanation": ""   // leave empty if the document has no answer key
}

Theory:
{
  "type": "theory",
  "text": "stem",
  "marks": 5,
  "difficulty": "easy|medium|hard",
  "learning_objective": "",
  "model_answer": "",
  "key_points": [],
  "rubric": [],
  "presentation_marks": 0,
  "grammar_marks": 0
}

Rules:
- Preserve question numbers, drop them from the text.
- If the document contains an answer key (e.g. "Answers: 1-B, 2-C" or similar), use it as correct_answer. correct_answer must be the letter.
- If options are numbered 1-4 with possible answers, infer the letter as A-D.
- For theory questions with no rubric in the source, leave rubric/model_answer empty (the system will generate them).
- Do NOT invent answer keys that are not in the document. Leave correct_answer/explanation empty when unknown.
`;

  const result = await chatJSON([
    { role: 'system', content: system },
    { role: 'user', content: `Examination document:\n\n${rawText.slice(0, 120000)}` },
  ]);

  return Array.isArray(result) ? result : result.questions;
}

/**
 * Generate a marking scheme for a single theory question.
 */
async function generateTheoryScheme({ text, marks, difficulty }) {
  const system = SYSTEM_BASE + `
Create a marking scheme for a theory question. Return an object:
{
  "model_answer": "complete model answer a top student would give",
  "key_points": ["must-mention point 1", "point 2", ...],
  "rubric": [{"point": "key idea", "marks": 2, "explanation": "what earns these marks"}],
  "presentation_marks": 1,
  "grammar_marks": 1
}
Rules:
- Total scoring equals the question's marks (${marks || 5}). Adjust presentation/grammar marks to fit.
- Rubric points are specific and checkable.
`;

  return chatJSON([
    { role: 'system', content: system },
    {
      role: 'user',
      content: `Question (difficulty: ${difficulty || 'medium'}):\n${text}`,
    },
  ]);
}

/**
 * Determine the correct answers for objective questions that have no answer key.
 * questions: [{index, text, options:[{key,text}]}]
 * Returns: [{index, correct_index, explanation}]
 */
async function answerObjectiveQuestions(questions) {
  if (!questions.length) return [];
  const system = SYSTEM_BASE + `
For each question, determine the single correct answer option. Return:
{"answers":[{"index": 0, "correct_index": 2, "explanation": "short reason"}]}
Rules:
- correct_index is the 0-based index into the options array.
- Pick the objectively correct answer; if ambiguous, choose the best answer.
- Provide a one-sentence explanation for each.
`;
  const user = questions
    .map(
      (q, i) =>
        `Q${i} (index ${q.index}):\n${q.text}\nOptions:\n${q.options
          .map((o, j) => `  ${j}. ${o.text}`)
          .join('\n')}`
    )
    .join('\n\n');

  const result = await chatJSON([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);

  const byIndex = {};
  for (const a of result.answers || result) byIndex[a.index] = a;
  return questions.map((q) => ({
    index: q.index,
    correct_index: byIndex[q.index]?.correct_index ?? -1,
    explanation: byIndex[q.index]?.explanation || '',
  }));
}

/**
 * Mark a theory answer against the scheme + rubric using AI.
 */
async function markTheory({ questionText, modelAnswer, keyPoints, rubric, presentationMarks, grammarMarks, maxMarks, studentAnswer }) {
  const system = SYSTEM_BASE + `
You are a strict but fair examiner. Mark a student's theory answer against the marking scheme.

Return exactly:
{
  "marks_awarded": number,
  "max_marks": number,
  "breakdown": [{"criterion": "...", "marks": number, "comment": "..."}],
  "feedback": "2-3 sentences of constructive feedback"
}

Rules:
- Award marks based on correctness, completeness, accuracy, relevance, use of keywords, and logical explanation.
- Award PARTIAL marks generously but fairly. Be consistent: if a rubric point is partially addressed, give partial marks.
- Presentation and grammar marks are awarded only if the writing is clear/organized and grammatically acceptable.
- marks_awarded MUST be an integer or half-integer between 0 and max_marks.
`;

  const rubricText = Array.isArray(rubric) && rubric.length
    ? rubric.map((r, i) => `${i + 1}. ${r.point} (${r.marks} marks) ${r.explanation ? '- ' + r.explanation : ''}`).join('\n')
    : '(no per-point rubric)';

  const user = [
    `QUESTION:\n${questionText}`,
    `\nMODEL ANSWER:\n${modelAnswer || '(not provided)'}`,
    `\nKEY POINTS EXPECTED:\n${(keyPoints || []).join('\n') || '(none)'}`,
    `\nRUBRIC:\n${rubricText}`,
    `\nPRESENTATION MARKS AVAILABLE: ${presentationMarks || 0}`,
    `\nGRAMMAR MARKS AVAILABLE: ${grammarMarks || 0}`,
    `\nMAX MARKS: ${maxMarks}`,
    `\nSTUDENT ANSWER:\n${studentAnswer}`,
  ].join('\n');

  const result = await chatJSON(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { temperature: 0.2 }
  );

  return {
    marksAwarded: clamp(result.marks_awarded, maxMarks),
    maxMarks,
    breakdown: result.breakdown || [],
    feedback: result.feedback || '',
  };
}

function clamp(n, max) {
  n = Math.round(Number(n) * 2) / 2;
  if (isNaN(n)) return 0;
  return Math.max(0, Math.min(n, max));
}

module.exports = {
  AIError,
  aiConfigured,
  chatJSON,
  generateQuestions,
  extractQuestionsFromText,
  answerObjectiveQuestions,
  generateTheoryScheme,
  markTheory,
};
