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

// ── Question send ──────────────────────────────────────────────────────

function formatQuestion(exam, question, qIndex, qCount) {
  const header = `📝 ${exam.title}\nQuestion ${qIndex} of ${qCount}  •  ${question.marks} mark${question.marks === 1 ? '' : 's'}\n${'─'.repeat(30)}\n`;
  if (question.type === 'objective') {
    const options = JSON.parse(question.options || '[]');
    const body = options.map((o) => `${o.key}. ${o.text}`).join('\n');
    return `${header}${question.text}\n\n${body}\n\nReply with the letter of your answer (e.g. A).`;
  }
  return `${header}${question.text}\n\nType your full answer as a single message.`;
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
  const text = formatQuestion(exam, question, question.q_order, count);
  await wa.sendText(student.phone, text);
  return true;
}

// ── Entry point for inbound WhatsApp messages ──────────────────────────

async function handleInbound(phone, body) {
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

  await processAnswer(session, student, body);
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
      `Hi! You have no pending exams right now. If an exam has been sent to you, reply to the exam message to begin.`
    );
    return { ok: false, reason: 'no_exam' };
  }

  const exam = candidates[0];
  const session = createSession(exam.id, student.id);
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

async function processAnswer(session, student, body) {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(session.exam_id);
  const question = db
    .prepare('SELECT * FROM questions WHERE exam_id = ? AND q_order = ?')
    .get(exam.id, session.current_q_order);
  if (!question) return;

  const already = db
    .prepare('SELECT id FROM answers WHERE session_id = ? AND question_id = ?')
    .get(session.id, question.id);
  if (already) return;

  const next = await handleAnswer(exam, session, student, question, body);
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

async function handleAnswer(exam, session, student, question, body) {
  let result;
  if (question.type === 'objective') {
    if (!marking.isObjectiveAnswer(body)) {
      await wa.sendText(student.phone, '⚠️ Please reply with the letter of your answer only (e.g. A, B, C or D).');
      return false;
    }
    result = marking.markObjective(question, body);
    const saved = db
      .prepare(
        `INSERT INTO answers (session_id, question_id, q_order, answer_text, is_correct, marks_awarded, max_marks, marked_by, marked_at)
         VALUES (?,?,?,?,?,?,?,?,datetime('now'))`
      )
      .run(
        session.id, question.id, question.q_order, marking.normalizeAnswer(body),
        result.isCorrect ? 1 : 0, result.marksAwarded, result.maxMarks, 'auto'
      );

    const feedback = [
      result.isCorrect ? '✅ Correct!' : '❌ Wrong.',
      question.explanation ? `\n${question.explanation}` : '',
    ].join('');
    await wa.sendText(student.phone, feedback);
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
  const report = { sent: 0, failed: 0, errors: [] };

  for (const student of recipients) {
    let session = db.prepare('SELECT * FROM sessions WHERE exam_id = ? AND student_id = ?').get(examId, student.id);
    let fresh = false;

    try {
      if (!session) {
        session = createSession(examId, student.id);
        fresh = true;
      } else if (session.status === 'abandoned') {
        db.prepare(
          `UPDATE sessions SET status='in_progress', current_q_order=1, started_at=datetime('now'), ended_at=NULL WHERE id=?`
        ).run(session.id);
        session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
        fresh = true;
      } else if (session.status !== 'in_progress') {
        continue; // completed/expired — already finished, skip
      }

      if (fresh) {
        await wa.sendText(
          student.phone,
          `📢 ${exam.title} is ready.\n\nReply with your answer to each question. Your exam starts now.`
        );
      }
      await sendQuestionTo(session, student);
      report.sent++;
    } catch (err) {
      report.failed++;
      report.errors.push({ phone: student.phone, error: err.message });
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
  deadline,
};
