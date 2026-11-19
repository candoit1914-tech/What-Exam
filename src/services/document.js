// Turn an uploaded file into the text the extractor reads, whatever it was
// written as. The pipeline downstream only ever wants a string of exam text —
// `ai.extractQuestionsFromText` does not know or care whether a human typed it
// into Notepad, exported it from Word, Excel or PDF — so every format converges
// on exam text plus optional image markers, and only the reader differs.
//
// JSON is the exception, and deliberately so: a JSON upload is ALREADY
// structured questions, so it is imported verbatim (exact text, exact options,
// exact answer) rather than re-parsed by the model. Re-reading a hand-built
// answer sheet through a probabilistic parser would only risk corrupting work
// someone already did correctly.
const { readZip } = require('./zip');
const path = require('path');

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
 * Read paragraph text and embedded pictures from a .docx.
 *
 * Word splits a paragraph across many <w:t> runs (spell-check breaks, tracked
 * changes, a bolded word), so the text is assembled per <w:p> (paragraph) and
 * not per run — otherwise every paragraph would shatter into fragments the
 * parser reads as separate questions. <w:tab/> and <w:br/> become spacing so a
 * two-column layout does not run two questions together. Embedded image
 * relationships become [IMG:n] markers at their paragraph position so the
 * question importer can attach each figure to the nearby question.
 */
function docxSource(buf) {
  const parts = readZip(buf);
  const doc = parts['word/document.xml'];
  if (!doc) throw new Error('not a Word document: word/document.xml is missing');
  const xml = doc.toString('utf8');
  const relXml = parts['word/_rels/document.xml.rels']
    ? parts['word/_rels/document.xml.rels'].toString('utf8')
    : '';
  const relTargets = new Map();
  for (const match of relXml.matchAll(/<Relationship\b[^>]*\/?\s*>/g)) {
    const tag = match[0];
    const id = /\bId="([^"]+)"/.exec(tag)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
    const external = /\bTargetMode="External"/i.test(tag);
    if (!id || !target || external) continue;
    let decoded = target.replace(/\\/g, '/');
    try { decoded = decodeURIComponent(decoded); } catch (_) {}
    const resolved = decoded.startsWith('/')
      ? path.posix.normalize(decoded.slice(1))
      : path.posix.normalize(path.posix.join('word', decoded));
    relTargets.set(id, resolved);
  }
  const images = [];
  const markers = [];
  const paras = [];
  // Split on the paragraph element, keeping each paragraph's own XML.
  for (const chunk of xml.split(/<\/w:p>/)) {
    if (!/<w:p[\s>]/.test(chunk)) continue;
    let line = '';
    // Self-closing breaks/tabs are structural, so pull their text out in
    // document order alongside the runs. `<w:t` must be followed by whitespace
    // or ">" or `<w:tab/>` would match as a run opening and swallow the text
    // after it — markup leaking into the question.
    const tokens = chunk.match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>|<a:blip\b[^>]*>|<v:imagedata\b[^>]*>/g) || [];
    for (const tok of tokens) {
      // A text run, not a tab/br/cr: `<w:tab/>` also starts with "<w:t", so
      // the test must be the run's opening ">" and not its first four letters.
      if (/^<w:t(?:\s[^>]*)?>/.test(tok)) {
        const inner = tok.replace(/^<w:t(?:\s[^>]*)?>/, '').replace(/<\/w:t>$/, '');
        line += decodeXml(inner);
      } else if (/^<(?:a:blip|v:imagedata)\b/.test(tok)) {
        const relId = /\b(?:r:embed|r:id)="([^"]+)"/.exec(tok)?.[1];
        const mediaPath = relId && relTargets.get(relId);
        const media = mediaPath && parts[mediaPath];
        if (media) {
          const idx = images.length;
          images.push({
            kind: 'uploaded',
            page: 1,
            filename: path.posix.basename(mediaPath),
            buffer: Buffer.from(media),
          });
          markers.push({ idx, page: 1 });
          line += ` [IMG:${idx}] `;
        }
      } else {
        line += ' ';
      }
    }
    paras.push(line.replace(/\s+/g, ' ').trim());
  }
  return {
    text: paras.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    images,
    markers,
  };
}

function docxText(buf) {
  return docxSource(buf).text;
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
 * because both occur in the wild. Drawing images are anchored back to their
 * worksheet row and inserted as markers beside that row's question text.
 */
function xlsxSource(buf) {
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
    const rowNumber = Number(/\br="(\d+)"/.exec(rowXml)?.[1]) || rows.length + 1;
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
    if (line) rows.push({ row: rowNumber, text: line });
  }

  const sheetDir = path.posix.dirname(sheetName);
  const sheetRelsName = path.posix.join(sheetDir, '_rels', `${path.posix.basename(sheetName)}.rels`);
  const sheetRelsXml = parts[sheetRelsName] ? parts[sheetRelsName].toString('utf8') : '';
  const sheetRels = new Map();
  for (const match of sheetRelsXml.matchAll(/<Relationship\b[^>]*\/?\s*>/g)) {
    const tag = match[0];
    const id = /\bId="([^"]+)"/.exec(tag)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
    if (!id || !target || /\bTargetMode="External"/i.test(tag)) continue;
    let decoded = target.replace(/\\/g, '/');
    try { decoded = decodeURIComponent(decoded); } catch (_) {}
    const resolved = decoded.startsWith('/')
      ? path.posix.normalize(decoded.slice(1))
      : path.posix.normalize(path.posix.join(sheetDir, decoded));
    sheetRels.set(id, resolved);
  }

  const drawingId = /<drawing\b[^>]*\br:id="([^"]+)"/.exec(sheet)?.[1];
  const drawingName = drawingId && sheetRels.get(drawingId);
  const drawingXml = drawingName && parts[drawingName] ? parts[drawingName].toString('utf8') : '';
  const drawingRelsName = drawingName
    ? path.posix.join(path.posix.dirname(drawingName), '_rels', `${path.posix.basename(drawingName)}.rels`)
    : '';
  const drawingRelsXml = drawingRelsName && parts[drawingRelsName]
    ? parts[drawingRelsName].toString('utf8')
    : '';
  const drawingRels = new Map();
  for (const match of drawingRelsXml.matchAll(/<Relationship\b[^>]*\/?\s*>/g)) {
    const tag = match[0];
    const id = /\bId="([^"]+)"/.exec(tag)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
    if (!id || !target || /\bTargetMode="External"/i.test(tag)) continue;
    let decoded = target.replace(/\\/g, '/');
    try { decoded = decodeURIComponent(decoded); } catch (_) {}
    const resolved = decoded.startsWith('/')
      ? path.posix.normalize(decoded.slice(1))
      : path.posix.normalize(path.posix.join(path.posix.dirname(drawingName), decoded));
    drawingRels.set(id, resolved);
  }

  const images = [];
  const markers = [];
  const markersByRow = new Map();
  const anchors = drawingXml.match(/<xdr:(?:twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[\s\S]*?<\/xdr:(?:twoCellAnchor|oneCellAnchor|absoluteAnchor)>/g) || [];
  for (const anchor of anchors) {
    const row = Number(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/.exec(anchor)?.[1]);
    const relId = /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(anchor)?.[1];
    const mediaPath = relId && drawingRels.get(relId);
    const media = mediaPath && parts[mediaPath];
    if (!Number.isFinite(row) || !media) continue;
    const idx = images.length;
    images.push({ kind: 'uploaded', page: 1, filename: path.posix.basename(mediaPath), buffer: Buffer.from(media) });
    markers.push({ idx, page: 1 });
    if (!markersByRow.has(row + 1)) markersByRow.set(row + 1, []);
    markersByRow.get(row + 1).push(`[IMG:${idx}]`);
  }

  const rowMap = new Map(rows.map((item) => [item.row, item.text]));
  for (const row of markersByRow.keys()) if (!rowMap.has(row)) rowMap.set(row, '');
  const text = [...rowMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([row, rowText]) => [rowText, ...(markersByRow.get(row) || [])].filter(Boolean).join('\t'))
    .join('\n');
  return { text, images, markers };
}

function xlsxText(buf) {
  return xlsxSource(buf).text;
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
 * @returns {{format: string, text?: string, images?: object[], markers?: object[], questions?: object[]}}
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
    case 'docx': return { format, ...docxSource(buffer) };
    case 'xlsx': return { format, ...xlsxSource(buffer) };
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
  docxSource,
  xlsxText,
  xlsxSource,
  plainText,
};
