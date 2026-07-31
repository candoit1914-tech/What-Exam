#!/usr/bin/env node
/* CLI to send an exam to phone numbers directly.
   Usage: npm run send -- <examId> <phone1> <phone2> ... */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const db = require('../src/db');
const examService = require('../src/services/exam');
const marking = require('../src/services/marking');

async function main() {
  const [examId, ...phones] = process.argv.slice(2);
  if (!examId || !phones.length) {
    console.log('Usage: npm run send -- <examId> <phone1> <phone2> ...');
    process.exit(1);
  }
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
  if (!exam) {
    console.log(`Exam ${examId} not found.`);
    process.exit(1);
  }

  for (const raw of phones) {
    let phone = String(raw).replace(/[^\d]/g, '');
    if (!phone.startsWith('1') && !phone.startsWith('234')) phone = '234' + phone.replace(/^0/, '');
    const student = examService.getOrCreateStudent(phone);
    db.prepare(`INSERT OR IGNORE INTO exam_recipients (exam_id, student_id) VALUES (?, ?)`).run(examId, student.id);
  }

  console.log(`Sending exam #${examId} "${exam.title}"...`);
  const report = await examService.sendExamToRecipients(examId);
  console.log(`Sent: ${report.sent}, failed: ${report.failed}`);
  for (const e of report.errors) console.log(`  ✗ ${e.phone}: ${e.error}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
