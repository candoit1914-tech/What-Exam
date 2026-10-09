'use strict';
require('./helpers/isolate');

// A question's figure is worth nothing if it only ever reaches the log. This
// file pins the two halves of "the student can see the diagram":
//
//   delivery — a picture that fails to send is RECORDED as owed (with its
//     error), retried on the next attempt, and sent with a signed public link
//     behind it so a Media-API refusal is not the end of the road;
//   import   — the note after an upload reports what was ATTACHED, which is a
//     different number from what the page scan found, and says in words when
//     a student's diagram quietly did not make it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const config = require('../src/config');
const auth = require('../src/auth');
const db = require('../src/db');
const wa = require('../src/services/whatsapp');
const exam = require('../src/services/exam');
const { attachmentSummary } = require('../src/services/pdfImport');

let seq = 0;
const phone = () => `233fs${++seq}${String(Date.now()).slice(-6)}`;

/** Run `fn` with the bot's chat stubbed out, restoring whatever it replaced. */
async function withChat(fn) {
  const originalText = wa.sendText;
  const originalImage = wa.sendImage;
  const calls = [];
  wa.sendText = async (p, text) => { calls.push({ type: 'text', text }); };
  wa.sendImage = async (p, file, opts) => { calls.push({ type: 'image', file, opts }); };
  try {
    await fn(calls);
  } finally {
    wa.sendText = originalText;
    wa.sendImage = originalImage;
  }
}

/** A live exam with one figure-carrying question and a student on it. */
function fixture(title) {
  const eid = db
    .prepare("INSERT INTO exams(title,duration_minutes,status) VALUES (?,30,'live')")
    .run(title).lastInsertRowid;
  const studentId = db.prepare('INSERT INTO students(phone) VALUES (?)').run(phone()).lastInsertRowid;
  const qid = db
    .prepare(
      `INSERT INTO questions(exam_id,q_order,type,text,marks,section_key)
       VALUES (?,1,'theory','Study the diagram.',5,'')`
    )
    .run(eid).lastInsertRowid;
  db.prepare("INSERT INTO question_images(question_id,position,image,kind) VALUES (?,?,?,'figure')")
    .run(qid, 0, 'fig-sent.png');
  const session = exam.createSession(eid, studentId);
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
  return { eid, qid, session, student };
}

// ── delivery ──────────────────────────────────────────────────────────

test('a figure that fails to send is owed, not lost — and the question still goes out', async () => {
  const { session, student } = fixture('FigSendFails');
  const originalText = wa.sendText;
  const originalImage = wa.sendImage;
  const texts = [];
  try {
    wa.sendText = async (p, text) => { texts.push(text); };
    wa.sendImage = async () => { throw new Error('Media API refused the upload'); };
    await exam.sendQuestionTo(session, student);
  } finally {
    wa.sendText = originalText;
    wa.sendImage = originalImage;
  }

  assert.ok(texts.some((t) => /Study the diagram\./.test(t)), 'the question text still reached the student');
  const row = db
    .prepare("SELECT * FROM message_outbox WHERE session_id = ? AND kind = 'figure'")
    .get(session.id);
  assert.ok(row, 'the failed attempt was recorded');
  assert.equal(row.state, 'queued', 'queued so the next message can carry it');
  assert.match(row.error, /Media API refused the upload/, 'with the reason it failed');

  // ...and the retry that follows once the gateway works again.
  await withChat(async (calls) => {
    await exam.deliverOwedFigures(session);
    assert.deepEqual(
      calls.filter((c) => c.type === 'image').map((c) => path.basename(c.file)),
      ['fig-sent.png'],
      'the owed figure goes out on the next attempt'
    );
  });
  const after = db
    .prepare("SELECT * FROM message_outbox WHERE session_id = ? AND kind = 'figure'")
    .get(session.id);
  assert.equal(after.state, 'sent', 'and the debt is retired');
});

test('every figure also carries a signed public link as a fallback transport', async () => {
  const { session, student } = fixture('FigLink');
  await withChat(async (calls) => {
    await exam.sendQuestionTo(session, student);
    const images = calls.filter((c) => c.type === 'image');
    assert.equal(images.length, 1, 'the figure went out');
    const url = new URL(images[0].opts.publicUrl, 'http://fallback.invalid');
    assert.ok(url.pathname.endsWith('/figure/fig-sent.png'), 'pointing at the public figure route');
    const token = url.searchParams.get('token');
    assert.ok(token, 'and signed');
    assert.ok(auth.verifyFigureToken(token, 'fig-sent.png'), 'the signature names exactly this file');
    assert.ok(!auth.verifyFigureToken(token, 'some-other.png'), 'and cannot be replayed for another file');
    assert.ok(!auth.verifyFigureToken('forged.token', 'fig-sent.png'), 'a forged token is refused');
  });
});

test('one figure record per question, and nothing left owed after it is sent', async () => {
  const { qid, session, student } = fixture('FigNoDouble');
  await withChat(async () => {
    await exam.sendQuestionTo(session, student);
  });
  await withChat(async (calls) => {
    await exam.deliverOwedFigures(session);
    assert.equal(calls.filter((c) => c.type === 'image').length, 0, 'nothing left owed');
  });
  const rows = db
    .prepare("SELECT COUNT(*) c FROM message_outbox WHERE session_id = ? AND question_id = ? AND kind = 'figure'")
    .get(session.id, qid);
  assert.equal(rows.c, 1, 'one record per question, not one per attempt');
});

// ── the bytes themselves ──────────────────────────────────────────────

test('a figure whose file is gone says so, instead of blaming WhatsApp', async () => {
  const missing = path.join(config.uploadsDir, `never-written-${Date.now()}.png`);
  await assert.rejects(() => wa.sendImage('233000000001', missing), /missing from disk/);
  await assert.rejects(() => wa.sendImage('233000000001', Buffer.alloc(0)), /empty/);
});

test('imageMediaType reads what the bytes actually are', () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(20)]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.equal(wa.imageMediaType(png), 'image/png');
  assert.equal(wa.imageMediaType(jpeg), 'image/jpeg');
  assert.equal(wa.imageMediaType(Buffer.from('not an image at all, honestly')), '');
  assert.equal(wa.imageMediaType('not a buffer'), '');
});

test('the link fallback is only offered where WhatsApp can actually fetch it', () => {
  assert.ok(wa.linkUsable('https://what-exam.onrender.com/figure/a.png?token=x'), 'a public HTTPS URL');
  assert.ok(!wa.linkUsable('http://localhost:3000/figure/a.png?token=x'), 'localhost is unreachable from Meta');
  assert.ok(!wa.linkUsable('https://localhost/figure/a.png?token=x'), 'even over TLS');
  assert.ok(!wa.linkUsable('http://what-exam.onrender.com/figure/a.png?token=x'), 'WhatsApp only fetches HTTPS');
  assert.ok(!wa.linkUsable('not a url'), 'and nonsense is refused rather than sent');
});

test('the public figure route serves a signed file and refuses everything else', async () => {
  const fs = require('node:fs');

  await withServer(async (base) => {
    const name = `route-test-${Date.now()}.png`;
    fs.writeFileSync(path.join(config.uploadsDir, name), Buffer.from('89504e470d0a1a0a', 'hex'));

    const signed = await get(`${base}/figure/${name}?token=${encodeURIComponent(auth.figureToken(name))}`);
    assert.equal(signed.status, 200, `a valid signature serves the file: ${signed.body.toString('utf8').slice(0, 400)}`);
    assert.match(signed.type || '', /image\/png/, 'as an image, so WhatsApp renders it');

    const unsigned = await get(`${base}/figure/${name}`);
    assert.equal(unsigned.status, 403, 'without a signature it is refused');

    const other = await get(`${base}/figure/${name}?token=${encodeURIComponent(auth.figureToken('another-file.png'))}`);
    assert.equal(other.status, 403, 'and a signature for a different file does not transfer');

    const traversal = await get(`${base}/figure/..%2Fexams.db?token=${encodeURIComponent(auth.figureToken('exams.db'))}`);
    assert.equal(traversal.status, 400, 'a file that is not a figure is not even looked up');

    fs.unlinkSync(path.join(config.uploadsDir, name));
    const gone = await get(`${base}/figure/${name}?token=${encodeURIComponent(auth.figureToken(name))}`);
    assert.equal(gone.status, 404, 'a signed link to a file that has since vanished is a 404, not a 500');

    try { fs.unlinkSync(path.join(config.uploadsDir, name)); } catch {}
  });
});

// res.sendFile() returns undefined in Express 4, so chaining `.sendFile(x)
// .on('error')` threw a TypeError and answered every attachment request with a
// 500 — figures in the result report included. Pinned so it cannot come back.
test('the report attachment route serves its picture instead of 500ing', async () => {
  const fs = require('node:fs');
  const sid = 991;

  await withServer(async (base) => {
    const name = `report-test-${Date.now()}.png`;
    fs.writeFileSync(path.join(config.uploadsDir, name), Buffer.from('89504e470d0a1a0a', 'hex'));
    const url = (file, token) =>
      `${base}/report/${sid}/attachment?file=${encodeURIComponent(file)}&token=${encodeURIComponent(token)}`;

    const ok = await get(url(name, auth.reportToken(sid)));
    assert.equal(ok.status, 200, `a signed attachment is served: ${ok.body.toString('utf8').slice(0, 300)}`);

    const missing = await get(url(`gone-${Date.now()}.png`, auth.reportToken(sid)));
    assert.equal(missing.status, 404, 'a file that is not there is a 404');

    const forged = await get(url(name, 'not-a-token'));
    assert.equal(forged.status, 403, 'and an unsigned request is refused');

    try { fs.unlinkSync(path.join(config.uploadsDir, name)); } catch {}
  });
});

/** Boot the real app on an ephemeral port, hand `fn` its base URL, close it. */
async function withServer(fn) {
  const http = require('node:http');
  const app = require('../src/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function get(url) {
  const http = require('node:http');
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) })
        );
      })
      .on('error', reject);
  });
}

// ── the import note ───────────────────────────────────────────────────

test('the import note reports what was ATTACHED, not what the scan found', () => {
  const diag = {
    figures: { pages: 1, kept: 2, candidates: { raster: 1, vector: 1 }, dropped: {}, visionRecovered: 0 },
  };

  assert.match(
    attachmentSummary({ requested: 2, attached: 2, failures: [], diagnostics: diag }),
    /Found 2 images or diagrams across 1 page and attached each to its question/,
    'a clean import still says the figures are on their questions'
  );

  const none = attachmentSummary({ requested: 2, attached: 0, failures: ['x.png: ENOENT'], diagnostics: diag });
  assert.match(none, /none could be rendered/, 'a renderer that produced nothing owns the sentence');
  assert.match(none, /ENOENT/, 'with the reason');
  assert.match(none, /WITHOUT their figures/, 'and the consequence for the student');

  assert.match(
    attachmentSummary({ requested: 2, attached: 1, failures: ['y.png: boom'], diagnostics: diag }),
    /Attached 1 of 2 images or diagrams.*?could not be rendered \(y\.png: boom\)/s,
    'a partial attach is reported as partial'
  );

  assert.match(
    attachmentSummary({ requested: 0, attached: 0, failures: [], diagnostics: diag }),
    /no saved question references them/,
    'figures nobody references are not announced as delivered'
  );

  assert.match(
    attachmentSummary({
      requested: 0, attached: 0, failures: [],
      diagnostics: { figures: { pages: 3, kept: 0, candidates: { raster: 0, vector: 0 }, dropped: {} } },
    }),
    /No images or diagrams were found in this PDF \(3 pages scanned\)/,
    'and a paper with no figures says exactly that'
  );
});
