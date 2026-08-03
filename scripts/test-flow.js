#!/usr/bin/env node
/* Dev-only E2E test: drives the exam flow with a stubbed WhatsApp client.
   Usage: node scripts/test-flow.js   (uses a throwaway DB at data/test-flow.db) */
const path = require('path');
const fs = require('fs');

const dbFile = path.resolve(__dirname, '../data/test-flow.db');
for (const f of fs.readdirSync(path.dirname(dbFile)).filter((n) => n.startsWith('test-flow.db'))) {
  fs.unlinkSync(path.join(path.dirname(dbFile), f));
}
process.env.DB_PATH = dbFile;

const db = require('../src/db');
const examService = require('../src/services/exam');
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
wa.sendTemplate = async () => {
  sent.push({ to: 'template', kind: 'template' });
  return { messages: [{ id: 'stub' }] };
};

function seedExam() {
  const info = db
    .prepare(
      `INSERT INTO exams (title, subject, duration_minutes, pass_percentage, status, generated_by, total_marks)
       VALUES ('Test 10q','Science',10,50,'live','manual',10)`
    )
    .run();
  const examId = Number(info.lastInsertRowid);
  const qs = [
    ['Which organelle is known as the powerhouse of the cell?', ['Nucleus', 'Mitochondria', 'Ribosome', 'Lysosome'], 'B'],
    ['Where does most nutrient absorption occur?', ['Stomach', 'Small intestine', 'Large intestine', 'Esophagus'], 'B'],
    ['Enzyme secreted by salivary glands for carbohydrate digestion?', ['Pepsin', 'Amylase', 'Lipase', 'Trypsin'], 'B'],
    ['Process by which a cell engulfs large particles?', ['Pinocytosis', 'Phagocytosis', 'Exocytosis', 'Osmosis'], 'B'],
    ['Primarily responsible for water reabsorption?', ['Stomach', 'Duodenum', 'Jejunum', 'Large intestine'], 'D'],
    ['Basic unit of life?', ['Atom', 'Molecule', 'Cell', 'Tissue'], 'C'],
    ['NOT a function of the liver in digestion?', ['Produces bile', 'Stores glycogen', 'Detoxifies blood', 'Secretes insulin'], 'D'],
    ['Genetic material is located in the?', ['Cytoplasm', 'Nucleus', 'Mitochondria', 'Ribosome'], 'B'],
    ['Pepsin works best in which pH?', ['Alkaline (pH 8)', 'Neutral (pH 7)', 'Slightly acidic (pH 6)', 'Strongly acidic (pH 2)'], 'D'],
    ['Which structure connects small intestine to large intestine?', ['Pyloric sphincter', 'Ileocecal valve', 'Cardiac sphincter', 'Hepatic duct'], 'B'],
  ];
  qs.forEach(([text, opts, ans], i) => {
    db.prepare(
      `INSERT INTO questions (exam_id, q_order, type, text, options, correct_answer, marks)
       VALUES (?,?,?,?,?,?,1)`
    ).run(examId, i + 1, 'objective', text, JSON.stringify(opts.map((o, j) => ({ key: String.fromCharCode(65 + j), text: o }))), ans);
  });
  db.prepare('UPDATE exams SET total_marks = 10 WHERE id = ?').run(examId);
  return examId;
}

async function main() {
  const examId = seedExam();
  const phone = '233555000001';
  const student = examService.getOrCreateStudent(phone);
  db.prepare('INSERT OR IGNORE INTO exam_recipients (exam_id, student_id) VALUES (?,?)').run(examId, student.id);

  // 1. Admin sends the exam
  sent.length = 0;
  const report = await examService.sendExamToRecipients(examId);
  console.log('send report:', JSON.stringify(report));

  const textMsgs = sent.filter((s) => s.kind === 'text');
  console.log(`\n--- first wave: ${sent.length} msgs (${textMsgs.length} text, ${sent.length - textMsgs.length} list)`);
  console.log('--- INTRO ---\n' + textMsgs[0].text);
  console.log('\n--- Q1 CARD ---\n' + textMsgs[1].text);
  const list = sent.find((s) => s.kind === 'list');
  console.log('\n--- Q1 PICKER rows ---');
  console.log(list.rows.map((r) => `  ${r.id}: ${r.title}`).join('\n'));

  // 2. Greeting must NOT be counted as an answer
  sent.length = 0;
  const greet = await examService.handleInbound(phone, 'hello', {});
  const greetTexts = sent.filter((s) => s.kind === 'text').map((s) => s.text);
  console.log(`\n--- greeting -> ${greet.reason}; sent ${sent.length} msgs (should resend Q1)`);

  // 3. Answer all 10 (mix: tap replyId, typed letter, full option text)
  const plan = [
    { input: { replyId: 'B' }, note: 'tap B' },
    { input: { body: 'b' }, note: 'type b' },
    { input: { replyId: 'B' }, note: 'tap B' },
    { input: { body: 'Phagocytosis' }, note: 'type full option' },
    { input: { replyId: 'D' }, note: 'tap D' },
    { input: { body: 'C' }, note: 'type C' },
    { input: { replyId: 'D' }, note: 'tap D' },
    { input: { body: 'nucleus' }, note: 'type lowercase option' },
    { input: { replyId: 'D' }, note: 'tap D' },
    { input: { body: 'B.' }, note: 'type B.' },
  ];
  const sessionId = db.prepare('SELECT id FROM sessions WHERE exam_id = ? AND student_id = ?').get(examId, student.id).id;

  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    sent.length = 0;
    const body = p.input.body || '';
    const meta = p.input.replyId ? { replyId: p.input.replyId } : {};
    const r = await examService.handleInbound(phone, body, meta);
    const kinds = sent.map((m) => (m.kind === 'text' ? 'text' : `list[${m.rows.map((x) => x.id).join(',')}]`));
    const lastText = sent.filter((s) => s.kind === 'text').map((s) => s.text.replace(/\n/g, ' | ')).join(' /// ');
    const q = db.prepare('SELECT current_q_order FROM sessions WHERE id = ?').get(sessionId).current_q_order;
    console.log(`Q${i + 1} ${p.note.padEnd(20)} -> ${r.reason.padEnd(8)} now on Q${q}  [${kinds.join(', ')}]  ${lastText.slice(0, 90)}`);
  }

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  console.log('\n--- FINAL ---');
  console.log('session:', session.status, '| current_q_order:', session.current_q_order, '| score:', session.final_score, '/ 10 |', session.final_percentage, '%');
  const answers = db
    .prepare('SELECT q_order, answer_text, is_correct FROM answers WHERE session_id = ? ORDER BY q_order')
    .all(sessionId);
  console.log('answers recorded:', answers.length, 'of 10');
  console.log('summary:', answers.map((a) => `${a.q_order}:${a.answer_text}${a.is_correct ? '✓' : '✗'}`).join(' '));

  const score = answers.filter((a) => a.is_correct).length;
  console.log(`PASS ${score}/10 correct`);

  // 4. Post-completion message should not restart
  sent.length = 0;
  const after = await examService.handleInbound(phone, 'hello', {});
  console.log('\n--- message after completion ->', after.reason);
  console.log('sent:', sent.map((s) => (s.kind === 'text' ? s.text.replace(/\n/g, ' | ').slice(0, 80) : 'list')).join(' /// '));

  // 5. Admin re-send after expiry should restart
  db.prepare(`UPDATE sessions SET status='expired', ended_at=datetime('now'), current_q_order=1 WHERE id=?`).run(sessionId);
  sent.length = 0;
  const re = await examService.sendExamToRecipients(examId);
  const restarted = db.prepare('SELECT status, current_q_order, started_at FROM sessions WHERE id = ?').get(sessionId);
  const freshAnswers = db.prepare('SELECT COUNT(*) c FROM answers WHERE session_id = ?').get(sessionId).c;
  console.log(`\n--- re-send after expiry -> sent=${re.sent} failed=${re.failed} | session=${restarted.status} q=${restarted.current_q_order} | old answers wiped=${freshAnswers === 0}`);

  const oldSession = db.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId);
  db.prepare('DELETE FROM sessions WHERE exam_id = ?').run(examId);
  console.log('done');
}

main().catch((e) => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
