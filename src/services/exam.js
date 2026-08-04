const db = require('../db');
const config = require('../config');
const wa = require('./whatsapp');
const marking = require('./marking');
const results = require('./results');
const ai = require('./ai');

// ── Students ───────────────────────────────────────────────────────────

function normalizePhone(raw) {
  let p = String(raw || '').replace(/[^\d]/g, '');
  if (!p) return '';
  if (p.startsWith('0')) {
    p = p.slice(1);
    if (p.length === 9) return '233' + p;  // Ghana local (0XX... 10 digits) -> +233
    if (p.length === 10) return '234' + p; // Nigeria local (0XX... 11 digits) -> +234
    return p;
  }
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
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid);
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

/** Render the A–D options as a decorated, button-like bubble card. */
function formatOptionsBox(options) {
  const inner = options
    .map((o) => `┃  ${o.key} · ${o.text}`)
    .join('\n');
  return (
    `╭──────────────────────────────╮\n` +
    inner + '\n' +
    `╰──────────────────────────────╯`
  );
}

function formatQuestion(exam, question, qCount) {
  const subject = exam.subject ? `📚 Subject: *${exam.subject}*\n` : '';
  const marks = question.marks === 1 ? '1 mark' : `${question.marks} marks`;
  const header =
    `🧠 *${exam.title.toUpperCase()}*\n` +
    subject +
    `✍️ *Question ${question.q_order} of ${qCount}* · ${marks}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n`;

  if (question.type === 'objective') {
    const options = JSON.parse(question.options || '[]');
    const letters = options.map((o) => o.key).join(', ');
    return (
      `${header}${question.text}\n\n` +
      formatOptionsBox(options) + '\n\n' +
      `Tap the *answer bubble* ⬇️ below, or type a letter (${letters}).`
    );
  }
  return `${header}${question.text}\n\n*Type your full answer as a single message.*`;
}

function formatExamIntro(exam, questionCount) {
  return (
    `✅ *You have a new exam!*\n\n` +
    `📝 *${exam.title}*${exam.subject ? `\n📚 *Subject: ${exam.subject}*` : ''}\n` +
    `⏱️ Duration: *${exam.duration_minutes} minute${exam.duration_minutes === 1 ? '' : 's'}*\n` +
    `✍️ Questions: *${questionCount}*\n` +
    `🎯 Pass mark: *${exam.pass_percentage}%*\n\n` +
    `Tap an option to answer each question as it arrives. Answers are locked once selected. Your timer starts now. Good luck! 🍀`
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
  db.prepare(
    `UPDATE sessions SET status='in_progress', current_q_order=1, started_at=datetime('now'),
       last_active_at=datetime('now'), ended_at=NULL, final_score=0, final_percentage=0, passed=0
     WHERE id = ?`
  ).run(session.id);
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
}

/** Human-friendly summary of a WhatsApp send error. */
function friendlyError(err) {
  const msg = (err && (err.message || String(err))) || 'Unknown error';
  if (msg.includes('131026') || (err && err.code === 131026)) {
    return 'No open 24h session for this number. The student must message your WhatsApp number once first, or set WHATSAPP_TEMPLATE_NAME to an approved template for first-contact delivery.';
  }
  if (msg.includes('131030') || msg.includes('131043') || msg.includes('132000')) {
    return `Template issue (${err && err.code}: ${err && err.metaCode ? err.metaCode : msg}). Create/approve the template in the Meta dashboard, then set WHATSAPP_TEMPLATE_NAME.`;
  }
  return msg;
}

async function sendQuestionTo(session, student) {
  session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(session.exam_id);
  const count = db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(exam.id).c;
  const question = db
    .prepare('SELECT * FROM questions WHERE exam_id = ? AND q_order = ?')
    .get(exam.id, session.current_q_order);
  if (!question) {
    await finalize(session, student);
    return false;
  }
  const text = formatQuestion(exam, question, count);
  await wa.sendText(student.phone, text);

  if (question.type === 'objective') {
    const options = (JSON.parse(question.options || '[]') || []).slice(0, 10);
    try {
      await wa.sendAnswerButtons(student.phone, `Question ${question.q_order}`, options);
    } catch (err) {
      // Bubble buttons are the primary picker. Fall back to an interactive
      // list, then to typed letters, so the question is never lost.
      console.error(`[exam] interactive picker failed for Q${question.q_order}:`, err.message);
      try {
        const rows = options.map((o) => ({
          id: String(o.key),
          title: String(o.text).slice(0, 24) || o.key,
        }));
        await wa.sendInteractiveList(
          student.phone,
          `Question ${question.q_order}`,
          `${exam.title} — Q${question.q_order} (${question.marks} mark${question.marks === 1 ? '' : 's'})\nTap an option to submit your answer.`,
          'Choose answer',
          rows
        );
      } catch (err2) {
        await wa
          .sendText(student.phone, `Reply with the letter of your answer (${options.map((o) => o.key).join(', ')}).`)
          .catch(() => {});
      }
    }
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
  const question = db
    .prepare('SELECT * FROM questions WHERE exam_id = ? AND q_order = ?')
    .get(exam.id, session.current_q_order);
  if (!question) return;

  // A casual greeting is not an answer — resend the question instead of marking it wrong.
  if (question.type === 'objective' && !meta.replyId) {
    const trimmed = body.trim().toLowerCase();
    if (!resolveObjectiveLetter(question, body, meta) && START_WORDS.has(trimmed)) {
      await wa.sendText(
        student.phone,
        '🚀 Let\u2019s go! Read the question and tap an option below, or type the letter (A, B, C or D).'
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
    let nq = db.prepare('SELECT * FROM questions WHERE exam_id = ? AND q_order = ?').get(exam.id, qo);
    while (
      nq &&
      db.prepare('SELECT id FROM answers WHERE session_id = ? AND question_id = ?').get(session.id, nq.id)
    ) {
      qo += 1;
      nq = db.prepare('SELECT * FROM questions WHERE exam_id = ? AND q_order = ?').get(exam.id, qo);
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
  const nextQ = db
    .prepare('SELECT * FROM questions WHERE exam_id = ? AND q_order = ?')
    .get(exam.id, question.q_order + 1);
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
        '⚠️ That doesn\u2019t look like an answer.\n\nTap ⬇️ *"Choose answer"* and pick an option, or type the letter of your answer (e.g. *A*).'
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
      marked = await marking.markTheoryAnswer(question, answerText, null);
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
}

// ── Admin: send exam to recipients ─────────────────────────────────────

async function sendExamToRecipients(examId) {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
  if (!exam) throw new Error('Exam not found');
  const recipients = db
    .prepare(
      `SELECT s.* FROM exam_recipients r JOIN students s ON s.id = r.student_id WHERE r.exam_id = ?`
    )
    .all(examId);
  const report = { sent: 0, failed: 0, skipped: 0, errors: [] };
  const questionCount = db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(examId).c;
  const template = config.whatsapp.templateName;

  for (const student of recipients) {
    let session = db.prepare('SELECT * FROM sessions WHERE exam_id = ? AND student_id = ?').get(examId, student.id);
    let fresh = false;

    try {
      if (!session) {
        session = createSession(examId, student.id);
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
          // Already actively on a question — do NOT re-deliver the current
          // question (that caused "Q1 keeps repeating" on re-sends).
          report.skipped++;
          continue;
        }
      } else {
        continue; // completed — already finished
      }

      if (fresh) {
        if (template) {
          const params = config.whatsapp.templateParams.length
            ? config.whatsapp.templateParams.map((p) => ({ type: 'text', text: p }))
            : [
                { type: 'text', text: exam.title },
                { type: 'text', text: exam.subject || 'General' },
                { type: 'text', text: String(exam.duration_minutes) },
                { type: 'text', text: String(questionCount) },
              ];
          await wa.sendTemplate(student.phone, template, config.whatsapp.templateLanguage, params);
        } else {
          await wa.sendText(student.phone, formatExamIntro(exam, questionCount));
        }
      }
      await sendQuestionTo(session, student);
      report.sent++;
    } catch (err) {
      report.failed++;
      report.errors.push({ phone: student.phone, error: friendlyError(err) });
      if (session) {
        db.prepare(`UPDATE sessions SET status = 'abandoned', ended_at = datetime('now') WHERE id = ?`).run(session.id);
      }
    }
  }
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
  sendExamToRecipients,
  sendQuestionTo,
  restartSession,
  deadline,
};
