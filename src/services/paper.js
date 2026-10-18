'use strict';

// ── Paper I and Paper II ───────────────────────────────────────────────
//
// An exam is TWO papers, never one mixed pool — the WAEC/Ghana shape every
// candidate recognises:
//
//   Paper I  — the objectives: every question is answered, no choice, ever.
//   Paper II — the theory questions, under the heading the PDF printed
//              ("SECTION B"); the ONLY place a student picks questions.
//
// Every question row carries its paper in `section_key`, so the importer, the
// selection rules, the selector and the chat can tell which paper a question
// belongs to without re-reading its text:
//
//   paper-i                 every objective of the exam
//   paper-ii                theory with no heading of its own
//   paper-ii-section-b      theory under "SECTION B"
//
// This module is deliberately pure — no db, no services — so src/db.js can use
// the SAME mapping when it migrates questions imported before the two papers
// were separated, and so pdfImport and selection can share one definition.

const PAPER_I_KEY = 'paper-i';
const PAPER_II_KEY = 'paper-ii';
const PAPER_I_LABEL = 'PAPER I';
const PAPER_II_LABEL = 'PAPER II';

/** "SECTION B" -> "section-b". Stable, so it matches what the admin sees. */
function slugOf(section) {
  return String(section || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function isPaperIKey(key) {
  return String(key || '') === PAPER_I_KEY;
}

function isPaperIIKey(key) {
  const k = String(key || '');
  return k === PAPER_II_KEY || k.startsWith(`${PAPER_II_KEY}-`);
}

/**
 * The section key ONE EXTRACTED QUESTION is stored under.
 *
 * Objectives never keep the heading they sat under: a paper's multiple-choice
 * part IS Paper I, however the PDF labels it, so merging every objective under
 * one key is what keeps the two papers apart. Theory keeps its heading under
 * the Paper II prefix, which is what lets "SECTION B" stay a section a rule,
 * the dashboard and the selector can all point at.
 */
function sectionKeyFor(question) {
  const q = question || {};
  if (q.type === 'objective') return PAPER_I_KEY;
  const slug = slugOf(q.section);
  return slug ? `${PAPER_II_KEY}-${slug}` : PAPER_II_KEY;
}

/** 'paper-i' → 'PAPER I'; '' for any key this paper does not own. */
function paperITitle(key) {
  return isPaperIKey(key) ? PAPER_I_LABEL : '';
}

/**
 * The name a Paper II section is listed under: the paper's own label plus the
 * heading the PDF printed — "PAPER II", or "PAPER II — SECTION B". The heading
 * is kept verbatim (mixed case, roman numerals) because it is what the admin
 * and the student recognise from the paper.
 */
function paperIITitle(key, heading) {
  if (!isPaperIIKey(key)) return '';
  const label = String(heading || '').replace(/\s+/g, ' ').trim();
  return label ? `${PAPER_II_LABEL} — ${label}` : PAPER_II_LABEL;
}

/**
 * Where a section key written BEFORE the papers were separated belongs today.
 *
 * `type` is the row's question type ('objective' | 'theory'), or 'theory' for
 * an exam_sections row — a rule always followed the theory questions it ruled,
 * and any quota it held over objectives is dropped by the migration rather
 * than carried into Paper I.
 *
 * Two legacy shapes are left exactly as they are:
 *   ''      — a question nobody ever grouped (manual entry, AI generation)
 *   theory  — the block the default theory rule names, already theory-only
 *
 * Everything else was written by the importer and is rewritten: objectives to
 * Paper I, theory to Paper II under its own heading — including the old shared
 * 'paper' key, which is what put objectives and theory in ONE ruled section.
 *
 * Pure and idempotent: applying it twice returns the same key.
 */
function legacySectionKey(rawKey, type) {
  const key = String(rawKey || '').trim();
  if (type === 'objective') {
    if (key === '' || key === 'theory' || isPaperIKey(key)) return key;
    return PAPER_I_KEY;
  }
  if (key === '' || key === 'theory' || isPaperIIKey(key)) return key;
  if (key === 'paper' || isPaperIKey(key)) return PAPER_II_KEY;
  return `${PAPER_II_KEY}-${key}`;
}

/** True when `legacySectionKey` would move this row — the migration's fast path. */
function needsLegacyRemap(rawKey, type) {
  return legacySectionKey(rawKey, type) !== String(rawKey || '').trim();
}

module.exports = {
  PAPER_I_KEY,
  PAPER_II_KEY,
  PAPER_I_LABEL,
  PAPER_II_LABEL,
  slugOf,
  isPaperIKey,
  isPaperIIKey,
  sectionKeyFor,
  paperITitle,
  paperIITitle,
  legacySectionKey,
  needsLegacyRemap,
};
