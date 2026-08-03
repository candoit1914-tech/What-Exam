const db = require('../db');
const config = require('../config');
const wa = require('./whatsapp');

function computeForSession(sessionId) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(session.exam_id);
  const totalMarks = db.prepare('SELECT COALESCE(SUM(max_marks),0) t FROM answers WHERE session_id = ?').get(sessionId).t;
  const awarded = db.prepare('SELECT COALESCE(SUM(marks_awarded),0) s FROM answers WHERE session_id = ?').get(sessionId).s;
  const answered = db.prepare('SELECT COUNT(*) c FROM answers WHERE session_id = ?').get(sessionId).c;
  const questionCount = db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(exam.id).c;

  const percentage = totalMarks > 0 ? Math.round((awarded / totalMarks) * 1000) / 10 : 0;
  return {
    sessionId,
    exam,
    score: awarded,
    totalMarks,
    percentage,
    passed: percentage >= (exam.pass_percentage ?? config.exam.passPercentage),
    answered,
    questionCount,
  };
}

async function sendResultMessage(sessionId, phone, reason) {
  const r = computeForSession(sessionId);
  const passMark = r.exam.pass_percentage;

  let msg =
    `🏁 *Exam complete*\n\n` +
    `📝 ${r.exam.title}${r.exam.subject ? ` — ${r.exam.subject}` : ''}\n` +
    `⏱️ ${reason === 'expired' ? 'Time expired' : 'All questions answered'}\n\n` +
    `🎯 Score: *${r.score} / ${r.totalMarks}*\n` +
    `📊 Percentage: *${r.percentage}%*\n` +
    `Result: ${r.passed ? '✅ *PASS*' : '❌ *FAIL*'} (pass mark ${passMark}%)\n`;

  const key = db
    .prepare(
      `SELECT a.q_order, a.answer_text, a.is_correct, q.correct_answer, q.text FROM answers a
       JOIN questions q ON q.id = a.question_id
       WHERE a.session_id = ? AND q.type = 'objective'
       ORDER BY q.q_order`
    )
    .all(sessionId);
  if (key.length) {
    msg += `\n*Answer key* (yours → correct):\n` +
      key
        .map((k) => {
          const yours = String(k.answer_text || '').toUpperCase();
          const right = String(k.correct_answer || '').toUpperCase();
          const mark = String(k.is_correct) === '1' || k.is_correct === 1 ? '✅' : '❌';
          return `${k.q_order}. ${mark} ${yours} → ${right}`;
        })
        .join('\n') +
      '\n';
  }

  const reviewCount = db
    .prepare('SELECT COUNT(*) c FROM answers WHERE session_id = ? AND needs_review = 1')
    .get(sessionId).c;
  if (reviewCount) msg += `\n⚠️ ${reviewCount} answer(s) pending review by your administrator.\n`;

  msg += `\nFull report: ${config.appUrl}/report/${sessionId}`;

  await wa.sendText(phone, msg);
}

function reportHTML(sessionId) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return { status: 404, html: '<h1>Report not found</h1>' };
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(session.student_id);
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(session.exam_id);
  const r = computeForSession(sessionId);
  const answers = db
    .prepare(
      `SELECT a.*, q.type, q.text, q.options, q.correct_answer, q.marks AS q_marks, q.explanation,
              m.scheme AS scheme
       FROM answers a
       JOIN questions q ON q.id = a.question_id
       LEFT JOIN marking_schemes m ON m.question_id = q.id
       WHERE a.session_id = ?
       ORDER BY q.q_order`
    )
    .all(sessionId);
  const allQuestions = db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(exam.id).c;

  const rows = answers
    .map((a) => {
      let details = '';
      if (a.type === 'objective') {
        const opts = JSON.parse(a.options || '[]');
        details = `<div class="opts">${opts
          .map((o) => `<div class="${o.key === a.correct_answer ? 'correct' : ''}">${o.key}. ${o.text}${o.key === a.correct_answer ? ' ✓' : ''}</div>`)
          .join('')}</div>`;
      } else {
        const sch = a.scheme ? JSON.parse(a.scheme) : null;
        details = `<div class="opts">
          <div><strong>Model answer:</strong> ${esc(sch?.model_answer || '(not available)')}</div>
          ${(sch?.key_points || []).map((k) => `<div class="keypoint">• ${esc(k)}</div>`).join('')}
        </div>`;
      }
      return `<tr>
        <td>${a.q_order}</td>
        <td>${esc(a.text)}</td>
        <td>${a.type}</td>
        <td>${esc(a.answer_text)}</td>
        <td>${a.type === 'objective' ? esc(a.correct_answer) : '—'}</td>
        <td>${a.marks_awarded} / ${a.max_marks}</td>
        <td>${a.marked_by}${a.needs_review ? ' ⚠️' : ''}</td>
        <td>${esc(a.ai_feedback || '')}${details}</td>
      </tr>`;
    })
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Result — ${esc(exam.title)}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#1f2937}
  h1{font-size:1.4rem} .card{background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin:16px 0}
  .score{display:flex;gap:24px;flex-wrap:wrap} .score div{flex:1;min-width:120px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px;text-align:center}
  .score b{display:block;font-size:1.6rem;color:#111827} .pass{color:#15803d}.fail{color:#b91c1c}
  table{width:100%;border-collapse:collapse;margin-top:16px;font-size:.85rem}
  th,td{border:1px solid #e5e7eb;padding:8px;text-align:left;vertical-align:top}
  th{background:#f3f4f6} .correct{color:#15803d}.keypoint{color:#374151}
  .opts{margin-top:6px;font-size:.8rem;color:#4b5563}
  @media print{.noprint{display:none}}
</style></head>
<body>
<div class="noprint" style="text-align:right"><button onclick="window.print()">🖨️ Print / Save as PDF</button></div>
<h1>${esc(exam.title)} — Result Report</h1>
<p><strong>Student:</strong> ${esc(student.name || student.phone)}<br>
<strong>Started:</strong> ${session.started_at} &nbsp; <strong>Ended:</strong> ${session.ended_at || '—'} &nbsp; <strong>Status:</strong> ${session.status}</p>
<div class="card">
  <div class="score">
    <div><b>${r.score}/${r.totalMarks}</b>Score</div>
    <div><b>${r.percentage}%</b>Percentage</div>
    <div><b class="${r.passed ? 'pass' : 'fail'}">${r.passed ? 'PASS' : 'FAIL'}</b>Result</div>
    <div><b>${r.answered}/${r.questionCount}</b>Answered</div>
  </div>
</div>
<h2>Detailed Marking</h2>
<table>
  <thead><tr><th>#</th><th>Question</th><th>Type</th><th>Student Answer</th><th>Key</th><th>Marks</th><th>Marked By</th><th>Feedback / Scheme</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</body></html>`;
  return { status: 200, html };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { computeForSession, sendResultMessage, reportHTML };
