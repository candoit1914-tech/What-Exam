const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const ai = require('../services/ai');
const marking = require('../services/marking');
const pdf = require('../services/pdf');
const pdfImport = require('../services/pdfImport');
const examService = require('../services/exam');
const results = require('../services/results');
const config = require('../config');
const auth = require('../auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── Admin auth ─────────────────────────────────────────────────────────
router.post('/auth/login', (req, res) => {
  const password = (req.body && req.body.password) || '';
  if (!auth.verifyPassword(password)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  res.json({ token: auth.adminToken() });
});

router.use((req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!auth.verifyAdmin(token)) {
    return res.status(401).json({ error: 'Unauthorized — please sign in.' });
  }
  next();
});

function qWithScheme(row) {
  const scheme = marking.getScheme(row.id);
  return {
    id: row.id,
    exam_id: row.exam_id,
    q_order: row.q_order,
    type: row.type,
    text: row.text,
    passage: row.passage || '',
    options: row.options ? JSON.parse(row.options) : null,
    correct_answer: row.correct_answer,
    marks: row.marks,
    difficulty: row.difficulty,
    learning_objective: row.learning_objective,
    explanation: row.explanation,
    source: row.source,
    image: row.image || '',
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
  if (b.duration_minutes !== undefined) { fields.push('duration_minutes=?'); vals.push(Math.max(parseInt(b.duration_minutes) || config.exam.defaultDurationMinutes, 1)); }
  if (b.pass_percentage !== undefined) {
    const p = parseFloat(b.pass_percentage);
    fields.push('pass_percentage=?');
    vals.push(Number.isFinite(p) ? Math.min(Math.max(p, 0), 100) : config.exam.passPercentage);
  }
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
      `INSERT INTO questions (exam_id, q_order, type, text, passage, options, correct_answer, marks, difficulty, learning_objective, explanation, source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      exam.id, nextOrder, q.type || 'objective', q.text, q.passage || '',
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

// Batch add multiple questions at once (much faster than adding one-by-one)
router.post('/exams/:id/questions/batch', asyncWrap(async (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (exam.status === 'live' || exam.status === 'ended') {
    return res.status(400).json({ error: 'Exam is already live/ended. Questions can no longer be edited.' });
  }
  const questions = Array.isArray(req.body.questions) ? req.body.questions : [];
  if (!questions.length) return res.status(400).json({ error: 'No questions provided' });

  let nextOrder = (db.prepare('SELECT MAX(q_order) m FROM questions WHERE exam_id = ?').get(exam.id).m || 0) + 1;
  const insert = db.prepare(
    `INSERT INTO questions (exam_id, q_order, type, text, passage, options, correct_answer, marks, difficulty, learning_objective, explanation, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insertScheme = db.prepare(
    `INSERT INTO marking_schemes (question_id, type, scheme) VALUES (?, ?, ?)
     ON CONFLICT(question_id) DO UPDATE SET scheme=excluded.scheme, updated_at=datetime('now')`
  );

  const created = [];
  const theoryToScheme = [];

  db.exec('BEGIN');
  try {
    for (const q of questions) {
      const marks = parseFloat(q.marks) || (q.type === 'theory' ? 5 : 1);
      const info = insert.run(
        exam.id, nextOrder, q.type || 'objective', q.text || '', q.passage || '',
        q.type === 'objective' && Array.isArray(q.options)
          ? JSON.stringify(q.options.map((o, i) => ({ key: String.fromCharCode(65 + i), text: o })))
          : null,
        q.correct_answer || null,
        marks, q.difficulty || 'medium', q.learning_objective || '', q.explanation || '',
        q.source || 'manual'
      );
      const qid = info.lastInsertRowid;
      created.push(qid);

      // Insert scheme inline for objective questions
      if (q.type === 'objective') {
        insertScheme.run(qid, 'objective', JSON.stringify({
          type: 'objective',
          correct_answer: q.correct_answer || null,
          marks,
          explanation: q.explanation || '',
        }));
      } else {
        // For theory questions, if scheme data is provided, use it; otherwise mark for AI generation
        if (q.model_answer || q.key_points?.length || q.rubric?.length) {
          insertScheme.run(qid, 'theory', JSON.stringify({
            type: 'theory',
            model_answer: q.model_answer || '',
            key_points: q.key_points || [],
            rubric: q.rubric || [],
            presentation_marks: q.presentation_marks || 0,
            grammar_marks: q.grammar_marks || 0,
          }));
        } else {
          theoryToScheme.push(qid);
        }
      }
      nextOrder++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // Generate marking schemes for theory questions in parallel (best-effort)
  if (theoryToScheme.length) {
    const schemeTasks = theoryToScheme.map((qid) => async () => {
      try {
        const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(qid);
        if (q) await marking.buildMarkingScheme(q);
      } catch (err) {
        console.error('[api] batch scheme gen failed for qid', qid, err.message);
      }
    });
    await ai.mapLimit(schemeTasks, 8, (run) => run());
  }

  marking.recomputeExamTotal(exam.id);
  res.json({ ok: true, count: created.length, questions: created });
}));

router.put('/exams/:id/questions/:qid', (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (exam.status === 'live' || exam.status === 'ended') {
    return res.status(400).json({ error: 'Exam is already live/ended. Questions can no longer be edited.' });
  }
  const q = db.prepare('SELECT * FROM questions WHERE id = ? AND exam_id = ?').get(req.params.qid, req.params.id);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  const b = req.body;
  const fields = [];
  const vals = [];
  if (b.text !== undefined) { fields.push('text=?'); vals.push(String(b.text)); }
  if (b.passage !== undefined) { fields.push('passage=?'); vals.push(String(b.passage)); }
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
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (exam.status === 'live' || exam.status === 'ended') {
    return res.status(400).json({ error: 'Exam is already live/ended. Questions can no longer be edited.' });
  }
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
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (exam.status === 'live' || exam.status === 'ended') {
    return res.status(400).json({ error: 'Exam is already live/ended. Schemes can no longer be edited.' });
  }
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
  const { subject, topics, count, objectiveCount, theoryCount, types, difficulty, instructions, pool, poolMultiplier } = req.body;
  const objN = objectiveCount != null ? Math.min(Math.max(parseInt(objectiveCount) || 0, 0), 50) : null;
  const theoN = theoryCount != null ? Math.min(Math.max(parseInt(theoryCount) || 0, 0), 50) : null;
  const totalFromTypes = (objN || 0) + (theoN || 0);
  const n = totalFromTypes > 0
    ? Math.min(Math.max(totalFromTypes, 1), 150)
    : Math.min(Math.max(parseInt(count) || 10, 1), 50);
  const multiplier = pool ? Math.min(Math.max(parseInt(poolMultiplier) || 2, 2), 7) : 1;
  console.log(`[generate] exam=${exam.id} objN=${objN} theoN=${theoN} n=${n} pool=${pool} multiplier=${multiplier}`);
  const existing = db
    .prepare('SELECT text FROM questions WHERE exam_id = ? ORDER BY q_order LIMIT 20')
    .all(exam.id)
    .map((r) => r.text);
  let generated;
  try {
    generated = await ai.generateQuestions({
      subject: subject || exam.subject || exam.title,
      topics,
      count: n,
      objectiveCount: objN,
      theoryCount: theoN,
      poolSize: pool ? n * multiplier : n,
      types: Array.isArray(types) ? types : ['objective', 'theory'],
      difficulty,
      instructions,
      avoid: existing,
    });
  } catch (err) {
    console.error('[generate] AI generation failed:', err.message);
    return res.status(502).json({ error: `AI generation failed: ${err.message}` });
  }
  console.log(`[generate] got ${generated.length} questions from AI`);
  if (generated.length === 0) {
    return res.status(502).json({ error: 'AI returned no questions. The provider may be rate-limited — try again in a few seconds.' });
  }

  const active = generated.slice(0, n);
  const variants = pool ? generated.slice(n) : [];

  let nextOrder = (db.prepare('SELECT MAX(q_order) m FROM questions WHERE exam_id = ?').get(exam.id).m || 0) + 1;
  const insert = db.prepare(
    `INSERT INTO questions (exam_id, q_order, type, text, passage, options, correct_answer, marks, difficulty, learning_objective, explanation, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insertPool = db.prepare(
    `INSERT INTO question_pool (exam_id, type, text, passage, options, correct_answer, marks, difficulty, learning_objective, explanation, scheme_json, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const created = [];
  for (const g of active) {
    if (g.type === 'objective') {
      const opts = (g.options || []).map((t, i) => ({ key: String.fromCharCode(65 + i), text: t }));
      const correct = g.correct_index != null ? opts[g.correct_index]?.key : g.correct_answer;
      const info = insert.run(
        exam.id, nextOrder, 'objective', g.text, g.passage || '', JSON.stringify(opts),
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
        exam.id, nextOrder, 'theory', g.text, g.passage || '', null, null,
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
  for (const g of variants) {
    if (g.type === 'objective') {
      const opts = (g.options || []).map((t, i) => ({ key: String.fromCharCode(65 + i), text: t }));
      const correct = g.correct_index != null ? opts[g.correct_index]?.key : g.correct_answer;
      insertPool.run(
        exam.id, 'objective', g.text, g.passage || '', JSON.stringify(opts), correct || null,
        parseFloat(g.marks) || 1, g.difficulty || 'medium', g.learning_objective || '', g.explanation || '',
        JSON.stringify({ type: 'objective', correct_answer: correct || null, marks: parseFloat(g.marks) || 1, explanation: g.explanation || '' }),
        'ai'
      );
    } else {
      insertPool.run(
        exam.id, 'theory', g.text, g.passage || '', null, null,
        parseFloat(g.marks) || 5, g.difficulty || 'medium', g.learning_objective || '', '',
        JSON.stringify({
          type: 'theory',
          model_answer: g.model_answer || '',
          key_points: g.key_points || [],
          rubric: g.rubric || [],
          presentation_marks: g.presentation_marks || 0,
          grammar_marks: g.grammar_marks || 0,
        }),
        'ai'
      );
    }
  }
  marking.recomputeExamTotal(exam.id);
  res.json({ ok: true, count: created.length, poolCount: variants.length, questions: created });
}));

// ── PDF upload (background job) ───────────────────────────────────────

router.post('/exams/:id/pdf', upload.single('file'), asyncWrap(async (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (exam.status === 'live' || exam.status === 'ended') {
    return res.status(400).json({ error: 'Exam is already live/ended. Questions can no longer be edited.' });
  }
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const magic = req.file.buffer.slice(0, 5).toString('latin1');
  if (magic !== '%PDF-') return res.status(400).json({ error: 'Uploaded file is not a valid PDF.' });

  const running = pdfImport.activeJobForExam(exam.id);
  if (running) {
    return res.status(409).json({
      error: `An import is already running for this exam (${running.stage || 'processing…'}). Please wait for it to finish.`,
    });
  }

  pdf.saveUpload(req.file.buffer, req.file.originalname);
  const jobId = pdfImport.createJob(exam.id, req.file.originalname);
  // Run off the request path: the browser gets the job id instantly and
  // polls for progress, so slow AI extraction can never hang the upload.
  pdfImport.startJob(jobId, req.file.buffer).catch((err) => {
    console.error('[pdf] background job crashed:', err);
  });
  res.json({ jobId, message: 'Upload accepted. Extraction is running in the background.' });
}));

// Diagrams extracted from uploaded PDFs, saved as PNGs in uploadsDir.
router.get('/exams/:id/images/:file', (req, res) => {
  const name = path.basename(String(req.params.file || ''));
  if (!/^[\w-]+\.png$/i.test(name)) return res.status(400).json({ error: 'Bad file name' });
  const full = path.join(config.uploadsDir, name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Image not found' });
  res.type('image/png').sendFile(full);
});

// Photo answers uploaded via WhatsApp, saved as PNGs in uploadsDir.
router.get('/results/:sessionId/image/:file', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const name = path.basename(String(req.params.file || ''));
  if (!/^[\w-]+\.png$/i.test(name)) return res.status(400).json({ error: 'Bad file name' });
  const full = path.join(config.uploadsDir, name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Image not found' });
  res.type('image/png').sendFile(full);
});

// ── Background jobs ───────────────────────────────────────────────────

router.get('/jobs', (req, res) => {
  const { exam_id } = req.query;
  res.json(exam_id ? pdfImport.jobsForExam(exam_id) : pdfImport.allJobs());
});

router.get('/jobs/:id', (req, res) => {
  const job = pdfImport.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

router.delete('/jobs/:id', (req, res) => {
  res.json({ ok: pdfImport.deleteJob(req.params.id) });
});

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

router.delete('/messages', (req, res) => {
  db.prepare('DELETE FROM outbound_messages').run();
  res.json({ ok: true, message: 'delivery log cleared' });
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
       `SELECT a.id, a.q_order, a.answer_text, a.answer_image, a.is_correct, a.marks_awarded, a.max_marks,
               a.marked_by, a.ai_feedback, a.needs_review, a.reviewed, a.ai_detected,
               q.type, q.text, q.correct_answer
       FROM answers a JOIN questions q ON q.id = a.question_id
       WHERE a.session_id = ? ORDER BY q.q_order`
    )
    .all(session.id);
  res.json({ ...r, answers });
});

router.patch('/results/:sessionId/answers/:answerId', (req, res) => {
  const { marks_awarded, reviewed } = req.body;
  const answer = db.prepare('SELECT * FROM answers WHERE id = ? AND session_id = ?').get(req.params.answerId, req.params.sessionId);
  if (!answer) return res.status(404).json({ error: 'Answer not found' });
  const fields = [];
  const vals = [];
  if (marks_awarded !== undefined) {
    const m = parseFloat(marks_awarded);
    fields.push('marks_awarded=?');
    vals.push(Number.isFinite(m) ? Math.min(Math.max(m, 0), answer.max_marks || 0) : answer.marks_awarded);
    // An admin overrode the mark, so any AI-copy flag no longer applies.
    fields.push('ai_detected=0');
  }
  if (reviewed !== undefined) { fields.push('reviewed=?'); vals.push(reviewed ? 1 : 0); }
  if (fields.length) {
    fields.push('needs_review=0');
    vals.push(answer.id);
    db.prepare(`UPDATE answers SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  }
  const updated = results.persistSessionTotals(answer.session_id);
  res.json({ ok: true, score: updated.score, percentage: updated.percentage, passed: updated.passed });
});

router.get('/results/:sessionId/report-url', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ url: auth.reportUrl(session.id) });
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

router.delete('/students/:id', (req, res) => {
  const info = db.prepare('DELETE FROM students WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Student not found' });
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
