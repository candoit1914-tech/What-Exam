'use strict';

// Why did WhatsApp show no picture? This answers the two halves separately:
//
//   1. IMPORT — did any question in this database actually carry a figure?
//      (questions.image, plus the question_images rows delivery walks)
//   2. DELIVERY — does each of those files still exist on disk? A figure that
//      was extracted and then lost (a redeploy wiped an ephemeral uploads
//      directory, a file was replaced/removed by the dashboard) sends as text
//      only: sendImage() throws ENOENT, the bubble is logged and skipped, and
//      the student sees a question with no diagram.
//
// Usage:
//   node scripts/figure-report.js           # every exam
//   node scripts/figure-report.js 4         # one exam
//
// Run it with the same .env / DB_PATH and UPLOADS_DIR the server uses.

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const db = require('../src/db');

const onlyExam = Number(process.argv[2]) || 0;

const questions = db
  .prepare(
    `SELECT q.id, q.exam_id, q.q_order, q.image, e.title
       FROM questions q JOIN exams e ON e.id = q.exam_id
      ${onlyExam ? 'WHERE q.exam_id = ?' : ''}
      ORDER BY q.exam_id, q.q_order`
  )
  .all(...(onlyExam ? [onlyExam] : []));

if (!questions.length) {
  console.log(onlyExam ? `Exam ${onlyExam} has no questions.` : 'This database has no questions at all.');
  console.log('Nothing can be shown in WhatsApp until a PDF imports questions first.');
  process.exit(0);
}

const rowsFor = db.prepare('SELECT image FROM question_images WHERE question_id = ? ORDER BY position');

const byExam = new Map();
for (const q of questions) {
  const bubbles = rowsFor.all(q.id).map((r) => r.image);
  if (!bubbles.length && q.image) bubbles.push(q.image);
  const missing = bubbles.filter((f) => !fs.existsSync(path.join(config.uploadsDir, f)));
  const row = byExam.get(q.exam_id) || {
    title: q.title, total: 0, withFigure: 0, bubbles: 0, missing: 0, firstMissing: '',
  };
  row.total++;
  if (bubbles.length) row.withFigure++;
  row.bubbles += bubbles.length;
  row.missing += missing.length;
  if (missing.length && !row.firstMissing) row.firstMissing = missing[0];
  byExam.set(q.exam_id, row);
}

console.log('uploads dir:', config.uploadsDir);
console.log('database:   ', config.dbPath);
console.log('');
console.log('exam  | questions | with figure | figure files | missing files');
console.log('------+-----------+-------------+--------------+---------------');
for (const [id, r] of byExam) {
  console.log(
    `${String(id).padEnd(5)} | ${String(r.total).padEnd(9)} | ${String(r.withFigure).padEnd(11)} | ${String(r.bubbles).padEnd(12)} | ${
      r.missing ? `${r.missing} (${r.firstMissing})` : '0'
    }`
  );
  console.log(`      ${r.title}`);
}

console.log('');
// ── delivery ──────────────────────────────────────────────────────────
// Every figure send is recorded in message_outbox, so this is the half of the
// story the import cannot tell: a picture that was extracted, written to disk
// and then refused by the gateway.
const deliveries = db
  .prepare(
    `SELECT state, COUNT(*) c FROM message_outbox WHERE kind = 'figure' GROUP BY state`
  )
  .all();
const owed = db
  .prepare(
    `SELECT o.id, o.session_id, o.question_id, o.attempts, o.state,
            substr(o.error, 1, 220) AS error, o.updated_at,
            q.q_order, substr(q.text, 1, 60) AS question
       FROM message_outbox o LEFT JOIN questions q ON q.id = o.question_id
      WHERE o.kind = 'figure' AND o.state <> 'sent'
      ORDER BY o.id DESC LIMIT 10`
  )
  .all();

if (deliveries.length) {
  console.log('');
  console.log('figure deliveries:', deliveries.map((d) => `${d.state}=${d.c}`).join('  '));
}
for (const row of owed) {
  console.log(`  ! session ${row.session_id}, question ${row.q_order} — ${row.state} after ${row.attempts} attempt(s)`);
  if (row.error) console.log(`    ${row.error}`);
}

console.log('');
const totalQ = [...byExam.values()].reduce((n, r) => n + r.total, 0);
const totalFig = [...byExam.values()].reduce((n, r) => n + r.withFigure, 0);

if (!totalFig) {
  console.log('NO question in this database carries a figure.');
  console.log('That is an IMPORT problem, not a WhatsApp one — delivery never had a picture to send.');
  console.log('');
  console.log('The import note on the upload reports what was ATTACHED (files that exist), not');
  console.log('just what the page scan found — the possible readings are:');
  console.log('  "Found N ... and attached each to its question"   -> files exist; look at DELIVERY above instead.');
  console.log('  "Found N but none could be rendered (...)"        -> rendering failed; the note carries the reason.');
  console.log('  "Attached X of N ... could not be rendered (...)" -> partial; the rest never became files.');
  console.log('  "No images or diagrams were found ..."            -> the page scan found nothing to assemble.');
  console.log('  "No images or diagrams were attached: ... rejected as ..." -> every candidate was filtered; the note names the rule.');
  console.log('  "...no saved question references them"            -> figures exist, but no saved question kept their marker.');
  console.log('');
  console.log('For scanned papers also confirm AI_VISION=true (it asks the model to point at a figure the scan missed).');
} else {
  console.log(`${totalFig} of ${totalQ} question(s) carry a figure.`);
  const missing = [...byExam.values()].reduce((n, r) => n + r.missing, 0);
  if (missing) {
    console.log(`${missing} figure file(s) are MISSING from disk — WhatsApp cannot send a file that is not there.`);
    console.log('This is what an ephemeral uploads directory looks like after a redeploy.');
    console.log('Re-import the PDF, and make sure UPLOADS_DIR points at a persistent disk.');
  } else {
    console.log('Every figure file is present on disk, so delivery has what it needs.');
    console.log('The "figure deliveries" line above is the other half: anything other than sent');
    console.log('has its error printed right below it, and is retried on the next message the');
    console.log('student sends. The same failure appears in the log as');
    console.log('"question image send failed (continued)".');
  }
}
