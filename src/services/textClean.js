'use strict';

// Watermark / source / download footer lines that get glued onto extracted
// questions (e.g. "DOWNLOADED FROM SRONU papers.sronu.com") must never reach a
// student. Only STANDALONE lines matching a precise, safe pattern are dropped:
// a passage sentence that merely mentions a URL or "source" survives.
const WATERMARK =
  /sronu|downloaded\s+(from|by)|source\s*[:=]|visit\s+(us\s+)?at\b|^mock\s+exam(?:ination)?|do\s+not\s+share|for\s+internal\s+use\b/i;
// Vertically-arranged PDF watermarks put one word per line (DOWNLOADED / FROM /
// SRONU / papers.sronu.com). A line that is exactly one of these fragment
// words is a footer, never prose.
const FRAGMENT = /^(downloaded|from)$/i;
const URL_LINE =
  /^(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9.-]*\.(?:com|org|net|gh|edu|co)(?:\/[\w./-]*)?$/i;

// A print-site watermark set VERTICALLY, one LETTER per line, reads as a run
// of lone letters — "D" "O" "W" "N" "L" "O" "A" "D" "E" "D" "F" "R" "O" "M"
// spells DOWNLOADED FROM. No exam content stacks single letters like that, so
// a run is dropped WHOLE, but only when the letters it spells actually contain
// a watermark word: a stray "A", a lone "(i)", or a column of chemistry
// symbols is never touched, because those runs never spell DOWNLOADED/SRONU.
const LONE_LETTER = /^[A-Za-z]$/;
const VERTICAL_WATERMARK =
  /DOWNLOADED|SRONU|CONFIDENTIAL|WATERMARK|PROTECTED|PIRAC|COPYRIGHT|DISTRIBUT/i;

// The same watermark LETTER-SPACED across a line: "s r o n u ." / "c o m" /
// "p a p e r s .". A line is considered only when it really is letter-spaced
// (every character separated by blanks), then its spacing/punctuation is
// collapsed — and the line is dropped only if that collapsed token is itself
// a watermark/domain word. So "a b c" in a puzzle survives (it collapses to
// "abc", not a watermark), and ordinary prose is never collapsed at all.
const LETTER_SPACED = /^(?:[A-Za-z]\s+){2,}[A-Za-z](?:\s*[.,;:!?])?\s*$/;
const SPACED_TOKEN = /^(?:sronu|papers?|downloaded|from|www|https?|com|net|org|gh|edu|co)$/i;

// The renderer sometimes glues a letter-spaced watermark token onto the FRONT
// of a real line ("c o m young ones…", "s r o n u . 2026 BECE"). Only a
// LEADING token is stripped, only when it is letter-spaced AND collapses to a
// watermark/domain word AND genuine content follows it — so a line that merely
// begins with normal words is never rewritten.
const LEADING_SPACED = /^((?:[A-Za-z]\s+){2,}[A-Za-z](?:\s*[.,;:!?])?)\s+/;

function stripLeadingSpacedToken(line) {
  const m = LEADING_SPACED.exec(line);
  if (!m) return line;
  const collapsed = m[1].replace(/[\s.]+/g, '').toLowerCase();
  if (!SPACED_TOKEN.test(collapsed)) return line;
  return line.slice(m[0].length);
}

function stripSourceWatermarks(text) {
  const lines = String(text || '').split(/\r?\n/);

  // Pass 1 — mark the lone-letter runs that spell a watermark word. A run is a
  // maximal stretch of consecutive lone-letter lines; it is removed whole, and
  // only when the letters it spells contain a watermark term.
  const dropRun = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; ) {
    if (!LONE_LETTER.test(lines[i].trim())) { i++; continue; }
    let j = i;
    let spelled = '';
    while (j < lines.length && LONE_LETTER.test(lines[j].trim())) {
      spelled += lines[j].trim().toUpperCase();
      j++;
    }
    if (spelled.length >= 3 && VERTICAL_WATERMARK.test(spelled)) {
      for (let k = i; k < j; k++) dropRun[k] = true;
    }
    i = j;
  }

  const kept = lines.filter((line, idx) => {
    if (dropRun[idx]) return false;
    const l = line.trim();
    if (!l) return true; // blank lines are collapsed below, not dropped
    if (WATERMARK.test(l) || FRAGMENT.test(l) || URL_LINE.test(l)) return false;
    if (LETTER_SPACED.test(l)) {
      const collapsed = l.replace(/[\s.]+/g, '').toLowerCase();
      if (SPACED_TOKEN.test(collapsed)) return false;
    }
    return true;
  }).map((line) => {
    // A watermark token glued to the FRONT of a real line is cut away; the
    // real content behind it survives untouched.
    const stripped = stripLeadingSpacedToken(line);
    return stripped.trim() ? stripped : '';
  });
  return kept.join('\n').replace(/\n{2,}/g, '\n').trim();
}

// Whole marker lines [IMG:n] inserted at figure positions are payload for the
// attachment pipeline, never content: strip every one. The AI may echo a
// marker back mid-line ("Look at Figure 1. [IMG:0]") — a marker is removed
// wherever it appears, whether it sits on its own line or inline in text.
// The same applies to [MATH:n] markers spliced inline where stacked math
// glyphs were removed (see pdf.js detectMathExprs).
function stripMarkers(text) {
  return String(text || '')
    .replace(/^\[(?:IMG|MATH):\d+\]\s*\n?/gm, '')
    .replace(/\s?\[(?:IMG|MATH):\d+\]/g, '');
}

// ── Paper furniture ────────────────────────────────────────────────────────
// A practice paper prints a great deal that a student reading a WhatsApp chat
// has no use for: the running header ("2027 BECE French Mock | Original
// practice material Page 8"), the paper's own title ("PAPER 2: WRITTEN AND
// COMMUNICATIVE SKILLS"), its time and marks lines, its printed INSTRUCTIONS
// block, and the "Question 1 [40 marks]" label above every question. This app
// writes its own header, part labels, instructions and numbering, so none of
// that may reach a question or a passage.
//
// Two rules keep the dropping safe:
//   - only STANDALONE lines go; a phrase inside prose never does;
//   - a line that could be a real question stem is kept even though it reads
//     like an instruction ("Write a letter to your friend…", "Read the
//     passage and answer…"). Only the narrow forms a paper uses to address
//     the candidate as a whole are dropped.
const FURNITURE = [
  // running header / footer of a practice paper
  /original\s+practice\s+material/i,
  /^\d{4}\s+(?:bece|waec|neco|jsce|gce)\b/i,
  /^(?:bece|waec|neco|jsce|gce)\b.*\bmock\b/i,
  /^page\s+\d+(?:\s*(?:of|\/)\s*\d+)?$/i,
  // the paper's own title block
  /^paper\s+\d+\s*[:：.,\-–—]/i,
  /^time\s*[:·]\s*\S/i,
  /^(?:duration|suggested\s+(?:raw\s+)?marks?|total\s+(?:raw\s+)?marks?|raw\s+marks?)\s*[:·]/i,
  /^marks?\s+(?:reward|are|will\s+be)\b/i,
  // the printed instructions block
  /^instructions?\s*[:：]?\s*$/i,
  /^instructions?\s*[:：]/i,
  /^in\s+(?:part|section|paper)\s+[0-9ivx]+(?:\s*[,.:]|\s*$)/i,
  /^answer\s+(?:all|any|one|only)\b/i,
  /^write\s+(?:clearly|neatly|legibly)\b/i,
  // the label the app numbers for the student anyway
  /^(?:question|soal)\s*\d+\s*(?:\[[^\]]*\]|\(\s*\d+(?:\.\d+)?\s*marks?\s*\)|[-–—:.])?\s*$/i,
];

/**
 * "PART 1: COMPULSORY READING AND LANGUAGE TASK" and "PART A, LEXIS AND
 * STRUCTURE" are labels the paper pads with a description. The app prints the
 * label alone — "*PART 1*", "*PART A*" — so the structure stays and the
 * paper's prose goes. The padding is ALL CAPS on a printed paper; mixed case
 * means a sentence that happens to start with "Part 1", and prose is never
 * rewritten.
 */
function shortenPartLabel(line) {
  const m = /^(part|section)\s+(?:\d{1,2}|[ivx]{1,4}|[a-z])\s*[:：.,\-–—]/i.exec(line);
  if (!m) return null;
  const rest = line.slice(m[0].length);
  if (/[^A-Z0-9\s:.,()'"/\-–—]/.test(rest)) return null;
  return m[0].replace(/[:：.,\-–—]\s*$/, '').toUpperCase();
}

function stripPaperFurniture(text) {
  const lines = String(text || '').split(/\r?\n/);
  const kept = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { kept.push(raw); continue; }
    if (FURNITURE.some((re) => re.test(l))) continue;
    const short = shortenPartLabel(l);
    kept.push(short == null ? raw : short);
  }
  return kept
    .join('\n')
    // The paper's own annotation of what a question is worth. The app carries
    // marks in the dashboard and the report; the chat stem does not need it.
    .replace(/\s*\[\s*\d+(?:\.\d+)?\s*marks?\s*\]/gi, '')
    .replace(/\s*\(\s*\d+(?:\.\d+)?\s*marks?\s*\)\s*$/gi, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

module.exports = { stripSourceWatermarks, stripPaperFurniture, stripMarkers };
