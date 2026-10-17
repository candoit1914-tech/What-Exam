// Turn an uploaded file into the text the extractor reads, whatever it was
// written as. The pipeline downstream only ever wants a string of exam text —
// `ai.extractQuestionsFromText` does not know or care whether a human typed it
// into Notepad, exported it from Word, or printed it to PDF — so every format
// converges on the same shape and only the reader differs.
//
// JSON is the exception, and deliberately so: a JSON upload is ALREADY
// structured questions, so it is imported verbatim (exact text, exact options,
// exact answer) rather than re-parsed by the model. Re-reading a hand-built
// answer sheet through a probabilistic parser would only risk corrupting work
// someone already did correctly.
const { readZip } = require('./zip');

/** The formats this endpoint will read, in the order the UI should offer them. */
const SUPPORTED_EXTENSIONS = ['.pdf', '.txt', '.text', '.docx', '.xlsx', '.json'];

/**
 * Map an uploaded filename to a format key, ignoring query strings and casing.
 * @param {string} name
 * @returns {'pdf'|'txt'|'docx'|'xlsx'|'json'|null}
 */
function formatOf(name) {
  const clean = String(name || '').split(/[?#]/)[0].toLowerCase();
  const dot = clean.lastIndexOf('.');
  if (dot < 0) return null;
  switch (clean.slice(dot)) {
    case '.pdf': return 'pdf';
    case '.txt':
    case '.text': return 'txt';
    case '.docx': return 'docx';
    case '.xlsx': return 'xlsx';
    case '.json': return 'json';
    default: return null;
  }
}

/** Decode to text, tolerating a UTF-8 BOM that Word and Notepad love to add. */
function toText(buf) {
  return String(buf.toString('utf8')).replace(/^\uFEFF/, '');
}

// ── DOCX ───────────────────────────────────────────────────────────────

/** Decode the handful of XML entities that appear in Word's text runs. */
function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&'); // &amp; last, so &amp;lt; decodes to "&lt;" not "<"
}

/**
 * Read the paragraph text of a .docx.
 *
 * Word splits a paragraph across many <w:t> runs (spell-check breaks, tracked
 * changes, a bolded word), so the text is assembled per <w:p> (paragraph) and
 * not per run — otherwise every paragraph would shatter into fragments the
 * parser reads as separate questions. <w:tab/> and <w:br/> become spacing so a
 * two-column layout does not run two questions together.
 */
function docxText(buf) {
  const parts = readZip(buf);
  const doc = parts['word/document.xml'];
  if (!doc) throw new Error('not a Word document: word/document.xml is missing');
  const xml = doc.toString('utf8');
  const paras = [];
  // Split on the paragraph element, keeping each paragraph's own XML.
  for (const chunk of xml.split(/<\/w:p>/)) {
    if (!/<w:p[\s>]/.test(chunk)) continue;
    let line = '';
    // Self-closing breaks/tabs are structural, so pull their text out in
    // document order alongside the runs. `<w:t` must be followed by whitespace
    // or ">" or `<w:tab/>` would match as a run opening and swallow the text
    // after it — markup leaking into the question.
    const tokens = chunk.match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>/g) || [];
    for (const tok of tokens) {
      // A text run, not a tab/br/cr: `<w:tab/>` also starts with "<w:t", so
      // the test must be the run's opening ">" and not its first four letters.
      if (/^<w:t(?:\s[^>]*)?>/.test(tok)) {
        const inner = tok.replace(/^<w:t(?:\s[^>]*)?>/, '').replace(/<\/w:t>$/, '');
        line += decodeXml(inner);
      } else {
        line += ' ';
      }
    }
    paras.push(line.replace(/\s+/g, ' ').trim());
  }
  return paras.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── XLSX ───────────────────────────────────────────────────────────────

/** Resolve a shared-string index to its text (each string is many runs too). */
function sharedStrings(xml) {
  const out = [];
  for (const si of xml.split(/<\/si>/)) {
    if (!/<si[\s>]/.test(si)) continue;
    const runs = si.match(/<t(?:\s[^>]*)?>[\s\S]*?<\/t>/g) || [];
    out.push(decodeXml(runs.map((r) => r.replace(/^<t(?:\s[^>]*)?>/, '').replace(/<\/t>$/, '')).join('')));
  }
  return out;
}

/**
 * Read a .xlsx as rows of text, one row per line, cells tab-separated.
 *
 * A spreadsheet is the one upload format with no notion of a paragraph, so the
 * convention that makes it work is: the first column carries the question and
 * the columns to its right carry its options/answer, exactly as a teacher
 * would type it. Inline strings are handled as well as the shared-string table
 * because both occur in the wild.
 */
function xlsxText(buf) {
  const parts = readZip(buf);
  const shared = parts['xl/sharedStrings.xml']
    ? sharedStrings(parts['xl/sharedStrings.xml'].toString('utf8'))
    : [];
  // First worksheet only: an exam paper is one sheet, and guessing which of
  // several sheets holds it would silently import the wrong one.
  const sheetName = Object.keys(parts).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  if (!sheetName) throw new Error('not a spreadsheet: no worksheet found');
  const sheet = parts[sheetName].toString('utf8');

  const rows = [];
  for (const rowXml of sheet.split(/<\/row>/)) {
    if (!/<row[\s>]/.test(rowXml)) continue;
    const cells = [];
    for (const c of rowXml.match(/<c\b[\s\S]*?(?:\/>|<\/c>)/g) || []) {
      // r="B2" gives the column; sparse sheets omit empty cells, so the column
      // letter is what keeps option A under question A rather than shifted left.
      const ref = /r="([A-Z]+)\d+"/.exec(c);
      const col = ref ? ref[1] : null;
      const idx = col ? colToIndex(col) : cells.length;
      const type = (/t="([^"]+)"/.exec(c) || [])[1];
      let value = '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(c);
      if (type === 'inlineStr' || /<is>/.test(c)) {
        const runs = c.match(/<t(?:\s[^>]*)?>[\s\S]*?<\/t>/g) || [];
        value = decodeXml(runs.map((r) => r.replace(/^<t(?:\s[^>]*)?>/, '').replace(/<\/t>$/, '')).join(''));
      } else if (v) {
        value = type === 's' ? (shared[Number(v[1])] ?? '') : decodeXml(v[1]);
      }
      while (cells.length < idx) cells.push('');
      cells[idx] = value;
    }
    const line = cells.map((c) => String(c).replace(/\s+/g, ' ').trim()).join('\t').trim();
    if (line) rows.push(line);
  }
  return rows.join('\n');
}

/** "A" -> 0, "B" -> 1, "AA" -> 26. Spreadsheet column letters to a 0-based index. */
function colToIndex(col) {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ── Plain text ─────────────────────────────────────────────────────────

function plainText(buf) {
  return toText(buf).replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Read a file into { text } for the extractor, or { questions } when the file
 * already held structured questions (JSON).
 *
 * The extension decides, not the MIME type: a browser's guess for .docx and
 * .xlsx varies by OS, and a file renamed by a download server lies about
 * itself. A mismatch that still parses is fine; one that does not throws with
 * a message naming the format we tried.
 *
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {{format: string, text?: string, questions?: object[]}}
 */
function readExamSource(buffer, filename) {
  const format = formatOf(filename);
  if (!format) {
    throw new Error(
      `Unsupported file type for "${filename}". Upload a PDF, Word (.docx), Excel (.xlsx), text (.txt) or JSON file.`
    );
  }
  switch (format) {
    case 'pdf': return { format, pdf: buffer };
    case 'txt': return { format, text: plainText(buffer) };
    case 'docx': return { format, text: docxText(buffer) };
    case 'xlsx': return { format, text: xlsxText(buffer) };
    case 'json': return { format, questions: parseQuestionsJson(buffer, filename) };
    default: throw new Error(`Unsupported file type: ${filename}`);
  }
}

// ── JSON ───────────────────────────────────────────────────────────────

/**
 * Accept a bare array, {questions:[…]} or a bare object, and normalize each
 * entry to the shape the extractor produces so the save loop cannot tell an
 * import from a parse.
 *
 * Field names are matched loosely ("text"/"question"/"stem", "options"/
 * "choices", "correct_answer"/"answer") because a JSON upload has no fixed
 * author and demanding one exact spelling would reject a correct file.
 */
function parseQuestionsJson(buffer, filename) {
  let data;
  try {
    data = JSON.parse(toText(buffer));
  } catch (err) {
    throw new Error(`"${filename}" is not valid JSON: ${err.message}`);
  }
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data && data.questions) ? data.questions
    : data && typeof data === 'object' ? [data]
    : null;
  if (!rows) throw new Error(`"${filename}" holds no questions. Send a JSON array of question objects, or {"questions": [...]}.`);

  const out = [];
  rows.forEach((row, i) => {
    if (!row || typeof row !== 'object') return;
    const text = String(row.text ?? row.question ?? row.stem ?? '').trim();
    if (!text) return; // a row with no question text cannot be asked
    const rawType = String(row.type || '').toLowerCase();
    const options = asArray(row.options ?? row.choices)
      .map((o) => String(o).trim()).filter(Boolean);
    const type = rawType === 'objective' || rawType === 'theory'
      ? rawType
      : options.length ? 'objective' : 'theory';
    const followUps = asArray(row.follow_ups ?? row.followUps ?? row.sub_questions ?? row.parts)
      .map((f) => (typeof f === 'string' ? { text: f.trim(), marks: 0 } : {
        text: String(f && (f.text ?? f.question) || '').trim(),
        marks: Number(f && f.marks) || 0,
      }))
      .filter((f) => f.text);
    out.push({
      type,
      number: Number(row.number) || i + 1,
      section: String(row.section ?? row.part ?? '').trim(),
      text,
      passage: String(row.passage ?? row.context ?? '').trim(),
      options,
      correct_answer: String(row.correct_answer ?? row.answer ?? row.correct ?? '').trim(),
      correct_index: Number.isFinite(Number(row.correct_index)) ? Number(row.correct_index) : null,
      marks: Number(row.marks) || (type === 'objective' ? 1 : 4),
      difficulty: String(row.difficulty || 'medium'),
      learning_objective: String(row.learning_objective ?? row.objective ?? '').trim(),
      model_answer: String(row.model_answer ?? row.modelAnswer ?? '').trim(),
      key_points: asArray(row.key_points ?? row.keyPoints).map(String),
      follow_ups: followUps,
      _imported: true, // tells the save loop this row is authored, not parsed
    });
  });
  if (!out.length) throw new Error(`"${filename}" contained no usable questions — every entry was missing question text.`);
  return out;
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null || v === '') return [];
  return [v];
}

module.exports = {
  SUPPORTED_EXTENSIONS,
  formatOf,
  readExamSource,
  parseQuestionsJson,
  docxText,
  xlsxText,
  plainText,
};
