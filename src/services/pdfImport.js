const db = require('../db');
const pdf = require('./pdf');
const ai = require('./ai');
const marking = require('./marking');
const path = require('path');
const config = require('../config');
const { stripSourceWatermarks } = require('./textClean');

function diag(event, details) {
  if (process.env.PDF_DIAG === '1') console.log('[pdf-import:diag]', event, details);
}

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

/**
 * Deterministic image file name for a rendered diagram:
 * `<timestamp>-<examId>-q<qOrder>-<markerIndex>.png`. The timestamp prefix
 * keeps re-uploads from colliding while the rest stays searchable.
 */
function imageFileNameFor(examId, qOrder, markerIndex, now = Date.now()) {
  return `${now}-${examId}-q${qOrder}-${markerIndex}.png`;
}

/**
 * Render every math expression a question kept (g.markerIndices) and store it
 * as a question_images row with increasing position, so WhatsApp can send the
 * bubbles in reading order above the question text. Best-effort: a render
 * failure logs and skips that bubble — the question still imports.
 * `mathExprs` is the document-global expression list from textWithMarkers;
 * `pageCache` renders each page at most once.
 */
async function storeMathImages(g, questionId, mathExprs, pageCache, buffer, examId, qOrder) {
  const result = { requested: 0, attached: 0, failed: 0 };
  if (!Array.isArray(g.markerIndices) || !g.markerIndices.length) return result;
  const indices = [...new Set(g.markerIndices)].sort((a, b) => a - b);
  result.requested = indices.length;
  // Insert AFTER all renders succeed so positions are never left scattered if
  // an earlier render throws mid-batch.
  const rows = [];
  for (const idx of indices) {
    const expr = Number.isInteger(idx) && idx >= 0 ? mathExprs[idx] : null;
    if (!expr) {
      result.failed++;
      diag('missing math expression', { questionId, marker: `[MATH:${idx}]` });
      continue;
    }
    try {
      const dest = path.join(config.uploadsDir, imageFileNameFor(examId, qOrder, idx));
      await pdf.renderMathRegion(buffer, expr, dest, 4, pageCache);
      rows.push(path.basename(dest));
    } catch (e) {
      result.failed++;
      diag('math render failed', { questionId, page: expr.page, marker: `[MATH:${idx}]`, error: e.code || e.name });
    }
  }
  for (const image of rows) {
    try {
      db.prepare(`INSERT INTO question_images (question_id, position, image, kind) VALUES (?,?,?, 'math')`)
        .run(questionId, result.attached, image);
      result.attached++;
    } catch (e) {
      result.failed++;
      diag('math attachment failed', { questionId, error: e.code || e.name });
    }
  }
  if (result.failed) console.warn('[pdf-import] math attachments failed', { questionId, ...result });
  diag('math attachments', { questionId, ...result });
  return result;
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

/**
 * Fail every import that was left mid-flight when this server process died
 * (crash, Render redeploy). A stale 'running'/'pending' job would otherwise
 * keep the dashboard polling forever and block new uploads for that exam with
 * a "already running" 409. Called once at server boot, before anything starts.
 */
function recoverStaleJobs() {
  const info = db
    .prepare(
      `UPDATE jobs
       SET status='error', stage='Failed', progress=0, count=0,
           error='The import was interrupted by a server restart. Re-upload the PDF to try again.',
           updated_at = datetime('now')
       WHERE type='pdf_import' AND status IN ('pending','running')`
    )
    .run();
  if (info.changes) {
    console.log(`[pdfImport] marked ${info.changes} interrupted import job(s) as failed`);
  }
  return info.changes;
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
 * Explain why an import produced zero questions, in terms of what actually
 * went wrong.
 *
 * These cases are genuinely different and need different advice. Telling
 * someone their document "may not contain exam questions" when the real
 * problem is that nothing could be read out of it sends them to re-check a
 * file that is perfectly fine.
 *
 * @param {{text?: string, isOcr?: boolean, blockWarning?: string}} input
 * @returns {string}
 */
function describeExtractionFailure({ text, isOcr, blockWarning } = {}) {
  // This branch is for a TIMEOUT, so it must not claim documents that were
  // simply unreadable. The empty-text extractor reports its own warning, which
  // arrives here as `blockWarning`; checking `blockWarning` alone relabelled an
  // unreadable scan as "the AI provider did not answer in time" - the exact
  // misleading message this function exists to replace. Unreadable text is
  // handled by the branch below.
  if (blockWarning && String(text || '').trim()) {
    return (
      'No questions could be parsed from this PDF. ' +
      blockWarning +
      ' The AI provider did not answer in time — try again, or raise AI_BLOCK_TIMEOUT_MS if it keeps happening.'
    );
  }
  // Nothing readable at all. Either OCR ran and could not read the page
  // images, or the document had no usable text layer.
  if (!String(text || '').trim()) {
    return isOcr
      ? 'No readable text could be extracted from this PDF. It appears to be a scan, and OCR could not read the page images clearly enough to work with. Try a higher-resolution scan, or export the PDF from the original document rather than photographing it.'
      : 'No readable text could be extracted from this PDF, so there was nothing to build questions from. This usually means the pages are images or a scan that needs clearer imaging — try re-exporting the PDF from the original document.';
  }
  // There was plenty of readable text; it simply was not an exam paper.
  return 'The document may not contain exam questions in a recognizable format.';
}

/**
 * Process an uploaded exam PDF in the background. Runs entirely off the HTTP
 * request path so a slow AI endpoint can never make the browser hang or a
 * proxy/server timeout kill the import. Progress is written to the jobs table
 * so the dashboard can poll it.
 *
 * opts.typeFilter: optional array like ['objective'] or ['theory'] to extract
 * only specific question types. If omitted, all types are extracted.
 */
async function startJob(jobId, buffer, opts = {}) {
  const job = getJob(jobId);
  if (!job) return;
  const typeFilter = Array.isArray(opts.typeFilter) && opts.typeFilter.length ? opts.typeFilter : null;
  updateJob(jobId, { status: 'running', stage: 'Reading PDF…', progress: 2 });

  const created = [];
  // Every question row this job wrote, as ids. applySelectionRules re-reads them
  // so its claims are checked against what was really saved, not against what the
  // model claimed.
  const savedRows = [];
  try {
    const sourceText = await pdf.textWithMarkers(buffer);
    // textWithMarkers already calls analyzeDocument internally which includes
    // the image list. Use that instead of a second extractDocument call.
    const images = sourceText.images || [];
    const text = sourceText.text;
    const isOcr = sourceText._ocr || false;
    if (isOcr) {
      console.log('[pdfImport] Document was scanned/image-based — used OCR to extract text');
      updateJob(jobId, { warning: 'This PDF was scanned/image-based. Text was extracted via OCR and may contain minor errors.' });
    }
    updateJob(jobId, { stage: 'Parsing questions…', progress: 10 });

    let blockWarning = '';
    const parsed = await ai.extractQuestionsFromText(
      text,
      (done, total) => {
        const pct = 10 + Math.round((done / Math.max(1, total)) * 45);
        updateJob(jobId, { stage: `Parsing questions… (${done}/${total})`, progress: pct });
      },
      (warning) => { blockWarning = warning; },
      { markers: sourceText.markers, mathMarkers: sourceText.mathExprs }
    );
    diag('question extraction', { jobId, questions: parsed.length,
      ...(sourceText.diagnostics || {}) });
    if (!parsed.length) {
      console.warn('[pdf-import] extraction produced no questions', { jobId });
      // Surface WHY. The wrong guess here sends the user hunting for a problem
      // in their PDF that isn't there: a paper that parses to nothing is
      // usually unreadable text (a scan), not a mis-formatted document.
      throw new Error(describeExtractionFailure({ text, isOcr, blockWarning }));
    }

    // Filter by type if the user selected only objectives or only theories
    let filtered = parsed;
    if (typeFilter) {
      filtered = parsed.filter((q) => typeFilter.includes(q.type));
      if (!filtered.length) {
        const want = typeFilter.join(' and ');
        throw new Error(
          `No ${want} questions found in this PDF. ` +
          `The document contained ${parsed.length} questions but none were ${want} type.`
        );
      }
      console.log(`[pdfImport] filtered ${parsed.length} → ${filtered.length} questions (type: ${typeFilter.join(',')})`);
      updateJob(jobId, { count: filtered.length });
    }

    // Estimate from the parseable (cleaned) text — the raw text still contains
    // the solutions/answer-key section, whose "1. B." lines would inflate the
    // count and produce a false "questions missing" warning.
    const warning = [
      ai.completenessWarning(ai.estimateQuestionCount(ai.cleanExamText(text)), filtered),
      blockWarning,
    ].filter(Boolean).join(' ');
    if (warning) updateJob(jobId, { warning });

    // Objective questions missing an answer key are sent to AI for answers.
    // This step is best-effort: a failure must not fail the whole import.
    const objQuestions = [];
    const missingAnswers = [];
    for (const g of filtered) {
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
        // Skip verification pass since we're only filling genuinely missing answers
        // (the PDF's own answer key answers were already spliced deterministically)
        const answers = await ai.answerObjectiveQuestions(missingAnswers, { skipVerify: true });
        for (const a of answers) answersMap[a.index] = a;
      } catch (err) {
        console.error('[pdfImport] answer fill failed (continuing):', err.message);
      }
    }

    updateJob(jobId, { stage: 'Saving questions…', progress: 62 });
    let nextOrder =
      (db.prepare('SELECT MAX(q_order) m FROM questions WHERE exam_id = ?').get(job.exam_id).m || 0) + 1;
    const insert = db.prepare(
      `INSERT INTO questions (exam_id, q_order, type, text, passage, options, correct_answer, marks, difficulty, learning_objective, explanation, source, image, section_key, source_number)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
    const pageCache = new Map();
    for (const g of filtered) {
      if (g.passage && String(g.passage).trim()) curPassage = stripSourceWatermarks(String(g.passage).trim());
      const passage = curPassage;
      g.text = stripSourceWatermarks(g.text);

      // Diagrams: render the figure this question kept via its marker and
      // store the file name (relative, served from uploads). Rendering is
      // best-effort: a raster/vector decode failure must never fail the
      // import — the question still exists, just without its figure.
      let imageFile = '';
      if (g.markerIndex != null && Number.isInteger(g.markerIndex)) {
        const entry = images[g.markerIndex];
        if (entry) {
          try {
            const dest = path.join(
              config.uploadsDir,
              imageFileNameFor(job.exam_id, nextOrder, g.markerIndex)
            );
            imageFile = path.basename(
              await (entry.kind === 'vector'
                ? pdf.renderVectorRegion(buffer, entry, dest)
                : pdf.renderImage(buffer, entry, dest))
            );
          } catch (e) {
            console.warn('[pdf-import] diagram attachment failed', { jobId, questionOrder: nextOrder,
              marker: `[IMG:${g.markerIndex}]`, page: entry.page });
            diag('diagram render error', { jobId, error: e.code || e.name });
          }
        } else {
          console.warn('[pdf-import] diagram marker has no image', { jobId, questionOrder: nextOrder,
            marker: `[IMG:${g.markerIndex}]` });
        }
      }

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
          correct, marks, g.difficulty || 'medium', g.learning_objective || '', explanation, 'pdf', imageFile,
          slugOf(g.section), Number(g.number) || 0
        );
        created.push(info.lastInsertRowid);
        savedRows.push(info.lastInsertRowid);
        await storeMathImages(g, info.lastInsertRowid, sourceText.mathExprs || [], pageCache, buffer, job.exam_id, nextOrder);
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
          parseFloat(g.marks) || 5, g.difficulty || 'medium', g.learning_objective || '', '', 'pdf', imageFile,
          slugOf(g.section), Number(g.number) || 0
        );
        const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(info.lastInsertRowid);
        created.push(q.id);
        savedRows.push(q.id);
        await storeMathImages(g, q.id, sourceText.mathExprs || [], pageCache, buffer, job.exam_id, nextOrder);
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
    // Theory scheme generation is one AI call per question; run up to 12 in
    // parallel (capped like the other bulk AI phases so a shared endpoint is
    // not flooded) instead of one at a time.
    const builtSchemes = await ai.mapLimit(tasks, 12, (run) => run());

    // buildMarkingScheme() deliberately never throws: when the AI is rate
    // limited or unavailable it persists a valid-looking but empty placeholder
    // scheme, which awards nothing when the paper is marked. Without counting
    // those the job reports a clean "done" over questions no examiner can mark,
    // which is exactly how a paper ends up looking like it has no usable
    // questions once it is sent.
    const emptySchemes = builtSchemes.filter((s) => !marking.schemeHasContent(s)).length;
    if (emptySchemes) {
      const msg = `${emptySchemes} of ${totalSchemes} theory question(s) have no marking scheme yet, so they will be marked by keyword heuristic only — review them before sending.`;
      // Appended defensively: anything thrown in this success path lands in the
      // catch block below, which deletes every question this job inserted. A
      // warning must never be able to destroy a good import.
      try {
        const prior = (getJob(jobId) || {}).warning;
        updateJob(jobId, { warning: [prior, msg].filter(Boolean).join(' ') });
      } catch (e) {
        console.error('[pdfImport] could not record marking-scheme warning:', e.message);
      }
    }

    // Selection rules last: every question row must exist before any claim about
    // those rows can be checked against what was really extracted.
    try {
      const out = applySelectionRules(
        job.exam_id,
        filtered,
        savedRows.map((id) => db.prepare('SELECT id, q_order, section_key, source_number FROM questions WHERE id = ?').get(id)),
        buildSectionMeta(filtered)
      );
      if (out.applied) updateJob(jobId, { stage: 'Applying selection rules…', progress: 68 });
    } catch (err) {
      // A rule we cannot read must never fail an otherwise good import.
      console.error('[pdfImport] selection rules failed (continuing):', err.message);
    }

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

/** "SECTION B" -> "section-b". Stable, so it matches what the admin sees. */
function slugOf(section) {
  return String(section || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Read the "answer any N of M" limit out of the section instruction the extractor
 * preserved on the first question of each section. The instruction text lands in
 * `passage` (see the SECTION INSTRUCTIONS prompt rule), so the count has to be
 * recovered from there; anything not recognised is simply left at 0, which means
 * answer-all and therefore no rule.
 */
function buildSectionMeta(questions) {
  const meta = {};
  for (const q of Array.isArray(questions) ? questions : []) {
    const section = String((q && q.section) || '').trim();
    if (!section || meta[section]) continue;
    const text = `${q.instructions || ''} ${q.passage || ''}`;
    // "Answer any TWO questions", "Answer TWO (2) questions", "Answer 2 questions".
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    // "Answer all FOUR", "Answer any TWO", "Answer 2" — `all`/`any` is filler, not
    // a count, and a word here must not be read as a digit.
    const byWord = text.match(/answer\s+(?:all\s+|any\s+)?(\w+)(?:\s*\(\d+\))?\s+(?:of\s+(?:the\s+)?\w+\s+)?questions?/i);
    const byDigit = text.match(/answer\s+(?:any\s+)?(\d+)\s+(?:of\s+(?:the\s+)?\w+\s+)?questions?/i);
    let count = 0;
    if (byDigit) count = parseInt(byDigit[1], 10);
    else if (byWord && words[String(byWord[1]).toLowerCase()]) count = words[String(byWord[1]).toLowerCase()];
    meta[section] = {
      title: section,
      instructions: String(q.instructions || ''),
      answer_count: count,
    };
  }
  return meta;
}

/**
 * Turn the extraction's per-question selection facts into stored rules.
 *
 * `questions` is the extraction array itself — the only shape this pipeline
 * actually returns. Section rules are DERIVED by grouping on each question's
 * `section`, and `sectionMeta` (title, instructions, answer_count, keyed by the
 * verbatim heading) supplies the wording. Every claim is checked against the rows
 * we actually saved:
 *
 *   - a compulsory question whose number never landed in the database is reported
 *     and dropped, because pointing at the wrong question is unrecoverable;
 *   - a count larger than the real pool is clamped;
 *   - a rule that ends up meaning "answer all" is not written at all, so the exam
 *     behaves exactly as it does today.
 */
function applySelectionRules(examId, questions, savedQuestions, sectionMeta = {}) {
  const list = Array.isArray(questions) ? questions : [];
  if (!list.length) return { applied: 0, skipped: [] };

  const saved = Array.isArray(savedQuestions) ? savedQuestions : [];
  // Keyed on the PRINTED number, which is what the paper said and what the model
  // echoed back. q_order is insertion order and drifts the moment a block drops.
  const bySourceNumber = new Map();
  for (const q of saved) {
    const n = Number(q.source_number);
    if (n) bySourceNumber.set(n, q);
  }

  const skipped = [];
  let applied = 0;

  // Group the extraction by section, keeping the model-declared compulsory flag.
  const groups = new Map();
  for (const q of list) {
    const section = String((q && q.section) || '').trim();
    if (!section) continue;
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section).push(q);
  }

  db.exec('BEGIN');
  try {
    let position = 0;
    for (const [section, members] of groups) {
      const key = slugOf(section);
      const inSection = saved.filter((q) => String(q.section_key || '') === key);

      // Compulsory questions in this section, matched on the printed number.
      const forcedIds = new Set();
      for (const q of members) {
        if (!q.compulsory) continue;
        const row = bySourceNumber.get(Number(q.number));
        if (row) forcedIds.add(row.id);
        else skipped.push(`${section}: compulsory question ${q.number} was not extracted`);
      }
      if (!inSection.length) {
        skipped.push(`${section}: no questions were saved for it`);
        continue;
      }

      // Write BOTH directions. is_compulsory defaults to 1, so a reconciliation
      // that only ever forces questions leaves the whole pool compulsory and
      // every quota silently collapses to answer-all.
      const setFlag = db.prepare('UPDATE questions SET is_compulsory = ? WHERE id = ?');
      for (const q of inSection) setFlag.run(forcedIds.has(q.id) ? 1 : 0, q.id);

      const meta = sectionMeta[section] || sectionMeta[key] || {};
      const pool = inSection.length - forcedIds.size;
      const want = Math.max(0, parseInt(meta.answer_count, 10) || 0);
      const count = Math.min(want, pool);
      if (count <= 0 || count >= pool) {
        skipped.push(`${section}: rule is answer-all, nothing to choose`);
        continue;
      }

      db.prepare(
        `INSERT INTO exam_sections(exam_id,section_key,title,instructions,position,answer_count)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(exam_id, section_key) DO UPDATE SET
           title=excluded.title, instructions=excluded.instructions,
           position=excluded.position, answer_count=excluded.answer_count`
      ).run(
        examId, key,
        String(meta.title || section),
        String(meta.instructions || ''),
        position++, count
      );
      applied++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  console.log(`[pdfImport] selection rules: applied ${applied}, skipped ${skipped.length}`, skipped);
  return { applied, skipped };
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
  recoverStaleJobs,
  buildOptions,
  correctKeyFor,
  imageFileNameFor,
  storeMathImages,
  describeExtractionFailure,
  slugOf,
  buildSectionMeta,
  applySelectionRules,
};
