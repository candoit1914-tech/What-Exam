// Multi-format upload: the extractor downstream only wants exam text, so every
// format converges on the same shape and only the reader differs.
const test = require('node:test');
const assert = require('node:assert');

const { buildZip, readZip } = require('../src/services/zip');
const {
  SUPPORTED_EXTENSIONS, formatOf, readExamSource,
  docxText, xlsxText, plainText, parseQuestionsJson,
} = require('../src/services/document');

test('formatOf reads the extension, ignoring case and query strings', () => {
  assert.equal(formatOf('paper.pdf'), 'pdf');
  assert.equal(formatOf('PAPER.PDF'), 'pdf');
  assert.equal(formatOf('notes.txt'), 'txt');
  assert.equal(formatOf('notes.text'), 'txt');
  assert.equal(formatOf('paper.docx'), 'docx');
  assert.equal(formatOf('sheet.xlsx'), 'xlsx');
  assert.equal(formatOf('bank.json'), 'json');
  assert.equal(formatOf('legacy.doc'), null, 'legacy .doc is deliberately not supported');
  assert.equal(formatOf('archive.zip'), null);
  assert.equal(formatOf('noextension'), null);
  assert.equal(formatOf(''), null);
  assert.ok(SUPPORTED_EXTENSIONS.includes('.docx'));
});

test('readZip walks the central directory and inflates payloads', () => {
  const payload = 'x'.repeat(500); // long enough that deflate actually shrinks it
  const buf = buildZip([
    { name: 'word/document.xml', data: Buffer.from(payload) },
    { name: 'loose.txt', data: Buffer.from('stored or deflated') },
  ]);
  const back = readZip(buf);
  assert.equal(Object.keys(back).length, 2);
  assert.equal(back['word/document.xml'].toString('utf8'), payload);
  assert.equal(back['loose.txt'].toString('utf8'), 'stored or deflated');
});

test('readZip fails loudly on a file that is not a ZIP', () => {
  assert.throws(() => readZip(Buffer.from('nope')), /too short/);
  assert.throws(() => readZip(Buffer.alloc(64)), /no end-of-central-directory record/);
});

test('docxText joins the runs of one paragraph, not every run', () => {
  // Word splits a paragraph across many <w:t> runs; per-run assembly would
  // shatter a question into fragments the parser reads as separate questions.
  const docXml = [
    '<?xml version="1.0"?>',
    '<w:document xmlns:w="x"><w:body>',
    '<w:p><w:r><w:t>English Language 2026</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>1. Which to</w:t></w:r><w:r><w:t>wn hosts the feast?</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>A. Kumasi</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>B. Accra</w:t></w:r></w:p>',
    '<w:p/>',
    '<w:p><w:r><w:t>2. The &amp; best &lt;town&gt;</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>continues?</w:t></w:r></w:p>',
    '</w:body></w:document>',
  ].join('');
  const buf = buildZip([{ name: 'word/document.xml', data: Buffer.from(docXml) }]);
  const text = docxText(buf);
  assert.match(text, /1\. Which town hosts the feast\?/, 'runs of one paragraph are joined');
  assert.match(text, /A\. Kumasi/, 'the tab between options becomes spacing, not a merge');
  assert.ok(!/KumasiB\./.test(text), 'options do not run together');
  assert.match(text, /2\. The & best <town> continues\?/, 'XML entities decode, br becomes spacing');
  assert.ok(!/<w:/.test(text), 'no markup leaks into the text');
  assert.ok(!/\n{3,}/.test(text), 'empty paragraphs do not pile up');
});

test('docxText rejects a ZIP that is not a Word document', () => {
  const buf = buildZip([{ name: 'xl/workbook.xml', data: Buffer.from('<x/>') }]);
  assert.throws(() => docxText(buf), /word\/document\.xml is missing/);
});

test('xlsxText reads rows with shared strings, inline strings and sparse refs', () => {
  const shared = '<sst><si><t>1. Which town hosts the feast?</t></si>'
    + '<si><t>A. Kumasi</t></si><si><t>B. Accra</t></si></sst>';
  const sheet = '<worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="s"><v>2</v></c></row>'
    + '<row r="3"><c r="A3" t="inlineStr"><is><t>C. Tamale</t></is></c><c r="C3"><v>42</v></c></row>'
    + '</sheetData></worksheet>';
  const buf = buildZip([
    { name: 'xl/sharedStrings.xml', data: Buffer.from(shared) },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet) },
  ]);
  const text = xlsxText(buf);
  const lines = text.split('\n');
  assert.equal(lines[0], '1. Which town hosts the feast?');
  // Row 2 keeps its two columns; the empty B cell of row 1 must not shift rows.
  assert.equal(lines[1], 'A. Kumasi\tB. Accra');
  // r="C3" places 42 in the third column even though column B was empty.
  assert.equal(lines[2], 'C. Tamale\t\t42');
});

test('xlsxText rejects a ZIP with no worksheet', () => {
  const buf = buildZip([{ name: 'xl/workbook.xml', data: Buffer.from('<x/>') }]);
  assert.throws(() => xlsxText(buf), /no worksheet found/);
});

test('plainText strips a BOM and normalises line endings and blank runs', () => {
  assert.equal(plainText(Buffer.from('\uFEFF1. Q?\r\nA. X\r\n\r\n\r\n2. Q2?')), '1. Q?\nA. X\n\n2. Q2?');
});

test('readExamSource routes each format and refuses an unknown one', () => {
  assert.equal(readExamSource(Buffer.from('x'), 'a.pdf').format, 'pdf');
  assert.equal(readExamSource(Buffer.from('x'), 'a.txt').text, 'x');
  assert.throws(() => readExamSource(Buffer.from('x'), 'a.pptx'), /Unsupported file type/);
  assert.throws(() => readExamSource(Buffer.from('x'), 'noext'), /Unsupported file type/);
});

test('parseQuestionsJson accepts the shapes a person actually writes', () => {
  // Bare array, loose field names, options implied by presence of choices.
  const fromArray = parseQuestionsJson(
    Buffer.from(JSON.stringify([{ question: 'Which town?', choices: ['Kumasi', 'Accra'], answer: 'A' }])),
    'a.json'
  );
  assert.equal(fromArray.length, 1);
  assert.equal(fromArray[0].type, 'objective', 'choices imply objective');
  assert.equal(fromArray[0].text, 'Which town?');
  assert.equal(fromArray[0].correct_answer, 'A');
  assert.equal(fromArray[0].number, 1);
  assert.ok(fromArray[0]._imported, 'the save loop is told this row is authored, not parsed');

  // Wrapped {questions:[…]}, string follow-ups and object follow-ups.
  const wrapped = parseQuestionsJson(
    Buffer.from(JSON.stringify({ questions: [
      { text: 'Write a letter.', type: 'theory', number: 3, parts: ['(a) intro', { text: 'body', marks: 3 }] },
    ] })),
    'b.json'
  );
  assert.equal(wrapped[0].type, 'theory');
  assert.equal(wrapped[0].number, 3);
  assert.deepEqual(wrapped[0].follow_ups.map((f) => f.text), ['(a) intro', 'body']);
  assert.equal(wrapped[0].follow_ups[1].marks, 3);

  // A single object is a one-question file, not an error.
  const single = parseQuestionsJson(Buffer.from(JSON.stringify({ text: 'Only one?' })), 'c.json');
  assert.equal(single.length, 1);
});

test('parseQuestionsJson refuses files that hold no askable question', () => {
  assert.throws(
    () => parseQuestionsJson(Buffer.from('{not json'), 'bad.json'),
    /not valid JSON/
  );
  assert.throws(
    () => parseQuestionsJson(Buffer.from(JSON.stringify({ title: 'nothing' })), 'empty.json'),
    /no usable questions|holds no questions/
  );
  assert.throws(
    () => parseQuestionsJson(Buffer.from('"just a string"'), 'scalar.json'),
    /holds no questions/
  );
  assert.throws(
    () => parseQuestionsJson(Buffer.from(JSON.stringify([{ options: ['A', 'B'] }])), 'notext.json'),
    /missing question text/
  );
});
