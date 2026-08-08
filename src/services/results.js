const db = require('../db');
const config = require('../config');
const wa = require('./whatsapp');
const auth = require('../auth');

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

module.exports = { computeForSession, persistSessionTotals, sendResultMessage, reportHTML };
