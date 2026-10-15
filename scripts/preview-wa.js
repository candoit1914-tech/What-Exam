// Scratch: prints the WhatsApp surfaces a student sees, so the wording can be
// read as a whole. Not part of the test suite — `node scripts/preview-wa.js`.
process.env.DB_PATH = require('path').join(require('os').tmpdir(), 'la-preview.db');
process.env.SEED_ON_BOOT = 'false';
const db = require('../src/db');
const exam = require('../src/services/exam');

const eid = db.prepare(
  "INSERT INTO exams(title,subject,duration_minutes,status,pass_percentage) VALUES ('WASSCE Integrated Science','Science',45,'live',50)"
).run().lastInsertRowid;
db.prepare(
  "INSERT INTO questions(exam_id,q_order,type,text,options,correct_answer) VALUES (?,1,'objective','Which instrument measures electric current?',?,'B')"
).run(eid, JSON.stringify([
  { key: 'A', text: 'Voltmeter' },
  { key: 'B', text: 'Ammeter' },
  { key: 'C', text: 'Ohmmeter' },
  { key: 'D', text: 'Galvanometer' },
]));
const row = db.prepare('SELECT * FROM exams WHERE id=?').get(eid);

console.log('===== INVITE =====');
console.log(exam.formatExamIntro(row, 7));
console.log('\n===== NUDGE (a reply that is not an entry) =====');
console.log(exam.entryReminderMessage());
console.log('\n===== ENTRY =====');
console.log(exam.entryConfirmedMessage(row));
db.close();
