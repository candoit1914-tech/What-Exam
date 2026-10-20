const db = require('../db');
const pdf = require('./pdf');
const ai = require('./ai');
const marking = require('./marking');
const selection = require('./selection');
const path = require('path');
const config = require('../config');
const { stripSourceWatermarks, stripPaperFurniture } = require('./textClean');
const { PAPER_I_KEY, PAPER_II_KEY, slugOf, sectionKeyFor, paperIITitle } = require('./paper');

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
 * @param {{text?: string, isOcr?: boolean, blockWarning?: string, noun?: string}} input
 * @returns {string}
 */
function describeExtractionFailure({ text, isOcr, blockWarning, noun = 'PDF' } = {}) {
  // This branch is for a TIMEOUT, so it must not claim documents that were
  // simply unreadable. The empty-text extractor reports its own warning, which
  // arrives here as `blockWarning`; checking `blockWarning` alone relabelled an
  // unreadable scan as "the AI provider did not answer in time" - the exact
  // misleading message this function exists to replace. Unreadable text is
  // handled by the branch below.
  if (blockWarning && String(text || '').trim()) {
    // When the extractor already named the real cause ("The cause: the AI
    // provider answered but returned no questions"), appending the timeout
    // guess would contradict it. For a warning that names no cause, the
    // timeout guess is what it has always been.
    const namesCause = /the cause:/i.test(blockWarning);
    return (
      `No questions could be parsed from this ${noun}. ` +
      blockWarning +
      (namesCause
        ? ' Try again — the same paper usually imports on a second attempt.'
        : ' The AI provider did not answer in time — try again, or raise AI_BLOCK_TIMEOUT_MS if it keeps happening.')
    );
  }
  // Nothing readable at all. Either OCR ran and could not read the page
  // images, or the document had no usable text layer.
  if (!String(text || '').trim()) {
    return isOcr
      ? `No readable text could be extracted from this ${noun}. It appears to be a scan, and OCR could not read the page images clearly enough to work with. Try a higher-resolution scan, or export the PDF from the original document rather than photographing it.`
      : `No readable text could be extracted from this ${noun}, so there was nothing to build questions from. This usually means the pages are images or a scan that needs clearer imaging — try re-exporting the PDF from the original document.`;
  }
  // There was plenty of readable text; it simply was not an exam paper.
  return 'The document may not contain exam questions in a recognizable format.';
}

// ── Instructions are not questions ─────────────────────────────────────
//
// A paper prints directives — "Answer all questions in this section",
// "INSTRUCTIONS: ...", "Each question carries 20 marks", "SECTION B" — and the
// extractor can hand one back as its own entry, which would be saved as a
// question and asked of a student. Two of those forms are already removed
// line-by-line by stripPaperFurniture; what is left here is everything the
// furniture pass deliberately keeps (it only drops the narrowest forms, because
// a real stem can read like an instruction).
//
// A stem counts as a directive when the WHOLE of it reads like one. Each form
// below is a line a paper uses to address the candidate rather than to ask them
// something, and none of them is a question a student could answer.

const DIRECTIVE_PATTERNS = [
  // The paper addressing the candidate: "INSTRUCTIONS:", "Note:", "N.B.:".
  /^(?:instructions?|notes?|directions?|remarks?|guidance|n\.?b\.?)\s*[:：]/i,
  // The quota lines: "Answer all questions in this section", "Attempt THREE
  // questions", "Choose ONE question", "Do not answer more than two".
  /^(?:answer|attempt|choose|select|pick|tick|shade|circle|ring|cross\s+out)\s+(?:all|any|each|only|both|one|two|three|four|five|six|seven|eight|nine|ten|following|more\s+than|not\s+more\s+than|up\s+to|the\s+(?:following|questions?|one|ones)|questions?|your\s+answers?)\b/i,
  // A line handing the reader to questions printed elsewhere on the paper:
  // "answer questions 1 to 5", "the questions that follow".
  /\bquestions?\s+\d+\s*(?:-|–|to|and|&)\s*\d+\b/i,
  /\bquestions?\s+that\s+follow/i,
  /\bquestion\s+that\s+follows\b/i,
  // Headings printed where a question would be: "SECTION B", "PART II",
  // "OBJECTIVE TEST". A heading never has a verb, a number or a question mark.
  /^(?:section|part|paper|unit|chapter|module)\s+(?:[a-z]{1,4}\d*|\d{1,2}|[ivx]{1,4})(?:\s*[:：]\s*[^.?!]*)?$/i,
  /^(?:objective|theory|essay|composition|comprehension|multiple\s+choice)\s*(?:test|paper|section|questions?|task)?\s*[:：.]?$/i,
  // Paper logistics a candidate reads but never answers.
  /^(?:each|every)\s+question\s+carries?\b/i,
  /^(?:total\b[^.?!]{0,30}\bmarks?\b|marks?\s*[:·])/i,
  /^(?:do\s+not|don'?t|ensure|remember|note\s+that)\b/i,
  /^(?:write|shade|use|place|record)\s+(?:your|the|all)\s+answers?\b/i,
  /\banswer\s+(?:sheet|booklet|grid|paper)\b/i,
  /^(?:this|the)\s+(?:paper|question\s+paper|section|test)\s+(?:consists|contains|is\s+divided)\b/i,
];

// The verbs a real TASK opens with. When an instruction block ends in one
// ("Answer the following question in about 300 words: Write a letter…", or
// "Answer all questions in this section. Write a letter to your father."), the
// task in the tail is the content and the entry must survive.
const TASK_VERBS =
  /^(?:write|describe|explain|define|discuss|translate|summaris|summariz|comment|calculate|solve|identify|outline|draw|list|mention|determine|find|compute|suggest|recommend|examine|argue|what|why|how|when|where|who|which)\b/i;

/**
 * Does this stem talk TO the candidate instead of asking them something?
 *
 * The whole stem has to read like a directive; a real question wrapped in one
 * line of instruction keeps its content:
 *   - a stem that ends by asking something is a question;
 *   - a colon that opens onto a task ("…300 words: Write a letter…") keeps the
 *     tail, unless the tail is a directive itself ("Note: attempt only three");
 *   - when the stem is several sentences, the LAST one decides — an instruction
 *     block may end with the task it was setting up.
 */
function looksLikeDirective(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return true;
  if (/[?]\s*$/.test(text)) return false; // it asks something

  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const tail = sentences[sentences.length - 1] || text;
  if (sentences.length > 1 && tail.split(/\s+/).length >= 4 && TASK_VERBS.test(tail)) return false;

  const colonAt = text.search(/[:：]/);
  if (colonAt >= 0 && colonAt < text.length - 1) {
    const after = text.slice(colonAt + 1).replace(/\s+/g, ' ').trim();
    if (after.split(/\s+/).length >= 4 && !DIRECTIVE_PATTERNS.some((re) => re.test(after))) return false;
  }
  return DIRECTIVE_PATTERNS.some((re) => re.test(text));
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
  // Every upload converges on the same pipeline; only the reader differs. A
  // PDF is read by the page scanner (figures, markers, OCR), .txt/.docx/.xlsx
  // arrive as plain exam text, and .json arrives as questions someone already
  // structured — those are imported verbatim instead of re-parsed by the model.
  const source = opts.source || { format: 'pdf' };
  const isPdf = source.format === 'pdf';
  const isImported = Array.isArray(source.questions);
  const noun = isPdf ? 'PDF' : 'file';
  updateJob(jobId, { status: 'running', stage: isPdf ? 'Reading PDF…' : 'Reading file…', progress: 2 });

  const created = [];
  // Every question row this job wrote, as ids. applySelectionRules re-reads them
  // so its claims are checked against what was really saved, not against what the
  // model claimed.
  const savedRows = [];
  try {
    let sourceText;
    if (isImported) {
      // Authored questions: no page to scan and no text to parse — the file
      // already IS the questions, so only the shape of the pipeline's input
      // needs filling in (no figures, no markers, no OCR).
      sourceText = { text: '', images: [], markers: [], mathExprs: [], rowsByPage: [], diagnostics: {} };
    } else if (isPdf) {
      try {
        sourceText = await pdf.textWithMarkers(buffer);
      } catch (err) {
        // The DOCUMENT could not be opened — never a figure problem (those
        // degrade to notes), so it must fail, but in words the admin can act
        // on. pdfjs' raw "Invalid PDF structure"/"PasswordException" is what
        // used to vanish into a toast with nothing to search for.
        const detail = String((err && err.message) || err || '').trim().replace(/[.\s]+$/, '');
        throw new Error(
          `This PDF could not be read${detail ? ` (${detail})` : ''}. ` +
          'It may be password-protected, damaged, or not really a PDF — export it again ' +
          '(or print to PDF from the original document) and re-upload.'
        );
      }
      // Pages whose own text tells the student to study a figure, but which gave
      // the scanner nothing to assemble, get one chance with AshnaAI's vision:
      // point at what is already printed on the page. It runs before anything
      // reads sourceText.text/images/markers, so a rescued figure travels through
      // extraction exactly like a geometrically found one.
      const visionRecovered = await recoverFiguresWithVision(buffer, sourceText);
      if (visionRecovered) {
        console.log(`[pdfImport] vision located ${visionRecovered} figure(s) the page scan missed`);
      }
    } else {
      // .txt/.docx/.xlsx: already exam text, read by document.readExamSource.
      sourceText = {
        text: String(source.text || ''),
        images: [], markers: [], mathExprs: [], rowsByPage: [], diagnostics: {},
      };
      if (!sourceText.text.trim()) {
        throw new Error(
          `No readable text could be extracted from this file, so there was nothing to build questions from. ` +
          `Check that the ${noun} is an exam paper with numbered questions.`
        );
      }
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
    }
    // What the page scanner could not do, kept in the import note rather than
    // only in a server log nobody opens: a skipped page loses its questions, a
    // page whose diagram geometry refused to read loses only its diagrams, a
    // dead figure filter loses only figures. Each is a different thing to act
    // on — and none of them is a reason to fail an import that can still
    // produce questions.
    const scan = (sourceText.diagnostics && sourceText.diagnostics.figures) || {};
    if (Array.isArray(scan.failedPages) && scan.failedPages.length) {
      const n = scan.failedPages.length;
      warnings.push(
        `${n === 1 ? 'Page' : 'Pages'} ${scan.failedPages.join(', ')} could not be parsed and ` +
        `${n === 1 ? 'was' : 'were'} skipped — any questions printed only on ` +
        `${n === 1 ? 'that page' : 'those pages'} are missing from this import. ` +
        `Re-upload ${n === 1 ? 'that page as a scan to recover it' : 'those pages as scans to recover them'}.`
      );
    }
    if (Array.isArray(scan.figureScanFailedPages) && scan.figureScanFailedPages.length) {
      const n = scan.figureScanFailedPages.length;
      warnings.push(
        `Diagram scanning failed on ${n === 1 ? 'page' : 'pages'} ${scan.figureScanFailedPages.join(', ')}; ` +
        `${n === 1 ? 'that page was' : 'those pages were'} imported without ${n === 1 ? 'its' : 'their'} diagrams.`
      );
    }
    if (scan.selectionError) {
      warnings.push(
        'The diagram filter could not run on this PDF, so no diagrams were attached — ' +
        'the questions themselves imported normally.'
      );
    }
    if (warnings.length) updateJob(jobId, { warning: warnings.join(' ') });
    updateJob(jobId, { stage: 'Parsing questions…', progress: 10 });

    let blockWarning = '';
    // An imported JSON already holds its questions in final shape: running it
    // through the model would re-parse (and risk corrupting) work someone
    // already did correctly, so the authored rows go straight through.
    const parsed = isImported
      ? source.questions
      : await ai.extractQuestionsFromText(
          text,
          (done, total) => {
            const pct = 10 + Math.round((done / Math.max(1, total)) * 45);
            updateJob(jobId, { stage: `Parsing questions… (${done}/${total})`, progress: pct });
          },
          // APPENDED, not overwritten: the last warning used to replace the
          // one before it, so a secondary note ("3 diagrams could not be
          // matched") hid the primary one ("N blocks could not be parsed —
          // cause: timed out") and the failure message was built on the wrong
          // warning entirely.
          (warning) => { blockWarning = [blockWarning, warning].filter(Boolean).join(' '); },
          { markers: sourceText.markers, mathMarkers: sourceText.mathExprs }
        );
    if (isImported) {
      console.log(`[pdfImport] imported ${parsed.length} authored question(s) from JSON (no parsing needed)`);
      updateJob(jobId, { stage: 'Saving questions…', progress: 55 });
    }
    diag('question extraction', { jobId, questions: parsed.length,
      ...(sourceText.diagnostics || {}) });
    if (!parsed.length) {
      console.warn('[pdf-import] extraction produced no questions', { jobId });
      // Surface WHY. The wrong guess here sends the user hunting for a problem
      // in their PDF that isn't there: a paper that parses to nothing is
      // usually unreadable text (a scan), not a mis-formatted document.
      throw new Error(describeExtractionFailure({ text, isOcr, blockWarning, noun }));
    }

    // Filter by type if the user selected only objectives or only theories
    let filtered = parsed;
    if (typeFilter) {
      filtered = parsed.filter((q) => typeFilter.includes(q.type));
      if (!filtered.length) {
        const want = typeFilter.join(' and ');
        throw new Error(
          `No ${want} questions found in this ${noun}. ` +
          `The document contained ${parsed.length} questions but none were ${want} type.`
        );
      }
      console.log(`[pdfImport] filtered ${parsed.length} → ${filtered.length} questions (type: ${typeFilter.join(',')})`);
      updateJob(jobId, { count: filtered.length });
    }

    // An INSTRUCTION is not a question. The paper prints directives — "Answer
    // all questions in this section", "INSTRUCTIONS: ...", "SECTION B" — that
    // the extractor hands back as if they were questions. Two things must
    // happen to such an entry before anything else runs:
    //
    //   - it is DROPPED, unless it still carries real limbs (a comprehension
    //     heading whose parts are the actual content);
    //   - the passage it introduced is NOT lost with it: reading papers carry
    //     the passage on the line in front of the questions, so the passage is
    //     handed to the next real question instead of dying with the directive.
    //
    // stripPaperFurniture already reduces the narrowest directive forms to an
    // EMPTY string; looksLikeDirective catches the rest of them. This runs
    // BEFORE the answer-key pass so objective indexing stays aligned.
    const beforeInstructionFilter = filtered.length;
    const realQuestions = [];
    let orphanPassage = '';
    for (const q of filtered) {
      const cleaned = stripPaperFurniture(stripSourceWatermarks(String(q.text || '')));
      const limbs = Array.isArray(q.follow_ups) ? q.follow_ups.filter((f) => f && f.text) : [];
      const keep = limbs.length > 0 || (Boolean(cleaned.trim()) && !looksLikeDirective(cleaned));
      if (!keep) {
        const carried = String((q && q.passage) || '').trim();
        if (carried && !orphanPassage) orphanPassage = carried;
        continue;
      }
      if (orphanPassage) {
        // The instruction's own group is the one it introduced: give the
        // passage to its first question, and drop it if that question already
        // has a passage of its own rather than pasting two groups together.
        if (!String((q && q.passage) || '').trim()) q.passage = orphanPassage;
        orphanPassage = '';
      }
      realQuestions.push(q);
    }
    filtered = realQuestions;
    const droppedInstructions = beforeInstructionFilter - filtered.length;
    if (droppedInstructions > 0) {
      console.log(`[pdfImport] dropped ${droppedInstructions} instruction line(s) parsed as questions`);
      updateJob(jobId, { count: filtered.length });
    }
    // If the extractor handed back NOTHING but instructions, importing an empty
    // paper would be worse than failing loudly: the admin needs to know the
    // document had no real questions to extract.
    if (!filtered.length) {
      throw new Error(
        `No real questions could be extracted from this ${noun} — every entry the parser returned was an instruction line. ` +
        'Check that the upload is an exam paper with numbered questions.'
      );
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
          correct, marks, g.difficulty || 'medium', g.learning_objective || '', explanation, source.format, imageFile,
          // Paper I: every objective of the exam lives under one key, whatever
          // heading the PDF printed it under, so objectives and theory can
          // never end up in the same ruled section.
          PAPER_I_KEY, Number(g.number) || 0, '[]'
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
          parseFloat(g.marks) || 5, g.difficulty || 'medium', g.learning_objective || '', '', source.format, imageFile,
          // Paper II, under the heading the paper printed ("paper-ii-section-b")
          // or on its own ("paper-ii") when the paper has no headings. This is
          // the ONLY paper a section rule may ever point at.
          sectionKeyFor(g), Number(g.number) || 0,
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
        savedRows.map((id) => db.prepare('SELECT id, q_order, type, section_key, source_number FROM questions WHERE id = ?').get(id)),
        buildSectionMeta(filtered)
      );
      if (out.applied) updateJob(jobId, { stage: 'Applying selection rules…', progress: 68 });
    } catch (err) {
      // A rule we cannot read must never fail an otherwise good import.
      console.error('[pdfImport] selection rules failed (continuing):', err.message);
    }

    // A paper that never states a choice still gets one: a theory block of
    // about six or seven questions becomes "question 1 compulsory, answer any
    // N" — the same default an AI-generated exam receives. Only blocks no
    // instruction line and no compulsory flag ever spoke for are touched, so a
    // paper whose rules WERE read keeps them verbatim.
    try {
      selection.applyDefaultTheoryRule(job.exam_id);
    } catch (err) {
      // Same law as every rule step: a rule we cannot write must never fail an
      // otherwise good import.
      console.error('[pdfImport] default theory rule failed (continuing):', err.message);
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

// "SECTION B" -> "section-b" (slugOf) and every section key an import writes
// (sectionKeyFor, PAPER_I_KEY, PAPER_II_KEY) live in ./paper.js — src/db.js
// needs the same mapping when it migrates questions imported before the two
// papers were separated, so there must be one definition of them.

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
    // "Answer only THREE questions", "Answer 2 questions", "Attempt ONE question",
    // "Answer about 4 questions" — the hedges papers use when the count is
    // approximate ("about", "approximately", "at least", "at most") are filler
    // too: they shape the demand, they are never the demand itself.
    /\b(?:answer|attempt|choose|select|pick)\s+(?:all\s+|any\s+|only\s+|the\s+|a\s+|about\s+|approximately\s+|at\s+least\s+|at\s+most\s+)?(\d{1,2}|[a-z]+)(?:\s*\(\d+\))?\s+questions?\b/i,
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
 * Facts are keyed TWICE: by the paper key the rows are saved under (paper.js
 * `sectionKeyFor` — `paper-i`, `paper-ii`, `paper-ii-<slug>`) and by the
 * heading the model returned verbatim, so a caller can look a section up
 * either way. The paper-scoped key is what keeps the two papers' counts
 * apart: an objectives instruction ("Answer all 40 questions") must never
 * price the theory block printed next to it, and a theory section's "answer
 * any FOUR" must never be read as a quota on Paper I.
 *
 * A paper with NO headings at all still carries its limit on the first
 * question, so that case is returned under the empty key too — but only the
 * THEORY facts go there, with objectives facts as the fallback when the
 * paper carries no theory at all, for the same reason.
 */
function buildSectionMeta(questions) {
  const list = Array.isArray(questions) ? questions : [];
  const meta = {};

  const factsFor = (q) => ({
    title: String((q && q.section) || '').trim(),
    instructions: String((q && q.instructions) || ''),
    answer_count: answerCountFrom(`${(q && q.instructions) || ''} ${(q && q.passage) || ''}`),
  });

  // Keep the first question's wording, and take the count from whichever
  // question actually states one — extraction sometimes hangs a section's
  // instructions on a later question.
  const merge = (prev, facts) => {
    if (!prev) return facts;
    if (prev.answer_count === 0 && facts.answer_count > 0) {
      return {
        title: prev.title,
        instructions: facts.instructions || prev.instructions,
        answer_count: facts.answer_count,
      };
    }
    return prev;
  };

  let unheadedAny = null;
  let unheadedTheory = null;
  for (const q of list) {
    if (!q) continue;
    const facts = factsFor(q);
    const heading = facts.title;
    const key = sectionKeyFor(q);
    meta[key] = merge(meta[key], facts);
    if (heading) {
      meta[heading] = merge(meta[heading], facts);
    } else {
      unheadedAny = merge(unheadedAny, facts);
      if (key !== PAPER_I_KEY) unheadedTheory = merge(unheadedTheory, facts);
    }
  }

  // The headingless paper states its limit on the first question, and that
  // limit belongs to the THEORY block: dropping it is what left a headingless
  // paper never offering a choice, while letting an objectives instruction
  // price the theory questions is the opposite failure.
  const unheaded = unheadedTheory || unheadedAny;
  if (unheaded) meta[''] = unheaded;
  return meta;
}

/**
 * Turn the extraction's per-question selection facts into stored rules.
 *
 * `questions` is the extraction array itself — the only shape this pipeline
 * actually returns. Questions are grouped by the section key they were SAVED
 * under (paper.js `sectionKeyFor`): every objective forms the one Paper I group,
 * theory forms one group per heading of Paper II. `sectionMeta` (title,
 * instructions, answer_count, keyed by the verbatim heading) supplies the
 * wording. Every claim is checked against the rows we actually saved:
 *
 *   - Paper I never gets a rule: objectives are answered in full, and any quota
 *     the paper or the model claimed for them is reported and refused;
 *   - a compulsory question whose number never landed in the database is
 *     reported and dropped, because pointing at the wrong question is
 *     unrecoverable;
 *   - the paper's stated count is the CHOICE it puts on offer ("answer about
 *     FOUR questions") and the compulsory questions are owed ON TOP of it: a
 *     section of six that asks for four and forces one owes five in all. The
 *     sum is clamped to the section;
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

  // Group the extraction by the key its rows live under — ONE group for Paper I
  // (however the PDF split its objective sections) and one per Paper II heading.
  // Grouping on the stored key rather than the printed heading is what keeps the
  // rule, the saved rows and the selector talking about one section.
  const groups = new Map();
  for (const q of list) {
    const key = sectionKeyFor(q);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        heading: String((q && q.section) || '').trim(),
        objective: key === PAPER_I_KEY,
        members: [],
      };
      groups.set(key, group);
    }
    group.members.push(q);
  }
  // A paper with no headings at all still states its limit — "Answer any
  // THREE questions" sits on the first question. Without a key for
  // exam_sections to point at, that limit could never be stored and the paper
  // silently answered every question instead of offering a choice, so those
  // questions are given one shared Paper II section.
  const paperMeta = sectionMeta[''] || null;

  db.exec('BEGIN');
  try {
    // Every question of an exam belongs to a paper. Rows this pipeline saved
    // already carry their key; a row still unsectioned (an earlier import, a
    // hand-entered question) is placed now, so the rule, the drawn snapshot and
    // the selector can never point at different sections.
    db.prepare(
      `UPDATE questions SET section_key = ? WHERE exam_id = ? AND type <> 'objective'
         AND COALESCE(section_key, '') = ''`
    ).run(PAPER_II_KEY, examId);
    db.prepare(
      `UPDATE questions SET section_key = ? WHERE exam_id = ? AND type = 'objective'
         AND COALESCE(section_key, '') = ''`
    ).run(PAPER_I_KEY, examId);
    for (const row of saved) {
      if (String(row.section_key || '').trim()) continue;
      row.section_key = row.type === 'objective' ? PAPER_I_KEY : PAPER_II_KEY;
    }

    let position = 0;
    for (const group of groups.values()) {
      const { key, heading, objective } = group;
      const members = group.members;

      // Compulsory questions in this section, matched on the printed number.
      const forcedIds = new Set();
      for (const q of members) {
        if (!q.compulsory) continue;
        const row = bySourceNumber.get(Number(q.number));
        if (row) forcedIds.add(row.id);
        else skipped.push(`${heading || key}: compulsory question ${q.number} was not extracted`);
      }
      const inSection = saved.filter((q) => String(q.section_key || '') === key);
      if (!inSection.length) {
        skipped.push(`${heading || key}: no questions were saved for it`);
        continue;
      }

      // Paper I: every objective is compulsory and every objective is answered.
      // There is nothing to choose from and nothing to rule over, so no row is
      // written — an exam_sections row would advertise a choice the student
      // must never be given for objectives.
      if (objective) {
        const allCompulsory = db.prepare('UPDATE questions SET is_compulsory = 1 WHERE id = ?');
        for (const row of inSection) allCompulsory.run(row.id);
        // Paper-scoped first: the objectives' own instruction, never the
        // theory block's — on a headingless paper the empty key holds theory
        // facts and would report the wrong number here.
        const claimed = Math.max(
          0,
          parseInt((sectionMeta[PAPER_I_KEY] || sectionMeta[heading] || {}).answer_count, 10) || 0
        );
        if (claimed > 0) {
          skipped.push(
            `${heading || key}: objectives are Paper I and are answered in full — the paper's count of ${claimed} was not written`
          );
        }
        continue;
      }

      // Paper-scoped facts first — the saved rows' own key — so the theory
      // block never picks up an objectives instruction printed under the same
      // (or no) heading. The verbatim heading and the headingless paper's
      // facts remain as fallbacks for meta keyed the old way.
      const meta = sectionMeta[key] || (heading ? sectionMeta[heading] : null) || paperMeta || {};
      const total = inSection.length;
      const want = Math.max(0, parseInt(meta.answer_count, 10) || 0);
      // The stated count is the CHOICE on offer ("answer about FOUR
      // questions"): the compulsory questions are owed ON TOP of it, so a
      // section of six whose paper asks for four and forces one owes five in
      // all — the one forced plus the four on offer. The sum is clamped to the
      // section, so a count that already covers everything still reads as
      // answer-all. With no stated count there is nothing to add to, and the
      // block stays answer-all exactly as the paper printed it.
      const count = want > 0 ? Math.min(want + forcedIds.size, total) : 0;
      const selective = count > 0 && count < total;

      // An unheaded Paper II block with no limit must be left exactly as the
      // paper printed it: splitting it here would mark questions optional that
      // no rule ever priced, and shut the default theory rule's own gate.
      if (!heading && !selective) {
        skipped.push(`${key}: rule is answer-all, nothing to choose`);
        continue;
      }

      // Write BOTH directions. is_compulsory defaults to 1, so a reconciliation
      // that only ever forces questions leaves the whole pool compulsory and
      // every quota silently collapses to answer-all.
      const setFlag = db.prepare('UPDATE questions SET is_compulsory = ? WHERE id = ?');
      for (const q of inSection) setFlag.run(forcedIds.has(q.id) ? 1 : 0, q.id);

      if (!selective) {
        skipped.push(`${heading || key}: rule is answer-all, nothing to choose`);
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
        // The paper's own label for its theory section: "PAPER II — SECTION B".
        paperIITitle(key, heading) || String(meta.title || heading),
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
  PAPER_I_KEY,
  PAPER_II_KEY,
  sectionKeyFor,
  looksLikeDirective,
  answerCountFrom,
  buildSectionMeta,
  applySelectionRules,
};
