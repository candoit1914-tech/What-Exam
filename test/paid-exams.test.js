'use strict';
require('./helpers/isolate');

// The admin's free/paid switch on a paper.
//
// Two properties are being pinned here, and they pull in opposite directions:
//   1. a PAID paper must not leak a single question before Paystack says the
//      money landed — not at send time, not on the first "hello", not through a
//      forged webhook;
//   2. a FREE paper must not notice this feature exists: same invite, same
//      timing, same single message, no payment rows and no network calls.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');

const db = require('../src/db');
const config = require('../src/config');
const auth = require('../src/auth');
const api = require('../src/routes/api');
const paystackWebhook = require('../src/routes/paystackWebhook');
const exam = require('../src/services/exam');
const payments = require('../src/services/payments');
const wa = require('../src/services/whatsapp');

const SECRET = 'sk_test_paid_exams';
const realSendText = wa.sendText;
const realFetch = global.fetch;

let server;
let base;
let token;
let sent = [];
let seq = 0;

// ── helpers ───────────────────────────────────────────────────────────

/** Capture everything the bot would say, so a test can read the conversation. */
function capture() {
  sent = [];
  wa.sendText = async (phone, text) => {
    sent.push(text);
    return { messages: [{ id: 'mock' }] };
  };
}

/** isolate.js points global.fetch at a throwing stub; this is the gateway. */
function stubFetch(handler) {
  global.fetch = async (url, opts = {}) => handler(String(url), opts);
}

function jsonResponse(status, body) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

/**
 * A fake Paystack. `verifyStatus` is what the verify endpoint reports, which is
 * how a student whose webhook never arrived gets unlocked on their next reply.
 */
function paystackStub({ verifyStatus = 'pending' } = {}) {
  stubFetch((url, opts) => {
    if (url.endsWith('/transaction/initialize')) {
      const body = JSON.parse(opts.body);
      return jsonResponse(200, {
        status: true,
        data: {
          reference: body.reference,
          access_code: 'ac',
          authorization_url: `https://checkout.paystack.com/${body.reference}`,
        },
      });
    }
    if (url.includes('/transaction/verify/')) {
      const reference = decodeURIComponent(url.split('/').pop());
      const row = db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
      return jsonResponse(200, {
        status: true,
        data: {
          status: verifyStatus,
          reference,
          amount: row ? row.amount : 0,
          currency: row ? row.currency : 'GHS',
          channel: 'mobile_money',
          paid_at: '2026-10-07T09:00:00.000Z',
        },
      });
    }
    throw new Error(`unexpected gateway call: ${url}`);
  });
}

function makeExam({ pricing = 'free', amount = 0, status = 'live' } = {}) {
  return db
    .prepare(
      `INSERT INTO exams (title, duration_minutes, status, pricing, price_amount)
       VALUES ('Paywall Paper', 30, ?, ?, ?)`
    )
    .run(status, pricing, amount).lastInsertRowid;
}

function addStudent(eid) {
  const phone = `233pay${++seq}${String(eid).padStart(4, '0')}`;
  const sid = db.prepare('INSERT INTO students(phone) VALUES (?)').run(phone).lastInsertRowid;
  db.prepare('INSERT INTO exam_recipients(exam_id, student_id) VALUES (?,?)').run(eid, sid);
  // Two questions on purpose: answering the last one finalises the session,
  // which would drag results/AI into a test that is about the paywall.
  for (const order of [1, 2]) {
    db.prepare(
      `INSERT INTO questions(exam_id, q_order, type, text, options, correct_answer)
       VALUES (?, ?, 'objective', ?, ?, 'A')`
    ).run(eid, order, `Q${order}`, JSON.stringify([{ key: 'A', text: 'Yes' }, { key: 'B', text: 'No' }]));
  }
  return db.prepare('SELECT * FROM students WHERE id=?').get(sid);
}

function sessionFor(eid, sid) {
  return db.prepare('SELECT * FROM sessions WHERE exam_id = ? AND student_id = ?').get(eid, sid);
}

function paymentsFor(eid) {
  return db.prepare('SELECT * FROM payments WHERE exam_id = ? ORDER BY id').all(eid);
}

function request(method, path_, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const h = {
      authorization: `Bearer ${token}`,
      ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      ...headers,
    };
    const req = http.request(`${base}${path_}`, { method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* not json */ }
        resolve({ status: res.statusCode, body: parsed, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sign = (raw) => crypto.createHmac('sha512', SECRET).update(raw, 'utf8').digest('hex');

function postWebhook(raw, signature) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(raw, 'utf8');
    const headers = { 'content-type': 'application/json', 'content-length': payload.length };
    if (signature !== null) headers['x-paystack-signature'] = signature;
    const req = http.request(`${base}/webhook/paystack`, { method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function waitFor(predicate, what, ms = 3000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

before(async () => {
  config.paystack.secretKey = SECRET;
  config.paystack.baseUrl = 'https://api.paystack.test';
  config.paystack.currency = 'GHS';
  token = auth.adminToken();

  const app = express();
  // Same ordering as server.js: the webhook sees the raw bytes it signed.
  app.use('/webhook/paystack', paystackWebhook);
  app.use(express.json());
  app.use('/api', api);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  wa.sendText = realSendText;
  global.fetch = realFetch;
  if (server) server.close();
});

// ── the admin's choice ────────────────────────────────────────────────

test('an exam is free unless the admin says otherwise', async () => {
  const res = await request('POST', '/api/exams', { body: { title: 'No price set' } });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT pricing, price_amount FROM exams WHERE id = ?').get(res.body.id);
  assert.equal(row.pricing, 'free');
  assert.equal(row.price_amount, 0);
});

test('a paid exam stores the admin amount in pesewas', async () => {
  const res = await request('POST', '/api/exams', {
    body: { title: 'Priced', pricing: 'paid', amount: '10' },
  });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT pricing, price_amount FROM exams WHERE id = ?').get(res.body.id);
  assert.equal(row.pricing, 'paid');
  assert.equal(row.price_amount, 1000, 'GHS 10 is 1000 pesewas — the integer Paystack charges');
});

test('a paid exam with no amount is refused rather than sold for free', async () => {
  const res = await request('POST', '/api/exams', { body: { title: 'Broken', pricing: 'paid', amount: 0 } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /amount/i);
});

// ── free papers are untouched ─────────────────────────────────────────

test('a free exam sends exactly one message and books nothing', async () => {
  capture();
  paystackStub(); // present only to prove it is never called
  const eid = makeExam();
  addStudent(eid);

  const report = await exam.sendExamToRecipients(eid);

  assert.equal(report.sent, 1);
  assert.equal(sent.length, 1, 'the free invite is the only message that goes out');
  assert.ok(sent[0].includes('INSTRUCTIONS'), 'the normal invite is delivered');
  assert.ok(!/paystack|payment/i.test(sent[0]), 'no paywall language on a free paper');
  assert.equal(paymentsFor(eid).length, 0, 'no payment row is ever created');
});

// ── paid papers ───────────────────────────────────────────────────────

test('a paid exam sends the invite and a checkout link behind it', async () => {
  capture();
  paystackStub();
  const eid = makeExam({ pricing: 'paid', amount: 1000 });
  addStudent(eid);

  const report = await exam.sendExamToRecipients(eid);

  assert.equal(report.sent, 1, 'still one recipient, one delivery report entry');
  assert.equal(sent.length, 2, 'invite first, payment link second');
  assert.ok(sent[0].includes('INSTRUCTIONS'), 'the invite itself is unchanged');
  assert.match(sent[1], /checkout\.paystack\.com/, 'the second message is the Paystack link');
  assert.ok(sent[1].includes('GHS 10'), 'the message says what it costs');

  const [payment] = paymentsFor(eid);
  assert.equal(payment.status, 'pending');
  assert.equal(payment.amount, 1000);
  assert.equal(payment.currency, 'GHS');
});

test('a paid exam with no secret key is refused instead of sending a dead link', async () => {
  capture();
  config.paystack.secretKey = '';
  try {
    const eid = makeExam({ pricing: 'paid', amount: 500 });
    addStudent(eid);
    const res = await request('POST', `/api/exams/${eid}/send`);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /PAYSTACK_SECRET_KEY/);
    assert.equal(sent.length, 0, 'nothing may go out without a gateway behind it');
    assert.equal(paymentsFor(eid).length, 0);
  } finally {
    config.paystack.secretKey = SECRET;
  }
});

test('until the money lands the reply gets the link, the clock and question 1 stay home', async () => {
  capture();
  paystackStub();
  const eid = makeExam({ pricing: 'paid', amount: 1000 });
  const student = addStudent(eid);
  await exam.sendExamToRecipients(eid);
  sent.length = 0;

  const outcome = await exam.handleInbound(student.phone, 'start');

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'payment_required');
  assert.ok(sent.some((m) => /checkout\.paystack\.com/.test(m)), 'the link is re-sent on every reply');
  assert.ok(!sent.some((m) => m.includes('QUESTION 1')), 'no question may be handed over unpaid');
  assert.equal(sessionFor(eid, student.id).started_at, null, 'the countdown must not be armed');
});

test('a forged webhook signature is rejected and unlocks nothing', async () => {
  capture();
  const eid = makeExam({ pricing: 'paid', amount: 1000 });
  const student = addStudent(eid);
  db.prepare(
    `INSERT INTO payments (exam_id, student_id, reference, amount, currency, status, authorization_url)
     VALUES (?,?,?,?, 'GHS', 'pending', 'https://checkout.paystack.com/x')`
  ).run(eid, student.id, 'ref-forged', 1000);

  const raw = JSON.stringify({
    event: 'charge.success',
    data: { reference: 'ref-forged', amount: 1000, currency: 'GHS', channel: 'card' },
  });

  const forged = await postWebhook(raw, 'deadbeef'.repeat(16));
  assert.equal(forged.status, 401);
  const unsigned = await postWebhook(raw, null);
  assert.equal(unsigned.status, 401, 'an unsigned event is not a Paystack event');

  assert.equal(db.prepare('SELECT status FROM payments WHERE reference = ?').get('ref-forged').status, 'pending');
  assert.equal(sent.length, 0);
});

test('a signed charge webhook marks the payment and opens the paper by itself', async () => {
  capture();
  paystackStub();
  const eid = makeExam({ pricing: 'paid', amount: 1000 });
  const student = addStudent(eid);
  await exam.sendExamToRecipients(eid);
  const [payment] = paymentsFor(eid);
  sent.length = 0;

  const raw = JSON.stringify({
    event: 'charge.success',
    data: {
      reference: payment.reference,
      amount: 1000,
      currency: 'GHS',
      channel: 'mobile_money',
      paid_at: '2026-10-07T09:00:00.000Z',
    },
  });
  const res = await postWebhook(raw, sign(raw));
  assert.equal(res.status, 200, 'Paystack must be acknowledged even though the sends happen after');
  assert.equal(db.prepare('SELECT status FROM payments WHERE id = ?').get(payment.id).status, 'paid');

  await waitFor(
    () => sent.some((m) => m.includes('Payment received')) && sent.some((m) => m.includes('QUESTION 1')),
    'the confirmation and question 1'
  );

  // From here the student is an ordinary student again.
  const outcome = await exam.handleInbound(student.phone, 'A');
  assert.ok(['answered', 'started'].includes(outcome.reason), `got ${outcome.reason}`);
  assert.notEqual(outcome.reason, 'payment_required');
});

test('a second copy of the same webhook does not send anything again', async () => {
  capture();
  paystackStub();
  const eid = makeExam({ pricing: 'paid', amount: 1000 });
  const student = addStudent(eid);
  await exam.sendExamToRecipients(eid);
  const [payment] = paymentsFor(eid);
  sent.length = 0;

  const raw = JSON.stringify({
    event: 'charge.success',
    data: { reference: payment.reference, amount: 1000, currency: 'GHS', channel: 'card' },
  });
  await postWebhook(raw, sign(raw));
  await waitFor(() => sent.length > 0, 'the first unlock');
  const afterFirst = sent.slice();

  const replay = await postWebhook(raw, sign(raw));
  assert.equal(replay.status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(sent, afterFirst, 'a retry is acknowledged and otherwise ignored');
});

test('a webhook that pays the wrong amount does not unlock', async () => {
  capture();
  const eid = makeExam({ pricing: 'paid', amount: 1000 });
  const student = addStudent(eid);
  db.prepare(
    `INSERT INTO payments (exam_id, student_id, reference, amount, currency, status, authorization_url)
     VALUES (?,?,?,?, 'GHS', 'pending', 'https://checkout.paystack.com/x')`
  ).run(eid, student.id, 'ref-short', 1000);

  const raw = JSON.stringify({
    event: 'charge.success',
    data: { reference: 'ref-short', amount: 500, currency: 'GHS', channel: 'card' },
  });
  const res = await postWebhook(raw, sign(raw));
  assert.equal(res.status, 200, 'Paystack is still acknowledged — we just do not act on it');
  assert.equal(db.prepare('SELECT status FROM payments WHERE reference = ?').get('ref-short').status, 'pending');
  assert.equal(sent.length, 0);
});

test('a student whose webhook never arrived is unlocked by verification on reply', async () => {
  capture();
  paystackStub({ verifyStatus: 'success' });
  const eid = makeExam({ pricing: 'paid', amount: 1000 });
  const student = addStudent(eid);
  await exam.sendExamToRecipients(eid);
  sent.length = 0;

  const outcome = await exam.handleInbound(student.phone, 'hello');

  assert.equal(payments.hasPaid(eid, student.id), true, 'verified against Paystack directly');
  assert.ok(sent.some((m) => m.includes('Payment received')), 'the student is told');
  assert.ok(sent.some((m) => m.includes('QUESTION 1')), 'and gets their paper on the same reply');
  assert.notEqual(outcome.reason, 'payment_required');
});

test('an unpaid student on a paid paper is blocked even when they skip the invite', async () => {
  capture();
  paystackStub();
  const eid = makeExam({ pricing: 'paid', amount: 1000 });
  const student = addStudent(eid);
  // No send: the student simply messages a number they were given.
  const outcome = await exam.handleInbound(student.phone, 'hi');
  assert.equal(outcome.reason, 'payment_required');
  assert.ok(!sent.some((m) => m.includes('QUESTION 1')));
  assert.equal(sessionFor(eid, student.id), undefined, 'no session may be created for an unpaid student');
});
