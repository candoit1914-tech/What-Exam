const db = require('../db');
const pdf = require('./pdf');
const ai = require('./ai');
const marking = require('./marking');
const path = require('path');
const config = require('../config');
const { stripSourceWatermarks, stripPaperFurniture } = require('./textClean');

function diag(event, details) {
  if (process.env.PDF_DIAG === '1') console.log('[pdf-import:diag]', event, details);
}

// ── Import helpers ─────────────────────────────────────────────────────

const DROP_REASON_TEXT = {
  tooSmall: 'too small to be a figure',
  tooBig: 'bigger than a question figure',
  tooThin: 'lines or page rules',
  coveredByRaster: 'frames drawn around a photo',
  repeatingOrnament: 'page decorations repeated on several pages',
  textInsideBox: 'read as tables',
  nothingBelow: 'page headers with no question above them',
};

/**
 * One sentence saying how the figures went, appended to the import toast.
 * An import that found no figures otherwise looks exactly like one whose
 * figures were all filtered out — and "the diagrams did not come through" is
 * precisely the question this answers before anyone has to read a log: it
 * either reports what was attached or names the rule that rejected what the
 * page scan actually found.
 */
function figureSummary(diagnostics) {
  const figures = diagnostics && diagnostics.figures;
  if (!figures) return '';
  const pages = figures.pages || 0;
  const found = figures.kept || 0;
  const candidates = (figures.candidates && (figures.candidates.raster || 0) + (figures.candidates.vector || 0)) || 0;
  const vision = figures.visionRecovered || 0;
  if (found > 0) {
    const what = found === 1 ? 'image or diagram' : 'images or diagrams';
    const byAi = vision ? ` (${vision} of them located by the AI reading the page image)` : '';
    return `Found ${found} ${what} across ${pages} page${pages === 1 ? '' : 's'} and attached each to its question${byAi}.`;
  }
  if (!candidates) {
    return `No images or diagrams were found in this PDF (${pages} page${pages === 1 ? '' : 's'} scanned).`;
  }
  const reasons = Object.entries(figures.dropped || {})
    .filter(([, n]) => n > 0)
    .map(([key, n]) => `${n} ${DROP_REASON_TEXT[key] || key}`)
    .join(', ');
  return `No images or diagrams were attached: the page scan found ${candidates} candidate${candidates === 1 ? '' : 's'}, all rejected as ${reasons}.`;
}

/**
 * What actually reached the database — the sentence that decides whether the
 * student sees a picture at all.
 *
 * figureSummary reports what the page SCAN found, which is a different number
 * from what was ATTACHED: a marker the renderer could not turn into a file, or
 * a figure no extracted question references, leaves the note claiming
 * "attached each to its question" over a question that arrives bare in
 * WhatsApp. Everything here counts rows that exist now:
 *
 *   requested — [IMG:n] markers the saved questions kept,
 *   attached  — files actually rendered and stored for them,
 *   failures  — why the difference, in the renderer's own words.
 */
function attachmentSummary({ requested = 0, attached = 0, failures = [], diagnostics } = {}) {
  const figures = (diagnostics && diagnostics.figures) || {};
  const pages = figures.pages || 0;
  const kept = figures.kept || 0;
  const vision = figures.visionRecovered || 0;
  const byAi = vision ? ` (${vision} of them located by the AI reading the page image)` : '';
  const plural = (n) => (n === 1 ? 'image or diagram' : 'images or diagrams');
  const reasons = [...new Set((failures || []).map((f) => String(f).slice(0, 160)))].slice(0, 2).join('; ');

  if (requested === 0) {
    // The scan found figures, but not one of them sits inside a saved
    // question — the most confusing outcome of all, because figureSummary
    // would announce figures the student is never going to be shown.
    if (kept > 0) {
      return (
        `Found ${kept} ${plural(kept)} in this PDF, but no saved question references ${kept === 1 ? 'it' : 'them'}, ` +
        `so none were attached — ${kept === 1 ? 'that question reaches' : 'those questions reach'} the student ` +
        `${kept === 1 ? 'without its figure' : 'without their figures'}.`
      );
    }
    return figureSummary(diagnostics);
  }
  if (attached >= requested && attached > 0 && kept === requested) {
    return figureSummary(diagnostics) || `Found ${requested} ${plural(requested)} and attached each to its question.`;
  }
  if (attached >= requested && attached > 0) {
    return (
      `Attached ${attached} ${plural(attached)} to the questions that reference ${attached === 1 ? 'it' : 'them'}${byAi} ` +
      `(${kept} ${kept === 1 ? 'was' : 'were'} found in the PDF in total — the others belong to questions this import did not save).`
    );
  }
  if (attached > 0) {
    const missing = requested - attached;
    return (
      `Attached ${attached} of ${requested} ${plural(requested)} to their questions; ` +
      `${missing} could not be rendered (${reasons || 'the renderer produced no file'}) and ` +
      `${missing === 1 ? 'will reach the student without its figure' : 'will reach the student without their figures'}.`
    );
  }
  return (
    `Found ${requested} ${plural(requested)} but none could be rendered (${reasons || 'the renderer produced no file'}). ` +
    `Those questions will reach the student WITHOUT ${requested === 1 ? 'their figure' : 'their figures'} — ` +
    'check the server log for "diagram attachment failed".'
  );
}

// ── Vision rescue ──────────────────────────────────────────────────────
//
// The path scanner assembles figures out of what the PDF draws. Sometimes
// there is nothing to assemble — a figure the scanner cannot see, or one a
// filter was right to distrust — while the page text still tells the student
// to "study the diagram above". Only one thing on that page can resolve the
// contradiction: the page itself. AshnaAI is asked to POINT at the printed
// figure. It never draws, describes or invents one; every box it returns has
// to survive a size and ink check first, and a page it cannot read simply
// keeps the figure it never had.

// A figure word, and a word placing it on the page ("above", "shown",
// "labelled"). Both are needed: "photosynthesis" alone would send vision
// calls after every biology question.
const FIGURE_REF = /\b(?:figure|diagram|illustration|graph|chart|picture|photograph|drawing|plate)\b/i;
const FIGURE_REF_CONTEXT = /\b(?:above|below|shown|given|overleaf|opposite|labelled|labeled|study|examine|refer)\b/i;
// Budget: an import already spends many AI calls; this one only exists to
// rescue figures, so it never reads more than a few pages.
const VISION_PAGE_LIMIT = 3;

function pngSize(buf) {
  // PNG: 8-byte signature, 4-byte chunk length, "IHDR", then width/height.
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Pages that talk about a figure but yielded no figure to the scanner. */
function pagesMissingFigures(sourceText) {
  const rowsByPage = sourceText.rowsByPage || [];
  const withFigure = new Set((sourceText.images || []).map((i) => i.page));
  const out = [];
  rowsByPage.forEach((rows, p) => {
    const page = p + 1;
    if (withFigure.has(page)) return; // something was found here already
    const refs = (rows || []).filter((row) => {
      const line = String(row.line || '').trim();
      return line.length >= 8 && line.length <= 300 && FIGURE_REF.test(line) && FIGURE_REF_CONTEXT.test(line);
    });
    if (refs.length) out.push({ page, refs });
  });
  return out.slice(0, VISION_PAGE_LIMIT);
}

/** A box of blank paper is not a figure, however confidently it was boxed. */
async function boxHasInk(pagePng, box) {
  try {
    const sharp = require('sharp');
    const { data } = await sharp(pagePng)
      .extract({ left: box.x, top: box.y, width: box.w, height: box.h })
      // Flatten first: these pages are drawn onto a TRANSPARENT canvas, and an
      // untouched transparent pixel greyscales to 0 — indistinguishable from
      // black ink. Every blank patch would pass the ink check.
      .flatten({ background: '#ffffff' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let inked = 0;
    for (let i = 0; i < data.length; i++) if (data[i] < 245) inked++;
    return data.length > 0 && inked / data.length > 0.015;
  } catch (err) {
    diag('vision ink check failed', { error: err.code || err.name });
    return false;
  }
}

/**
 * Splice a vision-boxed figure into the extraction result: it becomes one more
 * entry in `images` (rendered by the same vector crop as any other region), its
 * marker lands INSIDE the question that pointed at it, and the diagnostics
 * count it. Returns false when no sensible anchor line could be found — a
 * marker nobody can place would attach to the wrong question, which is worse
 * than no figure at all.
 */
function attachVisionFigure(sourceText, page, box, refs) {
  // Anchor inside the QUESTION that pointed at the figure: a marker line only
  // attaches to the question whose block it falls into, so prefer a reference
  // row that opens a question, and otherwise the last reference row (the one
  // below the figure, which is where papers put "study the diagram above").
  const anchor = refs.find((r) => /^\s*\d{1,3}\s*[.)]/.test(r.line)) || refs[refs.length - 1];
  const anchorText = String((anchor && anchor.line) || '').trim();
  if (!anchorText) return false;
  const lines = String(sourceText.text || '').split('\n');
  let at = -1;
  for (let j = 0; j < lines.length; j++) {
    if (lines[j].includes(anchorText) || (lines[j].length > 20 && anchorText.includes(lines[j]))) { at = j + 1; break; }
  }
  if (at < 0) return false;
  if (!sourceText.images) sourceText.images = [];
  const idx = sourceText.images.length;
  sourceText.images.push({ page, x: box.x, y: box.y, w: box.w, h: box.h, kind: 'vector' });
  lines.splice(at, 0, `[IMG:${idx}]`);
  sourceText.text = lines.join('\n');
  sourceText.markers = (sourceText.markers || []).concat({ idx, page }).sort((a, b) => a.idx - b.idx);
  return true;
}

/**
 * Locate figures the page scanner missed, on the pages whose own text says
 * there is one. Bounded (a few pages), best-effort (never throws into the
 * import), and counted so the admin's import note can say the AI found them.
 * Returns how many figures were recovered.
 */
async function recoverFiguresWithVision(buffer, sourceText) {
  const recovered = { count: 0 };
  try {
    if (!config.ai.vision || !ai.aiConfigured()) return 0;
    const pending = pagesMissingFigures(sourceText);
    if (!pending.length) return 0;
    for (const { page, refs } of pending) {
      const pagePng = await pdf.renderPageToBuffer(buffer, page, 1, { text: true });
      const size = pngSize(pagePng);
      if (!size) continue;
      const hint = refs.map((r) => r.line).join('\n').slice(0, 400);
      const boxes = await ai.locateFigures({
        imageBase64: pagePng.toString('base64'),
        pageWidth: size.width,
        pageHeight: size.height,
        hint,
      });
      const taken = [];
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        // Two boxes on top of each other are the same figure reported twice.
        if (taken.some((b) => Math.abs(b.x - box.x) < 10 && Math.abs(b.y - box.y) < 10)) continue;
        if (!(await boxHasInk(pagePng, box))) continue;
        const attached = attachVisionFigure(sourceText, page, box, refs);
        if (!attached) continue;
        taken.push(box);
        recovered.count++;
      }
      if (taken.length) diag('vision figure recovery', { page, boxes: taken.length, refs: refs.length });
    }
  } catch (err) {
    // The rescue is worth nothing if it can break an import that was otherwise
    // going to produce questions with, at worst, no figures.
    console.warn('[pdfImport] vision figure recovery failed', { error: err && err.message });
  }
  if (recovered.count && sourceText.diagnostics && sourceText.diagnostics.figures) {
    sourceText.diagnostics.figures.visionRecovered = recovered.count;
    sourceText.diagnostics.figures.kept = sourceText.images.length;
    sourceText.diagnostics.figures.keptByPage = sourceText.images.map((i) => `p${i.page}:${i.kind}`);
  }
  return recovered.count;
}

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
 * The [IMG:n] markers a question kept, in document order, deduped and
 * validated. `figureIndices` is the full set; `markerIndex` is the first one
 * and is always included, so a question imported before this field existed
 * (or by a caller that only ever wrote the single field) still renders.
 */
function figureMarkersFor(g) {
  const all = [
    ...(Array.isArray(g.figureIndices) ? g.figureIndices : []),
    ...(g.markerIndex != null ? [g.markerIndex] : []),
  ];
  return [...new Set(all.filter((i) => Number.isInteger(i) && i >= 0))].sort((a, b) => a - b);
}

/** How many bubbles a question asks for, figures + maths expressions. */
function mathMarkerCount(g) {
  return Array.isArray(g.markerIndices) ? new Set(g.markerIndices).size : 0;
}

/**
 * Render every math expression a question kept (g.markerIndices) and store it
 * as a question_images row with increasing position, so WhatsApp can send the
 * bubbles in reading order above the question text. Best-effort: a render
 * failure logs and skips that bubble — the question still imports.
 * `mathExprs` is the document-global expression list from textWithMarkers;
 * `pageCache` renders each page at most once. `positionOffset` is where this
 * batch starts in the question's bubble list — figures are stored first, so
 * the maths rows continue behind them instead of colliding on the same
 * position.
 */
async function storeMathImages(g, questionId, mathExprs, pageCache, buffer, examId, qOrder, positionOffset = 0) {
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
        .run(questionId, positionOffset + result.attached, image);
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

/**
 * Persist a question's whole bubble list: its figures first (when the
 * question needs more than one bubble — see the import loop), then its maths
 * expressions behind them. They share ONE position sequence because delivery
 * walks `ORDER BY position` and must never show an expression above the
 * diagram it explains. Best-effort throughout: a failure logs and the
 * question still imports without that bubble.
 */
async function storeQuestionImages(questionId, figureFiles, g, mathExprs, pageCache, buffer, examId, qOrder) {
  let stored = 0;
  for (const image of figureFiles) {
    try {
      db.prepare(`INSERT INTO question_images (question_id, position, image, kind) VALUES (?,?,?, 'figure')`)
        .run(questionId, stored, image);
      stored++;
    } catch (e) {
      console.warn('[pdf-import] figure attachment failed', { questionId, error: e.code || e.name });
      diag('figure attachment failed', { questionId, error: e.code || e.name });
    }
  }
  if (stored) diag('figure attachments', { questionId, attached: stored });
  return storeMathImages(g, questionId, mathExprs, pageCache, buffer, examId, qOrder, stored);
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
    // Pages whose own text tells the student to study a figure, but which gave
    // the scanner nothing to assemble, get one chance with AshnaAI's vision:
    // point at what is already printed on the page. It runs before anything
    // reads sourceText.text/images/markers, so a rescued figure travels through
    // extraction exactly like a geometrically found one.
    const visionRecovered = await recoverFiguresWithVision(buffer, sourceText);
    if (visionRecovered) {
      console.log(`[pdfImport] vision located ${visionRecovered} figure(s) the page scan missed`);
    }
    // textWithMarkers already calls analyzeDocument internally which includes
    // the image list. Use that instead of a second extractDocument call.
    const images = sourceText.images || [];
    const text = sourceText.text;
    const isOcr = sourceText._ocr || false;
    const warnings = [];
    if (isOcr) {
      console.log('[pdfImport] Document was scanned/image-based — used OCR to extract text');
      warnings.push('This PDF was scanned/image-based. Text was extracted via OCR and may contain minor errors.');
      updateJob(jobId, { warning: warnings.join(' ') });
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
    // count and produce a false "questions missing" warning. The estimate
    // counts EVERY question in the document, so a paper the admin filtered to
    // one type is compared against everything that was parsed: measuring the
    // filtered subset against the whole document would cry "questions missing"
    // over a filter the admin chose on purpose.
    //
    // The figure note is deliberately NOT written here: at this point nothing
    // has been rendered yet, so a sentence saying the figures were attached
    // would be a promise, not a report. attachmentSummary() writes it once the
    // files really exist (or really do not).
    const warning = [
      ai.completenessWarning(
        ai.estimateQuestionCount(ai.cleanExamText(text)),
        typeFilter ? parsed : filtered
      ),
      blockWarning,
    ].filter(Boolean).join(' ');
    const jobWarning = [...warnings, warning].filter(Boolean).join(' ');
    if (jobWarning) updateJob(jobId, { warning: jobWarning });

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
      `INSERT INTO questions (exam_id, q_order, type, text, passage, options, correct_answer, marks, difficulty, learning_objective, explanation, source, image, section_key, source_number, follow_ups)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
    // Figures this import was asked to attach, how many really got a file, and
    // why the two numbers differ. Nothing here is inferred from the scan: these
    // are rows that exist (or do not) once the loop is done.
    let figureRequested = 0;
    let figureAttached = 0;
    const figureFailures = [];
    for (const g of filtered) {
      // Paper furniture (running header, paper title, time/marks lines, the
      // printed INSTRUCTIONS block, "Question 1 [40 marks]") is stripped from
      // the ROWS that reach WhatsApp and the dashboard. Only the stored copies
      // are cleaned: g.passage stays raw on purpose, because buildSectionMeta
      // reads it later for the "answer any THREE of the five" rule, and that
      // rule lives in exactly the lines being dropped here.
      if (g.passage && String(g.passage).trim()) {
        curPassage = stripPaperFurniture(stripSourceWatermarks(String(g.passage).trim()));
      }
      const passage = curPassage;
      g.text = stripPaperFurniture(stripSourceWatermarks(g.text));

      // Diagrams: render EVERY figure this question kept via its markers and
      // store the file names (relative, served from uploads). The first goes
      // into questions.image — the single-image column the dashboard and the
      // report have always read — and a question that needs more than one
      // bubble stores the full set as question_images rows, so delivery never
      // has to choose which of its figures the student gets to see. Rendering
      // is best-effort: a raster/vector decode failure must never fail the
      // import — the question still imports, just without that figure.
      const figureMarkers = figureMarkersFor(g);
      const figureFiles = [];
      figureRequested += figureMarkers.length;
      for (const markerIndex of figureMarkers) {
        const dest = path.join(
          config.uploadsDir,
          imageFileNameFor(job.exam_id, nextOrder, markerIndex)
        );
        const entry = images[markerIndex];
        if (!entry) {
          console.warn('[pdf-import] diagram marker has no image', { jobId, questionOrder: nextOrder,
            marker: `[IMG:${markerIndex}]` });
          figureFailures.push(`[IMG:${markerIndex}] pointed at no image on the page`);
          continue;
        }
        try {
          figureFiles.push(path.basename(
            await (entry.kind === 'vector'
              ? pdf.renderVectorRegion(buffer, entry, dest)
              : pdf.renderImage(buffer, entry, dest))
          ));
        } catch (e) {
          console.warn('[pdf-import] diagram attachment failed', { jobId, questionOrder: nextOrder,
            marker: `[IMG:${markerIndex}]`, page: entry.page, error: e.message || e.code || e.name });
          diag('diagram render error', { jobId, error: e.code || e.name });
          // Named in the import note, not just the log: this is the moment a
          // student's diagram quietly disappears, and the admin's only other
          // clue would be a question that arrives in WhatsApp with nothing
          // above it.
          figureFailures.push(`${path.basename(dest)}: ${e.message || e.code || e.name}`);
        }
      }
      figureAttached += figureFiles.length;
      const imageFile = figureFiles[0] || '';
      // One bubble rides in questions.image alone (exactly as before); a
      // question carrying several — two figures, or a figure beside a maths
      // expression — stores them all as rows in reading order, figures first.
      const extraBubbles = figureFiles.length + mathMarkerCount(g);
      const figureRowFiles = figureFiles.length && extraBubbles > 1 ? figureFiles : [];

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
          slugOf(g.section), Number(g.number) || 0, '[]'
        );
        created.push(info.lastInsertRowid);
        savedRows.push(info.lastInsertRowid);
        await storeQuestionImages(info.lastInsertRowid, figureRowFiles, g, sourceText.mathExprs || [], pageCache, buffer, job.exam_id, nextOrder);
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
          slugOf(g.section), Number(g.number) || 0,
          // The limbs the extractor folded back under this number (1a, 1b…).
          // They are what the chat prints under the stem and what the marking
          // scheme is built from, so dropping them here would leave a
          // question the student cannot fully answer or be marked on.
          JSON.stringify(ai.normalizeFollowUps(g.follow_ups))
        );
        const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(info.lastInsertRowid);
        created.push(q.id);
        savedRows.push(q.id);
        await storeQuestionImages(q.id, figureRowFiles, g, sourceText.mathExprs || [], pageCache, buffer, job.exam_id, nextOrder);
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

    // Written only now, when every render has happened and "attached" counts
    // files that exist. Appended rather than set, so an OCR note or a
    // completeness warning from earlier survives.
    const figureNote = attachmentSummary({
      requested: figureRequested,
      attached: figureAttached,
      failures: figureFailures,
      diagnostics: sourceText.diagnostics,
    });
    if (figureNote) {
      const prior = (getJob(jobId) || {}).warning;
      updateJob(jobId, { warning: [prior, figureNote].filter(Boolean).join(' ') });
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
 * The one section a paper with no headings is given, so its "answer any N"
 * limit has a key to be stored under — exam_sections points at a key, and a
 * missing key is how a limit silently became answer-all.
 */
const PAPER_SECTION_KEY = 'paper';

/**
 * Read "how many of these must be answered" out of a section instruction.
 *
 * The extractor keeps those instructions in `passage` (see the SECTION
 * INSTRUCTIONS prompt rule), so the count has to be recovered from prose —
 * there is no structured field. Real papers word it every way there is:
 * "Answer any THREE questions", "Answer 2 questions", "Answer only three of
 * the five questions", "Answer 3 out of 5", "Attempt ONE question", "Choose
 * TWO questions to answer". Anything not recognised returns 0, which means
 * answer-all and therefore no rule.
 */
function answerCountFrom(raw) {
  const text = String(raw || '');
  const words = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20,
  };
  const toNum = (value) => (/^\d+$/.test(value) ? parseInt(value, 10) : words[String(value).toLowerCase()] || 0);
  // `all` / `any` / `only` / `the` / `a` are filler, never a count, and a word
  // that is not in the map must not be read as a number.
  const patterns = [
    // "Answer any 3 of the 5 questions", "Answer 3 out of 5 questions",
    // "Answer TWO of the FIVE questions" — the count asked for comes first.
    /\b(?:answer|attempt|choose|select|pick)\b[^.?!]{0,40}?\b(\d{1,2}|[a-z]+)(?:\s*\(\d+\))?\s+(?:out\s+of|of)\s+(?:the\s+)?\b(?:\d{1,2}|[a-z]+)\b/i,
    // "Answer only THREE questions", "Answer 2 questions", "Attempt ONE question".
    /\b(?:answer|attempt|choose|select|pick)\s+(?:all\s+|any\s+|only\s+|the\s+|a\s+)?(\d{1,2}|[a-z]+)(?:\s*\(\d+\))?\s+questions?\b/i,
    // The count without a verb in front of it: "3 of the 5 questions".
    /\b(\d{1,2})\s+(?:out\s+of|of)\s+(?:the\s+)?(?:\d{1,2})\s+questions?\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const count = toNum(match[1]);
    if (count > 0) return count;
  }
  return 0;
}

/**
 * Build the per-section rule facts from the extraction's own questions.
 *
 * Sections are keyed on the heading the model returned verbatim. A paper with
 * NO headings at all still carries its limit on the first question, so that
 * case is returned under the empty key instead of being dropped — dropping it
 * is what left a headingless paper with no way to ever offer a choice.
 */
function buildSectionMeta(questions) {
  const list = Array.isArray(questions) ? questions : [];
  const meta = {};
  const anySection = list.some((q) => String((q && q.section) || '').trim());

  const factsFor = (q) => ({
    title: String((q && q.section) || '').trim(),
    instructions: String((q && q.instructions) || ''),
    answer_count: answerCountFrom(`${(q && q.instructions) || ''} ${(q && q.passage) || ''}`),
  });

  if (!anySection) {
    const entries = list.filter(Boolean).map(factsFor);
    if (entries.length) {
      // The instruction may sit on any question, and only one that states a
      // count matters; the first is kept when none does.
      meta[''] = entries.find((e) => e.answer_count > 0) || entries[0];
    }
    return meta;
  }

  for (const q of list) {
    const section = String((q && q.section) || '').trim();
    if (!section) continue;
    const facts = factsFor(q);
    const prev = meta[section];
    // The first question of a section carries its instructions, but extraction
    // sometimes hangs them on a later one: keep the first's wording, and take
    // the count from whichever question actually states one.
    if (!prev) {
      meta[section] = facts;
    } else if (prev.answer_count === 0 && facts.answer_count > 0) {
      meta[section] = {
        title: prev.title,
        instructions: facts.instructions || prev.instructions,
        answer_count: facts.answer_count,
      };
    }
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
 *   - a count larger than the section is clamped (the count includes its
 *       compulsory questions, so it is priced against all of them);
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
  // A paper with no headings at all still states its limit — "Answer any
  // THREE questions" sits on the first question. Without a key for
  // exam_sections to point at, that limit could never be stored and the paper
  // silently answered every question instead of offering a choice, so those
  // questions are given one shared section.
  const paperMeta = sectionMeta[''] || sectionMeta[PAPER_SECTION_KEY];
  if (!groups.size && paperMeta && Math.max(0, parseInt(paperMeta.answer_count, 10) || 0) > 0) {
    groups.set(PAPER_SECTION_KEY, list);
  }

  db.exec('BEGIN');
  try {
    let position = 0;
    for (const [section, members] of groups) {
      const isPaper = section === PAPER_SECTION_KEY;
      const key = isPaper ? PAPER_SECTION_KEY : slugOf(section);
      if (isPaper) {
        // Retag the rows so the rule, the drawn snapshot and the selector all
        // speak about the same section.
        db.prepare(
          "UPDATE questions SET section_key = ? WHERE exam_id = ? AND (section_key IS NULL OR section_key = '')"
        ).run(key, examId);
        for (const row of saved) {
          if (!String(row.section_key || '').trim()) row.section_key = key;
        }
      }
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

      const meta = isPaper
        ? paperMeta
        : (sectionMeta[section] || sectionMeta[key] || {});
      // The count is the paper's own — "answer any FOUR questions" counts the
      // compulsory ones, so it is priced against the WHOLE section. Pricing the
      // same 4 against the three questions that are left to choose would cover
      // the entire pool, read as answer-all and hand the student all five.
      const total = inSection.length;
      const want = Math.max(0, parseInt(meta.answer_count, 10) || 0);
      const count = Math.min(want, total);
      if (count <= 0 || count >= total) {
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
        String(meta.title || (isPaper ? 'Paper' : section)),
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
  figureSummary,
  attachmentSummary,
  recoverFiguresWithVision,
  slugOf,
  PAPER_SECTION_KEY,
  answerCountFrom,
  buildSectionMeta,
  applySelectionRules,
};
