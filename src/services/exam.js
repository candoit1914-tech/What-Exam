const db = require('../db');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const wa = require('./whatsapp');
const marking = require('./marking');
const results = require('./results');
const certificate = require('./certificate');
const ai = require('./ai');
const ocr = require('./ocr');
const outbox = require('./outbox');
// selection.js requires only ../db, so this edge is not circular. Never require
// ./exam back from selection.js — exam is the caller, not the callee.
const selection = require('./selection');
// The Paystack paywall. payments.js requires ./exam back only lazily, inside
// unlock(), so this edge is safe at require time too.
const payments = require('./payments');
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

/**
 * Candidate phone formats, most specific first. A rule that matches owns the
 * number outright. Length is validated BEFORE any country-code inference so a
 * short national number can never be mistaken for an international one — the
 * bug this table replaces checked `startsWith('1')` first, which turned every
 * 9-digit Ghanaian number beginning with 1 into a 9-digit NANP fragment.
 */
const PHONE_RULES = [
  // Explicit country code, with or without a stray national trunk 0. The
  // number already carries the country code, so the build only strips that
  // stray 0 — re-prefixing would double the country code.
  { re: /^2330?\d{9}$/, build: (p) => p.replace(/^2330/, '233') },
  { re: /^2340?\d{10}$/, build: (p) => p.replace(/^2340/, '234') },
  // North American: country code 1 plus ten digits.
  { re: /^1\d{10}$/, build: (p) => p },
  // Ghana national: 0XXXXXXXXX (ten) or XXXXXXXXX (nine).
  { re: /^0\d{9}$/, build: (p) => '233' + p.slice(1) },
  { re: /^\d{9}$/, build: (p) => '233' + p },
  // Nigeria national: 0XXXXXXXXXX (eleven) or XXXXXXXXXX (ten).
  { re: /^0\d{10}$/, build: (p) => '234' + p.slice(1) },
  // Ten digits beginning 2 is already an international local-part.
  { re: /^2\d{9}$/, build: (p) => p },
  // Remaining bare ten-digit numbers are Nigerian.
  { re: /^\d{10}$/, build: (p) => '234' + p },
];

function normalizePhone(raw) {
  const digits = String(raw == null ? '' : raw).replace(/[^\d]/g, '');
  if (!digits) return '';
  // 00 is the international access prefix; + was already stripped above.
  const p = digits.startsWith('00') ? digits.slice(2) : digits;
  for (const rule of PHONE_RULES) {
    if (rule.re.test(p)) return rule.build(p);
  }
  return '';
}

/**
 * Split a pasted recipient list into raw tokens. Accepts commas, semicolons,
 * pipes, tabs, newlines and runs of spaces. Does NOT validate: an invalid
 * token must reach the caller so it can report the exact input and reason
 * rather than silently disappearing.
 */
function splitRecipients(raw) {
  return String(raw == null ? '' : raw)
    .split(/[\s,;|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function getOrCreateStudent(phone) {
  let s = db.prepare('SELECT * FROM students WHERE phone = ?').get(phone);
  if (!s) {
    const info = db.prepare('INSERT INTO students (phone) VALUES (?)').run(phone);
    s = db.prepare('SELECT * FROM students WHERE id = ?').get(info.lastInsertRowid);
  }
  return s;
}

/**
 * Link recipients to an exam, collapsing duplicates by normalized number.
 *
 * Runs in one transaction: `students.phone` is UNIQUE, so a read-then-write
 * outside a transaction lets a concurrent import of the same new number raise
 * SQLITE_CONSTRAINT_UNIQUE and lose every recipient in the batch.
 *
 * An existing student name ALWAYS wins. A differing incoming name is reported
 * as a conflict for the admin to resolve — importing exam 2 must never rename
 * a student on exam 1.
 */
function addRecipients(examId, entries) {
  const added = [];
  const conflicts = [];
  const invalid = [];
  let merged = 0;

  const insertStudent = db.prepare('INSERT INTO students (phone, name) VALUES (?, ?)');
  const findStudent = db.prepare('SELECT * FROM students WHERE phone = ?');
  const linkRecipient = db.prepare(
    'INSERT OR IGNORE INTO exam_recipients (exam_id, student_id) VALUES (?, ?)',
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    // Collapse on the normalized number, keeping first-seen order so the
    // report reads in the order the admin pasted.
    const byPhone = new Map();
    for (const entry of entries || []) {
      const raw = entry && entry.phone;
      const phone = normalizePhone(raw);
      if (!phone) {
        invalid.push({ input: String(raw == null ? '' : raw), reason: 'Not a recognised phone number' });
        continue;
      }
      const name = String((entry && entry.name) || '').trim();
      const prior = byPhone.get(phone);
      if (prior) {
        // Same number pasted twice. It creates no second student, so it counts
        // as merged: the admin pasted 5 lines and must be told 4 were folded
        // into 1, not that nothing was a duplicate.
        merged++;
        // A name on the later copy that disagrees with the first is a
        // conflict; an absent or equal one is not.
        if (name && prior.name && name !== prior.name) {
          conflicts.push({ phone, existingName: prior.name, incomingName: name });
        } else if (name && !prior.name) {
          prior.name = name;
        }
        continue;
      }
      byPhone.set(phone, { phone, name });
    }

    for (const { phone, name } of byPhone.values()) {
      let student = findStudent.get(phone);
      if (!student) {
        insertStudent.run(phone, name);
        // Re-read by phone, not by lastInsertRowid: findStudent filters on
        // phone, and phone is UNIQUE, so this is the row just inserted.
        student = findStudent.get(phone);
        added.push({ id: student.id, phone, name: student.name || '' });
      } else {
        merged++;
        if (name && !student.name) {
          // Only ever fills a blank. Never overwrites a real name.
          db.prepare('UPDATE students SET name = ? WHERE id = ?').run(name, student.id);
          student = findStudent.get(phone);
        } else if (name && student.name && name !== student.name) {
          conflicts.push({ phone, existingName: student.name, incomingName: name });
        }
      }
      linkRecipient.run(examId, student.id);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { added, merged, conflicts, invalid };
}

// ── Sessions ───────────────────────────────────────────────────────────

/**
 * The student's live attempt, including one that finalize() has claimed but not
 * yet closed. 'finalizing' MUST be in this list: without it a student who
 * messages while their results are being computed looks session-less, and
 * maybeStartSession hands them a brand-new attempt while their grade is still
 * in the air.
 */
function getActiveSession(studentId) {
  return db
    .prepare(
      `SELECT s.*, e.title AS exam_title, e.duration_minutes, e.pass_percentage
       FROM sessions s JOIN exams e ON e.id = s.exam_id
       WHERE s.student_id = ? AND s.status IN ('in_progress','finalizing')`
    )
    .get(studentId);
}

function sessionHasNoAnswers(sessionId) {
  return db.prepare('SELECT COUNT(*) c FROM answers WHERE session_id = ?').get(sessionId).c === 0;
}

/** The student's unfinished attempt for this exam, if any. */
function activeSession(examId, studentId) {
  return db
    .prepare("SELECT * FROM sessions WHERE exam_id = ? AND student_id = ? AND status='in_progress' ORDER BY id DESC LIMIT 1")
    .get(examId, studentId);
}

/** Most recent attempt regardless of status — the one to report or restart. */
function latestSession(examId, studentId) {
  return db
    .prepare('SELECT * FROM sessions WHERE exam_id = ? AND student_id = ? ORDER BY id DESC LIMIT 1')
    .get(examId, studentId);
}

function attemptsUsed(examId, studentId) {
  return db
    .prepare('SELECT COUNT(*) c FROM sessions WHERE exam_id = ? AND student_id = ?')
    .get(examId, studentId).c;
}

/** Attempts this exam allows. 0 (the default) or a missing exam means unlimited. */
function maxAttemptsFor(examId) {
  const row = db.prepare('SELECT max_attempts FROM exams WHERE id = ?').get(examId);
  return Number((row && row.max_attempts) || config.exam.maxAttempts || 0);
}

function createSession(examId, studentId) {
  // An unfinished attempt always wins: resuming keeps the student's progress
  // instead of silently starting over.
  const active = activeSession(examId, studentId);
  if (active) return active;

  let info;
  try {
    info = db
      // started_at is written explicitly rather than left to a column default.
      // A session exists from the moment the invite goes out, so its absence is
      // what tells the timer not to run until the student actually replies.
      .prepare('INSERT INTO sessions (exam_id, student_id, attempt_no, started_at) VALUES (?, ?, ?, NULL)')
      .run(examId, studentId, attemptsUsed(examId, studentId) + 1);
  } catch (err) {
    // Two simultaneous inbound messages raced. The partial unique index kept
    // one, so resume the winner rather than failing the student's message.
    const raced = activeSession(examId, studentId);
    if (raced) return raced;
    throw err;
  }
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
  // Sort pool questions: objective first, then theory, maintaining original order within each type
  // Deduplicate by question text to prevent the same question appearing twice in one exam
  const poolRows = db.prepare('SELECT id, type, text, is_compulsory, section_key FROM question_pool WHERE exam_id = ? ORDER BY id').all(examId);
  const seenTexts = new Set();
  const uniqueRows = [];
  for (const row of poolRows) {
    const key = String(row.text || '').trim().toLowerCase();
    if (key && seenTexts.has(key)) continue;
    if (key) seenTexts.add(key);
    uniqueRows.push(row);
  }
  // Papers without a quota keep today's objective-first ordering verbatim.
  // Only a paper that actually asks the student to choose switches to
  // section order, because grouping by section is the whole point.
  const plan = selection.sectionPlan(examId);
  const position = new Map(plan.map((s) => [s.section_key, s.position]));
  if (plan.some((s) => s.quota > 0)) {
    uniqueRows.sort((a, b) => {
      const pa = position.has(a.section_key) ? position.get(a.section_key) : 9999;
      const pb = position.has(b.section_key) ? position.get(b.section_key) : 9999;
      return pa !== pb ? pa - pb : (a.id || 0) - (b.id || 0);
    });
  } else {
    // Hard sort: ALL objective questions first, then ALL theory questions.
    // Within each type, preserve pool insertion order (by id).
    uniqueRows.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'objective' ? -1 : 1;
      return (a.id || 0) - (b.id || 0);
    });
  }
  const chosen = uniqueRows.slice(0, n);
  const ins = db.prepare(
    'INSERT INTO session_questions (session_id, question_id, q_order, is_selected, section_key) VALUES (?,?,?,?,?)'
  );
  // Every drawn question starts selected, INCLUDING the optional ones the student
  // will get to pick from. They are only deselected once the student commits, in
  // applySelection. Writing 0 here would hide the whole section from
  // sessionQuestionSequence, which filters on is_selected, so the selector could
  // never open and the student would be delivered the section unasked.
  chosen.forEach((p, i) => {
    ins.run(sessionId, p.id, i + 1, 1, p.section_key || '');
  });
  db.prepare('UPDATE sessions SET paper_total = ? WHERE id = ?')
    .run(selection.computePaperTotal(sessionId), sessionId);
  return chosen.length;
}

/** Copy template questions into the pool until it holds at least `target` rows. */
function topUpPool(examId, currentPool, target) {
  const inPool = new Set(currentPool.map((r) => String(r.text || '').trim()));
  const templates = db.prepare('SELECT * FROM questions WHERE exam_id = ? ORDER BY q_order').all(examId);
  const insertPool = db.prepare(
    `INSERT INTO question_pool (exam_id, type, text, passage, options, correct_answer, marks, difficulty, learning_objective, explanation, scheme_json, source, image, is_compulsory, section_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
      scheme ? scheme.scheme : '', t.source || 'manual', t.image || '',
      t.is_compulsory == null ? 1 : t.is_compulsory, t.section_key || ''
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
    .prepare('SELECT q_order, question_id, is_selected FROM session_questions WHERE session_id = ? ORDER BY q_order')
    .all(session.id);
  let questions;
  if (drawn.length) {
    const get = db.prepare('SELECT * FROM question_pool WHERE id = ?');
    questions = drawn
      .map((m) => {
        const row = get.get(m.question_id);
        if (row) {
          row._pool = true;
          row.q_order = m.q_order;
          // is_selected lives on the snapshot, not on question_pool: it is this
          // student's private choice. Two students drawn the same pool row can
          // disagree about it, which is exactly why it cannot be a pool column.
          row.is_selected = m.is_selected;
        }
        return row;
      })
      .filter(Boolean);
  } else {
    questions = db.prepare('SELECT * FROM questions WHERE exam_id = ? ORDER BY q_order').all(s.exam_id);
  }
  // Same rule as drawSessionQuestions, and for the same reason: a quota-free
  // exam must come out byte-identical to how it behaved before this feature.
  const plan = selection.sectionPlan(s.exam_id);
  const position = new Map(plan.map((x) => [x.section_key, x.position]));
  if (plan.some((x) => x.quota > 0)) {
    questions.sort((a, b) => {
      const pa = position.has(a.section_key) ? position.get(a.section_key) : 9999;
      const pb = position.has(b.section_key) ? position.get(b.section_key) : 9999;
      return pa !== pb ? pa - pb : (a.q_order || 0) - (b.q_order || 0);
    });
  } else {
    // Hard sort: ALL objective questions first, then ALL theory questions.
    // Within each type, preserve q_order.
    questions.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'objective' ? -1 : 1;
      return (a.q_order || 0) - (b.q_order || 0);
    });
  }
  // is_selected defaults to 1, so an exam with no quota loses nothing here.
  return questions.filter((q) => q.is_selected !== 0);
}

/**
 * Student-facing question numbers. A paper numbers its sections
 * separately: objectives 1..N, then theory 1..M. A theory question
 * is "theory question 1", never "question 41" — the number restarts
 * with the section, the way the printed paper and every mark scheme
 * refer to it, no matter what number the objectives ended on.
 *
 * The display number is the rank within the question's own type in
 * presentation order, computed from the same sequence the student is
 * walked through, so the question bubble, the selector and the
 * result all agree. Keys are question ids (pool ids for a drawn
 * session, template ids otherwise).
 */
function displayNumbersFromSequence(sequence) {
  const counters = { objective: 0, theory: 0 };
  const numbers = new Map();
  for (const q of sequence) {
    const type = q.type === 'theory' ? 'theory' : 'objective';
    counters[type] += 1;
    numbers.set(q.id, counters[type]);
  }
  return numbers;
}

/** The display-number map for a session's presented questions. */
function questionDisplayNumbers(sessionId) {
  return displayNumbersFromSequence(sessionQuestionSequence({ id: sessionId }));
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
  if (i === -1) {
    // q_order + 1 may be a question this student deselected. Step over those
    // rather than offering a question they said no to.
    let next = question.q_order + 1;
    for (;;) {
      const candidate = getSessionQuestion(session.id, next);
      if (!candidate) return null;
      const row = db
        .prepare('SELECT is_selected FROM session_questions WHERE session_id = ? AND q_order = ?')
        .get(session.id, next);
      if (!row || row.is_selected !== 0) return candidate;
      next++;
    }
  }
  return seq[i + 1] || null;
}

function deadline(session) {
  // If started_at is NULL, the session hasn't started yet — return a far-future
  // deadline so the timer check never triggers before the student engages.
  if (!session.started_at) return new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  // Ensure consistent UTC parsing: append 'Z' if the timestamp lacks a timezone
  // indicator. SQLite's datetime('now') returns UTC without 'Z', which JS Date
  // would parse as local time — causing a systematic timer drift.
  const startedAtStr = String(session.started_at);
  const utcStr = /[Zz]|[+-]\d{2}:\d{2}$/.test(startedAtStr) ? startedAtStr : startedAtStr + 'Z';
  return new Date(new Date(utcStr).getTime() + session.duration_minutes * 60000);
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
  'exam',
]);

/**
 * Greetings and commands to start — words that are never a theory answer.
 *
 * Deliberately narrower than START_WORDS: "yes", "ok" and "go" can be a
 * student's real answer to a short theory question, so swallowing them would
 * cost them a mark. This set only has to catch what the payment confirmation
 * tells a stuck student to type ("Hi" or "Exam") and the obvious greetings
 * that go with it.
 */
const GREETING_WORDS = new Set(['hi', 'hello', 'hey', 'yo', 'exam', 'start', 'begin']);

function formatQuestion(exam, question, qCount, body, session, displayNumber = null) {
  // The type banner and any passage/instruction/header are sent as their own
  // bubbles by buildQuestionBubbles, so the question bubble carries just the
  // stem (optionally pre-stripped of leading section headers).
  let text = body != null ? body : String(question.text || '').trim();
  // Ensure the question text ends with proper punctuation for a complete sentence.
  // This fixes truncated questions from PDF imports where extraction may have
  // cut off mid-sentence.
  if (text && !/[.!?;:\-]\s*$/.test(text) && !/\)\s*$/.test(text)) {
    // Check if this is a short fragment that looks like it was cut off
    const words = text.split(/\s+/);
    if (words.length > 2 && !text.includes('\n')) {
      text = text + ' —';
    }
  }
  // The number the student sees: per-type (objectives 1..N, theory
  // 1..M), falling back to the raw position only when no map was
  // supplied.
  const shown = displayNumber || question.q_order;
  return `*QUESTION ${shown}*\n\n${text}`;
}

/**
 * The sub-questions of a theory question, laid out the way the printed paper
 * lays them out: a heading, then every sub-question in its own block with a
 * blank line above it. Run together on single newlines, (b) reads as a
 * continuation of (a)'s marks line; spaced, each one is a separate thing to
 * answer under the same question number.
 *
 * Returns '' when there is nothing to show, so a caller can treat it as just
 * another part of the message.
 */
function formatSubQuestions(question) {
  if (!question || String(question.type) !== 'theory') return '';
  let followUps;
  try {
    followUps = JSON.parse(question.follow_ups);
  } catch (err) {
    console.error('[exam] failed to format follow-up questions:', err.message);
    return '';
  }
  if (!Array.isArray(followUps)) return '';

  const blocks = [];
  for (const fu of followUps) {
    const text = fu ? String(fu.text || '').trim() : '';
    if (!text) continue;
    const marks = fu && Number.isFinite(Number(fu.marks)) && Number(fu.marks) > 0 ? `\nMarks: ${fu.marks}` : '';
    // Lettered from the kept blocks, so a malformed entry cannot leave a gap
    // in the student's (a), (b), (c).
    blocks.push(`*(${String.fromCharCode(97 + blocks.length)})* ${text}${marks}`);
  }
  if (!blocks.length) return '';
  return `*Sub-questions:*\n\n${blocks.join('\n\n')}`;
}

/** mm:ss left on the clock, computed from the session start + exam duration. */
function timeRemaining(session, exam) {
  // Reachable only if a question is ever delivered before the student engages.
  // new Date('') is NaN, and "Time remaining: NaN:NaN" must never ship.
  if (!session || !session.started_at) return '—';
  const startedAtStr = String(session.started_at);
  const utcStr = /[Zz]|[+-]\d{2}:\d{2}$/.test(startedAtStr) ? startedAtStr : startedAtStr + 'Z';
  const ms = new Date(utcStr).getTime() + exam.duration_minutes * 60000 - Date.now();
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

/** Simple instructions shown before the first question of each type. */
const SECTION_INTRO = {
  objective: 'Reply with the letter of your answer (e.g. A, B, C, or D).',
  theory: 'Type your full answer to each question as a single message.',
};

/**
 * The chat bubbles to send for one question: a section header (once per type,
 * before the first of its kind), the section instructions and reading passage
 * as separate bubbles (once, before the first question that uses them), then
 * the question bubble. "Already sent" is derived from the questions that
 * precede this one in the sequence, so resume/nudge re-sends never duplicate
 * headers, instructions, or passages.
 */
function buildQuestionBubbles(exam, question, sequence, index, session) {
  const bubbles = [];
  const type = question.type === 'theory' ? 'THEORY' : 'OBJECTIVE';
  const prev = index > 0 ? sequence.slice(0, index) : [];
  const firstOfType = !prev.some((q) => q.type === question.type);
  if (firstOfType) {
    if (SECTION_INTRO[question.type]) bubbles.push(SECTION_INTRO[question.type]);
    bubbles.push(formatSectionHeader(type));
  }

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

  const textClean = stripSourceWatermarks(String(question.text || '')).trim();
  const { headings: tHead, body } = splitQuestionHeadings(textClean);
  for (const h of tHead) {
    if (!seen.headings.has(h)) {
      bubbles.push(`*${h}*`);
      seen.headings.add(h);
    }
  }
  // The question is numbered within its own type, so theory
  // question 1 is QUESTION 1 no matter how many objectives
  // the paper carries.
  const numbers = displayNumbersFromSequence(sequence);
  bubbles.push(formatQuestion(exam, question, sequence.length, body, session, numbers.get(question.id)));
  return bubbles;
}

function safeParseOptions(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Answer-options message for objective questions (sent right after the question). */
function formatOptions(exam, session, question) {
  const options = safeParseOptions(question.options);
  const body = options.map((o) => `${o.key}. ${o.text}`).join('\n');
  return (
    `${body}\n\n` +
    `Reply with the letter of your answer.`
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

function formatExamIntro(exam, questionCount, { started = false } = {}) {
  // A paid paper has no invite block. Its whole invitation is the payment
  // bubble: the subject, duration, question count and START prompt below are
  // all things a student cannot use until Paystack has taken their money.
  //
  // The rule lives here, where the text is built, rather than at each call
  // site, so no caller — written now or later — can put the block back into a
  // paying student's chat. '' means "there is nothing to say", and every
  // caller treats it that way.
  if (payments.isPaidExam(exam)) return '';
  const type = examTypeOf(exam.id);
  const steps = [
    'Questions arrive one at a time.',
    type === 'Theory'
      ? 'Type your full answer to each question as a single message. Theory answers are marked at the end of the exam.'
      : 'After each question, its answer options are sent in a separate message; reply with the letter of your answer (e.g. *A*).',
    'Answers are locked once you send them.',
    started
      ? 'Your timer starts now. The exam ends automatically when time is up.'
      : 'Reply START to begin — your timer starts the moment you reply.',
    'Copying AI-written answers (e.g. ChatGPT, Gemini) is cheating — such answers are detected and earn 0 marks.',
  ];
  // The START prompt only makes sense before the student has begun. Telling
  // someone who has just started to reply START, or that their exam "begins
  // instantly" the moment an admin presses Send, is the confusion this split
  // exists to remove.
  const startLine = started
    ? ''
    : 'Reply *START* to this chat to open it.\n\n';
  const instructions = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  // A paper that asks the student to choose says so up front, so nobody only
  // discovers the rule when the selector interrupts them mid-exam.
  const rules = selection
    .sectionPlan(exam.id)
    .filter((s) => s.quota > 0)
    .map((s) => `${s.title || s.section_key}: answer any ${s.quota} of the ${s.optional.length} questions.`);
  const ruleLines = rules.length ? `${rules.join('\n')}\n\n` : '';
  return (
    `*${String(exam.title).toUpperCase()}*\n\n` +
    `Subject: *${exam.subject || 'General'}*\n` +
    `Exam type: *${type}*\n` +
    `Duration: *${exam.duration_minutes} minute${exam.duration_minutes === 1 ? '' : 's'}*\n` +
`Number of questions: *${questionCount}*\n` +
    `Pass mark: *${exam.pass_percentage}%\n\n` +
    ruleLines +
    startLine +
    `*INSTRUCTIONS*\n${instructions}`
  );
}

/**
 * The instructions block a paper opens with — and never for a paid one.
 *
 * A paid chat reads: the payment bubble, "Payment received", then the paper.
 * The invite was deliberately withheld when the admin pressed Send, so
 * re-sending its twin here would put back the exact bubble they asked not to
 * see. A paid paper that wants its instructions delivered has the approved
 * paid-start template, which carries them in the same message as question 1.
 *
 * The question count is read here rather than by the caller so it is only
 * ever counted when it is actually going to be printed.
 */
async function sendOpeningIntro(student, exam, session, options = {}) {
  // The paid rule lives in formatExamIntro; this early return only saves
  // reading a question count for a block that will never be built.
  if (payments.isPaidExam(exam)) return;
  const questionCount =
    getSessionQuestionCount(session.id) ||
    db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(exam.id).c;
  const intro = formatExamIntro(exam, questionCount, options);
  if (!intro) return;
  await wa.sendText(student.phone, intro);
}

/** Resolve a student's objective answer from a tap (replyId), a letter, or full option text. */
function resolveObjectiveLetter(question, body, meta = {}) {
  if (meta.replyId) {
    const l = marking.normalizeAnswer(meta.replyId).replace(/\.$/, '');
    if (/^[A-D]$/.test(l)) return l;
  }
  const letter = marking.normalizeAnswer(body).replace(/\.$/, '');
  if (/^[A-D]$/.test(letter)) return letter;
  const options = safeParseOptions(question.options);
  const hit = options.find((o) => marking.normalizeAnswer(o.text) === marking.normalizeAnswer(body));
  return hit ? hit.key : null;
}

/** Reset a session to a fresh attempt (wipes previous answers + result). */
function restartSession(session) {
  const current = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id) || session;
  const used = attemptsUsed(current.exam_id, current.student_id);
  const max = maxAttemptsFor(current.exam_id);
  // Checked before anything is written so a refused restart leaves the
  // existing attempt — and its answers — exactly as they were.
  if (max > 0 && used >= max) {
    throw new Error(
      `Attempt limit reached for this exam (${max} attempt${max === 1 ? '' : 's'} allowed).`
    );
  }

  // Retire the old row rather than rewriting it: its answers, score and
  // timestamps stay queryable, and retiring frees the partial unique index for
  // the new active attempt.
  if (current.status === 'in_progress') {
    db.prepare("UPDATE sessions SET status='abandoned' WHERE id = ?").run(current.id);
  }
  const info = db
    // Same reasoning as createSession: a restart is a fresh invite, so the new
    // attempt must never inherit a running clock from the attempt it replaces.
    .prepare('INSERT INTO sessions (exam_id, student_id, attempt_no, started_at) VALUES (?, ?, ?, NULL)')
    .run(current.exam_id, current.student_id, used + 1);
  const fresh = db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid);
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

/**
 * Record that a recipient has received the exam. `sent_at` is the single source
 * of truth for "this number was actually reached" — the admin dashboard and the
 * participation list both read it, so it is only stamped once a send succeeds.
 *
 * Driven off the session, not the caller-supplied student: some delivery paths
 * only have the phone number in hand, and the session always carries both ids.
 */
function recordAcceptance(session) {
  db.prepare(
    `UPDATE exam_recipients SET sent_at = datetime('now')
      WHERE exam_id = ? AND student_id = ? AND sent_at IS NULL`
  ).run(session.exam_id, session.student_id);
}

async function sendQuestionTo(session, student, qOrder = null) {
  session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(session.exam_id);
  if (!exam || (exam.status !== 'published' && exam.status !== 'live')) {
    await wa.sendText(student.phone, `The exam for this session is no longer active. No more questions will be sent.`);
    return false;
  }
  const question = getSessionQuestion(session.id, qOrder == null ? session.current_q_order : qOrder);
  if (!question) {
    await finalize(session, student);
    return false;
  }
  // Delivery has reached an optional question of a selective section: the student
  // picks from it before seeing it, so the selector replaces this question rather
  // than arriving after it.
  if (selection.needsChoice(session, question)) {
    selection.beginChoice(session.id, question.section_key);
    await selection.sendSelector(student.phone, session.id, question.section_key);
    return false;
  }
  const sequence = sessionQuestionSequence(session);
  const index = sequence.findIndex((q) => q.id === question.id);

  // Every bubble that is not the question itself is meta content — section
  // intro, type header, heading, instructions, reading passage — and goes out
  // as its OWN WhatsApp message. An instruction and a question never share a
  // chat bubble (per product requirement).
  const bubbles = buildQuestionBubbles(exam, question, sequence, index, session);
  const questionBubble = bubbles.pop();
  for (const bubble of bubbles) {
    await wa.sendText(student.phone, bubble);
  }

  // Diagram/image bubbles go directly ABOVE the question so the student sees
  // the figure first, then the full question that refers to it. Math
  // expressions imported from PDFs are stored in question_images (position
  // order); fall back to the legacy single questions.image for everything else.
  const mathImages = db
    .prepare('SELECT image FROM question_images WHERE question_id = ? ORDER BY position')
    .all(question.id);
  if (mathImages.length) {
    for (const row of mathImages) {
      await wa.sendImage(student.phone, path.join(config.uploadsDir, row.image)).catch((err) => {
        console.error('[exam] question image send failed (continued):', err.message);
      });
    }
  } else if (question.image) {
    await wa.sendImage(student.phone, path.join(config.uploadsDir, question.image)).catch((err) => {
      console.error('[exam] image send failed (continued):', err.message);
    });
  }

  // Question bubble: full stem, then the answer (options or follow-ups), then
  // the timer — nothing omitted.
  const parts = [questionBubble];
  if (question.type === 'objective') {
    const options = safeParseOptions(question.options);
    parts.push(options.map((o) => `${o.key}. ${o.text}`).join('\n'));
  }
  const subQuestions = formatSubQuestions(question);
  if (subQuestions) parts.push(subQuestions);

  // Place the timer BELOW the answer options so students see the question,
  // options, then time remaining — not buried in the question text. The parts
  // are joined by a blank line already, so the timer carries no separators of
  // its own; giving it its own put two blank lines above it.
  parts.push(`Time remaining: *${timeRemaining(session, exam)}*`);

  const combined = parts.join('\n\n');
  if (combined.trim()) {
    await wa.sendText(student.phone, combined);
  }

  recordAcceptance(session);
  return true;
}

/**
 * Move the student on to `nextQ` and deliver it, without ever losing the fact
 * that a question is owed.
 *
 * The position used to be advanced *before* the send, so a WhatsApp outage left
 * the student pointing at a question they never received and the answer a
 * re-send could not recover. Now the intent is written to the outbox first,
 * the question is sent, and only a successful send advances the position. A
 * crash or outage in between leaves a queued row that recoverQueuedSends()
 * replays exactly once.
 */
/**
 * The next question this student should see: the first selected question in
 * delivery order that has no answer yet. Used after a selection is committed,
 * where "where now?" depends on what the student just picked rather than on the
 * q_order that happened to be current before the selector opened.
 */
function firstUnansweredSelected(session) {
  const answered = new Set(
    db.prepare('SELECT q_order FROM answers WHERE session_id = ?').all(session.id)
      .map((r) => Number(r.q_order))
  );
  const seq = sessionQuestionSequence(session);
  return seq.find((q) => !answered.has(Number(q.q_order))) || null;
}

async function advanceAndSend(session, student, nextQ) {
  // The selector is a decision, not a delivery: nothing is owed until the student
  // picks, so this must not enqueue a question send. current_q_order is also left
  // alone — the commit path re-reads the sequence and lands on the first SELECTED
  // question, which is usually not nextQ at all.
  if (selection.needsChoice(session, nextQ)) {
    selection.beginChoice(session.id, nextQ.section_key);
    await selection.sendSelector(student.phone, session.id, nextQ.section_key);
    return;
  }
  const entry = outbox.enqueue({
    sessionId: session.id,
    questionId: nextQ.id,
    qOrder: nextQ.q_order,
    kind: 'question',
    recipient: student.phone,
  });
  // Already delivered on an earlier attempt: just move the position on.
  if (entry.state === 'sent') {
    commitAdvance(session.id, entry.q_order);
    return;
  }
  try {
    await sendQuestionTo(session, student, nextQ.q_order);
    commitAdvance(session.id, nextQ.q_order, entry.id);
  } catch (err) {
    outbox.markFailed(entry.id, err, Math.max(1, config.exam.sendRetries));
    throw err;
  }
}

/**
 * Advance the position and retire the outbox row atomically, so the student can
 * never be advanced without the send being recorded (or the reverse).
 *
 * A SAVEPOINT is used rather than BEGIN/COMMIT because callers may already be
 * inside a transaction (bulk admin sends, and the regression tests wrap their
 * fixtures). Releasing the outermost savepoint commits; releasing a nested one
 * simply rejoins the enclosing transaction, which is the correct behaviour
 * either way and keeps a failure from rolling back a caller's own work.
 */
function commitAdvance(sessionId, qOrder, entryId = null) {
  db.exec('SAVEPOINT commit_advance');
  try {
    db.prepare(
      `UPDATE sessions SET current_q_order = ?, last_active_at = datetime('now') WHERE id = ?`
    ).run(qOrder, sessionId);
    if (entryId != null) outbox.markSent(entryId);
    db.exec('RELEASE commit_advance');
  } catch (err) {
    db.exec('ROLLBACK TO commit_advance');
    db.exec('RELEASE commit_advance');
    throw err;
  }
}

/**
 * Replay question deliveries that were recorded but never confirmed. Safe to
 * call repeatedly: a row is only retried while it is still queued, and a
 * successful replay marks it sent and advances the position in one step.
 */
async function recoverQueuedSends() {
  let recovered = 0;
  for (const entry of outbox.pending()) {
    if (entry.kind !== 'question') continue;
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(entry.session_id);
    if (!session) continue;
    const student = { id: session.student_id, phone: entry.recipient };
    try {
      await sendQuestionTo(session, student, entry.q_order);
      commitAdvance(session.id, entry.q_order, entry.id);
      recovered++;
    } catch (err) {
      outbox.markFailed(entry.id, err, Math.max(1, config.exam.sendRetries));
    }
  }
  return recovered;
}

// ── Entry point for inbound WhatsApp messages ──────────────────────────

async function handleInbound(phone, body, meta = {}) {
  const student = getOrCreateStudent(phone);
  let session = getActiveSession(student.id);

  if (!session) {
    const started = await maybeStartSession(student);
    return { started: true, ok: started.ok, reason: started.reason };
  }

  // Results are on the way: finalize() has claimed this session. Recording an
  // answer now would race the drain/mark/compute flow, and dropping through to
  // maybeStartSession would start a fresh attempt. The message is swallowed —
  // the result message is the reply the student gets.
  if (session.status === 'finalizing') {
    return { started: false, ok: true, reason: 'finalizing' };
  }

  // A paid paper stays locked until Paystack says the money landed. This runs
  // before the invite shortcut below, which would otherwise arm the clock and
  // hand over question 1 on the student's first "hello". A student already
  // part-way through (started_at set) is never blocked.
  if (!session.started_at) {
    const examRow = db.prepare('SELECT * FROM exams WHERE id = ?').get(session.exam_id);
    const gate = await payments.ensurePaid(examRow, student, session);
    if (!gate.paid) {
      await payments.tryDeliverLink(student, examRow);
      return { started: false, ok: false, reason: 'payment_required' };
    }
  }

  // An approved template invites a reply; it does not open the service
  // window. Deliver Q1 on that first reply instead of grading the greeting.
  const invited = db.prepare("SELECT id FROM message_outbox WHERE session_id=? AND kind='intro' AND state='sent'").get(session.id);
  const questionSent = db.prepare("SELECT id FROM message_outbox WHERE session_id=? AND kind='question' AND state='sent'").get(session.id);
  if (invited && !questionSent && sessionHasNoAnswers(session.id)) {
    // Stored in the same ISO-8601-Z form as every other write to started_at, so
    // the column holds one format rather than a mix of SQLite and JS datetimes.
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    db.prepare('UPDATE sessions SET started_at = ? WHERE id=?').run(now, session.id);
    session = { ...session, started_at: now };
    // Question 1 goes out through the normal advance path so the delivery is
    // recorded in the outbox. A bare sendQuestionTo() leaves no trace, and
    // this branch would then fire again on the student's next reply —
    // swallowing their first answer and re-sending question 1 forever.
    const firstQ = getSessionQuestion(session.id, session.current_q_order)
      || firstUnansweredSelected(session);
    if (!firstQ) {
      await finalize(session, student, 'completed');
      return { started: true, ok: true, reason: 'completed' };
    }
    await advanceAndSend(session, student, firstQ);
    return { started: true, ok: true, reason: 'started' };
  }

  // Bulk-sent sessions are created the moment the admin clicks Send, but the
  // timer must start when the student actually engages. A session that has no
  // answers yet restarts its clock on the first inbound message, so a late
  // starter is never greeted by a countdown that already ran down (e.g. the
  // 59:57 → 6:47 jump from sending hours after the admin pressed Send).
  //
  // A student still choosing has no answers either, but their clock is already
  // running — restarting it would hand the selection back as free time (the
  // tap-tap-CONFIRM dance and the first reply after it would each reset the
  // countdown). Two states say "this student has already been through a
  // selector":
  //   'selecting'          — the selector is open right now;
  //   non-empty selection_section — a selector opened at least once; applySelection
  //     deliberately keeps the section after the commit, so it stays set.
  // selection_state alone is not enough: it returns to '' on commit, which is
  // indistinguishable from a session that never chose anything.
  // Anything else — a legacy bulk-sent session whose clock already ran down,
  // a student who has only been reading question 1 — may re-arm the clock.
  const choosing = session.selection_state === 'selecting' || !!String(session.selection_section || '');
  if (sessionHasNoAnswers(session.id) && !choosing) {
    // Store as ISO 8601 with 'Z' suffix for consistent UTC parsing in deadline().
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    db.prepare(
      `UPDATE sessions SET started_at = ?, last_active_at = datetime('now') WHERE id = ?`
    ).run(now, session.id);
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

/**
 * The first outbound message after a paid checkout may be outside WhatsApp's
 * 24-hour service window. An approved utility template opens the paper and
 * carries Q1 in that same message; the student's reply then opens the window
 * for the regular question flow.
 */
async function sendPaidStartTemplate(session, student, exam, firstQ) {
  const template = config.whatsapp.paidStartTemplateName;
  if (!template) return false;

  let questionText;
  if (selection.needsChoice(session, firstQ)) {
    selection.beginChoice(session.id, firstQ.section_key);
    // Session space, not template space: sectionPlan reads the admin's
    // questions, and a drawn attempt can hold a different set. The student
    // must only ever be offered what they were actually drawn.
    const plan = selection.sessionPlan(session.id).find((item) => item.section_key === firstQ.section_key);
    const questions = (plan?.optional || []).map((q, i) => `${i + 1}. ${q.text}`).join('\n');
    questionText = `Choose ${plan?.quota || 1} question(s) from this section:\n${questions}\nReply with the number(s), then CONFIRM.`;
  } else {
    const sequence = sessionQuestionSequence(session);
    const index = sequence.findIndex((q) => q.id === firstQ.id);
    const bubbles = buildQuestionBubbles(exam, firstQ, sequence, index, session);
    // The same vertical, spaced layout the ordinary question message uses, so
    // a paper opened through the payment template reads like any other paper.
    const subQuestions = formatSubQuestions(firstQ);
    const details = [
      ...bubbles,
      ...(firstQ.type === 'objective'
        ? [safeParseOptions(firstQ.options).map((o) => `${o.key}. ${o.text}`).join('\n')]
        : []),
      ...(subQuestions ? [subQuestions] : []),
      `Time allowed: ${exam.duration_minutes} minutes.`,
    ].filter(Boolean);
    questionText = details.join('\n\n');
  }

  // The configured template body should say payment is confirmed, the exam
  // starts now, and the student should answer the question below. Its three
  // body variables are exam title, first-question payload, and duration.
  await wa.sendTemplate(student.phone, template, config.whatsapp.templateLanguage, [
    { type: 'text', text: String(exam.title) },
    { type: 'text', text: questionText },
    { type: 'text', text: String(exam.duration_minutes) },
  ]);

  if (!selection.needsChoice(session, firstQ)) {
    const entry = outbox.enqueue({
      sessionId: session.id,
      questionId: firstQ.id,
      qOrder: firstQ.q_order,
      kind: 'question',
      recipient: student.phone,
    });
    commitAdvance(session.id, firstQ.q_order, entry.id);
  }
  recordAcceptance(session);
  return true;
}

async function maybeStartSession(student, preferredExamId = null) {
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

  // The exam that was paid for wins over "newest published": a student
  // holding several live papers must have the paper they just paid for
  // opened, not whichever one happens to sort first.
  let exam = candidates[0];
  if (preferredExamId != null) {
    const wanted = Number(preferredExamId);
    const match = candidates.find((c) => c.id === wanted);
    if (match) exam = match;
  }
  let existing = latestSession(exam.id, student.id);

  // The paywall, before anything at all is delivered. An unpaid student gets
  // the checkout link and no paper; a student already part-way through the
  // attempt (started_at set) is never blocked, so an admin pricing a live
  // paper mid-run cannot strand the people already writing it.
  if (!existing || !existing.started_at) {
    const gate = await payments.ensurePaid(exam, student, existing);
    if (!gate.paid) {
      await payments.tryDeliverLink(student, exam);
      return { ok: false, reason: 'payment_required' };
    }
  }

  if (existing && existing.status === 'in_progress') {
    // An invited-but-unstarted attempt: the state a paper sits in between
    // "invite sent" and "the student engaged". Payment IS that engagement —
    // the moment Paystack confirms the charge the paper opens for real:
    // the clock is armed here and question 1 goes out through the normal
    // advance path (recorded in the outbox, so the student's next reply is
    // graded as an answer rather than read as another "start").
    if (!existing.started_at) {
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      db.prepare(
        `UPDATE sessions SET started_at = ?, last_active_at = datetime('now') WHERE id = ?`
      ).run(now, existing.id);
      existing = { ...existing, started_at: now };
      const firstQ = getSessionQuestion(existing.id, existing.current_q_order)
        || firstUnansweredSelected(existing);
      if (!firstQ) {
        await finalize(existing, student, 'completed');
        return { ok: true, reason: 'completed' };
      }
      try {
        const templated = payments.isPaidExam(exam)
          && await sendPaidStartTemplate(existing, student, exam, firstQ);
        if (!templated) {
          await sendOpeningIntro(student, exam, existing, { started: true });
          if (existing.selection_state === 'selecting') {
            await selection.sendSelector(student.phone, existing.id, existing.selection_section);
            return { ok: true, reason: 'selecting' };
          }
          await advanceAndSend(existing, student, firstQ);
        }
      } catch (err) {
        // A failed push must remain eligible for the payment sweep to retry.
        // Without resetting the clock, the sweep mistakes this for a delivered
        // exam and permanently stops retrying after a WhatsApp 131047 rejection.
        db.prepare('UPDATE sessions SET started_at=NULL WHERE id=?').run(existing.id);
        throw err;
      }
      return { ok: true, reason: 'started' };
    }

    await sendOpeningIntro(student, exam, existing, { started: true });
    // A restart can leave a selector pending with no question sent; re-render it
    // rather than pushing a question the student never chose.
    if (existing.selection_state === 'selecting') {
      await selection.sendSelector(student.phone, existing.id, existing.selection_section);
      return { ok: true, reason: 'reselecting' };
    }
    await sendQuestionTo(existing, student);
    return { ok: true, reason: 'resumed' };
  }
  if (existing && existing.status === 'finalizing') {
    // Results are being computed for this attempt. Starting a new one here
    // would leave the student with a second paper while the first one's grade
    // is still in the air — the message is acknowledged and nothing else.
    await wa.sendText(
      student.phone,
      `Your *${exam.title}* results are being prepared — they will arrive in a moment.`
    );
    return { ok: true, reason: 'finalizing' };
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
    // Only restart if the session hasn't exceeded retry limit
    const retries = existing.retry_count || 0;
    if (retries >= config.exam.sendRetries) {
      await wa.sendText(student.phone, `Your exam session could not be started after multiple attempts. Please ask your administrator to send the exam again.`);
      return { ok: false, reason: 'max_retries' };
    }
    session = restartSession(existing);
    db.prepare('UPDATE sessions SET retry_count = ? WHERE id = ?').run(retries + 1, session.id);
  } else {
    session = createSession(exam.id, student.id);
  }

  // Start the timer NOW — when the student actually engages — not when the
  // admin created or sent the exam. Question generation can take a long time,
  // so the clock must not start until the student is ready.
  if (!session.started_at) {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    db.prepare(
      `UPDATE sessions SET started_at = ?, last_active_at = datetime('now') WHERE id = ?`
    ).run(now, session.id);
    session = getActiveSession(student.id);
  }

  await sendOpeningIntro(student, exam, session);
  const sent = await sendQuestionTo(session, student).catch(async (err) => {
    await wa.sendText(student.phone, `Could not start "${exam.title}" right now. Please try again shortly.`);
    return false;
  });
  if (sent) {
    await db.prepare(`UPDATE sessions SET last_active_at = datetime('now'), retry_count = 0 WHERE id = ?`).run(session.id);
  } else {
    // Don't permanently abandon — mark with retry count so background cleanup can retry
    const retries = (session.retry_count || 0) + 1;
    if (retries >= config.exam.sendRetries) {
      db.prepare(`UPDATE sessions SET status = 'abandoned', ended_at = datetime('now'), retry_count = ? WHERE id = ?`).run(retries, session.id);
    } else {
      db.prepare(`UPDATE sessions SET retry_count = ?, last_active_at = datetime('now') WHERE id = ?`).run(retries, session.id);
    }
  }
  return { ok: sent, reason: sent ? 'started' : 'send_failed' };
}

// ── Answer processing ──────────────────────────────────────────────────

async function processAnswer(session, student, body, meta = {}) {
  // A student replying while a selector is open is choosing, not answering. This
  // must run before the question lookup: current_q_order still points at the
  // optional question whose selector is open, so grading would record their tap
  // as an answer to it.
  if (session.selection_state === 'selecting') {
    const res = await selection.handleReply(session, student, body, meta);
    if (res && res.committed) {
      // The choice is committed and the paper priced. Find where we now are and
      // deliver — handleReply never sends a question itself.
      const fresh = getActiveSession(student.id) || session;
      const nextQ = firstUnansweredSelected(fresh);
      if (nextQ) {
        db.prepare('UPDATE sessions SET current_q_order = ? WHERE id = ?').run(nextQ.q_order, fresh.id);
        await sendQuestionTo(fresh, student, nextQ.q_order);
      } else {
        await finalize(fresh, student, 'completed');
      }
    } else if (!res || !res.handled) {
      // selection.handleReply could not parse this as a selection (missing plan or
      // exhausted quota). Leaving selection_state set would brick the session: every
      // later reply re-enters this branch. Clear it and treat the message as an
      // answer (or a no-op that re-delivers the current question).
      console.warn(`[exam] selection unhandled for session ${session.id}; clearing selection_state`);
      // '' rather than NULL: the column is NOT NULL DEFAULT ''. selection_section
      // is kept on purpose — it is the record that this student has already
      // engaged with a selector, which is what stops handleInbound from handing
      // them a fresh clock for a message the selector swallowed.
      db.prepare(`UPDATE sessions SET selection_state = '' WHERE id = ?`).run(session.id);
      session = { ...session, selection_state: '' };
      const exam2 = db.prepare('SELECT * FROM exams WHERE id = ?').get(session.exam_id);
      const question2 = getSessionQuestion(session.id, session.current_q_order);
      if (exam2 && question2) {
        const next2 = await handleAnswer(exam2, session, student, question2, body, meta);
        if (next2 !== false) {
          const nq2 = nextInSequence(session, question2);
          if (nq2) await advanceAndSend(session, student, nq2);
          else await finalize(session, student, 'completed');
        } else {
          await sendQuestionTo(session, student);
        }
      }
      return;
    }
    return;
  }

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

  // The same protection for theory, where a greeting would otherwise be
  // marked as their answer: the payment confirmation tells a student whose
  // paper did not open to type Hi or Exam, and that reply can land here if
  // the push already went out. Only the opening reply of an attempt is read
  // this way — once an answer exists the student is genuinely mid-paper, and
  // a short word there may well be what they meant to write.
  if (question.type === 'theory' && !meta.replyId && sessionHasNoAnswers(session.id)) {
    const trimmed = body.trim().toLowerCase();
    if (GREETING_WORDS.has(trimmed)) {
      await wa.sendText(
        student.phone,
        '🚀 Your exam is on — type your full answer to the question below.'
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
      await advanceAndSend(session, student, nq);
    } else {
      await finalize(session, student, 'completed');
    }
    return;
  }

  let next;
  try {
    next = await handleAnswer(exam, session, student, question, body, meta);
  } catch (err) {
    // A duplicate webhook delivery or double-tap races the check above and hits
    // the unique answers index — treat it exactly like the already-answered path
    // instead of crashing the inbound handler.
    if (/UNIQUE constraint failed/i.test(String(err && err.message))) {
      let nq = nextInSequence(session, question);
      while (
        nq &&
        db.prepare('SELECT id FROM answers WHERE session_id = ? AND question_id = ?').get(session.id, nq.id)
      ) {
        nq = nextInSequence(session, nq);
      }
      if (nq) {
        await advanceAndSend(session, student, nq);
      } else {
        await finalize(session, student, 'completed');
      }
      return;
    }
    throw err;
  }
  if (next === false) {
    // Invalid input — re-send the question so the student can try again.
    await sendQuestionTo(session, student);
    return;
  }

  // advance
  const nextQ = nextInSequence(session, question);
  if (nextQ) {
    await advanceAndSend(session, student, nextQ);
  } else {
    await finalize(session, student, 'completed');
  }
}

async function handleAnswer(exam, session, student, question, body, meta = {}) {
  if (question.type === 'objective') {
    if (meta.mediaType === 'image') {
      await wa.sendText(
        student.phone,
        '⚠️ For this question, please type the letter of your answer (e.g. *A*).'
      );
      return false;
    }
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
      const options = safeParseOptions(question.options);
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
          // Another student may have already resolved this question's key while we
          // were waiting on the AI — don't overwrite (and possibly disagree with)
          // the stored one.
          const existing = question._pool
            ? db.prepare('SELECT correct_answer FROM question_pool WHERE id = ?').get(question.id)
            : db.prepare('SELECT correct_answer FROM questions WHERE id = ?').get(question.id);
          const stored = existing ? String(existing.correct_answer || '').trim() : '';
          if (!stored) {
            if (question._pool) {
              db.prepare('UPDATE question_pool SET correct_answer = ? WHERE id = ?').run(key, question.id);
            } else {
              db.prepare('UPDATE questions SET correct_answer = ? WHERE id = ?').run(key, question.id);
            }
          }
          // Grade this student against the key that is actually stored.
          const gradeKey = stored || key;
          if (!question._pool) {
            db.prepare(
              `INSERT INTO marking_schemes (question_id, type, scheme) VALUES (?, 'objective', ?)
               ON CONFLICT(question_id) DO UPDATE SET scheme=excluded.scheme, updated_at=datetime('now')`
            ).run(question.id, JSON.stringify({
              type: 'objective',
              correct_answer: gradeKey,
              marks: question.marks,
              explanation: resolved?.explanation || '',
            }));
          }
          const result = marking.markObjective({ ...question, correct_answer: gradeKey }, letter);
          db.prepare(
            `UPDATE answers SET is_correct=?, marks_awarded=?, marked_by='ai', ai_feedback=?, needs_review=0, marked_at=datetime('now')
             WHERE session_id=? AND question_id=?`
          ).run(
            result.isCorrect ? 1 : 0, result.marksAwarded,
            `Answer key determined by the AI examiner: ${gradeKey}.`,
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
    let answerText = body;
    let answerImage = '';
    let puterRead = false;
    if (meta.mediaType === 'image') {
      console.log(`[exam] Received image from ${student.phone}, mediaId=${meta.mediaId}`);
      try {
        if (!meta.mediaId) {
          throw new Error('No media ID in image message');
        }
        const { buffer, mimeType } = await wa.downloadMedia(meta.mediaId);
        if (!buffer || buffer.length === 0) {
          throw new Error('Downloaded image buffer is empty');
        }
        console.log(`[exam] Downloaded image: ${buffer.length} bytes, mimeType=${mimeType}`);
        // Save the raw image directly — no canvas re-rendering needed.
        // Accept jpg, png, webp, etc. as-is from WhatsApp.
        const ext = mimeType?.includes('png') ? 'png'
          : mimeType?.includes('webp') ? 'webp'
          : mimeType?.includes('gif') ? 'gif'
          : 'jpg';
        answerImage = `${session.id}-${question.q_order}-${Date.now()}.${ext}`;
        fs.writeFileSync(path.join(config.uploadsDir, answerImage), buffer);
        console.log(`[exam] Saved photo answer as ${answerImage}`);

        // Read the handwritten answer from the photo
        // Primary: AI vision providers (best for handwritten text)
        // Fallback: local OCR (tesseract.js)
        let readSuccess = false;
        
        // Try AI vision first (much better for handwritten text than Tesseract)
        if (ai.aiConfigured()) {
          try {
            console.log(`[exam] Reading photo with AI vision...`);
            const readText = await ai.readPhotoAnswer(answerImage, question.text);
            if (readText && readText !== '[unreadable]' && readText.length > 1) {
              answerText = readText;
              puterRead = true;
              readSuccess = true;
              console.log(`[ai] Read answer: ${answerText.slice(0, 150)}...`);
            }
          } catch (err) {
            console.error(`[ai] Vision read failed: ${err.message}`);
          }
        }
        
        // Fallback to local OCR if AI vision didn't work
        if (!readSuccess) {
          try {
            console.log(`[exam] Falling back to local OCR (tesseract.js)...`);
            const ocrResult = await ocr.readPhotoAnswer(answerImage, question.text);
            if (ocrResult.success && ocrResult.text && ocrResult.text !== '[unreadable]' && ocrResult.text.length > 1) {
              answerText = ocrResult.text;
              puterRead = true;
              readSuccess = true;
              console.log(`[ocr] Read answer (${ocrResult.confidence}% conf): ${answerText.slice(0, 150)}...`);
            }
          } catch (err) {
            console.error(`[ocr] Read failed: ${err.message}`);
          }
        }
        
        if (!readSuccess) {
          // Both AI vision and OCR failed - store the photo but mark for review
          // Don't use placeholder text that would be marked as 0
          answerText = '(photo answer - awaiting manual review)';
          console.log(`[exam] Could not read photo answer, marking for manual review`);
        }
      } catch (err) {
        console.error('[exam] photo answer download/render failed:', err.message);
        console.error('[exam] Full error:', err.stack);
        // Try to send a more helpful error message
        const errorMsg = err.message.includes('metadata')
          ? 'Sorry, I could not process your photo. The image may be too large or the connection timed out. Please try sending a smaller photo.'
          : 'Sorry, I could not receive your photo. Please try again.';
        await wa.sendText(student.phone, errorMsg);
        return false;
      }
    }
    if (meta.mediaType === 'audio') {
      console.log(`[exam] Received audio from ${student.phone}, mediaId=${meta.mediaId}`);
      try {
        if (!meta.mediaId) {
          throw new Error('No media ID in audio message');
        }
        const { buffer, mimeType } = await wa.downloadMedia(meta.mediaId);
        if (!buffer || buffer.length === 0) {
          throw new Error('Downloaded audio buffer is empty');
        }
        console.log(`[exam] Downloaded audio: ${buffer.length} bytes, mimeType=${mimeType}`);
        const ext = mimeType?.includes('mp3') ? 'mp3'
          : mimeType?.includes('wav') ? 'wav'
          : 'ogg';
        const audioFile = `${session.id}-${question.q_order}-${Date.now()}.${ext}`;
        fs.writeFileSync(path.join(config.uploadsDir, audioFile), buffer);
        console.log(`[exam] Saved audio answer as ${audioFile}`);

        // Transcribe the audio using AI
        if (ai.aiConfigured()) {
          try {
            console.log(`[exam] Transcribing audio with AI...`);
            const transcribed = await ai.transcribeAudio(audioFile, question.text);
            if (transcribed && transcribed !== '[inaudible]' && transcribed.trim().length > 0) {
              answerText = transcribed.trim();
              console.log(`[ai] Transcribed: ${answerText.slice(0, 150)}...`);
            } else {
              // Transcription returned empty or inaudible
              answerText = '(audio answer - could not transcribe)';
              console.log(`[ai] Transcription returned empty or inaudible`);
            }
          } catch (err) {
            console.error(`[ai] Audio transcription failed: ${err.message}`);
            answerText = '(audio answer - transcription failed)';
          }
        } else {
          answerText = '(audio answer - AI not configured)';
        }
      } catch (err) {
        console.error('[exam] audio answer download failed:', err.message);
        console.error('[exam] Full error:', err.stack);
        const errorMsg = err.message.includes('metadata')
          ? 'Sorry, I could not process your audio. The file may be too large or the connection timed out. Please try again.'
          : 'Sorry, I could not receive your audio. Please try again.';
        await wa.sendText(student.phone, errorMsg);
        return false;
      }
    }
    const context = [question.passage, question.text].filter(Boolean).join('\n\n');

    // PHOTO ANSWER: store as pending — marking is deferred to markAllPendingTheory
    if (answerImage) {
      // The OCR/AI read above already populated answerText.  Store as pending
      // so markAllPendingTheory can grade it at finalization via
      // markTheoryImageAnswer (the proven single-shot image→read→mark path).
      db.prepare(
        `INSERT INTO answers (session_id, question_id, q_order, answer_text, answer_image, is_correct, marks_awarded, max_marks, marked_by, ai_feedback, needs_review, ai_detected)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        session.id, question.id, question.q_order, answerText, answerImage,
        null, 0, question.marks, 'pending', '', 0, 0
      );
    } else {
      // TEXT ANSWER or no Puter.js: store as pending, mark later
      db.prepare(
        `INSERT INTO answers (session_id, question_id, q_order, answer_text, answer_image, is_correct, marks_awarded, max_marks, marked_by, ai_feedback, needs_review, ai_detected)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        session.id, question.id, question.q_order, answerText, answerImage,
        null, 0, question.marks, 'pending', '', 0, 0
      );
    }

    if (ai.aiConfigured() && !answerImage) {
      trackSessionTask(session.id, (async () => {
        let aiDetected = 0;
        let caution = '';
        try {
          const det = await ai.detectAiGeneratedAnswer({ questionText: context, studentAnswer: answerText });
          if (det.ai_generated) {
            aiDetected = 1;
            // The number the student saw on the bubble: per-type
            // (theory question 1, not question 41).
            const shown = questionDisplayNumbers(session.id).get(question.id) || question.q_order;
            caution =
              `⚠️ *Warning: AI-written answer detected*\n\n` +
              `Your answer to Question ${shown} looks like it was written by an AI (e.g. ChatGPT, Gemini, Claude) and copied in.\n\n` +
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
    // If no scheme (non-pool question or pool scheme missing), try to load from DB
    if (!scheme || (!scheme.model_answer && !scheme.correct_answer)) {
      const dbScheme = marking.getScheme(question.id);
      if (dbScheme) scheme = dbScheme;
    }
    // Check if the scheme has meaningful content
    const schemeHasContent = scheme && (
      (scheme.model_answer && scheme.model_answer.trim()) ||
      (Array.isArray(scheme.key_points) && scheme.key_points.length > 0 && scheme.key_points.some(kp => kp && kp.trim())) ||
      (Array.isArray(scheme.rubric) && scheme.rubric.length > 0 && scheme.rubric.some(r => r && r.point && r.point.trim()))
    );
    // If still no usable scheme, generate it now (for manually created questions)
    if (!schemeHasContent) {
      if (question.type === 'theory' && ai.aiConfigured()) {
        try {
          console.log(`[exam] Generating marking scheme for question ${question.id} (text: "${(question.text || '').slice(0, 80)}")...`);
          scheme = await marking.buildMarkingScheme(question);
          const newHasContent = scheme && (
            (scheme.model_answer && scheme.model_answer.trim()) ||
            (Array.isArray(scheme.key_points) && scheme.key_points.length > 0 && scheme.key_points.some(kp => kp && kp.trim()))
          );
          console.log(`[exam] Scheme generated for question ${question.id}: hasContent=${newHasContent}`);
        } catch (err) {
          console.error(`[exam] Failed to generate scheme for question ${question.id}:`, err.message);
          scheme = null; // Will trigger no-scheme grading mode in markTheoryAnswer
        }
      } else if (question.type === 'theory' && !ai.aiConfigured()) {
        console.log(`[exam] AI not configured, cannot generate scheme for question ${question.id}`);
        scheme = null; // Will trigger heuristic fallback
      }
    }
    let marked;
    if (a.answer_image) {
      // Photo answer: use image-based marking via marking service
      try {
        console.log(`[exam] Marking pending photo answer ${a.id}...`);
        const imgResult = await marking.markTheoryImageAnswer(question, a.answer_text || '(photo answer)', a.answer_image, scheme);

        // Always set marked_by='ai' so the answer is never reprocessed in a loop.
        // needs_review=1 flags it for admin attention when marking failed or was uncertain.
        db.prepare(
          `UPDATE answers SET marked_by='ai', marks_awarded=?, ai_feedback=?, answer_text=?, needs_review=?, marked_at=datetime('now') WHERE id=?`
        ).run(
          imgResult.marksAwarded,
          imgResult.feedback || '',
          a.answer_text || '(photo answer)',
          imgResult.needsReview ? 1 : 0,
          a.id
        );
        console.log(`[exam] Pending photo marked: ${imgResult.marksAwarded}/${question.marks} (needsReview=${imgResult.needsReview})`);
        return;
      } catch (err) {
        console.error(`[exam] AI marking failed for pending photo:`, err.message);
      }

      // All attempts failed — mark as needing review with 0 marks, but mark as 'ai'
      // so it is not reprocessed in an infinite loop
      db.prepare(
        `UPDATE answers SET needs_review=1, marked_by='ai', marks_awarded=0, ai_feedback=?, marked_at=datetime('now') WHERE id=?`
      ).run('Photo answer could not be read by AI. Awaiting manual review.', a.id);
      return;
    }
    
    // Handle audio answers that couldn't be transcribed
    if (a.answer_text && a.answer_text.startsWith('(audio answer')) {
      // Audio transcription failed - mark for review
      db.prepare(
        `UPDATE answers SET needs_review=1, marked_by='ai', marks_awarded=0, ai_feedback=?, marked_at=datetime('now') WHERE id=?`
      ).run('Audio answer could not be transcribed. Awaiting manual review.', a.id);
      console.log(`[exam] Audio answer ${a.id} could not be transcribed, marked for review`);
      return;
    }
    
    try {
      marked = await marking.markTheoryAnswer(question, a.answer_text, scheme);
    } catch (err) {
      await delay(1000);
      try {
        marked = await marking.markTheoryAnswer(question, a.answer_text, scheme);
      } catch (err2) {
        // AI failed twice — try heuristic keyword fallback
        console.log(`[exam] AI marking failed for answer ${a.id}, trying heuristic fallback`);
        const sch = scheme || marking.getScheme(question.id);
        const h = marking.heuristicMark(question, a.answer_text, sch);
        db.prepare(
          `UPDATE answers SET marked_by='ai', marks_awarded=?, needs_review=0, ai_feedback=?, marked_at=datetime('now') WHERE id=?`
        ).run(
          h.marksAwarded,
          h.marksAwarded > 0 ? h.feedback : `Heuristic fallback awarded ${h.marksAwarded}/${question.marks} marks. ${h.feedback}`,
          a.id
        );
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
  // Atomically claim the session so two concurrent finalizers (timer cleanup +
  // inbound message, duplicate webhook delivery) cannot both run the drain/mark/
  // send flow and deliver duplicate results and certificates.
  const claimed = db.prepare(
    `UPDATE sessions SET status = 'finalizing' WHERE id = ? AND status = 'in_progress'`
  ).run(session.id);
  if (claimed.changes === 0) return;
  await drainSession(session.id); // background AI work must finish before results are computed
  await markAllPendingTheory(session.id);
  const result = results.computeForSession(session.id);

  // Send results BEFORE marking status so that if the send fails, the session
  // remains in_progress and can be retried on the next cleanup cycle.
  let resultSent = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await results.sendResultMessage(session.id, student.phone, reason);
      resultSent = true;
      break;
    } catch (err) {
      console.error(`[exam] result send attempt ${attempt} failed for ${student.phone}:`, err.message);
      if (attempt < 3) await delay(2000 * attempt);
    }
  }

  if (!resultSent) {
    // Restore the previous in_progress state so the cleanup cycle retries this
    // session instead of leaving the student with no grade message and a dead end.
    console.error(`[exam] FAILED to send results to ${student.phone} after 3 attempts. Session restored to in_progress for retry.`);
    db.prepare(`UPDATE sessions SET status = 'in_progress' WHERE id = ? AND status = 'finalizing'`).run(session.id);
    return;
  }

  // NOW mark the session as ended/expired — after results have been sent.
  db.prepare(
    `UPDATE sessions SET status = ?, ended_at = datetime('now'), final_score = ?, final_percentage = ?, passed = ?
     WHERE id = ?`
  ).run(reason, result.score, result.percentage, result.passed ? 1 : 0, session.id);

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

/**
 * Release finalize() claims left behind by a crash or redeploy.
 *
 * finalize() claims a session by flipping in_progress → finalizing so a second
 * finalizer cannot race it. If the process dies between that claim and the
 * closing UPDATE, the session is stranded: the cleanup only scans in_progress,
 * the dashboard counts it as neither active nor finished, and the student never
 * gets a grade. Called once at startup, before anything can be finalizing.
 */
function recoverInterruptedFinalizes() {
  const info = db.prepare(`UPDATE sessions SET status = 'in_progress' WHERE status = 'finalizing'`).run();
  if (info.changes) {
    console.log(`[recover] released ${info.changes} session(s) left claimed by an interrupted finalize`);
  }
  return info.changes;
}

// ── Admin: end an exam ─────────────────────────────────────────────────

/**
 * Recover sessions left in_progress past their deadline by a crash or
 * redeploy: each is finalized exactly like timer expiry (report + WhatsApp
 * result + certificate). One failing session never blocks the rest.
 */
async function finalizeStaleSessions() {
  // Find sessions that are in_progress but whose deadline has passed.
  // Use consistent UTC comparison: append 'Z' to SQLite datetime strings.
  const stale = db.prepare(
    `SELECT s.id, s.student_id, s.started_at, e.duration_minutes
     FROM sessions s
     JOIN exams e ON e.id = s.exam_id
     WHERE s.status = 'in_progress'
       AND s.started_at IS NOT NULL`
  ).all();

  const now = Date.now();
  const staleIds = [];
  for (const row of stale) {
    const startedAtStr = String(row.started_at || '');
    const utcStr = /[Zz]|[+-]\d{2}:\d{2}$/.test(startedAtStr) ? startedAtStr : startedAtStr + 'Z';
    const deadlineMs = new Date(utcStr).getTime() + row.duration_minutes * 60000;
    if (now > deadlineMs) staleIds.push(row);
  }

  let n = 0;
  for (const row of staleIds) {
    try {
      const session = db.prepare(
        `SELECT s.*, e.duration_minutes, e.pass_percentage FROM sessions s
         JOIN exams e ON e.id = s.exam_id WHERE s.id = ?`
      ).get(row.id);
      const student = db.prepare('SELECT * FROM students WHERE id = ?').get(row.student_id);
      if (!session || !student) continue;
      await finalize(session, student, 'expired');
      console.log(`[cleanup] finalized stale session ${row.id} (${student.phone})`);
      n++;
    } catch (err) {
      console.error(`[cleanup] failed to finalize stale session ${row.id}:`, err.message);
    }
  }
  if (n) console.log(`[cleanup] finalized ${n} stale session(s) — reports, certificates and results were sent.`);
  return n;
}

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

  // Process sessions in parallel with concurrency limit instead of sequentially.
  // With 100 students, sequential processing could take 50+ minutes.
  await mapLimit(active, config.exam.sendConcurrency, async (s) => {
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
  });

  return { ended: active.length };
}

// ── Background cleanup ──────────────────────────────────────────────────

let staleCleanupTimer = null;

/**
 * Start a periodic background task that finalizes expired sessions.
 * Without this, sessions past their deadline stay in_progress until the
 * next server restart — meaning students get stuck mid-exam forever.
 */
function startStaleSessionCleanup() {
  if (staleCleanupTimer) return; // already running
  const intervalMs = config.exam.staleSessionCleanupIntervalMs || 60000;
  staleCleanupTimer = setInterval(async () => {
    try {
      const n = await finalizeStaleSessions();
      if (n) console.log(`[cleanup] Finalized ${n} stale session(s)`);
    } catch (err) {
      console.error('[cleanup] Stale session cleanup error:', err.message);
    }
  }, intervalMs);
  // Don't keep the process alive just for cleanup
  if (staleCleanupTimer.unref) staleCleanupTimer.unref();
  console.log(`[cleanup] Stale session cleanup started (interval: ${intervalMs}ms)`);
}

function stopStaleSessionCleanup() {
  if (staleCleanupTimer) {
    clearInterval(staleCleanupTimer);
    staleCleanupTimer = null;
  }
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
async function sendIntro(session, student, exam, count, template, { force = false } = {}) {
  const entry = outbox.enqueue({ sessionId: session.id, kind: 'intro', recipient: student.phone });
  if (force && entry.state === 'sent') {
    // Resending an invite the student never answered is the whole point of a
    // resend, so the recorded-but-already-sent entry goes back in the queue
    // instead of short-circuiting the send.
    db.prepare("UPDATE message_outbox SET state='queued', error='', sent_at=NULL WHERE id=?").run(entry.id);
    entry.state = 'queued';
  }
  if (entry.state === 'sent') return;
  try {
    // A paid paper sends ONLY the checkout link. The invite is the message
    // that tells a student to "Reply *START* to this chat to open it" — advice
    // that is a lie while the paper sits behind a paywall, and a second bubble
    // they cannot act on until they have paid. The link is the whole
    // invitation; the instructions arrive with the paper the moment it opens.
    //
    // tryDeliverLink swallows its own gateway failures into a plain apology, so
    // a null back means nothing usable reached the student. Throwing instead of
    // marking the intro sent keeps the delivery report honest and lets the
    // retry cron pick the recipient up again.
    if (payments.isPaidExam(exam)) {
      const link = await payments.tryDeliverLink(student, exam);
      if (!link) throw new Error('The payment link could not be delivered.');
      outbox.markSent(entry.id);
      recordAcceptance(session);
      return;
    }
    if (template) {
      const values = config.whatsapp.templateParams.length ? config.whatsapp.templateParams
        : [exam.title, exam.subject || 'General', String(exam.duration_minutes), String(count)];
      await wa.sendTemplate(student.phone, template, config.whatsapp.templateLanguage, values.map(text => ({ type: 'text', text })));
    } else {
      // '' for a paid paper — never reached, because the link above returns
      // first. Kept as a check so an empty bubble cannot reach the chat even
      // if that ordering ever changes.
      const intro = formatExamIntro(exam, count);
      if (intro) await wa.sendText(student.phone, intro);
    }
    outbox.markSent(entry.id);
    recordAcceptance(session);
  } catch (error) {
    outbox.markFailed(entry.id, error, Math.max(1, config.exam.sendRetries));
    throw error;
  }
}

async function sendExamToStudent(exam, student, questionCount, template, report) {
  const phone = student.phone;
  let session = latestSession(exam.id, student.id);
  let fresh = false;

  try {
    if (!session) {
      session = createSession(exam.id, student.id);
      fresh = true;
    } else if (session.status === 'abandoned' || session.status === 'expired') {
      session = restartSession(session);
      fresh = true;
    } else if (session.status === 'in_progress') {
      // No start time means the invite went out and the student never replied.
      // That is not a live attempt, so nudging them a question they have never
      // seen would be wrong — re-deliver the invite and leave the clock alone.
      if (!session.started_at) {
        await sendIntro(session, student, exam, getSessionQuestionCount(session.id) || questionCount, template, { force: true });
        report.sent++;
        return;
      }
      // A session whose timer already lapsed must restart, or the next
      // answer would be rejected by the deadline check.
      const startedAtStr = String(session.started_at || '');
      const utcStr = /[Zz]|[+-]\d{2}:\d{2}$/.test(startedAtStr) ? startedAtStr : startedAtStr + 'Z';
      const expiredAt = new Date(new Date(utcStr).getTime() + exam.duration_minutes * 60000).getTime();
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
      // The clock does not run from the send. createSession/restartSession
      // already left started_at NULL; re-assert it so a session carried over
      // from an older code path cannot resume a stale countdown.
      db.prepare('UPDATE sessions SET started_at=NULL WHERE id=?').run(session.id);
      await sendIntro(session, student, exam, attemptCount, template);
      // Only the invite goes out now. Question 1 is delivered by handleInbound
      // when the student actually replies, so that starting the clock and
      // receiving the paper are the same event rather than two separate ones.
      report.sent++;
      return;
    }
    await sendQuestionTo(session, student);
    report.sent++;
  } catch (err) {
    // Instead of permanently abandoning, mark as pending retry so the
    // background cleanup can re-attempt delivery.
    report.failed++;
    report.errors.push({ phone, error: friendlyError(err) });
    if (session) {
      const retries = (session.retry_count || 0) + 1;
      if (retries < config.exam.sendRetries) {
        // Leave as in_progress so cleanup cron retries
        db.prepare(`UPDATE sessions SET retry_count = ?, last_active_at = datetime('now') WHERE id = ?`).run(retries, session.id);
        console.log(`[exam] Send failed for ${phone}, retry ${retries}/${config.exam.sendRetries} queued`);
      } else {
        db.prepare(`UPDATE sessions SET status = 'abandoned', ended_at = datetime('now') WHERE id = ?`).run(session.id);
        console.log(`[exam] Send failed for ${phone} after ${retries} retries — session abandoned`);
      }
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
  if (!['published', 'live'].includes(exam.status)) {
    report.skipped = recipients.length;
    return report;
  }
  const questionCount = db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(examId).c;
  const template = config.whatsapp.templateName;
  const limit = config.exam.sendConcurrency;

  await mapLimit(recipients, limit, (student) =>
    sendExamToStudent(exam, student, questionCount, template, report)
  );
  return report;
}

/**
 * Re-invite recipients. With no `studentIds` the target is every recipient who
 * has no started attempt — the cohort that got the invite but never began, plus
 * anyone whose send failed. An explicit list is honoured as given, so a
 * per-student resend can also nudge somebody already mid-exam.
 */
async function resendExamToRecipients(examId, studentIds = null) {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
  if (!exam) throw new Error('Exam not found');
  const report = { sent: 0, failed: 0, skipped: 0, resumed: 0, errors: [] };
  if (!['published', 'live'].includes(exam.status)) {
    report.skipped = db
      .prepare('SELECT COUNT(*) c FROM exam_recipients WHERE exam_id = ?')
      .get(examId).c;
    return report;
  }

  const unique = [...new Set(
    (Array.isArray(studentIds) ? studentIds : [])
      .map(Number)
      .filter((v) => Number.isInteger(v) && v > 0)
  )];
  const placeholders = unique.map(() => '?').join(',');
  const rows = unique.length
    ? db.prepare(
        `SELECT s.* FROM students s
         JOIN exam_recipients r ON r.student_id = s.id
         WHERE r.exam_id = ? AND s.id IN (${placeholders})`
      ).all(examId, ...unique)
    : db.prepare(
        `SELECT s.* FROM students s
         JOIN exam_recipients r ON r.student_id = s.id
         WHERE r.exam_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM sessions ss
              WHERE ss.exam_id = r.exam_id AND ss.student_id = s.id
                AND ss.started_at IS NOT NULL
           )`
      ).all(examId);

  const questionCount = db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(examId).c;
  const template = config.whatsapp.templateName;
  await mapLimit(rows, config.exam.sendConcurrency, (student) =>
    sendExamToStudent(exam, student, questionCount, template, report)
  );
  return report;
}

module.exports = {
  normalizePhone,
  splitRecipients,
  getOrCreateStudent,
  addRecipients,
  getActiveSession,
  createSession,
  recoverQueuedSends,
  handleInbound,
  // Exported for the paywall: payments.unlock() opens the paper from the
  // webhook, which runs outside any inbound message.
  maybeStartSession,
  processAnswer,
  handleAnswer,
  finalize,
  finalizeStaleSessions,
  recoverInterruptedFinalizes,
  endExam,
  sendExamToRecipients,
  resendExamToRecipients,
  sendQuestionTo,
  restartSession,
  getSessionQuestion,
  getSessionQuestionCount,
  sessionQuestionSequence,
  drawSessionQuestions,
  topUpPool,
  nextInSequence,
  firstUnansweredSelected,
  questionDisplayNumbers,
  deadline,
  timeRemaining,
  markAllPendingTheory,
  drainSession,
  formatQuestion,
  formatSubQuestions,
  formatExamIntro,
  buildQuestionBubbles,
  isSectionHeader,
  splitQuestionHeadings,
  stripPaperOnlyInstructions,
  splitSectionMeta,
  startStaleSessionCleanup,
  stopStaleSessionCleanup,
};
