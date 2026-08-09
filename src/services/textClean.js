'use strict';

// Watermark / source / download footer lines that get glued onto extracted
// questions (e.g. "DOWNLOADED FROM SRONU papers.sronu.com") must never reach a
// student. Only STANDALONE lines matching a precise, safe pattern are dropped:
// a passage sentence that merely mentions a URL or "source" survives.
const WATERMARK = /sronu|downloaded\s+(from|by)|source\s*[:=]|visit\s+(us\s+)?at\b/i;
// Vertically-arranged PDF watermarks put one word per line (DOWNLOADED / FROM /
// SRONU / papers.sronu.com). A line that is exactly one of these fragment
// words is a footer, never prose.
const FRAGMENT = /^(downloaded|from)$/i;
const URL_LINE =
  /^(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9.-]*\.(?:com|org|net|gh|edu|co)(?:\/[\w./-]*)?$/i;
// Whole marker lines [IMG:n] inserted at figure positions by the PDF
// extraction pipeline. They are payload for question attachment, never
// content, so they are stripped everywhere the text is stored or shown.
const IMG_MARKER = /^\[IMG:\d+\]\s*\n?/gm;

function stripSourceWatermarks(text) {
  const lines = String(text || '').split(/\r?\n/);
  const kept = lines.filter((line) => {
    const l = line.trim();
    if (!l) return true; // blank lines are collapsed below, not dropped
    return !(WATERMARK.test(l) || FRAGMENT.test(l) || URL_LINE.test(l));
  });
  return kept.join('\n').replace(/\n{2,}/g, '\n').trim();
}

// Whole marker lines [IMG:n] inserted at figure positions are payload for the
// attachment pipeline, never content: strip every one.
function stripMarkers(text) {
  return String(text || '').replace(IMG_MARKER, '');
}

module.exports = { stripSourceWatermarks, stripMarkers };
