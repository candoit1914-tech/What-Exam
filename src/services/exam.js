const db = require('../db');
const config = require('../config');
const wa = require('./whatsapp');
const marking = require('./marking');
const results = require('./results');
const certificate = require('./certificate');
const ai = require('./ai');
const { stripSourceWatermarks } = require('./textClean');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Background session work ─────────────────────────────────────────────
//
// AI examiner work (objective key resolution, AI-copy detection) runs in the
// BACKGROUND so it never delays sending the next question. The student's
// answer is recorded immediately and the work is tracked per session; it MUST
// be drained before the exam is finalized so grades are complete when results
// are computed.
const sessionTasks = new Map();

function trackSessionTask(sessionId, promise) {
  if (!sessionTasks.has(sessionId)) sessionTasks.set(sessionId, new Set());
  const set = sessionTasks.get(sessionId);
  set.add(promise);
  promise
    .catch(() => {}) // a background failure must never crash the process
    .finally(() => {
      set.delete(promise);
      if (!set.size) sessionTasks.delete(sessionId);
    });
  return promise;
}

/** Wait for all background AI work of a session to settle. */
async function drainSession(sessionId) {
  const set = sessionTasks.get(sessionId);
  if (!set || !set.size) return;
  await Promise.allSettled([...set]);
}

// ── Students ───────────────────────────────────────────────────────────

function normalizePhone(raw) {
  let p = String(raw || '').replace(/[^\d]/g, '');
  if (!p) return '';
  // International dialing prefix 00 is equivalent to +; drop it.
  if (p.startsWith('00')) p = p.slice(2);
  // Already international (has a country code). Keep it, but strip a stray
  // national-prefix 0 right after the country code (e.g. 2330269200946).
  if (p.startsWith('233') || p.startsWith('234') || p.startsWith('1')) {
    const cc = p.startsWith('234') ? '234' : p.startsWith('233') ? '233' : '1';
    const national = p.slice(cc.length);
    if (/^0\d/.test(national)) return cc + national.slice(1);
    return cc + national;
  }
  // Local number with a leading 0 (Ghana 0XX + 7 = 10 digits, Nigeria 0XX + 8 = 11 digits).
  if (p.startsWith('0')) {
    p = p.slice(1);
    if (p.length === 9) return '233' + p; // Ghana local (0XX...) -> +233
    if (p.length === 10) return '234' + p; // Nigeria local (0XX...) -> +234
    return '233' + p; // conservative default: assume Ghana
  }
  // National number already missing its leading 0.
  if (p.length === 9) return '233' + p; // Ghana
  if (p.length === 10) return '234' + p; // Nigeria
  return p; // already international (with country code, incl. 1, 233, 234, ...)
}

function getOrCreateStudent(phone) {
  let s = db.prepare('SELECT * FROM students WHERE phone = ?').get(phone);
  if (!s) {
    const info = db.prepare('INSERT INTO students (phone) VALUES (?)').run(phone);
    s = db.prepare('SELECT * FROM students WHERE id = ?').get(info.lastInsertRowid);
  }
  return s;
}

// ── Sessions ───────────────────────────────────────────────────────────

function getActiveSession(studentId) {
  return db
    .prepare(
      `SELECT s.*, e.title AS exam_title, e.duration_minutes, e.pass_percentage
       FROM sessions s JOIN exams e ON e.id = s.exam_id
       WHERE s.student_id = ? AND s.status = 'in_progress'`
    )
    .get(studentId);
}

function sessionHasNoAnswers(sessionId) {
  return db.prepare('SELECT COUNT(*) c FROM answers WHERE session_id = ?').get(sessionId).c === 0;
}

function createSession(examId, studentId) {
  const info = db
    .prepare('INSERT INTO sessions (exam_id, student_id) VALUES (?, ?)')
    .run(examId, studentId);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid);
  drawSessionQuestions(session.id, examId);
  return session;
}

/**
 * Assign a fresh question set for an attempt. When the exam has a question
 * pool, each session draws it in the uploaded PDF order (pool rows are
 * inserted in that order). If the pool is smaller than the exam's question
 * count, missing template questions are
 * COPIED into the pool first (with their marking scheme) so every session
 * presents the full exam. Copies keep session_questions.question_id pointing
 * at question_pool rows, which its FK constraint requires.
 */
function drawSessionQuestions(sessionId, examId) {
  const n = db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(examId).c;
  if (!n) return 0;
  const pool = db.prepare('SELECT id, text FROM question_pool WHERE exam_id = ?').all(examId);
  if (pool.length < n) topUpPool(examId, pool, n);
  // Present the paper in the uploaded PDF order (pool rows are inserted in that
  // order), never shuffled.
  const ids = db.prepare('SELECT id FROM question_pool WHERE exam_id = ? ORDER BY id').all(examId);
  const chosen = ids.slice(0, n);
  const ins = db.prepare(
    'INSERT INTO session_questions (session_id, question_id, q_order) VALUES (?,?,?)'
  );
  chosen.forEach((p, i) => ins.run(sessionId, p.id, i + 1));
  return chosen.length;
}

/** Copy template questions into the pool until it holds at least `target` rows. */
function topUpPool(examId, currentPool, target) {
  const inPool = new Set(currentPool.map((r) => String(r.text || '').trim()));
  const templates = db.prepare('SELECT * FROM questions WHERE exam_id = ? ORDER BY q_order').all(examId);
  const insertPool = db.prepare(
    `INSERT INTO question_pool (exam_id, type, text, passage, options, correct_answer, marks, difficulty, learning_objective, explanation, scheme_json, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  let added = 0;
  for (const t of templates) {
    if (currentPool.length + added >= target) break;
    const text = String(t.text || '').trim();
    if (inPool.has(text)) continue; // already represented in the pool
    const scheme = db.prepare('SELECT scheme FROM marking_schemes WHERE question_id = ?').get(t.id);
    insertPool.run(
      examId, t.type, t.text, t.passage || '', t.options || null, t.correct_answer || null,
      t.marks, t.difficulty || 'medium', t.learning_objective || '', t.explanation || '',
      scheme ? scheme.scheme : '', t.source || 'manual'
    );
    inPool.add(text);
    added++;
  }
}

/**
 * Resolve the question a session is on. Sessions with a drawn set read from
 * question_pool via session_questions; all other sessions use the exam's
 * template questions (original behavior).
 */
function getSessionQuestion(sessionId, qOrder) {
  const mapped = db
    .prepare('SELECT question_id FROM session_questions WHERE session_id = ? AND q_order = ?')
    .get(sessionId, qOrder);
  if (mapped) {
    const row = db.prepare('SELECT * FROM question_pool WHERE id = ?').get(mapped.question_id);
    if (row) {
      row._pool = true;
      row.q_order = qOrder;
      return row;
    }
  }
  const s = db.prepare('SELECT exam_id FROM sessions WHERE id = ?').get(sessionId);
  return s
    ? db.prepare('SELECT * FROM questions WHERE exam_id = ? AND q_order = ?').get(s.exam_id, qOrder)
    : null;
}

/** Number of questions drawn for this attempt (0 = template questions used). */
function getSessionQuestionCount(sessionId) {
  return db.prepare('SELECT COUNT(*) c FROM session_questions WHERE session_id = ?').get(sessionId).c;
}

/** Ordered questions this session presents, in the order the student sees them. */
function sessionQuestionSequence(session) {
  const s = db.prepare('SELECT exam_id FROM sessions WHERE id = ?').get(session.id);
  if (!s) return [];
  const drawn = db
    .prepare('SELECT q_order, question_id FROM session_questions WHERE session_id = ? ORDER BY q_order')
    .all(session.id);
  if (drawn.length) {
    const get = db.prepare('SELECT * FROM question_pool WHERE id = ?');
    return drawn
      .map((m) => {
        const row = get.get(m.question_id);
        if (row) {
          row._pool = true;
          row.q_order = m.q_order;
        }
        return row;
      })
      .filter(Boolean);
  }
  return db.prepare('SELECT * FROM questions WHERE exam_id = ? ORDER BY q_order').all(s.exam_id);
}

/**
 * The question a session presents after `question`, in presentation order.
 * Returns null when the current question is last. If the current question is
 * not part of the sequence (should not happen), falls back to q_order + 1 so
 * behavior degrades gracefully instead of finalizing early.
 */
function nextInSequence(session, question) {
  const seq = sessionQuestionSequence(session);
  const i = seq.findIndex((q) => q.id === question.id);
  if (i === -1) return getSessionQuestion(session.id, question.q_order + 1);
  return seq[i + 1] || null;
}

function deadline(session) {
  return new Date(new Date(session.started_at).getTime() + session.duration_minutes * 60000);
}

// ── Formatting helpers ─────────────────────────────────────────────────

const START_WORDS = new Set([
  'start',
  'begin',
  'hi',
  'hello',
  'hey',
  'ok',
  'okay',
  'yes',
  'ready',
  'go',
  'yo',
  'test',
]);

function formatQuestion(exam, question, qCount, body) {
  // The type banner and any passage/instruction/header are sent as their own
  // bubbles by buildQuestionBubbles, so the question bubble carries just the
  // stem (optionally pre-stripped of leading section headers).
  const text = body != null ? body : String(question.text || '').trim();
  return `*QUESTION ${question.q_order}*\n\n${text}`;
}

/** mm:ss left on the clock, computed from the session start + exam duration. */
function timeRemaining(session, exam) {
  const ms = new Date(session.started_at).getTime() + exam.duration_minutes * 60000 - Date.now();
  const total = Math.max(0, Math.round(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

// Paper-only exam instructions (shading, booklets, margins, ink) make no sense
// in a typed chat. A sentence is dropped only when it BOTH reads like an
// instruction AND names a physical-paper mechanic, so comprehension prose that
// happens to mention "pencil" is never corrupted.
const PAPER_ONLY =
  /\bshad(?:e|e in|ing)\b|\bpencil\b|\bpen\b|\bH\s*B\b|\banswer\s+(?:booklet|sheet|grid)\b|\bmargins?\b|\bruled\s+lines?\b|\brough\s+work\b|\b(?:blue|black)\s+ink\b|\btick\b|\bcross\s+out\b|\b(circle|ring|underline)\b|\bfill\s+in\b|\bdo\s+not\s+write\b|\bquestion\s+paper\b/i;
const INSTRUCTION_START =
  /^(write|shade|use|tick|cross|circle|ring|underline|fill|answer|do not|don't|ensure|make sure|remember|leave|erase|rub)/i;
const INSTRUCTION_PHRASE = /(your\s+answers?|answer\s+(sheet|booklet|grid|paper)|should\s+be|in\s+the\s+box)/i;

function stripPaperOnlyInstructions(text) {
  const segments = String(text || '')
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return segments
    .filter((s) => !((INSTRUCTION_START.test(s) || INSTRUCTION_PHRASE.test(s)) && PAPER_ONLY.test(s)))
    .join('\n');
}

// Section instructions live in the first question's passage field. Pull the
// leading instruction-like lines ("Read the passage…", "Answer ONE question…")
// into their own bubble so they are not jammed against the header, and leave
// the reading passage itself separate.
const SECTION_INSTRUCTION = [
  /^read\b/i,
  /between\s+\d+\s+and\s+\d+\s+words/i,
  /question(s)?\s+(\d+\s*(-|to)\s+)?\d+/i,
  /in\s+this\s+section/i,
];

// An essay prompt that starts with "write" (e.g. "Write about the importance
// of education.") is deliberately classified as an instruction, not passage —
// the prompt is what the student must produce, so it belongs in the section
// instructions.
function isInstructionLine(line) {
  return INSTRUCTION_START.test(line) || INSTRUCTION_PHRASE.test(line) ||
    SECTION_INSTRUCTION.some((re) => re.test(line));
}

function splitSectionMeta(text) {
  const lines = String(text || '')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const instructions = [];
  for (const line of lines) {
    if (isInstructionLine(line)) instructions.push(line);
    else break; // real prose starts here; never strip mid-passage
  }
  return {
    instructions: instructions.join('\n'),
    passage: lines.slice(instructions.length).join('\n'),
  };
}

// Section headers extracted from the PDF (e.g. "PART A, LEXIS AND STRUCTURE",
// "SECTION B", "OBJECTIVE", "THEORY") are ALL-CAPS or "Section/Part …" lines of
// at most a few words. They must be delivered as their own chat bubble, never
// jammed onto a question or instruction. Instruction lines never qualify.
const SECTION_HEADER_START = /^(section\s+[a-z]|part\s+[a-z]|objective\b|theory\b)/i;

function isSectionHeader(line) {
  const t = String(line).trim();
  if (!t || isInstructionLine(t)) return false;
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length < 3) return false; // "Q1", "A", "(a)" are labels, not headers
  const upperRatio = t.replace(/[^A-Z]/g, '').length / letters.length;
  const allCaps = upperRatio >= 0.75;
  return (allCaps || SECTION_HEADER_START.test(t)) && t.split(/\s+/).length <= 6;
}

/**
 * Pull leading section headers out of question text or passage so they can be
 * sent as their own bubble. Returns `{ headings, body }` where `body` is the
 * text with those leading header lines removed.
 */
function splitQuestionHeadings(text) {
  const lines = String(text || '')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const headings = [];
  for (const line of lines) {
    if (isSectionHeader(line)) headings.push(line);
    else break;
  }
  return { headings, body: lines.slice(headings.length).join('\n') };
}

function formatSectionHeader(type) {
  return `*${type}*`;
}

function formatSectionInstructions(instructions) {
  return `*Instructions*\n\n${instructions}`;
}

/**
 * The chat bubbles to send for one question: a section header (once per type,
 * before the first of its kind), the section instructions and reading passage
 * as separate bubbles (once, before the first question that uses them), then
 * the question bubble. "Already sent" is derived from the questions that
 * precede this one in the sequence, so resume/nudge re-sends never duplicate
 * headers, instructions, or passages.
 */
function buildQuestionBubbles(exam, question, sequence, index) {
  const bubbles = [];
  const type = question.type === 'theory' ? 'THEORY' : 'OBJECTIVE';
  const prev = index > 0 ? sequence.slice(0, index) : [];
  const firstOfType = !prev.some((q) => q.type === question.type);
  if (firstOfType) bubbles.push(formatSectionHeader(type));

  const clean = (p) => stripPaperOnlyInstructions(stripSourceWatermarks(p)).trim();
  // Dedupe keys are normalized (case + whitespace) so the same instruction or
  // passage is never sent twice just because extraction differed in spacing.
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const seen = { instructions: new Set(), passages: new Set(), headings: new Set() };
  for (const q of prev) {
    const pClean = clean(q.passage);
    const pRest = splitQuestionHeadings(pClean).body;
    const { instructions: pIns, passage: pPas } = splitSectionMeta(pRest);
    seen.instructions.add(norm(pIns));
    seen.passages.add(norm(pPas));
    splitQuestionHeadings(pClean).headings.forEach((h) => seen.headings.add(h));
    splitQuestionHeadings(String(q.text || '').trim()).headings.forEach((h) => seen.headings.add(h));
  }

  // Section headers, instructions and the reading passage lead the block as
  // separate bubbles (each once across the sequence), then the question.
  const pClean = clean(question.passage);
  const { headings: pHead, body: pRest } = splitQuestionHeadings(pClean);
  const { instructions, passage } = splitSectionMeta(pRest);
  for (const h of pHead) {
    if (!seen.headings.has(h)) {
      bubbles.push(`*${h}*`);
      seen.headings.add(h);
    }
  }
  const insKey = norm(instructions);
  if (instructions && !seen.instructions.has(insKey)) {
    bubbles.push(formatSectionInstructions(instructions));
    seen.instructions.add(insKey);
  }
  const pasKey = norm(passage);
  if (passage && !seen.passages.has(pasKey)) {
    bubbles.push(passage);
    seen.passages.add(pasKey);
  }

  const textClean = String(question.text || '').trim();
  const { headings: tHead, body } = splitQuestionHeadings(textClean);
  for (const h of tHead) {
    if (!seen.headings.has(h)) {
      bubbles.push(`*${h}*`);
      seen.headings.add(h);
    }
  }
  bubbles.push(formatQuestion(exam, question, sequence.length, body));
  return bubbles;
}

/** Answer-options message for objective questions (sent right after the question). */
function formatOptions(exam, session, question) {
  const options = JSON.parse(question.options || '[]');
  const body = options.map((o) => `${o.key}. ${o.text}`).join('\n');
  return (
    `${body}\n\n` +
    `Reply with the letter of your answer.\n\n` +
    `Time remaining: *${timeRemaining(session, exam)}*`
  );
}

function examTypeOf(examId) {
  const types = db
    .prepare('SELECT DISTINCT type AS t FROM questions WHERE exam_id = ?')
    .all(examId)
    .map((r) => r.t);
  if (types.length === 0) return 'Exam';
  if (types.length === 1) return types[0] === 'objective' ? 'Objective' : 'Theory';
  return 'Mixed';
}

function formatExamIntro(exam, questionCount) {
  const type = examTypeOf(exam.id);
  const steps = [
    'Questions arrive one at a time.',
    type === 'Theory'
      ? 'Type your full answer to each question as a single message. Theory answers are marked at the end of the exam.'
      : 'After each question, its answer options are sent in a separate message; reply with the letter of your answer (e.g. *A*).',
    'Answers are locked once you send them.',
    'Your timer starts now. The exam ends automatically when time is up.',
    'Copying AI-written answers (e.g. ChatGPT, Gemini) is cheating — such answers are detected and earn 0 marks.',
  ];
  const instructions = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return (
    `*${String(exam.title).toUpperCase()}*\n\n` +
    `Subject: *${exam.subject || 'General'}*\n` +
    `Exam type: *${type}*\n` +
    `Duration: *${exam.duration_minutes} minute${exam.duration_minutes === 1 ? '' : 's'}*\n` +
    `Number of questions: *${questionCount}*\n` +
    `Pass mark: *${exam.pass_percentage}%*\n\n` +
    `Reply *START* to this chat to open it - your exam begins instantly.\n\n` +
    `*INSTRUCTIONS*\n${instructions}`
  );
}

/** Resolve a student's objective answer from a tap (replyId), a letter, or full option text. */
function resolveObjectiveLetter(question, body, meta = {}) {
  if (meta.replyId) {
    const l = marking.normalizeAnswer(meta.replyId).replace(/\.$/, '');
    if (/^[A-D]$/.test(l)) return l;
  }
  const letter = marking.normalizeAnswer(body).replace(/\.$/, '');
  if (/^[A-D]$/.test(letter)) return letter;
  const options = JSON.parse(question.options || '[]');
  const hit = options.find((o) => marking.normalizeAnswer(o.text) === marking.normalizeAnswer(body));
  return hit ? hit.key : null;
}

/** Reset a session to a fresh attempt (wipes previous answers + result). */
function restartSession(session) {
  db.prepare('DELETE FROM answers WHERE session_id = ?').run(session.id);
  db.prepare('DELETE FROM session_questions WHERE session_id = ?').run(session.id);
  db.prepare(
    `UPDATE sessions SET status='in_progress', current_q_order=1, started_at=datetime('now'),
       last_active_at=datetime('now'), ended_at=NULL, final_score=0, final_percentage=0, passed=0
     WHERE id = ?`
  ).run(session.id);
  const fresh = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
  drawSessionQuestions(fresh.id, fresh.exam_id);
  return fresh;
}

/** Human-friendly summary of a WhatsApp send error. */
function friendlyError(err) {
  const msg = (err && (err.message || String(err))) || 'Unknown error';
  const code = err && err.code;
  if (msg.includes('131056') || code === 131056) {
    return 'WhatsApp briefly limited how fast this number can be messaged. Wait a few seconds and send your answer again.';
  }
  if (msg.includes('131026') || code === 131026) {
    return 'No open 24h session for this number. The student must message your WhatsApp number once first, or set WHATSAPP_TEMPLATE_NAME to an approved template for first-contact delivery.';
  }
  if (msg.includes('131047') || msg.includes('131048') || code === 131047 || code === 131048) {
    return 'WhatsApp re-engagement limit: this number has not messaged your bot recently. Ask the student to message your WhatsApp number once, or configure an approved template (WHATSAPP_TEMPLATE_NAME).';
  }
  if (msg.includes('132000') || msg.includes('131030') || msg.includes('131043') || code === 132000 || code === 131030 || code === 131043) {
    return `Template issue (${code || 'unknown'}${err && err.metaCode ? ': ' + err.metaCode : ''}). Create/approve the template in the Meta dashboard, then set WHATSAPP_TEMPLATE_NAME.`;
  }
  return msg;
}

async function sendQuestionTo(session, student) {
  session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(session.exam_id);
  if (!exam || (exam.status !== 'published' && exam.status !== 'live')) {
    await wa.sendText(student.phone, `The exam for this session is no longer active. No more questions will be sent.`);
    return false;
  }
  const question = getSessionQuestion(session.id, session.current_q_order);
  if (!question) {
    await finalize(session, student);
    return false;
  }
  const sequence = sessionQuestionSequence(session);
  const index = sequence.findIndex((q) => q.id === question.id);
  for (const bubble of buildQuestionBubbles(exam, question, sequence, index)) {
    await wa.sendText(student.phone, bubble);
  }
  if (question.type === 'objective') {
    await wa.sendText(student.phone, formatOptions(exam, session, question));
  }
  return true;
}

// ── Entry point for inbound WhatsApp messages ──────────────────────────

async function handleInbound(phone, body, meta = {}) {
  const student = getOrCreateStudent(phone);
  let session = getActiveSession(student.id);

  if (!session) {
    const started = await maybeStartSession(student);
    return { started: true, ok: started.ok, reason: started.reason };
  }

  // Bulk-sent sessions are created the moment the admin clicks Send, but the
  // timer must start when the student actually engages. A session that has no
  // answers yet restarts its clock on the first inbound message, so a late
  // starter is never greeted by a countdown that already ran down (e.g. the
  // 59:57 → 6:47 jump from sending hours after the admin pressed Send).
  if (sessionHasNoAnswers(session.id)) {
    db.prepare(
      `UPDATE sessions SET started_at = datetime('now'), last_active_at = datetime('now') WHERE id = ?`
    ).run(session.id);
    session = getActiveSession(student.id);
  }

  // Timer check
  const now = Date.now();
  const dl = deadline(session);
  if (now > dl.getTime()) {
    await finalize(session, student, 'expired');
    return { started: false, ok: true, reason: 'expired' };
  }

  await processAnswer(session, student, body, meta);
  return { started: false, ok: true, reason: 'answered' };
}

async function maybeStartSession(student) {
  const candidates = db
    .prepare(
      `SELECT e.* FROM exams e
       JOIN exam_recipients r ON r.exam_id = e.id
       WHERE r.student_id = ? AND e.status IN ('published','live')
       ORDER BY e.published_at DESC`
    )
    .all(student.id);

  if (candidates.length === 0) {
    const ended = db
      .prepare(
        `SELECT e.title FROM sessions s JOIN exams e ON e.id = s.exam_id
         WHERE s.student_id = ? AND s.status = 'ended'
         ORDER BY s.ended_at DESC LIMIT 1`
      )
      .get(student.id);
    if (ended) {
      await wa.sendText(student.phone, `The exam *${ended.title}* has been ended. No more questions will be sent.`);
      return { ok: false, reason: 'ended' };
    }
    await wa.sendText(
      student.phone,
      `Hi! 👋 You have no pending exams right now. If an exam has been sent to you, reply to it to begin.`
    );
    return { ok: false, reason: 'no_exam' };
  }

  const exam = candidates[0];
  const existing = db
    .prepare('SELECT * FROM sessions WHERE exam_id = ? AND student_id = ?')
    .get(exam.id, student.id);

  if (existing && existing.status === 'in_progress') {
    await sendQuestionTo(existing, student);
    return { ok: true, reason: 'resumed' };
  }
  if (existing && existing.status === 'completed') {
    const r = results.computeForSession(existing.id);
    await wa.sendText(
      student.phone,
      `You already finished *${exam.title}* with *${r.score}/${r.totalMarks}* (${r.percentage}%). Ask your admin to send it again if you want to retake.`
    );
    return { ok: false, reason: 'already_done' };
  }
  if (existing && existing.status === 'expired') {
    await wa.sendText(
      student.phone,
      `⏰ Your time for *${exam.title}* has ended. Ask your admin to send it again if you want to retake.`
    );
    return { ok: false, reason: 'expired' };
  }

  let session;
  if (existing && existing.status === 'abandoned') {
    session = restartSession(existing);
  } else {
    session = createSession(exam.id, student.id);
  }

  const questionCount =
    getSessionQuestionCount(session.id) ||
    db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(exam.id).c;
  await wa.sendText(student.phone, formatExamIntro(exam, questionCount));
  const sent = await sendQuestionTo(session, student).catch(async (err) => {
    await wa.sendText(student.phone, `Could not start "${exam.title}" right now. Please try again shortly.`);
    return false;
  });
  if (sent) {
    await db.prepare(`UPDATE sessions SET last_active_at = datetime('now') WHERE id = ?`).run(session.id);
  } else {
    db.prepare(`UPDATE sessions SET status = 'abandoned', ended_at = datetime('now') WHERE id = ?`).run(session.id);
  }
  return { ok: sent, reason: sent ? 'started' : 'send_failed' };
}

// ── Answer processing ──────────────────────────────────────────────────

async function processAnswer(session, student, body, meta = {}) {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(session.exam_id);
  const question = getSessionQuestion(session.id, session.current_q_order);
  if (!question) return;

  // A casual greeting is not an answer — resend the question instead of marking it wrong.
  if (question.type === 'objective' && !meta.replyId) {
    const trimmed = body.trim().toLowerCase();
    if (!resolveObjectiveLetter(question, body, meta) && START_WORDS.has(trimmed)) {
      await wa.sendText(
        student.phone,
        '🚀 Let\u2019s go! Read the question and type the letter of your answer (A, B, C or D).'
      );
      await sendQuestionTo(session, student);
      return;
    }
  }

  const already = db
    .prepare('SELECT id FROM answers WHERE session_id = ? AND question_id = ?')
    .get(session.id, question.id);
  if (already) {
    let nq = nextInSequence(session, question);
    while (
      nq &&
      db.prepare('SELECT id FROM answers WHERE session_id = ? AND question_id = ?').get(session.id, nq.id)
    ) {
      nq = nextInSequence(session, nq);
    }
    if (nq) {
      db.prepare('UPDATE sessions SET current_q_order = ? WHERE id = ?').run(nq.q_order, session.id);
      await sendQuestionTo(session, student);
    } else {
      await finalize(session, student, 'completed');
    }
    return;
  }

  const next = await handleAnswer(exam, session, student, question, body, meta);
  if (next === false) return; // invalid input, question re-sent

  // advance
  const nextQ = nextInSequence(session, question);
  if (nextQ) {
    db.prepare(
      `UPDATE sessions SET current_q_order = ?, last_active_at = datetime('now') WHERE id = ?`
    ).run(nextQ.q_order, session.id);
    await sendQuestionTo(session, student);
  } else {
    await finalize(session, student, 'completed');
  }
}

async function handleAnswer(exam, session, student, question, body, meta = {}) {
  if (question.type === 'objective') {
    const letter = resolveObjectiveLetter(question, body, meta);
    if (!letter) {
      await wa.sendText(
        student.phone,
        '⚠️ That doesn\u2019t look like an answer.\n\nType the letter of your answer (e.g. *A*).'
      );
      return false;
    }
    // No verified answer key stored → the AI examiner determines the answer in
    // the BACKGROUND (never blocking the next question), persists it for
    // results and future answers, and grades this answer. A genuinely
    // uncertain examiner or an AI failure records 0 marks with a neutral note
    // — never pending admin review. drainSession() guarantees this finishes
    // before the exam is finalized.
    if (!marking.resolveCorrectKey(question)) {
      const options = JSON.parse(question.options || '[]');
      db.prepare(
        `INSERT INTO answers (session_id, question_id, q_order, answer_text, is_correct, marks_awarded, max_marks, marked_by, ai_feedback, needs_review, marked_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))`
      ).run(
        session.id, question.id, question.q_order, letter,
        0, 0, question.marks, 'pending',
        'Answer key being resolved by the AI examiner.', 0
      );
      trackSessionTask(session.id, (async () => {
        let resolved = null;
        try {
          resolved = await ai.resolveObjectiveAnswer({
            questionText: question.text,
            passage: question.passage || '',
            options,
          });
        } catch (e) {
          resolved = null;
        }
        const idx = resolved ? Number(resolved.correct_index) : -1;
        const key = options[idx] ? String(options[idx].key || '').toUpperCase() : null;

        if (key && idx >= 0) {
          if (question._pool) {
            db.prepare('UPDATE question_pool SET correct_answer = ? WHERE id = ?').run(key, question.id);
          } else {
            db.prepare('UPDATE questions SET correct_answer = ? WHERE id = ?').run(key, question.id);
            db.prepare(
              `INSERT INTO marking_schemes (question_id, type, scheme) VALUES (?, 'objective', ?)
               ON CONFLICT(question_id) DO UPDATE SET scheme=excluded.scheme, updated_at=datetime('now')`
            ).run(question.id, JSON.stringify({
              type: 'objective',
              correct_answer: key,
              marks: question.marks,
              explanation: resolved?.explanation || '',
            }));
          }
          const result = marking.markObjective({ ...question, correct_answer: key }, letter);
          db.prepare(
            `UPDATE answers SET is_correct=?, marks_awarded=?, marked_by='ai', ai_feedback=?, needs_review=0, marked_at=datetime('now')
             WHERE session_id=? AND question_id=?`
          ).run(
            result.isCorrect ? 1 : 0, result.marksAwarded,
            `Answer key determined by the AI examiner: ${key}.`,
            session.id, question.id
          );
        } else {
          db.prepare(
            `UPDATE answers SET is_correct=0, marks_awarded=0, marked_by='ai', ai_feedback='The examiner could not determine the answer to this question.', needs_review=0, marked_at=datetime('now')
             WHERE session_id=? AND question_id=?`
          ).run(session.id, question.id);
        }
      })());
      return true;
    }
    const result = marking.markObjective(question, letter);
    const saved = db
      .prepare(
        `INSERT INTO answers (session_id, question_id, q_order, answer_text, is_correct, marks_awarded, max_marks, marked_by, marked_at)
         VALUES (?,?,?,?,?,?,?,?,datetime('now'))`
      )
      .run(
        session.id, question.id, question.q_order, letter,
        result.isCorrect ? 1 : 0, result.marksAwarded, result.maxMarks, 'auto'
      );

    // No per-question feedback — answers are only revealed with the grade
    // after the final question (per product requirement).
  } else {
    // Theory — the answer is stored immediately but NOT marked yet. All theory
    // answers are AI-marked together when the exam ends. A quick AI-copy check
    // runs in the BACKGROUND so it never delays the next question; a positive
    // result cautions the student right away and locks the answer to 0 marks.
    // The detection always finishes before the exam is finalized (drainSession).
    const answerText = body;
    const context = [question.passage, question.text].filter(Boolean).join('\n\n');
    db.prepare(
      `INSERT INTO answers (session_id, question_id, q_order, answer_text, is_correct, marks_awarded, max_marks, marked_by, ai_feedback, needs_review, ai_detected)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      session.id, question.id, question.q_order, answerText,
      null, 0, question.marks, 'pending', '', 0, 0
    );

    if (ai.aiConfigured()) {
      trackSessionTask(session.id, (async () => {
        let aiDetected = 0;
        let caution = '';
        try {
          const det = await ai.detectAiGeneratedAnswer({ questionText: context, studentAnswer: answerText });
          if (det.ai_generated) {
            aiDetected = 1;
            caution =
              `⚠️ *Warning: AI-written answer detected*\n\n` +
              `Your answer to Question ${question.q_order} looks like it was written by an AI (e.g. ChatGPT, Gemini, Claude) and copied in.\n\n` +
              `Copying AI answers is considered *cheating* in this exam, so this answer will earn *0 marks*.\n\n` +
              `Please answer the remaining questions yourself.`;
          }
        } catch (e) {
          aiDetected = 0; // detection failure never blocks the exam
        }
        if (aiDetected) {
          db.prepare(
            `UPDATE answers SET ai_detected=1, ai_feedback=?, needs_review=0 WHERE session_id=? AND question_id=?`
          ).run(caution, session.id, question.id);
          try {
            await wa.sendText(student.phone, caution);
          } catch (err) {
            // the caution is best-effort; the 0-mark cap is already applied
          }
        }
      })());
    }
  }
  return true;
}

// ── Finalize ───────────────────────────────────────────────────────────

/**
 * AI-mark every pending theory answer for a session at the end of the exam.
 * Runs together (concurrency-capped) so the student gets one complete result.
 * - Answers flagged as AI-copied (inline or by the marker) are capped at 0.
 * - A marking failure retries once, then records 0 marks with a note — it
 *   never blocks results or leaves an answer pending admin review.
 */
async function markAllPendingTheory(sessionId) {
  const pending = db
    .prepare(`SELECT * FROM answers WHERE session_id = ? AND marked_by = 'pending' ORDER BY q_order`)
    .all(sessionId);
  if (!pending.length) return;

  const tasks = pending.map((a) => async () => {
    const question = getSessionQuestion(sessionId, a.q_order);
    if (!question) return;
    let scheme = null;
    if (question._pool) {
      try {
        scheme = JSON.parse(question.scheme_json || '{}');
      } catch {
        scheme = null;
      }
    }
    let marked;
    try {
      marked = await marking.markTheoryAnswer(question, a.answer_text, scheme);
    } catch (err) {
      await delay(1000);
      try {
        marked = await marking.markTheoryAnswer(question, a.answer_text, scheme);
      } catch (err2) {
        db.prepare(
          `UPDATE answers SET marked_by='ai', marks_awarded=0, needs_review=0, ai_feedback='The examiner could not mark this answer; 0 marks were recorded.', marked_at=datetime('now') WHERE id=?`
        ).run(a.id);
        return;
      }
    }
    const detected = !!marked.aiGenerated || Number(a.ai_detected) === 1;
    const feedback = detected
      ? `⚠️ AI-written answer detected — 0 marks awarded (copying AI answers is cheating). ${marked.feedback || marked.aiReason}`.trim()
      : marked.feedback;
    db.prepare(
      `UPDATE answers SET marked_by='ai', marks_awarded=?, ai_feedback=?, needs_review=?, ai_detected=?, marked_at=datetime('now') WHERE id=?`
    ).run(detected ? 0 : marked.marksAwarded, feedback, detected ? 1 : 0, detected ? 1 : 0, a.id);
  });

  await ai.mapLimit(tasks, 3, (run) => run());
}

async function finalize(session, student, reason = 'completed') {
  if (session.status !== 'in_progress') return;
  await drainSession(session.id); // background AI work must finish before results are computed
  await markAllPendingTheory(session.id);
  const result = results.computeForSession(session.id);
  db.prepare(
    `UPDATE sessions SET status = ?, ended_at = datetime('now'), final_score = ?, final_percentage = ?, passed = ?
     WHERE id = ?`
  ).run(reason, result.score, result.percentage, result.passed ? 1 : 0, session.id);

  await results.sendResultMessage(session.id, student.phone, reason);

  if (config.exam.sendCertificates) {
    try {
      const png = await certificate.renderCertificatePng({
        studentName: student.name || student.phone,
        examTitle: result.exam.title,
        subject: result.exam.subject,
        date: new Date(),
        score: result.score,
        totalMarks: result.totalMarks,
        percentage: result.percentage,
        passed: result.passed,
      });
      await wa.sendImage(student.phone, png);
    } catch (err) {
      // certificate is a bonus — never break the finalize flow
      console.error(`Certificate send failed for ${student.phone}:`, err.message);
    }
  }
}

// ── Admin: end an exam ─────────────────────────────────────────────────

/** End an exam from the app: closes the exam and stops every active session immediately. */
async function endExam(examId) {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
  if (!exam) throw new Error('Exam not found');
  if (exam.status !== 'live' && exam.status !== 'published') {
    throw new Error('Exam is not live.');
  }
  db.prepare(`UPDATE exams SET status='ended', ended_at = datetime('now') WHERE id = ?`).run(examId);

  const active = db
    .prepare(
      `SELECT s.id, st.phone FROM sessions s JOIN students st ON st.id = s.student_id
       WHERE s.exam_id = ? AND s.status = 'in_progress'`
    )
    .all(examId);

  const notice =
    `*${String(exam.title).toUpperCase()}*\n\n` +
    `This exam has been ended by your administrator. No more questions will be sent.`;

  for (const s of active) {
    await drainSession(s.id);
    await markAllPendingTheory(s.id);
    const result = results.computeForSession(s.id);
    db.prepare(
      `UPDATE sessions SET status='ended', ended_at=datetime('now'), final_score=?, final_percentage=?, passed=? WHERE id=?`
    ).run(result.score, result.percentage, result.passed ? 1 : 0, s.id);
    try {
      await wa.sendText(s.phone, notice);
    } catch (err) {
      // session is already closed regardless of delivery outcome
    }
  }
  return { ended: active.length };
}

// ── Admin: send exam to recipients ─────────────────────────────────────

/** Run fn over items with at most `limit` promises in flight. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

/** Deliver (or nudge) the exam to one recipient, mutating `report`. */
async function sendExamToStudent(exam, student, questionCount, template, report) {
  const phone = student.phone;
  let session = db.prepare('SELECT * FROM sessions WHERE exam_id = ? AND student_id = ?').get(exam.id, student.id);
  let fresh = false;

  try {
    if (!session) {
      session = createSession(exam.id, student.id);
      fresh = true;
    } else if (session.status === 'abandoned' || session.status === 'expired') {
      session = restartSession(session);
      fresh = true;
    } else if (session.status === 'in_progress') {
      // A session whose timer already lapsed must restart, or the next
      // answer would be rejected by the deadline check.
      const expiredAt =
        new Date(new Date(session.started_at).getTime() + exam.duration_minutes * 60000).getTime();
      if (Date.now() > expiredAt) {
        session = restartSession(session);
        fresh = true;
      } else {
        // Session is still running — the student is mid-exam. Do NOT restart
        // or re-send the intro (that caused "Q1 keeps repeating"). Instead
        // re-deliver the CURRENT question as a nudge so the student can
        // continue; a silent skip made re-sends look like they "did nothing".
        try {
          await sendQuestionTo(session, student);
          report.resumed++;
        } catch (err) {
          report.failed++;
          report.errors.push({ phone, error: friendlyError(err) });
        }
        return;
      }
    } else {
      report.skipped++;
      return; // completed — already finished
    }

    if (fresh) {
      const attemptCount = getSessionQuestionCount(session.id) || questionCount;
      if (template) {
        const params = config.whatsapp.templateParams.length
          ? config.whatsapp.templateParams.map((p) => ({ type: 'text', text: p }))
          : [
              { type: 'text', text: exam.title },
              { type: 'text', text: exam.subject || 'General' },
              { type: 'text', text: String(exam.duration_minutes) },
              { type: 'text', text: String(attemptCount) },
            ];
        await wa.sendTemplate(phone, template, config.whatsapp.templateLanguage, params);
      } else {
        await wa.sendText(phone, formatExamIntro(exam, attemptCount));
      }
    }
    await sendQuestionTo(session, student);
    report.sent++;
  } catch (err) {
    report.failed++;
    report.errors.push({ phone, error: friendlyError(err) });
    if (session) {
      db.prepare(`UPDATE sessions SET status = 'abandoned', ended_at = datetime('now') WHERE id = ?`).run(session.id);
    }
  }
}

async function sendExamToRecipients(examId) {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
  if (!exam) throw new Error('Exam not found');
  const recipients = db
    .prepare(
      `SELECT s.* FROM exam_recipients r JOIN students s ON s.id = r.student_id WHERE r.exam_id = ?`
    )
    .all(examId);
  const report = { sent: 0, failed: 0, skipped: 0, resumed: 0, errors: [] };
  const questionCount = db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(examId).c;
  const template = config.whatsapp.templateName;
  const limit = config.exam.sendConcurrency;

  await mapLimit(recipients, limit, (student) =>
    sendExamToStudent(exam, student, questionCount, template, report)
  );
  return report;
}

module.exports = {
  normalizePhone,
  getOrCreateStudent,
  getActiveSession,
  createSession,
  handleInbound,
  processAnswer,
  handleAnswer,
  finalize,
  endExam,
  sendExamToRecipients,
  sendQuestionTo,
  restartSession,
  getSessionQuestion,
  getSessionQuestionCount,
  sessionQuestionSequence,
  drawSessionQuestions,
  nextInSequence,
  deadline,
  markAllPendingTheory,
  drainSession,
  formatQuestion,
  buildQuestionBubbles,
  isSectionHeader,
  splitQuestionHeadings,
  stripPaperOnlyInstructions,
  splitSectionMeta,
};
