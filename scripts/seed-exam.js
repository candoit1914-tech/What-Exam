#!/usr/bin/env node
/* Seeds the starter exam into the database.
   - Safe: skips when exams already exist (never clobbers user data).
   - CLI:   node scripts/seed-exam.js
   - Module: seedIfEmpty(db) -> { seeded:false } | { seeded:true, examId, title, status }
   The server calls seedIfEmpty() at boot so an empty DB (e.g. Render's
   ephemeral disk after a fresh deploy) is restored automatically. */
const DEMO_EXAM = {
  title: 'End of Term Integrated Science',
  subject: 'Integrated Science',
  description: '',
  duration_minutes: 30,
  pass_percentage: 50,
  status: 'live',
  generated_by: 'manual',
  total_marks: 11,
  questions: [
    {
      q_order: 1,
      type: 'objective',
      text: 'What is the capital of Ghana?',
      options: [
        { key: 'A', text: 'Kumasi' },
        { key: 'B', text: 'Accra' },
        { key: 'C', text: 'Tamale' },
        { key: 'D', text: 'Cape Coast' },
      ],
      correct_answer: 'B',
      marks: 2,
      difficulty: 'easy',
      learning_objective: 'Identify the capital city of Ghana',
      explanation: 'Accra is the capital and largest city of Ghana.',
      source: 'manual',
      scheme: {
        type: 'objective',
        correct_answer: 'B',
        marks: 2,
        explanation: 'Accra is the capital and largest city of Ghana.',
      },
    },
    {
      q_order: 2,
      type: 'objective',
      text: 'Which of these is NOT a renewable energy source?',
      options: [
        { key: 'A', text: 'Solar' },
        { key: 'B', text: 'Wind' },
        { key: 'C', text: 'Coal' },
        { key: 'D', text: 'Hydro' },
      ],
      correct_answer: 'C',
      marks: 2,
      difficulty: 'medium',
      learning_objective: 'Distinguish renewable from non-renewable energy',
      explanation: 'Coal is a fossil fuel and is non-renewable.',
      source: 'manual',
      scheme: {
        type: 'objective',
        correct_answer: 'C',
        marks: 2,
        explanation: 'Coal is a fossil fuel and is non-renewable.',
      },
    },
    {
      q_order: 3,
      type: 'theory',
      text: 'Explain three causes of soil erosion and suggest one way to control it.',
      options: null,
      correct_answer: null,
      marks: 7,
      difficulty: 'medium',
      learning_objective: 'Explain causes and control of soil erosion',
      explanation: '',
      source: 'manual',
      scheme: {
        type: 'theory',
        model_answer: '',
        key_points: [],
        rubric: [{ point: '', marks: 0, explanation: '' }],
        presentation_marks: 0,
        grammar_marks: 0,
      },
    },
  ],
  recipient_phones: ['233558126390'],
};

function seedIfEmpty(db) {
  const existing = db.prepare('SELECT COUNT(*) c FROM exams').get().c;
  if (existing > 0) return { seeded: false };

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const info = db
    .prepare(
      `INSERT INTO exams (title, subject, description, duration_minutes, pass_percentage, status, generated_by, total_marks, created_at, published_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      DEMO_EXAM.title,
      DEMO_EXAM.subject,
      DEMO_EXAM.description,
      DEMO_EXAM.duration_minutes,
      DEMO_EXAM.pass_percentage,
      DEMO_EXAM.status,
      DEMO_EXAM.generated_by,
      DEMO_EXAM.total_marks,
      now,
      now
    );
  const examId = Number(info.lastInsertRowid);

  for (const q of DEMO_EXAM.questions) {
    const qinfo = db
      .prepare(
        `INSERT INTO questions (exam_id, q_order, type, text, options, correct_answer, marks, difficulty, learning_objective, explanation, source)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        examId,
        q.q_order,
        q.type,
        q.text,
        q.options ? JSON.stringify(q.options) : null,
        q.correct_answer,
        q.marks,
        q.difficulty,
        q.learning_objective,
        q.explanation,
        q.source
      );
    const qid = Number(qinfo.lastInsertRowid);
    db.prepare('INSERT INTO marking_schemes (question_id, type, scheme, updated_at) VALUES (?,?,?,?)').run(
      qid,
      q.type,
      JSON.stringify(q.scheme),
      now
    );
  }

  const insertStudent = db.prepare('INSERT OR IGNORE INTO students (phone, name) VALUES (?,?)');
  const selectStudent = db.prepare('SELECT id FROM students WHERE phone = ?');
  const insertRecipient = db.prepare('INSERT OR IGNORE INTO exam_recipients (exam_id, student_id) VALUES (?,?)');
  for (const phone of DEMO_EXAM.recipient_phones) {
    insertStudent.run(phone, '');
    const studentId = selectStudent.get(phone).id;
    insertRecipient.run(examId, studentId);
  }

  return { seeded: true, examId, title: DEMO_EXAM.title, status: DEMO_EXAM.status };
}

module.exports = { seedIfEmpty };

if (require.main === module) {
  const db = require('../src/db');
  const r = seedIfEmpty(db);
  console.log(
    r.seeded
      ? `Seeded exam "${r.title}" (id ${r.examId}, status ${r.status}) into ${db ? 'database' : ''}`
      : 'Exams already exist — seed skipped (no data was changed).'
  );
}
