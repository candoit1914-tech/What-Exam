const db = require('../db');
const pdf = require('./pdf');
const ai = require('./ai');
const marking = require('./marking');
const { stripSourceWatermarks } = require('./textClean');

// ── Import helpers ─────────────────────────────────────────────────────

/**
 * Build the stored [{key,text}] option list for an objective question.
 * Keeps the letter each option carries on the paper (A., B., C., D.) as its
 * key so the answer key's letter keeps pointing at the right option even if
 * the AI happened to reorder the options. Options without a letter prefix get
 * A-D assigned by position.
 */
function buildOptions(rawOptions) {
  const opts = [];
  let idx = 0;
  for (const raw of rawOptions || []) {
    const t = String(raw == null ? '' : raw).trim();
    // A leading letter only counts as an option key when a real separator
    // (".", "-", ":", ")", "]") follows it, so a prose word like "Accra" or
    // "Cape Coast" is never misread as "A. ccra".
    const m = t.match(/^\(?([A-Da-d])\)?[.\s):\]-]+\s*(.*)$/);
    const key = m ? m[1].toUpperCase() : String.fromCharCode(65 + idx);
    const text = m ? m[2].trim() : t;
    opts.push({ key, text });
    idx++;
  }
  return opts;
}

/**
 * Pick a bare A-D letter for the correct answer. A validated correct_index is
 * preferred because it is anchored to the option array the AI actually
 * returned; the answer-key letter falls back to a sanitized match against the
 * option text so extra characters ("B. Accra", "Option B") can never flip a
 * correct answer to wrong.
 */
function correctKeyFor(opts, aiAnswer, fallback) {
  const ci = aiAnswer && aiAnswer.correct_index;
  if (ci != null && Number.isInteger(Number(ci)) && Number(ci) >= 0 && Number(ci) < opts.length) {
    return opts[Number(ci)].key;
  }
  if (aiAnswer && aiAnswer.correct_answer) {
    const k = marking.sanitizeCorrectAnswer(aiAnswer.correct_answer, opts);
    if (k) return k;
  }
  return fallback || null;
}

// ── Job store ──────────────────────────────────────────────────────────

function getJob(id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

function allJobs() {
  return db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 50').all();
}

function jobsForExam(examId) {
  return db.prepare('SELECT * FROM jobs WHERE exam_id = ? ORDER BY id DESC LIMIT 20').all(examId);
}

/** Any job that is still running for this exam (blocks duplicate uploads). */
function activeJobForExam(examId) {
  return db
    .prepare(`SELECT * FROM jobs WHERE exam_id = ? AND status IN ('pending','running') ORDER BY id DESC LIMIT 1`)
    .get(examId);
}

function deleteJob(id) {
  return db.prepare('DELETE FROM jobs WHERE id = ?').run(id).changes > 0;
}

function createJob(examId, filename) {
  const info = db
    .prepare(
      `INSERT INTO jobs (type, exam_id, filename, status)
       VALUES ('pdf_import', ?, ?, 'pending')`
    )
    .run(examId, String(filename || 'upload.pdf'));
  return info.lastInsertRowid;
}

function updateJob(id, patch) {
  const fields = Object.keys(patch);
  if (!fields.length) return;
  const vals = fields.map((f) => patch[f]);
  vals.push(id);
  db.prepare(
    `UPDATE jobs SET ${fields.map((f) => `${f}=?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
  ).run(...vals);
}

// ── Worker ─────────────────────────────────────────────────────────────

/**
 * Process an uploaded exam PDF in the background. Runs entirely off the HTTP
 * request path so a slow AI endpoint can never make the browser hang or a
 * proxy/server timeout kill the import. Progress is written to the jobs table
 * so the dashboard can poll it.
 */
async function startJob(jobId, buffer) {
  const job = getJob(jobId);
  if (!job) return;
  updateJob(jobId, { status: 'running', stage: 'Reading PDF…', progress: 2 });

  const created = [];
  try {
    const text = await pdf.extractText(buffer);
    updateJob(jobId, { stage: 'Parsing questions…', progress: 10 });

    const parsed = await ai.extractQuestionsFromText(text, (done, total) => {
      const pct = 10 + Math.round((done / Math.max(1, total)) * 45);
      updateJob(jobId, { stage: `Parsing questions… (${done}/${total})`, progress: pct });
    });
    if (!parsed.length) {
      throw new Error('No questions could be parsed from this PDF. Is the document text-based?');
    }

    const warning = ai.completenessWarning(ai.estimateQuestionCount(text), parsed);
    if (warning) updateJob(jobId, { warning });

    // Objective questions missing an answer key are sent to AI for answers.
    // This step is best-effort: a failure must not fail the whole import.
    const objQuestions = [];
    const missingAnswers = [];
    for (const g of parsed) {
      if (g.type === 'objective') {
        objQuestions.push(g);
        if (!g.correct_answer) {
          missingAnswers.push({ index: objQuestions.length - 1, text: g.text, options: g.options || [] });
        }
      }
    }
    let answersMap = {};
    if (missingAnswers.length) {
      updateJob(jobId, { stage: 'Filling missing answers…', progress: 57 });
      try {
        const answers = await ai.answerObjectiveQuestions(missingAnswers);
        for (const a of answers) answersMap[a.index] = a;
      } catch (err) {
        console.error('[pdfImport] answer fill failed (continuing):', err.message);
      }
    }

    updateJob(jobId, { stage: 'Saving questions…', progress: 62 });
    let nextOrder =
      (db.prepare('SELECT MAX(q_order) m FROM questions WHERE exam_id = ?').get(job.exam_id).m || 0) + 1;
    const insert = db.prepare(
      `INSERT INTO questions (exam_id, q_order, type, text, passage, options, correct_answer, marks, difficulty, learning_objective, explanation, source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    );

    // Reading-comprehension papers share one passage across a run of
    // questions. The extraction returns the passage once, on the first
    // question of the group, so carry it forward here: every question in the
    // group gets the passage and stays answerable on its own. Theory and
    // objective questions are saved together in document order for exactly
    // this reason.
    let curPassage = '';
    let objIdx = 0;
    const theoryToScheme = [];
    for (const g of parsed) {
      if (g.passage && String(g.passage).trim()) curPassage = stripSourceWatermarks(String(g.passage).trim());
      const passage = curPassage;
      g.text = stripSourceWatermarks(g.text);

      if (g.type === 'objective') {
        const opts = buildOptions(g.options);
        const gi = objIdx++;
        let correct = null;
        let explanation = g.explanation || '';
        const hasExtracted = !!(g.correct_answer && String(g.correct_answer).trim()) || g.correct_index != null;
        if (hasExtracted) {
          correct = correctKeyFor(opts, g);
        } else if (answersMap[gi]) {
          correct = correctKeyFor(opts, answersMap[gi]);
          explanation = answersMap[gi].explanation || '';
        }
        const marks = parseFloat(g.marks) || 1;
        const info = insert.run(
          job.exam_id, nextOrder, 'objective', g.text, passage, JSON.stringify(opts),
          correct, marks, g.difficulty || 'medium', g.learning_objective || '', explanation, 'pdf'
        );
        created.push(info.lastInsertRowid);
        db.prepare(
          `INSERT INTO marking_schemes (question_id, type, scheme) VALUES (?, 'objective', ?)
           ON CONFLICT(question_id) DO UPDATE SET scheme=excluded.scheme, updated_at=datetime('now')`
        ).run(info.lastInsertRowid, JSON.stringify({
          type: 'objective',
          correct_answer: correct,
          marks,
          explanation,
        }));
      } else {
        const info = insert.run(
          job.exam_id, nextOrder, 'theory', g.text, passage, null, null,
          parseFloat(g.marks) || 5, g.difficulty || 'medium', g.learning_objective || '', '', 'pdf'
        );
        const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(info.lastInsertRowid);
        created.push(q.id);
        // Preserve ANY marking-scheme content the paper provides (model answer,
        // key points, rubric). A partial scheme is kept verbatim and then passed
        // to buildMarkingScheme, which fills the missing parts with AI while
        // merging the paper's own content back in.
        if (g.model_answer || g.key_points?.length || g.rubric?.length || g.presentation_marks || g.grammar_marks) {
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
        theoryToScheme.push(q);
      }
      nextOrder++;
    }

    updateJob(jobId, { stage: 'Building marking schemes…', progress: 70 });
    let schemed = 0;
    const totalSchemes = theoryToScheme.length;
    const tasks = theoryToScheme.map((q) => () => {
      schemed++;
      const pct = 70 + Math.round((schemed / Math.max(1, totalSchemes)) * 25);
      updateJob(jobId, { progress: Math.min(pct, 98) });
      return marking.buildMarkingScheme(q);
    });
    await ai.mapLimit(tasks, 3, (run) => run());

    marking.recomputeExamTotal(job.exam_id);
    updateJob(jobId, { status: 'done', stage: 'Done', progress: 100, count: created.length });
  } catch (err) {
    // Never leave a half-imported question set behind: roll back anything this
    // job inserted (cascades to marking_schemes) so a retry starts clean.
    if (created.length) {
      db.exec('BEGIN');
      try {
        const del = db.prepare('DELETE FROM questions WHERE id = ?');
        for (const id of created) del.run(id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        console.error('[pdfImport] rollback failed:', e.message);
      }
    }
    console.error('[pdfImport] job failed:', err);
    updateJob(jobId, { status: 'error', stage: 'Failed', error: err.message || 'Import failed' });
  }
}

module.exports = {
  getJob,
  allJobs,
  jobsForExam,
  activeJobForExam,
  deleteJob,
  createJob,
  updateJob,
  startJob,
  buildOptions,
  correctKeyFor,
};
