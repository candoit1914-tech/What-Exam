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

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Reject with an AIError after `ms` if `promise` has not settled. This is a
 * HARD timeout: some Node/undici versions keep an aborted request pending
 * indefinitely, so AbortController alone cannot be relied on to unblock a
 * stuck AI call. Racing the promise against a timer guarantees a hanging
 * endpoint can never stall a job forever.
 */
function withHardTimeout(promise, ms) {
  if (!ms || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new AIError(`AI request timed out after ${Math.round(ms / 1000)}s.`);
      e.name = 'AIError';
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function chatJSON(messages, { temperature = 0.4, maxRetries = 2, timeoutMs = config.ai.timeoutMs, maxTokens = 8192 } = {}) {
  if (!aiConfigured()) {
    throw new AIError('AI is not configured. Set AI_API_KEY and AI_BASE_URL in .env');
  }

  const body = {
    model: config.ai.model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await withHardTimeout(
        fetch(`${config.ai.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.ai.apiKey}`,
          },
          body: JSON.stringify(body),
        }),
        timeoutMs
      );

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
      // A hard timeout must surface (never retry) so an exam question never
      // hangs the flow indefinitely waiting on an unresponsive AI endpoint.
      if (err instanceof AIError && /timed out/i.test(err.message)) {
        throw new AIError(`AI request timed out after ${Math.round(timeoutMs / 1000)}s.`);
      }
      // Retry transient network failures (ECONNRESET etc.) and HTTP errors with
      // a small backoff; concurrent extraction blocks make these more likely.
      const retryable = err instanceof AIError || err instanceof TypeError;
      if (retryable && attempt < maxRetries) {
        await delay(500 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * A slow model occasionally hits the output-token cap mid-object, leaving a
 * JSON payload that ends mid-value (often with an unterminated string, since
 * the final closing quotes are cut off). Close the dangling value and the
 * enclosing brackets so every question the model DID finish is recovered
 * instead of losing the whole block. Example: `... "text": "The oxen ___`
 * becomes `... "text": "The oxen ___"]}`.
 */
function repairTruncatedJSON(text) {
  const out = text.replace(/[,\s]+$/, '');
  const last = out[out.length - 1];
  // 1. Ends mid-string → close the string first.
  let patched = last === '"' ? out + '"' : out;
  // 2. Close every still-open bracket in the order they were opened.
  const stack = [];
  for (const ch of patched) {
    if (ch === '{' || ch === '[') stack.push(ch);
    else if ((ch === '}' || ch === ']') && stack.length && ((ch === '}' && stack[stack.length - 1] === '{') || (ch === ']' && stack[stack.length - 1] === '['))) {
      stack.pop();
    }
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    patched += stack[i] === '{' ? '}' : ']';
  }
  try {
    return JSON.parse(patched);
  } catch { /* continue */ }
  return null;
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
  // Last resort: the payload may have been truncated mid-question by the token
  // cap. Salvage what the model finished.
  for (const c of candidates) {
    const repaired = repairTruncatedJSON(c);
    if (repaired) return repaired;
  }
  throw new AIError('AI response was not valid JSON: ' + text.slice(0, 200));
}

const SYSTEM_BASE =
  'You are an expert examination setter and examiner. Always answer with valid JSON only. ' +
  'Never include markdown, code fences, or commentary. Respond with ONLY the JSON object, nothing else.';

const EXAMINER_PERSONA =
  'You are a genuine, sincere, objective professional teacher and chief examiner with more than 40 years of experience, deeply well-versed in national examinations (including the Ghana BECE). You grade fairly, honestly, and consistently: you give full credit where it is due, partial credit for partially correct work, and no credit only where nothing was earned. You never mark down out of strictness or mark up out of sympathy.';

/** Wrap any grading/scheme system prompt with the shared examiner persona. */
function examinerPrompt(base) {
  return `${EXAMINER_PERSONA}\n\n${base}`;
}

// Slow/commercial AI endpoints (e.g. huge 100B+ models) can take well over a
// minute to structure a full exam paper. Bulk admin operations (PDF upload /
// question extraction) get a generous window; the default timeout applies to
// everything else.
const BULK_TIMEOUT_MS = 5 * 60 * 1000;

// PDF/paper extraction runs in small question-aligned blocks so every AI call
// stays fast on slow endpoints. Each block generates at most BLOCK_MAX_TOKENS
// of output; the cap also keeps a single rambling block from burning the timeout.
// Blocks are kept SMALL on purpose: a huge block forces a slow (e.g. 100B+)
// model to generate a very long JSON payload, which can take minutes and hang
// the whole import. Small blocks finish quickly even on slow endpoints.
const BLOCK_QUESTIONS = 5;
const BLOCK_MAX_CHARS = 3500;
// Blocks run a few at a time: enough parallelism to collapse a long paper's
// wall-clock time, capped so a flaky shared endpoint is not flooded.
const BLOCK_CONCURRENCY = 4;
const BLOCK_MAX_TOKENS = 3000;
// A single extraction block runs on its own clock with a couple of retries
// (flaky shared endpoints drop requests under concurrency). A block that still
// fails is SKIPPED — never fails the whole paper — so this only bounds how
// long one stubborn block can stall the import.
const BLOCK_TIMEOUT_MS = 4 * 60 * 1000;
const BLOCK_RETRIES = 2;

/** Run fn over items with at most `limit` promises in flight (like a semaphore). */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx]);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

/**
 * Generate a full exam question set with automatic marking scheme.
 * When poolSize is greater than count, produces up to poolSize DISTINCT
 * questions over several calls so each attempt can draw a fresh set.
 *
 * The batch calls run CONCURRENTLY (concurrency-capped). The dominant cost is
 * the round trip to the AI endpoint, so parallelizing collapses the wall-clock
 * time from "sum of all batches" to "one slowest batch × few rounds".
 */
async function generateQuestions({ subject, topics, count, objectiveCount, theoryCount, types, difficulty, instructions, poolSize, avoid = [] }) {
  const typeList = Array.isArray(types) && types.length ? types : ['objective', 'theory'];
  const hasTheory = typeList.includes('theory');

  // Explicit per-type counts win (the admin can choose them); otherwise fall
  // back to the legacy even split of `count` across the selected types.
  let objN = objectiveCount != null
    ? Math.max(1, Math.round(Number(objectiveCount) || 0))
    : Math.max(1, Math.round(count / typeList.length));
  let theoN = theoryCount != null
    ? Math.max(0, Math.round(Number(theoryCount) || 0))
    : hasTheory
      ? Math.max(0, count - objN)
      : 0;
  if (objN === 0 && theoN > 0) { objN = 1; theoN = Math.max(0, theoN - 1); }
  const total = objN + theoN;

  const target = Math.min(Math.max(parseInt(poolSize) || total, total), 150);
  const batchSize = Math.max(1, Math.min(target, 10));
  const maxCalls = Math.min(Math.ceil(target / batchSize), 16);

  // Keep the same objective/theory split within each smaller batch so the
  // per-batch counts stay consistent with the overall request.
  const ratio = total > 0 ? batchSize / total : 1;
  const perBatchTheory = theoN > 0 ? Math.max(1, Math.round(theoN * ratio)) : 0;
  const perBatchObjective = Math.max(1, batchSize - perBatchTheory);

  const NOVELTY_RULE =
    'NOVELTY (non-negotiable): every question must be ORIGINAL and UNPREDICTABLE.\n' +
    '- A student who reads only the subject and topic list must NOT be able to guess these questions.\n' +
    '- Do NOT use classic textbook questions, well-known past-exam questions, or anything a student could have seen in another AI-generated exam.\n' +
    '- Approach every topic from a fresh angle: invent a believable context, scenario, dataset, or situation, then ask a question about it.\n' +
    '- Never reuse the same facts, figures, names, examples, or scenarios across questions or across batches.\n' +
    '- Vary stems and framing so no two questions feel alike.';

  const SPINS = [
    'Frame every question as a concrete real-world situation (a farmer, shopkeeper, school science club, health worker, community, market, lab) with a specific detail the student must reason about. No abstract, definition-style, or fill-in-the-blank stems.',
    'Make every question an application or analysis task: present a short scenario, measurement, or data snippet and ask the student to apply the concept. Never ask for a memorised definition, list, or label.',
    'Use fresh, believable but uncommon contexts and numbers. Rotate the setting so no two questions share a setting, and avoid familiar examples and standard figures.',
    'Ask from a decision or problem-solving angle: each question presents a mini-case and asks what happens, why, or what should be done, with exam-appropriate clarity for a JHS candidate.',
  ];
  const spin = SPINS[Math.floor(Math.random() * SPINS.length)];

  const avoidBlock =
    avoid && avoid.length
      ? 'ABSOLUTELY DO NOT generate, reuse, or closely paraphrase any of these existing questions:\n' +
        avoid.map((t, i) => `${i + 1}. ${String(t).slice(0, 140)}`).join('\n')
      : '';

  const system = (objN, theoN, variety) => SYSTEM_BASE + `
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
- The number of objective questions MUST be ${objN} and theory questions MUST be ${theoN}.
- Options must have exactly one correct answer; distractors must be plausible.
- correct_index is the 0-based index of the correct option.
- CORRECTNESS IS NON-NEGOTIABLE: the option at correct_index must be the ONLY defensible correct answer. If a stem or options are ambiguous, rewrite them so exactly one option is clearly correct. These keys are used to grade students, so a wrong key marks innocent students wrong — never emit an uncertain key.
- Theory rubric points must sum to (marks - presentation_marks - grammar_marks) or less; total scoring adds up to exactly marks where sensible.
- Difficulty overall: ${difficulty || 'mixed'}.
- Style: write like the Ghana Basic Education Certificate Examination (BECE) for a Junior High School (JHS) candidate. Use clear, age-appropriate English and concise stems. Each objective question has exactly four options (A-D) with ONE clearly correct answer and three plausible distractors. No trick wording, no ambiguity, no questions that depend on a textbook not available to the student. Theory questions may use sub-parts (a), (b), (c) where natural.
${NOVELTY_RULE}
${spin}
${variety || ''}
${avoidBlock}`;

  const user = (batchTotal) =>
    [
      `Subject: ${subject || 'General'}`,
      topics ? `Topics: ${topics}` : 'Topics: general',
      instructions ? `Additional instructions: ${instructions}` : '',
      `Please generate ${batchTotal} questions total (${perBatchObjective} objective, ${perBatchTheory} theory).`,
    ]
      .filter(Boolean)
      .join('\n');

  const variety =
    maxCalls > 1
      ? `- These questions are one batch of ${maxCalls} batches that together form ONE large pool on this exact subject and topic list. Every question in the WHOLE pool must be distinct: no repeats, no close paraphrases, and no reused facts, figures, or examples across batches.`
      : '- Produce a diverse set; avoid reusing the same facts, figures, or classic textbook examples across questions.';

  // Build lazy tasks so mapLimit actually throttles them; eager promises would
  // fire every call at once and defeat the concurrency cap.
  const tasks = Array.from({ length: maxCalls }, () => () =>
    chatJSON(
      [
        { role: 'system', content: system(perBatchObjective, perBatchTheory, variety) },
        { role: 'user', content: user(batchSize) },
      ],
      { temperature: 0.9 }
    )
  );
  const settled = await mapLimit(tasks, 4, (run) => run());

  const seen = new Set();
  const all = [];
  for (const result of settled) {
    const batch = Array.isArray(result) ? result : result.questions;
    for (const q of batch || []) {
      const t = String(q && q.text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (t && !seen.has(t)) {
        seen.add(t);
        all.push(q);
      }
    }
  }

  // The first `total` questions form the main set; every extra pool question
  // must be genuinely distinct from them (and from its siblings), so an
  // attempt can never show a question that paraphrases one already in the exam.
  // Threshold is deliberately high (0.8) so only clear paraphrases are dropped —
  // two different questions on the same topic still share vocabulary.
  const active = all.slice(0, total);
  const rest = [];
  for (const q of all.slice(total)) {
    const dupActive = active.some((a) => textSimilarity(a.text, q.text) > 0.8);
    const dupRest = rest.some((p) => textSimilarity(p.text, q.text) > 0.8);
    if (!dupActive && !dupRest) rest.push(q);
  }
  return active.concat(rest).slice(0, target);
}

/** Jaccard similarity over significant tokens; used to drop near-duplicate stems. */
function textSimilarity(a, b) {
  const ta = new Set(String(a).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
  const tb = new Set(String(b).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Extract structured questions from raw exam text (from PDF or pasted document).
 * Detects options and answer keys; generates schemes where missing.
 *
 * The document is split into question-aligned blocks and each block is
 * extracted by a SEPARATE small AI call, run concurrently. A single call that
 * must parse and emit the entire paper (often >8000 output tokens) easily
 * exceeds the bulk timeout on slow models (e.g. huge 100B+ endpoints), which
 * is what made PDF uploads time out. Small blocks keep every call fast.
 */
async function extractQuestionsFromText(rawText, onProgress) {
  const text = String(rawText || '').trim();
  if (!text) return [];

  const answerKey = extractAnswerKeySection(text);
  const markingScheme = extractMarkingSchemeSection(text);
  const blocks = splitIntoBlocks(text);

  const system = SYSTEM_BASE + `
You are given the raw text of an examination document. Extract every question.

Return: {"questions": [...]}. Each question is one of:

Objective:
{
  "type": "objective",
  "text": "stem (options already removed)",
  "options": ["A. Kumasi", "B. Accra", ...]  // KEEP the original letter prefixes (A., B., C., D.) exactly as written on the paper
  "correct_answer": "B",   // the option LETTER if the document has an answer key, else "" (empty string)
  "correct_index": 1,      // 0-based position of the correct option IN the options array you return (matches correct_answer); set to null (NOT 0) when the document has no answer key
  "passage": "",           // full passage/context this question is based on, else ""
  "marks": 1,
  "difficulty": "easy|medium|hard",
  "learning_objective": "",
  "explanation": ""   // leave empty if the document has no answer key
}

Theory:
{
  "type": "theory",
  "text": "stem",
  "passage": "",     // full passage/context this question is based on, else ""
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
- Preserve question numbers, drop them from the text. Keep any instruction that is part of the question stem (e.g. "Read the passage below and answer questions 1 to 5.") inside text when it belongs to a single question, otherwise it stays as context.
- If the document contains an answer key (e.g. "Answers: 1-B, 2-C" or similar), use it to fill correct_answer (the option LETTER) AND correct_index (the 0-based position of that option in the options array you return).
- If options are numbered 1-4 with possible answers, infer the letter as A-D.
- KEEP the options in the exact order and with the exact letters they have on the paper.
- PASSAGES: Reading-comprehension questions are based on a passage that appears before them in the document. If a question depends on such a passage, set its "passage" field to the full passage text VERBATIM on the FIRST question that uses that passage, and leave "passage": "" on the LATER questions that use the SAME passage (the system attaches it to the whole group). Preserve instructions that introduce the passage ("Read the following passage carefully and answer questions 1 to 5.") as part of that first question's passage.
- SECTION INSTRUCTIONS: Preserve section-level instructions students need to answer the questions (e.g. "Answer ONE question in this section", "Your answer should be between 250 and 300 words", "Answer ALL questions", "Write a letter", "Translate into English"). Attach them to the "passage" field of the FIRST question of that section — for BOTH objective and theory questions — and leave "passage": "" on the later questions of the same section. Never drop instructions that appear in the document.
- MARKING SCHEME: If a marking scheme / model answer / suggested answers section for the questions is quoted in the prompt, use it VERBATIM to fill model_answer, key_points and rubric for the matching theory questions (do not regenerate or paraphrase it).
- For theory questions with no rubric in the source, leave rubric/model_answer empty (the system will generate them).
- Do NOT invent answer keys that are not in the document. Leave correct_answer as "" and correct_index as null when unknown.
- WATERMARK LINES: Never copy watermark, source, or download footer/header lines (e.g. "Downloaded from sronu.com", "Source: www.example.com", "DOWNLOADED FROM SRONU") into text, passage, or instructions. Always drop such lines.
- COMPACT OUTPUT: keep option text short, leave explanation and learning_objective empty, and do not repeat the passage for later questions. Output ONLY the JSON object.
`;

  const user = (block, shared) => [
    'Extract every question from the document block below.',
    answerKey
      ? `\nThe document includes this answer key (use it to fill correct_answer — the option LETTER — and correct_index for the matching questions):\n${answerKey}`
      : '',
    markingScheme
      ? `\nThe document includes this marking scheme / model answers (use it VERBATIM to fill model_answer, key_points and rubric for the matching theory questions):\n${markingScheme}`
      : '',
    shared
      ? `\nThe questions in this block are based on the following passage/context (quoted from earlier in the document). Use it to answer comprehension questions and preserve it VERBATIM in the passage field of the first question that uses it (and attach any section instructions such as "Answer ONE question in this section" to that first question's passage as well):\n${shared}`
      : '',
    `\n--- Document block ---\n${block}`,
  ].join('\n');

  // A block's leading context is the passage and/or section instructions that
  // sit in front of its first question (the splitter breaks blocks at
  // instruction lines precisely so this is the group's own context). Leading
  // title lines ("ENGLISH LANGUAGE", "BIG EXAM PAPER") are dropped so they are
  // not attached to every question. If a block has no context of its own, the
  // most recent one is carried forward so questions never lose context.
  const sharedFor = (block) => {
    const lines = leadingContext(block.split(/\r?\n/));
    let start = 0;
    while (start < lines.length) {
      const l = lines[start].trim();
      if (CONTEXT_START.test(l) || l.length >= 40) break;
      start++; // skip title-like lines
    }
    return lines.slice(start).join('\n').trim();
  };
  let lastPassage = '';
  const blockPrompts = blocks.map((block) => {
    const lead = sharedFor(block);
    const isContext = lead.length > 0;
    if (isContext) lastPassage = lead;
    return { block, shared: isContext ? lead : lastPassage };
  });

  let completed = 0;
  // A single block runs on its own shorter clock with a single retry. If it
  // still fails (timeout, HTTP error, bad JSON), the block is SKIPPED — the
  // paper is saved with the blocks that did succeed instead of failing the
  // whole import on one stubborn block.
  const tasks = blockPrompts.map(({ block, shared }) => async () => {
    completed++;
    if (onProgress) onProgress(completed, blocks.length);
    for (let attempt = 0; attempt <= BLOCK_RETRIES; attempt++) {
      try {
        return await chatJSON(
          [
            { role: 'system', content: system },
            { role: 'user', content: user(block, shared) },
          ],
          // Internal retries are disabled: the block wrapper owns retries, and
          // the hard timeout guarantees a stuck fetch cannot stall the import.
          { timeoutMs: BLOCK_TIMEOUT_MS, maxTokens: BLOCK_MAX_TOKENS, maxRetries: 0 }
        );
      } catch (err) {
        const isTimeout = err && err.name === 'AIError' && /timed out/i.test(err.message);
        if (attempt < BLOCK_RETRIES) {
          await delay(1000 * (attempt + 1));
          continue;
        }
        console.error('[ai] extraction block skipped:', isTimeout ? 'timeout' : err.message);
        return null;
      }
    }
    return null;
  });

  const settled = await mapLimit(tasks, BLOCK_CONCURRENCY, (run) => run());

  const seen = new Set();
  const all = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (!result) continue; // skipped block (timed out / failed) — keep the rest
    const shared = blockPrompts[i].shared;
    const list = Array.isArray(result) ? result : result.questions;
    let cur = '';
    for (const q of list || []) {
      if (q && typeof q === 'object') {
        // Attach passage/instructions to every question. Prefer the passage the
        // AI attached (first question of a group), then carry that forward to
        // the following questions of the group, and fall back to this block's
        // shared context so instructions are never lost even if the AI omitted
        // them. This is authoritative: students always see what they need.
        const p = q.passage && String(q.passage).trim();
        if (p) cur = p;
        if (!cur && shared) cur = shared;
        if (!q.passage || !String(q.passage).trim()) q.passage = cur;
      }
      const t = String((q && q.text) || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      if (t && !seen.has(t)) {
        seen.add(t);
        all.push(q);
      }
    }
  }
  return all;
}

// A numbered question line, e.g. "1. What is..." or "12) State...". Option
// lines ("A. ...") and section headers do not match.
const QUESTION_START = /^\s*\d{1,3}\s*[.)]\s+\S/;

// An answer-option line, e.g. "A. Accra", "B) Gold", "(C) Yes". Requires a
// real separator after the letter so a prose word like "Accra" or "Cape
// Coast" is not mistaken for an option.
const OPTION_START = /^\s*\(?[A-Da-d]\)?[.\-:\])]/;

// An instruction / context header line (e.g. "Section A: Comprehension",
// "Read the following passage below and answer questions 1 to 5", "Answer ONE
// question in this section", "Your answer should be between 250 and 300
// words"). These start a new context for the questions that follow, so the
// splitter breaks the document at them and each group keeps its own passage
// and instructions instead of inheriting the previous section's.
// Also matches French paper wording (English Language / French / Ghanaian
// Language comprehension sections), e.g. "Lisez le texte", "Répondez à toutes
// les questions", "Traduisez en anglais", "Écrivez une composition".
const CONTEXT_START =
  /^\s*(?:section\s*[A-Za-z0-9]|instruction|note\s*:|read\s+the|study\s+the|use\s+the|answer\s+all\s+(?:the\s+)?questions|answer\s+(?:any\s+)?(?:one|two|three)\s+(?:question|questions)|write\s+(?:an?\s+)?(?:essay|story|composition|letter)|your\s+answer\s+(?:should|must)|in\s+not\s+(?:less|more)\s+than|between\s+\d+\s+and\s+\d+\s+words|lisez\s+(?:le\s+)?(?:texte|passage)|lis\s+le\s+(?:texte|passage)|lisez\s+attentivement|r[ée]pondez?\s+(?:[àa]\s+)?toutes\s+les\s+questions|r[ée]pondez\s+aux\s+questions|r[ée]pondez\s+[àa]\s+toutes|traduis(?:ez)?\s+(?:en|into)|e?[çc]ri(?:vez|s|re)\s+(?:une|la)|compl[ée]tez|choisiss(?:ez|s))/i;

/**
 * Extract the run of trailing non-question lines from a block (passage text,
 * section headers). Answer-option lines belong to their question, so they are
 * NOT treated as trailing context: a reading passage that follows a group of
 * questions is carried to the next block, but Q5's own options stay with Q5.
 */
function trailingContext(lines) {
  let i = lines.length;
  while (i > 0) {
    const line = lines[i - 1];
    if (QUESTION_START.test(line) || OPTION_START.test(line)) break;
    i--;
  }
  return lines.slice(i);
}

/**
 * Rough count of how many questions a document contains, based on question
 * numbers ("1." / "2)" style) at line starts. Used to warn when an import
 * extracts far fewer questions than the paper clearly holds.
 */
function estimateQuestionCount(text) {
  const lines = String(text || '').split(/\r?\n/);
  return lines.filter((l) => /^\s*\d{1,3}\s*[.)]\s/.test(l)).length;
}

/** Human-readable warning, or null when the extraction looks complete. */
function completenessWarning(estimate, extracted) {
  const count = Array.isArray(extracted) ? extracted.length : 0;
  if (estimate < 3 || count * 2 >= estimate) return null;
  return `Extracted ${count} questions, but the document appears to contain ~${estimate}. Some questions (often the theory section) may have been missed.`;
}

/** Detect a leading passage/context run at the start of a block. */
function leadingContext(lines) {
  let i = 0;
  while (i < lines.length && !QUESTION_START.test(lines[i])) i++;
  return lines.slice(0, i);
}

/**
 * Split document text into blocks that only break BETWEEN questions (or at
 * section/instruction boundaries).
 *
 * Reading-comprehension papers put a passage (and instructions) in front of a
 * group of questions, and a fresh instruction line starts each new section
 * (e.g. "Read the following passage...", "Section B: Essay", "Answer ONE
 * question in this section"). Rules:
 *  - A block is never flushed before it contains its first question, so a
 *    leading passage always stays with the questions that follow it.
 *  - When a block is flushed, any trailing non-question lines (a passage or
 *    section instructions) travel WITH the next block, not the one being flushed.
 *  - A new instruction/context line after a question starts a fresh block, so
 *    the next group's passage and instructions become that block's leading
 *    context and are never glued onto the previous group.
 */
function splitIntoBlocks(text, perBlock = BLOCK_QUESTIONS, maxChars = BLOCK_MAX_CHARS) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let cur = [];
  let qCount = 0;
  let totalChars = 0;
  const flush = () => {
    if (cur.length) {
      blocks.push(cur.join('\n'));
    }
    cur = [];
    qCount = 0;
    totalChars = 0;
  };
  const startNewBlock = () => {
    const ctx = trailingContext(cur);
    cur = cur.slice(0, cur.length - ctx.length);
    flush();
    cur = ctx; // passage / instructions lead the next block
    totalChars = ctx.reduce((s, l) => s + l.length + 1, 0);
  };
  for (const line of lines) {
    const isQuestion = QUESTION_START.test(line);
    const isContext = CONTEXT_START.test(line);
    const tooBig = qCount > 0 && totalChars + line.length >= maxChars;
    const tooMany = qCount >= perBlock;
    if (tooBig || tooMany) {
      if (isQuestion) startNewBlock();
    } else if (isContext && qCount > 0) {
      // New section / passage intro after some questions: break the block here
      // so the following questions keep their own context as leading text.
      startNewBlock();
    }
    cur.push(line);
    totalChars += line.length + 1;
    if (isQuestion) qCount++;
  }
  flush();
  return blocks;
}

/** Find the answer-key section ("Answers: 1-B, 2-C ...") near the end of the doc. */
function extractAnswerKeySection(text) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (
      /^\s*(?:answers?|answer\s*key|key)\s*[:.\-]?\s*$/i.test(lines[i]) ||
      /^\s*(?:answers?|answer\s*key|key)\s*[:.\-]\s*\d+\s*[.)\-]\s*[A-Da-d]/i.test(lines[i])
    ) {
      start = i;
      break;
    }
  }
  if (start === -1) return '';
  return lines.slice(start).join('\n').slice(0, 4000);
}

/**
 * Find a marking scheme / model answers section (e.g. "MARKING SCHEME",
 * "MARKING GUIDE", "SUGGESTED ANSWERS", "MODEL ANSWERS", "SOLUTIONS"). Used to
 * reuse the paper's own rubric/model answers instead of regenerating them.
 */
function extractMarkingSchemeSection(text) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (
      /^\s*(?:marking\s*(?:scheme|guide)|(?:suggested|model|sample)\s*answers?|solutions?)\s*[:.\-]?\s*$/i.test(lines[i]) ||
      /^\s*(?:marking\s*(?:scheme|guide))\s*[:.\-]\s*\d+\s*[.)\-]/i.test(lines[i])
    ) {
      start = i;
      break;
    }
  }
  if (start === -1) return '';
  return lines.slice(start).join('\n').slice(0, 6000);
}

/**
 * Generate a marking scheme for a single theory question.
 */
async function generateTheoryScheme({ text, marks, difficulty }) {
  const system = examinerPrompt(SYSTEM_BASE + `
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
`);

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
 *
 * Answers the self-verification pass cannot CONFIRM come back with
 * correct_index: -1 — callers must leave the answer unset and flag the
 * question for review rather than store a guess that marks students wrong.
 *
 * The questions are answered in SMALL AI batches (the same strategy as PDF
 * extraction): a single request that must answer dozens of questions is slow,
 * easily truncated, and one failure loses every answer. Batching means a
 * flaky/slow endpoint loses only a handful of questions, never the whole paper.
 */
const ANSWER_BATCH = 10;
const ANSWER_CONCURRENCY = 4;
const ANSWER_TIMEOUT_MS = 4 * 60 * 1000;
const ANSWER_MAX_TOKENS = 3000;

async function answerObjectiveQuestions(questions) {
  if (!questions.length) return [];
  const system = examinerPrompt(SYSTEM_BASE + `
For each question, determine the single correct answer option. Return:
{"answers":[{"index": 0, "correct_index": 2, "explanation": "short reason"}]}
Rules:
- correct_index is the 0-based index into the options array.
- CORRECTNESS IS NON-NEGOTIABLE: only pick an answer you are CERTAIN is correct. These keys are used to grade students, so a wrong key marks innocent students wrong.
- If a question is ambiguous, has more than one defensible answer, or you are not certain, set correct_index to -1 and explain why. NEVER guess.
- Pick the objectively correct answer only when exactly one option is clearly right.
- Provide a one-sentence explanation for each.
- COMPACT OUTPUT: keep explanations to a single short sentence. Output ONLY the JSON object.
`);

  const chunks = [];
  for (let i = 0; i < questions.length; i += ANSWER_BATCH) chunks.push(questions.slice(i, i + ANSWER_BATCH));

  const answerBatch = (chunk) => async () => {
    const user = chunk
      .map((q, i) => {
        const opts = (q.options || []).map((o, j) => {
          const text = typeof o === 'string' ? o : (o && (o.text ?? o.key)) || '';
          return `  ${j}. ${text}`;
        });
        return `Q${i} (index ${q.index}):\n${q.text}\nOptions:\n${opts.join('\n')}`;
      })
      .join('\n\n');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await chatJSON(
          [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          { timeoutMs: ANSWER_TIMEOUT_MS, maxTokens: ANSWER_MAX_TOKENS, maxRetries: 0, temperature: 0.2 }
        );
        const byIndex = {};
        for (const a of result.answers || result) byIndex[a.index] = a;
        return chunk.map((q) => ({
          index: q.index,
          correct_index: byIndex[q.index] ? Number(byIndex[q.index].correct_index) : -1,
          explanation: byIndex[q.index]?.explanation || '',
        }));
      } catch (err) {
        if (attempt === 0) {
          await delay(1000);
          continue;
        }
        console.error('[ai] answer batch skipped:', err.message);
        return chunk.map((q) => ({ index: q.index, correct_index: -1, explanation: '' }));
      }
    }
  };

  const settled = await mapLimit(chunks.map(answerBatch), ANSWER_CONCURRENCY, (run) => run());
  const byIndex = {};
  for (const batch of settled) for (const a of batch) byIndex[a.index] = a;

  // Self-verification pass: independently re-check every first-pass answer.
  // This is authoritative — a second look that cannot confirm an answer voids
  // it (correct_index: -1) so the question is flagged for review, not guessed.
  const toVerify = questions
    .map((q) => ({ q, a: byIndex[q.index] }))
    .filter((x) => x.a && Number(x.a.correct_index) >= 0)
    .map((x) => ({ index: x.q.index, correct_index: x.a.correct_index, explanation: x.a.explanation || '' }));
  if (toVerify.length) {
    try {
      const verified = await verifyObjectiveAnswers(questions, toVerify);
      for (const v of verified) byIndex[v.index] = v;
    } catch (err) {
      // Verification failure keeps the first-pass answers; never fatal.
      console.error('[ai] objective answer verification failed (keeping first-pass answers):', err.message);
    }
  }

  return questions.map((q) => {
    const a = byIndex[q.index];
    return {
      index: q.index,
      correct_index: a ? Number(a.correct_index) : -1,
      explanation: a?.explanation || '',
    };
  });
}

/**
 * Determine the correct answer for a SINGLE objective question at answer time.
 * Used when a question reached a student with no stored answer key. One
 * question per call keeps latency low mid-exam. Returns correct_index: -1
 * when the examiner is not certain or the AI call fails — callers must never
 * store a guess that would mark innocent students wrong.
 */
async function resolveObjectiveAnswer({ questionText, passage, options = [] }) {
  const system = examinerPrompt(SYSTEM_BASE + `
For the single question below, determine the single correct answer option. Return:
{"correct_index": 2, "explanation": "one short sentence"}
Rules:
- correct_index is the 0-based index into the options array.
- CORRECTNESS IS NON-NEGOTIABLE: only pick an answer you are CERTAIN is correct.
- If the question is ambiguous, has more than one defensible answer, or you are not certain, set correct_index to -1 and explain why. NEVER guess.
- COMPACT OUTPUT: Output ONLY the JSON object.
`);
  const opts = options.map((o, j) => {
    const text = typeof o === 'string' ? o : (o && (o.text ?? o.key)) || '';
    return `  ${j}. ${text}`;
  });
  const user = [
    passage ? `PASSAGE:\n${passage}` : '',
    `QUESTION:\n${questionText}`,
    `Options:\n${opts.join('\n')}`,
  ].filter(Boolean).join('\n\n');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await chatJSON(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        { timeoutMs: ANSWER_TIMEOUT_MS, maxTokens: ANSWER_MAX_TOKENS, maxRetries: 0, temperature: 0.1 }
      );
      const idx = Number(result.correct_index);
      const valid = Number.isInteger(idx) && idx >= 0 && idx < options.length;
      return { correct_index: valid ? idx : -1, explanation: result.explanation || '' };
    } catch (err) {
      if (attempt === 0) {
        await delay(1000);
        continue;
      }
      console.error('[ai] resolveObjectiveAnswer failed:', err.message);
      return { correct_index: -1, explanation: '' };
    }
  }
}

/**
 * Second-pass verification of AI-generated objective answers. Confirms each
 * answer against its question and options. Answers that cannot be confirmed
 * are returned with correct_index: -1 (never guessed).
 *
 * Runs in small AI batches (like answerObjectiveQuestions): a single request
 * that must verify dozens of answers is slow, easily truncated, and a lone
 * failure voids every answer.
 */
const VERIFY_BATCH = 10;

async function verifyObjectiveAnswers(questions, answers) {
  if (!answers.length) return [];
  const system = examinerPrompt(SYSTEM_BASE + `
You are verifying an exam answer key before it is used to grade students. For each question, confirm whether the proposed correct option is genuinely and unambiguously correct.
Return:
{"answers":[{"index": 0, "correct_index": 2, "confirmed": true}]}
Rules:
- confirmed must be true ONLY when the proposed answer is certainly correct AND every other option is clearly wrong.
- If the proposed answer is wrong, ambiguous, or you are not certain, set confirmed to false and correct_index to -1.
- A wrong key marks innocent students wrong, so when in doubt, do NOT confirm.
`);

  const chunks = [];
  for (let i = 0; i < answers.length; i += VERIFY_BATCH) chunks.push(answers.slice(i, i + VERIFY_BATCH));

  const verifyBatch = (chunk) => async () => {
    const user = chunk
      .map((a) => {
        const q = questions.find((qq) => qq.index === a.index);
        const opts = (q ? q.options : []).map((o, j) => {
          const text = typeof o === 'string' ? o : (o && (o.text ?? o.key)) || '';
          return `  ${j}. ${text}`;
        });
        return (
          `Q (index ${a.index}):\n${q ? q.text : '?'}\n` +
          `Options:\n${opts.join('\n') || '(none)'}\n` +
          `Proposed correct: index ${a.correct_index}\n` +
          `Reason given: ${a.explanation || ''}`
        );
      })
      .join('\n\n');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await chatJSON(
          [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          { timeoutMs: ANSWER_TIMEOUT_MS, maxTokens: ANSWER_MAX_TOKENS, maxRetries: 0, temperature: 0.1 }
        );
        const byIndex = {};
        for (const v of result.answers || result) byIndex[v.index] = v;
        return chunk.map((a) => {
          const v = byIndex[a.index];
          const confirmed = !!(v && v.confirmed);
          return {
            index: a.index,
            correct_index: confirmed ? a.correct_index : -1,
            explanation: a.explanation || '',
          };
        });
      } catch (err) {
        if (attempt === 0) {
          await delay(1000);
          continue;
        }
        console.error('[ai] verify batch skipped:', err.message);
        return chunk.map((a) => ({ index: a.index, correct_index: -1, explanation: a.explanation || '' }));
      }
    }
  };

  const settled = await mapLimit(chunks.map(verifyBatch), ANSWER_CONCURRENCY, (run) => run());
  const merged = [];
  for (const batch of settled) merged.push(...batch);
  return merged;
}

/**
 * Detect whether a theory answer was likely written or copied from an AI
 * assistant (ChatGPT, Gemini, Claude, ...). Returns { ai_generated, ai_reason }.
 * Conservative: when unsure, ai_generated is false (benefit of the doubt —
 * accusing a genuine student is worse than missing a cheater).
 */
async function detectAiGeneratedAnswer({ questionText, studentAnswer }) {
  const system = SYSTEM_BASE + `
You detect whether a student's theory exam answer was written by the student themselves or copied from an AI assistant (e.g. ChatGPT, Gemini, Claude).

Return exactly:
{"ai_generated": boolean, "ai_reason": "short explanation"}

Signs the answer was produced by an AI:
- Suspiciously perfect: no spelling or grammar errors at all, polished generic phrasing.
- Generic AI-typical vocabulary and structure ("In conclusion", "Moreover", "It is important to note", perfectly balanced paragraphs).
- Does not reflect the specific question's wording or a student's own reasoning and voice.
- Uniformly fluent, with no signs of the student's own working or genuine attempt.

Signs it was written by the student:
- Natural unevenness, personal wording, minor imperfections, first-person reasoning, concrete personal examples.
- The answer paraphrases the question or textbook in the student's own words.

Rules:
- Be CONSERVATIVE. Only set ai_generated=true when it is MORE LIKELY THAN NOT that the text was produced or copied from an AI.
- When in doubt, set ai_generated=false. Never decide based on the answer being correct or well-written alone.
`;

  const user = `QUESTION:\n${questionText}\n\nSTUDENT ANSWER:\n${studentAnswer}`;

  const result = await chatJSON(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { temperature: 0.1 }
  );

  return {
    ai_generated: !!result.ai_generated,
    ai_reason: String(result.ai_reason || '').slice(0, 300),
  };
}

/**
 * Mark a theory answer against the scheme + rubric using AI.
 */
async function markTheory({ questionText, modelAnswer, keyPoints, rubric, presentationMarks, grammarMarks, maxMarks, studentAnswer }) {
  const system = examinerPrompt(SYSTEM_BASE + `
You are a strict but fair examiner. Mark a student's theory answer against the marking scheme.

Return exactly:
{
  "marks_awarded": number,
  "max_marks": number,
  "breakdown": [{"criterion": "...", "marks": number, "comment": "..."}],
  "feedback": "2-3 sentences of constructive feedback",
  "ai_generated": boolean,
  "ai_reason": "short explanation"
}

Rules:
- Award marks based on correctness, completeness, accuracy, relevance, use of keywords, and logical explanation.
- Award PARTIAL marks generously but fairly. Be consistent: if a rubric point is partially addressed, give partial marks.
- Presentation and grammar marks are awarded only if the writing is clear/organized and grammatically acceptable.
- marks_awarded MUST be an integer or half-integer between 0 and max_marks.
- AI-COPIED ANSWERS: Also assess whether the student answer was likely written or copied from an AI assistant (ChatGPT, Gemini, Claude). Set ai_generated=true ONLY when it is MORE LIKELY THAN NOT that it is AI-produced (suspiciously perfect, no errors, generic AI phrasing, no personal reasoning). When ai_generated is true, marks_awarded MUST be 0 and ai_reason must explain. When unsure, set ai_generated=false (benefit of the doubt).
`);

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
    aiGenerated: !!result.ai_generated,
    aiReason: String(result.ai_reason || '').slice(0, 300),
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
  mapLimit,
  EXAMINER_PERSONA,
  examinerPrompt,
  generateQuestions,
  extractQuestionsFromText,
  answerObjectiveQuestions,
  resolveObjectiveAnswer,
  verifyObjectiveAnswers,
  detectAiGeneratedAnswer,
  generateTheoryScheme,
  markTheory,
  splitIntoBlocks,
  leadingContext,
  trailingContext,
  estimateQuestionCount,
  completenessWarning,
  extractAnswerKeySection,
  extractMarkingSchemeSection,
  parseJSON,
  repairTruncatedJSON,
};
