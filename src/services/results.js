const db = require('../db');
const config = require('../config');
const wa = require('./whatsapp');
const auth = require('../auth');
const certificate = require('./certificate');

function computeForSession(sessionId) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(session.exam_id);
  const totalMarks = db.prepare('SELECT COALESCE(SUM(max_marks),0) t FROM answers WHERE session_id = ?').get(sessionId).t;
  const awarded = db.prepare('SELECT COALESCE(SUM(marks_awarded),0) s FROM answers WHERE session_id = ?').get(sessionId).s;
  const answered = db.prepare('SELECT COUNT(*) c FROM answers WHERE session_id = ?').get(sessionId).c;
  const drawn = db.prepare('SELECT COUNT(*) c FROM session_questions WHERE session_id = ?').get(sessionId).c;
  const questionCount =
    drawn > 0 ? drawn : db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(exam.id).c;

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

function persistSessionTotals(sessionId) {
  const r = computeForSession(sessionId);
  db.prepare(
    `UPDATE sessions SET final_score = ?, final_percentage = ?, passed = ? WHERE id = ?`
  ).run(r.score, r.percentage, r.passed ? 1 : 0, sessionId);
  return r;
}

async function sendResultMessage(sessionId, phone, reason) {
  const r = computeForSession(sessionId);
  const passMark = r.exam.pass_percentage;

  let msg =
    `🏁 *Exam complete*\n\n` +
    `📝 ${r.exam.title}${r.exam.subject ? ` — ${r.exam.subject}` : ''}\n` +
    `⏱️ ${reason === 'expired' ? 'Time expired' : reason === 'ended' ? 'Ended by administrator' : 'All questions answered'}\n\n` +
    `🎯 Score: *${r.score} / ${r.totalMarks}*\n` +
    `📊 Percentage: *${r.percentage}%*\n` +
    `Result: ${r.passed ? '✅ *PASS*' : '❌ *FAIL*'} (pass mark ${passMark}%)\n`;

  const key = db
    .prepare(
      `SELECT a.q_order, a.answer_text, a.is_correct,
              COALESCE(p.correct_answer, q.correct_answer) AS correct_answer,
              COALESCE(p.text, q.text) AS text
       FROM answers a
       LEFT JOIN session_questions sq ON sq.session_id = a.session_id AND sq.q_order = a.q_order
       LEFT JOIN question_pool p ON p.id = sq.question_id
       LEFT JOIN questions q ON q.id = a.question_id AND p.id IS NULL
       WHERE a.session_id = ? AND COALESCE(p.type, q.type) = 'objective'
       ORDER BY a.q_order`
    )
    .all(sessionId);
  if (config.exam.sendAnswerKey && key.length) {
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

  const theory = db
    .prepare(
      `SELECT a.q_order, a.marks_awarded, a.max_marks, a.ai_detected
       FROM answers a
       LEFT JOIN session_questions sq ON sq.session_id = a.session_id AND sq.q_order = a.q_order
       LEFT JOIN question_pool p ON p.id = sq.question_id
       LEFT JOIN questions q ON q.id = a.question_id AND p.id IS NULL
       WHERE a.session_id = ? AND COALESCE(p.type, q.type) = 'theory'
       ORDER BY a.q_order`
    )
    .all(sessionId);
  if (theory.length) {
    msg += `\n*Theory marks* (yours / max):\n` +
      theory
        .map((t) => {
          const cheated = Number(t.ai_detected) === 1;
          return `Q${t.q_order}. ${t.marks_awarded}/${t.max_marks}${cheated ? ' ⚠️ AI-copied' : ''}`;
        })
        .join('\n') +
      '\n';
  }

  const cheats = db
    .prepare('SELECT q_order FROM answers WHERE session_id = ? AND ai_detected = 1 ORDER BY q_order')
    .all(sessionId);
  if (cheats.length) {
    const list = cheats.map((c) => c.q_order).join(', ');
    msg +=
      `\n⚠️ *Caution:* Your answer${cheats.length === 1 ? '' : 's'} to Q${list} looked like it was ` +
      `written by an AI (e.g. ChatGPT, Gemini, Claude) and copied in. Copying AI answers is cheating, ` +
      `so it earned *0 marks*.\n`;
  }

  const reviewCount = db
    .prepare('SELECT COUNT(*) c FROM answers WHERE session_id = ? AND needs_review = 1')
    .get(sessionId).c;
  if (reviewCount) msg += `\n⚠️ ${reviewCount} answer(s) pending review by your administrator.\n`;

  msg += `\nFull report: ${config.appUrl}${auth.reportUrl(sessionId)}`;

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
      `SELECT a.*,
              COALESCE(p.type, q.type) AS type,
              COALESCE(p.text, q.text) AS text,
              COALESCE(p.passage, q.passage) AS passage,
              COALESCE(p.options, q.options) AS options,
              COALESCE(p.correct_answer, q.correct_answer) AS correct_answer,
              COALESCE(p.explanation, q.explanation) AS explanation,
              COALESCE(p.image, q.image) AS image,
              COALESCE(p.scheme_json, m.scheme) AS scheme
       FROM answers a
       LEFT JOIN session_questions sq ON sq.session_id = a.session_id AND sq.q_order = a.q_order
       LEFT JOIN question_pool p ON p.id = sq.question_id
       LEFT JOIN questions q ON q.id = a.question_id AND p.id IS NULL
       LEFT JOIN marking_schemes m ON m.question_id = q.id
       WHERE a.session_id = ?
       ORDER BY a.q_order`
    )
    .all(sessionId);
  const drawn = db.prepare('SELECT COUNT(*) c FROM session_questions WHERE session_id = ?').get(sessionId).c;
  const allQuestions =
    drawn > 0 ? drawn : db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(exam.id).c;

  const statusLabel = {
    completed: 'Completed',
    ended: 'Ended by admin',
    expired: 'Time expired',
    in_progress: 'In progress',
    abandoned: 'Abandoned',
  }[session.status] || session.status;

  const rows = answers
    .map((a, i) => {
      const studentLetter = String(a.answer_text || '').trim().toUpperCase().replace(/\.$/, '');
      const isCorrect = String(a.is_correct) === '1' || a.is_correct === 1;

      let body = '';
      if (a.type === 'objective') {
        const opts = JSON.parse(a.options || '[]');
        const optPills = opts
          .map((o) => {
            const key = String(o.key || '');
            let cls = 'opt';
            let tag = '';
            if (key === String(a.correct_answer || '').toUpperCase()) {
              cls += ' opt-correct';
              tag = '<span class="opt-flag">Correct ✓</span>';
            }
            if (key === studentLetter) {
              if (key === String(a.correct_answer || '').toUpperCase()) cls += ' opt-chosen';
              else {
                cls += ' opt-chosen opt-wrong';
                tag = '<span class="opt-flag">Your answer</span>';
              }
            }
            return `<div class="${cls}"><span class="opt-key">${esc(o.key)}</span><span class="opt-text">${esc(o.text)}</span>${tag}</div>`;
          })
          .join('');
        body = `<div class="opts">${optPills}</div>
          <div class="ans-line">
            <span class="${isCorrect ? 'chip chip-pass' : 'chip chip-fail'}">${isCorrect ? 'Correct' : 'Incorrect'}</span>
            <span>Your answer: <b>${esc(studentLetter || '—')}</b></span>
            <span>Correct: <b>${esc(a.correct_answer || '—')}</b></span>
            <span>Marks: <b>${a.marks_awarded} / ${a.max_marks}</b></span>
          </div>`;
        if (a.explanation) body += `<p class="expl">${esc(a.explanation)}</p>`;
      } else {
        const sch = a.scheme ? JSON.parse(a.scheme) : null;
        const keyPts = sch?.key_points || [];
        body = `<div class="theory-block">
          <div class="theory-meta">
            <span class="chip ${a.marks_awarded >= (a.max_marks || 0) / 2 ? 'chip-pass' : 'chip-fail'}">${a.marks_awarded} / ${a.max_marks} marks</span>
            ${a.marked_by === 'manual' ? '<span class="chip chip-manual">Marked by admin</span>' : a.marked_by === 'ai' ? '<span class="chip chip-ai">Marked by AI</span>' : '<span class="chip chip-auto">Auto</span>'}
            ${a.needs_review ? '<span class="chip chip-review">Needs review</span>' : ''}
            ${Number(a.ai_detected) === 1 ? '<span class="chip chip-cheat">AI-copied — 0 marks</span>' : ''}
          </div>
          <details class="model" open>
            <summary>Model answer &amp; key points</summary>
            <p class="model-text">${esc(sch?.model_answer || '(not available)')}</p>
            ${keyPts.length ? `<ul class="keypoints">${keyPts.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}
          </details>
        </div>`;
        if (a.answer_image) {
          body += `<img class="report-img answer-photo" src="/report/${sessionId}/attachment?file=${encodeURIComponent(a.answer_image)}&token=${encodeURIComponent(auth.reportToken(sessionId))}" alt="student photo answer" style="max-width:340px;border:1px solid var(--line);border-radius:10px;margin-top:10px">`;
        }
        if (a.ai_feedback) body += `<p class="feedback">${esc(a.ai_feedback)}</p>`;
      }

      return `<article class="q-card">
        <header class="q-head">
          <span class="q-num">${i + 1}</span>
          <span class="q-type">${a.type === 'objective' ? 'Objective' : 'Theory'}</span>
          <span class="q-type">${a.max_marks} mark${Number(a.max_marks) === 1 ? '' : 's'}</span>
          <span class="q-status ${isCorrect ? 's-pass' : 's-fail'}">${isCorrect ? 'Correct' : a.needs_review ? 'Review' : 'Incorrect'}</span>
        </header>
        <p class="q-text">${a.passage ? `<span class="q-passage">${esc(a.passage)}</span><br><br>` : ''}${esc(a.text)}</p>
        ${a.image ? `<img class="qimg report-img" src="/report/${sessionId}/attachment?file=${encodeURIComponent(a.image)}&token=${encodeURIComponent(auth.reportToken(sessionId))}" alt="diagram">` : ''}
        ${body}
      </article>`;
    })
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(exam.title)} — Result Report</title>
<style>
  :root{--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--bg:#f1f5f9;--green:#16a34a;--green-dark:#15803d;--red:#dc2626;--teal:#0f766e;--card:#ffffff}
  *{box-sizing:border-box}
  html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{margin:0;background:linear-gradient(180deg,#eef7f3 0%,var(--bg) 320px);color:var(--ink);font-family:'Segoe UI',system-ui,-apple-system,'Helvetica Neue',Arial,sans-serif;line-height:1.55}
  .toolbar{position:sticky;top:0;z-index:5;background:rgba(255,255,255,.85);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:10px 16px}
  .toolbar-inner{max-width:860px;margin:0 auto;display:flex;justify-content:space-between;align-items:center;gap:12px}
  .brand{font-weight:800;font-size:.95rem;letter-spacing:.4px;color:var(--green-dark)}
  .btn{font:inherit;font-weight:600;font-size:.9rem;color:#fff;background:linear-gradient(135deg,var(--green) 0%,var(--teal) 100%);border:0;border-radius:10px;padding:9px 18px;cursor:pointer;box-shadow:0 4px 12px rgba(22,163,74,.25);transition:transform .12s ease,box-shadow .12s ease}
  .btn:hover{transform:translateY(-1px);box-shadow:0 6px 16px rgba(22,163,74,.32)}
  .page{max-width:860px;margin:0 auto;padding:28px 16px 72px}
  .hero{background:linear-gradient(135deg,#065f46 0%,var(--teal) 55%,#0e7490 100%);border-radius:22px;padding:30px 30px 26px;color:#fff;box-shadow:0 18px 40px rgba(15,118,110,.28);position:relative;overflow:hidden}
  .hero::after{content:"";position:absolute;right:-60px;top:-60px;width:240px;height:240px;border-radius:50%;background:rgba(255,255,255,.08)}
  .hero::before{content:"";position:absolute;right:60px;bottom:-90px;width:200px;height:200px;border-radius:50%;background:rgba(255,255,255,.05)}
  .hero-eyebrow{font-size:.8rem;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;opacity:.85}
  .hero-title{font-size:1.6rem;font-weight:800;margin:6px 0 2px;line-height:1.2}
  .hero-sub{opacity:.9;font-size:.95rem}
  .hero-meta{display:flex;flex-wrap:wrap;gap:8px 22px;margin-top:16px;font-size:.85rem;opacity:.95}
  .hero-meta b{font-weight:700}
  .badge{display:inline-block;margin-top:16px;padding:7px 18px;border-radius:999px;font-weight:800;font-size:.85rem;letter-spacing:1px;background:#fff;box-shadow:0 4px 12px rgba(0,0,0,.15)}
  .badge.pass{color:var(--green-dark)}.badge.fail{color:var(--red)}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin:-34px 18px 0}
  .stat{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 16px;text-align:center;box-shadow:0 8px 22px rgba(15,23,42,.06)}
  .stat .v{font-size:1.7rem;font-weight:800;color:var(--ink)}
  .stat .v.green{color:var(--green-dark)}
  .stat .v.pass{color:var(--green-dark)}.stat .v.fail{color:var(--red)}
  .stat .l{font-size:.75rem;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted);margin-top:4px}
  h2{font-size:1.1rem;font-weight:800;margin:34px 0 14px;letter-spacing:-.2px}
  .q-card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:14px;box-shadow:0 6px 18px rgba(15,23,42,.05);break-inside:avoid}
  .q-head{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
  .q-num{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,var(--green),var(--teal));color:#fff;font-weight:800;font-size:.9rem;display:flex;align-items:center;justify-content:center;flex:none}
  .q-type{font-size:.72rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted);background:#f1f5f9;border-radius:999px;padding:3px 10px}
  .q-status{margin-left:auto;font-size:.75rem;font-weight:800;letter-spacing:.6px;border-radius:999px;padding:4px 12px}
  .s-pass{background:#dcfce7;color:var(--green-dark)}
  .s-fail{background:#fee2e2;color:var(--red)}
  .q-text{font-size:1rem;font-weight:600;margin:0 0 14px;color:var(--ink)}
  .q-passage{display:block;font-size:.85rem;font-weight:500;color:#475569;background:#f8fafc;border-left:3px solid var(--teal);padding:10px 14px;border-radius:0 10px 10px 0;white-space:pre-wrap}
  .opts{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .opt{display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:12px;padding:9px 12px;font-size:.9rem;background:#fafbfc;position:relative}
  .opt-key{font-weight:800;color:var(--muted);background:#fff;border:1px solid var(--line);border-radius:7px;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;flex:none}
  .opt-text{color:#334155}
  .opt-correct{border-color:#86efac;background:#f0fdf4}
  .opt-correct .opt-key{background:var(--green);border-color:var(--green);color:#fff}
  .opt-chosen.opt-wrong{border-color:#fca5a5;background:#fef2f2}
  .opt-chosen.opt-wrong .opt-key{background:var(--red);border-color:var(--red);color:#fff}
  .opt-flag{margin-left:auto;font-size:.68rem;font-weight:800;color:var(--green-dark);letter-spacing:.4px;white-space:nowrap}
  .opt-chosen.opt-wrong .opt-flag{color:var(--red)}
  .ans-line{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;margin-top:12px;font-size:.88rem;color:#334155}
  .chip{display:inline-flex;align-items:center;gap:4px;font-size:.72rem;font-weight:800;letter-spacing:.5px;border-radius:999px;padding:3px 11px}
  .chip-pass{background:#dcfce7;color:var(--green-dark)}
  .chip-fail{background:#fee2e2;color:var(--red)}
  .chip-ai{background:#dbeafe;color:#1d4ed8}
  .chip-auto{background:#f1f5f9;color:var(--muted)}
  .chip-manual{background:#ede9fe;color:#6d28d9}
  .chip-review{background:#fef3c7;color:#b45309}
  .chip-cheat{background:#fecaca;color:#b91c1c}
  .expl,.feedback{margin:12px 0 0;font-size:.88rem;color:#475569;background:#f8fafc;border-left:3px solid var(--green);border-radius:0 10px 10px 0;padding:10px 14px}
  .theory-block{margin-top:12px}
  .theory-meta{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
  details.model{border:1px solid var(--line);border-radius:12px;background:#fafbfc;overflow:hidden}
  details.model summary{cursor:pointer;padding:11px 14px;font-weight:700;font-size:.85rem;color:var(--green-dark)}
  details.model[open] summary{border-bottom:1px solid var(--line)}
  .model-text{margin:12px 14px 6px;font-size:.88rem;color:#334155}
  .keypoints{margin:0 14px 12px;padding-left:20px;font-size:.86rem;color:#475569}
  .keypoints li{margin:4px 0}
  .footer{text-align:center;color:var(--muted);font-size:.78rem;margin-top:34px}
  @media (max-width:640px){.opts{grid-template-columns:1fr}.hero{padding:24px 20px}.stats{margin:-30px 8px 0;grid-template-columns:repeat(2,1fr)}.stat .v{font-size:1.4rem}}
  @media print{
    body{background:#fff}
    .toolbar{display:none}
    .hero{box-shadow:none}
    .stats{margin:14px 0 0;box-shadow:none}
    .q-card,.stat,.opt{box-shadow:none;border-color:#cbd5e1}
    details.model[open]{display:block}
    details.model{display:block}
    .q-card{break-inside:avoid}
    @page{margin:12mm}
  }
</style></head>
<body>
<div class="toolbar">
  <div class="toolbar-inner">
    <span class="brand">WHAT EXAM · Result Report</span>
    <button class="btn" onclick="window.print()">🖨️ Print / Save as PDF</button>
  </div>
</div>
<div class="page">
  <header class="hero">
    <div class="hero-eyebrow">Examination Result</div>
    <h1 class="hero-title">${esc(exam.title)}</h1>
    <div class="hero-sub">${exam.subject ? esc(exam.subject) : 'General'} &nbsp;·&nbsp; ${r.questionCount} questions &nbsp;·&nbsp; Pass mark ${exam.pass_percentage}%</div>
    <div class="hero-meta">
      <span>Student: <b>${esc(student.name || student.phone)}</b></span>
      <span>Started: <b>${esc(session.started_at)}</b></span>
      <span>Ended: <b>${esc(session.ended_at || '—')}</b></span>
      <span>Status: <b>${esc(statusLabel)}</b></span>
    </div>
    <span class="badge ${r.passed ? 'pass' : 'fail'}">${r.passed ? '✓ PASS' : '✗ FAIL'}</span>
  </header>

  <section class="stats">
    <div class="stat"><div class="v green">${r.percentage}%</div><div class="l">Percentage</div></div>
    <div class="stat"><div class="v">${r.score}<span style="font-size:1rem;color:#94a3b8"> / ${r.totalMarks}</span></div><div class="l">Total Score</div></div>
    <div class="stat"><div class="v">${r.answered}<span style="font-size:1rem;color:#94a3b8"> / ${r.questionCount}</span></div><div class="l">Answered</div></div>
    <div class="stat"><div class="v ${r.passed ? 'pass' : 'fail'}">${r.passed ? 'PASS' : 'FAIL'}</div><div class="l">Result</div></div>
  </section>

  <h2>Question-by-question breakdown</h2>
  ${rows || '<p style="color:#64748b">No answers recorded for this session yet.</p>'}
  <div class="footer">Generated by What Exam · ${esc(new Date().toLocaleString())}</div>
</div>
</body></html>`;
  return { status: 200, html };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Resend result message and certificate to a single student.
 * Used by both individual resend and bulk resend.
 */
async function sendResultAndCertificate(sessionId, phone, reason) {
  await sendResultMessage(sessionId, phone, reason);

  if (config.exam.sendCertificates) {
    try {
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
      const student = db.prepare('SELECT * FROM students WHERE id = ?').get(session.student_id);
      const r = computeForSession(sessionId);
      const png = await certificate.renderCertificatePng({
        studentName: student.name || student.phone,
        examTitle: r.exam.title,
        subject: r.exam.subject,
        date: session.ended_at ? new Date(session.ended_at) : new Date(),
        score: r.score,
        totalMarks: r.totalMarks,
        percentage: r.percentage,
        passed: r.passed,
      });
      await wa.sendImage(phone, png);
    } catch (err) {
      console.error(`[results] certificate resend failed for ${phone}:`, err.message);
    }
  }
}

/**
 * Bulk resend results + certificates to all finished sessions for an exam.
 * Returns a report with sent/failed counts.
 */
async function bulkResendResults(examId) {
  const sessions = db
    .prepare(
      `SELECT s.*, st.phone, st.name FROM sessions s
       JOIN students st ON st.id = s.student_id
       WHERE s.exam_id = ? AND s.status IN ('completed','expired','ended')
       ORDER BY s.ended_at DESC`
    )
    .all(examId);

  const report = { total: sessions.length, sent: 0, failed: 0, errors: [] };

  for (const sess of sessions) {
    try {
      await sendResultAndCertificate(sess.id, sess.phone, sess.status);
      report.sent++;
    } catch (err) {
      report.failed++;
      report.errors.push({ phone: sess.phone, name: sess.name, error: err.message });
    }
  }

  return report;
}

// Statuses that carry a real, final result. Any other status has no score yet.
const FINISHED_STATUSES = "('completed','ended','expired')";
const isFinished = (status) => FINISHED_STATUSES.includes(`'${status}'`);

/**
 * Build the participant roster for one exam: every recipient, sorted into
 * finished (ranked) / in progress / not started / not sent.
 *
 * This is the single data source behind both renderings (screen, print) so
 * the two can never disagree about who is on the roster or what rank they
 * hold.
 *
 * Division of labour, which is not interchangeable: the SQL window function
 * below picks each student's best attempt; the display order and the rank
 * numbers are assigned here in JavaScript. The outer ORDER BY sorts rows for
 * the per-student grouping only — it is NOT the leaderboard.
 */
function buildParticipantRoster(examId) {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
  if (!exam) return null;

  // Every recipient is the backbone, so a student who never started is still
  // listed. LEFT JOINs keep them, with NULL session columns.
  const rows = db
    .prepare(
      `SELECT st.id AS student_id, st.name, st.phone, r.sent_at,
              s.id AS session_id, s.status, s.started_at, s.ended_at,
              s.final_score, s.final_percentage, s.passed, s.attempt_no,
              ROW_NUMBER() OVER (
                PARTITION BY st.id
                ORDER BY COALESCE(s.final_percentage, -1) DESC,
                         COALESCE(s.final_score, -1) DESC,
                         s.ended_at ASC
              ) AS attempt_rank
         FROM exam_recipients r
         JOIN students st ON st.id = r.student_id
         LEFT JOIN sessions s ON s.student_id = st.id AND s.exam_id = r.exam_id
        WHERE r.exam_id = ?
        ORDER BY COALESCE(s.final_percentage, -1) DESC,
                 COALESCE(s.final_score, -1) DESC,
                 s.ended_at ASC`
    )
    .all(examId);

  const byId = new Map();
  for (const row of rows) {
    if (!byId.has(row.student_id)) byId.set(row.student_id, []);
    byId.get(row.student_id).push(row);
  }

  // current_q_order is the NEXT question to serve (default 1), not a count of
  // what the student answered, so the real count comes from the answers table.
  // Only sessions that actually exist are queried; a recipient who never
  // started has no session row and counts as 0.
  const answered = new Map();
  const countAnswers = db.prepare('SELECT COUNT(*) c FROM answers WHERE session_id = ?');
  for (const sid of new Set(rows.map((r) => r.session_id).filter((v) => v != null))) {
    answered.set(sid, countAnswers.get(sid).c);
  }

  // sessions.final_score / final_percentage / passed default to 0, not NULL, so
  // a student still sitting the exam would otherwise be published with a real
  // looking 0% score. Anything unfinished is reported as "no score" instead.
  const shape = (r) => {
    const scored = isFinished(r.status);
    return {
      student_id: r.student_id,
      name: r.name || '',
      phone: r.phone,
      sent_at: r.sent_at || '',
      status: r.status || '',
      started_at: r.started_at || '',
      ended_at: r.ended_at || '',
      final_score: scored ? r.final_score : null,
      final_percentage: scored ? r.final_percentage : null,
      passed: scored ? (r.passed ? 1 : 0) : null,
      attempt_no: r.attempt_no,
      questions_answered: r.session_id == null ? 0 : answered.get(r.session_id) ?? 0,
    };
  };

  const finished = [];
  const inProgress = [];
  const notStarted = [];
  const notSent = [];

  for (const attempts of byId.values()) {
    // The best attempt is attempt_rank 1, whatever its status. ROW_NUMBER()
    // always yields 1 for a non-empty partition, so the fallback is unneeded.
    const best = attempts.find((r) => r.attempt_rank === 1);
    // Each bucket asks whether ANY attempt qualifies, never whether the single
    // best one does. restartSession() retires a superseded attempt as
    // 'abandoned' WITHOUT setting ended_at, so a student part-way through
    // attempt 2 owns two rows that tie on every sort key below; trusting
    // attempt_rank there files a student who is working right now as not
    // started.
    const bestFinished = attempts.find((r) => isFinished(r.status));
    // The attempt actually in progress, which is the one worth reporting.
    // restartSession() retires the previous row before creating the next, so
    // there should only ever be one; if that invariant is ever broken, take the
    // highest attempt_no rather than depending on iteration order.
    const live = attempts
      .filter((r) => r.status === 'in_progress')
      .sort((a, b) => b.attempt_no - a.attempt_no)[0];
    const abandoned = attempts.find((r) => r.status === 'abandoned');

    if (bestFinished) {
      finished.push(shape(bestFinished));
    } else if (live) {
      inProgress.push(shape(live));
    } else if (abandoned) {
      // 'abandoned' has two unrelated causes. (1) Delivery failure: a send
      // gives up after config.exam.sendRetries attempts, and recordAcceptance()
      // stamps sent_at only when a send actually succeeds — so a NULL sent_at
      // here does mean the exam was never delivered, and "not sent" is the
      // honest label. (2) restartSession() retired a superseded attempt, which
      // says nothing at all about delivery. This branch is only reached when
      // no attempt is live, and sent_at is what separates the two causes: a
      // retired row with a sent_at did reach the student and was then
      // abandoned, so it is "not started"; without one, "not sent".
      (abandoned.sent_at ? notStarted : notSent).push(shape(abandoned));
    } else if (best.sent_at) {
      notStarted.push(shape(best));
    } else {
      notSent.push(shape(best));
    }
  }

  // Rank by percentage descending, then score descending, then earlier ended_at.
  // Done here, not in SQL: the array reaches this point in recipient order, and
  // a student with a live retry contributes an ended_at of NULL, which SQLite
  // sorts FIRST in an ASC ordering and which would otherwise promote them over
  // a student who genuinely finished earlier. COALESCE'ing the timestamp to ''
  // in JS keeps a missing value last rather than first.
  finished.sort((a, b) => {
    const pct = (b.final_percentage ?? -1) - (a.final_percentage ?? -1);
    if (pct) return pct;
    const score = (b.final_score ?? -1) - (a.final_score ?? -1);
    if (score) return score;
    const aEnd = String(a.ended_at || '');
    const bEnd = String(b.ended_at || '');
    return aEnd < bEnd ? -1 : aEnd > bEnd ? 1 : 0;
  });
  finished.forEach((r, i) => { r.rank = i + 1; });

  return {
    exam: {
      id: exam.id,
      title: exam.title,
      duration_minutes: exam.duration_minutes,
      pass_percentage: exam.pass_percentage,
      status: exam.status,
    },
    finished,
    inProgress,
    notStarted,
    notSent,
    summary: {
      finished: finished.length,
      inProgress: inProgress.length,
      notStarted: notStarted.length,
      notSent: notSent.length,
      total: byId.size,
    },
  };
}

// The print view is deliberately a standalone document: no app stylesheet,
// no JavaScript, no buttons. The browser's own print dialog turns it into
// paper or a PDF in one click, which is why this feature needs no PDF
// library and no headless renderer on the server.
const PRINT_CSS = `
  @page { size: A4 portrait; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
         color: #1a1a1a; margin: 0; font-size: 12px; line-height: 1.4; }
  h1 { font-size: 19px; margin: 0 0 2px; }
  .sub { color: #555; font-size: 11px; margin-bottom: 4px; }
  .summary { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 16px; }
  .chip { border: 1px solid #ccc; border-radius: 4px; padding: 4px 9px; }
  .chip b { font-size: 14px; }
  h2 { font-size: 13px; margin: 18px 0 6px; text-transform: uppercase;
       letter-spacing: .5px; border-bottom: 2px solid #333; padding-bottom: 3px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #bbb; padding: 5px 7px; text-align: left; }
  th { background: #ececec; font-size: 11px; text-transform: uppercase; }
  /* Rows must not be split by a page break - a student shown with a name on
     one page and a score on the next is useless in a printed register. */
  tr { break-inside: avoid; page-break-inside: avoid; }
  /* Repeat the column headers on every printed page. */
  thead { display: table-header-group; }
  tfoot { display: table-footer-group; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .pass { color: #146c2e; font-weight: 600; }
  .fail { color: #a4262c; font-weight: 600; }
  .none { color: #777; font-style: italic; padding: 7px; }
  .foot { margin-top: 18px; color: #666; font-size: 10px; }
  @media print {
    .none { color: #000; }
    h2 { break-after: avoid; page-break-after: avoid; }
  }
`;

function rosterPrintHTML(roster) {
  const exam = roster.exam;
  const dash = '<span class="none">&mdash;</span>';
  const txt = (v) => (v === null || v === undefined || v === '' ? dash : esc(v));
  const num = (v) => (v === null || v === undefined ? dash : esc(v));

  // `passed` is null for anyone who has not finished, which is a THIRD state
  // rather than a fail. Printing a score or a verdict for a student still
  // sitting the exam would be a false statement on a signed-off register, so
  // those columns are left empty instead of zeroed.
  const outcome = (passed) =>
    passed === null || passed === undefined
      ? dash
      : passed
        ? '<span class="pass">Pass</span>'
        : '<span class="fail">Fail</span>';

  const table = (head, rows, render) => {
    if (!rows.length) return '<p class="none">None</p>';
    return (
      '<table><thead><tr>' +
      head.map((h, i) => `<th${i > 1 ? ' class="num"' : ''}>${esc(h)}</th>`).join('') +
      '</tr></thead><tbody>' +
      rows.map(render).join('') +
      '</tbody></table>'
    );
  };

  const finishedHead = ['#', 'Name', 'Phone', 'Score', 'Percentage', 'Result', 'Attempt', 'Finished'];
  const otherHead = ['Name', 'Phone', 'Questions answered', 'Started'];

  const finishedRows = table(finishedHead, roster.finished, (r) =>
    '<tr>' +
    `<td class="num">${esc(r.rank)}</td><td>${esc(r.name)}</td><td>${esc(r.phone)}</td>` +
    `<td class="num">${num(r.final_score)}</td><td class="num">${num(r.final_percentage)}%</td>` +
    `<td>${outcome(r.passed)}</td><td class="num">${r.attempt_no ? esc(r.attempt_no) : dash}</td>` +
    `<td>${r.ended_at ? esc(r.ended_at) : dash}</td>` +
    '</tr>');

  const otherRows = (rows) => table(otherHead, rows, (r) =>
    '<tr>' +
    `<td>${esc(r.name)}</td><td>${esc(r.phone)}</td>` +
    `<td class="num">${txt(r.questions_answered)}</td>` +
    `<td>${r.started_at ? esc(r.started_at) : dash}</td>` +
    '</tr>');

  const chip = (label, n) => `<span class="chip">${esc(label)} <b>${n}</b></span>`;
  const s = roster.summary;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(exam.title)} - participants</title>
<style>${PRINT_CSS}</style>
</head>
<body>
<h1>${esc(exam.title)}</h1>
<p class="sub">Duration ${esc(exam.duration_minutes)} min &middot; Pass mark ${esc(exam.pass_percentage)}% &middot; Status ${esc(exam.status || 'unknown')}</p>
<div class="summary">
${chip('Total', s.total)}${chip('Finished', s.finished)}${chip('In progress', s.inProgress)}
${chip('Not started', s.notStarted)}${chip('Not sent', s.notSent)}
</div>

<h2>Finished (ranked by percentage)</h2>
${finishedRows}

<h2>In Progress</h2>
${otherRows(roster.inProgress)}

<h2>Not Started</h2>
${otherRows(roster.notStarted)}

<h2>Not Sent</h2>
${otherRows(roster.notSent)}

<p class="foot">Printed ${esc(new Date().toLocaleString())}</p>
</body>
</html>`;
}

module.exports = { computeForSession, persistSessionTotals, sendResultMessage, sendResultAndCertificate, bulkResendResults, reportHTML, buildParticipantRoster, rosterPrintHTML, FINISHED_STATUSES };
