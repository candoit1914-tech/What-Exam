'use strict';
require('./helpers/isolate');

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const db = require('../src/db');
const auth = require('../src/auth');
const api = require('../src/routes/api');
const { readZip } = require('./zip-read');

let server;
let base;
let token;
let examId;

function request(method, path_, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${path_}`,
      { method, headers: { authorization: `Bearer ${token}`, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { /* not json */ }
          resolve({ status: res.statusCode, headers: res.headers, buffer: buf, text, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function newExam() {
  return db
    .prepare("INSERT INTO exams (title, duration_minutes, status, pass_percentage) VALUES ('__roster_route__',30,'published',50)")
    .run().lastInsertRowid;
}

// multipart/form-data built by hand, so no new dependency appears for one test.
function multipart(fieldName, filename, contentType, content) {
  const boundary = '----rosterwatermarktest';
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`, 'utf8');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    body: Buffer.concat([head, content, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function postFile(contentType, body) {
  return request('POST', '/api/watermark-logo', {
    headers: { 'content-type': contentType, 'content-length': body.length }, body,
  });
}

// Deliberately NOT src/public/icon.svg: that file is the watermark service's
// default source, so re-uploading it would leave the served bytes identical and
// the "a custom logo changes the served watermark" assertion would prove nothing.
// This is the same distinct 3:1 mark test/watermark.test.js uses.
const CUSTOM_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100" viewBox="0 0 300 100">' +
  '<rect width="300" height="100" fill="#ffffff"/>' +
  '<circle cx="60" cy="50" r="36" fill="#25D366"/>' +
  '<rect x="120" y="26" width="150" height="48" rx="10" fill="#0a5c36"/>' +
  '</svg>', 'utf8');
const customSvg = () => multipart('file', 'custom.svg', 'image/svg+xml', CUSTOM_SVG);

before(async () => {
  token = auth.adminToken();
  const app = express();
  app.use(express.json());
  app.use('/api', api);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  examId = newExam();
});

// Every test starts from the app's default watermark, so the suite is
// order-independent: node:test runs the cases in one process against one
// uploadsDir, and without this an upload in one case would leak into the next.
beforeEach(async () => { await request('DELETE', '/api/watermark-logo'); });

after(() => { server?.close(); });

test('the section param is honoured and junk falls back to total', async () => {
  const junk = await request('GET', `/api/exams/${examId}/participants/print?section=constructor`);
  assert.equal(junk.status, 200, junk.text);
  assert.ok(!junk.text.includes('Section:'), 'an inherited-property key must fall back to total');
  const filtered = await request('GET', `/api/exams/${examId}/participants/print?section=not_sent`);
  assert.ok(filtered.text.includes('Section: Not sent'), 'the stamp must name the selected section');
  assert.ok(!filtered.text.includes('<h2'), 'group headings were removed; none may leak back');
  // This exam has no recipients, so the one selected group renders its
  // empty-state row rather than a table. That is exactly one group's worth of
  // output and nothing from the other three.
  assert.ok(filtered.text.includes('class="none"'), 'the empty group must say so');
});

test('the removed csv route 404s rather than lingering half-deleted', async () => {
  const gone = await request('GET', `/api/exams/${examId}/participants.csv`);
  assert.equal(gone.status, 404, 'the CSV export was removed; the path must not answer');
});

test('the docx is sent as an attachment with a section-aware filename', async () => {
  const filtered = await request('GET', `/api/exams/${examId}/participants.docx?section=not_sent`);
  assert.equal(filtered.status, 200, filtered.text);
  const cd = filtered.headers['content-disposition'];
  assert.ok(cd.includes('attachment'), cd);
  assert.ok(cd.includes('Not-sent'), `filename must name the section: ${cd}`);
  const plain = await request('GET', `/api/exams/${examId}/participants.docx`);
  assert.ok(plain.headers['content-disposition'].includes(`participants-${examId}.docx`),
    plain.headers['content-disposition']);
});

test('the docx is a real zip attachment with all nine parts', async () => {
  const res = await request('GET', `/api/exams/${examId}/participants.docx?section=not_sent`);
  assert.equal(res.status, 200, res.text);
  assert.ok(res.headers['content-type'].includes('wordprocessingml.document'), res.headers['content-type']);
  assert.ok(res.headers['content-disposition'].includes('.docx'));
  assert.equal(res.buffer.readUInt32LE(0), 0x04034b50, 'zip local header magic');
  assert.equal(readZip(res.buffer).size, 9);
});

test('the print page renders server-side with the watermark inlined', async () => {
  const res = await request('GET', `/api/exams/${examId}/participants/print?section=not_sent`);
  assert.equal(res.status, 200);
  assert.ok(res.headers['content-type'].includes('text/html'));
  assert.ok(res.text.startsWith('<!DOCTYPE html>'));
  assert.ok(res.text.includes('data:image/png;base64,'), 'watermark must be inlined, not linked');
  assert.ok(res.text.includes('Section: Not sent'));
});

test('watermark status reports custom=false and a preview url', async () => {
  const res = await request('GET', '/api/watermark-logo');
  assert.equal(res.status, 200);
  assert.equal(res.body.custom, false);
  assert.ok(res.body.url, 'the UI needs a url for the current mark either way');
});

test('the preview serves real png bytes at the watermark size', async () => {
  const res = await request('GET', '/api/watermark-logo.png');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'png magic');
  assert.equal(res.buffer.readUInt32BE(16), 700, 'png width from IHDR');
  assert.equal(res.buffer.readUInt32BE(20), 700, 'png height from IHDR');
});

test('uploading a custom logo flips custom to true and changes the served bytes', async () => {
  const before = (await request('GET', '/api/watermark-logo.png')).buffer;
  const m = customSvg();
  const up = await postFile(m.contentType, m.body);
  assert.equal(up.status, 201, `a newly stored logo is a new resource: ${up.text}`);
  assert.equal(up.body.custom, true);
  const after = (await request('GET', '/api/watermark-logo.png')).buffer;
  // Never notDeepEqual on multi-KB buffers: on a mismatch node walks and diffs
  // them, which costs tens of seconds. `.equals()` is a length check plus memcmp.
  assert.ok(!after.equals(before), 'a custom logo must change the served watermark');
  assert.equal(after.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'stored bytes must be a real png, never raw svg');
  // Storing the same bytes again is a no-op, not a new version.
  const again = await postFile(m.contentType, m.body);
  assert.equal(again.status, 200, 'byte-identical bytes must not be reported as a new upload');
  assert.ok((await request('GET', '/api/watermark-logo.png')).buffer.equals(after),
    'an identical re-upload must not change the served bytes');
});

test('a non-image upload is rejected with 400 and leaves no file behind', async () => {
  const m = multipart('file', 'x.gif', 'image/gif', Buffer.from('GIF87a nope'));
  const up = await postFile(m.contentType, m.body);
  assert.equal(up.status, 400, `expected 400, got ${up.status}: ${up.text}`);
  assert.equal((await request('GET', '/api/watermark-logo')).body.custom, false);
});

test('bytes that lie about being a png are rejected, not stored', async () => {
  // Declares image/png but is not a PNG. The mimetype filter passes, so the
  // sharp decode is the only thing between this and a stored file.
  const m = multipart('file', 'fake.png', 'image/png', Buffer.from('definitely not a png'));
  const up = await postFile(m.contentType, m.body);
  assert.equal(up.status, 400, `expected 400, got ${up.status}: ${up.text}`);
  assert.equal((await request('GET', '/api/watermark-logo')).body.custom, false);
});

test('an upload with no file at all is a 400', async () => {
  const res = await request('POST', '/api/watermark-logo');
  assert.equal(res.status, 400, `expected 400, got ${res.status}`);
});

test('delete reverts to the default watermark, and twice is not a 500', async () => {
  const m = customSvg();
  await postFile(m.contentType, m.body);
  const del = await request('DELETE', '/api/watermark-logo');
  assert.equal(del.status, 200);
  assert.equal(del.body.custom, false);
  const again = await request('DELETE', '/api/watermark-logo');
  assert.equal(again.status, 200, 'deleting twice must not 500');
});

test('every export and watermark route requires the admin token', async () => {
  const paths = [
    ['GET', `/api/exams/${examId}/participants`],
    ['GET', `/api/exams/${examId}/participants/print`],
    ['GET', `/api/exams/${examId}/participants.docx`],
    ['GET', '/api/watermark-logo'],
    ['GET', '/api/watermark-logo.png'],
    ['POST', '/api/watermark-logo'],
    ['DELETE', '/api/watermark-logo'],
  ];
  for (const [method, p] of paths) {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(`${base}${p}`, { method }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 401, `${method} ${p} must be protected`);
  }
});

test('a missing exam is a 404, not a 500', async () => {
  assert.equal((await request('GET', '/api/exams/999999/participants/print')).status, 404);
  assert.equal((await request('GET', '/api/exams/999999/participants.docx')).status, 404);
});
