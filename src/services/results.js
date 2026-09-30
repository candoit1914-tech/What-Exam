const db = require('../db');
const config = require('../config');
const wa = require('./whatsapp');
const auth = require('../auth');
const certificate = require('./certificate');
const { buildZip } = require('./zip');

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

// esc() handles HTML text nodes. OOXML is a different grammar: an unescaped
// quote or apostrophe inside an attribute, or a bare ampersand anywhere, makes
// Word refuse to open the file, so the document renderer needs its own
// escaper. That makes this a correctness property, not a cosmetic one.
function escXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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

  // Deterministic tie-break for every group sort below. `numeric` so 'Exam 2'
  // sorts before 'Exam 10', and `sensitivity: 'base'` so 'ann' and 'Ann' do not
  // produce two differently-ordered runs of the same register. student_id is
  // the final fallback so two students sharing a name still have one order.
  const byName = (a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), 'en', { numeric: true, sensitivity: 'base' })
    || String(a.student_id ?? '').localeCompare(String(b.student_id ?? ''));

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

  // The in-progress group cannot be ranked by percentage: shape() nulls the
  // score for anyone who has not finished, precisely so a printed register
  // never shows a score for a student still sitting the exam. Questions
  // answered is the honest progress measure, and it is compared as a number so
  // '9' never sorts below '10'.
  inProgress.sort((a, b) => (b.questions_answered ?? 0) - (a.questions_answered ?? 0)
    || byName(a, b));

  // The two unscored groups have no measure to rank by at all. Sorting by name
  // is not a ranking, it is determinism: the buckets above are filled in SQL
  // recipient order, and a printed register that reshuffles between two prints
  // of the same exam is a register nobody can check against.
  notStarted.sort(byName);
  notSent.sort(byName);

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
  /* The page margin is ZERO so the page area IS the sheet, which is the only way
     a \`position: fixed\` frame can reach the edge: fixed boxes resolve against
     the page area, so a margin here would silently inset the rule further in.
     The printable inset therefore lives on \`body\` as padding, which keeps every
     value inside the rule instead of letting a wide table run out past it. */
  @page { size: A4 portrait; margin: 0; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
         color: #1a1a1a; margin: 0; padding: 14mm 12mm; font-size: 12px; line-height: 1.4; }
  h1 { font-size: 19px; margin: 0 0 2px; }
  .sub { color: #555; font-size: 11px; margin-bottom: 4px; }
  .summary { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 16px; }
  .chip { border: 1px solid #ccc; border-radius: 4px; padding: 4px 9px; }
  .chip b { font-size: 14px; }
  /* The group headings are gone by request, so consecutive tables need their
     own separation or they read as one long register with no group break. */
  .block + .block { margin-top: 16px; }
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
  /* Chrome ignores \`@page { border }\` entirely, so the page frame is a fixed
     element instead: it repeats on every page in Chrome, Edge and Firefox.

     \`inset: 0\` is the sheet edge, which only works because \`@page\` above sets
     margin 0 - a fixed box is measured from the page area, so the old 8mm inset
     actually drew the rule 8mm INSIDE the text block and a wide table spilled
     out past it. Square corners, because a radius here would round the paper.

     The trade: a physical printer still cannot reach its own non-printable edge,
     so on paper this rule may be trimmed. As a PDF - what this page is for - it
     prints edge to edge. */
  .frame { position: fixed; inset: 0; border: 1.5pt solid #25D366;
           pointer-events: none; z-index: 0; }
  /* Centred on the page, behind everything. \`width\` rather than \`height\` so a
     wide mark scales to the paper instead of overflowing it. The opacity and
     blur are what make it read as a watermark rather than as a second copy of
     the content: the .docx washout is baked into the PNG by
     src/services/watermark.js, but the print page has no such pass, so the
     fade happens here. */
  .wm { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
        width: 66%; opacity: 0.13; filter: blur(1.5px);
        pointer-events: none; z-index: 0; }
  body > *:not(.frame):not(.wm) { position: relative; z-index: 1; }
  /* Without this the green frame and the shaded table headers are dropped by
     the print dialog - the same trick reportHTML already uses. */
  body, .frame, th { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  /* This URL is a print artefact rather than a preview, so the frame and the
     watermark stay off the screen and appear only in the printed output. */
  .frame, .wm { display: none; }
  @media print {
    .frame, .wm { display: block; }
    .none { color: #000; }
  }
`;

// One definition of the five exportable sections. The keys are the URL
// vocabulary; the labels are what the dropdown, the document stamp and the
// filename use. The stored group names are camelCase, so `in_progress` and
// `inProgress` are deliberately different strings.
const ROSTER_SECTIONS = {
  total:       { label: 'Total',       groups: ['finished', 'inProgress', 'notStarted', 'notSent'] },
  finished:    { label: 'Finished',    groups: ['finished'] },
  in_progress: { label: 'In progress', groups: ['inProgress'] },
  not_started: { label: 'Not started', groups: ['notStarted'] },
  not_sent:    { label: 'Not sent',    groups: ['notSent'] },
};

// Unknown, missing or malformed input resolves to 'total' rather than
// throwing: these URLs are also built by bookmark and by a bare button
// click, and a section typo must not turn a register into a 404.
// The hasOwnProperty guard is deliberate - a plain truthy lookup on
// ROSTER_SECTIONS[key] would resolve 'constructor' and 'toString' to
// something truthy and then fail confusingly further down. The typeof guard
// is the other half of the same idea: a query string like ?section[]=finished
// arrives as ['finished'], and String() of that is a valid key, so without
// it an array would smuggle a section past the vocabulary entirely.
function normalizeSection(value) {
  if (typeof value !== 'string') return 'total';
  const key = value.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ROSTER_SECTIONS, key) ? key : 'total';
}

function sectionGroups(section) {
  return ROSTER_SECTIONS[normalizeSection(section)].groups;
}

// 'Not sent' for the document stamp, '' for total so an unfiltered export
// keeps exactly today's appearance and filename.
function sectionStamp(section) {
  const key = normalizeSection(section);
  return key === 'total' ? '' : ROSTER_SECTIONS[key].label;
}

// 'Not-sent' for a filename: no spaces, no case-destroying surprises.
function sectionSlug(section) {
  const key = normalizeSection(section);
  return key === 'total' ? 'Total' : ROSTER_SECTIONS[key].label.replace(/\s+/g, '-');
}

// Declared once, consumed by the print page and the Word document. The three
// simple groups genuinely share one shape; declaring it three times is how
// they came to disagree.
const ROSTER_FINISHED_COLS = ['Position', 'Name', 'Phone', 'Score', 'Percentage', 'Result', 'Attempt', 'Finished At'];
const ROSTER_SIMPLE_COLS = ['Name', 'Phone', 'Questions answered', 'Started'];

function rosterColumns(group) {
  return group === 'finished' ? ROSTER_FINISHED_COLS : ROSTER_SIMPLE_COLS;
}

// section key -> the blocks to render, in roster order, each with its own
// title, column names and rows. `ranked` says whether the group carries a
// rank column, which the finished block uses and no other group does.
const ROSTER_BLOCK_META = {
  finished:   { title: 'Finished (ranked by percentage)', ranked: true,  field: 'finished' },
  inProgress: { title: 'In Progress',                     ranked: false, field: 'inProgress' },
  notStarted: { title: 'Not Started',                     ranked: false, field: 'notStarted' },
  notSent:    { title: 'Not Sent',                        ranked: false, field: 'notSent' },
};

function rosterBlocks(roster, section) {
  return sectionGroups(section).map((key) => {
    const meta = ROSTER_BLOCK_META[key];
    return { key, title: meta.title, ranked: meta.ranked, columns: rosterColumns(key), rows: roster[meta.field] };
  });
}

/**
 * The printable register, scoped to one section.
 *
 * @param {object} roster buildParticipantRoster()'s result
 * @param {string} [section] a ROSTER_SECTIONS key; anything unknown falls back
 *   to 'total', so a hand-typed URL prints the whole roster rather than 404ing
 * @param {string} [watermarkDataUri] the mark already inlined as a data: URI,
 *   which is what keeps the page self-contained and offline-printable
 * @returns {string} a standalone HTML document
 */
function rosterPrintHTML(roster, section, watermarkDataUri) {
  const exam = roster.exam;
  const stamp = sectionStamp(section);
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

  const table = (head, rows, render, widths) => {
    if (!rows.length) return '<p class="none">None</p>';
    return (
      '<table>' +
      (widths ? `<colgroup>${widths.map((w) => `<col style="width:${w}%">`).join('')}</colgroup>` : '') +
      '<thead><tr>' +
      head.map((h, i) => `<th${i > 1 ? ' class="num"' : ''}>${esc(h)}</th>`).join('') +
      '</tr></thead><tbody>' +
      rows.map(render).join('') +
      '</tbody></table>'
    );
  };

  const finishedHead = ['#', 'Name', 'Phone', 'Score', 'Percentage', 'Result', 'Attempt', 'Finished'];
  // The simple groups' four names are identical in both renderers, so they are
  // shared. The finished header stays compact ('#', 'Finished') to fit A4 and
  // is deliberately NOT the Word document's longer header.
  const otherHead = ROSTER_SIMPLE_COLS;

  // Column widths are declared, not left to the auto table algorithm. With only
  // `width: 100%` the browser hands space to the widest cell, and the long
  // "Questions answered" header outgrew every name on the page, so the register
  // read as a questions column with names squeezed beside it. Name now gets the
  // most room and the answer count the least; each set sums to 100%.
  const PRINT_FINISHED_WIDTHS = [5, 24, 19, 9, 11, 10, 9, 13];
  const PRINT_SIMPLE_WIDTHS = [36, 22, 12, 30];

  const finishedRowsOf = (rows) => table(finishedHead, rows, (r) =>
    '<tr>' +
    `<td class="num">${esc(r.rank)}</td><td>${esc(r.name)}</td><td>${esc(r.phone)}</td>` +
    `<td class="num">${num(r.final_score)}</td><td class="num">${num(r.final_percentage)}%</td>` +
    `<td>${outcome(r.passed)}</td><td class="num">${r.attempt_no ? esc(r.attempt_no) : dash}</td>` +
    `<td>${r.ended_at ? esc(r.ended_at) : dash}</td>` +
    '</tr>', PRINT_FINISHED_WIDTHS);

  const otherRowsOf = (rows) => table(otherHead, rows, (r) =>
    '<tr>' +
    `<td>${esc(r.name)}</td><td>${esc(r.phone)}</td>` +
    `<td class="num">${txt(r.questions_answered)}</td>` +
    `<td>${r.started_at ? esc(r.started_at) : dash}</td>` +
    '</tr>', PRINT_SIMPLE_WIDTHS);

  const chip = (label, n) => `<span class="chip">${esc(label)} <b>${n}</b></span>`;
  const s = roster.summary;

  // The blocks come from the shared section vocabulary rather than from four
  // hard-coded tables, so a print of one section cannot leak another's rows.
  // The group's title is deliberately NOT rendered: the group labels read as
  // section headers the register does not have, and the sub-line already stamps
  // which section is on the page.
  const sections = rosterBlocks(roster, section)
    .map(({ ranked, rows }) =>
      `<div class="block">\n${ranked ? finishedRowsOf(rows) : otherRowsOf(rows)}</div>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(exam.title)} - participants</title>
<style>${PRINT_CSS}</style>
</head>
<body>
${watermarkDataUri ? `<img class="wm" src="${esc(watermarkDataUri)}" alt="">` : ''}<div class="frame"></div>
<h1>${esc(exam.title)}</h1>
<p class="sub">Duration ${esc(exam.duration_minutes)} min &middot; Pass mark ${esc(exam.pass_percentage)}% &middot; Status ${esc(exam.status || 'unknown')}${stamp ? ` &middot; <b>Section: ${esc(stamp)}</b>` : ''}</p>
<div class="summary">
${chip('Total', s.total)}${chip('Finished', s.finished)}${chip('In progress', s.inProgress)}
${chip('Not started', s.notStarted)}${chip('Not sent', s.notSent)}
</div>

${sections}

<p class="foot">Printed ${esc(new Date().toLocaleString())}</p>
</body>
</html>`;
}

// The Word document carries its own header labels and column widths: the print
// page's compact '#' / 'Finished' pair exists to fit A4 in a browser, whereas
// the document has room for the longer shared names. Declared here rather than
// mutated onto the shared arrays, so the print page cannot be changed by
// accident from the document side.
const DOCX_FINISHED_HEAD = ['#', 'Name', 'Phone', 'Score', 'Percentage', 'Result', 'Attempt', 'Finished'];
// Byte-identical to the shared simple-group names, so they are shared rather
// than restated: a third copy is how the renderers came to disagree.
const DOCX_SIMPLE_HEAD = ROSTER_SIMPLE_COLS;
// Twips, each set summing to the 9680twip A4 text column (11906 - 2x794 - border
// allowance), so Word scales the table to the printable width instead of
// guessing from the header row alone.
const DOCX_FINISHED_WIDTHS = [520, 2100, 1900, 900, 1100, 1000, 800, 1360];
const DOCX_SIMPLE_WIDTHS = [3000, 2100, 2100, 2480];
const DOCX_CHIP_HEAD = ['Total', 'Finished', 'In progress', 'Not started', 'Not sent'];
const DOCX_CHIP_WIDTHS = [1936, 1936, 1936, 1936, 1936];
const DOCX_FULL_WIDTH = 9680;
const DOCX_GREEN = '25D366';

// A .docx is a ZIP of XML parts. Hand-rolled rather than pulled from npm: Node
// 24 ships deflateRawSync and crc32, so the container is ~40 lines, and a
// washed-out picture watermark needs hand-written VML regardless of which
// library assembles the file.
//
// Synchronous on purpose. The watermark Buffer is produced and cached by
// src/services/watermark.js; awaiting inside this function would only add a
// promise the caller does not need.
function rosterDocx(roster, section, watermarkPngBuffer) {
  const stamp = sectionStamp(section);
  const dash = '—';               // em dash: "no value", matching the report
  // The print page needs two shapes (missing entirely vs. zero) to keep
  // `&mdash;` out of a numeric column. A Word cell has no such distinction to
  // make, so one helper covers both.
  const val = (v) => (v === null || v === undefined || v === '' ? dash : String(v));
  const pct = (v) => (v === null || v === undefined ? dash : `${v}%`);

  // `passed` is null for anyone who has not finished, which is a THIRD state
  // rather than a fail. Printing a verdict for a student still sitting the exam
  // would be a false statement on a signed-off register, so the cell is left
  // empty instead of showing Fail.
  const outcome = (p) => (p === null || p === undefined ? dash : p ? 'Pass' : 'Fail');

  // Every emitter below escapes exactly once, at the point the text enters the
  // part. Escaping in the cell formatters as well would double-encode, turning
  // '&amp;' into '&amp;amp;' and corrupting every roster name on the page.
  const W = (s) => `<w:p>${s}</w:p>`;
  const run = (s, extra = '') =>
    `<w:r>${extra}<w:t xml:space="preserve">${escXml(s)}</w:t></w:r>`;
  const para = (s, extra = '') => W(run(s, extra));
  const cell = (v, width, header) =>
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>` +
    (header ? `<w:shd w:val="clear" w:fill="${DOCX_GREEN}"/>` : '') +
    '</w:tcPr>' +
    W(run(v, header ? '<w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr>' : '')) +
    '</w:tc>';

  const tblPr =
    '<w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
      .join('') +
    '</w:tblBorders></w:tblPr>';
  // tblGrid is schema-required before the first row, and it is also what tells
  // Word how wide each column is on the first page rather than after it has
  // reflowed the header.
  const grid = (widths) =>
    '<w:tblGrid>' + widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('') + '</w:tblGrid>';

  const table = (head, rows, widths) =>
    '<w:tbl>' + tblPr + grid(widths) +
    '<w:tr><w:trPr><w:tblHeader/></w:trPr>' +
    head.map((h, i) => cell(h, widths[i], true)).join('') +
    '</w:tr>' +
    rows.map((r) => '<w:tr><w:trPr><w:cantSplit/></w:trPr>' +
      r.map((v, i) => cell(v, widths[i], false)).join('') + '</w:tr>').join('') +
    '</w:tbl>';

  // A group with no members still gets a table: an empty w:tbl is invalid, and
  // a bare paragraph would not line up with the blocks around it.
  const emptyTable = (width) =>
    '<w:tbl>' + tblPr + grid([width]) +
    '<w:tr><w:trPr><w:cantSplit/></w:trPr>' + cell('None', width, false) + '</w:tr>' +
    '</w:tbl>';

  const finishedCells = (r) => [val(r.rank), val(r.name), val(r.phone), val(r.final_score),
    pct(r.final_percentage), outcome(r.passed), val(r.attempt_no), val(r.ended_at)];
  const simpleCells = (r) => [val(r.name), val(r.phone), val(r.questions_answered), val(r.started_at)];

  // rosterBlocks from Task 2 decides which groups appear and in what order.
  // The group title is deliberately not emitted here either, matching the print
  // page: the labels read as section headers the document does not have, and
  // the 'Section: <stamp>' line already says which one is on the page. An
  // empty spacer keeps consecutive tables from reading as one long table.
  const block = ({ ranked, rows }) => {
    const head = ranked ? DOCX_FINISHED_HEAD : DOCX_SIMPLE_HEAD;
    const widths = ranked ? DOCX_FINISHED_WIDTHS : DOCX_SIMPLE_WIDTHS;
    const cells = ranked ? finishedCells : simpleCells;
    return para('') +
      (rows.length
        ? table(head, rows.map(cells), widths)
        : emptyTable(DOCX_FULL_WIDTH));
  };

  const s = roster.summary;
  const chipRow = table(
    DOCX_CHIP_HEAD,
    [[String(s.total), String(s.finished), String(s.inProgress), String(s.notStarted), String(s.notSent)]],
    DOCX_CHIP_WIDTHS);

  const exam = roster.exam;
  // Only w and r are declared: this part references no VML, and an unused
  // namespace declaration is noise a reviewer has to rule out as a bug.
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<w:body>' +
    para(exam.title, '<w:rPr><w:b/><w:sz w:val="38"/></w:rPr>') +
    para(`Duration ${exam.duration_minutes} min · Pass mark ${exam.pass_percentage}% · Status ${exam.status || 'unknown'}`,
         '<w:rPr><w:color w:val="555555"/><w:sz w:val="22"/></w:rPr>') +
    (stamp ? para(`Section: ${stamp}`,
      '<w:rPr><w:b/><w:color w:val="25D366"/><w:sz w:val="22"/></w:rPr>') : '') +
    chipRow + para('') +
    rosterBlocks(roster, section).map(block).join('') +
    para(`Printed ${new Date().toLocaleString()}`,
         '<w:rPr><w:color w:val="666666"/><w:sz w:val="20"/></w:rPr>') +
    // A4 portrait 11906x16838 twips, margins matched to the print page.
    '<w:sectPr>' +
    '<w:headerReference w:type="default" r:id="rId4"/>' +
    '<w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="907" w:right="794" w:bottom="907" w:left="794" w:header="0" w:footer="0" w:gutter="0"/>' +
    '<w:pgBorders w:offsetFrom="page">' +
    ['top', 'left', 'bottom', 'right']
      .map((side) => `<w:${side} w:val="single" w:sz="18" w:space="24" w:color="${DOCX_GREEN}"/>`)
      .join('') +
    '</w:pgBorders>' +
    '</w:sectPr>' +
    '</w:body></w:document>';

  // The exact VML shape Word itself writes for a picture watermark. The
  // negative z-index is what puts it behind the body text, and
  // mso-position-*-relative:margin is what centres it on the text column
  // rather than the paper. gain/blacklevel are Word's native washout; the blur
  // is baked into the PNG by src/services/watermark.js because the watermark
  // feature exposes no blur control. w and r are needed for the run and the
  // relationship, v and o for VML itself.
  const headerXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
    ' xmlns:v="urn:schemas-microsoft-com:vml"' +
    ' xmlns:o="urn:schemas-microsoft-com:office:office">' +
    '<w:p><w:r><w:pict>' +
    '<v:shapetype id="_x0000_t75" coordsize="21600,21600" o:spt="75" o:preferrelative="t"' +
    ' path="m@4@5l@4@11@9@11@9@5xe" filled="f" stroked="f">' +
    '<v:stroke joinstyle="miter"/>' +
    '<v:formulas>' +
    '<v:f eqn="if lineDrawn pixelLineWidth 0"/><v:f eqn="sum @0 1 0"/>' +
    '<v:f eqn="sum 0 0 @1"/><v:f eqn="prod @2 1 2"/><v:f eqn="prod @3 21600 pixelWidth"/>' +
    '<v:f eqn="prod @3 21600 pixelHeight"/><v:f eqn="sum @0 0 1"/><v:f eqn="prod @6 1 2"/>' +
    '<v:f eqn="prod @7 21600 pixelWidth"/><v:f eqn="sum @8 21600 0"/>' +
    '<v:f eqn="prod @7 21600 pixelHeight"/><v:f eqn="sum @10 21600 0"/>' +
    '</v:formulas>' +
    '<v:path o:extrusionok="f" gradientshapeok="t" o:connecttype="rect"/>' +
    '<o:lock v:ext="edit" aspectratio="t"/>' +
    '</v:shapetype>' +
    '<v:shape type="#_x0000_t75"' +
    // The VML style attribute sizes itself in points, so no EMU conversion is
    // needed anywhere in this part.
    ' style="position:absolute;margin-left:0;margin-top:0;width:360pt;height:360pt;' +
    'z-index:-251657216;' +
    'mso-position-horizontal:center;mso-position-horizontal-relative:margin;' +
    'mso-position-vertical:center;mso-position-vertical-relative:margin"' +
    ' o:allowincell="f">' +
    '<v:imagedata r:id="rId1" o:title="watermark" gain="19661f" blacklevel="22938f"/>' +
    '</v:shape>' +
    '</w:pict></w:r></w:p>' +
    '</w:hdr>';

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '</Relationships>';

  // rId2 is declared but not referenced from the body, which is normal: the
  // numbers need not be contiguous, only resolvable. Its target is relative to
  // word/, so reaching docProps needs the leading '..' - a bare
  // "docProps/core.xml" would resolve to word/docProps/core.xml and leave a
  // dangling relationship in the package.
  const documentRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="../docProps/core.xml"/>' +
    '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' +
    '</Relationships>';

  const headerRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/watermark.png"/>' +
    '</Relationships>';

  const stylesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>' +
    '<w:sz w:val="20"/><w:szCs w:val="20"/>' +
    '</w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
    '<w:name w:val="Normal"/><w:qFormat/>' +
    '</w:style>' +
    '</w:styles>';

  const stampUtc = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const coreXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"' +
    ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escXml(exam.title)} - participants</dc:title>` +
    '<dc:creator>Exam Admin</dc:creator><cp:lastModifiedBy>Exam Admin</cp:lastModifiedBy>' +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${stampUtc}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${stampUtc}</dcterms:modified>` +
    '</cp:coreProperties>';

  const xml = (s) => Buffer.from(s, 'utf8');
  return buildZip([
    { name: '[Content_Types].xml', data: xml(contentTypes) },
    { name: '_rels/.rels', data: xml(rootRels) },
    { name: 'docProps/core.xml', data: xml(coreXml) },
    { name: 'word/document.xml', data: xml(documentXml) },
    { name: 'word/_rels/document.xml.rels', data: xml(documentRels) },
    { name: 'word/styles.xml', data: xml(stylesXml) },
    { name: 'word/header1.xml', data: xml(headerXml) },
    { name: 'word/_rels/header1.xml.rels', data: xml(headerRels) },
    { name: 'word/media/watermark.png', data: watermarkPngBuffer },
  ]);
}

module.exports = { computeForSession, persistSessionTotals, sendResultMessage, sendResultAndCertificate, bulkResendResults, reportHTML, buildParticipantRoster, rosterPrintHTML, rosterDocx, FINISHED_STATUSES, ROSTER_SECTIONS, normalizeSection, sectionGroups, sectionStamp, sectionSlug, ROSTER_FINISHED_COLS, ROSTER_SIMPLE_COLS, rosterColumns, rosterBlocks };
