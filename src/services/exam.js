const db = require('../db');
const config = require('../config');
const wa = require('./whatsapp');
const marking = require('./marking');
const results = require('./results');
const certificate = require('./certificate');
const ai = require('./ai');

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

function createSession(examId, studentId) {
  const info = db
    .prepare('INSERT INTO sessions (exam_id, student_id) VALUES (?, ?)')
    .run(examId, studentId);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid);
  drawSessionQuestions(session.id, examId);
  return session;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Assign a fresh random question set for an attempt. When the exam has a
 * question pool, each session draws its own subset in a random order, so
 * different students (and retakes) see different questions.
 */
function drawSessionQuestions(sessionId, examId) {
  const n = db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(examId).c;
  if (!n) return 0;
  const pool = db.prepare('SELECT id FROM question_pool WHERE exam_id = ?').all(examId);
  if (!pool.length) return 0;
  const chosen = shuffle(pool).slice(0, n);
  const ins = db.prepare(
    'INSERT INTO session_questions (session_id, question_id, q_order) VALUES (?,?,?)'
  );
  chosen.forEach((p, i) => ins.run(sessionId, p.id, i + 1));
  return chosen.length;
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

function formatQuestion(exam, question, qCount) {
  return `Question ${question.q_order}\n${question.text}`;
}

/** mm:ss left on the clock, computed from the session start + exam duration. */
function timeRemaining(session, exam) {
  const ms = new Date(session.started_at).getTime() + exam.duration_minutes * 60000 - Date.now();
  const total = Math.max(0, Math.round(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
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
      ? 'Type your full answer to each question as a single message.'
      : 'After each question, its answer options are sent in a separate message; reply with the letter of your answer (e.g. *A*).',
    'Answers are locked once you send them.',
    'Your timer starts now. The exam ends automatically when time is up.',
  ];
  const instructions = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return (
    `*${String(exam.title).toUpperCase()}*\n\n` +
    `Subject: *${exam.subject || 'General'}*\n` +
    `Exam type: *${type}*\n` +
    `Duration: *${exam.duration_minutes} minute${exam.duration_minutes === 1 ? '' : 's'}*\n` +
    `Number of questions: *${questionCount}*\n` +
    `Pass mark: *${exam.pass_percentage}%*\n\n` +
    `👋 *New to the bot?* Reply *START* to this chat to open it — your exam begins instantly.\n\n` +
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
  const count = db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(exam.id).c;
  const question = getSessionQuestion(session.id, session.current_q_order);
  if (!question) {
    await finalize(session, student);
    return false;
  }
  await wa.sendText(student.phone, formatQuestion(exam, question, count));
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
    let qo = question.q_order + 1;
    let nq = getSessionQuestion(session.id, qo);
    while (
      nq &&
      db.prepare('SELECT id FROM answers WHERE session_id = ? AND question_id = ?').get(session.id, nq.id)
    ) {
      qo += 1;
      nq = getSessionQuestion(session.id, qo);
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
  const nextQ = getSessionQuestion(session.id, question.q_order + 1);
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
  let result;
  if (question.type === 'objective') {
    const letter = resolveObjectiveLetter(question, body, meta);
    if (!letter) {
      await wa.sendText(
        student.phone,
        '⚠️ That doesn\u2019t look like an answer.\n\nType the letter of your answer (e.g. *A*).'
      );
      return false;
    }
    result = marking.markObjective(question, letter);
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
    // theory — AI marked
    const answerText = body;
    let marked = null;
    let err = null;
    try {
      let scheme = null;
      if (question._pool) {
        try {
          scheme = JSON.parse(question.scheme_json || '{}');
        } catch {
          scheme = null;
        }
      }
      marked = await marking.markTheoryAnswer(question, answerText, scheme);
    } catch (e) {
      err = e;
    }

    let marksAwarded = 0;
    let feedback = '';
    let needsReview = 0;
    if (marked) {
      marksAwarded = marked.marksAwarded;
      feedback = marked.feedback;
    } else {
      marksAwarded = 0;
      needsReview = 1;
      feedback = 'This answer needs manual review by your administrator.';
      err = null; // not fatal
    }

    db.prepare(
      `INSERT INTO answers (session_id, question_id, q_order, answer_text, is_correct, marks_awarded, max_marks, marked_by, ai_feedback, needs_review, marked_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))`
    ).run(
      session.id, question.id, question.q_order, answerText,
      null, marksAwarded, question.marks,
      marked ? 'ai' : 'manual', feedback, needsReview
    );

    await wa.sendText(student.phone, feedback);
  }
  return true;
}

// ── Finalize ───────────────────────────────────────────────────────────

async function finalize(session, student, reason = 'completed') {
  if (session.status !== 'in_progress') return;
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
  finalize,
  endExam,
  sendExamToRecipients,
  sendQuestionTo,
  restartSession,
  getSessionQuestion,
  getSessionQuestionCount,
  drawSessionQuestions,
  deadline,
};
