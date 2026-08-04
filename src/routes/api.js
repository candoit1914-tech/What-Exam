const express = require('express');
const multer = require('multer');
const db = require('../db');
const ai = require('../services/ai');
const marking = require('../services/marking');
const pdf = require('../services/pdf');
const examService = require('../services/exam');
const results = require('../services/results');
const config = require('../config');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function qWithScheme(row) {
  const scheme = marking.getScheme(row.id);
  return {
    id: row.id,
    exam_id: row.exam_id,
    q_order: row.q_order,
    type: row.type,
    text: row.text,
    options: row.options ? JSON.parse(row.options) : null,
    correct_answer: row.correct_answer,
    marks: row.marks,
    difficulty: row.difficulty,
    learning_objective: row.learning_objective,
    explanation: row.explanation,
    source: row.source,
    scheme,
  };
}

function examSummary(row) {
  const questions = db
    .prepare('SELECT COUNT(*) c, COALESCE(SUM(marks),0) m FROM questions WHERE exam_id = ?')
    .get(row.id);
  const sessions = db
    .prepare(
      `SELECT
         COUNT(*) total,
         COALESCE(SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END),0) active,
         COALESCE(SUM(CASE WHEN status IN ('completed','expired','ended') THEN 1 ELSE 0 END),0) finished
       FROM sessions WHERE exam_id = ?`
    )
    .get(row.id);
  return {
    id: row.id,
    title: row.title,
    subject: row.subject,
    description: row.description,
    duration_minutes: row.duration_minutes,
    pass_percentage: row.pass_percentage,
    status: row.status,
    generated_by: row.generated_by,
    total_marks: questions.m,
    question_count: questions.c,
    sessions_total: sessions.total,
    sessions_active: sessions.active,
    sessions_finished: sessions.finished,
    created_at: row.created_at,
    published_at: row.published_at,
    ended_at: row.ended_at,
  };
}

function asyncWrap(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// ── Stats ──────────────────────────────────────────────────────────────

router.get('/stats', (req, res) => {
  res.json({
    exams: db.prepare('SELECT COUNT(*) c FROM exams').get().c,
    published: db.prepare(`SELECT COUNT(*) c FROM exams WHERE status IN ('published','live')`).get().c,
    questions: db.prepare('SELECT COUNT(*) c FROM questions').get().c,
    students: db.prepare('SELECT COUNT(*) c FROM students').get().c,
    sessions: db.prepare('SELECT COUNT(*) c FROM sessions').get().c,
    active: db.prepare(`SELECT COUNT(*) c FROM sessions WHERE status='in_progress'`).get().c,
    reviews: db.prepare('SELECT COUNT(*) c FROM answers WHERE needs_review=1').get().c,
  });
});

// ── Webhook diagnostics ───────────────────────────────────────────────
router.get('/webhook-events', (req, res) => {
  const rows = db.prepare('SELECT id, source, payload, received_at FROM webhook_events ORDER BY id DESC LIMIT 30').all();
  res.json(rows);
});
router.delete('/webhook-events', (req, res) => {
  db.prepare('DELETE FROM webhook_events').run();
  res.json({ ok: true, message: 'webhook_events cleared' });
});

// ── Exams ──────────────────────────────────────────────────────────────

router.get('/exams', (req, res) => {
  const rows = db.prepare('SELECT * FROM exams ORDER BY created_at DESC').all();
  res.json(rows.map(examSummary));
});

router.post('/exams', (req, res) => {
  const { title, subject, description, duration_minutes, pass_percentage } = req.body;
  const info = db
    .prepare(
      `INSERT INTO exams (title, subject, description, duration_minutes, pass_percentage, generated_by)
       VALUES (?,?,?,?,?, 'manual')`
    )
    .run(
      title || 'Untitled Exam',
      subject || '',
      description || '',
      parseInt(duration_minutes) || config.exam.defaultDurationMinutes,
      parseFloat(pass_percentage) || config.exam.passPercentage
    );
  res.json({ id: info.lastInsertRowid });
});

router.get('/exams/:id', (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  const questions = db
    .prepare('SELECT * FROM questions WHERE exam_id = ? ORDER BY q_order')
    .all(exam.id)
    .map(qWithScheme);
  const recipients = db
    .prepare(
      `SELECT s.*, r.sent_at FROM exam_recipients r JOIN students s ON s.id = r.student_id WHERE r.exam_id = ?`
    )
    .all(exam.id);
  const resultsList = db
    .prepare(
      `SELECT s.*, st.name AS student_name, st.phone FROM sessions s
       JOIN students st ON st.id = s.student_id WHERE s.exam_id = ? ORDER BY s.started_at DESC`
    )
    .all(exam.id);
  res.json({ exam: examSummary(exam), questions, recipients, results: resultsList });
});

router.patch('/exams/:id', (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  const b = req.body;
  const fields = [];
  const vals = [];
  if (b.title !== undefined) { fields.push('title=?'); vals.push(String(b.title)); }
  if (b.subject !== undefined) { fields.push('subject=?'); vals.push(String(b.subject)); }
  if (b.description !== undefined) { fields.push('description=?'); vals.push(String(b.description)); }
  if (b.duration_minutes !== undefined) { fields.push('duration_minutes=?'); vals.push(parseInt(b.duration_minutes)); }
  if (b.pass_percentage !== undefined) { fields.push('pass_percentage=?'); vals.push(parseFloat(b.pass_percentage)); }
  if (!fields.length) return res.json({ ok: true });
  vals.push(exam.id);
  db.prepare(`UPDATE exams SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

// status transitions
router.post('/exams/:id/publish', (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  const count = db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(exam.id).c;
  if (!count) return res.status(400).json({ error: 'Add at least one question before publishing.' });
  db.prepare(`UPDATE exams SET status='live', published_at = datetime('now') WHERE id = ?`).run(exam.id);
  res.json({ ok: true });
});

router.post('/exams/:id/end', asyncWrap(async (req, res) => {
  const report = await examService.endExam(req.params.id);
  res.json(report);
}));

router.post('/exams/:id/archive', (req, res) => {
  db.prepare(`UPDATE exams SET status='archived' WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

router.delete('/exams/:id', (req, res) => {
  db.prepare('DELETE FROM exams WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Recipients ─────────────────────────────────────────────────────────

router.post('/exams/:id/recipients', (req, res) => {
  const { phones, students } = req.body || {};
  const list = [];
  if (Array.isArray(students)) {
    for (const s of students) {
      if (s && s.phone) list.push({ phone: s.phone, name: s.name || '' });
    }
  } else {
    for (const p of (Array.isArray(phones) ? phones : [phones])) {
      if (p) list.push({ phone: p, name: '' });
    }
  }
  const added = [];
  for (const item of list) {
    const phone = examService.normalizePhone(item.phone);
    if (!phone) continue;
    const student = examService.getOrCreateStudent(phone);
    if (item.name) {
      db.prepare('UPDATE students SET name = ? WHERE id = ?').run(String(item.name), student.id);
    }
    db.prepare(
      `INSERT OR IGNORE INTO exam_recipients (exam_id, student_id) VALUES (?, ?)`
    ).run(req.params.id, student.id);
    added.push({ id: student.id, phone, name: item.name || student.name });
  }
  res.json({ added });
});

router.delete('/exams/:id/recipients/:studentId', (req, res) => {
  db.prepare('DELETE FROM exam_recipients WHERE exam_id = ? AND student_id = ?').run(req.params.id, req.params.studentId);
  res.json({ ok: true });
});

router.post('/exams/:id/send', asyncWrap(async (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (exam.status !== 'live') {
    return res.status(400).json({ error: 'Publish the exam first. Only live exams can be sent to recipients.' });
  }
  const report = await examService.sendExamToRecipients(req.params.id);
  res.json(report);
}));

// ── Questions ──────────────────────────────────────────────────────────

router.post('/exams/:id/questions', asyncWrap(async (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (exam.status === 'live' || exam.status === 'ended') {
    return res.status(400).json({ error: 'Exam is already live/ended. Questions can no longer be edited.' });
  }
  const q = req.body;
  const nextOrder = (db.prepare('SELECT MAX(q_order) m FROM questions WHERE exam_id = ?').get(exam.id).m || 0) + 1;
  const marks = parseFloat(q.marks) || 1;
  const info = db
    .prepare(
      `INSERT INTO questions (exam_id, q_order, type, text, options, correct_answer, marks, difficulty, learning_objective, explanation, source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      exam.id, nextOrder, q.type || 'objective', q.text,
      q.type === 'objective' && Array.isArray(q.options)
        ? JSON.stringify(q.options.map((o, i) => ({ key: String.fromCharCode(65 + i), text: o })))
        : null,
      q.correct_answer || null,
      marks, q.difficulty || 'medium', q.learning_objective || '', q.explanation || '',
      'manual'
    );
  const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(info.lastInsertRowid);
  await marking.buildMarkingScheme(question);
  marking.recomputeExamTotal(exam.id);
  res.json(qWithScheme(question));
}));

router.put('/exams/:id/questions/:qid', (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ? AND exam_id = ?').get(req.params.qid, req.params.id);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  const b = req.body;
  const fields = [];
  const vals = [];
  if (b.text !== undefined) { fields.push('text=?'); vals.push(String(b.text)); }
  if (b.type !== undefined) { fields.push('type=?'); vals.push(String(b.type)); }
  if (b.correct_answer !== undefined) { fields.push('correct_answer=?'); vals.push(b.correct_answer || null); }
  if (b.marks !== undefined) { fields.push('marks=?'); vals.push(parseFloat(b.marks)); }
  if (b.difficulty !== undefined) { fields.push('difficulty=?'); vals.push(String(b.difficulty)); }
  if (b.learning_objective !== undefined) { fields.push('learning_objective=?'); vals.push(String(b.learning_objective)); }
  if (b.explanation !== undefined) { fields.push('explanation=?'); vals.push(String(b.explanation)); }
  if (b.options !== undefined) {
    const arr = Array.isArray(b.options) ? b.options : [];
    fields.push('options=?');
    vals.push(JSON.stringify(arr.map((o, i) => ({ key: String.fromCharCode(65 + i), text: o }))));
  }
  if (fields.length) {
    vals.push(q.id);
    db.prepare(`UPDATE questions SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  }
  marking.recomputeExamTotal(q.exam_id);
  const updated = db.prepare('SELECT * FROM questions WHERE id = ?').get(q.id);
  res.json(qWithScheme(updated));
});

router.delete('/exams/:id/questions/:qid', (req, res) => {
  db.prepare('DELETE FROM questions WHERE id = ? AND exam_id = ?').run(req.params.qid, req.params.id);
  db.prepare(
    `WITH ranked AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY q_order) AS rn
       FROM questions WHERE exam_id = ?
     )
     UPDATE questions SET q_order = (SELECT rn FROM ranked WHERE ranked.id = questions.id)
     WHERE exam_id = ?`
  ).run(req.params.id, req.params.id);
  marking.recomputeExamTotal(req.params.id);
  res.json({ ok: true });
});

// ── Marking schemes ────────────────────────────────────────────────────

router.put('/exams/:id/scheme/:qid', (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ? AND exam_id = ?').get(req.params.qid, req.params.id);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  const scheme = req.body.scheme || req.body;
  db.prepare(
    `INSERT INTO marking_schemes (question_id, type, scheme)
     VALUES (?,?,?) ON CONFLICT(question_id) DO UPDATE SET scheme=excluded.scheme, updated_at=datetime('now')`
  ).run(q.id, q.type, JSON.stringify(scheme));
  res.json({ ok: true });
});

router.post('/exams/:id/scheme/:qid/generate', asyncWrap(async (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ? AND exam_id = ?').get(req.params.qid, req.params.id);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  if (q.type !== 'theory') return res.status(400).json({ error: 'Only theory questions need an AI-generated scheme.' });
  const scheme = await marking.buildMarkingScheme(q);
  res.json({ ok: true, scheme });
}));

// ── AI generation ──────────────────────────────────────────────────────

router.post('/exams/:id/generate', asyncWrap(async (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (exam.status === 'live' || exam.status === 'ended') {
    return res.status(400).json({ error: 'Exam is already live/ended.' });
  }
  const { subject, topics, count, types, difficulty, instructions } = req.body;
  const generated = await ai.generateQuestions({
    subject: subject || exam.subject || exam.title,
    topics,
    count: parseInt(count) || 10,
    types: Array.isArray(types) ? types : ['objective', 'theory'],
    difficulty,
    instructions,
  });

  let nextOrder = (db.prepare('SELECT MAX(q_order) m FROM questions WHERE exam_id = ?').get(exam.id).m || 0) + 1;
  const insert = db.prepare(
    `INSERT INTO questions (exam_id, q_order, type, text, options, correct_answer, marks, difficulty, learning_objective, explanation, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  const created = [];
  for (const g of generated) {
    if (g.type === 'objective') {
      const opts = (g.options || []).map((t, i) => ({ key: String.fromCharCode(65 + i), text: t }));
      const correct = g.correct_index != null ? opts[g.correct_index]?.key : g.correct_answer;
      const info = insert.run(
        exam.id, nextOrder, 'objective', g.text, JSON.stringify(opts),
        correct || null, parseFloat(g.marks) || 1,
        g.difficulty || 'medium', g.learning_objective || '', g.explanation || '', 'ai'
      );
      created.push(info.lastInsertRowid);
      const oq = db.prepare('SELECT * FROM questions WHERE id = ?').get(info.lastInsertRowid);
      db.prepare(
        `INSERT INTO marking_schemes (question_id, type, scheme) VALUES (?, 'objective', ?)
         ON CONFLICT(question_id) DO UPDATE SET scheme=excluded.scheme, updated_at=datetime('now')`
      ).run(oq.id, JSON.stringify({
        type: 'objective',
        correct_answer: oq.correct_answer,
        marks: oq.marks,
        explanation: oq.explanation,
      }));
    } else {
      const info = insert.run(
        exam.id, nextOrder, 'theory', g.text, null, null,
        parseFloat(g.marks) || 5, g.difficulty || 'medium', g.learning_objective || '', '', 'ai'
      );
      created.push(info.lastInsertRowid);
      const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(info.lastInsertRowid);
      db.prepare(
        `INSERT INTO marking_schemes (question_id, type, scheme) VALUES (?, 'theory', ?)
         ON CONFLICT(question_id) DO UPDATE SET scheme=excluded.scheme`
      ).run(q.id, JSON.stringify({
        type: 'theory',
        model_answer: g.model_answer || '',
        key_points: g.key_points || [],
        rubric: g.rubric || [],
        presentation_marks: g.presentation_marks || 0,
        grammar_marks: g.grammar_marks || 0,
      }));
    }
    nextOrder++;
  }
  marking.recomputeExamTotal(exam.id);
  res.json({ ok: true, count: created.length, questions: created });
}));

// ── PDF upload ─────────────────────────────────────────────────────────

router.post('/exams/:id/pdf', upload.single('file'), asyncWrap(async (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const text = await pdf.extractText(req.file.buffer);
  pdf.saveUpload(req.file.buffer, req.file.originalname);
  const parsed = await ai.extractQuestionsFromText(text);

  let nextOrder = (db.prepare('SELECT MAX(q_order) m FROM questions WHERE exam_id = ?').get(exam.id).m || 0) + 1;
  const insert = db.prepare(
    `INSERT INTO questions (exam_id, q_order, type, text, options, correct_answer, marks, difficulty, learning_objective, explanation, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );

  // prepare objective questions missing answers for AI generation
  const missingAnswers = [];
  const objQuestions = [];
  for (const g of parsed) {
    if (g.type === 'objective') {
      objQuestions.push(g);
      if (!g.correct_answer) missingAnswers.push({ index: objQuestions.length - 1, text: g.text, options: g.options || [] });
    }
  }
  let answersMap = {};
  if (missingAnswers.length) {
    const answers = await ai.answerObjectiveQuestions(missingAnswers);
    for (const a of answers) answersMap[a.index] = a;
  }

  let created = 0;
  for (let i = 0; i < objQuestions.length; i++) {
    const g = objQuestions[i];
    const opts = (g.options || []).map((t, j) => ({
      key: String.fromCharCode(65 + j),
      text: String(t).replace(/^[A-D][.\s)]*\s*/i, '').trim(),
    }));
    let correct = g.correct_answer;
    let explanation = g.explanation || '';
    if (!correct && answersMap[i]) {
      correct = answersMap[i].correct_index >= 0 ? opts[answersMap[i].correct_index]?.key : null;
      explanation = answersMap[i].explanation || '';
    }
    insert.run(
      exam.id, nextOrder, 'objective', g.text, JSON.stringify(opts),
      correct || null, parseFloat(g.marks) || 1,
      g.difficulty || 'medium', g.learning_objective || '', explanation, 'pdf'
    );
    const oq = db.prepare('SELECT * FROM questions WHERE id = ?').get(
      db.prepare('SELECT id FROM questions WHERE exam_id = ? AND q_order = ?').get(exam.id, nextOrder).id
    );
    db.prepare(
      `INSERT INTO marking_schemes (question_id, type, scheme) VALUES (?, 'objective', ?)
       ON CONFLICT(question_id) DO UPDATE SET scheme=excluded.scheme, updated_at=datetime('now')`
    ).run(oq.id, JSON.stringify({
      type: 'objective',
      correct_answer: oq.correct_answer,
      marks: oq.marks,
      explanation: oq.explanation,
    }));
    nextOrder++;
    created++;
  }

  // theory questions: generate schemes in sequence
  for (const g of parsed) {
    if (g.type !== 'theory') continue;
    const info = insert.run(
      exam.id, nextOrder, 'theory', g.text, null, null,
      parseFloat(g.marks) || 5, g.difficulty || 'medium', g.learning_objective || '', '', 'pdf'
    );
    const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(info.lastInsertRowid);
    if (g.model_answer && g.key_points?.length) {
      db.prepare(
        `INSERT INTO marking_schemes (question_id, type, scheme) VALUES (?, 'theory', ?)
         ON CONFLICT(question_id) DO UPDATE SET scheme=excluded.scheme`
      ).run(q.id, JSON.stringify({
        type: 'theory',
        model_answer: g.model_answer || '',
        key_points: g.key_points || [],
        rubric: g.rubric || [],
        presentation_marks: g.presentation_marks || 0,
        grammar_marks: g.grammar_marks || 0,
      }));
    } else {
      await marking.buildMarkingScheme(q);
    }
    nextOrder++;
    created++;
  }

  marking.recomputeExamTotal(exam.id);
  res.json({ ok: true, count: created, textLength: text.length });
}));

// ── Delivery status ────────────────────────────────────────────────────

router.get('/messages', (req, res) => {
  const { phone } = req.query;
  const rows = phone
    ? db.prepare(
        `SELECT * FROM outbound_messages WHERE recipient = ? ORDER BY id DESC LIMIT 50`
      ).all(phone)
    : db.prepare(`SELECT * FROM outbound_messages ORDER BY id DESC LIMIT 50`).all();
  res.json(rows);
});

// ── Results / review ───────────────────────────────────────────────────

router.get('/results', (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.*, e.title AS exam_title, e.pass_percentage, st.name AS student_name, st.phone
       FROM sessions s
       JOIN exams e ON e.id = s.exam_id
       JOIN students st ON st.id = s.student_id
       WHERE s.status IN ('completed','expired','ended')
       ORDER BY s.ended_at DESC`
    )
    .all();
  res.json(rows);
});

router.get('/results/:sessionId', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const r = results.computeForSession(session.id);
  const answers = db
    .prepare(
      `SELECT a.id, a.q_order, a.answer_text, a.is_correct, a.marks_awarded, a.max_marks,
              a.marked_by, a.ai_feedback, a.needs_review, a.reviewed,
              q.type, q.text, q.correct_answer
       FROM answers a JOIN questions q ON q.id = a.question_id
       WHERE a.session_id = ? ORDER BY q.q_order`
    )
    .all(session.id);
  res.json({ ...r, answers });
});

router.patch('/results/:sessionId/answers/:answerId', (req, res) => {
  const { marks_awarded, reviewed } = req.body;
  const fields = [];
  const vals = [];
  if (marks_awarded !== undefined) { fields.push('marks_awarded=?'); vals.push(parseFloat(marks_awarded)); }
  if (reviewed !== undefined) { fields.push('reviewed=?'); vals.push(reviewed ? 1 : 0); }
  if (fields.length) {
    fields.push('needs_review=0');
    vals.push(req.params.answerId);
    db.prepare(`UPDATE answers SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  }
  const sessionId = db.prepare('SELECT session_id FROM answers WHERE id = ?').get(req.params.answerId)?.session_id;
  if (sessionId) results.computeForSession(sessionId);
  res.json({ ok: true });
});

// ── Students ───────────────────────────────────────────────────────────

router.get('/students', (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.*,
         (SELECT COUNT(*) FROM exam_recipients r WHERE r.student_id = s.id) AS exams,
         (SELECT COUNT(*) FROM sessions s2 WHERE s2.student_id = s.id) AS attempts
       FROM students s ORDER BY s.created_at DESC`
    )
    .all();
  res.json(rows);
});

router.patch('/students/:id', (req, res) => {
  if (req.body.name !== undefined) {
    db.prepare('UPDATE students SET name = ? WHERE id = ?').run(String(req.body.name), req.params.id);
  }
  res.json({ ok: true });
});

// ── Resend result ──────────────────────────────────────────────────────

router.post('/results/:sessionId/resend', asyncWrap(async (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(session.student_id);
  await results.sendResultMessage(session.id, student.phone, session.status);
  res.json({ ok: true });
}));

module.exports = router;
