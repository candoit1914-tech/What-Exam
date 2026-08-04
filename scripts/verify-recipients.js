#!/usr/bin/env node
/* E2E verification of multi-recipient delivery + the "re-send reaches an
   in-progress student" fix, using a throwaway DB seeded with the SAME exam
   structure as the production one (3 questions: 2 objective + 1 theory).
   Usage: node scripts/verify-recipients.js */
const path = require('path');
const fs = require('fs');

const dbFile = path.resolve(__dirname, '../data/verify-recipients.db');
for (const f of fs.readdirSync(path.dirname(dbFile)).filter((n) => n.startsWith('verify-recipients.db'))) {
  fs.unlinkSync(path.join(path.dirname(dbFile), f));
}
process.env.DB_PATH = dbFile;

const db = require('../src/db');
const examService = require('../src/services/exam');
const marking = require('../src/services/marking');
const wa = require('../src/services/whatsapp');

const sent = [];
wa.sendText = async (to, text) => {
  sent.push({ to, kind: 'text', text });
  return { messages: [{ id: 'stub' }] };
};
wa.sendInteractiveList = async (to, title, body, buttonText, rows) => {
  sent.push({ to, kind: 'list', rows });
  return { messages: [{ id: 'stub' }] };
};
wa.sendInteractiveButtons = async () => ({ messages: [{ id: 'stub' }] });
wa.sendTemplate = async () => {
  sent.push({ to: 'template', kind: 'template' });
  return { messages: [{ id: 'stub' }] };
};

function seedRealExam() {
  const info = db
    .prepare(
      `INSERT INTO exams (title, subject, duration_minutes, pass_percentage, status, generated_by, total_marks)
       VALUES ('End of Term Integrated Science','Integrated Science',30,50,'live','manual',11)`
    )
    .run();
  const examId = Number(info.lastInsertRowid);
  const qs = [
    {
      type: 'objective', marks: 2,
      text: 'What is the capital of Ghana?',
      options: [{ key: 'A', text: 'Kumasi' }, { key: 'B', text: 'Accra' }, { key: 'C', text: 'Tamale' }, { key: 'D', text: 'Cape Coast' }],
      correct: 'B',
    },
    {
      type: 'objective', marks: 2,
      text: 'Which of these is NOT a renewable energy source?',
      options: [{ key: 'A', text: 'Solar' }, { key: 'B', text: 'Wind' }, { key: 'C', text: 'Coal' }, { key: 'D', text: 'Hydro' }],
      correct: 'C',
    },
    { type: 'theory', marks: 7, text: 'Explain three causes of soil erosion and suggest one way to control it.' },
  ];
  qs.forEach((q, i) => {
    db.prepare(
      `INSERT INTO questions (exam_id, q_order, type, text, options, correct_answer, marks)
       VALUES (?,?,?,?,?,?,?)`
    ).run(examId, i + 1, q.type, q.text,
      q.options ? JSON.stringify(q.options) : null,
      q.correct || null, q.marks);
  });
  return examId;
}

function msgsTo(phone) {
  return sent.filter((m) => m.to === phone && m.kind === 'text').map((m) => m.text);
}

let failures = 0;
function check(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
}

async function main() {
  const examId = seedRealExam();
  const phones = ['233555000001', '233269200946']; // two different numbers
  for (const p of phones) {
    const s = examService.getOrCreateStudent(p);
    db.prepare('INSERT OR IGNORE INTO exam_recipients (exam_id, student_id) VALUES (?,?)').run(examId, s.id);
  }

  // ── Scenario A: one send delivers the exam to BOTH numbers ────────────
  sent.length = 0;
  const report = await examService.sendExamToRecipients(examId);
  check(report.sent === 2, `send report sent=2 (got ${report.sent})`);
  for (const p of phones) {
    const msgs = msgsTo(p);
    check(msgs.length >= 3, `${p} received intro + Q1 + options (${msgs.length} msgs)`);
    check(msgs[0].includes('*END OF TERM INTEGRATED SCIENCE*'), `${p} intro has bold uppercase title`);
    check(msgs[1].startsWith('Question 1\n'), `${p} got Question 1`);
    check(msgs[2].includes('A. Kumasi'), `${p} got Q1 options`);
  }

  // ── Scenario B: full flow completes (not stuck) — success AI marking ──
  marking.markTheoryAnswer = async () => ({
    marksAwarded: 6, maxMarks: 7, breakdown: [], feedback: 'Good answer.',
  });
  const s1 = examService.getOrCreateStudent(phones[0]);
  sent.length = 0;
  const r1 = await examService.handleInbound(phones[0], 'B', {});
  const r2 = await examService.handleInbound(phones[0], 'C', {});
  const r3 = await examService.handleInbound(phones[0], 'rain, wind, farming on slopes; plant trees.', {});
  const sess1 = db.prepare('SELECT * FROM sessions WHERE exam_id = ? AND student_id = ?').get(examId, s1.id);
  const ans1 = db.prepare('SELECT COUNT(*) c FROM answers WHERE session_id = ?').get(sess1.id).c;
  const finalMsgs = sent.filter((m) => m.kind === 'text').map((m) => m.text).join(' ');
  check(sess1.status === 'completed', `student1 completed (${sess1.status}) — not stuck`);
  check(ans1 === 3, `student1 has all 3 answers recorded (${ans1})`);
  check(finalMsgs.includes('%'), `student1 got a result message`);

  // ── Scenario C: AI failure/timing-out on theory must NOT freeze ────────
  marking.markTheoryAnswer = async () => {
    throw new Error('AI request timed out after 60s.');
  };
  const s2 = examService.getOrCreateStudent(phones[1]);
  sent.length = 0;
  await examService.handleInbound(phones[1], 'B', {});
  await examService.handleInbound(phones[1], 'C', {});
  await examService.handleInbound(phones[1], 'some theory answer', {});
  const sess2 = db.prepare('SELECT * FROM sessions WHERE exam_id = ? AND student_id = ?').get(examId, s2.id);
  const th = db.prepare('SELECT * FROM answers WHERE session_id = ? AND q_order = 3').get(sess2.id);
  check(sess2.status === 'completed', `student2 completed despite AI failure (${sess2.status})`);
  check(th && th.needs_review === 1, `theory answer flagged needs_review=1, not frozen`);

  // ── Scenario D: re-send reaches an in-progress student (the fix) ───────
  const s3 = examService.getOrCreateStudent('233400000002');
  db.prepare('INSERT OR IGNORE INTO exam_recipients (exam_id, student_id) VALUES (?,?)').run(examId, s3.id);
  sent.length = 0;
  await examService.sendExamToRecipients(examId); // first send → in_progress
  sent.length = 0;
  await examService.handleInbound('233400000002', 'B', {}); // answer Q1, session at Q2
  sent.length = 0;
  const re = await examService.sendExamToRecipients(examId); // re-send while in_progress
  const s3msgs = msgsTo('233400000002');
  const sess3 = db.prepare('SELECT * FROM sessions WHERE exam_id = ? AND student_id = ?').get(examId, s3.id);
  check(re.resumed === 1, `re-send reports resumed=1 (got ${re.resumed}, skipped=${re.skipped})`);
  check(s3msgs.length >= 2 && s3msgs.some((m) => m.startsWith('Question 2\n')), `in-progress student received Q2 again (${s3msgs.length} msgs)`);
  check(sess3.status === 'in_progress' && sess3.current_q_order === 2, `session still in_progress at Q2, not restarted`);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('VERIFY FAILED:', e);
  process.exit(1);
});
